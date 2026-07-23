"""
离线自测（不访问网络）。

只覆盖纯逻辑：
    - market_utils.parse_symbol / Symbol.to_native / guess_a_share_market
    - models 的构建
    - FastAPI 应用可正常构造，路由数量正确

真实数据接口的联调放到 P4 或用户切网后手动测。

运行方式：
    .venv/Scripts/python.exe test_offline.py
"""

from __future__ import annotations

import sys


def test_parse_symbol() -> None:
    from market_utils import Market, parse_symbol

    cases = [
        ("SH:600519", Market.SH, "600519"),
        ("sh:600519", Market.SH, "600519"),
        ("sh600519", Market.SH, "600519"),
        ("SZ:000001", Market.SZ, "000001"),
        ("BJ:430047", Market.BJ, "430047"),
        ("HK:00700", Market.HK, "00700"),
        ("hk00700", Market.HK, "00700"),
        ("US:AAPL", Market.US, "AAPL"),
        ("us:aapl", Market.US, "AAPL"),
    ]
    for raw, m, c in cases:
        s = parse_symbol(raw)
        assert s.market == m and s.code == c, f"{raw} -> {s}"
    # 非法
    for raw in ("", "600519", "XX:600519"):
        try:
            parse_symbol(raw)
        except ValueError:
            continue
        raise AssertionError(f"应该抛错: {raw!r}")
    print("[OK] parse_symbol")


def test_symbol_to_native() -> None:
    from market_utils import parse_symbol

    s = parse_symbol("SH:600519")
    assert s.to_native("plain") == "600519"
    assert s.to_native("east") == "sh600519"

    s = parse_symbol("HK:700")
    assert s.to_native("hk_num") == "00700"

    s = parse_symbol("US:AAPL")
    assert s.to_native("us_dot") == "105.AAPL"
    print("[OK] Symbol.to_native")


def test_guess_a_share_market() -> None:
    from market_utils import Market, guess_a_share_market

    assert guess_a_share_market("600519") == Market.SH
    assert guess_a_share_market("688981") == Market.SH  # 科创板
    assert guess_a_share_market("000001") == Market.SZ
    assert guess_a_share_market("300750") == Market.SZ  # 创业板
    assert guess_a_share_market("430047") == Market.BJ
    assert guess_a_share_market("831010") == Market.BJ
    print("[OK] guess_a_share_market")


def test_models() -> None:
    from models import ApiResponse, IntradayPoint, KlinePoint, Quote, SearchItem

    q = Quote(symbol="SH:600519", name="贵州茅台", price=1800.0)
    assert q.symbol == "SH:600519"

    kp = KlinePoint(ts="2026-07-22", open=1.0, high=2.0, low=0.5, close=1.5)
    assert kp.close == 1.5

    ip = IntradayPoint(ts="09:30", price=100.0)
    assert ip.price == 100.0

    si = SearchItem(symbol="SH:600519", name="贵州茅台", market="SH")
    assert si.market == "SH"

    resp = ApiResponse[Quote](code=0, msg="ok", data=q)
    assert resp.code == 0 and resp.data and resp.data.symbol == "SH:600519"

    err = ApiResponse[Quote](code=500, msg="boom", data=None)
    assert err.code == 500 and err.data is None
    print("[OK] models")


def test_app_construct() -> None:
    from main import create_app

    app = create_app()
    paths = {r.path for r in app.routes}
    # 关键业务路径应存在
    for p in ("/health", "/quote", "/quotes", "/intraday", "/kline", "/search"):
        assert p in paths, f"路由缺失: {p}"
    print("[OK] FastAPI 应用构造，共", len(paths), "个路径")


def main() -> int:
    tests = [
        test_parse_symbol,
        test_symbol_to_native,
        test_guess_a_share_market,
        test_models,
        test_app_construct,
    ]
    failed = 0
    for t in tests:
        try:
            t()
        except AssertionError as e:
            print("[FAIL]", t.__name__, e)
            failed += 1
        except Exception as e:
            print("[ERR]", t.__name__, type(e).__name__, e)
            failed += 1
    if failed:
        print(f"\n共 {failed} 项失败")
        return 1
    print(f"\n全部 {len(tests)} 项通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
