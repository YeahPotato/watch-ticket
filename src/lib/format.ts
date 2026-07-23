/**
 * 数字/时间格式化工具。
 */

export function formatPrice(v: number | null | undefined, digits = 2): string {
  if (v == null || Number.isNaN(v)) return "-";
  return v.toFixed(digits);
}

export function formatPct(v: number | null | undefined, digits = 2): string {
  if (v == null || Number.isNaN(v)) return "-";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(digits)}%`;
}

export function formatChange(v: number | null | undefined, digits = 2): string {
  if (v == null || Number.isNaN(v)) return "-";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(digits)}`;
}

/** 5678900 → "567.89万"、1234000000 → "12.34亿" */
export function formatVolume(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "-";
  const abs = Math.abs(v);
  if (abs >= 1e8) return (v / 1e8).toFixed(2) + "亿";
  if (abs >= 1e4) return (v / 1e4).toFixed(2) + "万";
  return v.toFixed(0);
}

/** 把 "2026-07-22 09:30:00" / "2026-07-22" 之类的 ts 提取显示片段 */
export function formatTs(ts: string, kind: "minute" | "day" = "minute"): string {
  if (!ts) return "-";
  // 兼容 "YYYY-MM-DD HH:mm:ss"
  const [d, t] = ts.split(" ");
  if (kind === "day" || !t) return d ?? ts;
  return `${d} ${t.slice(0, 5)}`;
}

/** 涨跌 tailwind class */
export function upDownClass(v: number | null | undefined): string {
  if (v == null) return "";
  if (v > 0) return "text-up";
  if (v < 0) return "text-down";
  return "text-muted-foreground";
}
