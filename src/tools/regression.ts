import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  compareQuerySchema,
  comparePerformanceRuns,
  type CompareBaseline,
  type CompareExclusions,
  type CompareTarget,
} from "./compare.js";
import {
  evaluateRegression,
  type RegressionMetric,
  type RegressionSummary,
} from "../analysis/regression.js";
import {
  EMPTY_EXCLUSIONS,
  type ComparisonStatus,
} from "../analysis/compare.js";
import {
  deviceTargetSchema,
  metricRegressionSchema,
  type MetricRegression,
} from "../model/test-plan.js";
import {
  terminalRunStatusSchema,
  type TestRun,
} from "../model/test-run.js";
import type { RunStore } from "../storage/runs.js";
import type { RegisterOptions } from "./index.js";

/**
 * Input shape for the MCP tool `evaluate_regression_gate` and the CLI
 * `perfstage gate` command. It is exactly the `compare` query: the same
 * baseline selection rules and the same argument conflicts apply, so reusing
 * the schema prevents the two surfaces from drifting.
 */
export const regressionQuerySchema = compareQuerySchema;

export type RegressionQuery = z.infer<typeof regressionQuerySchema>;

export interface RegressionResult {
  target: CompareTarget;
  baseline: CompareBaseline;
  /** C2 comparison status, kept under its original name. */
  status: ComparisonStatus;
  regression: RegressionSummary;
  metrics: RegressionMetric[];
  excluded: CompareExclusions;
  warnings: string[];
}

export interface RegressionError {
  error: string;
}

type HandlerResult = RegressionResult | RegressionError;

/**
 * Narrow snapshot reader: only `metrics[].{name, regression}` and the device
 * fallback matter here.
 *
 * Parsing the whole history with `testPlanSchema` would make an unrelated
 * future field able to turn an old run into `plan-unreadable`. The snapshot is
 * still validated strictly for the fields this gate consumes; `device` is
 * extracted leniently below so a malformed device block cannot hide rules.
 */
const planRegressionSnapshotSchema = z
  .object({
    metrics: z
      .array(
        z
          .object({
            name: z.string().min(1),
            regression: metricRegressionSchema.optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

/**
 * Device fallback from a plan snapshot.
 *
 * Uses the same schema as `compare`, so a malformed `device` block resolves to
 * `null`s on both surfaces instead of letting `gate` and `compare` disagree
 * about which device a snapshot describes.
 */
function planDeviceFacts(plan: Record<string, unknown>): {
  deviceId: string | null;
  osVersion: string | null;
} {
  const device = deviceTargetSchema.safeParse(plan["device"]);
  if (!device.success) {
    return { deviceId: null, osVersion: null };
  }
  return {
    deviceId: device.data.id,
    osVersion: device.data.osVersion ?? null,
  };
}

interface RegressionFacts {
  readable: boolean;
  rules: Map<string, MetricRegression>;
  /** Device fallback from `plan.json`, mirroring `compare`'s resolution. */
  deviceId: string | null;
  osVersion: string | null;
  warnings: string[];
}

const TERMINAL_STATUSES: ReadonlySet<TestRun["status"]> = new Set(
  terminalRunStatusSchema.options,
);

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type RunRead = { run: TestRun } | { error: string };

async function readRun(store: RunStore, runId: string): Promise<RunRead> {
  try {
    return { run: await store.read(runId) };
  } catch (error) {
    return { error: describeError(error) };
  }
}

async function readRegressionRules(
  store: RunStore,
  runId: string,
): Promise<RegressionFacts> {
  const path = join(store.runDirectory(runId), "plan.json");

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    return {
      readable: false,
      rules: new Map(),
      deviceId: null,
      osVersion: null,
      warnings: [
        `目标 plan.json 不可读（${describeError(error)}），无法读取 regression 规则。`,
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      readable: false,
      rules: new Map(),
      deviceId: null,
      osVersion: null,
      warnings: [
        `目标 plan.json 不是合法 JSON（${describeError(error)}），无法读取 regression 规则。`,
      ],
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      readable: false,
      rules: new Map(),
      deviceId: null,
      osVersion: null,
      warnings: [
        "目标 plan.json 不是计划对象，无法读取 regression 规则。",
      ],
    };
  }

  // Device facts are independent from the rules: a broken `metrics` block must
  // not make `gate` and `compare` disagree about which device a snapshot is for.
  const deviceFacts = planDeviceFacts(parsed as Record<string, unknown>);

  const snapshot = planRegressionSnapshotSchema.safeParse(parsed);
  if (!snapshot.success) {
    return {
      readable: false,
      rules: new Map(),
      ...deviceFacts,
      warnings: [
        `目标 plan.json 的 regression 配置无效：${snapshot.error.message}`,
      ],
    };
  }

  const rules = new Map<string, MetricRegression>();
  for (const metric of snapshot.data.metrics) {
    // First declaration wins, matching `compareMetrics`/`numericMetric`
    // which resolve a duplicated metric name to its first occurrence.
    if (metric.regression !== undefined && !rules.has(metric.name)) {
      rules.set(metric.name, metric.regression);
    }
  }
  return {
    readable: true,
    rules,
    ...deviceFacts,
    warnings: [],
  };
}

/**
 * Read-only regression gate handler.
 *
 * Delegates the baseline selection, aggregation and numeric comparison to
 * `comparePerformanceRuns` (C2), then evaluates the rules captured in the
 * target run's `plan.json`. It never writes to the workspace and never stores
 * the verdict, so a Take's terminal artifacts stay immutable.
 */
export async function evaluateRegressionGate(
  rawInput: unknown,
  options: RegisterOptions,
): Promise<HandlerResult> {
  if (!options.runStore) {
    return {
      error:
        "evaluate_regression_gate 缺少工作区 runStore；请先调用 initialize_performance_workspace。",
    };
  }

  const raw = (rawInput ?? {}) as Record<string, unknown>;
  const bothAgainstAndSamples =
    raw["against"] !== undefined && raw["samples"] !== undefined;

  const query = regressionQuerySchema.safeParse(rawInput ?? {});
  if (query.success && !bothAgainstAndSamples) {
    // A terminal Take that did not complete is the first reason in the
    // contract, ahead of every data-shape problem. `compare` refuses such a
    // Take when it has no numeric metrics, so decide it here: an `invalid`
    // Take must map to exit 2 (untrustworthy), not 3 (environment error).
    // Parameter errors still win: an invalid `--against` is an input error
    // (exit 3), not evidence that the Take is untrustworthy.
    const targetRead = await readRun(options.runStore, query.data.runId);
    if (
      "run" in targetRead &&
      TERMINAL_STATUSES.has(targetRead.run.status) &&
      targetRead.run.status !== "completed"
    ) {
      const againstId = query.data.against;
      let againstRun: TestRun | null = null;
      if (againstId !== undefined) {
        const checked = await checkAgainst(
          options.runStore,
          targetRead.run,
          againstId,
        );
        if ("error" in checked) {
          return { error: checked.error };
        }
        againstRun = checked.against;
      }
      return untrustworthyTarget(
        targetRead.run,
        againstRun,
        options.runStore,
      );
    }
  }

  const comparison = await comparePerformanceRuns(rawInput, options);
  if ("error" in comparison) {
    return comparison;
  }

  const facts = await readRegressionRules(
    options.runStore,
    comparison.target.runId,
  );
  const evaluation = evaluateRegression({
    targetStatus: comparison.target.status,
    planReadable: facts.readable,
    baselineStatus: comparison.status,
    baselineKind: comparison.baseline.kind,
    metrics: comparison.metrics,
    rules: facts.rules,
  });

  return {
    target: comparison.target,
    baseline: comparison.baseline,
    status: comparison.status,
    regression: evaluation.summary,
    metrics: evaluation.metrics,
    excluded: comparison.excluded,
    warnings: [...comparison.warnings, ...facts.warnings],
  };
}

/**
 * Validate `--against` for the untrustworthy-target shortcut.
 *
 * The shortcut must not swallow an invalid `--against`: argument errors and an
 * untrustworthy Take are different CI signals (3 means fix the call or the
 * environment, 2 means rerun the Take). This mirrors `compare`'s checks and
 * wording; returning a message here is what keeps the exit code at 3.
 */
async function checkAgainst(
  store: RunStore,
  target: TestRun,
  againstId: string,
): Promise<{ against: TestRun } | { error: string }> {
  if (againstId === target.id) {
    return {
      error: `against 不能与目标 runId（${againstId}）相同：一次 Take 与自身对比不构成有效基线。`,
    };
  }

  const read = await readRun(store, againstId);
  if ("error" in read) {
    return { error: `无法读取对比运行 ${againstId}：${read.error}` };
  }
  const against = read.run;
  if (!TERMINAL_STATUSES.has(against.status)) {
    return {
      error: `对比运行 ${againstId} 尚未进入终态（当前 ${against.status}），无法对比。`,
    };
  }
  if (against.planId !== target.planId) {
    return {
      error: `对比运行 ${againstId} 与目标的场景不同（${against.planId} ≠ ${target.planId}）。`,
    };
  }

  const [targetDevice, againstDevice] = await Promise.all([
    deviceIdOf(store, target),
    deviceIdOf(store, against),
  ]);
  if (againstDevice !== targetDevice) {
    return {
      error: `对比运行 ${againstId} 与目标的设备不同（${againstDevice ?? "未知"} ≠ ${targetDevice ?? "未知"}）。`,
    };
  }
  return { against };
}

/** Device id resolution order used by `compare`: run.json, then plan.json. */
async function deviceIdOf(store: RunStore, run: TestRun): Promise<string | null> {
  if (run.device?.id !== undefined) return run.device.id;
  const facts = await readRegressionRules(store, run.id);
  return facts.deviceId;
}

/**
 * Result for a Take that is terminal but not `completed`.
 *
 * No baseline is derived: a verdict on untrustworthy evidence would be
 * meaningless, and this path does not run the baseline selection at all, so
 * `status`/`excluded` here are not C2 findings. Every declared rule is still
 * reported as `not-evaluated / target-not-completed`, so a CI consumer sees
 * both the exit code 2 and an explicit reason instead of a silent `pass`.
 */
async function untrustworthyTarget(
  run: TestRun,
  against: TestRun | null,
  store: RunStore,
): Promise<RegressionResult> {
  const facts = await readRegressionRules(store, run.id);
  const evaluation = evaluateRegression({
    targetStatus: run.status,
    planReadable: facts.readable,
    baselineStatus: "no-baseline",
    baselineKind: against !== null ? "against" : "derived",
    metrics: [],
    rules: facts.rules,
  });
  const osVersion = run.device?.osVersion ?? facts.osVersion;
  const againstOsVersion =
    against === null
      ? osVersion
      : (against.device?.osVersion ??
        (await readRegressionRules(store, against.id)).osVersion);
  const warnings = [
    `目标 Take 未成功完成（status=${run.status}），回归门禁不做判定。`,
    ...facts.warnings,
  ];
  if (
    against !== null &&
    againstOsVersion !== null &&
    osVersion !== null &&
    againstOsVersion !== osVersion
  ) {
    warnings.push(
      `对比运行与目标的 iOS 版本不同（${againstOsVersion} ≠ ${osVersion}），按调用方显式选择继续对比。`,
    );
  }
  return {
    target: {
      runId: run.id,
      planId: run.planId,
      status: run.status,
      ...(run.gate !== undefined ? { gate: run.gate } : {}),
      startedAt: run.startedAt,
      deviceId: run.device?.id ?? facts.deviceId,
      osVersion,
    },
    baseline: {
      kind: against !== null ? "against" : "derived",
      samples: 0,
      runIds: against !== null ? [against.id] : [],
      osVersion: againstOsVersion,
      window: null,
    },
    status: "no-baseline",
    regression: evaluation.summary,
    metrics: evaluation.metrics,
    excluded: { ...EMPTY_EXCLUSIONS, unreadable: 0 },
    warnings,
  };
}
