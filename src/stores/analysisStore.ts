/**
 * 量化分析 store：保存每只票的最新 AnalysisReport + 自动刷新调度。
 *
 * 自动刷新（可开关，默认 ON）：
 *   - 引用计数：AnalysisWidget 挂载 register()，卸载 unregister()；只在 >=1 个 widget 时定时器活跃
 *   - 每 60 秒 tick：过滤出「所属市场当前开盘」的自选，调 refreshAll
 *   - 闲时（非交易时段）不发请求，只在下次 tick 再判断
 *   - 用户可通过 setAutoRefresh(false) 关闭
 */

import { create } from "zustand";

import { api, type AnalysisReport } from "@/api/tauri";
import { useMarketStore } from "@/stores/marketStore";

interface Entry {
  report: AnalysisReport | null;
  loading: boolean;
  updatedAt: number;
  error?: string;
}

/** 可排序字段 ID（与 AnalysisWidget 表头一一对应） */
export type SortField =
  | "symbol"
  | "name"
  | "price"
  | "change_pct"
  | "composite_score"
  | "updated_at";

export type SortDirection = "asc" | "desc";

export interface SortState {
  field: SortField;
  direction: SortDirection;
}

const SORT_STORAGE_KEY = "analysis_widget_sort";
const DEFAULT_SORT: SortState = { field: "composite_score", direction: "desc" };

interface State {
  reports: Record<string, Entry>;
  batchLoading: boolean;

  /** 自动刷新开关（默认 ON） */
  autoRefresh: boolean;
  /** 当前最后一次自动 tick 使用的周期，供 widget 变更后同步 */
  autoRefreshPeriod: string;
  autoRefreshBars: number;

  /** 表格排序：null 表示不排序，回到 subscriptions 原顺序 */
  sort: SortState | null;
  sortLoaded: boolean;

  refreshOne: (
    symbol: string,
    period?: string,
    bars?: number,
  ) => Promise<void>;
  refreshAll: (
    symbols: string[],
    period?: string,
    bars?: number,
  ) => Promise<void>;
  clearOne: (symbol: string) => void;

  setAutoRefresh: (v: boolean) => void;
  setAutoRefreshParams: (period: string, bars: number) => void;

  /** 引用计数：widget 挂载/卸载时调用；管理定时器生命周期 */
  register: () => void;
  unregister: () => void;

  /** 排序：从 SQLite 载入（首次挂载） */
  loadSort: () => Promise<void>;
  /** 排序：3 态循环 desc → asc → null（若当前不是该字段则从 desc 开始） */
  cycleSort: (field: SortField) => void;
}

const CONCURRENCY = 3;
const AUTO_INTERVAL_MS = 60_000; // 每分钟一次

let timer: ReturnType<typeof setInterval> | null = null;
let refCount = 0;

// 排序写库 debounce（避免用户快速点击表头频繁 IO）
let saveSortTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSaveSort(sort: SortState | null) {
  if (saveSortTimer) clearTimeout(saveSortTimer);
  saveSortTimer = setTimeout(() => {
    api
      .updateSetting(SORT_STORAGE_KEY, JSON.stringify(sort))
      .catch((e) => console.warn("保存排序失败", e));
  }, 300);
}

/** 定时器 tick：过滤开盘中的自选，调 refreshAll */
async function tick() {
  const state = useAnalysisStore.getState();
  if (!state.autoRefresh) return;
  if (state.batchLoading) return; // 上一批未结束，本轮跳过

  const subs = useMarketStore.getState().subscriptions;
  if (subs.length === 0) return;

  try {
    // 并发查每个市场是否开盘（不同 symbol 同市场会重复查，合理接受）
    const uniqMarkets = Array.from(new Set(subs.map((s) => s.market)));
    const marketOpen = new Map<string, boolean>();
    await Promise.all(
      uniqMarkets.map(async (m) => {
        try {
          const ok = await api.isMarketOpen(m);
          marketOpen.set(m, ok);
        } catch {
          marketOpen.set(m, false);
        }
      }),
    );

    const targets = subs
      .filter((s) => marketOpen.get(s.market))
      .map((s) => s.symbol);
    if (targets.length === 0) {
      // 全部收盘，静默跳过
      return;
    }

    await state.refreshAll(
      targets,
      state.autoRefreshPeriod,
      state.autoRefreshBars,
    );
  } catch (e) {
    console.debug("自动刷新 tick 失败（已忽略）", e);
  }
}

function startTimer() {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch(() => undefined);
  }, AUTO_INTERVAL_MS);
}

function stopTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export const useAnalysisStore = create<State>((set, get) => ({
  reports: {},
  batchLoading: false,
  autoRefresh: true,
  autoRefreshPeriod: "1d",
  autoRefreshBars: 750,
  sort: DEFAULT_SORT,
  sortLoaded: false,

  refreshOne: async (symbol, period = "1d", bars) => {
    set((s) => ({
      reports: {
        ...s.reports,
        [symbol]: {
          report: s.reports[symbol]?.report ?? null,
          loading: true,
          updatedAt: s.reports[symbol]?.updatedAt ?? 0,
        },
      },
    }));
    try {
      const r = await api.analyzeSymbol(symbol, period, bars);
      set((s) => ({
        reports: {
          ...s.reports,
          [symbol]: {
            report: r,
            loading: false,
            updatedAt: Date.now(),
          },
        },
      }));
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? String(e);
      set((s) => ({
        reports: {
          ...s.reports,
          [symbol]: {
            report: s.reports[symbol]?.report ?? null,
            loading: false,
            updatedAt: Date.now(),
            error: msg,
          },
        },
      }));
    }
  },

  refreshAll: async (symbols, period = "1d", bars) => {
    if (symbols.length === 0) return;
    set({ batchLoading: true });
    const queue = [...symbols];
    const refreshOne = get().refreshOne;
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () =>
      (async () => {
        while (queue.length > 0) {
          const s = queue.shift();
          if (!s) return;
          await refreshOne(s, period, bars);
        }
      })(),
    );
    try {
      await Promise.all(workers);
    } finally {
      set({ batchLoading: false });
    }
  },

  clearOne: (symbol) => {
    set((s) => {
      const next = { ...s.reports };
      delete next[symbol];
      return { reports: next };
    });
  },

  setAutoRefresh: (v) => {
    set({ autoRefresh: v });
  },
  setAutoRefreshParams: (period, bars) => {
    set({ autoRefreshPeriod: period, autoRefreshBars: bars });
  },

  register: () => {
    refCount += 1;
    if (refCount === 1) {
      startTimer();
    }
    // 首次挂载时懒加载排序
    if (!get().sortLoaded) {
      get()
        .loadSort()
        .catch(() => undefined);
    }
  },
  unregister: () => {
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0) {
      stopTimer();
    }
  },

  loadSort: async () => {
    try {
      const raw = await api.getSetting(SORT_STORAGE_KEY);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as SortState | null;
          set({ sort: parsed, sortLoaded: true });
          return;
        } catch {
          // fallthrough → default
        }
      }
      set({ sort: DEFAULT_SORT, sortLoaded: true });
    } catch (e) {
      console.debug("载入排序失败，使用默认", e);
      set({ sort: DEFAULT_SORT, sortLoaded: true });
    }
  },

  cycleSort: (field) => {
    const current = get().sort;
    let next: SortState | null;
    if (!current || current.field !== field) {
      // 换字段或从无排序进入：默认降序
      next = { field, direction: "desc" };
    } else if (current.direction === "desc") {
      next = { field, direction: "asc" };
    } else {
      // asc → 无排序
      next = null;
    }
    set({ sort: next });
    scheduleSaveSort(next);
  },
}));
