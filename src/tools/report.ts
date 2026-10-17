import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { posix } from "node:path";
import { z } from "zod";
import {
  normalizeDiagnostics,
  classifyDiagnosticImpact,
  type DiagnosticEvidence,
  type DiagnosticInput,
} from "../diagnostics/normalize.js";
import { deriveFinalStatus } from "../reports/status.js";
import { buildJsonReport, type JsonReport, type ReportFinding } from "../reports/json.js";
import { renderMarkdownReport } from "../reports/markdown.js";
import {
  type TestRun,
  type ActionRecord,
  runStatusSchema,
} from "../model/test-run.js";
import type { TestPlan } from "../model/test-plan.js";
import type { RegisterOptions } from "./index.js";

const actionRecordSchema = z
  .object({
    actionId: z.string().min(1),
    action: z.unknown().optional(),
    outcome: z.enum(["executed", "skipped", "failed", "timeout"]),
    attempts: z.number().int().nonnegative().default(1),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().nullable().optional(),
    durationMs: z.number().nonnegative().optional(),
    error: z.string().optional(),
    notes: z.string().optional(),
  })
  .passthrough();

const metricResultSchema = z
  .object({
    name: z.string().min(1),
    value: z.unknown().optional(),
    unit: z.string().optional(),
    threshold: z
      .object({ warn: z.number().optional(), fail: z.number().optional() })
      .strict()
      .optional(),
    verdict: z.enum(["pass", "warn", "fail", "skipped"]).optional(),
    measuredAt: z.string().datetime().optional(),
  })
  .passthrough();

const diagnosticInputSchema = z
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
    crashReports: z.array(z.unknown()).optional(),
    lifecycle: z.array(z.unknown()).optional(),
    crashQueryError: z.string().optional(),
    logQueryError: z.string().optional(),
    lifecycleQueryError: z.string().optional(),
  })
  .passthrough();

const evidencePathSchema = z
  .object({
    kind: z.string().min(1),
    sourcePath: z.string().min(1),
    relativePath: z.string().min(1),
  })
  .strict();

/**
 * Input shape for `finalize_performance_test`. The handler returns a structured
 * tool error when the run is missing or has already reached a terminal status
 * so existing evidence is never overwritten.
 */
export const finalizeInputSchema = z
  .object({
    runId: z.string().min(1),
    requestedStatus: runStatusSchema,
    actions: z.array(actionRecordSchema).default([]),
    metrics: z.array(metricResultSchema).default([]),
    diagnostics: diagnosticInputSchema.default({}),
    evidencePaths: z.array(evidencePathSchema).optional(),
    notes: z.string().optional(),
  })
  .strict();

export interface FinalizePerformanceTestError {
  error: string;
}

export interface FinalizeEvidencePath {
  kind: string;
  sourcePath?: string;
  relativePath: string;
}

export interface FinalizePerformanceTestResult {
  runId: string;
  status: TestRun["status"];
  runPath: string;
  planPath: string;
  jsonPath: string;
  markdownPath: string;
  evidencePaths: FinalizeEvidencePath[];
  findings: ReportFinding[];
  diagnostics: DiagnosticEvidence;
}

type HandlerResult =
  | FinalizePerformanceTestResult
  | FinalizePerformanceTestError;

const TERMINAL_STATUSES = new Set<TestRun["status"]>([
  "completed",
  "partial",
  "invalid",
  "failed",
  "cancelled",
]);

function isError(value: HandlerResult): value is FinalizePerformanceTestError {
  return typeof (value as { error?: unknown }).error === "string";
}

async function loadStoredPlan(
  options: RegisterOptions,
  runId: string,
): Promise<TestPlan | undefined> {
  const planRel = "plan.json";
  const planAbs = posix.join(options.runStore.runDirectory(runId), planRel);
  if (!existsSync(planAbs)) {
    return undefined;
  }
  try {
    const text = await fs.readFile(planAbs, "utf8");
    const parsed = JSON.parse(text) as TestPlan;
    return parsed;
  } catch {
    return undefined;
  }
}

function isRunStartable(status: TestRun["status"]): boolean {
  return !TERMINAL_STATUSES.has(status);
}

function pickAction(
  action: z.infer<typeof actionRecordSchema>,
  plan: TestPlan | undefined,
): ActionRecord {
  const planAction = plan?.actions.find((a) => a.id === action.actionId);
  return {
    actionId: action.actionId,
    ...(planAction !== undefined ? { action: planAction } : {}),
    outcome: action.outcome,
    attempts: action.attempts ?? 1,
    startedAt: action.startedAt,
    endedAt: action.endedAt ?? null,
    durationMs: action.durationMs,
    error: action.error,
    notes: action.notes,
  };
}

function deriveMissingEvidence(
  plan: TestPlan | undefined,
  metrics: z.infer<typeof metricResultSchema>[],
): string[] {
  const missing: string[] = [];
  if (plan) {
    const collected = new Set(metrics.map((metric) => metric.name));
    for (const requested of plan.metrics) {
      if (!collected.has(requested.name)) {
        missing.push(`metric:${requested.name}`);
      }
    }
  }
  return missing;
}

function deriveMetricFailures(
  metrics: z.infer<typeof metricResultSchema>[],
): string[] {
  return metrics
    .filter((metric) => metric.verdict === "fail")
    .map((metric) => metric.name);
}

function deriveFindings(
  status: TestRun["status"],
  impact: ReturnType<typeof classifyDiagnosticImpact>,
  requestedStatus: TestRun["status"],
  downgradedFromCompleted: boolean,
): ReportFinding[] {
  const findings: ReportFinding[] = [];
  for (const reason of impact.reasons) {
    findings.push({
      category: "diagnostics",
      message: reason,
    });
  }
  if (downgradedFromCompleted && requestedStatus === "completed") {
    findings.push({
      category: "status-downgrade",
      message: `最终状态由 completed 降级为 ${status}。`,
    });
  }
  return findings;
}

/**
 * Shared handler for both the production MCP tool and the test harness.
 *
 * The handler is intentionally conservative: it refuses to overwrite a run
 * that has already reached a terminal status, performs evidence copying via
 * the safe run store, writes the JSON and Markdown reports through helpers
 * provided by the reports layer, and returns POSIX-style paths relative to
 * the run directory.
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

  let existing: TestRun;
  try {
    existing = await options.runStore.read(input.runId);
  } catch (error) {
    return {
      error: `运行 ${input.runId} 不存在：${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (!isRunStartable(existing.status)) {
    return {
      error: `Run ${input.runId} already reached terminal status (${existing.status}); refusing to overwrite evidence.`,
    };
  }

  const plan = await loadStoredPlan(options, input.runId);

  const actionRecords: ActionRecord[] = input.actions.map((action) =>
    pickAction(action, plan),
  );

  const evidenceCopied: FinalizeEvidencePath[] = [];
  const copiedPaths: Record<string, string> = {};
  for (const evidence of input.evidencePaths ?? []) {
    try {
      const rel = await options.runStore.copyEvidence(
        input.runId,
        evidence.sourcePath,
        evidence.relativePath,
      );
      evidenceCopied.push({
        kind: evidence.kind,
        sourcePath: evidence.sourcePath,
        relativePath: rel,
      });
      copiedPaths[evidence.kind] = rel;
    } catch (error) {
      return {
        error: `复制证据 ${evidence.kind} 失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  // If the caller logs an explicit log path but didn't list it in
  // evidencePaths, still record it for the report.
  if (
    typeof input.diagnostics.logPath === "string" &&
    input.diagnostics.logPath.length > 0
  ) {
    copiedPaths.deviceLog = input.diagnostics.logPath;
  }

  const startedAt = existing.startedAt;
  const endedAt = options.now().toISOString();

  const diagnosticInput: DiagnosticInput = {
    logText: input.diagnostics.logText,
    logPath: input.diagnostics.logPath,
    logFilters: input.diagnostics.logFilters,
    crashIdsBefore: input.diagnostics.crashIdsBefore,
    crashIdsAfter: input.diagnostics.crashIdsAfter,
    crashReports: (input.diagnostics.crashReports ?? []) as never,
    lifecycle: (input.diagnostics.lifecycle ?? []) as never,
    crashQueryError: input.diagnostics.crashQueryError,
    logQueryError: input.diagnostics.logQueryError,
    lifecycleQueryError: input.diagnostics.lifecycleQueryError,
  };
  const evidence: DiagnosticEvidence = normalizeDiagnostics(
    diagnosticInput,
    startedAt,
    endedAt,
  );
  const impact = classifyDiagnosticImpact(evidence);

  const missing = deriveMissingEvidence(plan, input.metrics);
  const failures = deriveMetricFailures(input.metrics);

  const status = deriveFinalStatus({
    requestedStatus: input.requestedStatus,
    diagnosticsImpact: impact,
    missingEvidence: missing,
    metricFailures: failures,
  });

  const findings = deriveFindings(
    status,
    impact,
    input.requestedStatus,
    input.requestedStatus === "completed" && status !== "completed",
  );

  const updatedRun: TestRun = {
    ...existing,
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
    evidence: {
      ...existing.evidence,
      ...(input.diagnostics.logPath !== undefined
        ? { deviceLogPath: input.diagnostics.logPath }
        : {}),
      ...(input.diagnostics.logPath === undefined &&
      evidenceCopied.find((e) => e.kind === "deviceLog") !== undefined
        ? {}
        : {}),
    },
    notes: input.notes ?? existing.notes,
  };

  try {
    await options.runStore.write(updatedRun);
  } catch (error) {
    return {
      error: `写入 run.json 失败：${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const jsonReport: JsonReport = buildJsonReport(
    updatedRun,
    plan ?? ({} as TestPlan),
    evidence,
    findings,
    copiedPaths,
  );
  const markdown = renderMarkdownReport(jsonReport);

  try {
    await options.runStore.writeText(
      input.runId,
      "report.json",
      JSON.stringify(jsonReport, null, 2),
    );
  } catch (error) {
    return {
      error: `写入 report.json 失败：${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  try {
    await options.runStore.writeText(input.runId, "report.md", markdown);
  } catch (error) {
    return {
      error: `写入 report.md 失败：${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  return {
    runId: input.runId,
    status,
    runPath: posix.join("run.json"),
    planPath: posix.join("plan.json"),
    jsonPath: posix.join("report.json"),
    markdownPath: posix.join("report.md"),
    evidencePaths: evidenceCopied,
    findings,
    diagnostics: evidence,
  };
}

void isError;
