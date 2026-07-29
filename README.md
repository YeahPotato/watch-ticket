# Watch Ticket · 行情监听

基于 Tauri + React + Python(AKShare) 的多市场股票行情监听桌面应用。

## 功能规划

- 多市场支持：A 股（沪深北）、港股、美股
- 实时**分时**与**多周期 K 线**（1m/5m/15m/30m/60m/日/周/月）
- **MACD** 指标计算 + **金叉/死叉**告警（通知 + 声音 + 记录）
- **多只股票同时监听**，轮询频率**可配置**
- **仪表盘多窗口**布局（可拖拽调整）
- 本地 **SQLite** 存储，保留最近 30 天数据

## 数据源

- **主：腾讯行情**（`qt.gtimg.cn` + `web.ifzq.gtimg.cn` + `smartbox.gtimg.cn`）
  - 支持 A/HK/US 的 quote、日/周/月 K、当日分时、股票搜索
- **副：AKShare**（东方财富）
  - 兜底：腾讯失败时自动回退
  - 唯一路径：**分钟 K 线**（1m/5m/15m/30m/60m），腾讯已下线公开分钟 K 端点
- 数据源切换在 `python-sidecar/aggregator.py`，路由和 Rust 端无感知

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面框架 | Tauri 2 |
| 前端 | React 19 + TypeScript + Vite |
| UI | Tailwind CSS + shadcn/ui + lucide-react |
| 图表 | lightweight-charts + ECharts |
| 状态 | Zustand |
| 后端 | Rust (tokio + sqlx + reqwest) |
| 数据源 | Python 3.11 + AKShare + FastAPI（Sidecar） |
| 存储 | SQLite |

## 目录结构

```
watch-ticket/
├── src/                # React 前端
├── src-tauri/          # Rust 后端
├── python-sidecar/     # Python 数据服务
```

## 开发环境要求

- Node.js ≥ 18
- pnpm ≥ 9
- Rust（stable）
- Python 3.11+（供 sidecar 使用；本项目开发默认使用 `C:\Users\jokeyyang\.workbuddy\binaries\python\versions\3.11.9\python.exe`）

## 常用命令

```bash
# 安装依赖
pnpm install

# 桌面端开发（会自动启动前端 + Rust）
pnpm tauri dev

# 打包发布
pnpm tauri build

# Python sidecar 开发（P2 之后可用）
pnpm sidecar:dev

# Python sidecar 打包成 exe（P7 之后可用）
pnpm sidecar:build
```

## 发布

- 提交修改，更新package.json , tauri.conf.json的版本
- git tag new-tag && git push origin new-tag



## 实施进度

- [x] P1 项目脚手架
- [x] P2 Python sidecar 开发（代码交付；东财数据源联调需切换到可访问 eastmoney.com 的网络环境）
- [x] P3 Rust 接入 sidecar + SQLite
- [x] P4 轮询调度 + 订阅管理
- [x] P5 前端仪表盘 + 分时/K 线图
- [x] P6 MACD + 金叉死叉告警
- [ ] P7 Sidecar 打包 + 数据清理 + 打磨
- [ ] P4 轮询调度 + 订阅管理
- [ ] P5 前端仪表盘 + 分时/K 线图
- [ ] P6 MACD + 金叉死叉告警
- [ ] P7 sidecar 打包 + 数据清理 + 打磨
