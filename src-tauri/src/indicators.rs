//! 技术指标：EMA / MACD / 金叉死叉判定。
//!
//! 算法与前端 `src/lib/indicators.ts` 保持完全一致：
//!   EMA[0] = value[0]
//!   EMA[i] = alpha * value[i] + (1 - alpha) * EMA[i-1]
//!   alpha  = 2 / (period + 1)
//!
//!   DIF   = EMA(close, fast) - EMA(close, slow)
//!   DEA   = EMA(DIF, signal)
//!   MACD  = (DIF - DEA) * 2
//!
//! 预热：前 `max(fast, slow) - 1` 根不参与金叉/死叉判定（EMA 未稳定）。

use crate::models::KlinePoint;

#[derive(Debug, Clone, Copy)]
pub struct MacdParams {
    pub fast: usize,
    pub slow: usize,
    pub signal: usize,
}

impl Default for MacdParams {
    fn default() -> Self {
        Self {
            fast: 12,
            slow: 26,
            signal: 9,
        }
    }
}

/// 通用 EMA 递推。
pub fn ema(values: &[f64], period: usize) -> Vec<f64> {
    if values.is_empty() || period == 0 {
        return Vec::new();
    }
    let alpha = 2.0 / (period as f64 + 1.0);
    let mut out = Vec::with_capacity(values.len());
    let mut prev = values[0];
    out.push(prev);
    for &v in &values[1..] {
        let cur = alpha * v + (1.0 - alpha) * prev;
        out.push(cur);
        prev = cur;
    }
    out
}

/// 计算 MACD 三条值。返回长度 = closes.len()，前 warmup 根用 None 占位。
///
/// 返回：(dif, dea, macd) 每个都是 Vec<Option<f64>>
pub fn macd(
    closes: &[f64],
    params: MacdParams,
) -> (Vec<Option<f64>>, Vec<Option<f64>>, Vec<Option<f64>>) {
    let n = closes.len();
    if n == 0 {
        return (Vec::new(), Vec::new(), Vec::new());
    }
    let ema_fast = ema(closes, params.fast);
    let ema_slow = ema(closes, params.slow);
    let dif_raw: Vec<f64> = ema_fast
        .iter()
        .zip(ema_slow.iter())
        .map(|(f, s)| f - s)
        .collect();
    let dea_raw = ema(&dif_raw, params.signal);

    let warmup = params.fast.max(params.slow).saturating_sub(1);

    let mut dif = Vec::with_capacity(n);
    let mut dea = Vec::with_capacity(n);
    let mut mac = Vec::with_capacity(n);
    for i in 0..n {
        if i < warmup {
            dif.push(None);
            dea.push(None);
            mac.push(None);
        } else {
            let d = dif_raw[i];
            let de = dea_raw[i];
            dif.push(Some(d));
            dea.push(Some(de));
            mac.push(Some((d - de) * 2.0));
        }
    }
    (dif, dea, mac)
}

/// 就地把 dif/dea/macd 填到 KlinePoint。
pub fn fill_macd_inplace(points: &mut [KlinePoint], params: MacdParams) {
    let closes: Vec<f64> = points.iter().map(|p| p.close).collect();
    let (dif, dea, mac) = macd(&closes, params);
    for (i, p) in points.iter_mut().enumerate() {
        p.dif = dif[i];
        p.dea = dea[i];
        p.macd = mac[i];
    }
}

/// cross 类型
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum CrossKind {
    Golden, // 金叉：DIF 上穿 DEA
    Dead,   // 死叉：DIF 下穿 DEA
}

impl CrossKind {
    pub fn as_str(self) -> &'static str {
        match self {
            CrossKind::Golden => "golden_cross",
            CrossKind::Dead => "dead_cross",
        }
    }
}

/// 业务细分：结合 DEA 相对价格位置将 cross 分为 5 种建议信号。
///
/// - golden_entry:   零轴附近水上金叉    → 建仓
/// - golden_add:     水上金叉（远离零轴） → 加仓
/// - golden_bounce:  水下金叉             → 短线反弹（不新增底仓）
/// - dead_reduce:    水上死叉             → 减仓 / 做反 T
/// - dead_risk:      水下死叉             → 风险信号
///
/// 判定：
///   零轴附近（相对阈值）: |DEA| / price < zero_axis_threshold（默认 0.001，即 0.1%）
pub fn classify_alert_kind(
    kind: CrossKind,
    dea: f64,
    price: f64,
    zero_axis_threshold: f64,
) -> &'static str {
    // price 为 0 时退化：忽略零轴附近，只区分水上/水下
    let near_zero = if price.abs() > f64::EPSILON {
        (dea.abs() / price.abs()) < zero_axis_threshold
    } else {
        false
    };
    let water_up = dea > 0.0;

    match kind {
        CrossKind::Golden => {
            if !water_up {
                "golden_bounce"
            } else if near_zero {
                "golden_entry"
            } else {
                "golden_add"
            }
        }
        CrossKind::Dead => {
            if water_up {
                "dead_reduce"
            } else {
                "dead_risk"
            }
        }
    }
}

/// 检测到的 cross 事件（未去重）。
#[derive(Debug, Clone)]
pub struct DetectedCross {
    #[allow(dead_code)]
    pub index: usize, // 在 points 数组中的下标（保留供未来使用）
    pub kind: CrossKind,
    pub ts: String,
    pub dif: f64,
    pub dea: f64,
    pub price: f64,
}

/// 扫描 points（应已填过 dif/dea），返回所有 cross 事件。
///
/// 判定规则：
///   金叉：prev.dif <= prev.dea && cur.dif > cur.dea
///   死叉：prev.dif >= prev.dea && cur.dif < cur.dea
/// 相等的一根不视为 cross。
pub fn detect_crosses(points: &[KlinePoint]) -> Vec<DetectedCross> {
    let mut out = Vec::new();
    for i in 1..points.len() {
        let p = &points[i - 1];
        let c = &points[i];
        let (pd, pe) = match (p.dif, p.dea) {
            (Some(a), Some(b)) => (a, b),
            _ => continue,
        };
        let (cd, ce) = match (c.dif, c.dea) {
            (Some(a), Some(b)) => (a, b),
            _ => continue,
        };
        let kind = if pd <= pe && cd > ce {
            Some(CrossKind::Golden)
        } else if pd >= pe && cd < ce {
            Some(CrossKind::Dead)
        } else {
            None
        };
        if let Some(k) = kind {
            out.push(DetectedCross {
                index: i,
                kind: k,
                ts: c.ts.clone(),
                dif: cd,
                dea: ce,
                price: c.close,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kp(ts: &str, close: f64) -> KlinePoint {
        KlinePoint {
            ts: ts.into(),
            open: close,
            high: close,
            low: close,
            close,
            volume: None,
            amount: None,
            dif: None,
            dea: None,
            macd: None,
        }
    }

    #[test]
    fn ema_first_equals_first_value() {
        let v = vec![10.0, 20.0, 30.0];
        let e = ema(&v, 3);
        assert_eq!(e.len(), 3);
        assert!((e[0] - 10.0).abs() < 1e-9);
        // alpha = 0.5
        assert!((e[1] - 15.0).abs() < 1e-9);
        assert!((e[2] - 22.5).abs() < 1e-9);
    }

    #[test]
    fn detect_golden_cross() {
        // 构造一段最终确定发生 DIF 上穿 DEA 的走势
        let closes: Vec<f64> = (0..60)
            .map(|i| {
                let x = i as f64;
                if x < 30.0 { 100.0 - x } else { 70.0 + (x - 30.0) * 2.0 }
            })
            .collect();
        let mut points: Vec<KlinePoint> =
            closes.iter().enumerate().map(|(i, c)| kp(&format!("d{}", i), *c)).collect();
        fill_macd_inplace(&mut points, MacdParams::default());
        let crosses = detect_crosses(&points);
        assert!(crosses.iter().any(|c| c.kind == CrossKind::Golden));
    }

    #[test]
    fn classify_kind_covers_all_branches() {
        // 阈值 0.001（0.1%）
        let t = 0.001;

        // 水下金叉 → golden_bounce
        assert_eq!(
            classify_alert_kind(CrossKind::Golden, -1.0, 100.0, t),
            "golden_bounce"
        );
        // 水上金叉且零轴附近（|DEA|/price = 0.05/100 = 0.0005 < 0.001）→ golden_entry
        assert_eq!(
            classify_alert_kind(CrossKind::Golden, 0.05, 100.0, t),
            "golden_entry"
        );
        // 水上金叉但远离零轴（|DEA|/price = 5/100 = 0.05 > 0.001）→ golden_add
        assert_eq!(
            classify_alert_kind(CrossKind::Golden, 5.0, 100.0, t),
            "golden_add"
        );
        // 水上死叉 → dead_reduce
        assert_eq!(
            classify_alert_kind(CrossKind::Dead, 3.0, 100.0, t),
            "dead_reduce"
        );
        // 水下死叉 → dead_risk
        assert_eq!(
            classify_alert_kind(CrossKind::Dead, -3.0, 100.0, t),
            "dead_risk"
        );
        // price=0 时退化：视为不"近零"，只按 DEA 正负分（水上金叉 → golden_add）
        assert_eq!(
            classify_alert_kind(CrossKind::Golden, 0.05, 0.0, t),
            "golden_add"
        );
    }
}
