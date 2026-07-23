/**
 * 添加自选弹窗。
 *
 * 两种方式：
 *   1. 直接输入 MARKET:CODE
 *   2. 搜索关键字（依赖 sidecar，需要网络能到东财）
 */

import { useState } from "react";
import { Loader2, Search } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { api, type RustError, type SearchItem } from "@/api/tauri";
import { useMarketStore } from "@/stores/marketStore";

function fmtErr(e: unknown): string {
  const err = e as RustError | { message?: string };
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    return `[${(err as RustError).code}] ${(err as RustError).message}`;
  }
  return String(e);
}

interface Props {
  trigger: React.ReactNode;
}

export function AddSymbolDialog({ trigger }: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"direct" | "search">("direct");
  const addSymbol = useMarketStore((s) => s.addSymbol);

  // direct
  const [code, setCode] = useState("");
  const [periods, setPeriods] = useState("1d");
  const [adding, setAdding] = useState(false);

  // search
  const [keyword, setKeyword] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchItem[]>([]);

  const handleAddDirect = async () => {
    const raw = code.trim().toUpperCase();
    if (!raw) return;
    if (!raw.includes(":")) {
      toast.error("格式应为 MARKET:CODE，如 SH:600519");
      return;
    }
    setAdding(true);
    try {
      await addSymbol(raw, undefined, periods || "1d");
      toast.success(`已订阅 ${raw}`);
      setCode("");
      setOpen(false);
    } catch (e) {
      toast.error("添加失败：" + fmtErr(e));
    } finally {
      setAdding(false);
    }
  };

  const handleSearch = async () => {
    const kw = keyword.trim();
    if (!kw) return;
    setSearching(true);
    try {
      const list = await api.searchSymbol(kw, 30);
      setResults(list);
      if (list.length === 0) toast.info("未搜到相关标的");
    } catch (e) {
      toast.error("搜索失败：" + fmtErr(e));
    } finally {
      setSearching(false);
    }
  };

  const handleAddResult = async (item: SearchItem) => {
    try {
      await addSymbol(item.symbol, item.name, "1d");
      toast.success(`已订阅 ${item.symbol} · ${item.name}`);
      setOpen(false);
    } catch (e) {
      toast.error("添加失败：" + fmtErr(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>添加自选</DialogTitle>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as "direct" | "search")}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="direct">直接输入</TabsTrigger>
            <TabsTrigger value="search">搜索</TabsTrigger>
          </TabsList>

          <TabsContent value="direct" className="space-y-3 pt-4">
            <Input
              placeholder="MARKET:CODE，如 SH:600519 / HK:00700 / US:AAPL"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAddDirect();
              }}
              autoFocus
            />
            <Input
              placeholder="K 线周期，逗号分隔（默认 1d）"
              value={periods}
              onChange={(e) => setPeriods(e.target.value)}
            />
            <div className="flex justify-end">
              <Button onClick={handleAddDirect} disabled={adding}>
                {adding && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                添加
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              市场前缀：SH / SZ / BJ / HK / US
            </p>
          </TabsContent>

          <TabsContent value="search" className="space-y-3 pt-4">
            <div className="flex gap-2">
              <Input
                placeholder="关键字，如 茅台 / 腾讯 / AAPL"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSearch();
                }}
                autoFocus
              />
              <Button onClick={handleSearch} disabled={searching}>
                {searching ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Search className="mr-2 h-4 w-4" />
                )}
                搜索
              </Button>
            </div>
            {results.length > 0 && (
              <div className="max-h-64 overflow-auto rounded-md border">
                {results.map((r) => (
                  <button
                    key={r.symbol}
                    type="button"
                    onClick={() => handleAddResult(r)}
                    className="flex w-full items-center justify-between border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-muted/50"
                  >
                    <span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {r.market}
                      </span>{" "}
                      <span className="font-mono">{r.symbol.split(":")[1]}</span>
                    </span>
                    <span className="text-muted-foreground">{r.name}</span>
                  </button>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              搜索依赖数据源（东财），若网络不通请用"直接输入"。
            </p>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
