import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RunStore } from "../storage/runs.js";
import { createRunStore } from "../storage/runs.js";
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
        "校验传入的场景或一次性方案、合并执行/设备/指标/诊断覆盖、创建 prepared 状态的 TestRun 并返回 Claude 后续要执行的步骤列表。",
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
      });
      if ("error" in result) {
        return toToolErrorResult(result.error);
      }
      return toToolResult(result);
    },
  );
}