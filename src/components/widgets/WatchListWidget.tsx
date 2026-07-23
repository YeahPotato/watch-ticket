/**
 * 自选列表 widget：表格 + 实时报价 + 删除。
 * 数据源：marketStore（订阅列表 + quote:updated 事件）
 */

import { Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { WidgetShell } from "@/components/WidgetShell";
import { formatPct, formatPrice, upDownClass } from "@/lib/format";
import { useMarketStore } from "@/stores/marketStore";

interface Props {
  onClose?: () => void;
  onFocusSymbol?: (symbol: string) => void;
}

const MARKET_COLOR: Record<string, string> = {
  SH: "bg-red-500/10 text-red-600",
  SZ: "bg-red-500/10 text-red-600",
  BJ: "bg-red-500/10 text-red-600",
  HK: "bg-amber-500/10 text-amber-600",
  US: "bg-blue-500/10 text-blue-600",
};

export function WatchListWidget({ onClose, onFocusSymbol }: Props) {
  const subscriptions = useMarketStore((s) => s.subscriptions);
  const quotes = useMarketStore((s) => s.quotes);
  const removeSymbol = useMarketStore((s) => s.removeSymbol);

  return (
    <WidgetShell title={`自选（${subscriptions.length}）`} onClose={onClose}>
      {subscriptions.length === 0 ? (
        <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
          尚无自选，点击顶部"添加自选"按钮添加。
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">市场</TableHead>
              <TableHead>代码</TableHead>
              <TableHead>名称</TableHead>
              <TableHead className="text-right">现价</TableHead>
              <TableHead className="text-right">涨跌幅</TableHead>
              <TableHead>更新时间</TableHead>
              <TableHead className="w-16"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {subscriptions.map((sub) => {
              const q = quotes[sub.symbol];
              return (
                <TableRow
                  key={sub.symbol}
                  className="cursor-pointer"
                  onClick={() => onFocusSymbol?.(sub.symbol)}
                >
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
                    {sub.symbol.split(":")[1]}
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
                  <TableCell className="text-xs text-muted-foreground">
                    {q?.ts ?? "-"}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeSymbol(sub.symbol).catch(() => undefined);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </WidgetShell>
  );
}
