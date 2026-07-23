"""
AKShare 多市场统一适配器。

对外提供 5 类能力：
    - get_quote(symbol)                     : 单只最新报价
    - get_quotes(symbols)                   : 批量最新报价
    - get_intraday(symbol)                  : 当日分时（1 分钟粒度）
    - get_kline(symbol, period, limit)      : K 线（1m/5m/15m/30m/60m/1d/1w/1M）
    - search(keyword, limit)                : 代码/名称模糊搜索

所有函数都是同步阻塞（AKShare 自身同步），由上层通过 asyncio.to_thread 放到线程池执行。
错误统一抛 RuntimeError，路由层捕获转为 ApiResponse(code!=0)。
"""

from __future__ import annotations

import logging
import math
from datetime import datetime, timedelta
from typing import Any, Iterable

import akshare as ak
import pandas as pd
from cachetools import TTLCache

from market_utils import Market, Symbol, parse_symbol
from models import IntradayPoint, KlinePoint, Quote, SearchItem

logger = logging.getLogger(__name__)

# =============== 缓存 ===============
# 全表 spot（港股/美股一次性拉几千行），30 秒 TTL
_spot_cache: TTLCache = TTLCache(maxsize=8, ttl=30)
# 股票列表（用于 search），1 小时 TTL
_list_cache: TTLCache = TTLCache(maxsize=8, ttl=3600)


# =============== 工具 ===============
def _safe_float(v: Any) -> float | None:
    """把 pandas 里的各种值安全转成 float 或 None。"""
    if v is None:
        return None
    try:
        f = float(v)
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    except (TypeError, ValueError):
        return None


def _dt_to_str(v: Any, fmt: str = "%Y-%m-%d %H:%M:%S") -> str:
    """把 pandas timestamp / str / datetime 统一转字符串。"""
    if isinstance(v, str):
        return v
    if isinstance(v, (datetime, pd.Timestamp)):
        return v.strftime(fmt)
    return str(v)


# =============== spot 全表缓存 ===============
def _get_hk_spot_df() -> pd.DataFrame:
    key = "hk_spot"
    if key in _spot_cache:
        return _spot_cache[key]
    df = ak.stock_hk_spot_em()
    _spot_cache[key] = df
    return df


def _get_us_spot_df() -> pd.DataFrame:
    key = "us_spot"
    if key in _spot_cache:
        return _spot_cache[key]
    df = ak.stock_us_spot_em()
    _spot_cache[key] = df
    return df


def _get_a_spot_df() -> pd.DataFrame:
    key = "a_spot"
    if key in _spot_cache:
        return _spot_cache[key]
    df = ak.stock_zh_a_spot_em()
    _spot_cache[key] = df
    return df


# =============== 最新报价 ===============
def _quote_from_a_share(sym: Symbol) -> Quote:
    """A 股用全表 spot 提取，性能好且字段全。"""
    df = _get_a_spot_df()
    row = df[df["代码"] == sym.code]
    if row.empty:
        raise RuntimeError(f"A 股代码不存在: {sym.normalized}")
    r = row.iloc[0]
    return Quote(
        symbol=sym.normalized,
        name=str(r.get("名称") or ""),
        price=_safe_float(r.get("最新价")),
        open=_safe_float(r.get("今开")),
        high=_safe_float(r.get("最高")),
        low=_safe_float(r.get("最低")),
        prev_close=_safe_float(r.get("昨收")),
        change=_safe_float(r.get("涨跌额")),
        change_pct=_safe_float(r.get("涨跌幅")),
        volume=_safe_float(r.get("成交量")),
        amount=_safe_float(r.get("成交额")),
        ts=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    )


def _quote_from_hk(sym: Symbol) -> Quote:
    df = _get_hk_spot_df()
    # 港股列名：代码/名称/最新价/涨跌额/涨跌幅/今开/最高/最低/昨收/成交量/成交额
    code_5 = sym.code.zfill(5)
    row = df[df["代码"] == code_5]
    if row.empty:
        raise RuntimeError(f"港股代码不存在: {sym.normalized}")
    r = row.iloc[0]
    return Quote(
        symbol=sym.normalized,
        name=str(r.get("名称") or ""),
        price=_safe_float(r.get("最新价")),
        open=_safe_float(r.get("今开")),
        high=_safe_float(r.get("最高")),
        low=_safe_float(r.get("最低")),
        prev_close=_safe_float(r.get("昨收")),
        change=_safe_float(r.get("涨跌额")),
        change_pct=_safe_float(r.get("涨跌幅")),
        volume=_safe_float(r.get("成交量")),
        amount=_safe_float(r.get("成交额")),
        ts=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    )


def _quote_from_us(sym: Symbol) -> Quote:
    df = _get_us_spot_df()
    # 美股列名：序号/名称/最新价/涨跌额/涨跌幅/开盘价/最高价/最低价/昨收价/总市值/市盈率/成交量/成交额/振幅/换手率/代码
    # 代码列可能是 "105.AAPL" 这样，需要按后缀匹配
    df_codes = df["代码"].astype(str)
    mask = df_codes.str.endswith("." + sym.code) | (df_codes == sym.code)
    row = df[mask]
    if row.empty:
        raise RuntimeError(f"美股代码不存在: {sym.normalized}")
    r = row.iloc[0]
    return Quote(
        symbol=sym.normalized,
        name=str(r.get("名称") or ""),
        price=_safe_float(r.get("最新价")),
        open=_safe_float(r.get("开盘价")),
        high=_safe_float(r.get("最高价")),
        low=_safe_float(r.get("最低价")),
        prev_close=_safe_float(r.get("昨收价")),
        change=_safe_float(r.get("涨跌额")),
        change_pct=_safe_float(r.get("涨跌幅")),
        volume=_safe_float(r.get("成交量")),
        amount=_safe_float(r.get("成交额")),
        ts=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    )


def get_quote(symbol: str) -> Quote:
    """AKShare 直接实现（供聚合器兜底调用）。对外统一入口在 aggregator.py。"""
    sym = parse_symbol(symbol)
    if sym.is_a_share:
        return _quote_from_a_share(sym)
    if sym.market == Market.HK:
        return _quote_from_hk(sym)
    if sym.market == Market.US:
        return _quote_from_us(sym)
    raise RuntimeError(f"不支持的市场: {sym.market}")


def get_quotes(symbols: Iterable[str]) -> list[Quote]:
    """批量获取报价。同市场共用一次全表拉取，性能友好。"""
    results: list[Quote] = []
    for s in symbols:
        try:
            results.append(get_quote(s))
        except Exception as e:
            logger.warning("获取报价失败 %s: %s", s, e)
            # 失败的用占位返回，保证顺序对齐
            try:
                sym = parse_symbol(s)
                results.append(Quote(symbol=sym.normalized))
            except Exception:
                results.append(Quote(symbol=s))
    return results


# =============== 分时数据（当日 1 分钟粒度） ===============
def get_intraday(symbol: str) -> list[IntradayPoint]:
    """当日分时数据。返回按时间升序的 1 分钟点列表。"""
    sym = parse_symbol(symbol)
    today = datetime.now().strftime("%Y-%m-%d")
    start = f"{today} 09:00:00"
    end = f"{today} 16:00:00"

    if sym.is_a_share:
        # 东财 A 股分时（1 分钟）；不复权
        df = ak.stock_zh_a_hist_min_em(
            symbol=sym.code,
            period="1",
            start_date=start,
            end_date=end,
            adjust="",
        )
        # 列名：时间/开盘/收盘/最高/最低/成交量/成交额/最新价（不同版本略有差异）
        return _df_to_intraday(df, time_col_candidates=["时间", "日期"])

    if sym.market == Market.HK:
        df = ak.stock_hk_hist_min_em(
            symbol=sym.code.zfill(5),
            period="1",
            start_date=start,
            end_date=end,
            adjust="",
        )
        return _df_to_intraday(df, time_col_candidates=["时间", "日期"])

    if sym.market == Market.US:
        # 美股分时（AKShare 参数：symbol 用东财 code，如 "105.AAPL"；此处允许直接传字母代码，
        # AKShare 内部会做映射；若某些代码不 work，可后续查表映射真实市场号）
        df = ak.stock_us_hist_min_em(
            symbol=sym.code,
            start_date=start,
            end_date=end,
        )
        return _df_to_intraday(df, time_col_candidates=["时间", "日期"])

    raise RuntimeError(f"不支持的市场: {sym.market}")


def _df_to_intraday(df: pd.DataFrame, time_col_candidates: list[str]) -> list[IntradayPoint]:
    if df is None or df.empty:
        return []
    time_col = next((c for c in time_col_candidates if c in df.columns), df.columns[0])
    price_col = "收盘" if "收盘" in df.columns else ("最新价" if "最新价" in df.columns else df.columns[1])
    avg_col = "均价" if "均价" in df.columns else None
    vol_col = "成交量" if "成交量" in df.columns else None
    amt_col = "成交额" if "成交额" in df.columns else None

    points: list[IntradayPoint] = []
    for _, r in df.iterrows():
        price = _safe_float(r.get(price_col))
        if price is None:
            continue
        points.append(IntradayPoint(
            ts=_dt_to_str(r.get(time_col)),
            price=price,
            avg_price=_safe_float(r.get(avg_col)) if avg_col else None,
            volume=_safe_float(r.get(vol_col)) if vol_col else None,
            amount=_safe_float(r.get(amt_col)) if amt_col else None,
        ))
    return points


# =============== K 线 ===============
# 统一 period → AKShare 各接口的实际 period 参数
_MINUTE_PERIODS = {"1m": "1", "5m": "5", "15m": "15", "30m": "30", "60m": "60"}
_DAILY_PERIODS = {"1d": "daily", "1w": "weekly", "1M": "monthly"}


def get_kline(symbol: str, period: str, limit: int = 500) -> list[KlinePoint]:
    """获取 K 线。

    period 可选：
        - 分钟：1m / 5m / 15m / 30m / 60m
        - 日/周/月：1d / 1w / 1M

    limit 是"最多返回最近 N 根"（对分钟 K 特别有用，避免拉几万根）。
    """
    sym = parse_symbol(symbol)

    if period in _MINUTE_PERIODS:
        return _get_kline_minute(sym, _MINUTE_PERIODS[period], limit)
    if period in _DAILY_PERIODS:
        return _get_kline_daily(sym, _DAILY_PERIODS[period], limit)
    raise RuntimeError(f"不支持的 period: {period}")


def _get_kline_minute(sym: Symbol, ak_period: str, limit: int) -> list[KlinePoint]:
    # 分钟 K 拉近 30 天足够，超过限制时接口一般会自动截断
    end = datetime.now()
    start = end - timedelta(days=30)
    start_str = start.strftime("%Y-%m-%d %H:%M:%S")
    end_str = end.strftime("%Y-%m-%d %H:%M:%S")

    if sym.is_a_share:
        df = ak.stock_zh_a_hist_min_em(
            symbol=sym.code,
            period=ak_period,
            start_date=start_str,
            end_date=end_str,
            adjust="qfq",
        )
    elif sym.market == Market.HK:
        df = ak.stock_hk_hist_min_em(
            symbol=sym.code.zfill(5),
            period=ak_period,
            start_date=start_str,
            end_date=end_str,
            adjust="qfq",
        )
    elif sym.market == Market.US:
        # 美股分钟 K 接口暂不支持传 period，只有 1 分钟；退化处理：只有 1m 支持，其他抛错
        if ak_period != "1":
            raise RuntimeError("美股仅支持 1m 分钟 K")
        df = ak.stock_us_hist_min_em(
            symbol=sym.code,
            start_date=start_str,
            end_date=end_str,
        )
    else:
        raise RuntimeError(f"不支持的市场: {sym.market}")

    return _df_to_kline(df, limit)


def _get_kline_daily(sym: Symbol, ak_period: str, limit: int) -> list[KlinePoint]:
    # 日/周/月 K 拉近 3 年（够 30 天保留 + MACD 预热）
    end = datetime.now()
    start = end - timedelta(days=1000)
    start_str = start.strftime("%Y%m%d")
    end_str = end.strftime("%Y%m%d")

    if sym.is_a_share:
        df = ak.stock_zh_a_hist(
            symbol=sym.code,
            period=ak_period,
            start_date=start_str,
            end_date=end_str,
            adjust="qfq",
        )
    elif sym.market == Market.HK:
        df = ak.stock_hk_hist(
            symbol=sym.code.zfill(5),
            period=ak_period,
            start_date=start_str,
            end_date=end_str,
            adjust="qfq",
        )
    elif sym.market == Market.US:
        df = ak.stock_us_hist(
            symbol=sym.code,
            period=ak_period,
            start_date=start_str,
            end_date=end_str,
            adjust="qfq",
        )
    else:
        raise RuntimeError(f"不支持的市场: {sym.market}")

    return _df_to_kline(df, limit)


def _df_to_kline(df: pd.DataFrame, limit: int) -> list[KlinePoint]:
    if df is None or df.empty:
        return []
    # 兼容列名：分钟 K 是"时间"，日/周/月 K 是"日期"
    time_col = "时间" if "时间" in df.columns else "日期"

    # 只保留最近 limit 根
    if len(df) > limit:
        df = df.tail(limit)

    points: list[KlinePoint] = []
    for _, r in df.iterrows():
        o = _safe_float(r.get("开盘"))
        h = _safe_float(r.get("最高"))
        low = _safe_float(r.get("最低"))
        c = _safe_float(r.get("收盘"))
        if None in (o, h, low, c):
            continue
        points.append(KlinePoint(
            ts=_dt_to_str(r.get(time_col)),
            open=o, high=h, low=low, close=c,
            volume=_safe_float(r.get("成交量")),
            amount=_safe_float(r.get("成交额")),
        ))
    return points


# =============== 搜索 ===============
def _get_a_list() -> pd.DataFrame:
    key = "a_list"
    if key in _list_cache:
        return _list_cache[key]
    # 沪深两市股票代码与名称
    df = ak.stock_info_a_code_name()  # 列：code/name
    _list_cache[key] = df
    return df


def _get_hk_list() -> pd.DataFrame:
    key = "hk_list"
    if key in _list_cache:
        return _list_cache[key]
    df = _get_hk_spot_df()[["代码", "名称"]].copy()
    _list_cache[key] = df
    return df


def _get_us_list() -> pd.DataFrame:
    key = "us_list"
    if key in _list_cache:
        return _list_cache[key]
    df = _get_us_spot_df()[["代码", "名称"]].copy()
    _list_cache[key] = df
    return df


def search(keyword: str, limit: int = 20) -> list[SearchItem]:
    """全市场搜索（代码或名称模糊匹配）。"""
    if not keyword:
        return []
    kw = keyword.strip().upper()
    results: list[SearchItem] = []

    # A 股
    try:
        df = _get_a_list()
        mask = df["code"].astype(str).str.contains(kw, case=False, na=False) | \
               df["name"].astype(str).str.contains(kw, case=False, na=False)
        for _, r in df[mask].head(limit).iterrows():
            code = str(r["code"])
            # 简单按前缀猜市场
            from market_utils import guess_a_share_market
            m = guess_a_share_market(code)
            results.append(SearchItem(
                symbol=f"{m.value}:{code}",
                name=str(r["name"]),
                market=m.value,
            ))
    except Exception as e:
        logger.warning("A 股搜索失败: %s", e)

    # 港股
    try:
        df = _get_hk_list()
        mask = df["代码"].astype(str).str.contains(kw, case=False, na=False) | \
               df["名称"].astype(str).str.contains(kw, case=False, na=False)
        for _, r in df[mask].head(limit).iterrows():
            code = str(r["代码"])
            results.append(SearchItem(
                symbol=f"HK:{code}",
                name=str(r["名称"]),
                market="HK",
            ))
    except Exception as e:
        logger.warning("港股搜索失败: %s", e)

    # 美股
    try:
        df = _get_us_list()
        mask = df["代码"].astype(str).str.contains(kw, case=False, na=False) | \
               df["名称"].astype(str).str.contains(kw, case=False, na=False)
        for _, r in df[mask].head(limit).iterrows():
            raw = str(r["代码"])
            # 美股代码若形如 "105.AAPL"，取点后
            code = raw.split(".")[-1] if "." in raw else raw
            results.append(SearchItem(
                symbol=f"US:{code}",
                name=str(r["名称"]),
                market="US",
            ))
    except Exception as e:
        logger.warning("美股搜索失败: %s", e)

    return results[:limit]
