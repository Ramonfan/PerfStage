import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerTools } from "../tools/index.js";
import { createWorkspaceManager } from "../workspace/manager.js";
import { createRunStore } from "../storage/runs.js";
import { SERVER_INFO } from "../version.js";

interface RegisteredToolSummary {
  name: string;
  description?: string;
}

interface ToolListResult {
  tools: RegisteredToolSummary[];
}

const EXPECTED_TOOLS = [
  "initialize_performance_workspace",
  "list_performance_scenarios",
  "prepare_performance_test",
  "run_performance_test",
  "analyze_performance_trace",
  "finalize_performance_test",
  "list_performance_runs",
  "compare_performance_runs",
];

let root: string | null = null;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "performance-mcp-smoke-"));
});

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = null;
  }
});

describe("MCP server smoke", () => {
  it("exposes exactly the eight named tools via the MCP protocol", async () => {
    if (!root) throw new Error("root not initialized");
    const server = new McpServer(
      SERVER_INFO,
      { capabilities: { tools: {} } },
    );
    const workspaceManager = createWorkspaceManager(root);
    registerTools(server, {
      workspaceManager,
      scenarioDir: join(root, "scenarios"),
      runStore: createRunStore(join(root, "runs"), root),
      now: () => new Date(),
    });
    const client = new Client(
      { name: "smoke", version: "0.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    try {
      const result = (await client.listTools()) as ToolListResult;
      const names = result.tools.map((t) => t.name).sort();
      expect(names).toEqual([...EXPECTED_TOOLS].sort());
      for (const expected of EXPECTED_TOOLS) {
        const found = result.tools.find((t) => t.name === expected);
        expect(found, `tool ${expected}`).toBeDefined();
        expect(found?.description).toBeTruthy();
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns a tool error (not a thrown exception) when called before workspace initialization", async () => {
    if (!root) throw new Error("root not initialized");
    const server = new McpServer(
      SERVER_INFO,
      { capabilities: { tools: {} } },
    );
    const workspaceManager = createWorkspaceManager(root);
    registerTools(server, {
      workspaceManager,
      scenarioDir: join(root, "scenarios"),
      runStore: createRunStore(join(root, "runs"), root),
      now: () => new Date(),
    });
    const client = new Client(
      { name: "smoke", version: "0.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    try {
      const callResult = await client.callTool({
        name: "list_performance_scenarios",
        arguments: {},
      });
      const toolResult = callResult as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
        structuredContent?: unknown;
      };
      expect(toolResult.isError).toBe(true);
      expect(
        toolResult.content.some(
          (c) => c.type === "text" && /initialize_performance_workspace/.test(c.text),
        ),
      ).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns a comparison through the MCP transport", async () => {
    if (!root) throw new Error("root not initialized");
    const server = new McpServer(
      SERVER_INFO,
      { capabilities: { tools: {} } },
    );
    const workspaceManager = createWorkspaceManager(root);
    registerTools(server, {
      workspaceManager,
      scenarioDir: join(root, "scenarios"),
      runStore: createRunStore(join(root, "runs"), root),
      now: () => new Date(),
    });
    const client = new Client(
      { name: "smoke", version: "0.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    try {
      const init = await client.callTool({
        name: "initialize_performance_workspace",
        arguments: {},
      });
      expect((init as { isError?: boolean }).isError).toBeFalsy();

      const runStore = createRunStore(
        join(root, ".performance-test", "runs"),
        root,
      );
      const seed = async (id: string, startedAt: string, value: number) => {
        await runStore.create({
          id,
          planId: "scene-1",
          device: { id: "device-1", osVersion: "27.0.1" },
          status: "completed",
          startedAt,
          endedAt: startedAt,
          durationMs: 1_000,
          repetitions: 1,
          currentRepetition: 0,
          actions: [],
          metrics: [{ name: "hitches", value, unit: "次" }],
          evidence: { screenshotPaths: [], traceArchivePaths: [] },
          lifecycle: [],
        });
      };
      await seed("target", "2026-11-16T04:00:00.000Z", 12);
      await seed("base-1", "2026-11-16T01:00:00.000Z", 8);
      await seed("base-2", "2026-11-16T02:00:00.000Z", 14);
      await seed("base-3", "2026-11-16T03:00:00.000Z", 10);

      const callResult = await client.callTool({
        name: "compare_performance_runs",
        arguments: { runId: "target" },
      });
      const toolResult = callResult as {
        isError?: boolean;
        structuredContent?: {
          status?: string;
          baseline?: { samples?: number };
          metrics?: Array<Record<string, unknown>>;
        };
      };
      expect(toolResult.isError).toBeFalsy();
      expect(toolResult.structuredContent).toMatchObject({
        status: "comparable",
        baseline: { samples: 3 },
      });
      expect(toolResult.structuredContent?.metrics?.[0]).toMatchObject({
        name: "hitches",
        baselineMedian: 10,
        samples: 3,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
