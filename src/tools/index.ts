import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RunStore } from "../storage/runs.js";
import { createRunStore } from "../storage/runs.js";
import type { DeviceDriver } from "../device/types.js";
import type { TraceRecorder } from "../recording/types.js";
import type { TraceAnalyzer } from "../runner/execute.js";
import type {
  ReadyWorkspace,
  WorkspaceManager,
} from "../workspace/manager.js";
import {
  listPerformanceScenarios,
  listScenariosInputSchema,
} from "./scenarios.js";
import {
  prepareInputSchema,
  preparePerformanceTest,
} from "./plan.js";
import {
  finalizeInputSchema,
  finalizePerformanceTest,
} from "./report.js";
import {
  initializePerformanceWorkspace,
  initializeWorkspaceInputSchema,
} from "./workspace.js";
import {
  analyzePerformanceTrace,
  analyzeTraceInputSchema,
} from "./analyze.js";
import {
  runInputSchema,
  runPerformanceTest,
} from "./run.js";
import {
  listPerformanceRuns,
  runsQuerySchema,
} from "./runs.js";
import {
  comparePerformanceRuns,
  compareQuerySchema,
} from "./compare.js";

/**
 * Shared options passed to every tool handler.
 *
 * Production callers (MCP server startup and the smoke tests) supply a
 * {@link WorkspaceManager}. The readiness guard translates every
 * "uninitialized" / "invalid" workspace state into a structured tool
 * error before any side-effecting handler runs, then materializes the
 * canonical `scenarioDir` and `runStore` from the resolved workspace
 * paths so the handler itself never has to look them up.
 *
 * Legacy tests that build a tool harness against a raw `scenarioDir` /
 * `runStore` pair without bootstrapping a workspace are still supported
 * by passing the legacy fields directly and omitting
 * `workspaceManager`. {@link resolveReadyWorkspace} detects the missing
 * manager and uses the legacy paths verbatim.
 *
 * `scenarioDir` and `runStore` are typed as optional because the
 * production wiring only carries the workspace manager. The readiness
 * guard fills them in from the workspace before the handler is invoked;
 * the harness layer is responsible for the same. When the legacy
 * fallback is used the harness must inject the fields directly.
 */
export interface RegisterOptions {
  workspaceManager?: WorkspaceManager;
  scenarioDir?: string;
  runStore?: RunStore;
  now: () => Date;
  runsRoot?: string;
  /**
   * Runner collaborators. Production omits these and the `run_performance_test`
   * handler builds the real mobilecli/ xctrace adapters on demand; tests inject
   * fakes so the orchestration can be exercised without a plugged-in iPhone.
   */
  device?: DeviceDriver;
  recorder?: TraceRecorder;
  analyze?: TraceAnalyzer;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  settleMs?: number;
  launchSettleMs?: number;
  memorySettleMs?: number;
  passCooldownMs?: number;
  healthCheck?: boolean;
  healthCheckSettleMs?: number;
  foregroundTimeoutMs?: number;
  postLaunchSampleMs?: number;
  elementTimeoutMs?: number;
  /** See `ExecuteTakeDependencies.minimumWindowMs`; mainly a test knob. */
  minimumWindowMs?: number;
}

/**
 * Outcome of {@link resolveReadyWorkspace}. Exactly one branch is set;
 * consumers should `switch` on `kind` for exhaustive handling.
 */
export type ResolvedWorkspace =
  | {
      kind: "ready";
      scenarioDir: string;
      runStore: RunStore;
      workspace: ReadyWorkspace | null;
      /**
       * Workspace-relative path to the runs directory (e.g.
       * `.performance-test/runs`). Surfaced so production callers can
       * pipe it into handler `RegisterOptions.runsRoot` without having
       * to re-derive it from the workspace config. `undefined` when
       * the legacy fallback is in use.
       */
      runsRoot: string | undefined;
    }
  | { kind: "error"; error: string };

/**
 * Shared readiness guard used by every side-effecting tool handler.
 *
 * The helper must run BEFORE any of: scenario loading, run creation,
 * evidence copying, or report writing. Initialization itself stays
 * callable in either state — it is the tool that flips the state.
 *
 * Resolution order:
 *
 *   1. When `options.workspaceManager` is provided, ask it for the
 *      ready context. Success returns the canonical `scenarioDir` /
 *      `runStore` rooted at the workspace paths; failure returns a
 *      structured tool error containing the
 *      `initialize_performance_workspace` hint that
 *      {@link WorkspaceNotReadyError} already includes.
 *   2. When `options.workspaceManager` is missing, fall back to the
 *      legacy `scenarioDir` / `runStore` pair. Tests that bootstrap a
 *      scenario directory directly rely on this branch.
 */
export async function resolveReadyWorkspace(
  options: RegisterOptions,
): Promise<ResolvedWorkspace> {
  if (options.workspaceManager) {
    try {
      const ready = await options.workspaceManager.requireReady();
      return {
        kind: "ready",
        scenarioDir: ready.paths.scenarioDirectory,
        runStore: createRunStore(ready.paths.runsDirectory, ready.workspaceRoot),
        workspace: ready,
        runsRoot: ready.config.runsDirectory,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { kind: "error", error: message };
    }
  }

  if (options.scenarioDir && options.runStore) {
    return {
      kind: "ready",
      scenarioDir: options.scenarioDir,
      runStore: options.runStore,
      workspace: null,
      runsRoot: options.runsRoot,
    };
  }

  return {
    kind: "error",
    error:
      "RegisterOptions must include workspaceManager (production) or scenarioDir+runStore (legacy tests).",
  };
}

/**
 * Assert that {@link ResolvedWorkspace} succeeded and return the typed
 * `scenarioDir` / `runStore` pair. Used by every side-effecting handler
 * after the readiness guard so the downstream code can treat the fields
 * as non-null without optional chaining.
 */
export function unwrapReadyWorkspace(
  resolved: ResolvedWorkspace,
): { scenarioDir: string; runStore: RunStore; workspace: ReadyWorkspace | null } {
  if (resolved.kind !== "ready") {
    throw new Error(
      `Internal error: expected ready workspace, got error "${resolved.error}".`,
    );
  }
  return {
    scenarioDir: resolved.scenarioDir,
    runStore: resolved.runStore,
    workspace: resolved.workspace,
  };
}

function toToolErrorResult(error: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: error }],
    structuredContent: { error },
  };
}

function toToolResult(payload: unknown) {
  const structured =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : undefined;
  const text = JSON.stringify(payload, null, 2);
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: structured ?? { value: payload },
  };
}

/**
 * Register every performance-test tool on the given MCP server. Each tool
 * delegates to the same handler functions the test harness calls so protocol
 * behavior and unit-tested business logic cannot drift.
 */
export function registerTools(
  server: McpServer,
  options: RegisterOptions,
): void {
  // `initialize_performance_workspace` must be reachable from every state
  // (uninitialized AND invalid), so it intentionally never calls the
  // readiness guard.
  server.registerTool(
    "initialize_performance_workspace",
    {
      title: "Initialize Performance Workspace",
      description:
        "在当前工作目录创建 .performance-test 数据目录、写入 config.json（mode 0o600）、准备好 scenarios/ 与 runs/ 子目录，并返回工作区相对路径以及 Claude 下一步应执行的操作。",
      inputSchema: initializeWorkspaceInputSchema.shape,
    },
    async (args: unknown) => {
      if (!options.workspaceManager) {
        return toToolErrorResult(
          "initialize_performance_workspace is unavailable: server was started without a workspaceManager.",
        );
      }
      const result = await initializePerformanceWorkspace(args, {
        workspaceManager: options.workspaceManager,
        now: options.now,
      });
      if ("error" in result) {
        return toToolErrorResult(result.error);
      }
      return toToolResult(result);
    },
  );

  server.registerTool(
    "list_performance_scenarios",
    {
      title: "List Performance Scenarios",
      description:
        "枚举当前工作区中的所有性能测试场景 YAML，并返回按 id 排序的可用方案。",
      inputSchema: listScenariosInputSchema.shape,
    },
    async () => {
      const resolved = await resolveReadyWorkspace(options);
      if (resolved.kind === "error") {
        return toToolErrorResult(resolved.error);
      }
      const result = await listPerformanceScenarios({
        ...options,
        scenarioDir: resolved.scenarioDir,
        runStore: resolved.runStore,
      });
      if ("error" in result) {
        return toToolErrorResult(result.error);
      }
      return toToolResult(result);
    },
  );

  server.registerTool(
    "prepare_performance_test",
    {
      title: "Prepare Performance Test",
      description:
        "校验传入的场景或一次性方案、合并设备与指标覆盖、创建 prepared 状态的 TestRun 并返回人工接管所需的步骤列表。",
      inputSchema: prepareInputSchema.shape,
    },
    async (args: unknown) => {
      const resolved = await resolveReadyWorkspace(options);
      if (resolved.kind === "error") {
        return toToolErrorResult(resolved.error);
      }
      const result = await preparePerformanceTest(args, {
        ...options,
        scenarioDir: resolved.scenarioDir,
        runStore: resolved.runStore,
        runsRoot: resolved.runsRoot,
      });
      if ("error" in result) {
        return toToolErrorResult(result.error);
      }
      return toToolResult(result);
    },
  );

  server.registerTool(
    "finalize_performance_test",
    {
      title: "Finalize Performance Test",
      description:
        "读取 prepared 状态的运行、记录动作与证据、归一化诊断、按规则计算最终状态并写出 report.json/report.md。",
      inputSchema: finalizeInputSchema.shape,
    },
    async (args: unknown) => {
      const resolved = await resolveReadyWorkspace(options);
      if (resolved.kind === "error") {
        return toToolErrorResult(resolved.error);
      }
      const result = await finalizePerformanceTest(args, {
        ...options,
        scenarioDir: resolved.scenarioDir,
        runStore: resolved.runStore,
        runsRoot: resolved.runsRoot,
      });
      if ("error" in result) {
        return toToolErrorResult(result.error);
      }
      return toToolResult(result);
    },
  );

  server.registerTool(
    "analyze_performance_trace",
    {
      title: "Analyze Performance Trace",
      description:
        "用 PerfStage 自己的解析器读取 xctrace 录制结果，返回 finalize 可直接消费的规范指标（hitches/blockMs、launchMs、memoryMB）。",
      inputSchema: analyzeTraceInputSchema.shape,
    },
    async (args: unknown) => {
      const result = await analyzePerformanceTrace(args);
      if ("error" in result) {
        return toToolErrorResult(result.error);
      }
      return toToolResult(result);
    },
  );

  server.registerTool(
    "run_performance_test",
    {
      title: "Run Performance Test",
      description:
        "一键执行一次 Take：解析场景、驱动真机、按需录制 3 个 pass、解析 trace、做证据门禁并写出报告。返回 status / gate / metrics / reportPath。",
      inputSchema: runInputSchema.shape,
    },
    async (args: unknown) => {
      const resolved = await resolveReadyWorkspace(options);
      if (resolved.kind === "error") {
        return toToolErrorResult(resolved.error);
      }
      const result = await runPerformanceTest(args, {
        ...options,
        scenarioDir: resolved.scenarioDir,
        runStore: resolved.runStore,
        runsRoot: resolved.runsRoot,
      });
      if ("error" in result) {
        return toToolErrorResult(result.error);
      }
      return toToolResult(result);
    },
  );

  server.registerTool(
    "list_performance_runs",
    {
      title: "List Performance Runs",
      description:
        "按时间倒序列出历史运行记录，可按场景、计划、状态过滤并限制条数；索引缺失或落后时从 run.json 补全，不修改任何历史产物。",
      inputSchema: runsQuerySchema.shape,
    },
    async (args: unknown) => {
      const resolved = await resolveReadyWorkspace(options);
      if (resolved.kind === "error") {
        return toToolErrorResult(resolved.error);
      }
      const result = await listPerformanceRuns(args, {
        ...options,
        scenarioDir: resolved.scenarioDir,
        runStore: resolved.runStore,
        runsRoot: resolved.runsRoot,
      });
      if ("error" in result) {
        return toToolErrorResult(result.error);
      }
      return toToolResult(result);
    },
  );

  server.registerTool(
    "compare_performance_runs",
    {
      title: "Compare Performance Runs",
      description:
        "把一次 Take 与同场景、同设备、同 iOS 的历史基线逐指标对比：返回中位数、波动范围、差值、百分比、方向、逐指标样本数与排除计数；只读，不判定好坏，不做回归门禁。",
      inputSchema: compareQuerySchema.shape,
    },
    async (args: unknown) => {
      const resolved = await resolveReadyWorkspace(options);
      if (resolved.kind === "error") {
        return toToolErrorResult(resolved.error);
      }
      const result = await comparePerformanceRuns(args, {
        ...options,
        scenarioDir: resolved.scenarioDir,
        runStore: resolved.runStore,
        runsRoot: resolved.runsRoot,
      });
      if ("error" in result) {
        return toToolErrorResult(result.error);
      }
      return toToolResult(result);
    },
  );
}
