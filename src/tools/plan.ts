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
  type TestPlan,
  type MetricRequest,
  type DiagnosticSettings,
  type AnalysisFocus,
  type ExecutionMode,
} from "../model/test-plan.js";
import { testRunSchema, type TestRun } from "../model/test-run.js";
import { newRunId } from "../storage/runs.js";
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

const diagnosticOverridesSchema = z
  .object({
    collectDeviceLogs: z.boolean().optional(),
    collectCrashes: z.boolean().optional(),
    lifecycleSampling: z.boolean().optional(),
    includedLogSubsystems: z.array(z.string()).optional(),
    includedLogCategories: z.array(z.string()).optional(),
    excludedLogSubsystems: z.array(z.string()).optional(),
    networkCapture: z.boolean().optional(),
    screenshotOnFailure: z.boolean().optional(),
  })
  .strict();

const adHocPlanSchema = z
  .object({
    source: z.enum(["ad_hoc", "scenario", "schedule", "regression"]).optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    app: z.object({ bundleId: z.string().min(1) }).passthrough(),
    device: z
      .object({ id: z.string().min(1) })
      .passthrough()
      .optional(),
    actions: z.array(z.unknown()).min(1),
    metrics: z.array(metricRequestSchema).optional(),
    analysisFocus: z.array(z.string()).optional(),
    warmup: z.array(z.unknown()).optional(),
    preconditions: z.array(z.unknown()).optional(),
    execution: z.enum(["interactive", "automated", "headless"]).optional(),
    repetitions: z.number().int().positive().optional(),
    diagnostics: diagnosticOverridesSchema.optional(),
    notes: z.string().optional(),
  })
  .passthrough();

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
    execution: z.enum(["interactive", "automated", "headless"]).optional(),
    metricOverrides: z.array(metricRequestSchema).optional(),
    analysisFocus: z
      .array(z.enum(["jank", "startup", "memory", "battery", "network", "general"]))
      .optional(),
    diagnosticOverrides: diagnosticOverridesSchema.optional(),
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
  execution: ExecutionMode;
  analysisFocus: AnalysisFocus[];
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
    ...(adHocPlan.analysisFocus !== undefined
      ? { analysisFocus: adHocPlan.analysisFocus }
      : {}),
    ...(adHocPlan.warmup !== undefined ? { warmup: adHocPlan.warmup } : {}),
    ...(adHocPlan.preconditions !== undefined
      ? { preconditions: adHocPlan.preconditions }
      : {}),
    ...(adHocPlan.execution !== undefined ? { execution: adHocPlan.execution } : {}),
    ...(adHocPlan.repetitions !== undefined ? { repetitions: adHocPlan.repetitions } : {}),
    ...(adHocPlan.diagnostics !== undefined ? { diagnostics: adHocPlan.diagnostics } : {}),
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

async function planFromScenario(scenarioId: string): Promise<TestPlan> {
  const plans = await loadAllScenarios(
    // The handler already knows the scenario directory; this is loaded via a
    // dedicated function so the error message can reference the id.
    processScenarios.scenarioDir ?? ".",
  );
  // Find the scenario whose top-level id matches the requested one.
  const match = plans.find(
    (plan) => (plan.id ?? plan.name) === scenarioId,
  );
  if (!match) {
    throw new Error(`未找到 id 为 "${scenarioId}" 的场景。`);
  }
  return match;
}

// Module-level helper to share the configured scenario directory without
// forcing every helper to take options through their parameter list.
const processScenarios: { scenarioDir?: string } = {};

function setScenarioDir(directory: string) {
  processScenarios.scenarioDir = directory;
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

function mergeDiagnosticOverrides(
  base: DiagnosticSettings,
  overrides:
    | z.infer<typeof diagnosticOverridesSchema>
    | undefined,
): DiagnosticSettings {
  if (!overrides) {
    return base;
  }
  return {
    ...base,
    ...overrides,
  };
}

function buildNextSteps(
  plan: TestPlan,
  metricOverrides: MetricRequest[] | undefined,
): string[] {
  const metrics = mergeMetricOverrides(plan.metrics, metricOverrides);
  const instruments = Array.from(
    new Set(
      metrics
        .map((metric) => metric.instrument)
        .filter((name): name is string => Boolean(name)),
    ),
  );
  const metricSummary = instruments.length > 0
    ? instruments.join("、")
    : metrics.map((m) => m.name).join("、");

  return [
    "1. 准备工作设备：按 mobile-mcp 文档选取目标设备并确保 foregroundBundleId 与方案一致。",
    "2. 在执行动作前调用 mobile_get_device_logs 启动设备日志采集并保留过滤器与子系统限制。",
    "3. 在执行动作前调用 mobile_list_crashes 记录本次运行开始前的 Crash 列表快照。",
    "4. 按方案中的 warmup 与 actions 顺序，使用 mobile-mcp（mobile_click_on_screen_at_coordinates / mobile_swipe_on_screen / mobile_type_keys / mobile_launch_app 等）对设备执行动作；每次动作后遵守 waitAfterMs。",
    `5. 通过 instruments-mcp-server 采集以下性能指标（Instruments 工具按 plan.metrics[*].instrument 选择）：${metricSummary || "hitches/cpu/memory"}。将每条指标的 trace 路径写入指标的 tracePath 字段。`,
    "6. 再次调用 mobile_get_device_logs 与 mobile_list_crashes，提取执行后日志、当前 Crash 列表与新增 Crash 详情。",
    "7. 收集生命周期事件（foreground / background / springboard / system_alert / device_disconnect）以及任何截图或网络抓包证据。",
    "8. 在验证以上信息齐全后调用 finalize_performance_test 并提交 runId、requestedStatus、actions、metrics、diagnostics 与可选 evidencePaths/notes。",
  ];
}

async function findScenarioById(
  scenarioDir: string,
  scenarioId: string,
): Promise<TestPlan> {
  const candidates = await loadAllScenarios(scenarioDir);
  const match = candidates.find(
    (plan) => (plan.id ?? plan.name) === scenarioId,
  );
  if (!match) {
    throw new Error(`未找到 id 为 "${scenarioId}" 的场景。`);
  }
  return match;
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
 */
export async function preparePerformanceTest(
  rawInput: unknown,
  options: RegisterOptions,
): Promise<HandlerResult> {
  setScenarioDir(options.scenarioDir);
  const parsed = prepareInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      error: `prepare_performance_test 输入校验失败：${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    };
  }
  const input = parsed.data;

  let basePlan: TestPlan;
  try {
    if (input.scenarioId !== undefined) {
      basePlan = await findScenarioById(options.scenarioDir, input.scenarioId);
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
  const mergedDiagnostics = mergeDiagnosticOverrides(
    basePlan.diagnostics,
    input.diagnosticOverrides,
  );

  const mergedCandidate: Record<string, unknown> = {
    ...basePlan,
    device: input.device,
    diagnostics: mergedDiagnostics,
    metrics: mergedMetrics,
  };
  if (input.execution !== undefined) mergedCandidate.execution = input.execution;
  if (input.analysisFocus !== undefined) {
    mergedCandidate.analysisFocus = input.analysisFocus;
  }
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
    runPath: posix.join("run.json"),
    planPath: planRelative,
    execution: plan.execution,
    analysisFocus: plan.analysisFocus,
    metricOverrides,
    nextSteps: buildNextSteps(plan, metricOverrides),
  };
}

// `unused` shim so the helper keeps a typed reference even when not called
// directly from this file.
void readAdHocYaml;
