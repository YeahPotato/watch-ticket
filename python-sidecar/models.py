"""Pydantic 响应模型定义。"""

from __future__ import annotations

from typing import Any, Generic, Optional, TypeVar

from pydantic import BaseModel, Field

T = TypeVar("T")


class ApiResponse(BaseModel, Generic[T]):
    """统一 API 响应格式。"""

    code: int = Field(default=0, description="0 成功，非 0 错误")
    msg: str = Field(default="ok")
    data: Optional[T] = None


class Quote(BaseModel):
    """最新报价快照。"""

    symbol: str
    name: Optional[str] = None
    price: Optional[float] = None          # 现价
    open: Optional[float] = None
    high: Optional[float] = None
    low: Optional[float] = None
    prev_close: Optional[float] = None     # 昨收
    change: Optional[float] = None         # 涨跌额
    change_pct: Optional[float] = None     # 涨跌幅（%）
    volume: Optional[float] = None         # 成交量（股）
    amount: Optional[float] = None         # 成交额（元）
    ts: Optional[str] = None               # 时间戳（ISO 或 HH:MM:SS）


class IntradayPoint(BaseModel):
    """分时数据的一个点（通常是 1 分钟粒度）。"""

    ts: str                                # "YYYY-MM-DD HH:MM:SS" 或 "HH:MM"
    price: float
    avg_price: Optional[float] = None      # 均价
    volume: Optional[float] = None
    amount: Optional[float] = None


class KlinePoint(BaseModel):
    """K 线一根。"""

    ts: str                                # "YYYY-MM-DD" 或 "YYYY-MM-DD HH:MM:SS"
    open: float
    high: float
    low: float
    close: float
    volume: Optional[float] = None
    amount: Optional[float] = None


class SearchItem(BaseModel):
    """搜索结果项。"""

    symbol: str                            # 统一格式 MARKET:CODE
    name: str
    market: str


class DividendRecord(BaseModel):
    """单笔分红明细。"""

    ex_date: Optional[str] = None          # 除权除息日，"YYYY-MM-DD"
    cash_per_share: Optional[float] = None # 每股派息（税前含税，元/股）
    note: Optional[str] = None             # 备注（如"末期股息"/"特别股息"）


class DividendInfo(BaseModel):
    """过去 12 个月（TTM）的分红汇总。

    口径：以除权除息日在 [end_date - 12 months, end_date] 区间的分红加总（税前含税）。
    这与东财 F10 显示的"股息率"口径一致。
    dividend_per_share = 该区间所有派息之和（元/股）
    """

    symbol: str
    year: int                              # [已废弃语义] 兼容旧版：end_date 所在自然年
    end_date: Optional[str] = None         # TTM 截止日期，"YYYY-MM-DD"
    dividend_per_share: Optional[float] = None  # 12 个月加总（元/股）
    records: list[DividendRecord] = []
    source: Optional[str] = None


class ErrorInfo(BaseModel):
    detail: Any = None
