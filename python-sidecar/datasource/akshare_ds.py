"""
AKShare 数据源（兜底）。

复用现有 akshare_adapter 里的函数实现，只做接口适配。
"""

from __future__ import annotations

from typing import List

from datasource.base import DataSource
from models import IntradayPoint, KlinePoint, Quote, SearchItem


class AkshareSource(DataSource):
    name = "akshare"

    # AKShare 支持全部周期
    def supports_period(self, period: str) -> bool:
        return period in {"1m", "5m", "15m", "30m", "60m", "1d", "1w", "1M"}

    def get_quote(self, symbol: str) -> Quote:
        # 延迟导入避免循环
        from akshare_adapter import get_quote as _impl
        return _impl(symbol)

    def get_intraday(self, symbol: str) -> List[IntradayPoint]:
        from akshare_adapter import get_intraday as _impl
        return _impl(symbol)

    def get_kline(self, symbol: str, period: str, limit: int) -> List[KlinePoint]:
        from akshare_adapter import get_kline as _impl
        return _impl(symbol, period, limit)

    def search(self, keyword: str, limit: int = 20) -> List[SearchItem]:
        from akshare_adapter import search as _impl
        return _impl(keyword, limit)
