"""分红派息路由。"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime

from fastapi import APIRouter, Query

import aggregator as adapter
from models import ApiResponse, DividendInfo

logger = logging.getLogger(__name__)
router = APIRouter()


def _default_end_date() -> str:
    """默认取"今天"作为 TTM 截止日期。"""
    return datetime.now().strftime("%Y-%m-%d")


@router.get("/dividend", response_model=ApiResponse[DividendInfo])
async def dividend(
    symbol: str = Query(..., description="MARKET:CODE，仅支持 A 股/港股"),
    end_date: str = Query(
        default_factory=_default_end_date,
        pattern=r"^\d{4}-\d{2}-\d{2}$",
        description="TTM 截止日期 YYYY-MM-DD，缺省=今天。归集区间为 (end_date-365d, end_date]",
    ),
):
    try:
        data = await asyncio.to_thread(adapter.get_dividend, symbol, end_date)
        return ApiResponse(code=0, msg="ok", data=data)
    except Exception as e:
        logger.exception("dividend 失败 %s %s", symbol, end_date)
        return ApiResponse(code=500, msg=str(e), data=None)
