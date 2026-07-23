"""K 线数据路由。"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Query

import aggregator as adapter
from models import ApiResponse, KlinePoint, SearchItem

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/kline", response_model=ApiResponse[list[KlinePoint]])
async def kline(
    symbol: str = Query(..., description="MARKET:CODE"),
    period: str = Query("1d", description="1m/5m/15m/30m/60m/1d/1w/1M"),
    limit: int = Query(500, ge=1, le=5000),
):
    try:
        data = await asyncio.to_thread(adapter.get_kline, symbol, period, limit)
        return ApiResponse(code=0, msg="ok", data=data)
    except Exception as e:
        logger.exception("kline 失败 %s %s", symbol, period)
        return ApiResponse(code=500, msg=str(e), data=None)


@router.get("/search", response_model=ApiResponse[list[SearchItem]])
async def search(
    keyword: str = Query(..., min_length=1),
    limit: int = Query(20, ge=1, le=100),
):
    try:
        data = await asyncio.to_thread(adapter.search, keyword, limit)
        return ApiResponse(code=0, msg="ok", data=data)
    except Exception as e:
        logger.exception("search 失败 %s", keyword)
        return ApiResponse(code=500, msg=str(e), data=None)
