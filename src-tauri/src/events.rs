//! Tauri 事件常量与 payload 类型。前端通过 `listen` 订阅这些事件名。

use serde::Serialize;

use crate::models::{Alert, IntradayPoint, KlinePoint, Quote, Subscription};

pub const EV_QUOTE_UPDATED: &str = "quote:updated";
pub const EV_INTRADAY_UPDATED: &str = "intraday:updated";
pub const EV_KLINE_UPDATED: &str = "kline:updated";
pub const EV_SUBSCRIPTION_CHANGED: &str = "subscription:changed";
pub const EV_POLL_ERROR: &str = "poll:error";
pub const EV_ALERT_NEW: &str = "alert:new";

#[derive(Debug, Clone, Serialize)]
pub struct QuoteUpdated {
    pub symbol: String,
    pub quote: Quote,
}

#[derive(Debug, Clone, Serialize)]
pub struct IntradayUpdated {
    pub symbol: String,
    pub points: Vec<IntradayPoint>,
}

#[derive(Debug, Clone, Serialize)]
pub struct KlineUpdated {
    pub symbol: String,
    pub period: String,
    pub points: Vec<KlinePoint>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SubscriptionChanged {
    pub subscriptions: Vec<Subscription>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PollError {
    pub symbol: String,
    pub kind: String,
    pub error: String,
}

/// 新增告警事件（单条或批量）
#[derive(Debug, Clone, Serialize)]
pub struct AlertNew {
    pub alerts: Vec<Alert>,
}
