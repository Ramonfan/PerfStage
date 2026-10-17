import { existsSync, promises as fs } from "node:fs";
import { posix } from "node:path";
import { z } from "zod";
import {
  normalizeDiagnostics,
  classifyDiagnosticImpact,
  crashReportSchema,
  lifecycleEventSchema,
  type DiagnosticEvidence,
  type DiagnosticInput,
} from "../diagnostics/normalize.js";
import { deriveFinalStatus } from "../reports/status.js";
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
  type TestRun,
  type ActionRecord,
  runStatusSchema,
  actionRecordSchema,
} from "../model/test-run.js";
import type { TestPlan } from "../model/test-plan.js";
import type { RegisterOptions } from "./index.js";
import {
  deriveFindings,
  deriveMissingMetricEvidence,
  deriveMetricFailures,
} from "../reports/findings.js";

const evidencePathInputSchema = z
  .object({
    kind: z.string().min(1),
    sourcePath: z.string().min(1),
    relativePath: z.string().min(1),
  })
  .strict();

const finalizeDiagnosticsSchema = z
  .object({
    logText: z.string().optional(),
    logPath: z.string().optional(),
    logFilters: z
      .object({
        subsystem: z.string().optional(),
        category: z.string().optional(),
      })
      .optional(),
    crashIdsBefore: z.array(z.string()).optional(),
    crashIdsAfter: z.array(z.string()).optional(),
    crashReports: z.array(crashReportSchema).optional(),
    lifecycle: z.array(lifecycleEventSchema).optional(),
    crashQueryError: z.string().optional(),
    logQueryError: z.string().optional(),
    lifecycleQueryError: z.string().optional(),
  })
  .passthrough();

/**
 * Input shape for `finalize_performance_test`. The handler returns a
 * structured tool error when the run is missing, has already reached a
 * terminal status, or is currently being finalized by another caller.
 */
export const finalizeInputSchema = z
  .object({
    runId: z.string().min(1),
    requestedStatus: runStatusSchema,
    actions: z.array(actionRecordSchema).default([]),
    metrics: z
      .array(
        z
          .object({
            name: z.string().min(1),
            value: z.unknown().optional(),
            unit: z.string().optional(),
            threshold: z
              .object({
                warn: z.number().optional(),
                fail: z.number().optional(),
              })
              .strict()
              .optional(),
            verdict: z.enum(["pass", "warn", "fail", "skipped"]).optional(),
            measuredAt: z.string().datetime().optional(),
          })
          .passthrough(),
      )
      .default([]),
    diagnostics: finalizeDiagnosticsSchema.default({}),
    evidencePaths: z.array(evidencePathInputSchema).optional(),
    notes: z.string().optional(),
  })
  .strict();

export interface FinalizePerformanceTestError {
  error: string;
}

export interface FinalizePerformanceTestResult {
  runId: string;
  status: TestRun["status"];
  runPath: string;
  planPath: string;
  jsonPath: string;
  markdownPath: string;
  /**
   * Array of copied evidence descriptors so callers can use
   * `result.evidencePaths.map(...)`. The same evidence is embedded in
   * `report.json` under `evidencePaths` as a kind → path **map** so
   * `reportJson.evidencePaths.deviceLog` remains the contract that
   * downstream consumers (Task 8 e2e tests) rely on.
   */
  evidencePaths: ReportEvidencePath[];
  findings: ReportFinding[];
  diagnostics: DiagnosticEvidence;
  /** Concise summary suitable for surfacing in the Claude tool result. */
  summary: string;
}

type HandlerResult =
  | FinalizePerformanceTestResult
  | FinalizePerformanceTestError;

const TERMINAL_STATUSES: ReadonlySet<TestRun["status"]> = new Set([
  "completed",
  "partial",
  "invalid",
  "failed",
  "cancelled",
]);

function isError(
  value: HandlerResult,
): value is FinalizePerformanceTestError {
  return typeof (value as { error?: unknown }).error === "string";
}

async function loadStoredPlan(
  options: RegisterOptions,
  runId: string,
): Promise<TestPlan | null> {
  const planRel = "plan.json";
  const planAbs = posix.join(options.runStore.runDirectory(runId), planRel);
  if (!existsSync(planAbs)) {
    return null;
  }
  try {
    const text = await fs.readFile(planAbs, "utf8");
    return JSON.parse(text) as TestPlan;
  } catch {
    return null;
  }
}

/**
 * Resolve the canonical action reference from the plan so the persisted
 * action record always carries the validated, defaulted action shape
 * rather than free-form `z.unknown` blobs.
 */
function pickAction(
  action: z.infer<typeof actionRecordSchema>,
  plan: TestPlan | null,
): ActionRecord {
  const planAction = plan?.actions.find((a) => a.id === action.actionId);
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
 * Build a one-sentence, human-readable summary that the tool surfaces to
 * Claude. It always identifies the run id, the final status, and the most
 * notable stability signal (new crash, jetsam/watchdog, missing evidence,
 * unavailable diagnostics, or simply "clean").
 */
function buildSummary(
  result: {
    runId: string;
    status: TestRun["status"];
    evidencePaths: ReportEvidencePath[];
    findings: ReportFinding[];
    diagnostics: DiagnosticEvidence;
  },
): string {
  const hasNewCrash = result.findings.some((f) => f.code === "new-crash");
  const hasUnavailableDiagnostics = result.findings.some((f) =>
    f.code.endsWith("-unavailable"),
  );
  const failureReasons = result.findings
    .filter((f) => f.severity === "failure")
    .map((f) => f.code);
  const evidenceCount = result.evidencePaths.length;
  if (hasNewCrash) {
    return `Run ${result.runId} ended at ${result.status}: new crash detected during the run.`;
  }
  if (failureReasons.length > 0) {
    return `Run ${result.runId} ended at ${result.status} due to: ${failureReasons.join(", ")}.`;
  }
  if (hasUnavailableDiagnostics) {
    return `Run ${result.runId} ended at ${result.status}: diagnostics incomplete (${result.findings.length} caveats).`;
  }
  if (result.status === "completed") {
    return `Run ${result.runId} completed cleanly with ${evidenceCount} piece(s) of evidence saved.`;
  }
  return `Run ${result.runId} ended at ${result.status}.`;
}

/**
 * Shared handler for both the production MCP tool and the test harness.
 *
 * Concurrency safety: persistence of `run.json` (and the on-persist hook
 * used to write report.json / report.md) is fenced by an exclusive lock
 * file inside the run directory. Concurrent `finalize` calls cannot both
 * pass the prepared-status check: the loser observes `concurrent` and
 * returns a structured tool error.
 */
export async function finalizePerformanceTest(
  rawInput: unknown,
  options: RegisterOptions,
): Promise<HandlerResult> {
  const parsed = finalizeInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      error: `finalize_performance_test 输入校验失败：${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    };
  }
  const input = parsed.data;

  const plan = await loadStoredPlan(options, input.runId);

  // Build the mutator closure inside the constant block so the
  // transition rules apply uniformly regardless of which caller reaches it
  // first.
  const pendingEvidence: Array<{
    kind: string;
    sourcePath: string;
    relativePath: string;
  }> = input.evidencePaths ?? [];
  /**
   * Cumulative run-relative evidence paths keyed by evidence kind. Also
   * stores per-index entries for screenshot_<n> / traceArchive_<n> so the
   * same map shape can describe list evidence faithfully. The map is
   * what gets embedded in the JSON report (matching the e2e contract
   * `reportJson.evidencePaths.deviceLog`).
   */
  const copiedEvidenceMap: ReportEvidencePaths = {};
  /**
   * Per-kind list of run-relative paths. Used internally while building
   * the `updatedRun.evidence` update — list-valued evidence in
   * `TestRun.evidence` (screenshotPaths, traceArchivePaths) still uses
   * parallel arrays, so we keep both views.
   */
  const copiedByKind: Record<string, string[]> = {};
  const pushCopy = (kind: string, rel: string): void => {
    copiedEvidenceMap[kind] = rel;
    if (kind === "screenshot" || kind === "traceArchive") {
      const list = copiedByKind[kind] ?? [];
      list.push(rel);
      copiedByKind[kind] = list;
    }
  };
  const diagnosticInput: DiagnosticInput = {
    ...(input.diagnostics.logText !== undefined
      ? { logText: input.diagnostics.logText }
      : {}),
    ...(input.diagnostics.logPath !== undefined
      ? { logPath: input.diagnostics.logPath }
      : {}),
    ...(input.diagnostics.logFilters !== undefined
      ? { logFilters: input.diagnostics.logFilters }
      : {}),
    ...(input.diagnostics.crashIdsBefore !== undefined
      ? { crashIdsBefore: input.diagnostics.crashIdsBefore }
      : {}),
    ...(input.diagnostics.crashIdsAfter !== undefined
      ? { crashIdsAfter: input.diagnostics.crashIdsAfter }
      : {}),
    ...(input.diagnostics.crashReports !== undefined
      ? { crashReports: input.diagnostics.crashReports }
      : {}),
    ...(input.diagnostics.lifecycle !== undefined
      ? { lifecycle: input.diagnostics.lifecycle }
      : {}),
    ...(input.diagnostics.crashQueryError !== undefined
      ? { crashQueryError: input.diagnostics.crashQueryError }
      : {}),
    ...(input.diagnostics.logQueryError !== undefined
      ? { logQueryError: input.diagnostics.logQueryError }
      : {}),
    ...(input.diagnostics.lifecycleQueryError !== undefined
      ? { lifecycleQueryError: input.diagnostics.lifecycleQueryError }
      : {}),
  };

  // First pass: copy evidence outside the lock so a long copy cannot block
  // other readers. We capture the resulting run-relative paths in
  // `copiedEvidenceMap` (and `copiedByKind` for list evidence) and feed
  // them into the closure.
  for (const evidence of pendingEvidence) {
    try {
      const rel = await options.runStore.copyEvidence(
        input.runId,
        evidence.sourcePath,
        evidence.relativePath,
      );
      pushCopy(evidence.kind, rel);
    } catch (error) {
      return {
        error: `复制证据 ${evidence.kind} 失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  // We deliberately do NOT leak the absolute `input.diagnostics.logPath`
  // into updatedRun.evidence. If the caller supplied a device log we use
  // its derived run-relative location (when it was just copied) or omit it
  // entirely when no copy happened, leaving the absolute path out of any
  // persisted run state.
  const copiedLogRel = copiedEvidenceMap.deviceLog;

  let derivedStatus: TestRun["status"] = "completed";
  let derivedImpact: ReturnType<typeof classifyDiagnosticImpact> = {
    severity: "none",
    reasons: [],
  };
  let derivedMissing: string[] = [];
  let derivedFailures: string[] = [];
  let derivedEvidence: DiagnosticEvidence | null = null;
  let derivedFindings: ReportFinding[] = [];
  let derivedUpdatedRun: TestRun | null = null;
  let derivedMarkdown: string | null = null;
  let derivedJsonReport: JsonReport | null = null;

  const outcome = await options.runStore.tryFinalize(input.runId, {
    mutate: async (current): Promise<TestRun> => {
      const startedAt = current.startedAt;
      const endedAt = options.now().toISOString();
      const evidence: DiagnosticEvidence = normalizeDiagnostics(
        diagnosticInput,
        startedAt,
        endedAt,
      );
      derivedEvidence = evidence;
      const impact = classifyDiagnosticImpact(evidence);
      derivedImpact = impact;

      const missing = deriveMissingMetricEvidence(plan, input.metrics);
      const failures = deriveMetricFailures(input.metrics);
      derivedMissing = missing;
      derivedFailures = failures;

      const status = deriveFinalStatus({
        requestedStatus: input.requestedStatus,
        diagnosticsImpact: impact,
        missingEvidence: missing,
        metricFailures: failures,
      });
      derivedStatus = status;

      const actionRecords: ActionRecord[] = input.actions.map((action) =>
        pickAction(action, plan),
      );

      const newEvidence: TestRun["evidence"] = {
        ...current.evidence,
        screenshotPaths: [
          ...(current.evidence.screenshotPaths ?? []),
          ...(copiedByKind.screenshot ?? []),
        ],
        traceArchivePaths: [
          ...(current.evidence.traceArchivePaths ?? []),
          ...(copiedByKind.traceArchive ?? []),
        ],
      };
      const crashCopy = copiedEvidenceMap.crashReport;
      if (crashCopy) newEvidence.crashReportPath = crashCopy;
      const networkCopy = copiedEvidenceMap.networkCapture;
      if (networkCopy) newEvidence.networkCapturePath = networkCopy;
      const lifecycleCopy = copiedEvidenceMap.lifecycleTrace;
      if (lifecycleCopy) newEvidence.lifecycleTracePath = lifecycleCopy;
      if (copiedLogRel) newEvidence.deviceLogPath = copiedLogRel;

      const updated: TestRun = {
        ...current,
        status,
        endedAt,
        durationMs: Math.max(
          0,
          new Date(endedAt).getTime() - new Date(startedAt).getTime(),
        ),
        actions: actionRecords,
        metrics: input.metrics.map((metric) => ({
          name: metric.name,
          value: metric.value,
          unit: metric.unit,
          threshold: metric.threshold,
          verdict: metric.verdict,
          measuredAt: metric.measuredAt,
        })),
        evidence: newEvidence,
        notes: input.notes ?? current.notes,
      };
      derivedUpdatedRun = updated;
      return updated;
    },
    acceptStatus: (status) => !TERMINAL_STATUSES.has(status),
    onPersisted: async (persisted) => {
      if (!derivedUpdatedRun || persisted.id !== derivedUpdatedRun.id) {
        // Defensive — should never fire because the mutator and the hook
        // share the same closure, but a type guard keeps us honest.
        return;
      }
      const findings = deriveFindings({
        diagnosticsImpact: derivedImpact,
        missingEvidence: derivedMissing,
        metricFailures: derivedFailures,
        requestedStatus: input.requestedStatus,
        finalStatus: derivedStatus,
      });
      derivedFindings = findings;

      const reportMap: ReportEvidencePaths = {
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
        ...copiedEvidenceMap,
      };

      const jsonReport = buildJsonReport(persisted, derivedEvidence!, {
        plan,
        findings,
        evidencePaths: reportMap,
      });
      derivedJsonReport = jsonReport;

      const markdown = renderMarkdownReport(jsonReport);
      derivedMarkdown = markdown;

      await options.runStore.writeText(
        input.runId,
        "report.json",
        JSON.stringify(jsonReport, null, 2),
      );
      await options.runStore.writeText(input.runId, "report.md", markdown);
    },
  });

  if (outcome.kind !== "ok") {
    switch (outcome.kind) {
      case "missing":
        return {
          error: `Run ${input.runId} does not exist.`,
        };
      case "terminal":
        return {
          error: `Run ${input.runId} already reached terminal status (${outcome.status}); refusing to overwrite evidence.`,
        };
      case "concurrent":
        return {
          error: `Run ${input.runId} is being finalized concurrently by another call; please retry.`,
        };
      case "invalid":
        return {
          error: `Failed to finalize ${input.runId}: ${outcome.reason}`,
        };
      default:
        return {
          error: `Run ${input.runId} could not be finalized.`,
        };
    }
  }

  const result = {
    runId: input.runId,
    status: derivedStatus,
    runPath: posix.join("run.json"),
    planPath: posix.join("plan.json"),
    jsonPath: posix.join("report.json"),
    markdownPath: posix.join("report.md"),
    evidencePaths: evidencePathsArray(copiedEvidenceMap),
    findings: derivedFindings,
    diagnostics: derivedEvidence!,
  };

  return {
    ...result,
    summary: buildSummary(result),
  };
}

void isError;
