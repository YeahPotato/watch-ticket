"""报价 / 分时数据路由。"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Query

import aggregator as adapter
from models import ApiResponse, IntradayPoint, Quote

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/quote", response_model=ApiResponse[Quote])
async def quote(symbol: str = Query(..., description="MARKET:CODE，如 SH:600519")):
    try:
        q = await asyncio.to_thread(adapter.get_quote, symbol)
        return ApiResponse(code=0, msg="ok", data=q)
    except Exception as e:
        logger.exception("quote 失败 %s", symbol)
        return ApiResponse(code=500, msg=str(e), data=None)


@router.get("/quotes", response_model=ApiResponse[list[Quote]])
async def quotes(symbols: str = Query(..., description="多个 symbol，逗号分隔")):
    syms = [s.strip() for s in symbols.split(",") if s.strip()]
    if not syms:
        return ApiResponse(code=400, msg="symbols 为空", data=None)
    try:
        result = await asyncio.to_thread(adapter.get_quotes, syms)
        return ApiResponse(code=0, msg="ok", data=result)
    except Exception as e:
        logger.exception("quotes 失败 %s", symbols)
        return ApiResponse(code=500, msg=str(e), data=None)


@router.get("/intraday", response_model=ApiResponse[list[IntradayPoint]])
async def intraday(symbol: str = Query(..., description="MARKET:CODE")):
    try:
        data = await asyncio.to_thread(adapter.get_intraday, symbol)
        return ApiResponse(code=0, msg="ok", data=data)
    except Exception as e:
        logger.exception("intraday 失败 %s", symbol)
        return ApiResponse(code=500, msg=str(e), data=None)
