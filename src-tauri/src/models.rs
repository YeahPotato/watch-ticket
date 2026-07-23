//! 数据模型，与 Python sidecar 返回结构保持字段对齐。

use serde::{Deserialize, Serialize};

/// sidecar 统一响应格式
#[derive(Debug, Deserialize)]
pub struct ApiEnvelope<T> {
    pub code: i32,
    pub msg: String,
    pub data: Option<T>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Quote {
    pub symbol: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub price: Option<f64>,
    #[serde(default)]
    pub open: Option<f64>,
    #[serde(default)]
    pub high: Option<f64>,
    #[serde(default)]
    pub low: Option<f64>,
    #[serde(default)]
    pub prev_close: Option<f64>,
    #[serde(default)]
    pub change: Option<f64>,
    #[serde(default)]
    pub change_pct: Option<f64>,
    #[serde(default)]
    pub volume: Option<f64>,
    #[serde(default)]
    pub amount: Option<f64>,
    #[serde(default)]
    pub ts: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntradayPoint {
    pub ts: String,
    pub price: f64,
    #[serde(default)]
    pub avg_price: Option<f64>,
    #[serde(default)]
    pub volume: Option<f64>,
    #[serde(default)]
    pub amount: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KlinePoint {
    pub ts: String,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    #[serde(default)]
    pub volume: Option<f64>,
    #[serde(default)]
    pub amount: Option<f64>,
    #[serde(default)]
    pub dif: Option<f64>,
    #[serde(default)]
    pub dea: Option<f64>,
    #[serde(default)]
    pub macd: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchItem {
    pub symbol: String,
    pub name: String,
    pub market: String,
}

#[derive(Debug, Serialize)]
pub struct PingInfo {
    pub app_version: String,
    pub sidecar_port: Option<u16>,
    pub sidecar_ok: bool,
    pub sidecar_error: Option<String>,
    pub db_ok: bool,
    pub db_path: String,
}

/// 订阅记录
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Subscription {
    pub id: i64,
    pub symbol: String,
    pub name: Option<String>,
    pub market: String,
    pub kline_periods: String,
    pub sort_order: i64,
    pub added_at: String,
}

impl Subscription {
    pub fn periods(&self) -> Vec<String> {
        self.kline_periods
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    }
}

/// MACD 告警记录
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Alert {
    pub id: i64,
    pub symbol: String,
    pub period: String,
    pub ts: String,
    /// "golden_cross" / "dead_cross"
    pub alert_type: String,
    /// 业务细分（golden_entry / golden_add / golden_bounce / dead_reduce / dead_risk / legacy / ""）
    pub alert_kind: String,
    pub dif: Option<f64>,
    pub dea: Option<f64>,
    pub price: Option<f64>,
    pub acknowledged: bool,
    pub created_at: String,
}
