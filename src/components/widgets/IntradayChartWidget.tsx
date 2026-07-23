/**
 * 分时图 widget（含 MACD 副图 + 金叉/死叉标记 + 顶背离/底背离标记）。
 *
 * 布局（自上而下）：
 *   ①  主图：价格线（红）+ 均价线（黄）+ 昨收虚线基准；
 *      主图上打点：
 *        金叉 = 红色向上三角，死叉 = 绿色向下三角
 *        底背离 = 红色圆形，顶背离 = 绿色圆形
 *   ②  MACD 副图：DIF/DEA 双线 + MACD 红绿柱
 *   ③  成交量副图：柱状
 *
 * MACD 计算基于**每分钟价格序列**（使用当日分时点）。仅用于图上展示，
 * 不入 alerts 表、不发通知（避免高频抖动刷屏）。
 */

import { useEffect, useMemo, useRef } from "react";
import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";

import { WidgetShell } from "@/components/WidgetShell";
import { formatPct, formatPrice, upDownClass } from "@/lib/format";
import { macd as calcMacd } from "@/lib/indicators";
import { useIntradayStore } from "@/stores/intradayStore";
import { useMarketStore } from "@/stores/marketStore";

const EPS = 1e-8;
// 背离检测滑动窗口大小，可按需调整
const DIVERGENCE_WINDOW = 20;

interface Props {
  symbol: string;
  onClose?: () => void;
}

/** 简单四舍五入到指定小数位，避免浮点长尾影响 tooltip */
function round(v: number | null, n = 4): number | null {
  if (v == null) return null;
  const m = Math.pow(10, n);
  return Math.round(v * m) / m;
}

interface CrossMark {
  index: number;
  ts: string;
  price: number;
  kind: "golden" | "dead";
}

interface DivergenceMark {
  index: number;
  ts: string;
  price: number;
  kind: "top" | "bottom"; // top顶背离，bottom底背离
}

/**
 * 从 dif/dea 序列扫描金叉/死叉【增加浮点容错EPS】
 * 金叉：prev.dif <= prev.dea && cur.dif > cur.dea
 * 死叉：prev.dif >= prev.dea && cur.dif < cur.dea
 */
function detectCrosses(
  dif: (number | null)[],
  dea: (number | null)[],
  times: string[],
  prices: number[],
): CrossMark[] {
  const out: CrossMark[] = [];
  for (let i = 1; i < dif.length; i++) {
    const pd = dif[i - 1];
    const pe = dea[i - 1];
    const cd = dif[i];
    const ce = dea[i];
    if (pd == null || pe == null || cd == null || ce == null) continue;

    const prevDiff = pd - pe;
    const currDiff = cd - ce;

    if (prevDiff <= EPS && currDiff > EPS) {
      out.push({ index: i, ts: times[i], price: prices[i], kind: "golden" });
    } else if (prevDiff >= -EPS && currDiff < -EPS) {
      out.push({ index: i, ts: times[i], price: prices[i], kind: "dead" });
    }
  }
  return out;
}

/**
 * 检测MACD顶背离 / 底背离
 * @param prices 价格数组
 * @param difArr DIF数组（过滤null）
 * @param times 时间标签
 * @returns DivergenceMark[]
 * 规则：
 * 底背离：价格创阶段新低，DIF没有同步创新低
 * 顶背离：价格创阶段新高，DIF没有同步创新高
 */
function detectDivergence(
  prices: number[],
  difArr: (number | null)[],
  times: string[],
): DivergenceMark[] {
  const marks: DivergenceMark[] = [];
  const validDif = difArr.map((v) => v ?? 0);
  const len = prices.length;

  // 至少需要窗口长度数据
  if (len < DIVERGENCE_WINDOW) return marks;

  for (let i = DIVERGENCE_WINDOW; i < len; i++) {
    const start = i - DIVERGENCE_WINDOW;
    const slicePrice = prices.slice(start, i + 1);
    const sliceDif = validDif.slice(start, i + 1);

    const currPrice = prices[i];
    const currDif = validDif[i];

    const priceMax = Math.max(...slicePrice);
    const priceMin = Math.min(...slicePrice);
    const difMax = Math.max(...sliceDif);
    const difMin = Math.min(...sliceDif);

    // ========== 顶背离：当前价格是区间新高，DIF不是区间新高 ==========
    if (Math.abs(currPrice - priceMax) < EPS && Math.abs(currDif - difMax) > EPS) {
      marks.push({
        index: i,
        ts: times[i],
        price: currPrice,
        kind: "top",
      });
    }
    // ========== 底背离：当前价格是区间新低，DIF不是区间新低 ==========
    else if (Math.abs(currPrice - priceMin) < EPS && Math.abs(currDif - difMin) > EPS) {
      marks.push({
        index: i,
        ts: times[i],
        price: currPrice,
        kind: "bottom",
      });
    }
  }

  return marks;
}

export function IntradayChartWidget({ symbol, onClose }: Props) {
  const entry = useIntradayStore((s) => s.entries[symbol]);
  const ensure = useIntradayStore((s) => s.ensure);
  const quote = useMarketStore((s) => s.quotes[symbol]);
  const chartRef = useRef<ReactECharts>(null);

  // 加载分时数据
  useEffect(() => {
    ensure(symbol).catch(() => undefined);
  }, [symbol, ensure]);

  // 组件销毁释放echarts实例，防止内存泄漏
  useEffect(() => {
    return () => {
      const ins = chartRef.current?.getEchartsInstance();
      if (ins) ins.dispose();
    };
  }, []);

  // ===================== 统一预处理数据【只计算一次MACD，多处复用】 =====================
  const dataPack = useMemo(() => {
    const points = entry?.points ?? [];
    if (points.length === 0) return null;

    const times = points.map((p) => {
      const parts = p.ts.split(" ");
      const t = parts[1] ?? parts[0];
      return t.length >= 5 ? t.slice(0, 5) : t;
    });
    const prices = points.map((p) => p.price);
    const avgs = points.map((p) => p.avg_price ?? null);
    const vols = points.map((p) => p.volume ?? 0);

    // 统一计算MACD
    const macdResult = calcMacd(prices, 12, 26, 9);
    const dif = macdResult.map((m) => round(m.dif));
    const dea = macdResult.map((m) => round(m.dea));
    const macdBar = macdResult.map((m) => round(m.macd));

    const crosses = detectCrosses(dif, dea, times, prices);
    const divergences = detectDivergence(prices, dif, times);

    // 统计数量
    let g = 0, d = 0;
    crosses.forEach((c) => {
      if (c.kind === "golden") g++;
      else d++;
    });
    let topDiv = 0, bottomDiv = 0;
    divergences.forEach((v) => {
      if (v.kind === "top") topDiv++;
      else bottomDiv++;
    });

    return {
      points,
      times,
      prices,
      avgs,
      vols,
      macdResult,
      dif,
      dea,
      macdBar,
      crosses,
      divergences,
      crossCount: { g, d },
      divCount: { top: topDiv, bottom: bottomDiv },
    };
  }, [entry?.points]);

  const option = useMemo<EChartsOption>(() => {
    if (!dataPack) return {};
    const { times, prices, avgs, dif, dea, macdBar, divergences } = dataPack;
    const prevClose = quote?.prev_close;

    // ===== 金叉死叉标记点 =====
    // const crossMarkData = crosses.map((c) => ({
    //   name: c.kind === "golden" ? "金叉" : "死叉",
    //   coord: [c.index, c.price] as [number, number],
    //   value: c.kind === "golden" ? "金" : "死",
    //   itemStyle: {
    //     color: c.kind === "golden" ? "#e11d48" : "#16a34a",
    //   },
    //   symbol: c.kind === "golden" ? "triangle" : "arrow",
    //   symbolRotate: c.kind === "golden" ? 0 : 180,
    //   symbolSize: 12,
    //   label: {
    //     show: true,
    //     color: "#fff",
    //     fontSize: 9,
    //     fontWeight: "bold",
    //     position: c.kind === "golden" ? "bottom" : "top",
    //   },
    // }));

    // ===== 顶底背离标记点 =====
    const divMarkData = divergences.map((item) => ({
      name: item.kind === "top" ? "顶背离" : "底背离",
      coord: [item.index, item.price] as [number, number],
      value: item.kind === "top" ? "顶背离" : "底背离",
      itemStyle: {
        color: item.kind === "top" ? "#22c55e" : "#ef4444",
      },
      symbol: "circle" as "circle",
      symbolSize: 10,
      label: {
        show: true,
        color: item.kind === 'top'?"green":"red",
        fontSize: 8,
        position: (item.kind === "top" ? "top" : "bottom") as
          | "top"
          | "bottom",
      },
    }));

    // 合并所有标记点
    // const allMarkData = [...crossMarkData, ...divMarkData];
    const allMarkData = [...divMarkData];

    return {
      animation: false,
      grid: [
        { left: 55, right: 20, top: 24, height: "52%" },
        { left: 55, right: 20, top: "68%", height: "16%" },
        { left: 55, right: 20, top: "86%", height: "12%" },
      ],
      axisPointer: {
        link: [{ xAxisIndex: "all" }],
      },
      xAxis: [
        {
          type: "category",
          data: times,
          boundaryGap: false,
          axisLine: { lineStyle: { color: "#888" } },
          axisLabel: { fontSize: 10, hideOverlap: true },
          splitLine: { show: false },
        },
        {
          type: "category",
          gridIndex: 1,
          data: times,
          axisLabel: { show: false },
          axisTick: { show: false },
          axisLine: { show: false },
        },
        {
          type: "category",
          gridIndex: 2,
          data: times,
          axisLabel: { show: false },
          axisTick: { show: false },
          axisLine: { show: false },
        },
      ],
      yAxis: [
        {
          scale: true,
          splitLine: { lineStyle: { color: "#eee", type: "dashed" } },
          axisLabel: { fontSize: 10 },
          splitNumber: 5,
        },
        {
          gridIndex: 1,
          scale: true,
          splitLine: { lineStyle: { color: "#eee", type: "dashed" } },
          axisLabel: { fontSize: 9 },
          splitNumber: 3,
        },
        {
          gridIndex: 2,
          splitLine: { show: false },
          axisLabel: { fontSize: 9 },
          splitNumber: 2,
        },
      ],
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross" },
        confine: true,
        backgroundColor: "rgba(30,30,30,0.85)",
        borderWidth: 0,
        textStyle: { color: "#fff", fontSize: 11 },
      },
      legend: {
        data: ["价格", "均价", "DIF", "DEA", "MACD"],
        textStyle: { fontSize: 10 },
        top: 2,
        right: 20,
        itemGap: 8,
        itemWidth: 12,
        itemHeight: 8,
      },
      series: [
        {
          name: "价格",
          type: "line",
          data: prices,
          showSymbol: false,
          lineStyle: { width: 1.2, color: "#e11d48" },
          areaStyle: { color: "rgba(225, 29, 72, 0.08)" },
          markLine:
            prevClose != null
              ? {
                  symbol: "none",
                  silent: true,
                  lineStyle: { color: "#888", type: "dashed" },
                  data: [
                    {
                      yAxis: prevClose,
                      label: { formatter: "昨收", fontSize: 9 },
                    },
                  ],
                }
              : undefined,
          markPoint: allMarkData.length
            ? {
                data: allMarkData,
                animation: false,
              }
            : undefined,
        },
        {
          name: "均价",
          type: "line",
          data: avgs,
          showSymbol: false,
          lineStyle: { width: 1, color: "#eab308" },
        },
        // MACD 副图
        {
          name: "MACD",
          type: "bar",
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: macdBar,
          barWidth: "60%",
          itemStyle: {
            color: (params) => {
              const v = (params.value as number) ?? 0;
              return v >= 0 ? "#e11d48" : "#16a34a";
            },
          },
        },
        {
          name: "DIF",
          type: "line",
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: dif,
          showSymbol: false,
          lineStyle: { width: 1, color: "#3b82f6" },
        },
        {
          name: "DEA",
          type: "line",
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: dea,
          showSymbol: false,
          lineStyle: { width: 1, color: "#f59e0b" },
        },
      ],
    };
  }, [dataPack, quote?.prev_close]);

  const crossCount = dataPack?.crossCount ?? { g: 0, d: 0 };
  const divCount = dataPack?.divCount ?? { top: 0, bottom: 0 };
  const isLoading = entry?.loading ?? false;
  const isEmpty = !entry || entry.points.length === 0;

  return (
    <WidgetShell
      title={
        <div className="flex items-center gap-2 flex-wrap">
          <span>分时</span>
          <span className="font-mono">{symbol}</span>
          {quote?.name && (
            <span className="text-muted-foreground">{quote.name}</span>
          )}
          {quote && (
            <>
              <span className="ml-2 font-mono">{formatPrice(quote.price)}</span>
              <span
                className={`font-mono text-xs ${upDownClass(quote.change_pct)}`}
              >
                {formatPct(quote.change_pct)}
              </span>
            </>
          )}
          {(crossCount.g > 0 || crossCount.d > 0 || divCount.top > 0 || divCount.bottom > 0) && (
            <span className="ml-2 flex items-center gap-1 text-[10px]">
              <span className="text-up">金 {crossCount.g}</span>
              <span className="text-down">死 {crossCount.d}</span>
              <span className="text-up">底背离 {divCount.bottom}</span>
              <span className="text-down">顶背离 {divCount.top}</span>
            </span>
          )}
        </div>
      }
      onClose={onClose}
      contentClassName="overflow-hidden"
    >
      <div className="relative h-full w-full">
        {!isEmpty && (
          <ReactECharts
            ref={chartRef}
            option={option}
            style={{ height: "100%", width: "100%" }}
            notMerge={false}
            lazyUpdate
            opts={{ renderer: "canvas" }}
          />
        )}
        {isEmpty && (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {isLoading
              ? "加载中…"
              : entry?.error
                ? "拉取失败：" + entry.error
                : "暂无分时数据"}
          </div>
        )}
      </div>
    </WidgetShell>
  );
}