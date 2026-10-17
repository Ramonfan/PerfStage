import type { TestPlan } from "../model/test-plan.js";
import type { TestRun, MetricResult, ActionRecord } from "../model/test-run.js";
import type { DiagnosticEvidence, DiagnosticImpact } from "../diagnostics/normalize.js";

/**
 * The severity of a finding. Matches the values emitted by
 * `classifyDiagnosticImpact` so callers can render them consistently.
 */
export type ReportFindingSeverity = DiagnosticImpact["severity"];

export interface ReportMetric {
  name: string;
  value: unknown;
  unit?: string;
  threshold?: Record<string, unknown>;
  verdict?: string;
  measuredAt?: string;
  raw?: unknown;
}

export interface ReportAction {
  actionId: string;
  outcome: ActionRecord["outcome"];
  attempts: number;
  startedAt: string;
  /** Always rendered. `"unknown"` when the run was interrupted. */
  endedAt: string | null;
  durationMs?: number;
  error?: string;
  notes?: string;
}

export interface ReportFinding {
  /**
   * Stable machine-readable identifier such as `new-crash`, `jetsam`,
   * `metric:hitches`, or `status-downgrade`. Callers should branch on
   * `code` rather than on the human-readable `message`.
   */
  code: string;
  /** Severity bucket inherited from `DiagnosticImpact` (or `none` for neutral items). */
  severity: ReportFindingSeverity;
  message: string;
}

export interface ReportEvidencePath {
  /** Kind of evidence, e.g. `deviceLog`, `screenshot`, `crashReport`. */
  kind: string;
  /** Run-relative POSIX path. The original absolute source path is never stored here. */
  relativePath: string;
}

export interface JsonReport {
  run: TestRun;
  /**
   * The resolved plan. The minimal 2-arg `buildJsonReport` derives a stub
   * from the run; callers that need the full plan (e.g. to render bundle id
   * and actions) should hydrate this field via the prepare tool layer.
   */
  plan: TestPlan | null;
  actions: ReportAction[];
  metrics: ReportMetric[];
  diagnostics: DiagnosticEvidence;
  findings: ReportFinding[];
  status: TestRun["status"];
  evidencePaths: ReportEvidencePath[];
  generatedAt: string;
}

function toReportMetric(metric: MetricResult): ReportMetric {
  const { name, value, unit, threshold, verdict, measuredAt, ...rest } = metric;
  const raw = Object.keys(rest).length > 0 ? rest : undefined;
  return { name, value, unit, threshold, verdict, measuredAt, raw };
}

function toReportAction(action: ActionRecord): ReportAction {
  const { actionId, outcome, attempts, startedAt, endedAt, durationMs, error, notes } =
    action;
  // Always emit an `endedAt`. Absent entries become the literal string
  // `"unknown"` so JSON consumers cannot double-interpret null values.
  const normalizedEnd: string | null =
    typeof endedAt === "string" ? endedAt : "unknown";
  return {
    actionId,
    outcome,
    attempts,
    startedAt,
    endedAt: normalizedEnd,
    durationMs,
    error,
    notes,
  };
}

function deriveEvidencePaths(run: TestRun): ReportEvidencePath[] {
  const evidence = run.evidence;
  const paths: ReportEvidencePath[] = [];
  if (typeof evidence.deviceLogPath === "string") {
    paths.push({ kind: "deviceLog", relativePath: evidence.deviceLogPath });
  }
  if (typeof evidence.crashReportPath === "string") {
    paths.push({
      kind: "crashReport",
      relativePath: evidence.crashReportPath,
    });
  }
  if (typeof evidence.networkCapturePath === "string") {
    paths.push({
      kind: "networkCapture",
      relativePath: evidence.networkCapturePath,
    });
  }
  if (typeof evidence.lifecycleTracePath === "string") {
    paths.push({
      kind: "lifecycleTrace",
      relativePath: evidence.lifecycleTracePath,
    });
  }
  for (const p of evidence.screenshotPaths ?? []) {
    if (typeof p === "string") {
      paths.push({ kind: "screenshot", relativePath: p });
    }
  }
  for (const p of evidence.traceArchivePaths ?? []) {
    if (typeof p === "string") {
      paths.push({ kind: "traceArchive", relativePath: p });
    }
  }
  return paths;
}

/**
 * Public, pure 2-arg API. Builds the structural portion of the report
 * directly from the run and the normalized diagnostics. Anything that
 * requires filesystem lookups (e.g. resolving the full TestPlan) must be
 * supplied by the caller via the returned object's mutable fields.
 *
 * `findings`, `evidencePaths`, and timestamp normalization are derived from
 * the inputs in a single pass so the tool layer can compose richer reports
 * on top of this base.
 */
export function buildJsonReport(
  run: TestRun,
  diagnostics: DiagnosticEvidence,
  options: BuildJsonReportOptions = {},
): JsonReport {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const callerPlan = options.plan ?? null;
  return {
    run: {
      ...run,
      endedAt: run.endedAt ?? "unknown",
    },
    plan: callerPlan,
    actions: run.actions.map(toReportAction),
    metrics: run.metrics.map(toReportMetric),
    diagnostics,
    findings: options.findings ? [...options.findings] : [],
    status: run.status,
    evidencePaths: options.evidencePaths
      ? options.evidencePaths.map((p) => ({ ...p }))
      : deriveEvidencePaths(run),
    generatedAt,
  };
}

export interface BuildJsonReportOptions {
  /**
   * Override the generatedAt timestamp. Defaults to `new Date().toISOString()`.
   */
  generatedAt?: string;
  /**
   * Inject the resolved plan. The minimal 2-arg API cannot resolve the
   * plan on its own (no filesystem dependency), so the tool layer is
   * responsible for providing it.
   */
  plan?: TestPlan | null;
  /**
   * Inject pre-derived findings. Defaults to an empty list so downstream
   * code can always rely on `findings` being defined.
   */
  findings?: ReportFinding[];
  /**
   * Inject run-relative evidence paths. When omitted, the report falls
   * back to whatever `run.evidence` exposes (also run-relative).
   */
  evidencePaths?: ReportEvidencePath[];
}
