import { useEffect, useState } from "react";
import { Activity, History, Moon, Plus, RefreshCw, Settings2, Sun } from "lucide-react";
import { toast } from "sonner";
import type { Update } from "@tauri-apps/plugin-updater";
import { getVersion } from "@tauri-apps/api/app";

import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { AddSymbolDialog } from "@/components/AddSymbolDialog";
import { AddWidgetMenu } from "@/components/AddWidgetMenu";
import { Dashboard } from "@/components/Dashboard";
import { SettingsDialog } from "@/components/SettingsDialog";
import { UpdateDialog } from "@/components/UpdateDialog";
import { api } from "@/api/tauri";
import { checkForUpdate } from "@/lib/updater";
import { useTheme } from "@/hooks/useTheme";
import {
  disposeMarketStore,
  initMarketStore,
} from "@/stores/marketStore";
import {
  disposeAlertStore,
  initAlertStore,
} from "@/stores/alertStore";
import {
  disposeIntradayStore,
  initIntradayStore,
} from "@/stores/intradayStore";
import { useDashboardStore } from "@/stores/dashboardStore";
import { onPollError } from "@/api/events";

function App() {
  const { theme, toggle } = useTheme();
  const [update, setUpdate] = useState<Update | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [currentVersion, setCurrentVersion] = useState('');
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    initMarketStore().catch((e) => console.error("initMarketStore failed", e));
    initAlertStore().catch((e) => console.error("initAlertStore failed", e));
    initIntradayStore().catch((e) => console.error("initIntradayStore failed", e));

    // 读取当前版本
    getVersion()
      .then((v) => setCurrentVersion(v))
      .catch(() => undefined);

    // 启动时静默检测更新：有新版才弹，失败不打扰
    checkForUpdate()
      .then((u) => {
        if (u) {
          setUpdate(u);
          setUpdateOpen(true);
        }
      })
      .catch((e) => console.debug("启动检测更新失败（已忽略）", e));

    api
      .ping()
      .then((info) => {
        if (!info.sidecar_ok) {
          toast.warning("Sidecar 未就绪：" + (info.sidecar_error ?? "未知"));
        }
      })
      .catch(() => undefined);

    let off: (() => void) | null = null;
    onPollError((p) => {
      console.debug("poll error", p);
    })
      .then((u) => {
        off = u;
      })
      .catch(() => undefined);

    return () => {
      disposeMarketStore();
      disposeAlertStore();
      disposeIntradayStore();
      off?.();
    };
  }, []);

  const openAlertsPanel = () => {
    const widgets = useDashboardStore.getState().widgets;
    if (widgets.some((w) => w.type === "alerts")) {
      toast.info("信号历史面板已在仪表盘中");
      return;
    }
    useDashboardStore.getState().addWidget({ type: "alerts" });
  };

  /** 手动"检查更新"：无论结果都反馈 */
  const handleManualCheck = async () => {
    if (checking) return;
    setChecking(true);
    try {
      const u = await checkForUpdate();
      if (u) {
        setUpdate(u);
        setUpdateOpen(true);
      } else {
        toast.success(`已是最新版本 v${currentVersion}`);
      }
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? String(e);
      toast.error("检查更新失败：" + msg);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <header className="flex items-center gap-3 border-b px-4 py-2">
        <Activity className="h-5 w-5 text-primary" />
        <h1 className="text-base font-semibold">Watch Ticket · 行情监听</h1>
        <span className="text-xs text-muted-foreground">v{currentVersion}</span>

        <div className="ml-auto flex items-center gap-2">
          <AddSymbolDialog
            trigger={
              <Button size="sm">
                <Plus className="mr-2 h-4 w-4" />
                添加自选
              </Button>
            }
          />
          <AddWidgetMenu />

          <Button
            variant="ghost"
            size="icon"
            title="MACD 信号历史"
            onClick={openAlertsPanel}
          >
            <History className="h-4 w-4" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            title="检查更新"
            onClick={handleManualCheck}
            disabled={checking}
          >
            <RefreshCw className={`h-4 w-4 ${checking ? "animate-spin" : ""}`} />
          </Button>

          <SettingsDialog
            trigger={
              <Button variant="ghost" size="icon" title="设置">
                <Settings2 className="h-4 w-4" />
              </Button>
            }
          />

          <Button
            variant="ghost"
            size="icon"
            onClick={toggle}
            title={theme === "dark" ? "切换到浅色" : "切换到深色"}
          >
            {theme === "dark" ? (
              <Sun className="h-4 w-4" />
            ) : (
              <Moon className="h-4 w-4" />
            )}
          </Button>
        </div>
      </header>

      <main className="flex-1 overflow-auto p-3">
        <Dashboard />
      </main>

      <UpdateDialog
        update={update}
        open={updateOpen}
        onOpenChange={setUpdateOpen}
        currentVersion={currentVersion}
      />

      <Toaster position="bottom-right" richColors />
    </div>
  );
}

export default App;
