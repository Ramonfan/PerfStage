import type {
  GateResult,
  MetricResult,
  MetricVerdict,
} from "../model/test-run.js";

export interface MetricThreshold {
  warn?: number;
  fail?: number;
}

/**
 * Apply the documented threshold rule:
 *
 * ```text
 * value >= threshold.fail  -> fail
 * value >= threshold.warn  -> warn
 * otherwise                -> pass
 * no threshold             -> unknown
 * ```
 *
 * Only numeric values can be compared; a missing or non-numeric value is
 * `unknown` (the evidence gate separately turns that into `partial`).
 */
export function evaluateMetricVerdict(
  value: unknown,
  threshold: MetricThreshold | undefined,
): MetricVerdict {
  if (
    threshold === undefined ||
    (threshold.warn === undefined && threshold.fail === undefined)
  ) {
    return "unknown";
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "unknown";
  }
  if (threshold.fail !== undefined && value >= threshold.fail) {
    return "fail";
  }
  if (threshold.warn !== undefined && value >= threshold.warn) {
    return "warn";
  }
  return "pass";
}

/**
 * Resolve a metric's verdict. A derived verdict from `value` + `threshold`
 * wins because thresholds are the reproducible definition; an explicit
 * `verdict` is used only when no threshold is available.
 */
export function resolveMetricVerdict(metric: MetricResult): MetricVerdict {
  const derived = evaluateMetricVerdict(metric.value, metric.threshold);
  if (derived !== "unknown") {
    return derived;
  }
  return metric.verdict ?? "unknown";
}

/**
 * Collapse metric verdicts into a single gate result.
 *
 * Missing/skipped/unknown verdicts do not silently pass the gate: a Take
 * with no evaluated metric is `unknown`, not `pass`.
 */
export function deriveGate(verdicts: readonly MetricVerdict[]): GateResult {
  const evaluated = verdicts.filter((verdict) => verdict !== "skipped");
  if (evaluated.length === 0) {
    return "unknown";
  }
  if (evaluated.includes("fail")) {
    return "fail";
  }
  if (evaluated.includes("warn")) {
    return "warn";
  }
  if (evaluated.every((verdict) => verdict === "unknown")) {
    return "unknown";
  }
  return "pass";
}
