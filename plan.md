需求：
1. 新加模块「量化分析」

功能：
- 用户从自选列表选择股票，给出历史 3 年的价格
- 算出均价（3 年算术均，用于参考显示）
- 结合量化指标（MACD/RSI/KDJ/BOLL/OBV/均线趋势）给出 5 档评级 + 建议动作
- 建议加仓价 / 建议减仓价（技术位 + 现价折价/溢价 3 档）
- 触发价 & 保守价双语义（触发价易触及、保守价更远离现价）
- 表格支持按字段排序（点表头 3 态循环）
- 每支股票可添加自由文本备注（点击表格 cell 编辑，失焦保存）
- widget 支持拖拽调整大小（右下角把手）


实现情况（已完成）：
- 后端：analyzer.rs（评级引擎 + 建议价引擎）+ indicators.rs（5 指标）
- 后端：analyze_symbol / is_market_open / update_subscription_note 命令
- migrations/004_add_note.sql：subscriptions 加 note 字段
- 前端 widget：AnalysisWidget.tsx
    表格列（12 列）：
      市场 / 代码 / 名称 / 现价 / 涨跌幅 / 评级 / 建议动作 /
      建议买入价 / 建议卖出价 / 备注 / 分析时间 / 操作
- 数据源：
    - 现价 & 涨跌幅：现有 quote:updated 事件，交易时段每 3 秒自动刷新
    - 评级：手动刷新 + 自动刷新（交易时段每 60 秒），3 并发限流
- 建议价（各期数据充足时才给）：
    - 技术支撑/压力 = median(BOLL上/下轨, EMA20, 20日极值)
    - 加仓触发价 = max(support, last_close×0.95)   ← 表格主显示
    - 加仓保守价 = min(support, last_close×0.95)   ← tooltip 显示
    - 减仓触发价 = min(resistance, last_close×1.05) ← 表格主显示
    - 减仓保守价 = max(resistance, last_close×1.05) ← tooltip 显示
    - 3 档折价/溢价：**基于 last_close**（现价），×0.95/0.92/0.90（买）与 1.05/1.08/1.10（卖）
      * 修正历史 bug：早期用 3 年均价做基准，现价严重偏离均价时会导致"减仓 < 加仓"的逻辑悖论
    - **保守价 clamp**：advised 夹逼到现价 ±15%，避免近 20 日闪崩/爆拉使 support 中位数被极值污染
      * 触发价不夹逼（reflect 真实市场支撑/压力）
    - 展示：tooltip 一体显示（触发价 + 保守价 + 技术位 + 3 档现价折价 + 3 年均价对比）
    - 支撑位/压力位 tooltip 标注"（下列三者中位数）"，避免用户疑惑
    - 档位色深：一档 -400 / 二档 -600 / 三档 -800（越深越保守）
- 表格排序：
    - 可排序列：代码 / 名称 / 现价 / 涨跌幅 / 评级综合分 / 分析时间
    - 点表头 3 态循环：desc → asc → 无
    - null 值统一沉底，保持相对顺序稳定
    - 默认排序：评级综合分降序
    - 持久化到 SQLite settings（key: analysis_widget_sort），跨 widget 共享
- 备注：
    - 存储：subscriptions 表 note 字段（跟股票生命周期绑定，删自选自动删）
    - UI：表格内直接可编辑 input，失焦保存，Enter 提交，Esc 取消
    - 乐观更新：编辑立即生效，后端确认后由 subscription:changed 事件矫正
- widget 拖拽 & 调整大小：
    - react-grid-layout 原生支持
    - vite.config.ts 加 process.env.NODE_ENV define，修复 react-draggable 在浏览器抛 ReferenceError
    - Dashboard 加 draggableCancel（button/input/select/label 等交互元素）避免误触发拖动
    - index.css 覆盖 handle 样式（内嵌 18×18 muted 小方块，hover 高亮）+ placeholder 换主题色淡透明
- 表内隐藏（不动自选）：
    - 每行操作列加垃圾桶按钮，一键从量化分析里隐藏该票（其他 widget 不受影响）
    - 隐藏列表持久化到 SQLite settings（key: analysis_widget_hidden）
    - 标题栏显示 `visible/total`，有隐藏时旁边出齿轮菜单，可单独恢复或全部恢复
    - 齿轮菜单里点 item 阻止默认关闭，方便批量恢复
    - 载入时与 subscriptions 求交集，自动清理孤儿（用户在别处删自选后隐藏列表里的残留 symbol）
    - refreshAll / 自动 tick 均只作用于可见列表，避免后台白跑分析
- 手动拖拽排序（@dnd-kit）：
    - 整行可拖，PointerSensor distance=5px 阈值避免误触发单击
    - 拖动自动切 sort.field='manual'，与字段排序并存
    - 手动模式下标题栏出现「手动排序中 · 恢复」按钮，点击回到默认（评级降序）
    - 拖拽结果持久化到 SQLite settings（key: analysis_widget_manual_order）
    - 隐藏的票在 manualOrder 中保留位置（恢复后回到原位）
    - 载入时与 subscriptions 求交集清理孤儿
- 建议动作映射：
    - strong_buy  → 建仓/加仓
    - watch_buy   → 关注买点
    - hold        → 持有观望
    - watch_sell  → 关注减仓
    - strong_sell → 减仓/清仓
- 周期可切：日线（默认 750 根 ≈ 3 年）/周线（156 根）/月线（36 根）
- 系统托盘（Windows）：
    - Cargo.toml: tauri 加 tray-icon feature
    - 关闭主窗口按钮（X）不退出应用，改为拦截 CloseRequested → 隐藏窗口到托盘
    - 托盘图标 tooltip: "Watch Ticket · 行情监听"，图标复用应用 default_window_icon
    - 左键单击托盘：切换主窗口显示/隐藏（is_visible → hide 或 show+unminimize+set_focus）
    - 右键菜单：
      * "关于 Watch Ticket vX.Y.Z"（disabled，仅展示运行时版本号，来自 package_info）
      * 分隔线
      * "退出"（app.exit(0) 触发 Destroyed → 清理 sidecar）
    - Destroyed 事件保留原逻辑（sidecar.kill），只在真正退出时触发
- Sidecar 生命周期（Windows Job Object）：
    - Cargo.toml: winapi 加 jobapi2/processthreadsapi/handleapi/winnt features
    - sidecar.rs: spawn 成功后立即把子进程加入 Job Object（KILL_ON_JOB_CLOSE 标志）
    - SidecarHandle 持有 job handle，Drop 时关闭 handle 触发批量 kill
    - 效果：主进程无论正常退出/崩溃/被 taskkill，Windows 内核都会自动清理 sidecar，
      避免遗留孤儿进程占用端口 & 内存
    - 加入 job 失败时只 warn 不阻塞启动（graceful degradation）
- Sidecar 启动优先级（Dev / Release 差异化）：
    - Debug 构建（pnpm tauri dev）：**优先跑 python-sidecar/.venv 源码**，找不到才降级 bundled exe
      * 好处：改 Python 代码后重启 tauri dev 立即生效，无需 PyInstaller 重新打包
    - Release 构建：优先 bundled exe（PyInstaller 产物），保证发布版无需用户机器有 Python
    - 通过 cfg!(debug_assertions) 区分
- 分红派息 / 股息率（TTM，与东财 F10 口径一致）：
    - sidecar 新增 /dividend?symbol=&end_date= 接口
      * end_date：TTM 截止日期 YYYY-MM-DD，缺省=今天。归集区间 (end_date - 365 天, end_date]
      * A 股主源：ak.stock_fhps_detail_em（每 10 股派 X 元 → /10）
      * 港股主源：ak.stock_hk_dividend_payout_em（"分红方案"正则提取"每股派 X 元"）
      * 港股副源：ak.stock_hk_fhpx_detail_ths（fallback）
      * US / 不支持市场：source="unsupported"
      * 不缓存，每次调用实时拉
    - main.py 顶部 TQDM_DISABLE=1 环境变量，避免 tqdm 在 Windows pipe stderr 并发写入崩溃
      （3 并发下多个 akshare 请求会引发 OSError [Errno 22]）
    - Rust: models::DividendInfo/DividendRecord + akshare_client::get_dividend + commands::get_dividend
    - 前端 api: getDividend(symbol, endDate?)
    - analysisStore.Entry 加 dividend/dividendUpdatedAt；新增 fetchDividend 方法
    - refreshOne 分析成功后自动 fire-and-forget 拉分红
    - refreshAll 二阶段补齐：分析全部完成后，把仍缺失 dividend 的票再补拉一次（3 并发）
    - AnalysisWidget 加两列：
      * 「每股分红」：TTM 12 个月加总（元/股），tooltip 展开明细（除权日 + 金额 + 备注 + 合计 + 截止日）
      * 「股息率」：前端 useMemo 算 = TTM 分红 / 现价 × 100%，跟随现价实时刷新
        - ≥5% 深红加粗，3%-5% 红色，<3% 默认色
      * 两列都支持排序
      * 无数据统一显示「—」（灰色占位），排序时 null 沉底
    - 数据结构说明：DividendInfo.year 字段保留兼容语义（=end_date 所在年），实际以 end_date 为准


后续可扩展（未做）：
- 表格支持市值 / PE / PB / ROE 等基本面指标（需 sidecar 新增 fundamentals 接口，比股息更复杂）


检查：
- 查看量化分析里的所有逻辑是否合理 ✅ 已完成一轮审查，修复 3 项（advised clamp / BOLL squeeze 提示 / tooltip 中位数说明）