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

/**
 * Mapping from evidence kind (e.g. `deviceLog`, `crashReport`,
 * `networkCapture`, `screenshot`, `traceArchive`) to its **run-relative**
 * POSIX path. The accompanying Task-8 contract guarantees that
 * `reportJson.evidencePaths.deviceLog` is a string, never an array or
 * object, and never contains an absolute source path. Helpers that need a
 * richer shape can call `evidencePathsArray(report)` to expand this map.
 */
export type ReportEvidencePaths = Record<string, string>;

export interface ReportEvidencePath {
  /** Kind of evidence, e.g. `deviceLog`, `screenshot`, `crashReport`. */
  kind: string;
  /** Run-relative POSIX path. The original absolute source path is never stored here. */
  relativePath: string;
}

export interface JsonReport {
  run: TestRun;
  /**
   * The resolved plan. The minimal 2-arg `buildJsonReport` cannot resolve
   * the plan on its own (no filesystem dependency), so the tool layer
   * supplies it via `BuildJsonReportOptions.plan`.
   */
  plan: TestPlan | null;
  actions: ReportAction[];
  metrics: ReportMetric[];
  diagnostics: DiagnosticEvidence;
  findings: ReportFinding[];
  status: TestRun["status"];
  /**
   * Map of evidence-kind → run-relative POSIX path. Always includes
   * `deviceLog` when a device log was supplied and copied into the run
   * directory; absent entries are simply omitted from the map.
   */
  evidencePaths: ReportEvidencePaths;
  generatedAt: string;
}

export function evidencePathsArray(
  map: ReportEvidencePaths | undefined,
): ReportEvidencePath[] {
  if (!map) return [];
  return Object.entries(map).map(([kind, relativePath]) => ({
    kind,
    relativePath,
  }));
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

function deriveEvidencePathMap(run: TestRun): ReportEvidencePaths {
  const evidence = run.evidence;
  const paths: ReportEvidencePaths = {};
  if (typeof evidence.deviceLogPath === "string") {
    paths.deviceLog = evidence.deviceLogPath;
  }
  if (typeof evidence.crashReportPath === "string") {
    paths.crashReport = evidence.crashReportPath;
  }
  if (typeof evidence.networkCapturePath === "string") {
    paths.networkCapture = evidence.networkCapturePath;
  }
  if (typeof evidence.lifecycleTracePath === "string") {
    paths.lifecycleTrace = evidence.lifecycleTracePath;
  }
  for (const [i, p] of (evidence.screenshotPaths ?? []).entries()) {
    if (typeof p === "string") {
      paths[`screenshot_${i}`] = p;
    }
  }
  for (const [i, p] of (evidence.traceArchivePaths ?? []).entries()) {
    if (typeof p === "string") {
      paths[`traceArchive_${i}`] = p;
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
  const evidencePaths: ReportEvidencePaths = options.evidencePaths
    ? { ...options.evidencePaths }
    : deriveEvidencePathMap(run);
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
    evidencePaths,
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
   * Inject run-relative evidence paths as a kind→path map. When
   * omitted, the report falls back to whatever `run.evidence` exposes.
   */
  evidencePaths?: ReportEvidencePaths;
}
