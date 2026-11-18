import {
  formatTrendNumber,
  signedTrendNumber,
  type TrendGroup,
  type TrendMetricSeries,
  type TrendResult,
} from "../analysis/trend.js";

/**
 * Terminal view of a trend.
 *
 * One line per metric keeps a whole scene readable in a normal terminal: the
 * latest value, the descriptive statistics, the change against the previous
 * Take and a sparkline. Pure string building — the caller owns all I/O.
 */

const UNKNOWN = "未知";

function dayOf(startedAt: string): string {
  return startedAt.length >= 10 ? startedAt.slice(0, 10) : startedAt;
}

function deviceLabel(group: TrendGroup): string {
  return group.deviceId ?? UNKNOWN;
}

function osLabel(group: TrendGroup): string {
  return group.osVersion ?? UNKNOWN;
}

function unitSuffix(unit: string | null): string {
  return unit === null ? "" : `（${unit}）`;
}

function deltaLabel(series: TrendMetricSeries): string {
  if (series.delta === null) return "较上次测量 无法计算";
  const percent =
    series.deltaPercent === null
      ? ""
      : `（${signedTrendNumber(series.deltaPercent)}%）`;
  return `较上次测量 ${signedTrendNumber(series.delta)}${percent}`;
}

function metricLine(series: TrendMetricSeries): string {
  return [
    `  ${series.name}${unitSuffix(series.unit)}`,
    `最近 ${formatTrendNumber(series.latest)}`,
    `中位数 ${formatTrendNumber(series.median)}`,
    `范围 ${formatTrendNumber(series.min)}–${formatTrendNumber(series.max)}`,
    deltaLabel(series),
    series.sparkline,
  ].join("  ");
}

function groupHeader(group: TrendGroup): string {
  return `分组：${deviceLabel(group)} / iOS ${osLabel(group)}    ${
    group.runCount
  } 次 Take（${dayOf(group.firstStartedAt)} → ${dayOf(
    group.lastStartedAt,
  )}）    状态：completed ${group.statusCounts.completed}、partial ${
    group.statusCounts.partial
  }`;
}

export function renderTrendText(trend: TrendResult): string {
  const lines: string[] = [
    `场景：${trend.sceneId}    检查最近 ${trend.scanLimit} 条运行（匹配 ${
      trend.scanned
    } 条，每分组最多 ${trend.limit} 条）`,
  ];

  if (trend.groups.length === 0) {
    lines.push("没有可用于趋势的运行。");
  }

  for (const group of trend.groups) {
    lines.push(groupHeader(group));
    if (group.metrics.length === 0) {
      lines.push("  无可用数值指标。");
      continue;
    }
    for (const series of group.metrics) {
      lines.push(metricLine(series));
    }
  }

  lines.push(
    `排除（当前筛选）：invalid ${trend.exclusions.invalid}、failed ${
      trend.exclusions.failed
    }、cancelled ${trend.exclusions.cancelled}、不可读 ${
      trend.exclusions.unreadable
    }`,
  );
  return lines.join("\n");
}
