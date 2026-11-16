import {
  MIN_BASELINE_SAMPLES,
  type ComparisonStatus,
  type MetricComparison,
} from "./compare.js";
import type { MetricRegression } from "../model/test-plan.js";
import type { RunStatus } from "../model/test-run.js";

/**
 * Regression gate evaluation (C3).
 *
 * Pure functions only: the caller passes the C2 comparison result plus the
 * rules read from the target run's `plan.json` snapshot. No filesystem, no
 * clock, no workspace. That keeps the verdict reproducible and unit-testable.
 *
 * The module deliberately has a third state. `not-evaluated` is not a soft
 * pass: no rules, a short baseline, a missing metric or an unknown unit means
 * the gate cannot answer, and reporting `pass` there would fabricate evidence.
 */

export type RegressionStatus = "pass" | "fail" | "not-evaluated";

export type RegressionReason =
  | "target-not-completed"
  | "plan-unreadable"
  | "no-rules"
  | "baseline-no-samples"
  | "baseline-insufficient-samples"
  | "metric-not-in-target"
  | "metric-not-in-baseline"
  | "unit-mismatch"
  | "insufficient-metric-samples"
  | "zero-baseline";

export type RegressionTolerance =
  | "maxWorseningPercent"
  | "maxWorseningAbsolute";

export interface MetricRegressionEvaluation {
  status: RegressionStatus;
  worse: MetricRegression["worse"];
  maxWorseningPercent: number | null;
  maxWorseningAbsolute: number | null;
  /** Worsening relative to the baseline median; `null` when undefined. */
  worseningPercent: number | null;
  /** Worsening as an absolute number in the metric's unit. */
  worseningAbsolute: number | null;
  exceeded: RegressionTolerance[];
  reason: RegressionReason | null;
}

export interface RegressionMetric extends MetricComparison {
  /** `null` when the target plan declares no rule for this metric. */
  regression: MetricRegressionEvaluation | null;
}

export interface RegressionSummary {
  status: RegressionStatus;
  configured: number;
  /** Metrics that produced `pass` or `fail`. */
  evaluated: number;
  failed: number;
  notEvaluated: number;
  reason: RegressionReason | null;
  reasons: RegressionReason[];
}

export interface RegressionInput {
  targetStatus: RunStatus;
  /** `false` when the snapshot is missing, unreadable or has invalid rules. */
  planReadable: boolean;
  baselineStatus: ComparisonStatus;
  /**
   * `against` is an explicit single-Take choice, so the per-metric floor is 1;
   * a derived baseline keeps the C2 floor of 3.
   */
  baselineKind: "derived" | "against";
  metrics: readonly MetricComparison[];
  rules: ReadonlyMap<string, MetricRegression>;
}

export interface RegressionEvaluation {
  summary: RegressionSummary;
  metrics: RegressionMetric[];
}

/** Placeholder for a configured metric absent from the comparison union. */
function absentMetric(name: string): MetricComparison {
  return {
    name,
    unit: null,
    current: null,
    baselineMedian: null,
    delta: null,
    deltaPercent: null,
    direction: null,
    baselineRange: null,
    withinRange: null,
    samples: 0,
    status: "missing-current",
  };
}

function evaluateMetric(
  metric: MetricComparison,
  rule: MetricRegression,
  input: RegressionInput,
): MetricRegressionEvaluation {
  const base = {
    worse: rule.worse,
    maxWorseningPercent: rule.maxWorseningPercent ?? null,
    maxWorseningAbsolute: rule.maxWorseningAbsolute ?? null,
    worseningPercent: null as number | null,
    worseningAbsolute: null as number | null,
    exceeded: [] as RegressionTolerance[],
  };

  const notEvaluated = (
    reason: RegressionReason,
  ): MetricRegressionEvaluation => ({
    ...base,
    status: "not-evaluated",
    reason,
  });

  // Order matters: a Take that is not trustworthy outranks every data-shape
  // problem, and a short baseline outranks per-metric gaps.
  if (input.targetStatus !== "completed") {
    return notEvaluated("target-not-completed");
  }
  if (!input.planReadable) {
    return notEvaluated("plan-unreadable");
  }
  if (input.baselineStatus === "no-baseline") {
    return notEvaluated("baseline-no-samples");
  }
  if (input.baselineStatus === "insufficient-samples") {
    return notEvaluated("baseline-insufficient-samples");
  }
  if (metric.status === "missing-current") {
    return notEvaluated("metric-not-in-target");
  }
  if (metric.status === "missing-baseline") {
    return notEvaluated("metric-not-in-baseline");
  }
  if (metric.status === "unit-mismatch") {
    return notEvaluated("unit-mismatch");
  }

  const sampleFloor =
    input.baselineKind === "against" ? 1 : MIN_BASELINE_SAMPLES;
  if (metric.samples < sampleFloor) {
    return notEvaluated("insufficient-metric-samples");
  }
  if (
    metric.delta === null ||
    !Number.isFinite(metric.delta) ||
    metric.current === null ||
    !Number.isFinite(metric.current) ||
    metric.baselineMedian === null ||
    !Number.isFinite(metric.baselineMedian)
  ) {
    // `status: ok` should guarantee finite numbers, but never coerce a missing
    // or non-finite value into a verdict if a future comparison variant
    // changes that invariant.
    return notEvaluated("metric-not-in-target");
  }

  const worseningAbsolute =
    rule.worse === "higher" ? metric.delta : -metric.delta;
  const percent =
    metric.deltaPercent === null || !Number.isFinite(metric.deltaPercent)
      ? null
      : metric.deltaPercent;
  const worseningPercent =
    percent === null ? null : rule.worse === "higher" ? percent : -percent;

  const exceeded: RegressionTolerance[] = [];
  if (
    rule.maxWorseningPercent !== undefined &&
    worseningPercent !== null &&
    worseningPercent > rule.maxWorseningPercent
  ) {
    exceeded.push("maxWorseningPercent");
  }
  if (
    rule.maxWorseningAbsolute !== undefined &&
    worseningAbsolute > rule.maxWorseningAbsolute
  ) {
    exceeded.push("maxWorseningAbsolute");
  }

  const result = { ...base, worseningPercent, worseningAbsolute };

  if (exceeded.length > 0) {
    return { ...result, status: "fail", exceeded, reason: null };
  }
  // A percentage-only rule cannot be evaluated when the percentage is
  // unavailable (zero baseline median, or a non-finite ratio). When an absolute
  // rule is also present, that rule already decided the result.
  if (
    worseningPercent === null &&
    rule.maxWorseningPercent !== undefined &&
    rule.maxWorseningAbsolute === undefined
  ) {
    return {
      ...result,
      status: "not-evaluated",
      exceeded: [],
      reason: "zero-baseline",
    };
  }
  return { ...result, status: "pass", exceeded: [], reason: null };
}

/**
 * Evaluate every declared rule and fold the per-metric results.
 *
 * `fail` wins over `not-evaluated`, which wins over `pass`. A rule whose
 * metric does not appear in the comparison at all is appended as an
 * `absentMetric` entry so it can never silently disappear into a green gate.
 */
export function evaluateRegression(
  input: RegressionInput,
): RegressionEvaluation {
  const metrics: RegressionMetric[] = input.metrics.map((metric) => {
    const rule = input.rules.get(metric.name);
    return {
      ...metric,
      regression:
        rule === undefined ? null : evaluateMetric(metric, rule, input),
    };
  });

  const present = new Set(input.metrics.map((metric) => metric.name));
  for (const [name, rule] of input.rules) {
    if (present.has(name)) continue;
    const placeholder = absentMetric(name);
    metrics.push({
      ...placeholder,
      regression: evaluateMetric(placeholder, rule, input),
    });
  }

  const results = metrics.flatMap((metric) =>
    metric.regression === null ? [] : [metric.regression],
  );
  const failed = results.filter((result) => result.status === "fail").length;
  const notEvaluated = results.filter(
    (result) => result.status === "not-evaluated",
  ).length;
  const evaluated = results.filter(
    (result) => result.status === "pass" || result.status === "fail",
  ).length;

  let status: RegressionStatus;
  if (failed > 0) {
    status = "fail";
  } else if (notEvaluated > 0) {
    status = "not-evaluated";
  } else if (results.length === 0) {
    status = "not-evaluated";
  } else {
    status = "pass";
  }

  const reasons = [
    ...new Set(
      results.flatMap((result) =>
        result.reason === null ? [] : [result.reason],
      ),
    ),
  ];

  let reason: RegressionReason | null = null;
  if (status === "not-evaluated") {
    if (input.targetStatus !== "completed") {
      reason = "target-not-completed";
    } else if (!input.planReadable) {
      reason = "plan-unreadable";
    } else if (results.length === 0) {
      reason = "no-rules";
    } else {
      reason = reasons[0] ?? "no-rules";
    }
  }

  return {
    summary: {
      status,
      configured: input.rules.size,
      evaluated,
      failed,
      notEvaluated,
      reason,
      reasons,
    },
    metrics,
  };
}
