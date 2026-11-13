import { existsSync, promises as fs } from "node:fs";
import { posix } from "node:path";
import { z } from "zod";
import {
  crashReportSchema,
  lifecycleEventSchema,
  type DiagnosticEvidence,
} from "../diagnostics/normalize.js";
import type {
  ReportEvidencePath,
  ReportEvidencePaths,
  ReportFinding,
} from "../reports/json.js";
import { finalizeRun } from "../runner/finalize.js";
import type { GateResult, TestRun } from "../model/test-run.js";
import type { TestPlan as PlanDocument } from "../model/test-plan.js";
import { runStatusSchema, actionRecordSchema } from "../model/test-run.js";
import type { RegisterOptions } from "./index.js";

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
            verdict: z
              .enum(["pass", "warn", "fail", "unknown", "skipped"])
              .optional(),
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
  /**
   * Threshold gate, independent from `status` (D6). A complete Take with a
   * metric above its fail threshold is `status=completed` + `gate=fail`.
   */
  gate: GateResult;
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

async function loadStoredPlan(
  options: RegisterOptions,
  runId: string,
): Promise<PlanDocument | null> {
  if (!options.runStore) {
    return null;
  }
  const runStore = options.runStore;
  const planRel = "plan.json";
  const planAbs = posix.join(runStore.runDirectory(runId), planRel);
  if (!existsSync(planAbs)) {
    return null;
  }
  try {
    const text = await fs.readFile(planAbs, "utf8");
    return JSON.parse(text) as PlanDocument;
  } catch {
    return null;
  }
}

/**
 * Build a one-sentence, human-readable summary that the tool surfaces to
 * Claude. It always identifies the run id, the final status, the gate, and
 * the most notable stability signal.
 */
function buildSummary(
  result: {
    runId: string;
    status: TestRun["status"];
    gate: GateResult;
    evidencePaths: ReportEvidencePath[];
    findings: ReportFinding[];
    diagnostics: DiagnosticEvidence;
  },
): string {
  const hasNewCrash = result.findings.some((finding) => finding.code === "new-crash");
  const hasUnavailableDiagnostics = result.findings.some((finding) =>
    finding.code.endsWith("-unavailable"),
  );
  const failureReasons = result.findings
    .filter((finding) => finding.severity === "failure")
    .map((finding) => finding.code);
  const evidenceCount = result.evidencePaths.length;
  if (hasNewCrash) {
    return `Run ${result.runId} ended at ${result.status} (gate: ${result.gate}): new crash detected during the run.`;
  }
  if (failureReasons.length > 0) {
    return `Run ${result.runId} ended at ${result.status} (gate: ${result.gate}) due to: ${failureReasons.join(", ")}.`;
  }
  if (hasUnavailableDiagnostics) {
    return `Run ${result.runId} ended at ${result.status} (gate: ${result.gate}): diagnostics incomplete (${result.findings.length} caveats).`;
  }
  if (result.status === "completed") {
    return `Run ${result.runId} completed with gate ${result.gate} and ${evidenceCount} piece(s) of evidence saved.`;
  }
  return `Run ${result.runId} ended at ${result.status} (gate: ${result.gate}).`;
}

/**
 * Shared handler for both the production MCP tool and the test harness.
 *
 * The handler is a thin adapter around `finalizeRun`: it validates input,
 * loads the stored plan, guards the workspace, copies caller-supplied
 * evidence into the run directory, and maps the shared outcome to tool
 * results or structured errors.
 */
export async function finalizePerformanceTest(
  rawInput: unknown,
  options: RegisterOptions,
): Promise<HandlerResult> {
  if (!options.runStore) {
    return {
      error:
        "finalize_performance_test 缺少工作区 runStore；请先调用 initialize_performance_workspace。",
    };
  }
  const runStore = options.runStore;
  const parsed = finalizeInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      error: `finalize_performance_test 输入校验失败：${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    };
  }
  const input = parsed.data;

  if (input.requestedStatus === "prepared" || input.requestedStatus === "running") {
    return {
      error: `finalize_performance_test refuses requestedStatus "${input.requestedStatus}"; supply a terminal status (completed, partial, failed, invalid, or cancelled).`,
    };
  }

  const plan = await loadStoredPlan(options, input.runId);

  const copiedEvidence: ReportEvidencePaths = {};
  const copiedByKind: Record<string, string[]> = {};
  const pushCopy = (kind: string, relativePath: string): void => {
    copiedEvidence[kind] = relativePath;
    if (kind === "screenshot" || kind === "traceArchive") {
      const list = copiedByKind[kind] ?? [];
      list.push(relativePath);
      copiedByKind[kind] = list;
    }
  };

  // Guard first: confirm the run is owned by the current workspace and
  // that the run directory path passes the symlink-escape guard before
  // we copy any evidence or write any report file.
  try {
    await runStore.ensureSafeRun(input.runId);
  } catch (error) {
    return {
      error: `Run ${input.runId} is not safe to finalize: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  // Guard second: refuse to copy any evidence until the run exists and has
  // not already reached a terminal status.
  try {
    const existing = await runStore.read(input.runId);
    if (TERMINAL_STATUSES.has(existing.status)) {
      return {
        error: `Run ${input.runId} already reached terminal status (${existing.status}); refusing to copy or finalize evidence.`,
      };
    }
  } catch (error) {
    return {
      error: `Run ${input.runId} does not exist: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  for (const evidence of input.evidencePaths ?? []) {
    try {
      const relativePath = await runStore.copyEvidence(
        input.runId,
        evidence.sourcePath,
        evidence.relativePath,
      );
      pushCopy(evidence.kind, relativePath);
    } catch (error) {
      return {
        error: `复制证据 ${evidence.kind} 失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  const outcome = await finalizeRun(
    {
      runId: input.runId,
      requestedStatus: input.requestedStatus,
      plan,
      actions: input.actions,
      metrics: input.metrics,
      diagnostics: input.diagnostics,
      copiedEvidence,
      copiedByKind,
      ...(input.diagnostics.logPath !== undefined
        ? { fallbackLogPath: input.diagnostics.logPath }
        : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    },
    { runStore, now: options.now },
  );

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

  const finalized = outcome.result;
  const result = {
    runId: input.runId,
    status: finalized.status,
    gate: finalized.gate,
    runPath: posix.join("run.json"),
    planPath: posix.join("plan.json"),
    jsonPath: posix.join("report.json"),
    markdownPath: posix.join("report.md"),
    evidencePaths: finalized.evidencePaths,
    findings: finalized.findings,
    diagnostics: finalized.diagnostics,
  };

  return {
    ...result,
    summary: buildSummary(result),
  };
}
