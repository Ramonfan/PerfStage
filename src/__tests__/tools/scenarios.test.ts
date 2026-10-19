import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestToolHarness,
  isToolError,
  type TestToolHarness,
} from "../support/tool-harness.js";

let harness: TestToolHarness | null = null;
const roots: string[] = [];

beforeEach(async () => {
  harness = await createTestToolHarness();
});

afterEach(async () => {
  if (harness) {
    await harness.cleanup();
    harness = null;
  }
  for (const root of roots) {
    try {
      const { rm } = await import("node:fs/promises");
      await rm(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  roots.length = 0;
});

describe("list_performance_scenarios", () => {
  it("returns sorted scenarios with id, name, bundleId, action count, metric names, and diagnostic defaults", async () => {
    if (!harness) throw new Error("harness not initialized");
    const result = await harness.call("list_performance_scenarios");
    expect(isToolError(result)).toBe(false);
    const scenarios = (result as { scenarios: Array<Record<string, unknown>> }).scenarios;
    expect(scenarios).toHaveLength(2);
    expect(scenarios[0]?.id).toBe("community-home-scroll");
    expect(scenarios[1]?.id).toBe("message-list-scroll");
    const community = scenarios[0] as Record<string, unknown>;
    expect(community.name).toBe("社区首页来回滚动");
    expect(community.bundleId).toBe("com.nndev.im");
    expect(community.actionCount).toBe(2);
    expect(community.metricNames).toEqual(["hitches", "cpu", "memory"]);
    const diag = community.diagnostics as Record<string, unknown>;
    expect(diag.collectDeviceLogs).toBe(true);
    expect(diag.collectCrashes).toBe(true);
  });

  it("returns a structured error containing the path when a scenario is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "performance-mcp-bad-scenario-"));
    roots.push(root);
    const harness2 = await createTestToolHarness(root);
    try {
      const { writeFile } = await import("node:fs/promises");
      const path = join(harness2.scenarioDir, "broken.yaml");
      await writeFile(
        path,
        "id: broken\napp: { bundleId: x }\nactions:\n  - id: bad\n    type: ??\n",
        "utf8",
      );
      const result = await harness2.call("list_performance_scenarios");
      expect(isToolError(result)).toBe(true);
      expect((result as { error: string }).error).toContain("broken.yaml");
    } finally {
      await harness2.cleanup();
    }
  });
});
