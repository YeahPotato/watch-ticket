"""
腾讯行情数据源。

端点：
    Quote:    https://qt.gtimg.cn/q=<code>
    K 线:     https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=<code>,<period>,,,<count>,qfq
    分时:     https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=<code>

代码约定（腾讯格式）：
    A 股：  sh600519 / sz000001 / bj430047（北交所 bj 前缀腾讯不一定全支持，若失败会由上层回退到 AKShare）
    港股：  hk00700
    美股：  usAAPL（返回中显示为 AAPL.OQ，我们对外仍用 US:AAPL）

响应字段（quote，`~` 分隔）：
    [0]  市场号（1=A 沪，51=A 深，100=港，200=美 等）
    [1]  名称
    [2]  代码（可能带交易所后缀，如 AAPL.OQ）
    [3]  当前价
    [4]  昨收
    [5]  今开
    [6]  成交量（手，A 股）/ 股（港美）
    [7]  外盘  [8] 内盘  [9] 买一价 ... 略
    [30] 时间戳 "yyyy-MM-dd HH:mm:ss" 或 "yyyyMMddHHmmss"（A 股）
    [31] 涨跌额
    [32] 涨跌幅（%）
    [33] 最高
    [34] 最低
    [37] 成交额（元）
    ...
"""

from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import List, Optional

import requests

from datasource.base import DataSource
from market_utils import Market, Symbol, parse_symbol
from models import IntradayPoint, KlinePoint, Quote, SearchItem

logger = logging.getLogger(__name__)

# 支持的 K 线周期 → 腾讯 API 的 period 参数
_KLINE_PERIOD_MAP = {
    "1d": "day",
    "1w": "week",
    "1M": "month",
}


def _tencent_code(sym: Symbol) -> str:
    """把统一格式转成腾讯的 code。"""
    if sym.market == Market.SH:
        return f"sh{sym.code}"
    if sym.market == Market.SZ:
        return f"sz{sym.code}"
    if sym.market == Market.BJ:
        return f"bj{sym.code}"
    if sym.market == Market.HK:
        return f"hk{sym.code.zfill(5)}"
    if sym.market == Market.US:
        return f"us{sym.code.upper()}"
    raise RuntimeError(f"未知市场: {sym.market}")


# 美股 K 线代码后缀缓存：US:AAPL → usAAPL.OQ（腾讯 K 线需要完整代码）
_us_kline_code_cache: dict[str, str] = {}


def _resolve_us_kline_code(sym: Symbol) -> str:
    """
    美股 K 线接口要求带交易所后缀（.OQ/.N/.A），不带会只返回极少数据。
    从 quote 响应字段 [2] 抽取后缀，缓存起来。
    """
    key = sym.normalized
    if key in _us_kline_code_cache:
        return _us_kline_code_cache[key]

    base = _tencent_code(sym)  # usAAPL
    url = f"https://qt.gtimg.cn/q={base}"
    try:
        resp = _http_get(url, timeout=4.0)
        text = resp.content.decode("gbk", errors="replace")
        m = re.search(r'="([^"]+)"', text)
        if m:
            fields = m.group(1).split("~")
            if len(fields) > 2 and fields[2]:
                # e.g. "AAPL.OQ"
                full = f"us{fields[2]}"
                _us_kline_code_cache[key] = full
                return full
    except Exception as e:
        logger.debug("resolve us code fail %s: %s", key, e)

    # 兜底：直接用无后缀（可能只返回 2 根，但至少不炸）
    _us_kline_code_cache[key] = base
    return base


def _http_get(url: str, timeout: float = 5.0) -> requests.Response:
    """封装带超时的 GET。腾讯响应体是 GBK/UTF-8 混合，交给调用者按需 decode。"""
    r = requests.get(
        url,
        timeout=timeout,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                          "AppleWebKit/537.36 (KHTML, like Gecko) "
                          "Chrome/131.0.0.0 Safari/537.36",
            "Referer": "https://gu.qq.com/",
        },
    )
    r.raise_for_status()
    return r


def _float_or_none(s: str) -> Optional[float]:
    if s is None or s == "" or s == "0":
        # 注意：腾讯很多没数据的字段是 "0"，直接判 falsy 就行；但有些字段合理值就是 0
        # 这里对"字符串 '0'"仍返回 0.0，只对空串/None 返回 None
        if s in ("", None):
            return None
    try:
        v = float(s)
        return v
    except (TypeError, ValueError):
        return None


def _parse_quote_string(payload: str, sym: Symbol) -> Optional[Quote]:
    """
    腾讯 quote 响应格式（gbk 解码后）：
        v_sh600519="1~贵州茅台~600519~1305.00~1308.00~...";
    如果找不到数据，会返回 v_pv_none_match="1"; → 返回 None。
    """
    if "v_pv_none_match" in payload:
        return None
    m = re.search(r'="([^"]+)"', payload)
    if not m:
        return None
    fields = m.group(1).split("~")
    if len(fields) < 35:
        logger.debug("腾讯 quote 字段过少: %d", len(fields))
        return None

    # 时间戳：A 股是 yyyyMMddHHmmss；港美股是 yyyy-MM-dd HH:mm:ss
    ts_raw = fields[30] if len(fields) > 30 else None
    ts_norm: Optional[str] = None
    if ts_raw:
        if re.fullmatch(r"\d{14}", ts_raw):
            try:
                ts_norm = datetime.strptime(ts_raw, "%Y%m%d%H%M%S").strftime(
                    "%Y-%m-%d %H:%M:%S"
                )
            except ValueError:
                ts_norm = ts_raw
        else:
            ts_norm = ts_raw

    return Quote(
        symbol=sym.normalized,
        name=fields[1] or None,
        price=_float_or_none(fields[3]),
        prev_close=_float_or_none(fields[4]),
        open=_float_or_none(fields[5]),
        high=_float_or_none(fields[33]),
        low=_float_or_none(fields[34]),
        change=_float_or_none(fields[31]),
        change_pct=_float_or_none(fields[32]),
        volume=_float_or_none(fields[6]),
        amount=_float_or_none(fields[37]) if len(fields) > 37 else None,
        ts=ts_norm,
    )


def _parse_kline_data(data_obj: dict, period_key_hints: List[str]) -> List[KlinePoint]:
    """
    kline 响应：
        {
          "code": 0,
          "data": {
            "sh600519": {                # 也可能带市场后缀，如 usAAPL.OQ
              "day"  / "qfqday"   : [[ts, open, close, high, low, volume, ...], ...]
              "week" / "qfqweek"
              "month"/ "qfqmonth"
            }
          }
        }
    period_key_hints: 优先使用的 key 列表（如 ["qfqday", "day"]）
    """
    # data_obj 只应含一个 key
    if not data_obj:
        return []
    inner = next(iter(data_obj.values()))
    rows = None
    for k in period_key_hints:
        if k in inner and isinstance(inner[k], list):
            rows = inner[k]
            break
    if rows is None:
        return []

    out: List[KlinePoint] = []
    for r in rows:
        if len(r) < 6:
            continue
        try:
            out.append(KlinePoint(
                ts=str(r[0]),
                open=float(r[1]),
                close=float(r[2]),
                high=float(r[3]),
                low=float(r[4]),
                volume=float(r[5]) if r[5] not in (None, "") else None,
                amount=None,
            ))
        except (TypeError, ValueError):
            continue
    return out


def _parse_intraday_data(
    data_obj: dict,
    prev_close: Optional[float],
    volume_multiplier: int = 1,
) -> List[IntradayPoint]:
    """
    分时响应：
      {"data": {"data": ["0930 1300.00 686 89180000.00", ...], "date": "yyyy-MM-dd"}}
    字段：HHMM 价格 累计量 累计额
    分时"均价"用 累计额 / (累计量 * volume_multiplier) 计算。
    - A 股：volume 单位是"手"（=100 股），volume_multiplier=100
    - 港美：volume 单位是"股"，volume_multiplier=1
    """
    if not data_obj:
        return []
    inner = next(iter(data_obj.values()))
    day_wrap = inner.get("data") or {}
    lines = day_wrap.get("data") or []
    date_str = day_wrap.get("date") or ""
    # 规范化日期：腾讯 A 股返回 "20260722"，港美股可能返回 "2026-07-22"，也可能是空
    if re.fullmatch(r"\d{8}", date_str):
        date_str = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:]}"
    if not date_str:
        # 兜底用今日
        date_str = datetime.now().strftime("%Y-%m-%d")

    out: List[IntradayPoint] = []
    for line in lines:
        parts = line.split()
        if len(parts) < 3:
            continue
        hhmm = parts[0]
        try:
            price = float(parts[1])
            cum_vol = float(parts[2])
            cum_amt = float(parts[3]) if len(parts) > 3 else 0.0
        except ValueError:
            continue

        avg = (cum_amt / (cum_vol * volume_multiplier)) if cum_vol > 0 and cum_amt > 0 else None
        ts_full = (
            f"{date_str} {hhmm[:2]}:{hhmm[2:]}:00"
            if len(hhmm) == 4
            else f"{date_str} {hhmm}"
        )
        out.append(IntradayPoint(
            ts=ts_full,
            price=price,
            avg_price=avg,
            volume=cum_vol,
            amount=cum_amt or None,
        ))

    # prev_close 参数保留供未来使用（例如做均线基准）
    _ = prev_close
    return out


class TencentSource(DataSource):
    name = "tencent"

    def supports_period(self, period: str) -> bool:
        # 腾讯目前公开端点只支持日/周/月
        return period in _KLINE_PERIOD_MAP

    def get_quote(self, symbol: str) -> Quote:
        sym = parse_symbol(symbol)
        code = _tencent_code(sym)
        url = f"https://qt.gtimg.cn/q={code}"
        resp = _http_get(url, timeout=4.0)
        # 腾讯 A 股返回 GBK
        try:
            text = resp.content.decode("gbk")
        except UnicodeDecodeError:
            text = resp.text

        q = _parse_quote_string(text, sym)
        if q is None:
            raise RuntimeError(f"腾讯无该标的数据: {sym.normalized}")
        return q

    def get_kline(self, symbol: str, period: str, limit: int) -> List[KlinePoint]:
        if period not in _KLINE_PERIOD_MAP:
            raise RuntimeError(f"腾讯不支持周期: {period}")
        sym = parse_symbol(symbol)
        # 美股必须用带后缀的代码（否则只返回 2 根）
        if sym.market == Market.US:
            code = _resolve_us_kline_code(sym)
        else:
            code = _tencent_code(sym)
        tp = _KLINE_PERIOD_MAP[period]
        count = max(1, min(int(limit), 640))  # 腾讯上限约 640

        url = (
            f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?"
            f"param={code},{tp},,,{count},qfq"
        )
        resp = _http_get(url, timeout=5.0)
        try:
            payload = resp.json()
        except Exception as e:
            raise RuntimeError(f"腾讯 kline JSON 解析失败: {e}")
        if payload.get("code") != 0:
            raise RuntimeError(
                f"腾讯 kline 错误 code={payload.get('code')} msg={payload.get('msg')}"
            )

        # A 股会有 qfqday/qfqweek/qfqmonth；港美股则是 day/week/month
        pref = [f"qfq{tp}", tp]
        return _parse_kline_data(payload.get("data") or {}, pref)

    def get_intraday(self, symbol: str) -> List[IntradayPoint]:
        sym = parse_symbol(symbol)
        code = _tencent_code(sym)
        url = f"https://web.ifzq.gtimg.cn/appstock/app/minute/query?code={code}"
        resp = _http_get(url, timeout=5.0)
        try:
            payload = resp.json()
        except Exception as e:
            raise RuntimeError(f"腾讯 minute JSON 解析失败: {e}")
        if payload.get("code") != 0:
            raise RuntimeError(
                f"腾讯 minute 错误 code={payload.get('code')} msg={payload.get('msg')}"
            )
        # A 股 volume 单位是"手"（100 股），港美股是"股"
        vol_mul = 100 if sym.is_a_share else 1
        return _parse_intraday_data(
            payload.get("data") or {}, prev_close=None, volume_multiplier=vol_mul
        )

    def search(self, keyword: str, limit: int = 20) -> List[SearchItem]:
        """
        腾讯搜索端点：
            https://smartbox.gtimg.cn/s3/?q=茅台&t=all
        返回 JSONP-like，形如：
            v_hint="sh~600519~贵州茅台~gzmt~11~1305.00~ ...^sh~601288~..."
        用 ^ 分隔条目，字段用 ~ 分隔。
        """
        kw = keyword.strip()
        if not kw:
            return []
        url = f"https://smartbox.gtimg.cn/s3/?q={requests.utils.quote(kw)}&t=all"
        try:
            resp = _http_get(url, timeout=4.0)
            text = resp.content.decode("gbk", errors="replace")
        except Exception as e:
            raise RuntimeError(f"腾讯搜索失败: {e}")

        m = re.search(r'="([^"]+)"', text)
        if not m:
            return []
        raw = m.group(1)
        items: List[SearchItem] = []
        for entry in raw.split("^"):
            if not entry:
                continue
            parts = entry.split("~")
            if len(parts) < 3:
                continue
            tag, code, name = parts[0], parts[1], parts[2]
            # 腾讯 smartbox 会把中文以 \\u1234 形式 escape，转回来
            try:
                if "\\u" in name:
                    name = name.encode("utf-8").decode("unicode_escape")
            except Exception:
                pass
            market_map = {
                "sh": "SH", "sz": "SZ", "bj": "BJ",
                "hk": "HK", "us": "US",
            }
            market = market_map.get(tag.lower())
            if not market:
                continue
            # 港股保留 5 位；美股保留字母原样
            items.append(SearchItem(
                symbol=f"{market}:{code}",
                name=name,
                market=market,
            ))
            if len(items) >= limit:
                break
        return items
