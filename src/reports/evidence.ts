import {
  canonicalMetricName,
  metricDefinition,
  normalizeMetricResults,
} from "../analysis/metrics.js";
import {
  deriveGate,
  resolveMetricVerdict,
} from "../analysis/thresholds.js";
import type { MetricRequest, TestPlan } from "../model/test-plan.js";
import type {
  GateResult,
  MetricResult,
  MetricVerdict,
} from "../model/test-run.js";
import type { ReportFinding } from "./json.js";

export type EvidenceGapKind = "missing-metric" | "missing-value" | "missing-trace";

export interface EvidenceGap extends ReportFinding {
  kind: EvidenceGapKind;
  metric: string;
}

export interface MetricEvidenceEvaluation {
  /** Hard evidence gaps that make the Take `partial`. */
  gaps: EvidenceGap[];
  /** Gap findings ready to merge into the report. */
  findings: ReportFinding[];
  /** Resolved verdicts for the supplied metrics. */
  verdicts: MetricVerdict[];
  /** Threshold gate, or `unknown` when any evidence gap exists. */
  gate: GateResult;
}

function isMissingValue(value: unknown): boolean {
  return value === undefined || value === null;
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

/**
 * A metric needs a trace when it is produced by an Instruments template —
 * either the plan says so or the metric is one of the canonical MVP metrics.
 */
function requiresTrace(
  planMetric: MetricRequest | undefined,
  result: MetricResult,
): boolean {
  if (result.verdict === "skipped") {
    return false;
  }
  return (
    planMetric?.instrument !== undefined ||
    result.instrument !== undefined ||
    metricDefinition(result.name) !== undefined
  );
}

/**
 * Evidence gate for one Take: every metric the plan requested must be
 * present, must carry a value, and (when instrument-backed) must have a
 * trace path. These gaps downgrade `status` to `partial` regardless of the
 * threshold verdicts (A4).
 */
export function evaluateMetricEvidence(
  plan: TestPlan | null | undefined,
  rawResults: MetricResult[],
): MetricEvidenceEvaluation {
  const results = normalizeMetricResults(rawResults);
  const gaps: EvidenceGap[] = [];
  const seen = new Set<string>();
  const pushGap = (gap: EvidenceGap): void => {
    const key = `${gap.kind}:${canonicalMetricName(gap.metric)}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    gaps.push(gap);
  };

  const planMetrics = plan?.metrics ?? [];
  const findPlanMetric = (name: string): MetricRequest | undefined =>
    planMetrics.find(
      (metric) => canonicalMetricName(metric.name) === canonicalMetricName(name),
    );

  // 1. Every requested metric must have at least one result.
  for (const planMetric of planMetrics) {
    const hasResult = results.some(
      (result) => canonicalMetricName(result.name) === canonicalMetricName(planMetric.name),
    );
    if (!hasResult) {
      pushGap({
        kind: "missing-metric",
        metric: planMetric.name,
        code: `metric:${planMetric.name}`,
        severity: "warning",
        message: `缺少证据：未采集指标 ${planMetric.name}。`,
      });
    }
  }

  // 2. Every supplied result must carry a value, and instrument-backed
  //    metrics must carry a trace path.
  for (const result of results) {
    if (result.verdict === "skipped") {
      continue;
    }
    if (isMissingValue(result.value)) {
      pushGap({
        kind: "missing-value",
        metric: result.name,
        code: `value:${result.name}`,
        severity: "warning",
        message: `缺少证据：指标 ${result.name} 没有数值。`,
      });
    }
    if (requiresTrace(findPlanMetric(result.name), result) && isBlank(result.tracePath)) {
      pushGap({
        kind: "missing-trace",
        metric: result.name,
        code: `trace:${result.name}`,
        severity: "warning",
        message: `缺少证据：指标 ${result.name} 没有 trace 路径。`,
      });
    }
  }

  const verdicts = results.map((result) => {
    const planMetric = findPlanMetric(result.name);
    // Thresholds belong to the plan/scenario; a Result only needs to carry
    // the measured value. A result-level threshold wins when supplied.
    const threshold = result.threshold ?? planMetric?.threshold;
    return resolveMetricVerdict({
      ...result,
      ...(threshold !== undefined ? { threshold } : {}),
    });
  });
  const gate = gaps.length > 0 ? "unknown" : deriveGate(verdicts);

  return {
    gaps,
    findings: gaps.map(({ kind: _kind, metric: _metric, ...finding }) => finding),
    verdicts,
    gate,
  };
}
