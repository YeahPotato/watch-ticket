"""健康检查路由。"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter

from models import ApiResponse

router = APIRouter()


@router.get("/health", response_model=ApiResponse[dict])
async def health() -> ApiResponse[dict]:
    return ApiResponse(
        code=0,
        msg="ok",
        data={
            "status": "up",
            "time": datetime.now().isoformat(timespec="seconds"),
        },
    )
