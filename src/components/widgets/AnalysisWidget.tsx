/**
 * 量化分析 widget：所有自选的评级 + 建议动作一览。
 *
 * 数据源：
 *   - 现价 & 涨跌幅：marketStore（复用 quote:updated 3s 自动刷新）
 *   - 评级：analysisStore（手动刷新，首次挂载不自动跑，避免高开销）
 *
 * 交互：
 *   - 顶部"全部刷新"按钮：批量分析所有自选（3 并发限流）
 *   - 每行"刷新"图标：单票重新分析
 *   - 无评级时显示"—"和"点刷新"提示
 */

import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, RefreshCw, Loader2, Trash2, Settings2 } from "lucide-react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { WidgetShell } from "@/components/WidgetShell";
import { formatPct, formatPrice, upDownClass } from "@/lib/format";
import type { AnalysisRating, PriceSuggestion } from "@/api/tauri";
import { useAnalysisStore, type SortField } from "@/stores/analysisStore";
import { useMarketStore } from "@/stores/marketStore";

interface Props {
  onClose?: () => void;
}

const PERIOD_OPTIONS = [
  { value: "1d", label: "日线", bars: 750 },
  { value: "1w", label: "周线", bars: 156 },
  { value: "1M", label: "月线", bars: 36 },
] as const;

const MARKET_COLOR: Record<string, string> = {
  SH: "bg-red-500/10 text-red-600",
  SZ: "bg-red-500/10 text-red-600",
  BJ: "bg-red-500/10 text-red-600",
  HK: "bg-amber-500/10 text-amber-600",
  US: "bg-blue-500/10 text-blue-600",
};

/** 评级 → 展示文案 + 颜色 + 建议动作 */
const RATING_META: Record<
  AnalysisRating,
  { label: string; action: string; className: string }
> = {
  strong_buy: {
    label: "强烈买",
    action: "建仓/加仓",
    className: "text-red-700 font-semibold",
  },
  watch_buy: {
    label: "观察买",
    action: "关注买点",
    className: "text-red-500",
  },
  hold: {
    label: "持有",
    action: "持有观望",
    className: "text-muted-foreground",
  },
  watch_sell: {
    label: "观察卖",
    action: "关注减仓",
    className: "text-green-500",
  },
  strong_sell: {
    label: "强烈卖",
    action: "减仓/清仓",
    className: "text-green-700 font-semibold",
  },
};

function timeAgo(ts: number): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}秒前`;
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  return `${Math.floor(diff / 3600_000)}小时前`;
}

/** 计算目标价相对现价的偏离百分比。正 = 高于现价 */
function deviationPct(target: number, current: number | null | undefined): string {
  if (current == null || current === 0 || !Number.isFinite(target)) return "";
  const pct = ((target - current) / current) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

/** 建议价单元格（主显示触发价，带 tooltip 完整明细：技术位 + 三档折价 + 均价对比） */
function PriceCell({
  side,
  suggestion,
  currentPrice,
  avgPrice,
  avgDeviationPct,
}: {
  side: "buy" | "sell";
  suggestion: PriceSuggestion | null;
  currentPrice: number | null | undefined;
  avgPrice?: number | null;
  avgDeviationPct?: number | null;
}) {
  if (!suggestion) return <span className="text-muted-foreground">—</span>;
  const { trigger, advised, support, refs, discount_tiers } = suggestion;
  const colorClass = side === "buy" ? "text-red-600" : "text-green-600";
  const hasTiers = discount_tiers.every((n) => Number.isFinite(n));
  // 档位越深颜色越深
  const shadeClasses =
    side === "buy"
      ? ["text-red-400", "text-red-600", "text-red-800"]
      : ["text-green-400", "text-green-600", "text-green-800"];
  const pctLabels =
    side === "buy" ? ["-5%", "-8%", "-10%"] : ["+5%", "+8%", "+10%"];

  return (
    <Tooltip delayDuration={100}>
      <TooltipTrigger asChild>
        <div className={`cursor-help font-mono ${colorClass}`}>
          <div>{formatPrice(trigger)}</div>
          <div className="text-[10px] text-muted-foreground">
            {deviationPct(trigger, currentPrice)}
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-left">
        <div className="font-semibold mb-1">
          {side === "buy" ? "建议加仓价" : "建议减仓价"}明细
        </div>
        <div className="space-y-0.5 font-mono">
          <div>
            触发价：{formatPrice(trigger)}
            <span className="ml-2 text-[10px] opacity-70">（较易触及）</span>
          </div>
          <div>
            保守价：{formatPrice(advised)}
            <span className="ml-2 text-[10px] opacity-70">（更远离现价）</span>
          </div>

          <div className="mt-1 pt-1 border-t border-white/20">
            {side === "buy" ? "支撑位" : "压力位"}：{formatPrice(support)}
            <span className="ml-2 text-[10px] opacity-70">（下列三者中位数）</span>
          </div>
          {refs.boll != null && (
            <div className="ml-2 text-[10px] opacity-70">
              BOLL {side === "buy" ? "下轨" : "上轨"}：{formatPrice(refs.boll)}
            </div>
          )}
          {refs.ema20 != null && (
            <div className="ml-2 text-[10px] opacity-70">
              EMA20：{formatPrice(refs.ema20)}
            </div>
          )}
          <div className="ml-2 text-[10px] opacity-70">
            20日{side === "buy" ? "最低" : "最高"}：
            {formatPrice(refs.extreme_20d)}
          </div>

          {hasTiers && (
            <>
              <div className="mt-1 pt-1 border-t border-white/20 opacity-90">
                现价{side === "buy" ? "折价" : "溢价"}三档
              </div>
              {discount_tiers.map((t, i) => (
                <div key={i} className="ml-2 text-[11px]">
                  <span className={shadeClasses[i]}>{pctLabels[i]}</span>:{" "}
                  {formatPrice(t)}
                  <span className="ml-2 text-[10px] opacity-70">
                    （距现价 {deviationPct(t, currentPrice)}）
                  </span>
                </div>
              ))}
            </>
          )}

          {avgPrice != null && (
            <div className="mt-1 pt-1 border-t border-white/20 opacity-90 text-[10px]">
              3 年均价：{formatPrice(avgPrice)}
              {avgDeviationPct != null && (
                <span className="ml-2 opacity-70">
                  （现价距均价 {avgDeviationPct >= 0 ? "+" : ""}
                  {avgDeviationPct.toFixed(2)}%）
                </span>
              )}
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * 可排序的表格行：包裹 useSortable，把 transform/listeners 应用到 <TableRow>。
 * 整行都作为拖拽触发区，但通过 PointerSensor 的 5px 距离阈值避免误触发单击。
 */
function SortableAnalysisRow({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    // 拖拽时给一个明显的光标提示；listeners 挂在 <tr> 上，整行可拖
    cursor: isDragging ? "grabbing" : "grab",
  };
  return (
    <TableRow ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {children}
    </TableRow>
  );
}

/** 备注单元格：可编辑输入框，失焦保存；Enter 也保存，Esc 取消 */
function NoteCell({ symbol, value }: { symbol: string; value: string }) {
  const updateNote = useMarketStore((s) => s.updateNote);
  const [draft, setDraft] = useState(value);

  // 当外部 value 变化（如后端 push 或切换用户）时同步本地 draft
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = () => {
    if (draft === value) return;
    updateNote(symbol, draft).catch(() => {
      // 保存失败：回滚到旧值
      setDraft(value);
    });
  };

  return (
    <input
      className="w-full min-w-[6rem] max-w-[16rem] rounded border border-transparent bg-transparent px-1 py-0.5 text-xs hover:border-input focus:border-input focus:outline-none focus:ring-1 focus:ring-ring"
      value={draft}
      placeholder="点击输入"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          (e.target as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          setDraft(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

export function AnalysisWidget({ onClose }: Props) {
  const subscriptions = useMarketStore((s) => s.subscriptions);
  const quotes = useMarketStore((s) => s.quotes);
  const reports = useAnalysisStore((s) => s.reports);
  const batchLoading = useAnalysisStore((s) => s.batchLoading);
  const refreshOne = useAnalysisStore((s) => s.refreshOne);
  const refreshAll = useAnalysisStore((s) => s.refreshAll);
  const autoRefresh = useAnalysisStore((s) => s.autoRefresh);
  const setAutoRefresh = useAnalysisStore((s) => s.setAutoRefresh);
  const setAutoRefreshParams = useAnalysisStore(
    (s) => s.setAutoRefreshParams,
  );
  const register = useAnalysisStore((s) => s.register);
  const unregister = useAnalysisStore((s) => s.unregister);
  const sort = useAnalysisStore((s) => s.sort);
  const cycleSort = useAnalysisStore((s) => s.cycleSort);
  const hidden = useAnalysisStore((s) => s.hidden);
  const hide = useAnalysisStore((s) => s.hide);
  const unhide = useAnalysisStore((s) => s.unhide);
  const unhideAll = useAnalysisStore((s) => s.unhideAll);
  const manualOrder = useAnalysisStore((s) => s.manualOrder);
  const applyManualOrder = useAnalysisStore((s) => s.applyManualOrder);

  const [period, setPeriod] = useState<"1d" | "1w" | "1M">("1d");

  const currentPeriod = useMemo(
    () => PERIOD_OPTIONS.find((p) => p.value === period)!,
    [period],
  );

  /** 先过滤掉用户在量化分析里隐藏的票（不动 subscriptions 本身） */
  const visibleSubscriptions = useMemo(() => {
    if (hidden.length === 0) return subscriptions;
    const hidSet = new Set(hidden);
    return subscriptions.filter((s) => !hidSet.has(s.symbol));
  }, [subscriptions, hidden]);

  /** 已隐藏但仍在自选中的票（用于齿轮菜单展示 + 恢复） */
  const hiddenSubscriptions = useMemo(() => {
    if (hidden.length === 0) return [];
    const hidSet = new Set(hidden);
    return subscriptions.filter((s) => hidSet.has(s.symbol));
  }, [subscriptions, hidden]);

  /**
   * 按 sort 状态排序 visibleSubscriptions。
   * null 值统一沉底（无论升降），保持相对顺序稳定。
   * manual 模式：按 manualOrder 数组顺序，未在其中的 symbol 沉底。
   */
  const sortedSubscriptions = useMemo(() => {
    if (!sort) return visibleSubscriptions;
    // manual 模式单独处理：直接按数组下标排
    if (sort.field === "manual") {
      const idxMap = new Map(manualOrder.map((sym, i) => [sym, i]));
      return [...visibleSubscriptions].sort((a, b) => {
        const ia = idxMap.get(a.symbol);
        const ib = idxMap.get(b.symbol);
        if (ia == null && ib == null) return 0;
        if (ia == null) return 1;
        if (ib == null) return -1;
        return ia - ib;
      });
    }
    const dir = sort.direction === "asc" ? 1 : -1;

    const getValue = (sub: (typeof subscriptions)[number]): string | number | null => {
      const q = quotes[sub.symbol];
      const entry = reports[sub.symbol];
      switch (sort.field) {
        case "symbol":
          return sub.symbol;
        case "name":
          return q?.name ?? sub.name ?? sub.symbol;
        case "price":
          return q?.price ?? null;
        case "change_pct":
          return q?.change_pct ?? null;
        case "composite_score":
          return entry?.report?.composite_score ?? null;
        case "updated_at":
          return entry?.updatedAt ? entry.updatedAt : null;
        case "dividend_per_share":
          return entry?.dividend?.dividend_per_share ?? null;
        case "dividend_yield": {
          // 前端计算：分红 / 现价，×100 得到百分比
          const div = entry?.dividend?.dividend_per_share;
          const price = q?.price;
          if (div == null || price == null || price <= 0) return null;
          return (div / price) * 100;
        }
        case "manual":
          // 已在上方分支处理，兜底
          return null;
      }
    };

    return [...visibleSubscriptions].sort((a, b) => {
      const va = getValue(a);
      const vb = getValue(b);
      // null 值统一沉底
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "string" && typeof vb === "string") {
        return va.localeCompare(vb, "zh-CN") * dir;
      }
      return ((va as number) - (vb as number)) * dir;
    });
  }, [visibleSubscriptions, subscriptions, sort, quotes, reports, manualOrder]);

  // 挂载/卸载：注册引用计数，管理全局定时器生命周期
  useEffect(() => {
    register();
    return () => {
      unregister();
    };
  }, [register, unregister]);

  // 周期变化时把参数同步给定时器（下一次 tick 使用新参数）
  useEffect(() => {
    setAutoRefreshParams(period, currentPeriod.bars);
  }, [period, currentPeriod.bars, setAutoRefreshParams]);

  const handleRefreshAll = () => {
    // 只刷新可见的票（隐藏的不参与，避免白跑）
    const symbols = visibleSubscriptions.map((s) => s.symbol);
    refreshAll(symbols, period, currentPeriod.bars).catch(() => undefined);
  };

  const handleRefreshOne = (symbol: string) => {
    refreshOne(symbol, period, currentPeriod.bars).catch(() => undefined);
  };

  // ==================== 行拖拽排序 ====================
  // PointerSensor 用 5px 距离阈值，避免 shadcn Button/输入框的单击被误判为拖拽
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    // 当前排序视图下的 symbol 序列（即用户实际看到的顺序）
    const currentVisibleOrder = sortedSubscriptions.map((s) => s.symbol);
    const oldIndex = currentVisibleOrder.indexOf(String(active.id));
    const newIndex = currentVisibleOrder.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;

    const reorderedVisible = arrayMove(currentVisibleOrder, oldIndex, newIndex);

    // 合并到完整 manualOrder：
    // 1. 隐藏的票保持原位（在 manualOrder 中已存在的位置）
    // 2. 未在 manualOrder 里的新自选追加末尾
    // 简化策略：
    //   allSymbols = subscriptions 全集
    //   newOrder = reorderedVisible + (allSymbols - reorderedVisible 里的隐藏部分，按其在原 manualOrder 中的位置补齐)
    const allSymbols = subscriptions.map((s) => s.symbol);
    const reorderedSet = new Set(reorderedVisible);
    const remaining = allSymbols.filter((sym) => !reorderedSet.has(sym));
    // remaining（隐藏 + 未在原 manualOrder 的新票）按原 manualOrder 的相对位置排；不在其中的追加末尾
    remaining.sort((a, b) => {
      const ia = manualOrder.indexOf(a);
      const ib = manualOrder.indexOf(b);
      if (ia === -1 && ib === -1) return 0;
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
    const nextOrder = [...reorderedVisible, ...remaining];

    applyManualOrder(nextOrder);
  };

  /** 可排序表头小组件 */
  const SortableHead = ({
    field,
    children,
    align = "left",
  }: {
    field: SortField;
    children: React.ReactNode;
    align?: "left" | "right";
  }) => {
    const active = sort?.field === field;
    const dir = active ? sort!.direction : null;
    return (
      <TableHead
        className={`cursor-pointer select-none hover:bg-muted/50 ${
          align === "right" ? "text-right" : ""
        }`}
        onClick={() => cycleSort(field)}
      >
        <span
          className={`inline-flex items-center gap-1 ${
            align === "right" ? "flex-row-reverse" : ""
          }`}
        >
          {children}
          {active ? (
            dir === "asc" ? (
              <ArrowUp className="h-3 w-3" />
            ) : (
              <ArrowDown className="h-3 w-3" />
            )
          ) : (
            <span className="h-3 w-3 opacity-20">
              <ArrowDown className="h-3 w-3" />
            </span>
          )}
        </span>
      </TableHead>
    );
  };

  const title = (
    <div className="flex items-center gap-2">
      <span>
        量化分析（
        {hidden.length > 0
          ? `${visibleSubscriptions.length}/${subscriptions.length}`
          : subscriptions.length}
        ）
      </span>
      <Select
        value={period}
        onValueChange={(v) => setPeriod(v as typeof period)}
      >
        <SelectTrigger className="h-6 w-20 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PERIOD_OPTIONS.map((p) => (
            <SelectItem key={p.value} value={p.value}>
              {p.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        variant="outline"
        className="h-6 px-2"
        onClick={handleRefreshAll}
        disabled={batchLoading || visibleSubscriptions.length === 0}
      >
        {batchLoading ? (
          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
        ) : (
          <RefreshCw className="mr-1 h-3 w-3" />
        )}
        全部刷新
      </Button>
      {hiddenSubscriptions.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs text-muted-foreground"
              title={`${hiddenSubscriptions.length} 项已隐藏，点击恢复`}
            >
              <Settings2 className="mr-1 h-3 w-3" />
              已隐藏 {hiddenSubscriptions.length}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 w-64 overflow-auto">
            <DropdownMenuLabel className="flex items-center justify-between">
              <span>已隐藏（点击恢复）</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  unhideAll();
                }}
              >
                全部恢复
              </Button>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {hiddenSubscriptions.map((sub) => (
              <DropdownMenuItem
                key={sub.symbol}
                className="flex items-center justify-between gap-2 text-xs"
                onSelect={(e) => {
                  // 阻止默认关闭菜单，方便用户批量恢复
                  e.preventDefault();
                  unhide(sub.symbol);
                }}
              >
                <span className="font-mono">
                  {sub.symbol.split(":")[1] ?? sub.symbol}
                </span>
                <span className="truncate text-muted-foreground">
                  {sub.name ?? "-"}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {sort?.field === "manual" && (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs text-muted-foreground"
          onClick={() => cycleSort("composite_score")}
          title="已启用手动排序，点击恢复默认（评级降序）"
        >
          手动排序中 · 恢复
        </Button>
      )}
      <label
        className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer select-none"
        title="交易时段内每分钟自动刷新"
      >
        <Switch
          checked={autoRefresh}
          onCheckedChange={setAutoRefresh}
          className="scale-75"
        />
        自动
      </label>
    </div>
  );

  return (
    <TooltipProvider delayDuration={100}>
      <WidgetShell title={title} onClose={onClose}>
        {subscriptions.length === 0 ? (
          <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
            尚无自选。请先添加自选后再来做量化分析。
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">市场</TableHead>
                  <SortableHead field="symbol">代码</SortableHead>
                  <SortableHead field="name">名称</SortableHead>
                  <SortableHead field="price" align="right">
                    现价
                  </SortableHead>
                  <SortableHead field="change_pct" align="right">
                    涨跌幅
                  </SortableHead>
                  <SortableHead field="composite_score">评级</SortableHead>
                  <TableHead>建议动作</TableHead>
                  <TableHead className="text-right">建议买入价</TableHead>
                  <TableHead className="text-right">建议卖出价</TableHead>
                  <SortableHead field="dividend_per_share" align="right">
                    每股分红
                  </SortableHead>
                  <SortableHead field="dividend_yield" align="right">
                    股息率
                  </SortableHead>
                  <TableHead>备注</TableHead>
                  <SortableHead field="updated_at">分析时间</SortableHead>
                  <TableHead className="w-20"></TableHead>
                </TableRow>
              </TableHeader>
              <SortableContext
                items={sortedSubscriptions.map((s) => s.symbol)}
                strategy={verticalListSortingStrategy}
              >
                <TableBody>
                  {sortedSubscriptions.map((sub) => {
                    const q = quotes[sub.symbol];
                    const entry = reports[sub.symbol];
                    const report = entry?.report;
                    const meta = report ? RATING_META[report.rating] : null;
                    const loading = entry?.loading ?? false;
                    return (
                      <SortableAnalysisRow key={sub.symbol} id={sub.symbol}>
                        <TableCell>
                          <Badge
                            className={
                              MARKET_COLOR[sub.market] ??
                              "bg-muted text-muted-foreground"
                            }
                          >
                            {sub.market}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-mono">
                          {sub.symbol.split(":")[1] ?? sub.symbol}
                        </TableCell>
                        <TableCell>{q?.name ?? sub.name ?? "-"}</TableCell>
                        <TableCell className="text-right font-mono">
                          {formatPrice(q?.price)}
                        </TableCell>
                        <TableCell
                          className={`text-right font-mono ${upDownClass(q?.change_pct)}`}
                        >
                          {formatPct(q?.change_pct)}
                        </TableCell>
                        <TableCell>
                          {meta ? (
                            <span className={meta.className}>{meta.label}</span>
                          ) : entry?.error ? (
                            <span
                              className="text-xs text-muted-foreground"
                              title={entry.error}
                            >
                              失败
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {meta ? (
                            <span className={meta.className}>{meta.action}</span>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              {loading ? "分析中…" : "点右侧刷新"}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="inline-block text-right">
                            <PriceCell
                              side="buy"
                              suggestion={report?.buy_suggestion ?? null}
                              currentPrice={q?.price}
                              avgPrice={report?.avg_price}
                              avgDeviationPct={report?.avg_deviation_pct}
                            />
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="inline-block text-right">
                            <PriceCell
                              side="sell"
                              suggestion={report?.sell_suggestion ?? null}
                              currentPrice={q?.price}
                              avgPrice={report?.avg_price}
                              avgDeviationPct={report?.avg_deviation_pct}
                            />
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {entry?.dividend?.dividend_per_share != null ? (
                            <Tooltip delayDuration={100}>
                              <TooltipTrigger asChild>
                                <span className="cursor-help">
                                  {formatPrice(entry.dividend.dividend_per_share)}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-xs text-left">
                                <div className="font-semibold mb-1">
                                  过去 12 个月分红明细
                                  {entry.dividend.end_date ? (
                                    <span className="ml-1 text-[10px] opacity-70">
                                      （截至 {entry.dividend.end_date}）
                                    </span>
                                  ) : null}
                                </div>
                                <div className="space-y-0.5 font-mono">
                                  {entry.dividend.records.length === 0 ? (
                                    <div className="text-[10px] opacity-70">无明细</div>
                                  ) : (
                                    entry.dividend.records.map((rec, i) => (
                                      <div key={i}>
                                        {rec.ex_date ?? "?"}: {formatPrice(rec.cash_per_share)}
                                        {rec.note ? (
                                          <span className="ml-1 text-[10px] opacity-70">
                                            {rec.note}
                                          </span>
                                        ) : null}
                                      </div>
                                    ))
                                  )}
                                  <div className="mt-1 pt-1 border-t border-white/20 text-[10px] opacity-70">
                                    合计：{formatPrice(entry.dividend.dividend_per_share)} / 股
                                  </div>
                                </div>
                              </TooltipContent>
                            </Tooltip>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {(() => {
                            const div = entry?.dividend?.dividend_per_share;
                            const price = q?.price;
                            if (div == null || price == null || price <= 0) {
                              return <span className="text-muted-foreground">—</span>;
                            }
                            const yieldPct = (div / price) * 100;
                            return (
                              <span
                                className={
                                  yieldPct >= 5
                                    ? "text-red-600 font-semibold"
                                    : yieldPct >= 3
                                      ? "text-red-500"
                                      : ""
                                }
                              >
                                {yieldPct.toFixed(2)}%
                              </span>
                            );
                          })()}
                        </TableCell>
                        <TableCell>
                          <NoteCell
                            symbol={sub.symbol}
                            value={sub.note ?? ""}
                          />
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {entry?.updatedAt ? timeAgo(entry.updatedAt) : "-"}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-0.5">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => handleRefreshOne(sub.symbol)}
                              disabled={loading}
                              title="刷新此票"
                            >
                              {loading ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <RefreshCw className="h-3.5 w-3.5" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-destructive"
                              onClick={() => hide(sub.symbol)}
                              title="从量化分析里隐藏（不影响自选）"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </SortableAnalysisRow>
                    );
                  })}
                </TableBody>
              </SortableContext>
            </Table>
          </DndContext>
        )}
      </WidgetShell>
    </TooltipProvider>
  );
}
