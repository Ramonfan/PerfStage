import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listPerformanceScenarios,
  type ListPerformanceScenariosResult,
} from "../../tools/scenarios.js";
import {
  preparePerformanceTest,
  type PreparePerformanceTestResult,
} from "../../tools/plan.js";
import {
  finalizePerformanceTest,
  type FinalizePerformanceTestResult,
} from "../../tools/report.js";
import { createRunStore, type RunStore } from "../../storage/runs.js";

/**
 * The MCP tool harness is a test-only convenience layer. It mounts the same
 * production tool handlers against a temporary directory so we can exercise
 * them without an MCP transport.
 *
 * We deliberately do NOT implement the MCP protocol a second time. Each
 * `call` invokes the handler directly with parsed arguments and returns
 * whatever the handler returns (success data or `{ error: ... }`).
 */

export interface TestToolHarness {
  readonly root: string;
  readonly scenarioDir: string;
  readonly runsDir: string;
  readonly runStore: RunStore;
  call<T = unknown>(toolName: string, args?: unknown): Promise<T>;
  cleanup(): Promise<void>;
}

const COMMUNITY_YAML = `id: community-home-scroll
name: 社区首页来回滚动
app:
  bundleId: com.nndev.im
device: {}
preconditions:
  foregroundBundleId: com.nndev.im
  accessibilityText: 社区
warmup:
  - id: open-community
    type: tap
    target: 社区
    waitAfterMs: 1500
actions:
  - id: scroll-up-1
    type: swipe
    direction: up
    distance: 700
    durationMs: 500
    waitAfterMs: 1500
  - id: scroll-down-1
    type: swipe
    direction: down
    distance: 700
    durationMs: 500
    waitAfterMs: 1500
metrics:
  - name: hitches
    instrument: Animation Hitches
  - name: cpu
    instrument: Time Profiler
  - name: memory
    instrument: Allocations
`;

const MESSAGE_YAML = `id: message-list-scroll
name: 消息列表来回滚动
app:
  bundleId: com.nndev.im
device: {}
preconditions:
  foregroundBundleId: com.nndev.im
  accessibilityText: 消息
warmup:
  - id: open-message-tab
    type: tap
    target: 消息
    waitAfterMs: 1500
actions:
  - id: scroll-up-1
    type: swipe
    direction: up
    distance: 700
    durationMs: 500
    waitAfterMs: 1500
  - id: scroll-down-1
    type: swipe
    direction: down
    distance: 700
    durationMs: 500
    waitAfterMs: 1500
metrics:
  - name: hitches
    instrument: Animation Hitches
`;

export async function createTestToolHarness(
  rootOverride?: string,
): Promise<TestToolHarness> {
  const root =
    rootOverride ?? (await mkdtemp(join(tmpdir(), "performance-mcp-")));
  await mkdir(root, { recursive: true });
  const scenarioDir = join(root, "scenarios");
  const runsDir = join(root, "runs");
  await mkdir(scenarioDir, { recursive: true });
  await mkdir(runsDir, { recursive: true });
  await writeFile(join(scenarioDir, "community-home-scroll.yaml"), COMMUNITY_YAML, "utf8");
  await writeFile(join(scenarioDir, "message-list-scroll.yaml"), MESSAGE_YAML, "utf8");

  const runStore = createRunStore(runsDir);

  const harness: TestToolHarness = {
    root,
    scenarioDir,
    runsDir,
    runStore,
    async call<T = unknown>(toolName: string, args?: unknown): Promise<T> {
      if (toolName === "list_performance_scenarios") {
        return (await listPerformanceScenarios({
          scenarioDir,
          runStore,
          now: () => new Date(),
        })) as T;
      }
      if (toolName === "prepare_performance_test") {
        return (await preparePerformanceTest(args ?? {}, {
          scenarioDir,
          runStore,
          now: () => new Date(),
        })) as T;
      }
      if (toolName === "finalize_performance_test") {
        return (await finalizePerformanceTest(args ?? {}, {
          scenarioDir,
          runStore,
          now: () => new Date(),
        })) as T;
      }
      throw new Error(`unknown tool "${toolName}"`);
    },
    async cleanup(): Promise<void> {
      await rm(root, { recursive: true, force: true });
    },
  };

  return harness;
}

/**
 * Convenience wrappers around the raw `call` that return either the success
 * payload or throw the formatted tool error. Useful for cases where the test
 * wants to assert failure messages.
 */
export async function callExpectingSuccess<T>(
  harness: TestToolHarness,
  toolName: string,
  args?: unknown,
): Promise<T> {
  const result = (await harness.call(toolName, args)) as T | { error: string };
  if (
    result &&
    typeof result === "object" &&
    "error" in (result as Record<string, unknown>)
  ) {
    throw new Error(`tool error: ${(result as { error: string }).error}`);
  }
  return result as T;
}

export interface ToolError {
  error: string;
}

export function isToolError(value: unknown): value is ToolError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { error?: unknown }).error === "string"
  );
}

export type { ListPerformanceScenariosResult, PreparePerformanceTestResult, FinalizePerformanceTestResult };
