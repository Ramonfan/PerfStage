import { z } from "zod";
import { actionSchema, metricThresholdSchema } from "./test-plan.js";

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

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "completed",
  "partial",
  "invalid",
  "failed",
  "cancelled",
]);

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

export const testRunSchema = z.object({
  id: z.string().min(1),
  planId: z.string().min(1),
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
  evidence: diagnosticEvidenceSchema.prefault({}),
  lifecycle: z.array(appLifecycleEventSchema).default([]),
  error: z.string().optional(),
  notes: z.string().optional(),
});

export type TestRun = z.infer<typeof testRunSchema>;
