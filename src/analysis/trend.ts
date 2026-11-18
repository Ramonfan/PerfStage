import { median } from "./compare.js";
import type { GateResult, MetricResult, RunStatus } from "../model/test-run.js";

/**
 * Pure trend aggregation.
 *
 * A trend is a *descriptive* view of history: it groups finished Takes by
 * device and iOS, keeps the most recent ones per group and derives per-metric
 * series. It never re-judges a Take — thresholds, gate and exit codes stay
 * where they are — so this module does no I/O, reads no clock and has no
 * verdicts of its own.
 */

/** Default number of Takes kept per device/iOS group. */
export const DEFAULT_TREND_LIMIT = 20;
export const MIN_TREND_LIMIT = 1;
export const MAX_TREND_LIMIT = 200;
/** Upper bound on candidate runs a single `perfstage trend` call inspects. */
export const TREND_SCAN_LIMIT = 200;

const INCLUDED_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "completed",
  "partial",
]);

/**
 * Sparkline ramp, lowest to highest. Eight levels keep the line readable in
 * monospace terminals without relying on colour.
 */
const SPARK_LEVELS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
const SPARK_MIDDLE = "▄";

export interface TrendRun {
  runId: string;
  status: RunStatus;
  gate?: GateResult;
  startedAt: string;
  /** `null` when neither `run.json` nor `plan.json` recorded a device id. */
  deviceId: string | null;
  /** `null` when the iOS version is unknown (legacy run or ad-hoc plan). */
  osVersion: string | null;
  metrics: MetricResult[];
}

export interface TrendPoint {
  runId: string;
  startedAt: string;
  status: RunStatus;
  gate?: GateResult;
  value: number;
}

export interface TrendMetricSeries {
  name: string;
  unit: string | null;
  /** Ascending by `startedAt`; only finite numeric measurements appear. */
  points: TrendPoint[];
  latest: number;
  median: number;
  min: number;
  max: number;
  /** Latest minus the previous measurement; `null` with fewer than two points. */
  delta: number | null;
  /** `null` when there is no previous point or it measured zero. */
  deltaPercent: number | null;
  sparkline: string;
}

export interface TrendGroup {
  /** Raw device facts; `null` renders as「未知」and groups only with `null`. */
  deviceId: string | null;
  osVersion: string | null;
  runCount: number;
  /**
   * Trust breakdown of the included Takes. A `partial` Take still contributes
   * values, so the view has to say how many points are caveated.
   */
  statusCounts: { completed: number; partial: number };
  firstStartedAt: string;
  lastStartedAt: string;
  /** Ordered by the most recent Take's metric order; empty series dropped. */
  metrics: TrendMetricSeries[];
}

export interface TrendExclusions {
  invalid: number;
  failed: number;
  cancelled: number;
  unreadable: number;
}

export interface TrendResult {
  sceneId: string;
  /** Takes kept per group. */
  limit: number;
  /** Candidate runs matched to the scene (before status filtering). */
  scanned: number;
  scanLimit: number;
  /** Ordered by most recent Take, descending. */
  groups: TrendGroup[];
  exclusions: TrendExclusions;
}

export interface BuildTrendInput {
  sceneId: string;
  runs: readonly TrendRun[];
  limit?: number;
  /** Keep only this device id; `undefined` keeps every device. */
  deviceId?: string;
  /** Runs whose `run.json` could not be read; excluded, never guessed. */
  unreadable?: number;
  scanned?: number;
  scanLimit?: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Reject out-of-range limits instead of silently clamping user intent. */
export function resolveTrendLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_TREND_LIMIT;
  if (
    !Number.isInteger(limit) ||
    limit < MIN_TREND_LIMIT ||
    limit > MAX_TREND_LIMIT
  ) {
    throw new Error(
      `--limit 必须是 ${MIN_TREND_LIMIT}–${MAX_TREND_LIMIT} 的整数：${limit}`,
    );
  }
  return limit;
}

/**
 * Render a fixed-width number: integers stay integers, fractions keep at most
 * two decimals. Used by both text and SVG so the two views cannot disagree.
 */
export function formatTrendNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 100) / 100);
}

export function signedTrendNumber(value: number): string {
  const formatted = formatTrendNumber(value);
  return value > 0 ? `+${formatted}` : formatted;
}

/** Eight-level sparkline normalised to the series' own min–max. */
export function trendSparkline(values: readonly number[]): string {
  if (values.length === 0) return "";
  let min = values[0] as number;
  let max = values[0] as number;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (min === max) {
    // A flat series has no shape to show; the middle level keeps the count
    // visible without implying an increase or a decrease.
    return SPARK_MIDDLE.repeat(values.length);
  }
  const span = max - min;
  return values
    .map((value) => {
      const index = Math.round(((value - min) / span) * (SPARK_LEVELS.length - 1));
      return SPARK_LEVELS[index] ?? SPARK_MIDDLE;
    })
    .join("");
}

function compareStartedAtDescending(left: TrendRun, right: TrendRun): number {
  // Parse instead of comparing strings: mixed fractional-second precision
  // (legacy/manual timestamps) does not sort lexicographically by time.
  return (
    startedAtMs(right.startedAt) - startedAtMs(left.startedAt) ||
    right.runId.localeCompare(left.runId)
  );
}

function startedAtMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function metricNames(runs: readonly TrendRun[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  // The newest Take defines the canonical order; older Takes can only append
  // metrics the newest one omitted.
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    for (const metric of runs[index]?.metrics ?? []) {
      if (seen.has(metric.name)) continue;
      seen.add(metric.name);
      names.push(metric.name);
    }
  }
  return names;
}

function buildSeries(runs: readonly TrendRun[], name: string): TrendMetricSeries | null {
  const points: TrendPoint[] = [];
  let unit: string | null = null;
  for (const run of runs) {
    const metric = run.metrics.find((item) => item.name === name);
    if (metric === undefined || !isFiniteNumber(metric.value)) continue;
    // The unit follows the plotted points only: a later Take with a missing
    // value must not relabel a series whose measurements carry a different or
    // absent unit.
    if (metric.unit !== undefined && metric.unit.length > 0) {
      unit = metric.unit;
    }
    points.push({
      runId: run.runId,
      startedAt: run.startedAt,
      status: run.status,
      ...(run.gate !== undefined ? { gate: run.gate } : {}),
      value: metric.value,
    });
  }
  if (points.length === 0) return null;

  const values = points.map((point) => point.value);
  const latest = values[values.length - 1] as number;
  const previous = values.length >= 2 ? (values[values.length - 2] as number) : null;
  const delta = previous === null ? null : latest - previous;
  const deltaPercent =
    previous === null || previous === 0 || delta === null
      ? null
      : (delta / previous) * 100;

  return {
    name,
    unit,
    points,
    latest,
    median: median(values) ?? latest,
    min: Math.min(...values),
    max: Math.max(...values),
    delta,
    deltaPercent,
    sparkline: trendSparkline(values),
  };
}

function buildGroup(runs: readonly TrendRun[]): TrendGroup {
  const metrics = metricNames(runs)
    .map((name) => buildSeries(runs, name))
    .filter((series): series is TrendMetricSeries => series !== null);
  const first = runs[0] as TrendRun;
  const last = runs[runs.length - 1] as TrendRun;
  const statusCounts = { completed: 0, partial: 0 };
  for (const run of runs) {
    if (run.status === "partial") statusCounts.partial += 1;
    else statusCounts.completed += 1;
  }
  return {
    deviceId: first.deviceId,
    osVersion: first.osVersion,
    runCount: runs.length,
    statusCounts,
    firstStartedAt: first.startedAt,
    lastStartedAt: last.startedAt,
    metrics,
  };
}

function groupKey(run: TrendRun): string {
  return `${run.deviceId ?? "\u0000"}\u0000${run.osVersion ?? "\u0000"}`;
}

/**
 * Aggregate candidate Takes into grouped, per-metric series.
 *
 * Only `completed` and `partial` enter the chart: a `partial` Take carries
 * real measurements with an explicit trust caveat, while failed or invalid
 * Takes would draw retries as if they were ordinary samples.
 */
export function buildTrend(input: BuildTrendInput): TrendResult {
  const limit = resolveTrendLimit(input.limit);
  const exclusions: TrendExclusions = {
    invalid: 0,
    failed: 0,
    cancelled: 0,
    unreadable: input.unreadable ?? 0,
  };

  const buckets = new Map<string, TrendRun[]>();
  for (const run of input.runs) {
    // Device filtering happens first: exclusions describe the Takes this view
    // could have drawn, not runs the user explicitly filtered out.
    if (input.deviceId !== undefined && run.deviceId !== input.deviceId) {
      continue;
    }
    if (!INCLUDED_STATUSES.has(run.status)) {
      if (run.status === "invalid") exclusions.invalid += 1;
      else if (run.status === "failed") exclusions.failed += 1;
      else if (run.status === "cancelled") exclusions.cancelled += 1;
      continue;
    }
    const key = groupKey(run);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [run]);
    else bucket.push(run);
  }

  const groups: TrendGroup[] = [];
  for (const bucket of buckets.values()) {
    const recent = [...bucket].sort(compareStartedAtDescending).slice(0, limit);
    // `recent` is newest-first; series read oldest-first so the sparkline and
    // the "latest" value agree with time.
    groups.push(buildGroup(recent.reverse()));
  }
  groups.sort(
    (left, right) =>
      startedAtMs(right.lastStartedAt) - startedAtMs(left.lastStartedAt) ||
      (left.deviceId ?? "").localeCompare(right.deviceId ?? "") ||
      (left.osVersion ?? "").localeCompare(right.osVersion ?? ""),
  );

  return {
    sceneId: input.sceneId,
    limit,
    scanned: input.scanned ?? input.runs.length,
    scanLimit: input.scanLimit ?? TREND_SCAN_LIMIT,
    groups,
    exclusions,
  };
}
