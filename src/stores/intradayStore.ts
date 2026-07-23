/**
 * 分时数据 store。
 *
 * 数据来源：
 *   - 首次访问：invoke("refresh_intraday", symbol) 主动拉一次（不依赖调度器交易时段判断）
 *   - 之后：Rust 端 emit `intraday:updated` 事件（调度器交易时段内自动刷新）
 *
 * 使用：App 启动时调用一次 initIntradayStore() 建立事件监听。
 */

import { create } from "zustand";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { api, type IntradayPoint } from "@/api/tauri";
import { onIntradayUpdated } from "@/api/events";

interface Entry {
  points: IntradayPoint[];
  loading: boolean;
  updatedAt: number;
  error?: string;
}

interface State {
  entries: Record<string, Entry>;
  ensure: (symbol: string, opts?: { force?: boolean }) => Promise<void>;
}

export const useIntradayStore = create<State>((set, get) => ({
  entries: {},

  ensure: async (symbol, opts) => {
    const existing = get().entries[symbol];
    if (!opts?.force && existing) {
      // 已有加载中，或已经加载过（不管是否有点数据），都不重复拉
      if (existing.loading) return;
      // 已经有数据也不重复拉（事件会更新）
      if (existing.points.length > 0) return;
      // 之前明确失败过：允许再试一次
    }

    set((s) => ({
      entries: {
        ...s.entries,
        [symbol]: {
          points: existing?.points ?? [],
          loading: true,
          updatedAt: existing?.updatedAt ?? 0,
        },
      },
    }));

    try {
      const points = await api.refreshIntraday(symbol);
      // refreshIntraday 内部已经 emit 事件，但事件回来时机可能晚于此处 return；
      // 主动写入一次保证 UI 立即看到。
      set((s) => ({
        entries: {
          ...s.entries,
          [symbol]: { points, loading: false, updatedAt: Date.now() },
        },
      }));
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? String(e);
      console.warn("refreshIntraday 失败", symbol, msg);
      set((s) => ({
        entries: {
          ...s.entries,
          [symbol]: {
            points: existing?.points ?? [],
            loading: false,
            updatedAt: Date.now(),
            error: msg,
          },
        },
      }));
    }
  },
}));

let unlisten: UnlistenFn | null = null;

export async function initIntradayStore() {
  if (unlisten) return;
  unlisten = await onIntradayUpdated((p) => {
    useIntradayStore.setState((s) => ({
      entries: {
        ...s.entries,
        [p.symbol]: {
          points: p.points,
          loading: false,
          updatedAt: Date.now(),
        },
      },
    }));
  });
}

export function disposeIntradayStore() {
  if (unlisten) {
    try {
      unlisten();
    } catch {
      /* ignore */
    }
    unlisten = null;
  }
}
