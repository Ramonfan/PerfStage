import {
  terminalRunStatusSchema,
  type GateResult,
  type MetricResult,
  type RunStatus,
} from "../model/test-run.js";

/**
 * Baseline comparison core.
 *
 * Pure functions only: no filesystem, no clock, no environment. The handler in
 * `tools/compare.ts` reads runs and hands them here, which keeps the selection
 * and aggregation rules unit-testable without a workspace.
 *
 * The whole module reports *numeric* differences. It deliberately does not
 * judge whether an increase is good or bad: that belongs to the regression
 * gate (`add-regression-gate`), not to baseline reporting.
 */

export interface ComparisonRun {
  runId: string;
  planId: string;
  status: RunStatus;
  gate?: GateResult;
  startedAt: string;
  /** `null` when neither `run.json.device` nor `plan.json.device` has an id. */
  deviceId: string | null;
  /** `null` means the iOS version is unknown (legacy run or ad-hoc plan). */
  osVersion: string | null;
  metrics: MetricResult[];
}

export interface BaselineExclusions {
  differentPlan: number;
  differentDevice: number;
  differentOs: number;
  nonTerminal: number;
  notBefore: number;
}

export const EMPTY_EXCLUSIONS: BaselineExclusions = {
  differentPlan: 0,
  differentDevice: 0,
  differentOs: 0,
  nonTerminal: 0,
  notBefore: 0,
};

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(
  terminalRunStatusSchema.options,
);

/** Default number of historical Takes aggregated into a derived baseline. */
export const DEFAULT_BASELINE_SAMPLES = 3;
export const MIN_BASELINE_SAMPLES = 3;
export const MAX_BASELINE_SAMPLES = 20;

/** Minimum samples before a derived baseline is called `comparable`. */
const COMPARABLE_SAMPLE_FLOOR = MIN_BASELINE_SAMPLES;

export type ComparisonStatus =
  | "comparable"
  | "insufficient-samples"
  | "no-baseline";

export type ComparisonDirection = "increase" | "decrease" | "unchanged";

export type MetricComparisonStatus =
  | "ok"
  | "missing-current"
  | "missing-baseline"
  | "unit-mismatch";

export interface MetricComparison {
  name: string;
  unit: string | null;
  /** Target value; `null` when the metric is not a finite number. */
  current: number | null;
  baselineMedian: number | null;
  delta: number | null;
  deltaPercent: number | null;
  direction: ComparisonDirection | null;
  baselineRange: { min: number; max: number } | null;
  withinRange: boolean | null;
  /** How many baseline samples carried this metric as a finite number. */
  samples: number;
  status: MetricComparisonStatus;
}

export interface BaselineSelection {
  selected: ComparisonRun[];
  excluded: BaselineExclusions;
}

export interface BaselineSelectionOptions {
  /** Maximum number of historical Takes to aggregate (3–20). */
  samples?: number;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Parse a schema-validated ISO timestamp into epoch milliseconds.
 *
 * Comparing the strings directly assumes every producer writes the same
 * fractional-second precision; parsing makes mixed legacy/manual timestamps
 * order correctly even within the same second.
 */
function startedAtMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Arithmetic median; `null` for an empty sample set. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] as number;
  }
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function numericMetric(
  metrics: readonly MetricResult[],
  name: string,
): { value: number; unit?: string } | null {
  const metric = metrics.find((candidate) => candidate.name === name);
  if (metric === undefined || !isFiniteNumber(metric.value)) {
    return null;
  }
  return {
    value: metric.value,
    ...(metric.unit !== undefined ? { unit: metric.unit } : {}),
  };
}

/**
 * Select the historical Takes that form a derived baseline for `target`.
 *
 * Rules (design D3):
 *  1. same `planId`, same device id, same iOS version (`null` only matches
 *     `null`, so unknown legacy records never mix with a known version);
 *  2. terminal status only;
 *  3. `startedAt` strictly earlier than the target;
 *  4. newest first (tie-break by run id descending), truncated to `samples`.
 *
 * Every rejected candidate is counted by reason so the caller can explain a
 * small sample set instead of silently returning fewer runs.
 */
export function selectBaseline(
  target: ComparisonRun,
  candidates: readonly ComparisonRun[],
  options: BaselineSelectionOptions = {},
): BaselineSelection {
  const limit = options.samples ?? DEFAULT_BASELINE_SAMPLES;
  const excluded: BaselineExclusions = { ...EMPTY_EXCLUSIONS };
  const matching: ComparisonRun[] = [];

  // Counters are single-reason with this fixed precedence: plan, device, iOS,
  // terminal status, time. A candidate failing several predicates is counted
  // once, at the first mismatch, so `excluded` explains the common cause
  // without double counting.
  for (const candidate of candidates) {
    if (candidate.runId === target.runId) {
      // The target is never part of its own baseline.
      continue;
    }
    if (candidate.planId !== target.planId) {
      excluded.differentPlan += 1;
      continue;
    }
    if (candidate.deviceId !== target.deviceId) {
      excluded.differentDevice += 1;
      continue;
    }
    if (candidate.osVersion !== target.osVersion) {
      excluded.differentOs += 1;
      continue;
    }
    if (!TERMINAL_STATUSES.has(candidate.status)) {
      excluded.nonTerminal += 1;
      continue;
    }
    if (startedAtMs(candidate.startedAt) >= startedAtMs(target.startedAt)) {
      excluded.notBefore += 1;
      continue;
    }
    matching.push(candidate);
  }

  matching.sort(
    (left, right) =>
      startedAtMs(right.startedAt) - startedAtMs(left.startedAt) ||
      right.runId.localeCompare(left.runId),
  );

  return {
    selected: matching.slice(0, limit),
    excluded,
  };
}

/** Derived-baseline status from the number of aggregated historical Takes. */
export function comparisonStatusForSamples(sampleCount: number): ComparisonStatus {
  if (sampleCount === 0) return "no-baseline";
  if (sampleCount < COMPARABLE_SAMPLE_FLOOR) return "insufficient-samples";
  return "comparable";
}

function metricNames(
  target: readonly MetricResult[],
  baseline: readonly ComparisonRun[],
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const metric of target) {
    if (!seen.has(metric.name)) {
      seen.add(metric.name);
      names.push(metric.name);
    }
  }
  for (const run of baseline) {
    for (const metric of run.metrics) {
      if (!seen.has(metric.name)) {
        seen.add(metric.name);
        names.push(metric.name);
      }
    }
  }
  return names;
}

/**
 * Compare the target metrics against the aggregated baseline samples.
 *
 * Missing values are kept missing: they are never coerced to zero, and a
 * metric whose unit differs is reported as `unit-mismatch` instead of a delta
 * that would be meaningless.
 */
export function compareMetrics(
  target: readonly MetricResult[],
  baseline: readonly ComparisonRun[],
): MetricComparison[] {
  return metricNames(target, baseline).map((name) => {
    const current = numericMetric(target, name);
    const baselineValues: number[] = [];
    const baselineUnits = new Set<string>();
    for (const run of baseline) {
      const metric = numericMetric(run.metrics, name);
      if (metric === null) continue;
      baselineValues.push(metric.value);
      if (metric.unit !== undefined) baselineUnits.add(metric.unit);
    }

    const units = new Set<string>(baselineUnits);
    if (current?.unit !== undefined) {
      units.add(current.unit);
    }
    const unit = current?.unit ?? [...baselineUnits][0] ?? null;
    const baselineMedian = median(baselineValues);
    const baselineRange =
      baselineValues.length === 0
        ? null
        : {
            min: Math.min(...baselineValues),
            max: Math.max(...baselineValues),
          };

    let status: MetricComparisonStatus;
    if (current === null) {
      status = "missing-current";
    } else if (baselineValues.length === 0) {
      status = "missing-baseline";
    } else if (units.size > 1) {
      status = "unit-mismatch";
    } else {
      status = "ok";
    }

    if (
      status !== "ok" ||
      baselineMedian === null ||
      baselineRange === null ||
      current === null
    ) {
      // Aggregating values across incompatible units would repeat the same
      // mistake as a delta: the median looks like one homogeneous number but
      // mixes milliseconds and seconds. Base the suppression on the unit set,
      // not the status, so a target missing the metric cannot smuggle a mixed
      // baseline aggregate through as `missing-current`.
      const incompatible = units.size > 1;
      return {
        name,
        unit,
        current: current?.value ?? null,
        baselineMedian: incompatible ? null : baselineMedian,
        delta: null,
        deltaPercent: null,
        direction: null,
        baselineRange: incompatible ? null : baselineRange,
        withinRange: null,
        samples: baselineValues.length,
        status,
      };
    }

    const delta = current.value - baselineMedian;
    return {
      name,
      unit,
      current: current.value,
      baselineMedian,
      delta,
      deltaPercent: baselineMedian === 0 ? null : (delta / baselineMedian) * 100,
      direction: delta > 0 ? "increase" : delta < 0 ? "decrease" : "unchanged",
      baselineRange,
      withinRange:
        current.value >= baselineRange.min && current.value <= baselineRange.max,
      samples: baselineValues.length,
      status,
    };
  });
}

export interface BaselineWindow {
  from: string;
  to: string;
}

/**
 * Earliest and latest `startedAt` among the aggregated samples.
 *
 * Compares epoch milliseconds rather than the raw strings: legacy and manual
 * records may use different fractional-second precision, and lexical order
 * would put `...:00Z` after `...:00.500Z`.
 */
export function baselineWindow(
  samples: readonly ComparisonRun[],
): BaselineWindow | null {
  if (samples.length === 0) return null;
  let from = samples[0]?.startedAt;
  let to = samples[0]?.startedAt;
  for (const sample of samples) {
    if (from === undefined || startedAtMs(sample.startedAt) < startedAtMs(from)) {
      from = sample.startedAt;
    }
    if (to === undefined || startedAtMs(sample.startedAt) > startedAtMs(to)) {
      to = sample.startedAt;
    }
  }
  if (from === undefined || to === undefined) return null;
  return { from, to };
}
