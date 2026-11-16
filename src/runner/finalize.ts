import { normalizeMetricResults } from "../analysis/metrics.js";
import {
  classifyDiagnosticImpact,
  normalizeDiagnostics,
  type DiagnosticEvidence,
  type DiagnosticInput,
} from "../diagnostics/normalize.js";
import type { TestPlan } from "../model/test-plan.js";
import type {
  ActionOutcome,
  ActionRecord,
  GateResult,
  MetricResult,
  RunStatus,
  TestRun,
} from "../model/test-run.js";
import { terminalRunStatusSchema } from "../model/test-run.js";
import { deriveFindings } from "../reports/findings.js";
import {
  buildJsonReport,
  evidencePathsArray,
  type JsonReport,
  type ReportEvidencePath,
  type ReportEvidencePaths,
  type ReportFinding,
} from "../reports/json.js";
import { renderMarkdownReport } from "../reports/markdown.js";
import {
  evaluateMetricEvidence,
  type EvidenceGap,
} from "../reports/evidence.js";
import {
  isSafeRunRelative,
  sanitizeEvidencePaths,
} from "../reports/evidence-paths.js";
import { deriveRunOutcome } from "../reports/outcome.js";
import type { RunStore, RunIndexEntry } from "../storage/runs.js";

export interface FinalizeRunInput {
  runId: string;
  requestedStatus: RunStatus;
  plan: TestPlan | null;
  actions: ActionRecord[];
  metrics: MetricResult[];
  /**
   * Completed pass facts. Omitted by callers that do not record passes (the
   * manual prepare/finalize path), which leaves the stored `run.json` without
   * a `passes` key — history reports that as "not recorded".
   */
  passes?: TestRun["passes"];
  /**
   * Device facts captured by preflight. Absent when the Take failed before the
   * device was reached; the stored run then has no `device` key.
   */
  device?: TestRun["device"];
  diagnostics: DiagnosticInput;
  /**
   * Evidence that the caller already copied into the run directory, keyed by
   * evidence kind with **run-relative** POSIX paths.
   */
  copiedEvidence?: ReportEvidencePaths;
  /** List-valued evidence (screenshots, trace archives) already copied. */
  copiedByKind?: Record<string, string[]>;
  /**
   * A run-relative log path supplied through `diagnostics.logPath`. Used only
   * as a report fallback when no copy happened; absolute paths are dropped.
   */
  fallbackLogPath?: string;
  notes?: string;
  /** Force the interrupted/action-failed branch. Inferred from actions when omitted. */
  interrupted?: boolean;
}

export interface FinalizeRunDependencies {
  runStore: RunStore;
  now: () => Date;
}

export interface FinalizedRun {
  run: TestRun;
  status: RunStatus;
  gate: GateResult;
  findings: ReportFinding[];
  evidenceGaps: EvidenceGap[];
  diagnostics: DiagnosticEvidence;
  evidencePaths: ReportEvidencePath[];
  jsonReport: JsonReport;
  markdown: string;
  /**
   * Set when the run itself was persisted but the append-only history index
   * could not be updated. The Take keeps its status/gate: the report is
   * authoritative and history queries fall back to scanning `run.json`.
   */
  indexWarning?: string;
}

export type FinalizeRunOutcome =
  | { kind: "ok"; result: FinalizedRun }
  | { kind: "missing" }
  | { kind: "terminal"; status: RunStatus }
  | { kind: "concurrent" }
  | { kind: "invalid"; reason: string };

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(
  terminalRunStatusSchema.options,
);

function actionFailed(outcome: ActionOutcome): boolean {
  return outcome === "failed" || outcome === "timeout";
}

/**
 * Resolve the canonical action reference from the plan so the persisted
 * action record always carries the validated, defaulted action shape.
 */
function pickAction(
  action: ActionRecord,
  plan: TestPlan | null,
): ActionRecord {
  const planAction = plan?.actions.find((candidate) => candidate.id === action.actionId);
  return {
    actionId: action.actionId,
    ...(planAction !== undefined ? { action: planAction } : {}),
    outcome: action.outcome,
    attempts: action.attempts,
    startedAt: action.startedAt,
    endedAt: action.endedAt ?? null,
    durationMs: action.durationMs,
    error: action.error,
    notes: action.notes,
  };
}

/**
 * Project a finalized run onto the compact, append-only index row.
 *
 * Only query-critical fields are copied. `run.json` remains the authoritative
 * record for thresholds, samples and evidence.
 */
function isTerminalRunStatus(
  status: RunStatus,
): status is RunIndexEntry["status"] {
  return TERMINAL_STATUSES.has(status);
}

function buildIndexEntry(
  persisted: TestRun,
  plan: TestPlan | null,
  gate: GateResult,
): RunIndexEntry | null {
  if (!isTerminalRunStatus(persisted.status)) {
    // Finalize only persists terminal statuses; guard keeps the index
    // contract honest if that ever changes.
    return null;
  }
  return {
    v: 1,
    runId: persisted.id,
    planId: persisted.planId,
    scenarioId:
      plan !== null && plan.source === "scenario" ? (plan.id ?? null) : null,
    deviceId: plan?.device.id ?? null,
    status: persisted.status,
    gate,
    startedAt: persisted.startedAt,
    endedAt: persisted.endedAt,
    ...(persisted.durationMs !== undefined
      ? { durationMs: persisted.durationMs }
      : {}),
    passCount:
      persisted.passes === undefined ? null : persisted.passes.length,
    metrics: persisted.metrics.map((metric) => ({
      name: metric.name,
      ...(metric.value !== undefined ? { value: metric.value } : {}),
      ...(metric.unit !== undefined ? { unit: metric.unit } : {}),
      ...(metric.verdict !== undefined ? { verdict: metric.verdict } : {}),
    })),
  };
}

interface FinalizeCapture {
  evidence: DiagnosticEvidence;
  findings: ReportFinding[];
  status: RunStatus;
  gate: GateResult;
  result: FinalizedRun;
}

/**
 * Shared finalize pipeline used by the `finalize_performance_test` MCP tool
 * and (from M3) the one-shot Runner.
 *
 * It owns everything after evidence collection: metric normalization, the
 * evidence gate, `status`/`gate` separation, findings, `report.json`, and
 * `report.md`. The caller only supplies the collected facts; copying
 * evidence and workspace guards stay with the caller because they are
 * tool/workspace concerns.
 */
export async function finalizeRun(
  input: FinalizeRunInput,
  deps: FinalizeRunDependencies,
): Promise<FinalizeRunOutcome> {
  const normalizedMetrics = normalizeMetricResults(input.metrics);
  const metricEvaluation = evaluateMetricEvidence(input.plan, normalizedMetrics);
  const interrupted =
    input.interrupted ?? input.actions.some((action) => actionFailed(action.outcome));

  const metricFailures = normalizedMetrics
    .map((metric, index) => ({
      name: metric.name,
      verdict: metricEvaluation.verdicts[index] ?? "unknown",
    }))
    .filter((entry) => entry.verdict === "fail")
    .map((entry) => entry.name);

  let captured: FinalizeCapture | null = null;

  const outcome = await deps.runStore.tryFinalize(input.runId, {
    mutate: async (current): Promise<TestRun> => {
      const startedAt = current.startedAt;
      const endedAt = deps.now().toISOString();
      const evidence = normalizeDiagnostics(
        input.diagnostics,
        startedAt,
        endedAt,
      );
      // Never persist an absolute log path supplied via diagnostics.logPath.
      if (
        typeof evidence.logs.path === "string" &&
        !isSafeRunRelative(evidence.logs.path)
      ) {
        evidence.logs = { ...evidence.logs, path: undefined };
      }

      const impact = classifyDiagnosticImpact(evidence);
      const resolved = deriveRunOutcome({
        requestedStatus: input.requestedStatus,
        diagnosticsImpact: impact,
        missingEvidence: metricEvaluation.gaps.map((gap) => gap.code),
        metricVerdicts: metricEvaluation.verdicts,
        interrupted,
      });

      const actionRecords = input.actions.map((action) =>
        pickAction(action, input.plan),
      );

      const newEvidence: TestRun["evidence"] = {
        ...current.evidence,
        screenshotPaths: [
          ...(current.evidence.screenshotPaths ?? []),
          ...(input.copiedByKind?.screenshot ?? []),
        ],
        traceArchivePaths: [
          ...(current.evidence.traceArchivePaths ?? []),
          ...(input.copiedByKind?.traceArchive ?? []),
        ],
      };
      const crashCopy = input.copiedEvidence?.crashReport;
      if (crashCopy) newEvidence.crashReportPath = crashCopy;
      const networkCopy = input.copiedEvidence?.networkCapture;
      if (networkCopy) newEvidence.networkCapturePath = networkCopy;
      const lifecycleCopy = input.copiedEvidence?.lifecycleTrace;
      if (lifecycleCopy) newEvidence.lifecycleTracePath = lifecycleCopy;
      const logCopy = input.copiedEvidence?.deviceLog;
      if (logCopy) newEvidence.deviceLogPath = logCopy;

      const updated: TestRun = {
        ...current,
        status: resolved.status,
        gate: resolved.gate,
        endedAt,
        durationMs: Math.max(
          0,
          new Date(endedAt).getTime() - new Date(startedAt).getTime(),
        ),
        actions: actionRecords,
        metrics: normalizedMetrics.map((metric, index) => ({
          ...metric,
          verdict: metricEvaluation.verdicts[index] ?? metric.verdict,
        })),
        ...(input.passes !== undefined ? { passes: input.passes } : {}),
        ...(input.device !== undefined ? { device: input.device } : {}),
        evidence: newEvidence,
        notes: input.notes ?? current.notes,
      };

      captured = {
        evidence,
        status: resolved.status,
        gate: resolved.gate,
        findings: [],
        result: null as unknown as FinalizedRun,
      };
      return updated;
    },
    acceptStatus: (status) => !TERMINAL_STATUSES.has(status),
    onPersisted: async (persisted) => {
      if (!captured) {
        return;
      }
      const { evidence, status, gate } = captured;

      const findings = [
        ...metricEvaluation.findings,
        ...deriveFindings({
          diagnosticsImpact: classifyDiagnosticImpact(evidence),
          // Evidence-gap findings were already produced above with metric-
          // specific codes; do not duplicate them here.
          missingEvidence: [],
          metricFailures,
          requestedStatus: input.requestedStatus,
          finalStatus: status,
        }),
      ];

      const rawMap: Record<string, string | undefined> = {
        ...(input.fallbackLogPath !== undefined
          ? { deviceLog: input.fallbackLogPath }
          : {}),
        ...(persisted.evidence.deviceLogPath !== undefined
          ? { deviceLog: persisted.evidence.deviceLogPath }
          : {}),
        ...(persisted.evidence.crashReportPath !== undefined
          ? { crashReport: persisted.evidence.crashReportPath }
          : {}),
        ...(persisted.evidence.networkCapturePath !== undefined
          ? { networkCapture: persisted.evidence.networkCapturePath }
          : {}),
        ...(persisted.evidence.lifecycleTracePath !== undefined
          ? { lifecycleTrace: persisted.evidence.lifecycleTracePath }
          : {}),
        ...(input.copiedEvidence ?? {}),
      };
      const reportMap = sanitizeEvidencePaths(rawMap);

      const jsonReport = buildJsonReport(persisted, evidence, {
        plan: input.plan,
        findings,
        evidencePaths: reportMap,
        gate,
      });
      const markdown = renderMarkdownReport(jsonReport);

      await deps.runStore.writeText(
        input.runId,
        "report.json",
        JSON.stringify(jsonReport, null, 2),
      );
      await deps.runStore.writeText(input.runId, "report.md", markdown);

      // Index only after the report exists, so "has report" implies "has
      // index row". A failure here degrades history completeness but must not
      // rewrite the Take's already-final status: the report stays authoritative
      // and `runs` rebuilds the missing row from `run.json`.
      let indexWarning: string | undefined;
      const indexEntry = buildIndexEntry(persisted, input.plan, gate);
      if (indexEntry !== null) {
        try {
          await deps.runStore.appendIndex(indexEntry);
        } catch (error) {
          indexWarning = `运行索引未记录：${error instanceof Error ? error.message : String(error)}`;
        }
      }

      captured = {
        evidence,
        findings,
        status,
        gate,
        result: {
          run: persisted,
          status,
          gate,
          findings,
          evidenceGaps: metricEvaluation.gaps,
          diagnostics: evidence,
          evidencePaths: evidencePathsArray(reportMap),
          jsonReport,
          markdown,
          ...(indexWarning !== undefined ? { indexWarning } : {}),
        },
      };
    },
  });

  if (outcome.kind !== "ok") {
    return outcome;
  }
  const capture = captured as FinalizeCapture | null;
  if (!capture) {
    return { kind: "invalid", reason: "finalize produced no report" };
  }
  return { kind: "ok", result: capture.result };
}
