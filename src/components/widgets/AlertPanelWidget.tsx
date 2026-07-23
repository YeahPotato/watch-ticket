/**
 * MACD 信号历史面板。
 *
 * 展示 alerts 表里的金叉/死叉记录，按业务细分类型着色和分类：
 *   - golden_entry   零轴附近水上金叉 → ✅ 建仓
 *   - golden_add     水上金叉（远离零轴）→ ✅ 加仓
 *   - golden_bounce  水下金叉 → ⚠️ 短线反弹
 *   - dead_reduce    水上死叉 → ⚠️ 减仓 / 反 T
 *   - dead_risk      水下死叉 → ❌ 风险
 *   - legacy / ""    旧数据 → 未分类
 *
 * 顶栏 Tab：全部 / 金叉 / 死叉 / 建仓 / 加仓 / 风险
 * 右上：清空 30 天前
 */

import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  Ban,
  Coins,
  TrendingDown,
  TrendingUp,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { WidgetShell } from "@/components/WidgetShell";
import { formatPrice, formatTs } from "@/lib/format";
import type { Alert } from "@/api/tauri";
import { useAlertStore } from "@/stores/alertStore";

interface Props {
  onClose?: () => void;
}

type FilterKey =
  | "all"
  | "golden"
  | "dead"
  | "golden_entry"
  | "golden_add"
  | "dead_risk";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "golden", label: "金叉" },
  { key: "dead", label: "死叉" },
  { key: "golden_entry", label: "建仓" },
  { key: "golden_add", label: "加仓" },
  { key: "dead_risk", label: "风险" },
];

interface KindMeta {
  label: string;
  hint: string;
  className: string;
  Icon: typeof ArrowUpRight;
}

const KIND_META: Record<string, KindMeta> = {
  golden_entry: {
    label: "建仓",
    hint: "零轴附近水上金叉",
    className: "text-up",
    Icon: Coins,
  },
  golden_add: {
    label: "加仓",
    hint: "上涨途中水上金叉",
    className: "text-up",
    Icon: TrendingUp,
  },
  golden_bounce: {
    label: "反弹",
    hint: "水下金叉 · 短线反弹",
    className: "text-amber-500",
    Icon: ArrowUpRight,
  },
  dead_reduce: {
    label: "减仓",
    hint: "水上死叉 · 可做反 T",
    className: "text-amber-500",
    Icon: TrendingDown,
  },
  dead_risk: {
    label: "风险",
    hint: "水下死叉 · 下跌趋势",
    className: "text-down",
    Icon: Ban,
  },
  legacy: {
    label: "历史",
    hint: "旧数据（无细分）",
    className: "text-muted-foreground",
    Icon: ArrowUpRight,
  },
};

function metaFor(a: Alert): KindMeta {
  if (a.alert_kind && KIND_META[a.alert_kind]) {
    return KIND_META[a.alert_kind];
  }
  // 无 kind 时按主类型退化
  return a.alert_type === "golden_cross"
    ? {
        label: "金叉",
        hint: "MACD 金叉",
        className: "text-up",
        Icon: ArrowUpRight,
      }
    : {
        label: "死叉",
        hint: "MACD 死叉",
        className: "text-down",
        Icon: ArrowDownRight,
      };
}

function match(a: Alert, key: FilterKey): boolean {
  switch (key) {
    case "all":
      return true;
    case "golden":
      return a.alert_type === "golden_cross";
    case "dead":
      return a.alert_type === "dead_cross";
    case "golden_entry":
    case "golden_add":
    case "dead_risk":
      return a.alert_kind === key;
  }
}

export function AlertPanelWidget({ onClose }: Props) {
  const { alerts, loading, clearOld, refresh } = useAlertStore();
  const [tab, setTab] = useState<FilterKey>("all");

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  const visible = useMemo(
    () => alerts.filter((a) => match(a, tab)),
    [alerts, tab],
  );

  return (
    <WidgetShell
      title={
        <div className="flex items-center gap-2">
          <span>MACD 信号历史</span>
          <span className="text-xs text-muted-foreground">
            共 {alerts.length} 条
          </span>
        </div>
      }
      right={
        <div
          className="flex items-center gap-1"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title="清空 30 天前记录"
            onClick={() =>
              clearOld(30).then((): void => {
                toast.success("已清理旧记录");
              })
            }
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      }
      onClose={onClose}
    >
      <div className="flex h-full flex-col">
        <div className="border-b px-2 py-1">
          <Tabs value={tab} onValueChange={(v) => setTab(v as FilterKey)}>
            <TabsList className="h-7">
              {FILTERS.map((f) => (
                <TabsTrigger key={f.key} value={f.key} className="text-xs">
                  {f.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        <div className="flex-1 overflow-auto">
          {loading && alerts.length === 0 && (
            <div className="p-4 text-center text-xs text-muted-foreground">
              加载中…
            </div>
          )}
          {!loading && visible.length === 0 && (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              无匹配记录
            </div>
          )}
          <ul className="divide-y">
            {visible.map((a) => {
              const meta = metaFor(a);
              const Icon = meta.Icon;
              return (
                <li
                  key={a.id}
                  className="flex items-center gap-2 px-3 py-2 text-sm"
                >
                  <Icon className={`h-4 w-4 shrink-0 ${meta.className}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono">{a.symbol}</span>
                      <Badge variant="outline" className="text-[10px]">
                        {a.period}
                      </Badge>
                      <span className={`text-xs font-medium ${meta.className}`}>
                        {meta.label}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {meta.hint}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatTs(a.ts)}  ·  价 {formatPrice(a.price, 4)}
                      {a.dif != null && a.dea != null && (
                        <>
                          {"  "}· DIF {a.dif.toFixed(3)}  DEA {a.dea.toFixed(3)}
                        </>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </WidgetShell>
  );
}
