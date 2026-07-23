/**
 * 应用设置对话框。
 *
 * 可配置项：
 *   - MACD 参数：fast / slow / signal
 *
 * 保存写 settings 表；调度器每 60s 会自动 reload，无需重启。
 */

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/api/tauri";

interface Props {
  trigger: React.ReactNode;
}

interface Form {
  macdFast: string;
  macdSlow: string;
  macdSignal: string;
}

const DEFAULT_FORM: Form = {
  macdFast: "12",
  macdSlow: "26",
  macdSignal: "9",
};

export function SettingsDialog({ trigger }: Props) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Form>(DEFAULT_FORM);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api
      .listSettings()
      .then((map) => {
        setForm({
          macdFast: map.macd_fast ?? "12",
          macdSlow: map.macd_slow ?? "26",
          macdSignal: map.macd_signal ?? "9",
        });
      })
      .catch(() => setForm(DEFAULT_FORM))
      .finally(() => setLoading(false));
  }, [open]);

  const save = async () => {
    const fast = parseInt(form.macdFast, 10);
    const slow = parseInt(form.macdSlow, 10);
    const signal = parseInt(form.macdSignal, 10);
    if (![fast, slow, signal].every((n) => Number.isInteger(n) && n > 0)) {
      toast.error("MACD 参数必须为正整数");
      return;
    }
    if (fast >= slow) {
      toast.error("MACD fast 必须小于 slow");
      return;
    }

    setSaving(true);
    try {
      await Promise.all([
        api.updateSetting("macd_fast", String(fast)),
        api.updateSetting("macd_slow", String(slow)),
        api.updateSetting("macd_signal", String(signal)),
      ]);
      toast.success("设置已保存（下一轮 K 线拉取后生效）");
      setOpen(false);
    } catch (e) {
      toast.error("保存失败：" + String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            加载中…
          </div>
        ) : (
          <div className="space-y-4">
            <section className="space-y-2">
              <h3 className="text-sm font-medium">MACD 参数</h3>
              <div className="grid grid-cols-3 gap-2">
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">Fast</span>
                  <Input
                    value={form.macdFast}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, macdFast: e.target.value }))
                    }
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">Slow</span>
                  <Input
                    value={form.macdSlow}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, macdSlow: e.target.value }))
                    }
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">Signal</span>
                  <Input
                    value={form.macdSignal}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, macdSignal: e.target.value }))
                    }
                  />
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
                默认 12 / 26 / 9。修改后下一轮 K 线拉取时应用于所有订阅。
              </p>
            </section>

            <section className="space-y-1 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              MACD 金叉/死叉信号会自动记录到"信号历史"面板，不发桌面通知。
            </section>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={saving}
          >
            取消
          </Button>
          <Button onClick={save} disabled={saving || loading}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
