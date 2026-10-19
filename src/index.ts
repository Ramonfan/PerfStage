import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { registerTools } from "./tools/index.js";
import { createWorkspaceManager } from "./workspace/manager.js";
import { createRunStore } from "./storage/runs.js";

/**
 * Build a fresh MCP server with all performance-test tools registered.
 *
 * The server uses a workspace-scoped configuration rooted at
 * `process.cwd()`. The very first tool call Claude makes is expected to
 * be `initialize_performance_workspace`; that call materializes
 * `.performance-test/` inside the cwd and seeds the config.json with
 * restrictive permissions. Subsequent tool calls run against the
 * workspace-resolved scenario and runs directories — no tool reads from
 * the package installation directory.
 *
 * Diagnostics and tests are kept off of stdout; only the JSON-RPC stream is
 * emitted there. Everything else goes to stderr or the file system.
 */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: "performance-test-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  const workspaceManager = createWorkspaceManager(process.cwd());
  registerTools(server, {
    workspaceManager,
    scenarioDir: process.cwd(),
    runStore: createRunStore(process.cwd()),
    now: () => new Date(),
  });
  return server;
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const workspaceManager = createWorkspaceManager(process.cwd());
  const server = new McpServer(
    { name: "performance-test-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, {
    workspaceManager,
    scenarioDir: process.cwd(),
    runStore: createRunStore(process.cwd()),
    now: () => new Date(),
  });
  await server.connect(new StdioServerTransport());
}