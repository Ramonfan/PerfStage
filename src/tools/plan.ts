import { promises as fs } from "node:fs";
import { join, posix } from "node:path";
import { z } from "zod";
import { parseDocument } from "yaml";
import {
  loadAllScenarios,
} from "../scenario/loader.js";
import { parseScenarioDocument } from "../scenario/parser.js";
import {
  testPlanSchema,
  preconditionSchema,
  type TestPlan,
  type MetricRequest,
} from "../model/test-plan.js";
import { testRunSchema, type TestRun } from "../model/test-run.js";
import { newRunId, RUN_FILE_NAME } from "../storage/runs.js";
import { buildRunRelativePath } from "./path-utils.js";
import { describeInputIssues } from "../diagnostics/removed-config.js";
import type { RegisterOptions } from "./index.js";

const deviceTargetSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  osVersion: z.string().optional(),
  modelIdentifier: z.string().optional(),
});

const metricRequestSchema = z
  .object({
    name: z.string().min(1),
    instrument: z.string().optional(),
    tracePath: z.string().optional(),
    result: z.unknown().optional(),
    threshold: z
      .object({
        warn: z.number().optional(),
        fail: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .passthrough();

const adHocPlanSchema = z
  .object({
    source: z.enum(["ad_hoc", "scenario"]).optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    app: z.object({ bundleId: z.string().min(1) }).passthrough(),
    device: z
      .object({ id: z.string().min(1) })
      .passthrough()
      .optional(),
    actions: z.array(z.unknown()).min(1),
    metrics: z.array(metricRequestSchema).optional(),
    warmup: z.array(z.unknown()).optional(),
    preconditions: z.array(preconditionSchema).optional(),
    repetitions: z.number().int().positive().optional(),
    notes: z.string().optional(),
  })
  .strict();

/**
 * Input shape for `prepare_performance_test`. The discriminated union enforces
 * exactly-one-source: callers either reference a stored scenario (`scenarioId`)
 * or supply a fresh ad-hoc plan (`adHocPlan`). Everything else is optional
 * override data applied through the model schema.
 */
export const prepareInputSchema = z
  .object({
    scenarioId: z.string().min(1).optional(),
    adHocPlan: adHocPlanSchema.optional(),
    device: deviceTargetSchema,
    metricOverrides: z.array(metricRequestSchema).optional(),
    notes: z.string().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasScenario = value.scenarioId !== undefined;
    const hasAdHoc = value.adHocPlan !== undefined;
    if (hasScenario && hasAdHoc) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Both sources are exclusive; pass scenarioId xor adHocPlan, not both.",
      });
    }
    if (!hasScenario && !hasAdHoc) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Either scenarioId or adHocPlan is required; provide exactly one source.",
      });
    }
  });

export interface PreparePerformanceTestError {
  error: string;
}

export interface PreparePerformanceTestResult {
  runId: string;
  scenarioId: string;
  planId: string;
  runPath: string;
  planPath: string;
  /**
   * The resolved plan, inlined so a Skill or CLI caller can execute the Take
   * without re-reading `plan.json` (M1).
   */
  plan: TestPlan;
  metricOverrides?: MetricRequest[];
  nextSteps: string[];
}

type HandlerResult = PreparePerformanceTestResult | PreparePerformanceTestError;

function isError(value: HandlerResult): value is PreparePerformanceTestError {
  return typeof (value as { error?: unknown }).error === "string";
}

function planFromAdHoc(adHocPlan: z.infer<typeof adHocPlanSchema>): TestPlan {
  const candidate = {
    source: adHocPlan.source ?? "ad_hoc",
    ...(adHocPlan.id !== undefined ? { id: adHocPlan.id } : {}),
    ...(adHocPlan.name !== undefined ? { name: adHocPlan.name } : {}),
    app: adHocPlan.app,
    device: adHocPlan.device ?? { id: "any" },
    actions: adHocPlan.actions,
    ...(adHocPlan.metrics !== undefined ? { metrics: adHocPlan.metrics } : {}),
    ...(adHocPlan.warmup !== undefined ? { warmup: adHocPlan.warmup } : {}),
    ...(adHocPlan.preconditions !== undefined
      ? { preconditions: adHocPlan.preconditions }
      : {}),
    ...(adHocPlan.repetitions !== undefined ? { repetitions: adHocPlan.repetitions } : {}),
    ...(adHocPlan.notes !== undefined ? { notes: adHocPlan.notes } : {}),
  };
  // parseScenarioDocument enforces the same `scenario` source ruleset, but
  // ad_hoc plans still validate through testPlanSchema via that path; we
  // re-parse with the explicit `ad_hoc` source here so the persisted plan
  // matches the runtime model.
  const result = testPlanSchema.safeParse({
    ...candidate,
    source: "ad_hoc",
  });
  if (!result.success) {
    throw new Error(
      `adHocPlan 校验失败：${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

async function planFromScenario(
  scenarioDir: string,
  scenarioId: string,
): Promise<TestPlan> {
  // The handler already knows the scenario directory; this is loaded via
  // a dedicated function so the error message can reference the id.
  const plans = await loadAllScenarios(scenarioDir);
  // Find the scenario whose top-level id matches the requested one.
  const match = plans.find(
    (plan) => (plan.id ?? plan.name) === scenarioId,
  );
  if (!match) {
    throw new Error(`未找到 id 为 "${scenarioId}" 的场景。`);
  }
  return match;
}

function mergeMetricOverrides(
  base: MetricRequest[],
  overrides: MetricRequest[] | undefined,
): MetricRequest[] {
  if (!overrides || overrides.length === 0) {
    return base;
  }
  const byName = new Map<string, MetricRequest>();
  for (const metric of base) {
    byName.set(metric.name, { ...metric });
  }
  for (const override of overrides) {
    const existing = byName.get(override.name);
    if (existing) {
      // Deep-merge: keep any unspecified fields from the scenario metric,
      // then layer the override fields on top. This preserves the original
      // `instrument` and `tracePath` when the caller only wants to update
      // the runtime result or verdict.
      byName.set(override.name, { ...existing, ...override });
    } else {
      byName.set(override.name, { ...override });
    }
  }
  return Array.from(byName.values());
}

function buildNextSteps(
  plan: TestPlan,
  metricOverrides: MetricRequest[] | undefined,
): string[] {
  const metrics = mergeMetricOverrides(plan.metrics, metricOverrides);
  const metricSummary =
    metrics
      .map((metric) =>
        metric.instrument !== undefined && metric.instrument !== metric.name
          ? `${metric.name}（${metric.instrument}）`
          : metric.name,
      )
      .join("、") || "未声明指标";

  // Name what the recorded cold start actually carries; the Runner applies
  // these, so a manual takeover must apply them too or it measures a different
  // launch configuration.
  const launchParts: string[] = [];
  if (plan.app.launchArguments.length > 0) {
    launchParts.push(`启动参数 ${plan.app.launchArguments.join(" ")}`);
  }
  const envEntries = Object.entries(plan.app.environmentVariables);
  if (envEntries.length > 0) {
    launchParts.push(
      `环境变量 ${envEntries.map(([key, value]) => `${key}=${value}`).join(" ")}`,
    );
  }
  if (plan.app.launchUrl !== undefined) {
    launchParts.push(`深链 ${plan.app.launchUrl}`);
  }
  const launchNote =
    launchParts.length > 0
      ? `冷启动时带上 ${launchParts.join("、")}，深链在动作之前打开。`
      : "冷启动使用 App 默认配置。";

  return [
    "1. 确认工作区已初始化、设备已连接，并记下本次要使用的 deviceId。",
    "2. 首选一键路径：直接调用 run_performance_test（同一 sceneId + deviceId）。它会自行 prepare 并录制、解析、出报告，因此不会复用本工具刚创建的 prepared 运行。",
    "3. 仅在需要人工接管时继续走本运行：它只完成了校验与落盘，没有任何设备动作。",
    `4. 按 warmup → actions 顺序驱动真机，每次动作后遵守 waitAfterMs。${launchNote}`,
    `5. 录制 ${metricSummary} 所需的 pass（hitches 与 blockMs 共用 Animation Hitches，launchMs 用 App Launch，memoryMB 用 Activity Monitor），把 trace 路径写入 metrics[*].tracePath。`,
    "6. 动作期间保持设备日志与 Crash 采集，收尾前后各取一次 Crash 快照。",
    "7. 证据齐全后调用 finalize_performance_test 提交 runId、requestedStatus、actions、metrics 与 diagnostics；缺 trace 或缺值时 finalize 会降级为 partial，而不是 completed。",
  ];
}

async function readAdHocYaml(sourcePath: string): Promise<TestPlan> {
  let contents: string;
  try {
    contents = await fs.readFile(sourcePath, "utf8");
  } catch (error) {
    throw new Error(
      `无法读取 adHocPlan 文件 ${sourcePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  let document: unknown;
  try {
    document = parseDocument(contents).toJS();
  } catch (error) {
    throw new Error(
      `adHocPlan YAML 解析失败: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return parseScenarioDocument(document, sourcePath);
}

/**
 * Shared handler for both the production MCP tool and the test harness.
 *
 * The handler performs no device operation: it loads the YAML or accepts an
 * in-memory ad-hoc plan, applies CLI overrides, persists the prepared run and
 * the resolved plan, then returns ordered next steps for Claude to follow.
 *
 * The workspace context is required: every scenario lookup and every
 * run-store call goes through the resolved `scenarioDir` / `runStore`
 * provided by the readiness guard. No path defaults are read from the
 * package installation.
 */
export async function preparePerformanceTest(
  rawInput: unknown,
  options: RegisterOptions,
): Promise<HandlerResult> {
  if (typeof options.scenarioDir !== "string" || options.scenarioDir.length === 0) {
    return {
      error:
        "prepare_performance_test 缺少工作区 scenarioDirectory；请先调用 initialize_performance_workspace。",
    };
  }
  if (!options.runStore) {
    return {
      error:
        "prepare_performance_test 缺少工作区 runStore；请先调用 initialize_performance_workspace。",
    };
  }
  const parsed = prepareInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      error: `prepare_performance_test 输入校验失败：${describeInputIssues(
        parsed.error.issues,
      )}`,
    };
  }
  const input = parsed.data;

  let basePlan: TestPlan;
  try {
    if (input.scenarioId !== undefined) {
      basePlan = await planFromScenario(options.scenarioDir, input.scenarioId);
    } else if (input.adHocPlan !== undefined) {
      basePlan = planFromAdHoc(input.adHocPlan);
    } else {
      return { error: "必须提供 scenarioId 或 adHocPlan 之一。" };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `加载方案失败：${message}` };
  }

  // Apply overrides via the model schema so the resolved plan is consistent
  // with what Claude will ultimately execute.
  const metricOverrides = input.metricOverrides;
  const mergedMetrics = mergeMetricOverrides(
    basePlan.metrics,
    metricOverrides,
  );
  const mergedCandidate: Record<string, unknown> = {
    ...basePlan,
    device: input.device,
    metrics: mergedMetrics,
  };
  if (input.notes !== undefined) mergedCandidate.notes = input.notes;

  const planParse = testPlanSchema.safeParse(mergedCandidate);
  if (!planParse.success) {
    return {
      error: `合并后的方案无法通过模型校验：${planParse.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    };
  }
  const plan = planParse.data;
  const planId = plan.id ?? plan.name ?? `plan-${plan.actions.length}`;

  const runId = newRunId(options.now());
  const startedAt = options.now().toISOString();
  const initialRun: TestRun = testRunSchema.parse({
    id: runId,
    planId,
    status: "prepared",
    startedAt,
    endedAt: null,
    durationMs: 0,
    repetitions: plan.repetitions,
    currentRepetition: 0,
    actions: [],
    metrics: [],
    evidence: {
      screenshotPaths: [],
      traceArchivePaths: [],
    },
    lifecycle: [],
    notes: input.notes,
  });

  try {
    await options.runStore.create(initialRun);
  } catch (error) {
    return {
      error: `无法创建运行目录：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Persist the resolved plan alongside run.json so later tools (e.g.
  // finalize) can read it back without re-parsing the source scenario.
  const planRelative = posix.join("plan.json");
  try {
    await options.runStore.writeText(
      runId,
      planRelative,
      JSON.stringify(plan, null, 2),
    );
  } catch (error) {
    return {
      error: `无法写入方案：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return {
    runId,
    scenarioId: input.scenarioId ?? (plan.id ?? "ad-hoc"),
    planId,
    runPath: buildRunRelativePath(options.runsRoot, runId, RUN_FILE_NAME),
    planPath: planRelative,
    plan,
    metricOverrides,
    nextSteps: buildNextSteps(plan, metricOverrides),
  };
}

// `unused` shim so the helper keeps a typed reference even when not called
// directly from this file.
void readAdHocYaml;
