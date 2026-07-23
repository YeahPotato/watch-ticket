"""
数据源抽象接口。

约定：
    - 所有方法同步阻塞（由上层 asyncio.to_thread 调用）
    - 数据缺失或明确错误时抛 RuntimeError（附带简短原因）
    - 网络类临时错误抛 requests.exceptions.RequestException（可被上层重试/回退）
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import List

from models import IntradayPoint, KlinePoint, Quote, SearchItem


class DataSource(ABC):
    """行情数据源抽象类。"""

    name: str = "base"

    @abstractmethod
    def get_quote(self, symbol: str) -> Quote:
        ...

    @abstractmethod
    def get_intraday(self, symbol: str) -> List[IntradayPoint]:
        ...

    @abstractmethod
    def get_kline(self, symbol: str, period: str, limit: int) -> List[KlinePoint]:
        ...

    def search(self, keyword: str, limit: int = 20) -> List[SearchItem]:
        """默认实现：不支持搜索。"""
        raise NotImplementedError(f"{self.name} 不支持搜索")

    # 该数据源是否支持指定的周期
    def supports_period(self, period: str) -> bool:
        return period in {"1d", "1w", "1M"}
