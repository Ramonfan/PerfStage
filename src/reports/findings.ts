import type { DiagnosticImpact } from "../diagnostics/normalize.js";
import type { MetricRequest, TestPlan } from "../model/test-plan.js";
import type { MetricResult } from "../model/test-run.js";
import type { ReportFinding } from "./json.js";

/**
 * Returns the metric names that were requested by the plan but absent from
 * the supplied results. Missing metric results propagate upward as findings
 * with code `metric:<name>` so callers can distinguish them from diagnostic
 * unavailability.
 */
export function deriveMissingMetricEvidence(
  plan: TestPlan | null | undefined,
  results: MetricResult[],
): string[] {
  if (!plan) {
    return [];
  }
  const collected = new Set(results.map((m) => m.name));
  return plan.metrics
    .map((m: MetricRequest) => m.name)
    .filter((name) => !collected.has(name))
    .map((name) => `metric:${name}`);
}

/**
 * Returns the list of metric names whose verdict is `fail`.
 */
export function deriveMetricFailures(results: MetricResult[]): string[] {
  return results.filter((m) => m.verdict === "fail").map((m) => m.name);
}

/**
 * Combine diagnostic-impact reasons, missing-evidence entries, and metric
 * failures into a single `ReportFinding` array. Each entry is `(code,
 * severity, message)`. Status downgrades are appended when the requested
 * "completed" status was overridden.
 */
export function deriveFindings(input: {
  diagnosticsImpact: DiagnosticImpact;
  missingEvidence: string[];
  metricFailures: string[];
  requestedStatus: import("../model/test-run.js").RunStatus;
  finalStatus: import("../model/test-run.js").RunStatus;
}): ReportFinding[] {
  const findings: ReportFinding[] = [];

  for (const reason of input.diagnosticsImpact.reasons) {
    findings.push({
      code: reason,
      severity: input.diagnosticsImpact.severity,
      message: describeDiagnosticReason(reason),
    });
  }

  for (const missing of input.missingEvidence) {
    findings.push({
      code: missing,
      severity: "warning",
      message: `缺少证据：${missing}`,
    });
  }

  for (const failure of input.metricFailures) {
    findings.push({
      code: `metric:${failure}`,
      severity: "failure",
      message: `指标 ${failure} 未通过阈值。`,
    });
  }

  if (
    input.requestedStatus === "completed" &&
    input.finalStatus !== "completed"
  ) {
    findings.push({
      code: "status-downgrade",
      severity: "warning",
      message: `最终状态由 completed 降级为 ${input.finalStatus}。`,
    });
  }

  return findings;
}

function describeDiagnosticReason(reason: string): string {
  switch (reason) {
    case "new-crash":
      return "运行期间出现新增 Crash。";
    case "jetsam":
      return "日志检测到 jetsam。";
    case "watchdog":
      return "日志检测到 watchdog。";
    case "memory-warning":
      return "日志检测到内存压力告警。";
    case "device-disconnect":
      return "生命周期事件记录到设备断开。";
    case "crash-detection-unavailable":
      return "无法读取 Crash 列表；本次不能据此判定稳定性。";
    case "log-evidence-unavailable":
      return "无法读取设备日志；本次不能据此判定稳定性。";
    case "lifecycle-evidence-unavailable":
      return "无法读取生命周期事件；本次不能据此判定稳定性。";
    default:
      return reason;
  }
}
