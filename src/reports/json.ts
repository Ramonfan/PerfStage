import type {
  ActionOutcome,
  ActionRecord,
  MetricResult,
  RunStatus,
  TestRun,
} from "../model/test-run.js";
import type { TestAction } from "../model/test-plan.js";
import type {
  DiagnosticEvidence,
  DiagnosticImpact,
} from "../diagnostics/normalize.js";

/**
 * Phases the timeline can attribute to a slice of an action record.
 *
 * - `drag`: the gesture itself (finger-down to finger-up). Swipes produce a
 *   measurable drag; taps produce a near-instantaneous drag.
 * - `wait`: the deceleration/idle window after the gesture, including any
 *   `waitAfterMs`/`durationMs`/`timeoutMs` declared by the action.
 * - `post-action`: residual time between the declared wait end and the
 *   recorded `endedAt`. Surfaced only when the recorded wall-clock exceeds
 *   the plan-declared window.
 * - `unknown`: at least one timestamp was missing or did not line up, so the
 *   report must not invent sub-phase boundaries.
 */
export type ActionPhase = "drag" | "wait" | "post-action" | "unknown";

export interface ActionPhaseEntry {
  phase: ActionPhase;
  startedAt: string | "unknown";
  endedAt: string | "unknown";
}

export interface ActionTimelineEntry {
  actionId: string;
  type: string;
  outcome: ActionOutcome;
  attempts: number;
  phases: ActionPhaseEntry[];
  error?: string;
  notes?: string;
}

export interface MetricReportEntry {
  name: string;
  value: unknown;
  unit?: string;
  threshold?: MetricResult["threshold"];
  verdict?: MetricResult["verdict"];
  measuredAt?: string;
  /**
   * Verbatim copy of every metric field as captured, so forward-compatible
   * fields the schema does not model are still preserved end-to-end.
   */
  raw: Record<string, unknown>;
}

export interface ReportFinding {
  severity: "info" | "warning" | "failure";
  code: string;
  message: string;
}

export interface EvidencePaths {
  deviceLog?: string;
  crashReport?: string;
  screenshots: string[];
  traceArchives: string[];
  networkCapture?: string;
  lifecycleTrace?: string;
}

export interface PlanSummary {
  id: string;
}

export interface JsonReport {
  run: TestRun;
  plan: PlanSummary;
  actions: ActionTimelineEntry[];
  metrics: MetricReportEntry[];
  diagnostics: DiagnosticEvidence;
  findings: ReportFinding[];
  status: RunStatus;
  evidencePaths: EvidencePaths;
  generatedAt: string;
  /**
   * Set when `status` was downgraded from a `completed` requested status.
   * Markdown rendering relies on this to explain why a run was not reported
   * as clean.
   */
  downgradedFromCompleted: boolean;
}

const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function parseTimestamp(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return parsed;
}

function expectedDragMs(action: TestAction | undefined): number {
  if (!action) {
    return 0;
  }
  if (action.type === "swipe") {
    return action.durationMs ?? 0;
  }
  return 0;
}

function expectedWaitMs(action: TestAction | undefined): number {
  if (!action) {
    return 0;
  }
  switch (action.type) {
    case "tap":
      return action.waitAfterMs;
    case "swipe":
      return action.waitAfterMs;
    case "wait":
      return action.durationMs;
    case "wait_for":
      return action.timeoutMs;
    default:
      return 0;
  }
}

/**
 * Build the action timeline entries. Each record becomes one or more
 * `ActionPhaseEntry` rows. When timestamps cannot be partitioned cleanly the
 * whole record collapses to a single `unknown` row, matching the brief's
 * instruction to mark missing data explicitly instead of fabricating
 * durations.
 */
export function buildActionTimeline(
  records: ActionRecord[],
): ActionTimelineEntry[] {
  return records.map((record) => {
    const startedMs = parseTimestamp(record.startedAt);
    const endedMs = parseTimestamp(record.endedAt);
    const action = record.action;
    const dragMs = expectedDragMs(action);
    const waitMs = expectedWaitMs(action);
    const expectedTotal = dragMs + waitMs;

    const phases: ActionPhaseEntry[] = [];
    if (
      startedMs !== null &&
      endedMs !== null &&
      endedMs >= startedMs &&
      expectedTotal > 0 &&
      endedMs - startedMs >= expectedTotal
    ) {
      const dragStart = startedMs;
      const dragEnd = dragStart + dragMs;
      const waitStart = dragEnd;
      const waitEnd = waitStart + waitMs;
      if (dragMs > 0) {
        phases.push({
          phase: "drag",
          startedAt: new Date(dragStart).toISOString(),
          endedAt: new Date(dragEnd).toISOString(),
        });
      }
      if (waitMs > 0) {
        phases.push({
          phase: "wait",
          startedAt: new Date(waitStart).toISOString(),
          endedAt: new Date(waitEnd).toISOString(),
        });
      }
      if (endedMs > waitEnd) {
        phases.push({
          phase: "post-action",
          startedAt: new Date(waitEnd).toISOString(),
          endedAt: new Date(endedMs).toISOString(),
        });
      }
    } else {
      phases.push({
        phase: "unknown",
        startedAt:
          typeof record.startedAt === "string" &&
          ISO_TIMESTAMP_PATTERN.test(record.startedAt)
            ? new Date(startedMs ?? record.startedAt).toISOString()
            : "unknown",
        endedAt:
          typeof record.endedAt === "string" &&
          ISO_TIMESTAMP_PATTERN.test(record.endedAt)
            ? new Date(endedMs ?? record.endedAt).toISOString()
            : "unknown",
      });
    }

    return {
      actionId: record.actionId,
      type: action?.type ?? "unknown",
      outcome: record.outcome,
      attempts: record.attempts,
      phases,
      error: record.error,
      notes: record.notes,
    };
  });
}

/**
 * Coerce a MetricResult into the report shape, copying every property
 * verbatim under `raw`. The known fields are echoed for caller convenience;
 * `raw` is what guarantees no information is lost.
 */
export function buildMetricEntry(metric: MetricResult): MetricReportEntry {
  const raw: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metric)) {
    raw[key] = value;
  }
  return {
    name: metric.name,
    value: metric.value,
    unit: metric.unit,
    threshold: metric.threshold,
    verdict: metric.verdict,
    measuredAt: metric.measuredAt,
    raw,
  };
}

/**
 * Translate runtime signals into human-readable findings. Findings are
 * derived; the raw diagnostics remain available separately so callers can
 * re-derive without losing data.
 */
export function buildFindings(
  diagnostics: DiagnosticEvidence,
  impact: DiagnosticImpact,
  metricFailures: string[],
  missingEvidence: string[],
): ReportFinding[] {
  const findings: ReportFinding[] = [];

  for (const reason of impact.reasons) {
    findings.push({
      severity: impact.severity === "failure" ? "failure" : "warning",
      code: reason,
      message: reasonMessage(reason),
    });
  }

  for (const failure of metricFailures) {
    findings.push({
      severity: "failure",
      code: `metric:${failure}`,
      message: `指标 ${failure} 未通过阈值。`,
    });
  }

  for (const evidence of missingEvidence) {
    findings.push({
      severity: "warning",
      code: `missing:${evidence}`,
      message: `缺少必要证据：${evidence}`,
    });
  }

  if (diagnostics.logs.status === "unavailable") {
    findings.push({
      severity: "warning",
      code: "logs-unavailable",
      message: "未能读取设备日志，部分稳定性结论无法给出。",
    });
  }

  return findings;
}

function reasonMessage(reason: string): string {
  switch (reason) {
    case "new-crash":
      return "运行期间发生了新的 Crash。";
    case "jetsam":
      return "日志中出现 jetsam 终止记录。";
    case "watchdog":
      return "日志中出现 watchdog 超时。";
    case "memory-warning":
      return "日志中出现内存压力警告。";
    case "device-disconnect":
      return "生命周期中检测到设备断连。";
    case "crash-detection-unavailable":
      return "未能读取 Crash 列表，不能据此证明没有崩溃。";
    case "log-evidence-unavailable":
      return "未能读取设备日志。";
    case "lifecycle-evidence-unavailable":
      return "未能读取生命周期事件。";
    default:
      return reason;
  }
}

/**
 * Collect every persisted evidence pointer so the report (and its
 * downstream Markdown rendering) can list what is actually available
 * alongside the run, instead of speculating about paths.
 */
export function collectEvidencePaths(run: TestRun): EvidencePaths {
  return {
    deviceLog: run.evidence.deviceLogPath,
    crashReport: run.evidence.crashReportPath,
    screenshots: [...run.evidence.screenshotPaths],
    traceArchives: [...run.evidence.traceArchivePaths],
    networkCapture: run.evidence.networkCapturePath,
    lifecycleTrace: run.evidence.lifecycleTracePath,
  };
}

export interface BuildJsonReportOptions {
  /**
   * Final status to attach to the report. The reporting layer does not
   * compute the status itself; callers pass the result of
   * `deriveFinalStatus`.
   */
  status: RunStatus;
  /**
   * Impact classification produced by `classifyDiagnosticImpact`. Required
   * even when no impact was found so the report always records the verdict.
   */
  impact: DiagnosticImpact;
  metricFailures: string[];
  missingEvidence: string[];
  /**
   * Override for `generatedAt`; defaults to the current UTC instant. Tests
   * pin a deterministic value.
   */
  generatedAt?: string;
}

/**
 * Compose a `JsonReport` from a stored `TestRun` and its normalized
 * diagnostics. The function is intentionally additive: it never re-derives
 * statuses or evidence paths and never drops fields the schema does not
 * model.
 */
export function buildJsonReport(
  run: TestRun,
  diagnostics: DiagnosticEvidence,
  options: BuildJsonReportOptions,
): JsonReport {
  const generatedAt =
    options.generatedAt ?? new Date().toISOString();
  return {
    run,
    plan: { id: run.planId },
    actions: buildActionTimeline(run.actions),
    metrics: run.metrics.map(buildMetricEntry),
    diagnostics,
    findings: buildFindings(
      diagnostics,
      options.impact,
      options.metricFailures,
      options.missingEvidence,
    ),
    status: options.status,
    evidencePaths: collectEvidencePaths(run),
    generatedAt,
    downgradedFromCompleted:
      run.status === "completed" && options.status !== "completed",
  };
}