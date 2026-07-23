//! 后台轮询调度器。
//!
//! 设计思路：
//!   - 单调度器 + 任务池模型：一个 tokio task 每秒 tick
//!   - 每 tick 遍历所有订阅，对每种数据类型（quote / intraday / kline:<period>）
//!     判断"距上次拉取是否 ≥ 该数据类型配置的间隔"
//!   - 到点则 spawn 拉取任务；成功后写 DB + emit 事件
//!   - 交易时段外分时/quote/分钟K 停止；日周月 K 继续（低频）
//!   - 订阅变更由外部调用 `reload()` 触发（会重置计时器，让新订阅立刻拉一次）

use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use serde::Deserialize;
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter};
use tokio::sync::{watch, Mutex};
use tokio::task::JoinHandle;
use tracing::{debug, info, warn};

use crate::akshare_client::AkClient;
use crate::events::{
    AlertNew, IntradayUpdated, KlineUpdated, PollError, QuoteUpdated, EV_ALERT_NEW,
    EV_INTRADAY_UPDATED, EV_KLINE_UPDATED, EV_POLL_ERROR, EV_QUOTE_UPDATED,
};
use crate::indicators::{classify_alert_kind, detect_crosses, fill_macd_inplace, MacdParams};
use crate::market_time::is_market_open;
use crate::models::{Alert, Subscription};
use crate::repo;

/// 拉取任务的分类键
#[derive(Debug, Clone, Eq, PartialEq, Hash)]
struct TaskKey {
    symbol: String,
    kind: TaskKind,
}

#[derive(Debug, Clone, Eq, PartialEq, Hash)]
enum TaskKind {
    Quote,
    Intraday,
    Kline(String), // period
}

impl TaskKind {
    fn as_str(&self) -> String {
        match self {
            TaskKind::Quote => "quote".to_string(),
            TaskKind::Intraday => "intraday".to_string(),
            TaskKind::Kline(p) => format!("kline:{}", p),
        }
    }
}

/// 从 settings 表读取的调度配置（缓存 60 秒）
#[derive(Debug, Clone, Deserialize)]
struct SchedulerSettings {
    quote_interval_sec: u64,
    intraday_interval_sec: u64,
    kline_1m_interval_sec: u64,
    kline_5m_interval_sec: u64,
    kline_15m_interval_sec: u64,
    kline_30m_interval_sec: u64,
    kline_60m_interval_sec: u64,
    kline_daily_interval_sec: u64,
    kline_weekly_interval_sec: u64,
    kline_monthly_interval_sec: u64,
}

impl Default for SchedulerSettings {
    fn default() -> Self {
        Self {
            quote_interval_sec: 5,
            intraday_interval_sec: 5,
            kline_1m_interval_sec: 30,
            kline_5m_interval_sec: 60,
            kline_15m_interval_sec: 60,
            kline_30m_interval_sec: 120,
            kline_60m_interval_sec: 120,
            kline_daily_interval_sec: 300,
            kline_weekly_interval_sec: 86_400,
            kline_monthly_interval_sec: 86_400,
        }
    }
}

impl SchedulerSettings {
    async fn load(pool: &SqlitePool) -> Self {
        let mut s = Self::default();
        let map = match repo::list_settings(pool).await {
            Ok(m) => m,
            Err(_) => return s,
        };
        macro_rules! read {
            ($field:ident, $key:literal) => {
                if let Some(v) = map.get($key).and_then(|s| s.parse().ok()) {
                    s.$field = v;
                }
            };
        }
        read!(quote_interval_sec, "quote_interval_sec");
        read!(intraday_interval_sec, "intraday_interval_sec");
        read!(kline_1m_interval_sec, "kline_1m_interval_sec");
        read!(kline_5m_interval_sec, "kline_5m_interval_sec");
        read!(kline_15m_interval_sec, "kline_15m_interval_sec");
        read!(kline_30m_interval_sec, "kline_30m_interval_sec");
        read!(kline_60m_interval_sec, "kline_60m_interval_sec");
        read!(kline_daily_interval_sec, "kline_daily_interval_sec");
        read!(kline_weekly_interval_sec, "kline_weekly_interval_sec");
        read!(kline_monthly_interval_sec, "kline_monthly_interval_sec");
        s
    }

    /// 返回 (间隔秒数, 是否仅在交易时段执行)
    fn interval_for(&self, kind: &TaskKind) -> (u64, bool) {
        match kind {
            TaskKind::Quote => (self.quote_interval_sec, true),
            TaskKind::Intraday => (self.intraday_interval_sec, true),
            TaskKind::Kline(p) => match p.as_str() {
                "1m" => (self.kline_1m_interval_sec, true),
                "5m" => (self.kline_5m_interval_sec, true),
                "15m" => (self.kline_15m_interval_sec, true),
                "30m" => (self.kline_30m_interval_sec, true),
                "60m" => (self.kline_60m_interval_sec, true),
                "1d" => (self.kline_daily_interval_sec, false),
                "1w" => (self.kline_weekly_interval_sec, false),
                "1M" => (self.kline_monthly_interval_sec, false),
                _ => (300, false),
            },
        }
    }
}

pub struct Scheduler {
    handle: JoinHandle<()>,
    reload_tx: watch::Sender<u64>,
}

impl Scheduler {
    /// 请求重新加载订阅列表（会立即触发一次全量拉取）
    pub fn reload(&self) {
        let n = *self.reload_tx.borrow() + 1;
        let _ = self.reload_tx.send(n);
    }

    /// 停止调度器
    #[allow(dead_code)]
    pub fn stop(&self) {
        self.handle.abort();
    }
}

pub fn start(
    app: AppHandle,
    pool: SqlitePool,
    ak: Arc<AkClient>,
) -> Scheduler {
    let (reload_tx, reload_rx) = watch::channel::<u64>(0);
    let last_run: Arc<DashMap<TaskKey, Instant>> = Arc::new(DashMap::new());
    let subs_cache: Arc<Mutex<Vec<Subscription>>> = Arc::new(Mutex::new(Vec::new()));

    // 启动前先加载一次订阅
    {
        let pool = pool.clone();
        let subs_cache = subs_cache.clone();
        tokio::spawn(async move {
            if let Ok(subs) = repo::list_subscriptions(&pool).await {
                *subs_cache.lock().await = subs;
            }
        });
    }

    let handle = tokio::spawn(scheduler_loop(
        app,
        pool,
        ak,
        last_run,
        subs_cache,
        reload_rx,
    ));

    Scheduler { handle, reload_tx }
}

async fn scheduler_loop(
    app: AppHandle,
    pool: SqlitePool,
    ak: Arc<AkClient>,
    last_run: Arc<DashMap<TaskKey, Instant>>,
    subs_cache: Arc<Mutex<Vec<Subscription>>>,
    mut reload_rx: watch::Receiver<u64>,
) {
    info!("调度器启动");
    let mut ticker = tokio::time::interval(Duration::from_secs(1));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    let mut settings = SchedulerSettings::load(&pool).await;
    let mut settings_refreshed_at = Instant::now();

    loop {
        tokio::select! {
            _ = ticker.tick() => {}
            changed = reload_rx.changed() => {
                if changed.is_err() { break; }
                // 变更时重置计时器，让新订阅马上拉一次
                last_run.clear();
                match repo::list_subscriptions(&pool).await {
                    Ok(list) => {
                        info!("订阅重载，共 {} 条", list.len());
                        *subs_cache.lock().await = list;
                    }
                    Err(e) => warn!("订阅重载失败: {}", e),
                }
                continue;
            }
        }

        // 60 秒重读配置
        if settings_refreshed_at.elapsed() > Duration::from_secs(60) {
            settings = SchedulerSettings::load(&pool).await;
            settings_refreshed_at = Instant::now();
        }

        let subs = subs_cache.lock().await.clone();
        if subs.is_empty() {
            continue;
        }

        for sub in &subs {
            let market_open = is_market_open(&sub.market);

            // 三类数据轮询
            let mut kinds: Vec<TaskKind> =
                vec![TaskKind::Quote, TaskKind::Intraday];
            for p in sub.periods() {
                kinds.push(TaskKind::Kline(p));
            }

            for kind in kinds {
                let (interval, session_only) = settings.interval_for(&kind);
                if session_only && !market_open {
                    continue;
                }
                let key = TaskKey {
                    symbol: sub.symbol.clone(),
                    kind: kind.clone(),
                };
                let due = match last_run.get(&key) {
                    Some(t) => t.elapsed() >= Duration::from_secs(interval),
                    None => true,
                };
                if !due {
                    continue;
                }
                last_run.insert(key.clone(), Instant::now());

                spawn_fetch(app.clone(), pool.clone(), ak.clone(), sub.symbol.clone(), kind);
            }
        }
    }
    info!("调度器退出");
}

fn spawn_fetch(
    app: AppHandle,
    pool: SqlitePool,
    ak: Arc<AkClient>,
    symbol: String,
    kind: TaskKind,
) {
    tokio::spawn(async move {
        let kind_str = kind.as_str();
        let result: Result<(), crate::error::AppError> = async {
            match &kind {
                TaskKind::Quote => {
                    let q = ak.get_quote(&symbol).await?;
                    let _ = app.emit(
                        EV_QUOTE_UPDATED,
                        QuoteUpdated {
                            symbol: symbol.clone(),
                            quote: q,
                        },
                    );
                }
                TaskKind::Intraday => {
                    let pts = ak.get_intraday(&symbol).await?;
                    repo::replace_intraday(&pool, &symbol, &pts).await?;
                    let _ = app.emit(
                        EV_INTRADAY_UPDATED,
                        IntradayUpdated {
                            symbol: symbol.clone(),
                            points: pts,
                        },
                    );
                }
                TaskKind::Kline(period) => {
                    let mut pts = ak.get_kline(&symbol, period, 500).await?;

                    // 计算 MACD（用当前 settings 里的参数）
                    let params = load_macd_params(&pool).await;
                    fill_macd_inplace(&mut pts, params);

                    // 落库（带指标）
                    repo::upsert_klines(&pool, &symbol, period, &pts).await?;

                    // 检测金叉/死叉；alerts 表 UNIQUE 约束保证同 K 线不重复告警
                    let crosses = detect_crosses(&pts);
                    if !crosses.is_empty() {
                        // 零轴附近阈值：|DEA| / price < 0.001（0.1%）
                        const ZERO_AXIS_THRESHOLD: f64 = 0.001;
                        let rows: Vec<Alert> = crosses
                            .iter()
                            .map(|c| {
                                let kind_str = classify_alert_kind(
                                    c.kind,
                                    c.dea,
                                    c.price,
                                    ZERO_AXIS_THRESHOLD,
                                );
                                Alert {
                                    id: 0,
                                    symbol: symbol.clone(),
                                    period: period.clone(),
                                    ts: c.ts.clone(),
                                    alert_type: c.kind.as_str().to_string(),
                                    alert_kind: kind_str.to_string(),
                                    dif: Some(c.dif),
                                    dea: Some(c.dea),
                                    price: Some(c.price),
                                    acknowledged: false,
                                    created_at: String::new(),
                                }
                            })
                            .collect();
                        let inserted = repo::insert_alerts_if_new(&pool, &rows).await?;
                        if !inserted.is_empty() {
                            info!(
                                "新增 MACD 信号 {} 条: {} [{}]",
                                inserted.len(),
                                symbol,
                                period
                            );
                            // 不再发桌面通知，仅 emit 事件让前端更新历史列表
                            let _ = app.emit(
                                EV_ALERT_NEW,
                                AlertNew { alerts: inserted },
                            );
                        }
                    }

                    let _ = app.emit(
                        EV_KLINE_UPDATED,
                        KlineUpdated {
                            symbol: symbol.clone(),
                            period: period.clone(),
                            points: pts,
                        },
                    );
                }
            }
            Ok(())
        }
        .await;

        if let Err(e) = result {
            debug!("拉取失败 {} {}: {}", symbol, kind_str, e);
            let _ = app.emit(
                EV_POLL_ERROR,
                PollError {
                    symbol,
                    kind: kind_str,
                    error: e.to_string(),
                },
            );
        }
    });
}

/// 从 settings 表读 MACD 参数；失败退回默认值。
async fn load_macd_params(pool: &SqlitePool) -> MacdParams {
    let mut p = MacdParams::default();
    if let Ok(map) = repo::list_settings(pool).await {
        if let Some(v) = map.get("macd_fast").and_then(|s| s.parse().ok()) {
            p.fast = v;
        }
        if let Some(v) = map.get("macd_slow").and_then(|s| s.parse().ok()) {
            p.slow = v;
        }
        if let Some(v) = map.get("macd_signal").and_then(|s| s.parse().ok()) {
            p.signal = v;
        }
    }
    p
}
