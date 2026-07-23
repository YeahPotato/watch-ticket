/**
 * 前端指标计算（供图表副图用，与 Rust 端算法一致）。
 *
 * MACD:
 *   EMA_short = EMA(close, fast=12)
 *   EMA_long  = EMA(close, slow=26)
 *   DIF       = EMA_short - EMA_long
 *   DEA       = EMA(DIF, signal=9)
 *   MACD      = (DIF - DEA) * 2   // 常见约定
 *
 * 首根值不足以计算 EMA 时返回 null。
 */

export interface MacdPoint {
  dif: number | null;
  dea: number | null;
  macd: number | null;
}

export type MacdCrossInfo = {
  isGoldCross: boolean;
  isDeadCross: boolean;
  curr: MacdPoint | null;
  prev: MacdPoint | null;
};


/**
 * 通用 EMA 递推。
 * ema[0] = value[0]；ema[i] = alpha * value[i] + (1 - alpha) * ema[i-1]
 * alpha = 2 / (period + 1)
 */
export function ema(values: number[], period: number): (number | null)[] {
  if (period <= 0) throw new Error("period must be > 0");
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length === 0) return out;
  const alpha = 2 / (period + 1);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    const v = alpha * values[i] + (1 - alpha) * prev;
    out[i] = v;
    prev = v;
  }
  return out;
}


/**
 * MACD(12,26,9) 计算
 * @param closes 收盘价数组
 * @param fast DIF快线周期 默认12
 * @param slow DIF慢线周期 默认26
 * @param signal DEA周期 默认9
 * @returns MacdPoint[] 前置预热区间数据标记为null
 */
export function macd(
  closes: number[],
  fast = 12,
  slow = 26,
  signal = 9,
): MacdPoint[] {
  if (closes.length === 0) return [];

  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);

  // DIF = EMA12 - EMA26
  const dif: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    const f = emaFast[i];
    const s = emaSlow[i];
    dif.push(f != null && s != null ? f - s : 0);
  }

  const deaRaw = ema(dif, signal);
  const out: MacdPoint[] = [];
  const warmup = Math.max(fast, slow) - 1;

  for (let i = 0; i < closes.length; i++) {
    if (i < warmup) {
      out.push({ dif: null, dea: null, macd: null });
      continue;
    }
    const d = dif[i];
    const de = deaRaw[i] ?? null;
    const macdVal = de !== null ? (d - de) * 2 : null;
    out.push({ dif: d, dea: de, macd: macdVal });
  }

  return out;
}

// 浮点数对比容错阈值
const EPS = 1e-8;

/**
 * 检测最新K线是否形成MACD金叉/死叉
 */
export function detectMacdCross(macdResult: MacdPoint[]): MacdCrossInfo {
  // 过滤预热无效数据
  const validPoints = macdResult.filter(p => p.dif !== null && p.dea !== null);
  if (validPoints.length < 2) {
    return {
      isGoldCross: false,
      isDeadCross: false,
      curr: null,
      prev: null,
    };
  }

  const prev = validPoints.at(-2)!;
  const curr = validPoints.at(-1)!;

  const prevDiff = prev.dif! - prev.dea!;
  const currDiff = curr.dif! - curr.dea!;

  // 金叉：DIF上穿DEA
  const isGoldCross = prevDiff <= EPS && currDiff > EPS;
  // 死叉：DIF下穿DEA
  const isDeadCross = prevDiff >= -EPS && currDiff < -EPS;

  return {
    isGoldCross,
    isDeadCross,
    curr,
    prev,
  };
}

/**
 * 生成交易信号（匹配你的做T/建仓规则）
 */
export function getMacdTradeSignal(macdResult: MacdPoint[]): string {
  const cross = detectMacdCross(macdResult);
  if (!cross.curr) return "⏸ 数据不足，观望";

  const currDea = cross.curr.dea!;
  const isWaterUp = currDea > EPS;

  if (cross.isGoldCross) {
    if (isWaterUp) {
      // 零轴附近金叉判定
      if (Math.abs(currDea) < 0.1) {
        return "✅【建仓信号】零轴附近水上金叉";
      } else {
        return "✅【加仓信号】上涨途中水上金叉";
      }
    } else {
      return "⚠️【水下金叉】短线反弹，不新增长线底仓";
    }
  }

  if (cross.isDeadCross) {
    if (isWaterUp) {
      return "⚠️【减仓信号】水上死叉，适合反T高抛";
    } else {
      return "❌【风险信号】水下死叉，下跌趋势，禁止抄底";
    }
  }

  return "⏸ 暂无有效交叉信号，观望";
}