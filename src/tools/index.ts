import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RunStore } from "../storage/runs.js";
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

/**
 * Shared options passed to every tool handler. `scenarioDir` lists the YAML
 * scenarios, `runStore` is the persistence layer for `run.json` and evidence,
 * `now` returns the current time (overridable for tests), and `runsRoot`
 * optionally exposes the absolute root when callers need absolute paths.
 */
export interface RegisterOptions {
  scenarioDir: string;
  runStore: RunStore;
  now: () => Date;
  runsRoot?: string;
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
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined;
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
  server.registerTool(
    "list_performance_scenarios",
    {
      title: "List Performance Scenarios",
      description:
        "读取当前目录下的所有性能测试场景 YAML，并返回按 id 排序的可用方案。",
      inputSchema: listScenariosInputSchema.shape,
    },
    async () => {
      const result = await listPerformanceScenarios(options);
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
      const result = await preparePerformanceTest(args, options);
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
      const result = await finalizePerformanceTest(args, options);
      if ("error" in result) {
        return toToolErrorResult(result.error);
      }
      return toToolResult(result);
    },
  );
}
