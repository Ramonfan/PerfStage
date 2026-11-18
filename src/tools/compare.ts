import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  baselineWindow,
  compareMetrics,
  comparisonStatusForSamples,
  DEFAULT_BASELINE_SAMPLES,
  EMPTY_EXCLUSIONS,
  MAX_BASELINE_SAMPLES,
  MIN_BASELINE_SAMPLES,
  selectBaseline,
  type BaselineWindow,
  type ComparisonRun,
  type ComparisonStatus,
  type MetricComparison,
} from "../analysis/compare.js";
import {
  terminalRunStatusSchema,
  type GateResult,
  type RunStatus,
  type TestRun,
} from "../model/test-run.js";
import { deviceTargetSchema } from "../model/test-plan.js";
import type { RunStore } from "../storage/runs.js";
import type { RegisterOptions } from "./index.js";

export type { MetricComparison } from "../analysis/compare.js";

/**
 * Input shared by the MCP tool `compare_performance_runs` and the CLI
 * `perfstage compare` command.
 *
 * `against` and `samples` are mutually exclusive. The schema cannot express
 * that with `.refine` because MCP registration consumes `.shape`, so the
 * handler rejects the combination explicitly.
 */
export const compareQuerySchema = z.object({
  runId: z.string().min(1),
  /** Compare directly against one Take instead of a derived baseline. */
  against: z.string().min(1).optional(),
  samples: z
    .number()
    .int()
    .min(MIN_BASELINE_SAMPLES)
    .max(MAX_BASELINE_SAMPLES)
    .default(DEFAULT_BASELINE_SAMPLES),
});

export type CompareQuery = z.infer<typeof compareQuerySchema>;

export type BaselineKind = "derived" | "against";

export interface CompareTarget {
  runId: string;
  planId: string;
  status: RunStatus;
  gate?: GateResult;
  startedAt: string;
  deviceId: string | null;
  osVersion: string | null;
}

export interface CompareBaseline {
  kind: BaselineKind;
  samples: number;
  runIds: string[];
  osVersion: string | null;
  window: BaselineWindow | null;
}

export interface CompareExclusions {
  differentPlan: number;
  differentDevice: number;
  differentOs: number;
  nonTerminal: number;
  notBefore: number;
  unreadable: number;
}

export interface CompareResult {
  target: CompareTarget;
  baseline: CompareBaseline;
  status: ComparisonStatus;
  metrics: MetricComparison[];
  excluded: CompareExclusions;
  warnings: string[];
}

export interface CompareError {
  error: string;
}

type HandlerResult = CompareResult | CompareError;

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(
  terminalRunStatusSchema.options,
);

export interface PlanDeviceFacts {
  id: string | null;
  osVersion: string | null;
  /** `false` when the plan file is missing or not valid JSON. */
  readable: boolean;
}

/**
 * Read the device fallback from `plan.json`.
 *
 * Legacy runs only carry the device id in their plan snapshot, so this is the
 * only source for pre-`add-baseline-compare` Takes. A missing or malformed plan
 * yields `null`s instead of failing the comparison; `readable` lets the caller
 * distinguish a broken artifact from a plan that simply has no device.
 */
export async function readPlanDevice(
  store: RunStore,
  runId: string,
): Promise<PlanDeviceFacts> {
  let raw: string;
  try {
    raw = await readFile(join(store.runDirectory(runId), "plan.json"), "utf8");
  } catch {
    return { id: null, osVersion: null, readable: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { id: null, osVersion: null, readable: false };
  }
  if (parsed === null || typeof parsed !== "object") {
    // Syntactically valid JSON that cannot be a plan snapshot (e.g. `null`).
    // Guard before property access: a bare `null` would otherwise throw and
    // turn a comparison into an unhandled error instead of a counted exclusion.
    return { id: null, osVersion: null, readable: false };
  }
  const result = deviceTargetSchema.safeParse(
    (parsed as { device?: unknown }).device,
  );
  if (!result.success) {
    // A readable plan without a valid `device` (e.g. a scenario with `{}`) is
    // not a corrupt artifact; it just has no device facts to contribute.
    return { id: null, osVersion: null, readable: true };
  }
  return {
    id: result.data.id,
    osVersion: result.data.osVersion ?? null,
    readable: true,
  };
}

function isNumericMetric(metric: TestRun["metrics"][number]): boolean {
  return typeof metric.value === "number" && Number.isFinite(metric.value);
}

async function resolveRun(
  store: RunStore,
  runId: string,
  planDevice: PlanDeviceFacts,
): Promise<ComparisonRun> {
  const run = await store.read(runId);
  return {
    runId: run.id,
    planId: run.planId,
    status: run.status,
    ...(run.gate !== undefined ? { gate: run.gate } : {}),
    startedAt: run.startedAt,
    deviceId: run.device?.id ?? planDevice.id,
    osVersion: run.device?.osVersion ?? planDevice.osVersion,
    metrics: run.metrics,
  };
}

function targetOf(run: ComparisonRun): CompareTarget {
  return {
    runId: run.runId,
    planId: run.planId,
    status: run.status,
    ...(run.gate !== undefined ? { gate: run.gate } : {}),
    startedAt: run.startedAt,
    deviceId: run.deviceId,
    osVersion: run.osVersion,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read-only baseline comparison handler.
 *
 * Never writes to the workspace: it reads `run.json`/`plan.json`, derives the
 * baseline in memory, and returns a structured comparison. The same function
 * backs the CLI and the MCP tool so both surfaces cannot drift.
 */
export async function comparePerformanceRuns(
  rawInput: unknown,
  options: RegisterOptions,
): Promise<HandlerResult> {
  if (!options.runStore) {
    return {
      error:
        "compare_performance_runs 缺少工作区 runStore；请先调用 initialize_performance_workspace。",
    };
  }
  const store = options.runStore;

  const raw = (rawInput ?? {}) as Record<string, unknown>;
  if (raw.against !== undefined && raw.samples !== undefined) {
    return {
      error: "against 与 samples 只能选其一：直接对比单条 Take，或派生基线。",
    };
  }

  const parsed = compareQuerySchema.safeParse(raw);
  if (!parsed.success) {
    return { error: `对比参数无效：${parsed.error.message}` };
  }
  const query = parsed.data;

  if (query.against !== undefined && query.against === query.runId) {
    return {
      error: `against 不能与目标 runId（${query.runId}）相同：一次 Take 与自身对比不构成有效基线。`,
    };
  }

  // ── Target ────────────────────────────────────────────────────────────
  const targetPlan = await readPlanDevice(store, query.runId);
  let target: ComparisonRun;
  try {
    target = await resolveRun(store, query.runId, targetPlan);
  } catch (error) {
    return { error: `无法读取目标运行 ${query.runId}：${describeError(error)}` };
  }
  if (!TERMINAL_STATUSES.has(target.status)) {
    return {
      error: `目标运行 ${query.runId} 尚未进入终态（当前 ${target.status}），无法对比。`,
    };
  }
  if (!target.metrics.some(isNumericMetric)) {
    return {
      error: `目标运行 ${query.runId} 没有可对比的数值指标。`,
    };
  }

  const warnings: string[] = [];
  if (target.osVersion === null) {
    warnings.push(
      "目标的 iOS 版本未记录（旧 run 或设备未上报），基线只会在同为未记录的记录中聚合。",
    );
  }

  // ── Baseline ──────────────────────────────────────────────────────────
  let baselineRuns: ComparisonRun[];
  let kind: BaselineKind;
  let excluded: CompareExclusions = { ...EMPTY_EXCLUSIONS, unreadable: 0 };

  if (query.against !== undefined) {
    kind = "against";
    const againstPlan = await readPlanDevice(store, query.against);
    let against: ComparisonRun;
    try {
      against = await resolveRun(store, query.against, againstPlan);
    } catch (error) {
      return {
        error: `无法读取对比运行 ${query.against}：${describeError(error)}`,
      };
    }
    if (!TERMINAL_STATUSES.has(against.status)) {
      return {
        error: `对比运行 ${query.against} 尚未进入终态（当前 ${against.status}），无法对比。`,
      };
    }
    if (against.planId !== target.planId) {
      return {
        error: `对比运行 ${query.against} 与目标的场景不同（${against.planId} ≠ ${target.planId}）。`,
      };
    }
    if (against.deviceId !== target.deviceId) {
      return {
        error: `对比运行 ${query.against} 与目标的设备不同（${against.deviceId ?? "未知"} ≠ ${target.deviceId ?? "未知"}）。`,
      };
    }
    if (
      against.osVersion !== null &&
      target.osVersion !== null &&
      against.osVersion !== target.osVersion
    ) {
      warnings.push(
        `对比运行与目标的 iOS 版本不同（${against.osVersion} ≠ ${target.osVersion}），按调用方显式选择继续对比。`,
      );
    }
    baselineRuns = [against];
  } else {
    kind = "derived";
    let runIds: string[];
    try {
      runIds = await store.listRunIds();
    } catch (error) {
      return { error: `无法枚举运行目录：${describeError(error)}` };
    }

    const candidates: ComparisonRun[] = [];
    let unreadable = 0;
    for (const runId of runIds) {
      if (runId === target.runId) continue;
      // Read the run first: a different plan can be rejected without loading
      // its plan snapshot, which keeps the common case to one file read.
      let probe: TestRun;
      try {
        probe = await store.read(runId);
      } catch {
        unreadable += 1;
        continue;
      }
      if (probe.planId !== target.planId) {
        candidates.push({
          runId: probe.id,
          planId: probe.planId,
          status: probe.status,
          startedAt: probe.startedAt,
          deviceId: null,
          osVersion: null,
          metrics: [],
        });
        continue;
      }
      const planDevice =
        probe.device?.id !== undefined && probe.device.osVersion !== undefined
          ? {
              id: probe.device.id,
              osVersion: probe.device.osVersion,
              readable: true,
            }
          : await readPlanDevice(store, runId);
      const deviceId = probe.device?.id ?? planDevice.id;
      if (deviceId === null && !planDevice.readable) {
        // A legacy run with neither device facts nor a readable plan cannot
        // contribute; blame the broken artifact, not a device mismatch.
        unreadable += 1;
        continue;
      }
      candidates.push({
        runId: probe.id,
        planId: probe.planId,
        status: probe.status,
        ...(probe.gate !== undefined ? { gate: probe.gate } : {}),
        startedAt: probe.startedAt,
        deviceId,
        osVersion: probe.device?.osVersion ?? planDevice.osVersion,
        metrics: probe.metrics,
      });
    }

    const selection = selectBaseline(target, candidates, {
      samples: query.samples,
    });
    baselineRuns = selection.selected;
    excluded = { ...selection.excluded, unreadable };
  }

  const status: ComparisonStatus =
    kind === "against"
      ? "comparable"
      : comparisonStatusForSamples(baselineRuns.length);

  return {
    target: targetOf(target),
    baseline: {
      kind,
      samples: baselineRuns.length,
      runIds: baselineRuns.map((run) => run.runId),
      osVersion:
        kind === "against"
          ? (baselineRuns[0]?.osVersion ?? null)
          : target.osVersion,
      window: baselineWindow(baselineRuns),
    },
    status,
    metrics: compareMetrics(target.metrics, baselineRuns),
    excluded,
    warnings,
  };
}
