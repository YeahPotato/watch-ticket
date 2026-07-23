/**
 * 更新对话框：显示新版本信息 → 用户确认 → 下载 → 安装 → 重启。
 *
 * 由 App.tsx 顶层持有；启动时静默检测有新版才 open，也可由"检查更新"按钮手动打开。
 */

import { useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type { Update } from "@tauri-apps/plugin-updater";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { downloadAndInstall, type UpdateProgress } from "@/lib/updater";

interface Props {
  update: Update | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前应用版本，用于显示对比 */
  currentVersion: string;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function UpdateDialog({
  update,
  open,
  onOpenChange,
  currentVersion,
}: Props) {
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);

  const handleInstall = async () => {
    if (!update) return;
    setInstalling(true);
    setProgress({ downloaded: 0, phase: "started" });
    try {
      await downloadAndInstall(update, (p) => setProgress(p));
      // 正常情况：安装完 relaunch() 会立即退出进程，不会走到这里
      toast.success("更新完成，正在重启…");
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? String(e);
      toast.error("更新失败：" + msg);
      setInstalling(false);
      setProgress(null);
    }
  };

  const percent =
    progress?.contentLength && progress.contentLength > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.contentLength) * 100))
      : null;

  return (
    <Dialog open={open} onOpenChange={installing ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCw className="h-4 w-4" />
            发现新版本
          </DialogTitle>
          <DialogDescription>
            当前版本 v{currentVersion} → 新版本 v{update?.version ?? "?"}
          </DialogDescription>
        </DialogHeader>

        {update?.body && (
          <div className="max-h-48 overflow-auto rounded border bg-muted/40 p-3 text-xs whitespace-pre-wrap">
            {update.body}
          </div>
        )}

        {installing && (
          <div className="space-y-2">
            <div className="h-2 overflow-hidden rounded bg-muted">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: percent != null ? `${percent}%` : "30%" }}
              />
            </div>
            <div className="text-xs text-muted-foreground">
              {progress?.phase === "finished"
                ? "下载完成，正在安装…"
                : percent != null
                  ? `下载中 ${percent}% (${formatBytes(progress?.downloaded ?? 0)}${
                      progress?.contentLength
                        ? " / " + formatBytes(progress.contentLength)
                        : ""
                    })`
                  : `下载中 ${formatBytes(progress?.downloaded ?? 0)}`}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            disabled={installing}
            onClick={() => onOpenChange(false)}
          >
            稍后
          </Button>
          <Button disabled={installing || !update} onClick={handleInstall}>
            <Download className="mr-2 h-4 w-4" />
            {installing ? "更新中…" : "立即更新"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
