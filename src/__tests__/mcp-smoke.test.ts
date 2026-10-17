import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerTools } from "../tools/index.js";
import { createRunStore } from "../storage/runs.js";

interface RegisteredToolSummary {
  name: string;
  description?: string;
}

interface ToolListResult {
  tools: RegisteredToolSummary[];
}

const EXPECTED_TOOLS = [
  "list_performance_scenarios",
  "prepare_performance_test",
  "finalize_performance_test",
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
  it("exposes exactly the three named tools via the MCP protocol", async () => {
    if (!root) throw new Error("root not initialized");
    const server = new McpServer(
      { name: "performance-test-mcp", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    registerTools(server, {
      scenarioDir: join(root, "scenarios"),
      runStore: createRunStore(join(root, "runs")),
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

  it("returns a tool error (not a thrown exception) for malformed scenarios", async () => {
    if (!root) throw new Error("root not initialized");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const scenarioDir = join(root, "scenarios");
    await mkdir(scenarioDir, { recursive: true });
    await writeFile(
      join(scenarioDir, "broken.yaml"),
      "id: broken\napp: { bundleId: x }\nactions:\n  - id: bad\n    type: ??\n",
      "utf8",
    );
    const server = new McpServer(
      { name: "performance-test-mcp", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    registerTools(server, {
      scenarioDir,
      runStore: createRunStore(join(root, "runs")),
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
        toolResult.content.some((c) => c.type === "text" && /broken\.yaml/.test(c.text)),
      ).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
