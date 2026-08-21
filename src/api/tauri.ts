/**
 * Tauri 后端命令封装。
 *
 * 与 src-tauri/src/commands.rs 中的 #[tauri::command] 一一对应。
 */

import { invoke } from "@tauri-apps/api/core";

export interface PingInfo {
  app_version: string;
  sidecar_port: number | null;
  sidecar_ok: boolean;
  sidecar_error: string | null;
  db_ok: boolean;
  db_path: string;
}

export interface Quote {
  symbol: string;
  name?: string | null;
  price?: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  prev_close?: number | null;
  change?: number | null;
  change_pct?: number | null;
  volume?: number | null;
  amount?: number | null;
  ts?: string | null;
}

export interface IntradayPoint {
  ts: string;
  price: number;
  avg_price?: number | null;
  volume?: number | null;
  amount?: number | null;
}

export interface KlinePoint {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
  amount?: number | null;
  dif?: number | null;
  dea?: number | null;
  macd?: number | null;
}

export interface SearchItem {
  symbol: string;
  name: string;
  market: string;
}

export interface Subscription {
  id: number;
  symbol: string;
  name: string | null;
  market: string;
  kline_periods: string;
  sort_order: number;
  added_at: string;
  /** 用户自由文本备注（可为空字符串） */
  note: string;
}

export interface Alert {
  id: number;
  symbol: string;
  period: string;
  ts: string;
  alert_type: string; // "golden_cross" / "dead_cross"
  /**
   * 业务细分：
   *   golden_entry   零轴附近水上金叉 → 建仓
   *   golden_add     水上金叉（远离零轴）→ 加仓
   *   golden_bounce  水下金叉 → 短线反弹
   *   dead_reduce    水上死叉 → 减仓 / 做反 T
   *   dead_risk      水下死叉 → 风险信号
   *   legacy         旧数据（无细分）
   */
  alert_kind: string;
  dif: number | null;
  dea: number | null;
  price: number | null;
  acknowledged: boolean;
  created_at: string;
}

export interface AnalysisIndicator {
  name: string;
  /** [-2, +2] */
  score: number;
  detail: string;
}

/** 建议价参考位（支撑/压力位来源） */
export interface PriceRefs {
  boll: number | null;
  ema20: number | null;
  extreme_20d: number;
}

/** 建议加仓或减仓价 */
export interface PriceSuggestion {
  /** 保守价：更远离现价 */
  advised: number;
  /** 触发价：较易触及，实盘挂单参考 */
  trigger: number;
  support: number;
  refs: PriceRefs;
  /** 加仓：avg×0.95/0.92/0.90；减仓：avg×1.05/1.08/1.10；均价缺失时全 NaN */
  discount_tiers: [number, number, number];
}

/** 量化分析评级 key */
export type AnalysisRating =
  | "strong_buy"
  | "watch_buy"
  | "hold"
  | "watch_sell"
  | "strong_sell";

export interface AnalysisReport {
  symbol: string;
  period: string;
  bars: number;
  last_close: number;
  avg_price: number | null;
  avg_deviation_pct: number | null;
  composite_score: number;
  rating: AnalysisRating;
  rating_label: string;
  indicators: AnalysisIndicator[];
  reason: string;
  buy_suggestion: PriceSuggestion | null;
  sell_suggestion: PriceSuggestion | null;
}

/** Rust 返回的错误结构 */
export interface RustError {
  code: number;
  message: string;
}

/** 单笔分红明细 */
export interface DividendRecord {
  ex_date: string | null;
  cash_per_share: number | null;
  note: string | null;
}

/** 过去 12 个月（TTM）的分红汇总（税前含税），与东财 F10 口径一致 */
export interface DividendInfo {
  symbol: string;
  /** [已废弃语义] 兼容字段：end_date 所在自然年 */
  year: number;
  /** TTM 截止日期，"YYYY-MM-DD" */
  end_date: string | null;
  /** 12 个月加总（元/股），无数据时 null */
  dividend_per_share: number | null;
  records: DividendRecord[];
  source: string | null;
}

export const api = {
  // 自检
  ping: () => invoke<PingInfo>("ping"),
  sidecarHealth: () => invoke<unknown>("sidecar_health"),

  // 直查 sidecar
  getQuote: (symbol: string) => invoke<Quote>("get_quote", { symbol }),
  getKline: (symbol: string, period: string, limit = 500) =>
    invoke<KlinePoint[]>("get_kline", { symbol, period, limit }),
  searchSymbol: (keyword: string, limit = 20) =>
    invoke<SearchItem[]>("search_symbol", { keyword, limit }),

  // 订阅管理
  listSubscriptions: () => invoke<Subscription[]>("list_subscriptions"),
  addSubscription: (
    symbol: string,
    name?: string,
    klinePeriods?: string,
  ) =>
    invoke<Subscription>("add_subscription", {
      symbol,
      name,
      klinePeriods,
    }),
  removeSubscription: (symbol: string) =>
    invoke<number>("remove_subscription", { symbol }),
  updateSubscriptionPeriods: (symbol: string, klinePeriods: string) =>
    invoke<void>("update_subscription_periods", {
      symbol,
      klinePeriods,
    }),
  updateSubscriptionNote: (symbol: string, note: string) =>
    invoke<void>("update_subscription_note", { symbol, note }),

  // 缓存查询
  getCachedKline: (symbol: string, period: string, limit = 500) =>
    invoke<KlinePoint[]>("get_cached_kline", { symbol, period, limit }),

  // 主动刷新分时数据（会 emit intraday:updated 事件）
  refreshIntraday: (symbol: string) =>
    invoke<IntradayPoint[]>("refresh_intraday", { symbol }),

  // 设置
  listSettings: () => invoke<Record<string, string>>("list_settings"),
  updateSetting: (key: string, value: string) =>
    invoke<void>("update_setting", { key, value }),
  getSetting: (key: string) =>
    invoke<string | null>("get_setting", { key }),

  // 告警
  listAlerts: (limit = 200, onlyUnack = false) =>
    invoke<Alert[]>("list_alerts", { limit, onlyUnack }),
  ackAlert: (id: number) => invoke<number>("ack_alert", { id }),
  ackAllAlerts: () => invoke<number>("ack_all_alerts"),
  countUnackAlerts: () => invoke<number>("count_unack_alerts"),
  clearAlerts: (olderThanDays = 30) =>
    invoke<number>("clear_alerts", { olderThanDays }),

  // 量化分析
  analyzeSymbol: (symbol: string, period = "1d", bars = 750) =>
    invoke<AnalysisReport>("analyze_symbol", { symbol, period, bars }),

  // 分红派息（过去 12 个月 TTM）；A 股/港股支持，US 返回 dividend_per_share=null
  getDividend: (symbol: string, endDate?: string) =>
    invoke<DividendInfo>("get_dividend", { symbol, endDate: endDate ?? null }),

  // 交易时段查询（供前端定时任务判断）
  isMarketOpen: (market: string) =>
    invoke<boolean>("is_market_open", { market }),
};
