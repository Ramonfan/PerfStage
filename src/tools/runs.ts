import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  runStatusSchema,
  terminalRunStatusSchema,
  type RunStatus,
  type TestRun,
} from "../model/test-run.js";
import {
  RUN_FILE_NAME,
  type RunIndexEntry,
  type RunIndexMetric,
  type RunStore,
} from "../storage/runs.js";
import type { RegisterOptions } from "./index.js";

/**
 * Input shared by the MCP tool `list_performance_runs` and the CLI
 * `perfstage runs` command. Both surfaces must answer identically, so the
 * validation and defaults live here rather than in the shells.
 */
export const runsQuerySchema = z.object({
  scenarioId: z.string().min(1).optional(),
  status: runStatusSchema.optional(),
  limit: z.number().int().min(1).max(200).default(20),
});

export type RunsQuery = z.infer<typeof runsQuerySchema>;

export interface RunHistoryEntry {
  runId: string;
  planId: string;
  /** `null` for ad-hoc plans and for runs whose `plan.json` is missing. */
  scenarioId: string | null;
  /** `null` when `plan.json` is missing (legacy or manually edited run). */
  deviceId: string | null;
  status: RunStatus;
  gate?: string;
  startedAt: string;
  endedAt: string | null;
  durationMs?: number;
  /** `null` means the run predates pass persistence; never fabricate 0. */
  passCount: number | null;
  metrics: RunIndexMetric[];
}

export interface ListPerformanceRunsResult {
  runs: RunHistoryEntry[];
  /** Runs on disk but missing from the index (rebuilt from run.json). */
  unindexed: number;
  /** Unparsable index lines that were skipped. */
  invalidLines: number;
  /** Ghost index rows and run directories without a terminal run.json. */
  skipped: number;
}

export interface ListPerformanceRunsError {
  error: string;
}

type HandlerResult = ListPerformanceRunsResult | ListPerformanceRunsError;

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(
  terminalRunStatusSchema.options,
);

function toHistoryEntry(entry: RunIndexEntry): RunHistoryEntry {
  return {
    runId: entry.runId,
    planId: entry.planId,
    scenarioId: entry.scenarioId,
    deviceId: entry.deviceId,
    status: entry.status,
    ...(entry.gate !== undefined ? { gate: entry.gate } : {}),
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
    passCount: entry.passCount,
    metrics: entry.metrics,
  };
}

function metricDigest(run: TestRun): RunIndexMetric[] {
  return run.metrics.map((metric) => ({
    name: metric.name,
    ...(metric.value !== undefined ? { value: metric.value } : {}),
    ...(metric.unit !== undefined ? { unit: metric.unit } : {}),
    ...(metric.verdict !== undefined ? { verdict: metric.verdict } : {}),
  }));
}

interface StoredPlanFacts {
  scenarioId: string | null;
  deviceId: string | null;
}

/**
 * Read the plan snapshot from a run directory, tolerating missing or corrupt
 * files: legacy runs still have `run.json`, which is enough to list them.
 */
async function readPlanFacts(
  store: RunStore,
  runId: string,
): Promise<StoredPlanFacts> {
  try {
    const raw = await readFile(
      join(store.runDirectory(runId), "plan.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as {
      source?: unknown;
      id?: unknown;
      device?: { id?: unknown };
    };
    const scenarioId =
      parsed.source === "scenario" && typeof parsed.id === "string"
        ? parsed.id
        : null;
    const deviceId =
      typeof parsed.device?.id === "string" ? parsed.device.id : null;
    return { scenarioId, deviceId };
  } catch {
    return { scenarioId: null, deviceId: null };
  }
}

/**
 * Cheap liveness check for an indexed run: the row is only trustworthy while
 * its `run.json` still exists. Contents are not re-parsed — a terminal run is
 * immutable, so the index cannot disagree with it.
 */
async function hasRunFile(store: RunStore, runId: string): Promise<boolean> {
  try {
    await stat(join(store.runDirectory(runId), RUN_FILE_NAME));
    return true;
  } catch {
    return false;
  }
}

async function discoverRun(
  store: RunStore,
  runId: string,
): Promise<RunHistoryEntry | null> {
  let run: TestRun;
  try {
    run = await store.read(runId);
  } catch {
    // Corrupt or partially written run.json: skip rather than fail history.
    return null;
  }
  if (!TERMINAL_STATUSES.has(run.status)) {
    return null;
  }
  const plan = await readPlanFacts(store, runId);
  return {
    runId: run.id,
    planId: run.planId,
    scenarioId: plan.scenarioId,
    deviceId: plan.deviceId,
    status: run.status,
    ...(run.gate !== undefined ? { gate: run.gate } : {}),
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
    passCount: run.passes === undefined ? null : run.passes.length,
    metrics: metricDigest(run),
  };
}

/**
 * Shared history handler.
 *
 * Read path only: an index row missing from disk is rebuilt in memory from
 * `run.json`/`plan.json`, but nothing is written back. That keeps `runs`
 * safe to call from CI and concurrent sessions while still healing old or
 * partially indexed workspaces.
 */
export async function listPerformanceRuns(
  rawInput: unknown,
  options: RegisterOptions,
): Promise<HandlerResult> {
  if (!options.runStore) {
    return {
      error:
        "list_performance_runs 缺少工作区 runStore；请先调用 initialize_performance_workspace。",
    };
  }
  const parsed = runsQuerySchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return {
      error: `运行历史查询参数无效：${parsed.error.message}`,
    };
  }
  const query = parsed.data;
  const store = options.runStore;

  let index: Awaited<ReturnType<RunStore["readIndex"]>>;
  let runIds: string[];
  try {
    [index, runIds] = await Promise.all([
      store.readIndex(),
      store.listRunIds(),
    ]);
  } catch (error) {
    return {
      error: `无法读取运行历史：${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const existing = new Set(runIds);
  const entries = new Map<string, RunHistoryEntry>();
  let skipped = 0;
  for (const entry of index.entries) {
    if (!existing.has(entry.runId) || !(await hasRunFile(store, entry.runId))) {
      // Index row without a run directory or without run.json: a deleted or
      // half-removed run must not appear as a phantom history entry.
      skipped += 1;
      continue;
    }
    if (!entries.has(entry.runId)) {
      entries.set(entry.runId, toHistoryEntry(entry));
    }
  }

  let unindexed = 0;
  for (const runId of runIds) {
    if (entries.has(runId)) continue;
    const discovered = await discoverRun(store, runId);
    if (discovered === null) {
      skipped += 1;
      continue;
    }
    entries.set(runId, discovered);
    unindexed += 1;
  }

  const filtered = [...entries.values()]
    .sort(
      (left, right) =>
        right.startedAt.localeCompare(left.startedAt) ||
        right.runId.localeCompare(left.runId),
    )
    .filter((entry) => {
      if (query.status !== undefined && entry.status !== query.status) {
        return false;
      }
      if (query.scenarioId !== undefined) {
        return (
          entry.scenarioId === query.scenarioId ||
          entry.planId === query.scenarioId
        );
      }
      return true;
    });

  return {
    runs: filtered.slice(0, query.limit),
    unindexed,
    invalidLines: index.invalidLines,
    skipped,
  };
}
