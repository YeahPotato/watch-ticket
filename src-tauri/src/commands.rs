//! Tauri commands，供前端 invoke 调用。

use std::collections::HashMap;

use tauri::{AppHandle, Emitter, State};
use tracing::warn;

use crate::db;
use crate::error::{AppError, AppResult};
use crate::events::{IntradayUpdated, SubscriptionChanged, EV_INTRADAY_UPDATED, EV_SUBSCRIPTION_CHANGED};
use crate::models::{
    Alert, AnalysisReport, IntradayPoint, KlinePoint, PingInfo, Quote, SearchItem, Subscription,
};
use crate::repo;
use crate::state::AppState;

/// 全链路自检：应用版本 / sidecar 端口 / sidecar http / db。
#[tauri::command]
pub async fn ping(state: State<'_, AppState>) -> AppResult<PingInfo> {
    let sidecar_port = Some(state.sidecar.port());

    let (sidecar_ok, sidecar_error) = match state.ak.health().await {
        Ok(_) => (true, None),
        Err(e) => {
            warn!("sidecar health 失败: {}", e);
            (false, Some(e.to_string()))
        }
    };

    let db_ok = db::ping(&state.db).await.is_ok();

    Ok(PingInfo {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        sidecar_port,
        sidecar_ok,
        sidecar_error,
        db_ok,
        db_path: state.db_path.to_string_lossy().to_string(),
    })
}

/// 透传 sidecar /health
#[tauri::command]
pub async fn sidecar_health(state: State<'_, AppState>) -> AppResult<serde_json::Value> {
    state.ak.health().await
}

// =============== sidecar 直查（不经缓存） ===============

#[tauri::command]
pub async fn get_quote(state: State<'_, AppState>, symbol: String) -> AppResult<Quote> {
    state.ak.get_quote(&symbol).await
}

#[tauri::command]
pub async fn get_kline(
    state: State<'_, AppState>,
    symbol: String,
    period: String,
    limit: i64,
) -> AppResult<Vec<KlinePoint>> {
    state.ak.get_kline(&symbol, &period, limit).await
}

#[tauri::command]
pub async fn search_symbol(
    state: State<'_, AppState>,
    keyword: String,
    limit: Option<i64>,
) -> AppResult<Vec<SearchItem>> {
    state.ak.search(&keyword, limit.unwrap_or(20)).await
}

// =============== 订阅管理 ===============

fn extract_market(symbol: &str) -> AppResult<String> {
    let up = symbol.trim().to_uppercase();
    let (m, _) = up
        .split_once(':')
        .ok_or_else(|| AppError::msg("symbol 需为 MARKET:CODE 格式"))?;
    match m {
        "SH" | "SZ" | "BJ" | "HK" | "US" => Ok(m.to_string()),
        other => Err(AppError::msg(format!("未知市场: {}", other))),
    }
}

async fn emit_subscription_changed(app: &AppHandle, subs: Vec<Subscription>) {
    let _ = app.emit(
        EV_SUBSCRIPTION_CHANGED,
        SubscriptionChanged { subscriptions: subs },
    );
}

#[tauri::command]
pub async fn list_subscriptions(state: State<'_, AppState>) -> AppResult<Vec<Subscription>> {
    repo::list_subscriptions(&state.db).await
}

#[tauri::command]
pub async fn add_subscription(
    app: AppHandle,
    state: State<'_, AppState>,
    symbol: String,
    name: Option<String>,
    kline_periods: Option<String>,
) -> AppResult<Subscription> {
    let symbol_up = symbol.trim().to_uppercase();
    let market = extract_market(&symbol_up)?;
    let periods = kline_periods.unwrap_or_else(|| "1d".to_string());

    let sub = repo::upsert_subscription(
        &state.db,
        &symbol_up,
        name.as_deref(),
        &market,
        &periods,
    )
    .await?;

    // 通知调度器重载 + 广播订阅变更
    state.scheduler.reload();
    let all = repo::list_subscriptions(&state.db).await.unwrap_or_default();
    emit_subscription_changed(&app, all).await;

    Ok(sub)
}

#[tauri::command]
pub async fn remove_subscription(
    app: AppHandle,
    state: State<'_, AppState>,
    symbol: String,
) -> AppResult<u64> {
    let n = repo::delete_subscription(&state.db, &symbol.trim().to_uppercase()).await?;
    state.scheduler.reload();
    let all = repo::list_subscriptions(&state.db).await.unwrap_or_default();
    emit_subscription_changed(&app, all).await;
    Ok(n)
}

#[tauri::command]
pub async fn update_subscription_periods(
    app: AppHandle,
    state: State<'_, AppState>,
    symbol: String,
    kline_periods: String,
) -> AppResult<()> {
    repo::update_periods(
        &state.db,
        &symbol.trim().to_uppercase(),
        &kline_periods,
    )
    .await?;
    state.scheduler.reload();
    let all = repo::list_subscriptions(&state.db).await.unwrap_or_default();
    emit_subscription_changed(&app, all).await;
    Ok(())
}

/// 更新股票备注（自由文本）。不影响调度，仅广播订阅变更让前端刷新。
#[tauri::command]
pub async fn update_subscription_note(
    app: AppHandle,
    state: State<'_, AppState>,
    symbol: String,
    note: String,
) -> AppResult<()> {
    repo::update_note(&state.db, &symbol.trim().to_uppercase(), &note).await?;
    let all = repo::list_subscriptions(&state.db).await.unwrap_or_default();
    emit_subscription_changed(&app, all).await;
    Ok(())
}

// =============== 缓存查询（读 DB） ===============

#[tauri::command]
pub async fn get_cached_kline(
    state: State<'_, AppState>,
    symbol: String,
    period: String,
    limit: i64,
) -> AppResult<Vec<KlinePoint>> {
    repo::get_klines(&state.db, &symbol, &period, limit).await
}

/// 主动触发一次分时拉取（用于交易时段外或首次挂载 widget）。
/// 成功后落库并 emit intraday:updated 事件，与调度器一致。
#[tauri::command]
pub async fn refresh_intraday(
    app: AppHandle,
    state: State<'_, AppState>,
    symbol: String,
) -> AppResult<Vec<IntradayPoint>> {
    let pts = state.ak.get_intraday(&symbol).await?;
    repo::replace_intraday(&state.db, &symbol, &pts).await?;
    let _ = app.emit(
        EV_INTRADAY_UPDATED,
        IntradayUpdated {
            symbol: symbol.clone(),
            points: pts.clone(),
        },
    );
    Ok(pts)
}

// =============== 设置 ===============

#[tauri::command]
pub async fn list_settings(state: State<'_, AppState>) -> AppResult<HashMap<String, String>> {
    repo::list_settings(&state.db).await
}

#[tauri::command]
pub async fn update_setting(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> AppResult<()> {
    repo::upsert_setting(&state.db, &key, &value).await
}

#[tauri::command]
pub async fn get_setting(
    state: State<'_, AppState>,
    key: String,
) -> AppResult<Option<String>> {
    repo::get_setting(&state.db, &key).await
}

// =============== 告警 ===============

#[tauri::command]
pub async fn list_alerts(
    state: State<'_, AppState>,
    limit: Option<i64>,
    only_unack: Option<bool>,
) -> AppResult<Vec<Alert>> {
    repo::list_alerts(
        &state.db,
        limit.unwrap_or(200).clamp(1, 2000),
        only_unack.unwrap_or(false),
    )
    .await
}

#[tauri::command]
pub async fn ack_alert(state: State<'_, AppState>, id: i64) -> AppResult<u64> {
    repo::ack_alert(&state.db, id).await
}

#[tauri::command]
pub async fn ack_all_alerts(state: State<'_, AppState>) -> AppResult<u64> {
    repo::ack_all_alerts(&state.db).await
}

#[tauri::command]
pub async fn count_unack_alerts(state: State<'_, AppState>) -> AppResult<i64> {
    repo::count_unack(&state.db).await
}

#[tauri::command]
pub async fn clear_alerts(
    state: State<'_, AppState>,
    older_than_days: Option<i64>,
) -> AppResult<u64> {
    repo::clear_alerts_older_than(&state.db, older_than_days.unwrap_or(30)).await
}

// =============== 量化分析 ===============

/// 拉取指定周期最近 `bars` 根 K 线并做综合量化分析。
///
/// - `period`：1d / 1w / 1M
/// - `bars`：K 线根数。默认 750（≈ 3 年日 K），上限 2000。
#[tauri::command]
pub async fn analyze_symbol(
    state: State<'_, AppState>,
    symbol: String,
    period: Option<String>,
    bars: Option<i64>,
) -> AppResult<AnalysisReport> {
    let period = period.unwrap_or_else(|| "1d".to_string());
    let bars = bars.unwrap_or(750).clamp(60, 2000);

    let points = state
        .ak
        .get_kline(&symbol, &period, bars)
        .await
        .map_err(|e| AppError::msg(format!("拉取 K 线失败: {}", e)))?;

    if points.is_empty() {
        return Err(AppError::msg("K 线数据为空"));
    }

    Ok(crate::analyzer::analyze(symbol, period, points))
}

// =============== 交易时段查询 ===============

/// 判断指定市场当前是否处于交易时段。
///
/// 供前端定时刷新时决定是否发起请求，避免收盘时段无意义地打 sidecar。
/// 市场标识："SH" / "SZ" / "BJ" / "HK" / "US"；未知市场返回 false。
#[tauri::command]
pub fn is_market_open(market: String) -> bool {
    crate::market_time::is_market_open(&market)
}
