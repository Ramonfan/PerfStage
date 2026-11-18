import {
  buildTrend,
  TREND_SCAN_LIMIT,
  type TrendResult,
  type TrendRun,
} from "../analysis/trend.js";
import type { RunStore } from "../storage/runs.js";
import { readPlanDevice } from "./compare.js";
import { listPerformanceRuns } from "./runs.js";

/**
 * Read a scene's history and hand it to the pure trend aggregator.
 *
 * The index is only used to find candidate Takes; every number comes from the
 * authoritative `run.json` so a stale index row cannot invent a trend. Takes
 * whose `run.json` cannot be read are counted as exclusions instead of
 * aborting the whole view, and iOS falls back to `plan.json` for runs that
 * predate the device snapshot.
 */

export interface TrendQuery {
  /** Matches either `scenarioId` or `planId` of a stored run. */
  sceneId: string;
  limit?: number;
  /** Keep only Takes recorded on this device. */
  deviceId?: string;
}

export interface TrendToolOptions {
  runStore: RunStore;
  now: () => Date;
}

export interface TrendToolError {
  error: string;
}

export async function buildSceneTrend(
  rawInput: unknown,
  options: TrendToolOptions,
): Promise<TrendResult | TrendToolError> {
  const input = (rawInput ?? {}) as Partial<TrendQuery>;
  const sceneId = typeof input.sceneId === "string" ? input.sceneId.trim() : "";
  if (sceneId.length === 0) {
    return { error: "trend 需要一个场景 ID。用 `perfstage list` 查看可用场景。" };
  }

  const listed = await listPerformanceRuns(
    { scenarioId: sceneId, limit: TREND_SCAN_LIMIT },
    { runStore: options.runStore, now: options.now },
  );
  if ("error" in listed) {
    return { error: listed.error };
  }

  const resolved = await Promise.all(
    listed.runs.map(async (entry) => {
      try {
        const run = await options.runStore.read(entry.runId);
        let deviceId = run.device?.id ?? null;
        let osVersion = run.device?.osVersion ?? null;
        if (deviceId === null || osVersion === null) {
          const plan = await readPlanDevice(options.runStore, entry.runId);
          deviceId = deviceId ?? plan.id;
          osVersion = osVersion ?? plan.osVersion;
        }
        const trendRun: TrendRun = {
          runId: run.id,
          status: run.status,
          ...(run.gate !== undefined ? { gate: run.gate } : {}),
          startedAt: run.startedAt,
          deviceId,
          osVersion,
          metrics: run.metrics,
        };
        return { run: trendRun, unreadable: false };
      } catch {
        return { run: null, unreadable: true };
      }
    }),
  );

  const runs: TrendRun[] = [];
  let unreadable = 0;
  for (const item of resolved) {
    if (item.run === null) unreadable += 1;
    else runs.push(item.run);
  }

  return buildTrend({
    sceneId,
    runs,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(typeof input.deviceId === "string" && input.deviceId.length > 0
      ? { deviceId: input.deviceId }
      : {}),
    unreadable,
    scanned: listed.runs.length,
    scanLimit: TREND_SCAN_LIMIT,
  });
}
