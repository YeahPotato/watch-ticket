/**
 * Tauri event 订阅工具。
 *
 * 事件名与 src-tauri/src/events.rs 中的常量对应。
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  Alert,
  IntradayPoint,
  KlinePoint,
  Quote,
  Subscription,
} from "./tauri";

export const Events = {
  QuoteUpdated: "quote:updated",
  IntradayUpdated: "intraday:updated",
  KlineUpdated: "kline:updated",
  SubscriptionChanged: "subscription:changed",
  PollError: "poll:error",
  AlertNew: "alert:new",
} as const;

export interface QuoteUpdatedPayload {
  symbol: string;
  quote: Quote;
}
export interface IntradayUpdatedPayload {
  symbol: string;
  points: IntradayPoint[];
}
export interface KlineUpdatedPayload {
  symbol: string;
  period: string;
  points: KlinePoint[];
}
export interface SubscriptionChangedPayload {
  subscriptions: Subscription[];
}
export interface PollErrorPayload {
  symbol: string;
  kind: string;
  error: string;
}

export interface AlertNewPayload {
  alerts: Alert[];
}

export function onQuoteUpdated(
  cb: (p: QuoteUpdatedPayload) => void,
): Promise<UnlistenFn> {
  return listen<QuoteUpdatedPayload>(Events.QuoteUpdated, (e) => cb(e.payload));
}

export function onIntradayUpdated(
  cb: (p: IntradayUpdatedPayload) => void,
): Promise<UnlistenFn> {
  return listen<IntradayUpdatedPayload>(Events.IntradayUpdated, (e) =>
    cb(e.payload),
  );
}

export function onKlineUpdated(
  cb: (p: KlineUpdatedPayload) => void,
): Promise<UnlistenFn> {
  return listen<KlineUpdatedPayload>(Events.KlineUpdated, (e) => cb(e.payload));
}

export function onSubscriptionChanged(
  cb: (p: SubscriptionChangedPayload) => void,
): Promise<UnlistenFn> {
  return listen<SubscriptionChangedPayload>(Events.SubscriptionChanged, (e) =>
    cb(e.payload),
  );
}

export function onPollError(
  cb: (p: PollErrorPayload) => void,
): Promise<UnlistenFn> {
  return listen<PollErrorPayload>(Events.PollError, (e) => cb(e.payload));
}

export function onAlertNew(
  cb: (p: AlertNewPayload) => void,
): Promise<UnlistenFn> {
  return listen<AlertNewPayload>(Events.AlertNew, (e) => cb(e.payload));
}
