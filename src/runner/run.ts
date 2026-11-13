import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import type { DeviceDriver } from "../device/types.js";
import type { TestPlan } from "../model/test-plan.js";
import type { GateResult, RunStatus, TestRun } from "../model/test-run.js";
import type { TraceRecorder } from "../recording/types.js";
import { finalizeRun, type FinalizedRun } from "./finalize.js";
import {
  executeTake,
  type PassRecord,
  type TraceAnalyzer,
  type TakeExecution,
} from "./execute.js";
import type { RunStore } from "../storage/runs.js";

/**
 * Run state machine and the shared Take pipeline.
 *
 * Every entry point — the `run_performance_test` MCP tool, the `perfstage run`
 * CLI, and tests — goes through {@link runTake}. That is what keeps the
 * evidence chain identical no matter who starts a Take.
 */

export interface RunDependencies {
  runStore: RunStore;
  now: () => Date;
  device: DeviceDriver;
  recorder: TraceRecorder;
  analyze?: TraceAnalyzer;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  settleMs?: number;
  launchSettleMs?: number;
  memorySettleMs?: number;
  /** Cooldown between recording passes; see `ExecuteTakeDependencies`. */
  passCooldownMs?: number;
  /**
   * Probe the app before recording. Defaults to on for real Takes; the
   * fake-driven tests turn it off because they script the device state.
   */
  healthCheck?: boolean;
  healthCheckSettleMs?: number;
  foregroundTimeoutMs?: number;
  postLaunchSampleMs?: number;
  elementTimeoutMs?: number;
  /** See `ExecuteTakeDependencies.minimumWindowMs`. */
  minimumWindowMs?: number;
}

export interface RunTakeInput {
  runId: string;
  plan: TestPlan;
  deviceId: string;
}

export interface RunTakeSummary {
  runId: string;
  scenarioId: string | null;
  status: RunStatus;
  gate: GateResult;
  deviceId: string;
  metrics: Array<{
    name: string;
    value: unknown;
    unit?: string;
    verdict?: string;
    tracePath?: string;
    samples?: unknown[];
  }>;
  actions: Array<{
    actionId: string;
    outcome: string;
    durationMs?: number;
    error?: string;
  }>;
  passes: Array<{
    template: string;
    tracePath: string;
    attempts: number;
    durationMs: number;
    errorCount: number;
    warningCount: number;
  }>;
  findings: Array<{ code: string; severity: string; message: string }>;
  notes: string[];
  durationMs: number;
  reportPath: string;
  reportMarkdownPath: string;
  repetitionCount: number;
}

export type RunTakeOutcome =
  | { kind: "ok"; summary: RunTakeSummary; finalized: FinalizedRun }
  | { kind: "missing"; runId: string }
  | { kind: "terminal"; runId: string; status: RunStatus }
  | { kind: "invalid"; runId: string; reason: string };

/**
 * Execute a single Take end to end.
 *
 * The run is moved `prepared -> running` before any device I/O, so an
 * abandoned Take is visibly stuck rather than silently indistinguishable from
 * one that never started.
 */
export async function runTake(
  input: RunTakeInput,
  deps: RunDependencies,
): Promise<RunTakeOutcome> {
  const log = deps.log ?? (() => undefined);

  let run: TestRun;
  try {
    run = await deps.runStore.read(input.runId);
  } catch {
    return { kind: "missing", runId: input.runId };
  }

  if (isTerminal(run.status)) {
    return { kind: "terminal", runId: input.runId, status: run.status };
  }

  // ── prepared -> running ────────────────────────────────────────────
  const startedAt = deps.now().toISOString();
  await deps.runStore.write({
    ...run,
    status: "running",
    startedAt,
    repetitions: Math.max(1, input.plan.repetitions),
    currentRepetition: 0,
  });
  log(`run ${input.runId} is running`);

  const runDir = deps.runStore.runDirectory(input.runId);
  await fs.mkdir(runDir, { recursive: true });

  const execution = await executeTake(
    {
      plan: input.plan,
      deviceId: input.deviceId,
      thresholds: thresholdsFromPlan(input.plan),
    },
    {
      device: deps.device,
      recorder: deps.recorder,
      runDir,
      now: deps.now,
      ...(deps.analyze !== undefined ? { analyze: deps.analyze } : {}),
      ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
      ...(deps.log !== undefined ? { log: deps.log } : {}),
      ...(deps.settleMs !== undefined ? { settleMs: deps.settleMs } : {}),
      ...(deps.launchSettleMs !== undefined
        ? { launchSettleMs: deps.launchSettleMs }
        : {}),
      ...(deps.memorySettleMs !== undefined
        ? { memorySettleMs: deps.memorySettleMs }
        : {}),
      ...(deps.passCooldownMs !== undefined
        ? { passCooldownMs: deps.passCooldownMs }
        : {}),
      healthCheck: deps.healthCheck ?? true,
      ...(deps.healthCheckSettleMs !== undefined
        ? { healthCheckSettleMs: deps.healthCheckSettleMs }
        : {}),
      ...(deps.foregroundTimeoutMs !== undefined
        ? { foregroundTimeoutMs: deps.foregroundTimeoutMs }
        : {}),
      ...(deps.postLaunchSampleMs !== undefined
        ? { postLaunchSampleMs: deps.postLaunchSampleMs }
        : {}),
      ...(deps.elementTimeoutMs !== undefined
        ? { elementTimeoutMs: deps.elementTimeoutMs }
        : {}),
      ...(deps.minimumWindowMs !== undefined
        ? { minimumWindowMs: deps.minimumWindowMs }
        : {}),
    },
  );

  // Persist the raw log next to the report. Diagnostics scan the full text;
  // `report.json` drops that body once this file exists, so the report stays
  // small while early-log errors remain visible to the evidence gate.
  if (execution.fullLogText !== undefined && execution.fullLogText.length > 0) {
    await deps.runStore
      .writeText(input.runId, "device.log", execution.fullLogText)
      .catch(() => undefined);
  }

  const diagnostics = {
    ...execution.diagnostics,
    ...(execution.fullLogText !== undefined
      ? { logPath: "device.log" }
      : {}),
  };

  const requestedStatus: RunStatus =
    execution.fatalError !== undefined ? "failed" : "completed";

  const finalized = await finalizeRun(
    {
      runId: input.runId,
      requestedStatus,
      plan: input.plan,
      actions: execution.actions,
      metrics: withMetricThresholds(execution.metrics, input.plan),
      diagnostics,
      ...(execution.fullLogText !== undefined
        ? { fallbackLogPath: "device.log" }
        : {}),
      notes: summarizeNotes(execution),
      ...(execution.fatalError !== undefined ? { interrupted: true } : {}),
    },
    { runStore: deps.runStore, now: deps.now },
  );

  if (finalized.kind !== "ok") {
    return {
      kind: "invalid",
      runId: input.runId,
      reason:
        finalized.kind === "terminal"
          ? `run already terminal (${finalized.status})`
          : finalized.kind === "missing"
            ? "run disappeared during finalize"
            : finalized.kind === "concurrent"
              ? "another writer modified the run"
              : finalized.reason,
    };
  }

  return {
    kind: "ok",
    finalized: finalized.result,
    summary: buildSummary({
      runId: input.runId,
      plan: input.plan,
      deviceId: input.deviceId,
      execution,
      finalized: finalized.result,
      runDir,
    }),
  };
}

function isTerminal(status: RunStatus): boolean {
  return (
    status === "completed" ||
    status === "partial" ||
    status === "invalid" ||
    status === "failed" ||
    status === "cancelled"
  );
}

/** Collect per-metric thresholds declared by the plan. */
export function thresholdsFromPlan(
  plan: TestPlan,
): Record<string, { warn?: number; fail?: number }> {
  const map: Record<string, { warn?: number; fail?: number }> = {};
  for (const metric of plan.metrics) {
    if (metric.threshold === undefined) continue;
    map[metric.name] = metric.threshold;
  }
  return map;
}

/**
 * Attach each plan threshold to its measured metric.
 *
 * The evidence gate already merges plan thresholds, but persisting them on the
 * metric makes a stored `run.json` self-describing: a reader can tell why a
 * metric was `fail` without loading the plan from a month ago.
 */
function withMetricThresholds(
  metrics: TakeExecution["metrics"],
  plan: TestPlan,
): TakeExecution["metrics"] {
  const thresholds = thresholdsFromPlan(plan);
  return metrics.map((metric) => {
    // Metric names can arrive as aliases (`memory`) before normalization.
    const direct = thresholds[metric.name];
    if (direct !== undefined) {
      return metric.threshold === undefined
        ? { ...metric, threshold: direct }
        : metric;
    }
    return metric;
  });
}

function summarizeNotes(execution: TakeExecution): string | undefined {
  const notes = [...execution.notes];
  if (execution.repetitions > 1) {
    notes.unshift(`median of ${execution.repetitions} repetitions`);
  }
  return notes.length === 0 ? undefined : notes.join(" | ");
}

function buildSummary(input: {
  runId: string;
  plan: TestPlan;
  deviceId: string;
  execution: TakeExecution;
  finalized: FinalizedRun;
  runDir: string;
}): RunTakeSummary {
  const { runId, plan, deviceId, execution, finalized, runDir } = input;
  return {
    runId,
    scenarioId: plan.source === "scenario" ? (plan.id ?? null) : null,
    status: finalized.status,
    gate: finalized.gate,
    deviceId,
    metrics: finalized.run.metrics.map((metric) => ({
      name: metric.name,
      value: metric.value,
      ...(metric.unit !== undefined ? { unit: metric.unit } : {}),
      ...(metric.verdict !== undefined ? { verdict: metric.verdict } : {}),
      ...(metric.tracePath !== undefined ? { tracePath: metric.tracePath } : {}),
      ...(Array.isArray(metric.samples) ? { samples: metric.samples } : {}),
    })),
    actions: finalized.run.actions.map((action) => ({
      actionId: action.actionId,
      outcome: action.outcome,
      ...(action.durationMs !== undefined ? { durationMs: action.durationMs } : {}),
      ...(action.error !== undefined ? { error: action.error } : {}),
    })),
    passes: execution.passes.map((pass) => passSummary(pass)),
    findings: finalized.findings.map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      message: finding.message,
    })),
    notes: execution.notes,
    durationMs: finalized.run.durationMs ?? 0,
    reportPath: resolve(runDir, "report.json"),
    reportMarkdownPath: resolve(runDir, "report.md"),
    repetitionCount: execution.repetitions,
  };
}

function passSummary(pass: PassRecord): RunTakeSummary["passes"][number] {
  return {
    template: pass.template,
    tracePath: pass.tracePath,
    attempts: pass.attempts,
    durationMs: pass.durationMs,
    errorCount: pass.issues.filter((issue) => issue.level === "error").length,
    warningCount: pass.issues.filter((issue) => issue.level === "warning").length,
  };
}
