import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { registerTools } from "./tools/index.js";
import { createRunStore } from "./storage/runs.js";

const SCENARIO_DIR = process.env.PERFORMANCE_TEST_SCENARIO_DIR ?? "scenarios";
const RUNS_DIR = process.env.PERFORMANCE_TEST_RUNS_DIR ?? "runs";

/**
 * Build a fresh MCP server with all performance-test tools registered.
 *
 * `scenarioDir` and the runs directory are configurable through environment
 * variables so the server can be pointed at test fixtures without code edits.
 * Diagnostics and tests are kept off of stdout; only the JSON-RPC stream is
 * emitted there. Everything else goes to stderr or the file system.
 */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: "performance-test-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, {
    scenarioDir: SCENARIO_DIR,
    runStore: createRunStore(RUNS_DIR),
    now: () => new Date(),
    runsRoot: RUNS_DIR,
  });
  return server;
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const scenarioDir = resolve(process.cwd(), SCENARIO_DIR);
  const runsDir = resolve(process.cwd(), RUNS_DIR);
  const server = new McpServer(
    { name: "performance-test-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, {
    scenarioDir,
    runStore: createRunStore(runsDir),
    now: () => new Date(),
    runsRoot: runsDir,
  });
  await server.connect(new StdioServerTransport());
}
