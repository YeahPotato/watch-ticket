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
    /// 用户自由文本备注（可为空字符串）
    #[serde(default)]
    pub note: String,
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

/// 单指标评分明细。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisIndicator {
    /// 指标名（如 "MACD"、"RSI(14)"）
    pub name: String,
    /// 打分区间 [-2, +2]
    pub score: f64,
    /// 展示给用户的一句话说明
    pub detail: String,
}

/// 建议价的辅助参考位（支撑/压力位来源）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PriceRefs {
    /// BOLL 下轨（加仓）或上轨（减仓）；数据不足时为 None
    pub boll: Option<f64>,
    /// EMA20；数据不足时为 None
    pub ema20: Option<f64>,
    /// 近 20 根最低（加仓）或最高（减仓）
    pub extreme_20d: f64,
}

/// 建议价：加仓或减仓的综合价格及其分解。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PriceSuggestion {
    /// 保守建议价（更远离现价，更难触及）：
    ///   加仓 = min(support, discount_tiers[0])
    ///   减仓 = max(resistance, discount_tiers[0])
    pub advised: f64,
    /// 触发价（较易触及，实盘挂单参考）：
    ///   加仓 = max(support, discount_tiers[0])
    ///   减仓 = min(resistance, discount_tiers[0])
    pub trigger: f64,
    /// 支撑位或压力位（取 boll / ema20 / extreme_20d 三者中位数）
    pub support: f64,
    /// 参考位明细
    pub refs: PriceRefs,
    /// 3 年均价折价（加仓 0.95/0.92/0.90）或溢价（减仓 1.05/1.08/1.10）三档
    pub discount_tiers: [f64; 3],
}

/// 综合量化分析结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisReport {
    pub symbol: String,
    /// K 线周期："1d" / "1w" / "1M"
    pub period: String,
    /// 实际参与计算的 K 线根数
    pub bars: usize,
    /// 最新收盘价
    pub last_close: f64,
    /// 参考基准：全期算术均价
    pub avg_price: Option<f64>,
    /// 最新价对均价的偏离百分比（正 = 高于均价）
    pub avg_deviation_pct: Option<f64>,

    /// 综合分：所有指标分数的算术平均
    pub composite_score: f64,
    /// 评级 key: strong_buy / watch_buy / hold / watch_sell / strong_sell
    pub rating: String,
    /// 评级中文文案
    pub rating_label: String,

    pub indicators: Vec<AnalysisIndicator>,
    /// 综合理由（一句话）
    pub reason: String,

    /// 建议加仓价（数据不足时为 None）
    pub buy_suggestion: Option<PriceSuggestion>,
    /// 建议减仓价（数据不足时为 None）
    pub sell_suggestion: Option<PriceSuggestion>,
}
