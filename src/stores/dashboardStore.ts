/**
 * 仪表盘布局与 widget 列表 store。
 *
 * 持久化：debounce 500ms 写到 SQLite settings 表的 dashboard_layout 键。
 */

import { v4 as uuid } from "uuid";
import { create } from "zustand";

import { api } from "@/api/tauri";

export type WidgetType = "watchlist" | "intraday" | "alerts" | "analysis";

export interface WidgetItem {
  id: string;
  type: WidgetType;
  /** 关联的股票代码（kline/intraday 必需） */
  symbol?: string;
  /** K 线周期（kline 用） */
  period?: string;
  /** 图表参数（预留） */
  limit?: number;
  /** grid 布局 */
  x: number;
  y: number;
  w: number;
  h: number;
}

interface DashboardState {
  widgets: WidgetItem[];
  loaded: boolean;
  loading: boolean;

  load: () => Promise<void>;
  addWidget: (partial: Omit<WidgetItem, "id" | "x" | "y" | "w" | "h"> & Partial<Pick<WidgetItem, "x" | "y" | "w" | "h">>) => void;
  removeWidget: (id: string) => void;
  updateWidget: (id: string, patch: Partial<WidgetItem>) => void;
  /** react-grid-layout onLayoutChange 回调 */
  applyLayout: (layout: Array<{ i: string; x: number; y: number; w: number; h: number }>) => void;
  reset: () => void;
}

const STORAGE_KEY = "dashboard_layout";

const DEFAULT_WIDGETS: WidgetItem[] = [
  {
    id: uuid(),
    type: "watchlist",
    x: 0,
    y: 0,
    w: 12,
    h: 8,
  },
];

// 写入 debounce
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(widgets: WidgetItem[]) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api
      .updateSetting(STORAGE_KEY, JSON.stringify(widgets))
      .catch((e) => console.warn("保存布局失败", e));
  }, 500);
}

/** 找一个不与现有 widget 重叠的初始位置（简单策略：放到当前最大 y+h 之下） */
function nextPosition(widgets: WidgetItem[], w: number, h: number): { x: number; y: number; w: number; h: number } {
  const maxY = widgets.reduce((acc, it) => Math.max(acc, it.y + it.h), 0);
  return { x: 0, y: maxY, w, h };
}

const DEFAULT_SIZE: Record<WidgetType, { w: number; h: number }> = {
  watchlist: { w: 12, h: 8 },
  intraday: { w: 12, h: 12 },
  alerts: { w: 6, h: 6 },
  analysis: { w: 12, h: 8 },
};

export const useDashboardStore = create<DashboardState>((set, get) => ({
  widgets: [],
  loaded: false,
  loading: false,

  load: async () => {
    set({ loading: true });
    try {
      const raw = await api.getSetting(STORAGE_KEY);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as WidgetItem[];
          // 过滤掉已废弃的 widget 类型（如老版本保存的 kline）
          const allowed: WidgetType[] = ["watchlist", "intraday", "alerts", "analysis"];
          const cleaned = Array.isArray(parsed)
            ? parsed.filter(
                (w) =>
                  w &&
                  w.id &&
                  w.type &&
                  allowed.includes(w.type as WidgetType),
              )
            : null;
          if (cleaned && cleaned.length > 0) {
            set({ widgets: cleaned, loaded: true });
            // 若清理掉了旧 widget，回写一次
            if (cleaned.length !== (parsed as WidgetItem[]).length) {
              scheduleSave(cleaned);
            }
            return;
          }
        } catch {
          // fallthrough → default
        }
      }
      set({ widgets: DEFAULT_WIDGETS, loaded: true });
      scheduleSave(DEFAULT_WIDGETS);
    } finally {
      set({ loading: false });
    }
  },

  addWidget: (partial) => {
    const size = DEFAULT_SIZE[partial.type];
    const pos = nextPosition(get().widgets, partial.w ?? size.w, partial.h ?? size.h);
    const item: WidgetItem = {
      id: uuid(),
      type: partial.type,
      symbol: partial.symbol,
      period: partial.period,
      limit: partial.limit,
      x: partial.x ?? pos.x,
      y: partial.y ?? pos.y,
      w: partial.w ?? size.w,
      h: partial.h ?? size.h,
    };
    const next = [...get().widgets, item];
    set({ widgets: next });
    scheduleSave(next);
  },

  removeWidget: (id) => {
    const next = get().widgets.filter((w) => w.id !== id);
    set({ widgets: next });
    scheduleSave(next);
  },

  updateWidget: (id, patch) => {
    const next = get().widgets.map((w) => (w.id === id ? { ...w, ...patch } : w));
    set({ widgets: next });
    scheduleSave(next);
  },

  applyLayout: (layout) => {
    const map = new Map(layout.map((l) => [l.i, l]));
    const next = get().widgets.map((w) => {
      const l = map.get(w.id);
      return l ? { ...w, x: l.x, y: l.y, w: l.w, h: l.h } : w;
    });
    // 避免布局与旧数组浅相等
    set({ widgets: next });
    scheduleSave(next);
  },

  reset: () => {
    const next = [...DEFAULT_WIDGETS];
    set({ widgets: next });
    scheduleSave(next);
  },
}));
