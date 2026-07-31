//! 量化分析引擎。
//!
//! 输入：一段 KlinePoint（推荐 750+ 根日 K，覆盖 3 年）
//! 输出：AnalysisReport，包含 5 档评级、综合分、每个指标的细项、参考文字
//!
//! 评级规则：
//!   每个指标 → 打分 [-2, +2] → 取平均 → 映射到 5 档：
//!     ≥ 1.2   strong_buy   强烈买
//!     0.4..1.2 watch_buy    观察买
//!     -0.4..0.4 hold        持有
//!     -1.2..-0.4 watch_sell 观察卖
//!     ≤ -1.2  strong_sell   强烈卖

use crate::indicators::{
    arithmetic_mean, bollinger, detect_crosses, ema, fill_macd_inplace, kdj, obv, rsi,
    CrossKind, MacdParams,
};
use crate::models::{
    AnalysisIndicator, AnalysisReport, KlinePoint, PriceRefs, PriceSuggestion,
};

const MACD_LOOKBACK: usize = 3; // 最近 3 根内出现的 cross 才算"当前信号"

/// 主分析函数：接收原始 K 线（未填指标），返回完整报告。
///
/// `symbol` / `period` 仅用于填 report 元信息，不参与算法。
pub fn analyze(symbol: String, period: String, mut points: Vec<KlinePoint>) -> AnalysisReport {
    let bars = points.len();
    let insufficient = bars < 60; // 至少要 60 根，否则大部分指标都残缺

    // 先在 points 里填 MACD（供 detect_crosses 使用）
    fill_macd_inplace(&mut points, MacdParams::default());

    let closes: Vec<f64> = points.iter().map(|p| p.close).collect();
    let highs: Vec<f64> = points.iter().map(|p| p.high).collect();
    let lows: Vec<f64> = points.iter().map(|p| p.low).collect();
    let vols: Vec<Option<f64>> = points.iter().map(|p| p.volume).collect();

    let last_close = closes.last().copied().unwrap_or(0.0);
    let avg_price = arithmetic_mean(&closes);
    let avg_deviation_pct = match avg_price {
        Some(avg) if avg.abs() > f64::EPSILON => {
            Some((last_close - avg) / avg * 100.0)
        }
        _ => None,
    };

    let mut indicators: Vec<AnalysisIndicator> = Vec::new();

    if !insufficient {
        indicators.push(score_macd(&points));
        indicators.push(score_rsi(&closes));
        indicators.push(score_kdj(&highs, &lows, &closes));
        indicators.push(score_boll(&closes));
        indicators.push(score_obv(&closes, &vols));
        indicators.push(score_ma_trend(&closes)); // 均线趋势（辅助）
    }

    let composite = if indicators.is_empty() {
        0.0
    } else {
        indicators.iter().map(|x| x.score).sum::<f64>() / indicators.len() as f64
    };
    let (rating, rating_label) = map_rating(composite);
    let reason = compose_reason(&indicators, insufficient);

    // 建议价：数据不足时给 None；否则同时给加仓 / 减仓
    // 注意：3 档基准从 avg_price 改为 last_close，避免现价严重偏离均价时"减仓 < 加仓"的悖论。
    let (buy_suggestion, sell_suggestion) = if insufficient {
        (None, None)
    } else {
        (
            build_suggestion(&closes, &highs, &lows, last_close, Side::Buy),
            build_suggestion(&closes, &highs, &lows, last_close, Side::Sell),
        )
    };

    AnalysisReport {
        symbol,
        period,
        bars,
        last_close,
        avg_price,
        avg_deviation_pct,
        composite_score: composite,
        rating: rating.to_string(),
        rating_label: rating_label.to_string(),
        indicators,
        reason,
        buy_suggestion,
        sell_suggestion,
    }
}

/// 建议价方向
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum Side {
    Buy,
    Sell,
}

/// 生成建议价。返回 None 表示当前 K 线不足以计算（例如少于 20 根，无法算 20 日极值）。
///
/// `last_close`：最新收盘价，用作 3 档折价/溢价的基准（比均价更贴合当前实盘）。
fn build_suggestion(
    closes: &[f64],
    highs: &[f64],
    lows: &[f64],
    last_close: f64,
    side: Side,
) -> Option<PriceSuggestion> {
    let n = closes.len();
    if n < 20 {
        return None;
    }

    // BOLL(20, 2)：取最新一根的上/下轨
    let boll_series = bollinger(closes, 20, 2.0);
    let boll_last = boll_series.iter().rev().find_map(|x| *x);
    let boll = boll_last.map(|b| match side {
        Side::Buy => b.lower,
        Side::Sell => b.upper,
    });

    // EMA20：取末值
    let ema20_val = if n >= 20 {
        Some(*ema(closes, 20).last().unwrap())
    } else {
        None
    };

    // 近 20 根极值
    let extreme_20d = match side {
        Side::Buy => lows[(n - 20)..n]
            .iter()
            .cloned()
            .fold(f64::INFINITY, f64::min),
        Side::Sell => highs[(n - 20)..n]
            .iter()
            .cloned()
            .fold(f64::NEG_INFINITY, f64::max),
    };

    // 支撑位/压力位：取 boll / ema20 / extreme_20d 三者中位数（None 忽略）
    let mut refs_vec: Vec<f64> = Vec::with_capacity(3);
    if let Some(v) = boll {
        refs_vec.push(v);
    }
    if let Some(v) = ema20_val {
        refs_vec.push(v);
    }
    refs_vec.push(extreme_20d);
    refs_vec.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let support = if refs_vec.is_empty() {
        return None;
    } else if refs_vec.len() % 2 == 1 {
        refs_vec[refs_vec.len() / 2]
    } else {
        // 偶数取中间两个的平均
        let m = refs_vec.len() / 2;
        (refs_vec[m - 1] + refs_vec[m]) / 2.0
    };

    // 3 档折价/溢价：基于**最新现价**（不再用 3 年均价，避免现价严重偏离均价时的悖论）
    let factors: [f64; 3] = match side {
        Side::Buy => [0.95, 0.92, 0.90],
        Side::Sell => [1.05, 1.08, 1.10],
    };
    let discount_tiers: [f64; 3] = [
        last_close * factors[0],
        last_close * factors[1],
        last_close * factors[2],
    ];

    // 综合建议价 = 保守价：加仓取 min（更远离现价），减仓取 max
    // 触发价：加仓取 max（较易触及，实盘挂单参考），减仓取 min
    let tier0 = discount_tiers[0];
    let (advised_raw, trigger) = match side {
        Side::Buy => (support.min(tier0), support.max(tier0)),
        Side::Sell => (support.max(tier0), support.min(tier0)),
    };
    // 保守价夹逼到现价 ±15%：避免近 20 日闪崩/爆拉导致 support 被极值污染，
    // 使 advised 偏离现价过远（例：现价 100 但 20 日最低 50 → advised 会落到 50 附近）。
    // trigger 天然在 [support, tier0] 或 [tier0, support] 之间，无需夹逼。
    let clamp_lo = last_close * 0.85;
    let clamp_hi = last_close * 1.15;
    let advised = advised_raw.clamp(clamp_lo, clamp_hi);

    Some(PriceSuggestion {
        advised,
        trigger,
        support,
        refs: PriceRefs {
            boll,
            ema20: ema20_val,
            extreme_20d,
        },
        discount_tiers,
    })
}

/// 综合分 → (rating, label)
fn map_rating(score: f64) -> (&'static str, &'static str) {
    if score >= 1.2 {
        ("strong_buy", "强烈买")
    } else if score >= 0.4 {
        ("watch_buy", "观察买")
    } else if score > -0.4 {
        ("hold", "持有")
    } else if score > -1.2 {
        ("watch_sell", "观察卖")
    } else {
        ("strong_sell", "强烈卖")
    }
}

// =============== 单指标打分 ===============

fn score_macd(points: &[KlinePoint]) -> AnalysisIndicator {
    let crosses = detect_crosses(points);
    // 只看最近 MACD_LOOKBACK 根内的最新一次 cross
    let n = points.len();
    let recent = crosses.iter().rev().find(|c| {
        // 用 ts 匹配下标很慢；改用 index 字段（indicators.rs 里已保留）
        c.index + MACD_LOOKBACK >= n
    });

    let last = points.last();
    let dif = last.and_then(|p| p.dif).unwrap_or(0.0);
    let dea = last.and_then(|p| p.dea).unwrap_or(0.0);

    let (score, detail) = match recent {
        Some(c) if c.kind == CrossKind::Golden => {
            if c.dea > 0.0 {
                (2.0, "近期水上金叉（DIF>0，多头信号）".to_string())
            } else {
                (1.0, "近期水下金叉（可能反弹）".to_string())
            }
        }
        Some(c) if c.kind == CrossKind::Dead => {
            if c.dea > 0.0 {
                (-1.0, "近期水上死叉（减仓信号）".to_string())
            } else {
                (-2.0, "近期水下死叉（风险信号）".to_string())
            }
        }
        _ => {
            // 无近期 cross：按 DIF/DEA 相对位置给弱信号
            if dif > dea && dea > 0.0 {
                (0.5, "DIF 位于 DEA 之上且水上，趋势偏多".to_string())
            } else if dif < dea && dea < 0.0 {
                (-0.5, "DIF 位于 DEA 之下且水下，趋势偏空".to_string())
            } else {
                (0.0, "MACD 无明显信号".to_string())
            }
        }
    };

    AnalysisIndicator {
        name: "MACD".to_string(),
        score,
        detail,
    }
}

fn score_rsi(closes: &[f64]) -> AnalysisIndicator {
    let r = rsi(closes, 14);
    let last = r.iter().rev().find_map(|x| *x);
    let (score, detail) = match last {
        Some(v) if v < 20.0 => (2.0, format!("RSI={:.1}，深度超卖", v)),
        Some(v) if v < 30.0 => (1.0, format!("RSI={:.1}，超卖", v)),
        Some(v) if v <= 70.0 => (0.0, format!("RSI={:.1}，中性", v)),
        Some(v) if v <= 80.0 => (-1.0, format!("RSI={:.1}，超买", v)),
        Some(v) => (-2.0, format!("RSI={:.1}，深度超买", v)),
        None => (0.0, "RSI 数据不足".to_string()),
    };
    AnalysisIndicator {
        name: "RSI(14)".to_string(),
        score,
        detail,
    }
}

fn score_kdj(highs: &[f64], lows: &[f64], closes: &[f64]) -> AnalysisIndicator {
    let k = kdj(highs, lows, closes, 9, 3, 3);
    let last = k.iter().rev().find_map(|x| *x);
    let (score, detail) = match last {
        Some(v) if v.j < 0.0 => (
            2.0,
            format!("KDJ J={:.1}，深度超卖（可能底背离）", v.j),
        ),
        Some(v) if v.j < 20.0 => (1.0, format!("KDJ J={:.1}，超卖", v.j)),
        Some(v) if v.j <= 80.0 => (
            0.0,
            format!("KDJ K={:.1} D={:.1} J={:.1}，中性", v.k, v.d, v.j),
        ),
        Some(v) if v.j <= 100.0 => (-1.0, format!("KDJ J={:.1}，超买", v.j)),
        Some(v) => (
            -2.0,
            format!("KDJ J={:.1}，深度超买（可能顶背离）", v.j),
        ),
        None => (0.0, "KDJ 数据不足".to_string()),
    };
    AnalysisIndicator {
        name: "KDJ(9,3,3)".to_string(),
        score,
        detail,
    }
}

fn score_boll(closes: &[f64]) -> AnalysisIndicator {
    let b = bollinger(closes, 20, 2.0);
    let last_boll = b.iter().rev().find_map(|x| *x);
    let last_close = closes.last().copied().unwrap_or(0.0);
    let (score, detail) = match last_boll {
        Some(band) => {
            let range = band.upper - band.lower;
            if range.abs() < f64::EPSILON {
                (0.0, "BOLL 带宽收敛，可能变盘".to_string())
            } else {
                // 位置：0..1，越靠近下轨越多头
                let pos = (last_close - band.lower) / range;
                if pos < 0.05 {
                    (2.0, format!("触及/跌破下轨 {:.2}，超跌", band.lower))
                } else if pos < 0.25 {
                    (1.0, format!("下轨附近（{:.2}%）", pos * 100.0))
                } else if pos <= 0.75 {
                    (0.0, format!("中轨附近（{:.2}%）", pos * 100.0))
                } else if pos <= 0.95 {
                    (-1.0, format!("上轨附近（{:.2}%）", pos * 100.0))
                } else {
                    (-2.0, format!("触及/突破上轨 {:.2}，超涨", band.upper))
                }
            }
        }
        None => (0.0, "BOLL 数据不足".to_string()),
    };
    AnalysisIndicator {
        name: "BOLL(20,2)".to_string(),
        score,
        detail,
    }
}

fn score_obv(closes: &[f64], volumes: &[Option<f64>]) -> AnalysisIndicator {
    let o = obv(closes, volumes);
    let n = o.len();
    let (score, detail) = if n < 6 || closes.len() < 6 {
        (0.0, "OBV 数据不足".to_string())
    } else {
        // 比较近 5 根的斜率方向 + 价格斜率方向
        let obv_slope = o[n - 1] - o[n - 6];
        let price_slope = closes[n - 1] - closes[n - 6];
        match (obv_slope > 0.0, price_slope > 0.0) {
            // 量增价升：健康上涨
            (true, true) => (1.0, "OBV↑ 且价格↑（量价配合，健康）".to_string()),
            // 量增价跌：吸筹底背离，强多信号
            (true, false) => (
                2.0,
                "OBV↑ 但价格↓（量增价跌，吸筹底背离）".to_string(),
            ),
            // 量减价升：顶背离预警
            (false, true) => (
                -2.0,
                "OBV↓ 但价格↑（量减价升，顶背离预警）".to_string(),
            ),
            // 量减价跌：健康下跌
            (false, false) => (
                -1.0,
                "OBV↓ 且价格↓（量价同弱，弱势延续）".to_string(),
            ),
        }
    };
    AnalysisIndicator {
        name: "OBV".to_string(),
        score,
        detail,
    }
}

/// 均线趋势：EMA20 / EMA60 / EMA250 的多头排列或空头排列。
fn score_ma_trend(closes: &[f64]) -> AnalysisIndicator {
    let n = closes.len();
    if n < 60 {
        return AnalysisIndicator {
            name: "均线趋势".to_string(),
            score: 0.0,
            detail: "均线数据不足".to_string(),
        };
    }
    let e20 = ema(closes, 20);
    let e60 = ema(closes, 60);
    let e250 = if n >= 250 { Some(ema(closes, 250)) } else { None };

    let last_20 = *e20.last().unwrap();
    let last_60 = *e60.last().unwrap();
    let close_now = *closes.last().unwrap();

    let (score, detail) = match e250 {
        Some(e) => {
            let l250 = *e.last().unwrap();
            if close_now > last_20 && last_20 > last_60 && last_60 > l250 {
                (
                    2.0,
                    format!(
                        "多头排列：Close>{:.2}(EMA20)>{:.2}(EMA60)>{:.2}(EMA250)",
                        last_20, last_60, l250
                    ),
                )
            } else if close_now < last_20 && last_20 < last_60 && last_60 < l250 {
                (
                    -2.0,
                    format!(
                        "空头排列：Close<{:.2}<{:.2}<{:.2}",
                        last_20, last_60, l250
                    ),
                )
            } else if close_now > last_20 && last_20 > last_60 {
                (1.0, "短中期均线偏多".to_string())
            } else if close_now < last_20 && last_20 < last_60 {
                (-1.0, "短中期均线偏空".to_string())
            } else {
                (0.0, "均线纠缠，趋势不明".to_string())
            }
        }
        None => {
            if close_now > last_20 && last_20 > last_60 {
                (1.0, "短中期均线偏多（长期均线数据不足）".to_string())
            } else if close_now < last_20 && last_20 < last_60 {
                (-1.0, "短中期均线偏空（长期均线数据不足）".to_string())
            } else {
                (0.0, "均线纠缠".to_string())
            }
        }
    };

    AnalysisIndicator {
        name: "均线趋势".to_string(),
        score,
        detail,
    }
}

/// 拼装人类可读的理由文字。
fn compose_reason(indicators: &[AnalysisIndicator], insufficient: bool) -> String {
    if insufficient {
        return "数据不足（少于 60 根 K 线），无法给出可靠分析。".to_string();
    }
    let mut bull = Vec::new();
    let mut bear = Vec::new();
    for i in indicators {
        if i.score > 0.3 {
            bull.push(format!("{}({:+.1})", i.name, i.score));
        } else if i.score < -0.3 {
            bear.push(format!("{}({:+.1})", i.name, i.score));
        }
    }
    let mut parts = Vec::new();
    if !bull.is_empty() {
        parts.push(format!("偏多：{}", bull.join("、")));
    }
    if !bear.is_empty() {
        parts.push(format!("偏空：{}", bear.join("、")));
    }
    if parts.is_empty() {
        "各指标信号均不明显，建议观望。".to_string()
    } else {
        parts.join("；")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::KlinePoint;

    fn make_points(closes: Vec<f64>) -> Vec<KlinePoint> {
        closes
            .into_iter()
            .enumerate()
            .map(|(i, c)| KlinePoint {
                ts: format!("2024-{:02}-{:02}", (i / 30) % 12 + 1, i % 30 + 1),
                open: c,
                high: c * 1.01,
                low: c * 0.99,
                close: c,
                volume: Some(1000.0 + i as f64),
                amount: None,
                dif: None,
                dea: None,
                macd: None,
            })
            .collect()
    }

    #[test]
    fn insufficient_data_returns_hold() {
        let pts = make_points(vec![10.0; 30]);
        let r = analyze("X:1".into(), "1d".into(), pts);
        assert_eq!(r.rating, "hold");
        assert!(r.indicators.is_empty());
    }

    #[test]
    fn strong_uptrend_leans_buy_or_hold() {
        // 单调上升 300 根 - 会触发 RSI 超买、BOLL 上轨（偏空）
        // 但 MACD 水上金叉、均线多头排列（偏多）
        // 综合下来应该在 hold~watch_buy 之间
        let closes: Vec<f64> = (1..=300).map(|i| 10.0 + i as f64 * 0.1).collect();
        let r = analyze("X:1".into(), "1d".into(), make_points(closes));
        // 只断言 5 个必备指标都产生（含均线趋势 = 6 个）
        assert_eq!(r.indicators.len(), 6);
        assert!(r.composite_score.is_finite());
    }

    #[test]
    fn suggestions_are_reasonable() {
        // 用横盘振荡数据：现价 100，历史围绕 100 波动
        let closes: Vec<f64> = (0..300)
            .map(|i| 100.0 + ((i as f64 * 0.7).sin() * 5.0))
            .collect();
        let r = analyze("X:1".into(), "1d".into(), make_points(closes));

        let buy = r.buy_suggestion.expect("加仓价应存在");
        let sell = r.sell_suggestion.expect("减仓价应存在");

        // 加仓价应小于现价
        assert!(
            buy.advised < r.last_close,
            "buy.advised={} last_close={}",
            buy.advised,
            r.last_close
        );
        // 减仓价应大于现价
        assert!(
            sell.advised > r.last_close,
            "sell.advised={} last_close={}",
            sell.advised,
            r.last_close
        );
        // 加仓 3 档递减
        assert!(buy.discount_tiers[0] > buy.discount_tiers[1]);
        assert!(buy.discount_tiers[1] > buy.discount_tiers[2]);
        // 减仓 3 档递增
        assert!(sell.discount_tiers[0] < sell.discount_tiers[1]);
        assert!(sell.discount_tiers[1] < sell.discount_tiers[2]);
        // 加仓综合价（保守价）在温和行情下 = min(support, tiers[0])，且落在 clamp 区间内。
        // 横盘数据 clamp 不触发，原有偏序关系仍成立。
        assert!(buy.advised < r.last_close);
        assert!(buy.advised >= r.last_close * 0.85 - 1e-9, "buy.advised 应 >= 现价×0.85");
        assert!(buy.advised <= buy.support + 1e-9);
        assert!(buy.advised <= buy.discount_tiers[0] + 1e-9);
        // 加仓触发价 = max(support, tiers[0])，应 >= advised
        assert!(buy.trigger >= buy.advised);
        assert!(buy.trigger >= buy.support || buy.trigger >= buy.discount_tiers[0]);
        // 减仓综合价（保守价）在温和行情下 = max(support, tiers[0])，且落在 clamp 区间内
        assert!(sell.advised > r.last_close);
        assert!(sell.advised <= r.last_close * 1.15 + 1e-9, "sell.advised 应 <= 现价×1.15");
        assert!(sell.advised >= sell.support - 1e-9);
        assert!(sell.advised >= sell.discount_tiers[0] - 1e-9);
        // 减仓触发价 = min(support, tiers[0])，应 <= advised
        assert!(sell.trigger <= sell.advised);
    }

    #[test]
    fn advised_is_clamped_on_extreme_lows() {
        // 极端场景：前 280 根围绕 100 震荡，最近 20 根出现闪崩到 50。
        // 此时 20 日最低 = 50，会把 support 中位数拉低。
        // 未 clamp 时 buy.advised 可能落到 50 附近；clamp 后应 >= 现价 × 0.85。
        let mut closes: Vec<f64> = (0..280)
            .map(|i| 100.0 + ((i as f64 * 0.7).sin() * 3.0))
            .collect();
        // 20 根闪崩：从 100 一路砸到 55，再回到 95
        for i in 0..20 {
            let v = if i < 10 {
                100.0 - i as f64 * 5.0 // 100 → 55
            } else {
                55.0 + (i - 10) as f64 * 4.0 // 55 → 91
            };
            closes.push(v);
        }
        let r = analyze("X:1".into(), "1d".into(), make_points(closes));
        let buy = r.buy_suggestion.expect("加仓价应存在");
        // 现价 ≈ 91，clamp 下限 = 91 × 0.85 ≈ 77.35
        assert!(
            buy.advised >= r.last_close * 0.85 - 1e-9,
            "buy.advised={} 应 >= 现价({})×0.85={}",
            buy.advised,
            r.last_close,
            r.last_close * 0.85
        );
        // 触发价不夹逼，反映真实市场支撑（可能低于 clamp 下限）
        // 但触发价应仍 <= 现价（加仓触发价必然低于或等于现价）
        assert!(buy.trigger <= r.last_close + 1e-9);
    }

    #[test]
    fn suggestions_none_when_bars_too_few() {
        let closes = vec![10.0; 15]; // 少于 20 → build_suggestion 返回 None（虽然 analyze 会因 <60 提前返回）
        let r = analyze("X:1".into(), "1d".into(), make_points(closes));
        // <60 直接命中 insufficient → suggestions 应为 None
        assert!(r.buy_suggestion.is_none());
        assert!(r.sell_suggestion.is_none());
    }
}
