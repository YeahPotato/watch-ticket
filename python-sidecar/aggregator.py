"""
数据源聚合器（对外统一入口）。

策略：
    - 主：腾讯（quote / 日周月 K / 分时）
    - 副：AKShare（腾讯不支持的周期，以及腾讯失败时兜底）

调用规则：
    - 首选腾讯；抛异常/无数据时 → 降级 AKShare
    - 若腾讯明确表示"不支持该周期"（如分钟 K），直接走 AKShare 不做重试
    - 搜索：先试腾讯 smartbox；无结果或失败 → AKShare

日志：
    - 主源失败 warning 一次；成功用 info 记录来源便于观察
"""

from __future__ import annotations

import logging
from typing import Iterable, List

from datasource.akshare_ds import AkshareSource
from datasource.base import DataSource
from datasource.tencent import TencentSource
from market_utils import parse_symbol
from models import IntradayPoint, KlinePoint, Quote, SearchItem

logger = logging.getLogger(__name__)

_primary: DataSource = TencentSource()
_fallback: DataSource = AkshareSource()


def _try(primary_call, fallback_call, label: str):
    """先跑主源；抛异常时跑兜底。返回 (result, source_name)。"""
    try:
        r = primary_call()
        return r, _primary.name
    except Exception as e:
        logger.warning("[%s] 主源(%s)失败，回退副源: %s", label, _primary.name, e)
        try:
            r = fallback_call()
            return r, _fallback.name
        except Exception as e2:
            # 组合错误信息，方便前端定位
            raise RuntimeError(
                f"两个数据源都失败 主({_primary.name})={e} 副({_fallback.name})={e2}"
            )


# =============== Quote ===============
def get_quote(symbol: str) -> Quote:
    result, _ = _try(
        lambda: _primary.get_quote(symbol),
        lambda: _fallback.get_quote(symbol),
        label=f"quote {symbol}",
    )
    return result


def get_quotes(symbols: Iterable[str]) -> List[Quote]:
    out: List[Quote] = []
    for s in symbols:
        try:
            out.append(get_quote(s))
        except Exception as e:
            logger.warning("批量 quote 单只失败 %s: %s", s, e)
            try:
                sym = parse_symbol(s)
                out.append(Quote(symbol=sym.normalized))
            except Exception:
                out.append(Quote(symbol=s))
    return out


# =============== Intraday ===============
def get_intraday(symbol: str) -> List[IntradayPoint]:
    result, _ = _try(
        lambda: _primary.get_intraday(symbol),
        lambda: _fallback.get_intraday(symbol),
        label=f"intraday {symbol}",
    )
    return result


# =============== K 线 ===============
def get_kline(symbol: str, period: str, limit: int = 500) -> List[KlinePoint]:
    # 腾讯只支持 1d/1w/1M；其它周期直接走 AKShare
    if not _primary.supports_period(period):
        logger.info("kline %s period=%s 直接走 %s（主源不支持）", symbol, period, _fallback.name)
        return _fallback.get_kline(symbol, period, limit)

    result, _ = _try(
        lambda: _primary.get_kline(symbol, period, limit),
        lambda: _fallback.get_kline(symbol, period, limit),
        label=f"kline {symbol} {period}",
    )
    return result


# =============== 搜索 ===============
def search(keyword: str, limit: int = 20) -> List[SearchItem]:
    if not keyword:
        return []
    # 先尝试腾讯 smartbox
    try:
        r = _primary.search(keyword, limit)
        if r:
            return r
    except Exception as e:
        logger.warning("搜索主源失败: %s", e)

    # 兜底 AKShare
    try:
        return _fallback.search(keyword, limit)
    except Exception as e:
        raise RuntimeError(f"搜索失败: {e}")
