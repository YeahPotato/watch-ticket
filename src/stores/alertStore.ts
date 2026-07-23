/**
 * MACD 信号历史 store。
 *
 * 变更（相比早期版本）：
 *   - 不再有"未读/已读"UI 语义（不再通知，纯历史列表）
 *   - 保留 acknowledged 字段以兼容 DB，但前端不再展示/操作
 *
 * 生命周期：App 启动时 initAlertStore()。
 */

import { create } from "zustand";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { listen } from "@tauri-apps/api/event";

import { api, type Alert } from "@/api/tauri";

interface AlertNewPayload {
  alerts: Alert[];
}

interface AlertState {
  alerts: Alert[];
  loading: boolean;
  loaded: boolean;

  refresh: (opts?: { limit?: number }) => Promise<void>;
  clearOld: (days: number) => Promise<void>;
}

export const useAlertStore = create<AlertState>((set, get) => ({
  alerts: [],
  loading: false,
  loaded: false,

  refresh: async (opts) => {
    set({ loading: true });
    try {
      const list = await api.listAlerts(opts?.limit ?? 500, false);
      set({ alerts: list, loaded: true });
    } finally {
      set({ loading: false });
    }
  },

  clearOld: async (days) => {
    await api.clearAlerts(days);
    await get().refresh();
  },
}));

let unlisten: UnlistenFn | null = null;

export async function initAlertStore() {
  if (unlisten) return;

  unlisten = await listen<AlertNewPayload>("alert:new", (evt) => {
    const arrivals = evt.payload.alerts;
    if (!arrivals?.length) return;
    useAlertStore.setState((s) => {
      const known = new Set(s.alerts.map((a) => a.id));
      const news = arrivals.filter((a) => !known.has(a.id));
      if (news.length === 0) return s;
      return { alerts: [...news, ...s.alerts] };
    });
  });
}

export function disposeAlertStore() {
  if (unlisten) {
    try {
      unlisten();
    } catch {
      /* ignore */
    }
    unlisten = null;
  }
}
