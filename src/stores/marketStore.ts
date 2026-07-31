/**
 * 全局订阅与最新报价 store。
 *
 * 生命周期：App.tsx 启动时调用 `initMarketStore()` 建立事件监听 + 首次加载。
 *
 * 报价获取策略：
 *   - 后台调度器仅在**交易时段**每 5 秒拉一次 → emit `quote:updated` → 写入 quotes
 *   - 但收盘时段调度器不拉 → quotes 会一直为空。因此：
 *     1) initMarketStore 时对所有现有订阅主动拉一次
 *     2) 订阅列表变更时（新增/删除）对新出现的 symbol 主动拉一次
 */

import { create } from "zustand";

import { api, type Quote, type Subscription } from "@/api/tauri";
import {
  onPollError,
  onQuoteUpdated,
  onSubscriptionChanged,
  type PollErrorPayload,
} from "@/api/events";

interface MarketState {
  subscriptions: Subscription[];
  /** symbol → 最新报价 */
  quotes: Record<string, Quote>;
  /** 最近的拉取错误（保留最多 20 条） */
  errors: (PollErrorPayload & { at: number })[];

  loading: boolean;
  loaded: boolean;

  refresh: () => Promise<void>;
  addSymbol: (
    symbol: string,
    name?: string,
    klinePeriods?: string,
  ) => Promise<void>;
  removeSymbol: (symbol: string) => Promise<void>;
  updateNote: (symbol: string, note: string) => Promise<void>;
}

export const useMarketStore = create<MarketState>((set, get) => ({
  subscriptions: [],
  quotes: {},
  errors: [],
  loading: false,
  loaded: false,

  refresh: async () => {
    set({ loading: true });
    try {
      const subs = await api.listSubscriptions();
      set({ subscriptions: subs, loaded: true });
    } finally {
      set({ loading: false });
    }
  },

  addSymbol: async (symbol, name, klinePeriods) => {
    await api.addSubscription(symbol, name, klinePeriods);
    // subscription:changed 事件会带回全量，这里不用手动 refresh
  },

  removeSymbol: async (symbol) => {
    await api.removeSubscription(symbol);
    // 清掉本地缓存的报价
    const q = { ...get().quotes };
    delete q[symbol];
    set({ quotes: q });
  },

  updateNote: async (symbol, note) => {
    // 乐观更新本地 subscription 的 note
    const subs = get().subscriptions.map((s) =>
      s.symbol === symbol ? { ...s, note } : s,
    );
    set({ subscriptions: subs });
    try {
      await api.updateSubscriptionNote(symbol, note);
      // 后端会 emit subscription:changed，届时会用后端 truth 覆盖本地状态
    } catch (e) {
      console.warn("保存备注失败", e);
      // 失败时不主动 revert，一段时间后 subscription:changed 会矫正
      throw e;
    }
  },
}));

let unsubscribers: Array<() => void> = [];

/** 单只票主动拉一次报价，成功后写入 quotes；失败静默（避免刷屏） */
async function fetchQuoteOnce(symbol: string): Promise<void> {
  try {
    const q = await api.getQuote(symbol);
    useMarketStore.setState((s) => ({
      quotes: { ...s.quotes, [symbol]: q },
    }));
  } catch (e) {
    console.debug("fetchQuoteOnce 失败", symbol, e);
  }
}

/** 对一批 symbol 并发拉报价（限流：一次最多 5 个） */
async function fetchQuotesBatch(symbols: string[]): Promise<void> {
  const BATCH = 5;
  for (let i = 0; i < symbols.length; i += BATCH) {
    const slice = symbols.slice(i, i + BATCH);
    await Promise.all(slice.map(fetchQuoteOnce));
  }
}

export async function initMarketStore(): Promise<void> {
  // 先卸载旧的（HMR 场景）
  disposeMarketStore();

  const store = useMarketStore.getState();
  await store.refresh();

  // 1) 建立事件监听
  const off1 = await onSubscriptionChanged((p) => {
    // 找出新出现的 symbol，主动拉一次报价（用户 add 后立刻能看到价格）
    const oldSet = new Set(
      useMarketStore.getState().subscriptions.map((s) => s.symbol),
    );
    useMarketStore.setState({ subscriptions: p.subscriptions });
    const newlyAdded = p.subscriptions
      .map((s) => s.symbol)
      .filter((s) => !oldSet.has(s));
    if (newlyAdded.length > 0) {
      fetchQuotesBatch(newlyAdded).catch(() => undefined);
    }
  });
  const off2 = await onQuoteUpdated((p) => {
    useMarketStore.setState((s) => ({
      quotes: { ...s.quotes, [p.symbol]: p.quote },
    }));
  });
  const off3 = await onPollError((p) => {
    useMarketStore.setState((s) => ({
      errors: [{ ...p, at: Date.now() }, ...s.errors].slice(0, 20),
    }));
  });

  unsubscribers = [off1, off2, off3];

  // 2) 对启动时已有的订阅主动拉一次报价（覆盖收盘时段场景）
  const existing = useMarketStore.getState().subscriptions.map((s) => s.symbol);
  if (existing.length > 0) {
    fetchQuotesBatch(existing).catch(() => undefined);
  }
}

export function disposeMarketStore() {
  for (const u of unsubscribers) {
    try {
      u();
    } catch {
      /* ignore */
    }
  }
  unsubscribers = [];
}
