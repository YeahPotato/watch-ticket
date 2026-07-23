## Python 数据服务（Sidecar）

- 运行时：Python 3.11.9
- 依赖：AKShare + FastAPI + Uvicorn
- 用途：作为 Tauri sidecar，为 Rust 后端提供多市场行情 HTTP 接口

P2 阶段将在此目录添加：
- `main.py` - FastAPI 入口
- `akshare_adapter.py` - 多市场统一封装
- `routes/` - 路由拆分（intraday / kline）
- `requirements.txt`
- `build.py` - PyInstaller 打包脚本
