/**
 * "添加 widget" 下拉菜单。
 * 根据当前订阅列表让用户选择要展示的 symbol。
 */

import { useState } from "react";
import { Activity, Bell, LayoutGrid } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDashboardStore } from "@/stores/dashboardStore";
import { useMarketStore } from "@/stores/marketStore";

export function AddWidgetMenu() {
  const subscriptions = useMarketStore((s) => s.subscriptions);
  const addWidget = useDashboardStore((s) => s.addWidget);
  const [open, setOpen] = useState(false);

  const hasSubs = subscriptions.length > 0;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <LayoutGrid className="mr-2 h-4 w-4" />
          添加 Widget
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>选择组件类型</DropdownMenuLabel>
        <DropdownMenuSeparator />

        <DropdownMenuItem
          onClick={() => addWidget({ type: "watchlist" })}
        >
          <LayoutGrid className="mr-2 h-4 w-4" />
          自选列表
        </DropdownMenuItem>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={!hasSubs}>
            <Activity className="mr-2 h-4 w-4" />
            分时图（含 MACD）
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {subscriptions.map((s) => (
              <DropdownMenuItem
                key={s.symbol}
                onClick={() => addWidget({ type: "intraday", symbol: s.symbol })}
              >
                <span className="font-mono">{s.symbol}</span>
                {s.name && (
                  <span className="ml-2 text-muted-foreground">{s.name}</span>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuItem onClick={() => addWidget({ type: "alerts" })}>
          <Bell className="mr-2 h-4 w-4" />
          告警面板
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
