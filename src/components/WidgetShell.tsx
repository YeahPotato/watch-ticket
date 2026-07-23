/**
 * Widget 统一外壳：标题栏（拖拽把手）+ 关闭按钮 + 内容区。
 *
 * 拖拽把手只作用在 .widget-drag-handle 元素上，避免拖到内部图表触发布局改动。
 * 内容区默认可滚动（表格/列表类）；图表类 widget 应传 contentClassName="overflow-hidden"
 * 避免因子元素高度计算差异触发滚动条。
 */

import { GripVertical, X } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface WidgetShellProps {
  title: ReactNode;
  onClose?: () => void;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  /** 覆盖内容区样式；默认 "flex-1 overflow-auto" */
  contentClassName?: string;
}

export function WidgetShell({
  title,
  onClose,
  right,
  children,
  className,
  contentClassName,
}: WidgetShellProps) {
  return (
    <div
      className={cn(
        "flex h-full flex-col overflow-hidden rounded-md border bg-card text-card-foreground shadow-sm",
        className,
      )}
    >
      <div className="widget-drag-handle flex cursor-move items-center gap-1 border-b bg-muted/40 px-2 py-1.5">
        <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
        <div className="flex-1 truncate text-xs font-medium">{title}</div>
        <div
          className="flex items-center gap-1"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {right}
          {onClose && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={onClose}
              title="移除"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
      <div
        className={cn("min-h-0 flex-1 overflow-auto", contentClassName)}
      >
        {children}
      </div>
    </div>
  );
}
