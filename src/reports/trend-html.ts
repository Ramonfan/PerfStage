import {
  formatTrendNumber,
  signedTrendNumber,
  type TrendGroup,
  type TrendMetricSeries,
  type TrendResult,
} from "../analysis/trend.js";
import { escapeHtml } from "./html.js";
import { REPORT_STYLE } from "./html-style.js";

/**
 * Offline HTML + inline SVG view of a scene's trend.
 *
 * The page must open from disk with no network, no scripts and no external
 * assets, and regenerating the same history must produce the same bytes. Two
 * consequences worth knowing before editing:
 *
 * - nothing here reads the clock; the footer uses the newest Take's
 *   `startedAt`, so two runs over unchanged history are byte-identical;
 * - all geometry is rounded to two decimals for the same reason.
 */

const UNKNOWN = "未知";

const SVG_WIDTH = 640;
const SVG_HEIGHT = 160;
const PAD_LEFT = 56;
const PAD_RIGHT = 16;
const PAD_TOP = 16;
const PAD_BOTTOM = 28;
const INNER_WIDTH = SVG_WIDTH - PAD_LEFT - PAD_RIGHT;
const INNER_HEIGHT = SVG_HEIGHT - PAD_TOP - PAD_BOTTOM;

/** Chart-only rules; the shared page stylesheet stays report-specific. */
const TREND_STYLE = [
  "section{margin:1.75rem 0}",
  ".meta{color:#6e6e73;font-size:.9rem}",
  "figure{margin:0 0 1.25rem}",
  "figcaption{color:#6e6e73;font-size:.85rem;margin-bottom:.25rem}",
  "svg{display:block;max-width:100%;height:auto}",
  ".chart-line{fill:none;stroke:#2f6feb;stroke-width:2}",
  ".chart-dot{stroke:#fff;stroke-width:1.5}",
  ".chart-dot-completed{fill:#2f6feb}",
  ".chart-dot-partial{fill:#c98a00}",
  ".chart-axis{stroke:#d1d1d6;stroke-width:1}",
  ".chart-label{fill:#6e6e73;font-size:11px}",
  ".excluded{color:#6e6e73;font-size:.9rem}",
  "@media (prefers-color-scheme:dark){.chart-axis{stroke:#3a3a3c}.chart-label,figcaption,.meta,.excluded{fill:#98989d;color:#98989d}.chart-dot{stroke:#1c1c1e}}",
].join("");

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function dayOf(startedAt: string): string {
  return startedAt.length >= 10 ? startedAt.slice(0, 10) : startedAt;
}

function startedAtMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function deviceLabel(group: TrendGroup): string {
  return group.deviceId ?? UNKNOWN;
}

function osLabel(group: TrendGroup): string {
  return group.osVersion ?? UNKNOWN;
}

function unitSuffix(unit: string | null): string {
  return unit === null ? "" : `（${escapeHtml(unit)}）`;
}

/**
 * Horizontal positions in trace order. Timestamps are used when they parse and
 * actually advance; otherwise points are spread evenly so a degenerate series
 * still renders instead of collapsing on the left edge.
 */
function xPositions(points: TrendMetricSeries["points"]): number[] {
  if (points.length === 1) {
    return [PAD_LEFT + INNER_WIDTH / 2];
  }
  const times = points.map((point) => Date.parse(point.startedAt));
  const first = times[0];
  const last = times[times.length - 1];
  const usable =
    first !== undefined &&
    last !== undefined &&
    times.every((time) => Number.isFinite(time)) &&
    last > first;
  if (!usable) {
    return points.map(
      (_point, index) => PAD_LEFT + (INNER_WIDTH * index) / (points.length - 1),
    );
  }
  return times.map(
    (time) => PAD_LEFT + ((time - (first as number)) / ((last as number) - (first as number))) * INNER_WIDTH,
  );
}

function renderSvg(series: TrendMetricSeries): string {
  const values = series.points.map((point) => point.value);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    // A flat line still needs a span; a ±1 window around the value keeps the
    // stroke centred without implying a real range.
    min -= 1;
    max += 1;
  }
  const scaleY = (value: number): number =>
    PAD_TOP + INNER_HEIGHT - ((value - min) / (max - min)) * INNER_HEIGHT;

  const xs = xPositions(series.points);
  const coordinates = series.points.map((point, index) => ({
    x: round(xs[index] as number),
    y: round(scaleY(point.value)),
    point,
  }));
  const bottom = PAD_TOP + INNER_HEIGHT;
  const label = (value: number): string => escapeHtml(formatTrendNumber(value));

  const parts: string[] = [
    `<svg viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" role="img" aria-label="${escapeHtml(
      series.name,
    )} 趋势">`,
    `<line class="chart-axis" x1="${PAD_LEFT}" y1="${bottom}" x2="${
      SVG_WIDTH - PAD_RIGHT
    }" y2="${bottom}" />`,
    `<text class="chart-label" x="${PAD_LEFT - 8}" y="${
      PAD_TOP + 4
    }" text-anchor="end">${label(max)}</text>`,
    `<text class="chart-label" x="${PAD_LEFT - 8}" y="${
      bottom + 4
    }" text-anchor="end">${label(min)}</text>`,
    `<text class="chart-label" x="${PAD_LEFT}" y="${
      SVG_HEIGHT - 8
    }">${escapeHtml(dayOf(series.points[0]?.startedAt ?? ""))}</text>`,
    `<text class="chart-label" x="${SVG_WIDTH - PAD_RIGHT}" y="${
      SVG_HEIGHT - 8
    }" text-anchor="end">${escapeHtml(
      dayOf(series.points[series.points.length - 1]?.startedAt ?? ""),
    )}</text>`,
  ];

  if (coordinates.length >= 2) {
    const polyline = coordinates.map((item) => `${item.x},${item.y}`).join(" ");
    parts.push(`<polyline class="chart-line" points="${polyline}" />`);
  }

  for (const item of coordinates) {
    const gate =
      item.point.gate === undefined ? "" : ` · gate=${item.point.gate}`;
    const title = `${item.point.runId} · ${item.point.startedAt} · ${
      series.name
    }=${formatTrendNumber(item.point.value)}${series.unit === null ? "" : ` ${series.unit}`} · status=${
      item.point.status
    }${gate}`;
    parts.push(
      `<circle class="chart-dot chart-dot-${item.point.status}" cx="${item.x}" cy="${item.y}" r="3.5"><title>${escapeHtml(
        title,
      )}</title></circle>`,
    );
  }

  parts.push("</svg>");
  return parts.join("");
}

function metricCaption(series: TrendMetricSeries): string {
  const delta =
    series.delta === null
      ? "较上次测量 无法计算"
      : `较上次测量 ${escapeHtml(signedTrendNumber(series.delta))}`;
  return [
    `<strong>${escapeHtml(series.name)}</strong>${unitSuffix(series.unit)}`,
    `最近 ${escapeHtml(formatTrendNumber(series.latest))}`,
    `中位数 ${escapeHtml(formatTrendNumber(series.median))}`,
    `范围 ${escapeHtml(formatTrendNumber(series.min))}–${escapeHtml(
      formatTrendNumber(series.max),
    )}`,
    delta,
  ].join(" · ");
}

function renderGroup(group: TrendGroup): string {
  const parts = [
    "<section>",
    `<h2>设备 ${escapeHtml(deviceLabel(group))} · iOS ${escapeHtml(
      osLabel(group),
    )}</h2>`,
    `<p class="meta">${group.runCount} 次 Take（${escapeHtml(
      dayOf(group.firstStartedAt),
    )} → ${escapeHtml(dayOf(group.lastStartedAt))}） · 状态：completed ${
      group.statusCounts.completed
    }、partial ${group.statusCounts.partial}</p>`,
  ];
  if (group.metrics.length === 0) {
    parts.push("<p>无可用数值指标。</p>");
  }
  for (const series of group.metrics) {
    parts.push(
      "<figure>",
      `<figcaption>${metricCaption(series)}</figcaption>`,
      renderSvg(series),
      "</figure>",
    );
  }
  parts.push("</section>");
  return parts.join("\n");
}

export function renderTrendHtml(trend: TrendResult): string {
  // The footer timestamp is chosen by parsed time, not by string order:
  // mixed fractional-second precision must not pick an earlier Take. No clock
  // is read, so regenerating the same history stays byte-identical.
  const latest = trend.groups.reduce<string | null>(
    (newest, group) =>
      newest === null ||
      startedAtMs(group.lastStartedAt) > startedAtMs(newest)
        ? group.lastStartedAt
        : newest,
    null,
  );

  const body: string[] = [
    "<h1>性能趋势</h1>",
    `<p>场景 <strong>${escapeHtml(trend.sceneId)}</strong> · 检查最近 ${
      trend.scanLimit
    } 条运行（匹配 ${trend.scanned} 条，每分组最多 ${trend.limit} 条）</p>`,
  ];

  if (trend.groups.length === 0) {
    body.push("<p>没有可用于趋势的运行。</p>");
  }
  for (const group of trend.groups) {
    body.push(renderGroup(group));
  }

  body.push(
    `<p class="excluded">排除（当前筛选）：invalid ${trend.exclusions.invalid}、failed ${
      trend.exclusions.failed
    }、cancelled ${trend.exclusions.cancelled}、不可读 ${
      trend.exclusions.unreadable
    }</p>`,
    `<footer>由 PerfStage 生成 · 最近一次 Take ${escapeHtml(
      latest ?? "未记录",
    )}</footer>`,
  );

  return [
    "<!DOCTYPE html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>性能趋势 — ${escapeHtml(trend.sceneId)}</title>`,
    `<style>${REPORT_STYLE}${TREND_STYLE}</style>`,
    "</head>",
    "<body>",
    "<main>",
    ...body,
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
