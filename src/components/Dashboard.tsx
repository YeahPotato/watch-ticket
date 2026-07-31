/**
 * 仪表盘容器（react-grid-layout）。
 */

import { useEffect, useMemo, useState } from "react";
import { Responsive, WidthProvider, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

import {
  useDashboardStore,
  type WidgetItem,
} from "@/stores/dashboardStore";
import { WatchListWidget } from "@/components/widgets/WatchListWidget";
import { IntradayChartWidget } from "@/components/widgets/IntradayChartWidget";
import { AlertPanelWidget } from "@/components/widgets/AlertPanelWidget";
import { AnalysisWidget } from "@/components/widgets/AnalysisWidget";

const ResponsiveGridLayout = WidthProvider(Responsive);

function renderWidget(
  w: WidgetItem,
  removeWidget: (id: string) => void,
  _updateWidget: (id: string, patch: Partial<WidgetItem>) => void,
  onFocusSymbol: (symbol: string) => void,
) {
  const onClose = () => removeWidget(w.id);
  switch (w.type) {
    case "watchlist":
      return (
        <WatchListWidget onClose={onClose} onFocusSymbol={onFocusSymbol} />
      );
    case "intraday":
      return w.symbol ? (
        <IntradayChartWidget symbol={w.symbol} onClose={onClose} />
      ) : (
        <MissingSymbol onClose={onClose} />
      );
    case "alerts":
      return <AlertPanelWidget onClose={onClose} />;
    case "analysis":
      return <AnalysisWidget onClose={onClose} />;
    default:
      return null;
  }
}

function MissingSymbol({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
      未指定股票
      <button
        onClick={onClose}
        className="text-xs underline"
        type="button"
      >
        关闭
      </button>
    </div>
  );
}

export function Dashboard() {
  const widgets = useDashboardStore((s) => s.widgets);
  const applyLayout = useDashboardStore((s) => s.applyLayout);
  const removeWidget = useDashboardStore((s) => s.removeWidget);
  const updateWidget = useDashboardStore((s) => s.updateWidget);
  const [, setFocus] = useState<string | null>(null);

  const layouts = useMemo(() => {
    const l: Layout[] = widgets.map((w) => ({
      i: w.id,
      x: w.x,
      y: w.y,
      w: w.w,
      h: w.h,
      minW:
        w.type === "watchlist" || w.type === "analysis"
          ? 6
          : w.type === "alerts"
            ? 3
            : 6,
      minH:
        w.type === "intraday"
          ? 8
          : 4,
    }));
    return { lg: l, md: l, sm: l };
  }, [widgets]);

  useEffect(() => {
    useDashboardStore.getState().load();
  }, []);

  if (widgets.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        暂无组件。点击右上角"添加 Widget"开始。
      </div>
    );
  }

  return (
    <ResponsiveGridLayout
      className="layout"
      layouts={layouts}
      breakpoints={{ lg: 1200, md: 996, sm: 768 }}
      cols={{ lg: 12, md: 12, sm: 12 }}
      rowHeight={40}
      draggableHandle=".widget-drag-handle"
      draggableCancel="button,input,select,textarea,label,a,[role='combobox'],[role='button']"
      onLayoutChange={(current) => applyLayout(current)}
      margin={[10, 10]}
      containerPadding={[0, 0]}
      isResizable={true}
      resizeHandles={["se"]}
    >
      {widgets.map((w) => (
        <div key={w.id} className="relative h-full">
          {renderWidget(w, removeWidget, updateWidget, (s) => setFocus(s))}
        </div>
      ))}
    </ResponsiveGridLayout>
  );
}
