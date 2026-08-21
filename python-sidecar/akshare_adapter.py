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
import os
import time
import traceback
from datetime import datetime, timedelta
from typing import Any, Iterable

import akshare as ak
import pandas as pd
from cachetools import TTLCache

from market_utils import Market, Symbol, parse_symbol
from models import DividendInfo, DividendRecord, IntradayPoint, KlinePoint, Quote, SearchItem

logger = logging.getLogger(__name__)

# ============ 分红专用日志（写文件，方便诊断） ============
# 文件位置：<akshare_adapter.py 同目录>/dividend.log，追加模式，UTF-8
_DIVIDEND_LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dividend.log")
_dividend_logger = logging.getLogger("dividend_diag")
if not _dividend_logger.handlers:
    _dividend_logger.setLevel(logging.DEBUG)
    _dividend_logger.propagate = False  # 不冒泡到 root，避免污染 sidecar 主日志
    try:
        _fh = logging.FileHandler(_DIVIDEND_LOG_PATH, mode="a", encoding="utf-8")
        _fh.setFormatter(logging.Formatter(
            fmt="%(asctime)s [%(levelname)s] %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        ))
        _dividend_logger.addHandler(_fh)
        _dividend_logger.info("=" * 60)
        _dividend_logger.info("dividend logger 初始化 · log=%s · cwd=%s · pid=%s",
                              _DIVIDEND_LOG_PATH, os.getcwd(), os.getpid())
    except Exception as e:
        # 文件创建失败降级到 stderr（不阻断 sidecar 启动）
        logger.warning("dividend.log 打开失败: %s，分红日志将走主 logger", e)

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


# =============== 分红派息 ===============
def _ttm_window(end_date: str) -> tuple[str, str]:
    """给定截止日期，返回过去 12 个月的 [start, end] 字符串区间。

    end_date 格式 "YYYY-MM-DD"；start = end 往前减 1 年（自然年度对齐同月同日）。
    """
    end = datetime.strptime(end_date, "%Y-%m-%d").date()
    # 简单减 365 天而不是"同月同日减 1 年"，避免 2 月 29 号闰年问题
    start = end - timedelta(days=365)
    return start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d")


def _parse_date_any(v: Any) -> str | None:
    """把 AKShare 返回的各种日期形式解析成 'YYYY-MM-DD'；失败返回 None。"""
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    # 排除 pandas NaT（NaT 也是 Timestamp 子类型）
    if v is pd.NaT:
        return None
    try:
        if isinstance(v, pd.Timestamp):
            if pd.isna(v):
                return None
            return v.strftime("%Y-%m-%d")
    except Exception:
        return None
    if isinstance(v, datetime):
        return v.strftime("%Y-%m-%d")
    s = str(v).strip()
    if not s or s in ("nan", "NaT", "-", "--", "None"):
        return None
    # 常见格式尝试
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y%m%d", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    # 尝试 pandas 兜底
    try:
        ts = pd.to_datetime(s, errors="coerce")
        if pd.isna(ts):
            return None
        return ts.strftime("%Y-%m-%d")
    except Exception:
        return None


def _pick_col(df: pd.DataFrame, candidates: list[str]) -> str | None:
    """在 DataFrame 列名里按候选列表匹配第一个存在的列名。找不到返回 None。"""
    cols = list(df.columns)
    for c in candidates:
        if c in cols:
            return c
    # 模糊匹配（子串包含）
    for c in cols:
        for cand in candidates:
            if cand in str(c):
                return c
    return None


def _dividend_a(code: str, end_date: str) -> DividendInfo:
    """A 股 TTM 分红明细：以除权除息日在 (end_date - 365d, end_date] 归集。"""
    start_date, _ = _ttm_window(end_date)
    end_year = int(end_date.split("-")[0])
    _dividend_logger.info("[A] 入口 code=%s window=[%s, %s]", code, start_date, end_date)
    t0 = time.time()
    try:
        df = ak.stock_fhps_detail_em(symbol=code)
    except Exception as e:
        _dividend_logger.error(
            "[A] AKShare 请求失败 code=%s exc=%s: %s\n%s",
            code, type(e).__name__, e, traceback.format_exc(),
        )
        logger.warning("A 股分红拉取失败 %s: %s", code, e)
        return DividendInfo(symbol="", year=end_year, end_date=end_date,
                            dividend_per_share=None, records=[],
                            source="akshare-a-empty")

    elapsed = time.time() - t0
    rows = 0 if df is None else len(df)
    cols = [] if df is None else list(df.columns)
    _dividend_logger.info(
        "[A] AKShare 返回 code=%s rows=%d cols=%s elapsed=%.2fs",
        code, rows, cols, elapsed,
    )

    if df is None or df.empty:
        _dividend_logger.warning("[A] 返回空 df code=%s", code)
        return DividendInfo(symbol="", year=end_year, end_date=end_date,
                            dividend_per_share=None, records=[],
                            source="akshare-a-empty")

    ex_col = _pick_col(df, ["除权除息日"])
    per10_col = _pick_col(df, ["现金分红-现金分红比例", "现金分红比例"])
    per_share_col = _pick_col(df, ["每股股利", "每股派息"])
    _dividend_logger.info(
        "[A] 列选择 code=%s ex_col=%r per10_col=%r per_share_col=%r",
        code, ex_col, per10_col, per_share_col,
    )

    records: list[DividendRecord] = []
    total: float = 0.0
    hit = False
    filtered_hit = 0
    filtered_no_date = 0
    filtered_no_cash = 0

    for _, row in df.iterrows():
        ex_raw = row.get(ex_col) if ex_col else None
        ex_date = _parse_date_any(ex_raw)
        if not ex_date:
            filtered_no_date += 1
            continue
        # TTM 窗口过滤：(start_date, end_date]
        if not (start_date < ex_date <= end_date):
            continue
        filtered_hit += 1

        cash: float | None = None
        if per_share_col is not None:
            cash = _safe_float(row.get(per_share_col))
        if cash is None and per10_col is not None:
            v10 = _safe_float(row.get(per10_col))
            if v10 is not None:
                cash = v10 / 10.0
        if cash is None or cash <= 0:
            filtered_no_cash += 1
            continue

        hit = True
        total += cash
        records.append(DividendRecord(
            ex_date=ex_date, cash_per_share=cash, note=None,
        ))

    _dividend_logger.info(
        "[A] 过滤统计 code=%s window=(%s, %s]: no_date=%d hit=%d no_cash=%d final=%d total=%.4f",
        code, start_date, end_date, filtered_no_date, filtered_hit, filtered_no_cash,
        len(records), total,
    )

    return DividendInfo(
        symbol="",
        year=end_year,
        end_date=end_date,
        dividend_per_share=(total if hit else None),
        records=records,
        source="akshare-a",
    )


def _dividend_hk(code: str, end_date: str) -> DividendInfo:
    """港股 TTM 分红明细：按除净日归集到过去 12 个月。"""
    import re

    start_date, _ = _ttm_window(end_date)
    end_year = int(end_date.split("-")[0])
    hk_code = code.zfill(5)
    _dividend_logger.info("[HK] 入口 code=%s hk_code=%s window=[%s, %s]",
                          code, hk_code, start_date, end_date)
    df = None
    used_source = "akshare-hk-em"

    # 主源：东财
    t0 = time.time()
    try:
        df = ak.stock_hk_dividend_payout_em(symbol=hk_code)
        _dividend_logger.info(
            "[HK] 主源(em) 返回 code=%s rows=%d elapsed=%.2fs",
            hk_code, 0 if df is None else len(df), time.time() - t0,
        )
    except Exception as e:
        _dividend_logger.error(
            "[HK] 主源(em) 请求失败 code=%s exc=%s: %s",
            hk_code, type(e).__name__, e,
        )
        logger.warning("港股分红主源(em)失败 %s: %s", hk_code, e)

    # 副源：同花顺
    if df is None or df.empty:
        t1 = time.time()
        try:
            df = ak.stock_hk_fhpx_detail_ths(symbol=hk_code)
            used_source = "akshare-hk-ths"
            _dividend_logger.info(
                "[HK] 副源(ths) 返回 code=%s rows=%d elapsed=%.2fs",
                hk_code, 0 if df is None else len(df), time.time() - t1,
            )
        except Exception as e:
            _dividend_logger.error(
                "[HK] 副源(ths) 请求失败 code=%s exc=%s: %s",
                hk_code, type(e).__name__, e,
            )
            logger.warning("港股分红副源(ths)失败 %s: %s", hk_code, e)

    if df is None or df.empty:
        _dividend_logger.warning("[HK] 主副源均空 code=%s", hk_code)
        return DividendInfo(symbol="", year=end_year, end_date=end_date,
                            dividend_per_share=None, records=[],
                            source="akshare-hk-empty")

    ex_col = _pick_col(df, ["除净日", "除权除息日", "除权日", "除息日"])
    plan_col = _pick_col(df, ["分红方案", "方案", "派息", "股息"])
    per_share_col = _pick_col(df, ["每股股息", "每股派息", "每股分红", "分红金额"])
    _dividend_logger.info(
        "[HK] 列选择 code=%s ex_col=%r plan_col=%r per_share_col=%r cols=%s",
        hk_code, ex_col, plan_col, per_share_col, list(df.columns),
    )

    # "每股派港币5.3元" / "每股派 5.3 港元" / "每股派0.5元"
    _re_cash = re.compile(
        r"每股[派分]\s*(?:港币|港元|美元|HKD|USD|人民币|CNY)?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:港?[元币]|HKD|USD|CNY|人民币)?",
        re.IGNORECASE,
    )

    records: list[DividendRecord] = []
    total: float = 0.0
    hit = False
    stats_no_date = 0
    stats_hit = 0
    stats_no_cash = 0

    for _, row in df.iterrows():
        ex_date = _parse_date_any(row.get(ex_col)) if ex_col else None
        if not ex_date:
            stats_no_date += 1
            continue
        # TTM 窗口过滤：(start_date, end_date]
        if not (start_date < ex_date <= end_date):
            continue
        stats_hit += 1

        cash: float | None = None
        if per_share_col is not None:
            cash = _safe_float(row.get(per_share_col))
        if cash is None and plan_col is not None:
            plan = row.get(plan_col)
            if plan is not None:
                m = _re_cash.search(str(plan))
                if m:
                    cash = _safe_float(m.group(1))
        if cash is None or cash <= 0:
            stats_no_cash += 1
            continue

        hit = True
        total += cash
        note = None
        if plan_col is not None and row.get(plan_col) is not None:
            note = str(row.get(plan_col))[:60]
        records.append(DividendRecord(
            ex_date=ex_date, cash_per_share=cash, note=note,
        ))

    _dividend_logger.info(
        "[HK] 过滤统计 code=%s window=(%s, %s]: no_date=%d hit=%d no_cash=%d final=%d total=%.4f",
        hk_code, start_date, end_date, stats_no_date, stats_hit, stats_no_cash,
        len(records), total,
    )

    return DividendInfo(
        symbol="",
        year=end_year,
        end_date=end_date,
        dividend_per_share=(total if hit else None),
        records=records,
        source=used_source if hit else "akshare-hk-empty",
    )


def get_dividend(symbol: str, end_date: str) -> DividendInfo:
    """获取指定 symbol 在过去 12 个月的分红汇总（TTM）。

    end_date 为 TTM 截止日期（"YYYY-MM-DD"），归集区间为 (end_date - 365d, end_date]。
    仅支持 A 股和港股。美股/未支持市场返回 None。
    数据缺失不抛错，返回 dividend_per_share=None。
    """
    _dividend_logger.info(">> get_dividend symbol=%r end_date=%s", symbol, end_date)
    sym = parse_symbol(symbol)
    end_year = int(end_date.split("-")[0])

    if sym.is_a_share:
        info = _dividend_a(sym.code, end_date)
    elif sym.market.value == "HK":
        info = _dividend_hk(sym.code, end_date)
    else:
        info = DividendInfo(symbol=sym.normalized, year=end_year, end_date=end_date,
                            dividend_per_share=None, records=[],
                            source="unsupported")

    info.symbol = sym.normalized
    _dividend_logger.info(
        "<< get_dividend symbol=%s → div=%s records=%d source=%s end_date=%s",
        info.symbol, info.dividend_per_share, len(info.records), info.source, info.end_date,
    )
    return info
