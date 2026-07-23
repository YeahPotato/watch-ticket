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

/** Rust 返回的错误结构 */
export interface RustError {
  code: number;
  message: string;
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
};
