import { z } from "zod";
import { HITCHES_PROFILES } from "../recording/types.js";
import {
  actionSchema,
  deviceTargetSchema,
  metricThresholdSchema,
} from "./test-plan.js";

export const runStatusSchema = z.enum([
  "prepared",
  "running",
  "completed",
  "partial",
  "invalid",
  "failed",
  "cancelled",
]);

export type RunStatus = z.infer<typeof runStatusSchema>;

/**
 * Statuses a run can reach exactly once. The history index only stores these:
 * a `prepared`/`running` run is not a finished Take and must not appear in
 * history.
 */
export const terminalRunStatusSchema = z.enum([
  "completed",
  "partial",
  "invalid",
  "failed",
  "cancelled",
]);

export type TerminalRunStatus = z.infer<typeof terminalRunStatusSchema>;

/**
 * `status` and `gate` answer two different questions (D6):
 *
 * - `status` — was this Take valid and trustworthy?
 * - `gate`   — did the measured metrics meet their thresholds?
 *
 * A threshold miss keeps `status=completed` and sets `gate=fail`; it must not
 * pretend the evidence itself was incomplete.
 */
export const gateResultSchema = z.enum(["pass", "warn", "fail", "unknown"]);

export type GateResult = z.infer<typeof gateResultSchema>;

export const metricVerdictSchema = z.enum([
  "pass",
  "warn",
  "fail",
  "unknown",
  "skipped",
]);

export type MetricVerdict = z.infer<typeof metricVerdictSchema>;

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(
  terminalRunStatusSchema.options,
);

const LEGAL_TRANSITIONS: ReadonlyMap<RunStatus, ReadonlySet<RunStatus>> =
  new Map<RunStatus, ReadonlySet<RunStatus>>([
    ["prepared", new Set<RunStatus>(["running", "invalid", "cancelled"])],
    [
      "running",
      new Set<RunStatus>(["completed", "partial", "failed", "cancelled"]),
    ],
  ]);

export function transitionRunStatus(
  current: RunStatus,
  next: RunStatus,
): RunStatus {
  if (TERMINAL_STATUSES.has(current)) {
    throw new Error(
      `Cannot transition from terminal status "${current}" to "${next}".`,
    );
  }
  const allowed = LEGAL_TRANSITIONS.get(current);
  if (!allowed || !allowed.has(next)) {
    throw new Error(`Illegal status transition: "${current}" -> "${next}".`);
  }
  return next;
}

export const actionOutcomeSchema = z.enum([
  "executed",
  "skipped",
  "failed",
  "timeout",
]);
export type ActionOutcome = z.infer<typeof actionOutcomeSchema>;

export const actionRecordSchema = z.object({
  actionId: z.string().min(1),
  // Runtime-validated against the canonical actionSchema so stored runs can
  // never drift from the plan's action grammar.
  action: actionSchema.optional(),
  outcome: actionOutcomeSchema,
  attempts: z.number().int().nonnegative().default(1),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  durationMs: z.number().nonnegative().optional(),
  error: z.string().optional(),
  notes: z.string().optional(),
});
export type ActionRecord = z.infer<typeof actionRecordSchema>;

export const metricResultSchema = z
  .object({
    name: z.string().min(1),
    value: z.unknown().optional(),
    unit: z.string().optional(),
    instrument: z.string().optional(),
    tracePath: z.string().optional(),
    threshold: metricThresholdSchema.optional(),
    verdict: metricVerdictSchema.optional(),
    measuredAt: z.string().datetime().optional(),
  })
  .passthrough();
export type MetricResult = z.infer<typeof metricResultSchema>;

export const diagnosticEvidenceSchema = z.object({
  deviceLogPath: z.string().optional(),
  crashReportPath: z.string().optional(),
  screenshotPaths: z.array(z.string()).default([]),
  traceArchivePaths: z.array(z.string()).default([]),
  networkCapturePath: z.string().optional(),
  lifecycleTracePath: z.string().optional(),
});
export type DiagnosticEvidence = z.infer<typeof diagnosticEvidenceSchema>;

export const appLifecycleEventSchema = z.object({
  phase: z.enum([
    "prelaunch",
    "launching",
    "foreground",
    "background",
    "terminated",
    "crashed",
  ]),
  occurredAt: z.string().datetime(),
  notes: z.string().optional(),
});
export type AppLifecycleEvent = z.infer<typeof appLifecycleEventSchema>;

/**
 * A run-relative POSIX path (e.g. `traces/hitches.trace`).
 *
 * Absolute paths are rejected: `run.json` must stay portable and must never
 * leak the machine that produced it. Mirrors the guard `RunStore` applies to
 * every write.
 */
const runRelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.startsWith("\\") &&
      !/^[A-Za-z]:[\\/]/.test(value) &&
      !value.split(/[\\/]/).includes(".."),
    { message: "must be a run-relative POSIX path" },
  );

/**
 * Recording configuration persisted with a pass (see `reduce-trace-footprint`).
 *
 * `profile` mirrors `HITCHES_PROFILES`; `template` is the xctrace name that was
 * actually passed, so `Animation Hitches` and `Blank` are distinguishable
 * without re-recording. A compact profile also lists the diagnostics it did
 * not record.
 */
const recordingConfigSchema = z.object({
  profile: z.enum(HITCHES_PROFILES),
  template: z.string().min(1),
  instruments: z.array(z.string().min(1)).optional(),
  timeLimit: z.string().min(1),
  /** Effective `during` bound; only the hitches pass has that phase. */
  duringTimeoutMs: z.number().int().positive().optional(),
  /** Effective live-session timeout. Optional for runs predating the field. */
  liveTimeoutMs: z.number().int().positive().optional(),
  /** `full-session`, or the `--window` value once one is used. */
  window: z.string().min(1).optional(),
  missingDiagnostics: z.array(z.string().min(1)).optional(),
});

/**
 * Per-pass execution facts (D8 of `define-perfstage-roadmap`).
 *
 * Issue *details* deliberately stay out: counts are enough to tell whether a
 * pass was stable, and keeping one copy avoids a second fact source. Note that
 * the footprint measurement warning (`could not measure trace size: ...`) is
 * currently only counted here, not persisted verbatim in `run.json`.
 */
export const passRecordSchema = z.object({
  template: z.string().min(1),
  /**
   * Omitted when the recorder wrote the trace outside the run directory (a
   * defensive branch in `runner/execute.ts`). The pass still happened and
   * keeps its counts; only the unusable path is dropped so a successful Take
   * can never fail finalize because of it.
   */
  tracePath: runRelativePathSchema.optional(),
  attempts: z.number().int().positive().default(1),
  durationMs: z.number().nonnegative(),
  /**
   * Recording configuration. Optional because runs created before
   * `reduce-trace-footprint` never recorded it; absence means "predates
   * profiles", which is the full template, not "unknown profile".
   */
  recording: recordingConfigSchema.optional(),
  /**
   * Regular-file bytes inside the trace bundle. Optional because runs created
   * before `reduce-trace-footprint` never recorded it; absence is "not
   * measured", never 0.
   */
  traceBytes: z.number().int().positive().optional(),
  /**
   * Observed xctrace save duration. Optional because a killed session may not
   * expose the save phase; it is never derived from the pass wall clock.
   */
  saveMs: z.number().nonnegative().optional(),
  /** Canonical metric names this pass produced. */
  metrics: z.array(z.string().min(1)).default([]),
  errorCount: z.number().int().nonnegative().default(0),
  warningCount: z.number().int().nonnegative().default(0),
});
export type RunPassRecord = z.infer<typeof passRecordSchema>;

export const testRunSchema = z.object({
  id: z.string().min(1),
  planId: z.string().min(1),
  /**
   * Device facts captured during preflight, used to group baselines by
   * "scenario + device + iOS". Optional on purpose: runs created before
   * `add-baseline-compare` have no `device` key, and a Take that fails
   * before preflight cannot know them. Readers fall back to `plan.json`.
   */
  device: deviceTargetSchema.optional(),
  status: runStatusSchema,
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable().default(null),
  durationMs: z.number().int().nonnegative().optional(),
  repetitions: z.number().int().positive().default(1),
  currentRepetition: z.number().int().nonnegative().default(0),
  /** Threshold gate outcome; independent from `status` (D6). */
  gate: gateResultSchema.optional(),
  actions: z.array(actionRecordSchema).default([]),
  metrics: z.array(metricResultSchema).default([]),
  /**
   * Optional on purpose: a run created before `add-run-history` has no
   * `passes` key, and history must be able to say "not recorded" instead of
   * fabricating zero passes.
   */
  passes: z.array(passRecordSchema).optional(),
  evidence: diagnosticEvidenceSchema.prefault({}),
  lifecycle: z.array(appLifecycleEventSchema).default([]),
  error: z.string().optional(),
  notes: z.string().optional(),
});

export type TestRun = z.infer<typeof testRunSchema>;
