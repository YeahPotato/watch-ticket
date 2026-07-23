"""
Watch Ticket · Python Sidecar 主入口。

作为 Tauri 的 sidecar 子进程运行，提供本地 HTTP 接口封装 AKShare。

启动模式：
    - 默认：监听 127.0.0.1:0（系统分配空闲端口），在 stdout 首行打印
        {"event":"ready","port":<port>}
      Rust 端解析后拿到端口。
    - 开发调试：--port 8765 固定端口，方便 curl 测试。

命令行参数：
    --host   默认 127.0.0.1
    --port   默认 0（系统分配）
    --debug  开启 uvicorn reload + 调试日志
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import socket
import sys

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routes.health import router as health_router
from routes.intraday import router as intraday_router
from routes.kline import router as kline_router


def _apply_proxy_env(proxy: str | None) -> None:
    """让下游 requests/curl_cffi 自动走代理。

    优先级：命令行 --proxy > 已有环境变量。
    Windows 上公司网通常需要走本地代理才能访问东财等金融数据源。
    """
    if not proxy:
        return
    os.environ["HTTP_PROXY"] = proxy
    os.environ["HTTPS_PROXY"] = proxy
    # 大写和小写都设，兼容不同库
    os.environ["http_proxy"] = proxy
    os.environ["https_proxy"] = proxy


def create_app() -> FastAPI:
    app = FastAPI(
        title="Watch Ticket Sidecar",
        version="0.1.0",
        description="AKShare 多市场行情本地服务",
    )

    # 允许本地跨源调用（Tauri 前端偶尔会直接 fetch 用于调试）
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["GET"],
        allow_headers=["*"],
    )

    app.include_router(health_router)
    app.include_router(intraday_router)
    app.include_router(kline_router)

    return app


def _pick_free_port(host: str) -> int:
    """让系统分配一个空闲端口。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        return s.getsockname()[1]


def _announce_ready(port: int) -> None:
    """向 stdout 首行打印 ready 事件，供 Rust 侧解析。"""
    payload = {"event": "ready", "port": port}
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def main() -> None:
    parser = argparse.ArgumentParser(description="Watch Ticket Sidecar")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0, help="0 表示系统自动分配")
    parser.add_argument("--debug", action="store_true")
    parser.add_argument(
        "--proxy",
        default=os.environ.get("WATCH_TICKET_PROXY"),
        help="HTTP/HTTPS 代理，如 http://127.0.0.1:7890。也可读环境变量 WATCH_TICKET_PROXY",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.debug else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    _apply_proxy_env(args.proxy)
    if args.proxy:
        logging.info("已启用代理: %s", args.proxy)

    port = args.port or _pick_free_port(args.host)

    # 先打印 ready，再启动服务；实际监听在 uvicorn.run 之后才可用，
    # Rust 侧应做健康检查重试。
    _announce_ready(port)

    uvicorn.run(
        create_app(),
        host=args.host,
        port=port,
        log_level="debug" if args.debug else "info",
        access_log=args.debug,
    )


if __name__ == "__main__":
    main()
