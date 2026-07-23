"""
市场判断与股票代码规范化工具。

统一代码格式：MARKET:CODE
    - SH:600519 / SZ:000001 / BJ:430047   （A 股，6 位数字）
    - HK:00700                             （港股，通常 5 位数字）
    - US:AAPL                              （美股，字母代码，可能带 . 或 -）

对外 API 使用统一格式；AKShare 各接口要求的原生代码通过 to_native() 转换。
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class Market(str, Enum):
    SH = "SH"   # 上交所
    SZ = "SZ"   # 深交所
    BJ = "BJ"   # 北交所
    HK = "HK"   # 港交所
    US = "US"   # 美股


@dataclass(frozen=True)
class Symbol:
    market: Market
    code: str  # 不含市场前缀的原始代码

    @property
    def normalized(self) -> str:
        return f"{self.market.value}:{self.code}"

    @property
    def is_a_share(self) -> bool:
        return self.market in (Market.SH, Market.SZ, Market.BJ)

    def to_native(self, style: str) -> str:
        """将统一代码转换为 AKShare 各接口需要的原生格式。

        style 可选：
            - "plain"     : 纯代码，如 "600519"、"00700"、"AAPL"
            - "east"      : 东财风格前缀，如 "sh600519"、"sz000001"（部分 A 股接口用）
            - "hk_num"    : 港股 5 位补零，如 "00700"
            - "us_dot"    : 美股 AKShare 常用格式，如 "105.AAPL"（东财 code）
        """
        m, c = self.market, self.code
        if style == "plain":
            return c
        if style == "east":
            if m == Market.SH:
                return f"sh{c}"
            if m == Market.SZ:
                return f"sz{c}"
            if m == Market.BJ:
                return f"bj{c}"
            return c
        if style == "hk_num":
            # 港股统一 5 位补零
            return c.zfill(5)
        if style == "us_dot":
            # AKShare 美股接口的部分方法使用 "市场id.代码" 格式
            # 默认使用 105（纳斯达克），106（纽交所），107（美交所）
            # 由于我们无法在此处知道具体市场，默认 105，业务层可覆盖
            return f"105.{c}"
        raise ValueError(f"未知的 to_native 风格: {style}")


def parse_symbol(symbol: str) -> Symbol:
    """解析统一格式的股票代码。

    支持：
        - "SH:600519" / "sh:600519" / "sh600519"
        - "SZ:000001" / "sz000001"
        - "BJ:430047" / "bj430047"
        - "HK:00700" / "hk00700"
        - "US:AAPL"  / "us:aapl"

    对于不带市场前缀的裸代码，抛错要求上层显式指定。
    """
    if not symbol:
        raise ValueError("symbol 为空")

    s = symbol.strip().upper()

    # 冒号分隔
    if ":" in s:
        m_str, code = s.split(":", 1)
        try:
            market = Market(m_str)
        except ValueError as e:
            raise ValueError(f"未知市场: {m_str}") from e
        return Symbol(market=market, code=code.strip())

    # 无冒号：尝试识别前缀
    for m in (Market.SH, Market.SZ, Market.BJ, Market.HK, Market.US):
        if s.startswith(m.value):
            code = s[len(m.value):]
            if code:
                return Symbol(market=m, code=code)

    raise ValueError(
        f"无法识别的代码格式: {symbol}，请使用 MARKET:CODE，如 SH:600519 / HK:00700 / US:AAPL"
    )


def guess_a_share_market(code: str) -> Market:
    """A 股裸代码猜市场（辅助工具，不推荐 API 直接使用）。

    规则（简化，未覆盖所有边缘）：
        - 60/68/9 开头 → SH
        - 00/30/2 开头 → SZ
        - 43/83/87/88/920/4 开头 → BJ
    """
    c = code.strip()
    if c.startswith(("60", "68", "9")):
        return Market.SH
    if c.startswith(("00", "30", "2")):
        return Market.SZ
    if c.startswith(("43", "83", "87", "88", "92", "4")):
        return Market.BJ
    # 默认深市
    return Market.SZ
