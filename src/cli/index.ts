import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  createWorkspaceManager,
  type WorkspaceManager,
} from "../workspace/manager.js";
import { createRunStore } from "../storage/runs.js";
import { initializePerformanceWorkspace } from "../tools/workspace.js";
import { listPerformanceScenarios } from "../tools/scenarios.js";
import { listPerformanceRuns } from "../tools/runs.js";
import { comparePerformanceRuns } from "../tools/compare.js";
import type {
  CompareResult,
  MetricComparison,
} from "../tools/compare.js";
import { runStatusSchema } from "../model/test-run.js";
import { runPerformanceTest } from "../tools/run.js";
import type { RunTakeSummary } from "../runner/run.js";
import type { TraceAnalyzer } from "../runner/execute.js";
import type { DeviceDriver } from "../device/types.js";
import type { TraceRecorder } from "../recording/types.js";
import { getVersion } from "../version.js";
import {
  EXIT_ENVIRONMENT,
  EXIT_OK,
  exitCodeFor,
  type ExitCode,
} from "./exit-codes.js";

/**
 * `perfstage` command line.
 *
 * The CLI is deliberately a thin wrapper: every command calls the same
 * handler the MCP tool calls, so a Skill, a script and CI cannot drift apart.
 * It adds argument parsing, human/JSON rendering and exit codes — no new
 * performance logic.
 */

export interface CliIO {
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultIO: CliIO = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

const USAGE = `PerfStage — 一次定义，次次上演。

用法：
  perfstage init [--app <bundleId>] [--name <appName>] [--copy-scenarios] [--dir <path>]
  perfstage list [--dir <path>] [--json]
  perfstage run <sceneId> --device <udid> [--repetitions <n>] [--json] [--strict] [--dir <path>]
  perfstage run --plan <plan.json> --device <udid> [--json] [--strict] [--dir <path>]
  perfstage runs [--scenario <sceneId>] [--status <status>] [--limit <n>] [--json] [--dir <path>]
  perfstage compare <runId> [--against <runId>] [--samples <n>] [--json] [--dir <path>]
  perfstage report <runId> [--json] [--dir <path>]
  perfstage --version | --help

退出码：
  0  测试有效，未越过阈值（warn / unknown 视为通过）
  1  测试有效，gate=fail（--strict 时 warn 也返回 1）
  2  测试本身不可信（partial / failed / invalid / cancelled）
  3  无法运行（工作区、设备、依赖或输入错误）
`;

export interface CliContext {
  io: CliIO;
  cwd: string;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  /**
   * Runner seam used by tests (and by future offline/dry-run modes) to supply
   * a fake device/recorder. Production leaves it undefined so the real
   * mobilecli/xctrace adapters are built.
   */
  runner?: {
    device?: DeviceDriver;
    recorder?: TraceRecorder;
    analyze?: TraceAnalyzer;
    sleep?: (ms: number) => Promise<void>;
  };
}

function context(overrides: Partial<CliContext> = {}): CliContext {
  return {
    io: overrides.io ?? defaultIO,
    cwd: overrides.cwd ?? process.cwd(),
    env: overrides.env ?? process.env,
    now: overrides.now ?? (() => new Date()),
    ...(overrides.runner !== undefined ? { runner: overrides.runner } : {}),
  };
}

export async function main(
  argv: readonly string[],
  overrides: Partial<CliContext> = {},
): Promise<ExitCode> {
  const ctx = context(overrides);
  const { io } = ctx;

  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        dir: { type: "string" },
        app: { type: "string" },
        name: { type: "string" },
        "copy-scenarios": { type: "boolean", default: false },
        device: { type: "string" },
        plan: { type: "string" },
        scenario: { type: "string" },
        status: { type: "string" },
        limit: { type: "string" },
        against: { type: "string" },
        samples: { type: "string" },
        repetitions: { type: "string" },
        json: { type: "boolean", default: false },
        strict: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", default: false },
      },
    });
  } catch (error) {
    io.err(errorText(error));
    io.err(USAGE);
    return EXIT_ENVIRONMENT;
  }

  const { values, positionals } = parsed;
  if (values.version === true) {
    io.out(`perfstage ${getVersion()}`);
    return EXIT_OK;
  }
  if (values.help === true || positionals.length === 0) {
    io.out(USAGE);
    return EXIT_OK;
  }

  const command = positionals[0];
  const cwd = values.dir === undefined ? ctx.cwd : resolve(ctx.cwd, values.dir);
  const manager = createWorkspaceManager(cwd);

  switch (command) {
    case "init":
      return commandInit(values, manager, ctx);
    case "list":
      return commandList(values.json === true, manager, ctx);
    case "run":
      return commandRun(values, positionals.slice(1), manager, ctx);
    case "runs":
      return commandRuns(values, manager, ctx);
    case "compare":
      return commandCompare(values, positionals.slice(1), manager, ctx);
    case "report":
      return commandReport(values, positionals.slice(1), manager, ctx);
    default:
      io.err(`未知命令：${command}`);
      io.err(USAGE);
      return EXIT_ENVIRONMENT;
  }
}

type ParsedValues = {
  dir?: string;
  app?: string;
  name?: string;
  "copy-scenarios"?: boolean;
  device?: string;
  plan?: string;
  scenario?: string;
  status?: string;
  limit?: string;
  against?: string;
  samples?: string;
  repetitions?: string;
  json?: boolean;
  strict?: boolean;
  help?: boolean;
  version?: boolean;
};

async function commandInit(
  values: ParsedValues,
  manager: WorkspaceManager,
  ctx: CliContext,
): Promise<ExitCode> {
  const result = await initializePerformanceWorkspace(
    {
      ...(values.app !== undefined ? { bundleId: values.app } : {}),
      ...(values.name !== undefined ? { appName: values.name } : {}),
      ...(values["copy-scenarios"] === true ? { copyDefaultScenarios: true } : {}),
    },
    { workspaceManager: manager, now: ctx.now },
  );
  if ("error" in result) {
    return fail(ctx, result.error);
  }

  if (values.json === true) {
    ctx.io.out(JSON.stringify(result, null, 2));
    return EXIT_OK;
  }

  ctx.io.out(
    result.firstInitialization
      ? `已初始化性能工作区：${result.configPath}`
      : `性能工作区已存在：${result.configPath}`,
  );
  ctx.io.out(`场景目录：${result.scenarioDirectory}`);
  ctx.io.out(`运行目录：${result.runsDirectory}`);
  return EXIT_OK;
}

async function commandList(
  json: boolean,
  manager: WorkspaceManager,
  ctx: CliContext,
): Promise<ExitCode> {
  const ready = await requireWorkspace(manager, ctx);
  if (ready === null) return EXIT_ENVIRONMENT;

  const result = await listPerformanceScenarios({
    scenarioDir: ready.paths.scenarioDirectory,
    runStore: ready.store,
    now: ctx.now,
  });
  if ("error" in result) {
    return fail(ctx, result.error);
  }

  if (json) {
    ctx.io.out(JSON.stringify(result, null, 2));
    return EXIT_OK;
  }

  if (result.scenarios.length === 0) {
    ctx.io.out("没有找到场景。用 `perfstage init --copy-scenarios` 植入模板。");
    return EXIT_OK;
  }
  for (const scenario of result.scenarios) {
    const metrics = scenario.metricNames.join(", ") || "(默认指标)";
    ctx.io.out(
      `${scenario.id}\t${scenario.name}\t${scenario.bundleId}\t${scenario.actionCount} actions\t[${metrics}]`,
    );
  }
  return EXIT_OK;
}

async function commandRuns(
  values: ParsedValues,
  manager: WorkspaceManager,
  ctx: CliContext,
): Promise<ExitCode> {
  if (values.status !== undefined) {
    const parsed = runStatusSchema.safeParse(values.status);
    if (!parsed.success) {
      return fail(
        ctx,
        `--status 必须是 ${runStatusSchema.options.join(" / ")}：${values.status}`,
      );
    }
  }
  const limit = parseLimit(values.limit);
  if (limit === "invalid") {
    return fail(ctx, `--limit 必须是 1–200 的整数：${values.limit}`);
  }

  const ready = await requireWorkspace(manager, ctx);
  if (ready === null) return EXIT_ENVIRONMENT;

  const result = await listPerformanceRuns(
    {
      ...(values.scenario !== undefined ? { scenarioId: values.scenario } : {}),
      ...(values.status !== undefined ? { status: values.status } : {}),
      ...(limit !== undefined ? { limit } : {}),
    },
    { runStore: ready.store, now: ctx.now },
  );
  if ("error" in result) {
    return fail(ctx, result.error);
  }

  if (values.json === true) {
    ctx.io.out(JSON.stringify(result, null, 2));
    return EXIT_OK;
  }

  if (result.runs.length === 0) {
    ctx.io.out("没有匹配的运行记录。");
  }
  for (const run of result.runs) {
    const label = run.scenarioId ?? run.planId;
    const gate = run.gate === undefined ? "" : `  gate=${run.gate}`;
    const duration =
      run.durationMs === undefined ? "—" : formatDuration(run.durationMs);
    const metrics = run.metrics
      .map((metric) => `${metric.name}=${String(metric.value ?? "—")}`)
      .join("  ");
    ctx.io.out(
      `${run.runId}\t${label}\t${run.status}${gate}\t${duration}${
        metrics.length > 0 ? `\t${metrics}` : ""
      }`,
    );
  }
  ctx.io.out(
    `索引：本工作区补全 ${result.unindexed} 条，跳过 ${result.skipped} 条，损坏行 ${result.invalidLines}。`,
  );
  return EXIT_OK;
}

async function commandCompare(
  values: ParsedValues,
  positionals: string[],
  manager: WorkspaceManager,
  ctx: CliContext,
): Promise<ExitCode> {
  const runId = positionals[0];
  if (runId === undefined) {
    return fail(ctx, "compare 需要 <runId>。用 `perfstage runs` 查看运行记录。");
  }
  if (values.against !== undefined && values.samples !== undefined) {
    return fail(ctx, "--against 与 --samples 只能选其一。");
  }
  const samples = parseSamples(values.samples);
  if (samples === "invalid") {
    return fail(ctx, `--samples 必须是 3–20 的整数：${values.samples}`);
  }

  const ready = await requireWorkspace(manager, ctx);
  if (ready === null) return EXIT_ENVIRONMENT;

  const result = await comparePerformanceRuns(
    {
      runId,
      ...(values.against !== undefined ? { against: values.against } : {}),
      ...(samples !== undefined ? { samples } : {}),
    },
    { runStore: ready.store, now: ctx.now },
  );
  if ("error" in result) {
    return fail(ctx, result.error);
  }

  if (values.json === true) {
    ctx.io.out(JSON.stringify(result, null, 2));
    return EXIT_OK;
  }

  renderComparison(result, ctx.io);
  return EXIT_OK;
}

function renderComparison(result: CompareResult, io: CliIO): void {
  const { target, baseline, metrics, excluded } = result;
  const kind = baseline.kind === "derived" ? "派生" : "指定";
  const os = target.osVersion ?? "未知";
  io.out(
    `对比 ${target.runId}（${target.planId}，iOS ${os}，${target.status}） ↔ ${kind}基线 ${baseline.samples} 条`,
  );
  if (baseline.runIds.length > 0) {
    io.out(`基线运行：${baseline.runIds.join(", ")}`);
  }

  for (const metric of metrics) {
    io.out(formatMetricComparison(metric));
  }

  if (result.status === "no-baseline") {
    io.out("注意：没有可用的同口径基线，仅显示目标值，不伪造基线。");
  } else if (result.status === "insufficient-samples") {
    io.out(
      `注意：基线样本不足（${baseline.samples}/3），结果仅供参考；不做回归判断。`,
    );
  }
  for (const warning of result.warnings) {
    io.out(`注意：${warning}`);
  }
  const excludedTotal =
    excluded.differentPlan +
    excluded.differentDevice +
    excluded.differentOs +
    excluded.nonTerminal +
    excluded.notBefore +
    excluded.unreadable;
  if (excludedTotal > 0) {
    io.out(
      `排除：场景 ${excluded.differentPlan}，设备 ${excluded.differentDevice}，iOS ${excluded.differentOs}，非终态 ${excluded.nonTerminal}，不早于目标 ${excluded.notBefore}，不可读 ${excluded.unreadable}。`,
    );
  }
}

function formatMetricComparison(metric: MetricComparison): string {
  const delta =
    metric.delta === null
      ? "—"
      : `${metric.delta > 0 ? "+" : ""}${formatNumber(metric.delta)}${
          metric.deltaPercent === null
            ? ""
            : ` (${metric.deltaPercent > 0 ? "+" : ""}${metric.deltaPercent.toFixed(1)}%)`
        }`;
  const range =
    metric.baselineRange === null
      ? "—"
      : `${formatNumber(metric.baselineRange.min)}–${formatNumber(metric.baselineRange.max)}`;
  const status = metric.status === "ok" ? "" : `\t(${metric.status})`;
  return `${metric.name}\tcurrent=${formatNumberOrDash(metric.current)}\tbaseline=${formatNumberOrDash(metric.baselineMedian)}\tdelta=${delta}\tdirection=${metric.direction ?? "—"}\trange=${range}\tsamples=${metric.samples}${status}`;
}

function formatNumberOrDash(value: number | null): string {
  return value === null ? "—" : formatNumber(value);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

async function commandRun(
  values: ParsedValues,
  positionals: string[],
  manager: WorkspaceManager,
  ctx: CliContext,
): Promise<ExitCode> {
  const scenarioId = positionals[0];
  if (scenarioId === undefined && values.plan === undefined) {
    return fail(ctx, "run 需要 <sceneId> 或 --plan <file>。");
  }
  if (scenarioId !== undefined && values.plan !== undefined) {
    return fail(ctx, "run 只能二选一：<sceneId> 或 --plan <file>。");
  }

  const device =
    values.device ?? ctx.env.PERFSTAGE_DEVICE ?? ctx.env.PERFSTAGE_DEVICE_ID;
  if (device === undefined || device.length === 0) {
    return fail(
      ctx,
      "run 需要 --device <udid>（或设置 PERFSTAGE_DEVICE）。用 `xcrun devicectl list devices` 查看。",
    );
  }

  const ready = await requireWorkspace(manager, ctx);
  if (ready === null) return EXIT_ENVIRONMENT;

  let adHocPlan: unknown;
  if (values.plan !== undefined) {
    try {
      adHocPlan = JSON.parse(
        await readFile(resolve(ctx.cwd, values.plan), "utf8"),
      );
    } catch (error) {
      return fail(ctx, `无法读取计划文件 ${values.plan}：${errorText(error)}`);
    }
  }

  const repetitions = parseRepetitions(values.repetitions);
  if (repetitions === "invalid") {
    return fail(ctx, `--repetitions 必须是 1–10 的整数：${values.repetitions}`);
  }

  const result = await runPerformanceTest(
    {
      ...(scenarioId !== undefined ? { scenarioId } : {}),
      ...(adHocPlan !== undefined ? { adHocPlan } : {}),
      device: { id: device },
      ...(repetitions !== undefined ? { repetitions } : {}),
    },
    {
      workspaceManager: manager,
      now: ctx.now,
      // Progress must never pollute `--json` on stdout.
      log: (message) => ctx.io.err(`perfstage: ${message}`),
      ...(ctx.runner?.device !== undefined ? { device: ctx.runner.device } : {}),
      ...(ctx.runner?.recorder !== undefined
        ? { recorder: ctx.runner.recorder }
        : {}),
      ...(ctx.runner?.analyze !== undefined ? { analyze: ctx.runner.analyze } : {}),
      ...(ctx.runner?.sleep !== undefined ? { sleep: ctx.runner.sleep } : {}),
      // Only collapse the settle windows when a fake is driving: they exist to
      // let a real device calm down between passes. Fake actions also complete
      // instantly, so the production minimum measurement window would reject
      // every Take; the guard is covered by its own test.
      ...(ctx.runner !== undefined
        ? {
            settleMs: 0,
            launchSettleMs: 0,
            memorySettleMs: 0,
            passCooldownMs: 0,
            healthCheck: false,
            postLaunchSampleMs: 0,
            minimumWindowMs: 0,
          }
        : {}),
    },
  );

  if ("error" in result) {
    return fail(ctx, result.error);
  }

  if (values.json === true) {
    ctx.io.out(JSON.stringify(result, null, 2));
  } else {
    renderSummary(result, ctx.io);
  }
  return exitCodeFor({
    status: result.status,
    gate: result.gate,
    strict: values.strict === true,
  });
}

async function commandReport(
  values: ParsedValues,
  positionals: string[],
  manager: WorkspaceManager,
  ctx: CliContext,
): Promise<ExitCode> {
  const runId = positionals[0];
  if (runId === undefined) {
    return fail(ctx, "report 需要 <runId>。用 `perfstage runs` 查看运行记录。");
  }

  const ready = await requireWorkspace(manager, ctx);
  if (ready === null) return EXIT_ENVIRONMENT;

  const runDir = ready.store.runDirectory(runId);
  if (values.json === true) {
    try {
      ctx.io.out(await readFile(join(runDir, "report.json"), "utf8"));
      return EXIT_OK;
    } catch (error) {
      return fail(ctx, `运行 ${runId} 没有 report.json：${errorText(error)}`);
    }
  }

  try {
    const markdown = await readFile(join(runDir, "report.md"), "utf8");
    ctx.io.out(markdown.trimEnd());
    return EXIT_OK;
  } catch {
    // Fall back to the machine-readable report rather than failing a lookup
    // that did produce evidence.
    try {
      ctx.io.out(await readFile(join(runDir, "report.json"), "utf8"));
      return EXIT_OK;
    } catch (error) {
      return fail(ctx, `运行 ${runId} 没有报告：${errorText(error)}`);
    }
  }
}

interface ReadyContext {
  paths: { scenarioDirectory: string; runsDirectory: string };
  store: ReturnType<typeof createRunStore>;
}

async function requireWorkspace(
  manager: WorkspaceManager,
  ctx: CliContext,
): Promise<ReadyContext | null> {
  try {
    const ready = await manager.requireReady();
    return {
      paths: {
        scenarioDirectory: ready.paths.scenarioDirectory,
        runsDirectory: ready.paths.runsDirectory,
      },
      store: createRunStore(ready.paths.runsDirectory, ready.workspaceRoot),
    };
  } catch (error) {
    ctx.io.err(`perfstage: ${errorText(error)}`);
    ctx.io.err("先运行 `perfstage init` 初始化工作区。");
    return null;
  }
}

function renderSummary(result: RunTakeSummary, io: CliIO): void {
  io.out(
    `运行 ${result.runId}  status=${result.status}  gate=${result.gate}  用时 ${formatDuration(result.durationMs)}${
      result.repetitionCount > 1 ? `  重复 ${result.repetitionCount} 次取中位数` : ""
    }`,
  );

  for (const metric of result.metrics) {
    const value =
      metric.value === undefined ? "—" : String(metric.value);
    const verdict = metric.verdict === undefined ? "" : `  ${metric.verdict}`;
    const trace = metric.tracePath === undefined ? "" : `  ${metric.tracePath}`;
    io.out(
      `  ${metric.name.padEnd(10)} ${value} ${metric.unit ?? ""}${verdict}${trace}`,
    );
  }

  for (const action of result.actions) {
    io.out(
      `  动作 ${action.actionId}: ${action.outcome}${
        action.error === undefined ? "" : ` (${action.error})`
      }`,
    );
  }

  for (const finding of result.findings) {
    io.out(`  [${finding.severity}] ${finding.code}: ${finding.message}`);
  }
  for (const note of result.notes) {
    io.out(`  备注：${note}`);
  }

  io.out(`报告：${result.reportPath}`);
  io.out(`      ${result.reportMarkdownPath}`);
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const seconds = Math.round(ms / 1_000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes === 0 ? `${rest}s` : `${minutes}m${String(rest).padStart(2, "0")}s`;
}

function parseRepetitions(value: string | undefined): number | undefined | "invalid" {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
    return "invalid";
  }
  return parsed;
}

function parseLimit(value: string | undefined): number | undefined | "invalid" {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
    return "invalid";
  }
  return parsed;
}

function parseSamples(value: string | undefined): number | undefined | "invalid" {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 3 || parsed > 20) {
    return "invalid";
  }
  return parsed;
}

function fail(ctx: CliContext, message: string): ExitCode {
  ctx.io.err(message.startsWith("perfstage:") ? message : `perfstage: ${message}`);
  return EXIT_ENVIRONMENT;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
