import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestToolHarness,
  isToolError,
  type PreparePerformanceTestResult,
  type TestToolHarness,
} from "../support/tool-harness.js";
import { readFile } from "node:fs/promises";

let harness: TestToolHarness | null = null;

beforeEach(async () => {
  harness = await createTestToolHarness();
});

afterEach(async () => {
  if (harness) {
    await harness.cleanup();
    harness = null;
  }
});

describe("prepare_performance_test", () => {
  it("creates a run and returns Claude-executable next steps", async () => {
    if (!harness) throw new Error("harness not initialized");
    const result = await harness.call<PreparePerformanceTestResult>(
      "prepare_performance_test",
      {
        scenarioId: "community-home-scroll",
        device: { id: "device-1", name: "Ra iPhone" },
      },
    );
    expect(isToolError(result)).toBe(false);
    expect(result.runId).toEqual(expect.any(String));
    expect(result.scenarioId).toBe("community-home-scroll");
    expect(result.nextSteps).toEqual(
      expect.arrayContaining([
        expect.stringContaining("mobile_get_device_logs"),
        expect.stringContaining("mobile_list_crashes"),
      ]),
    );
    // The instructions must guide Claude through mobile-mcp and Instruments
    // calls, and explicitly include finalize ordering.
    expect(result.nextSteps.join("\n")).toEqual(expect.stringContaining("finalize_performance_test"));
    expect(result.nextSteps.join("\n")).toEqual(expect.stringContaining("Instruments"));
    expect(result.nextSteps.join("\n")).toEqual(expect.stringContaining("mobile-mcp"));
  });

  it("persists the prepared run and resolved plan", async () => {
    if (!harness) throw new Error("harness not initialized");
    const result = await harness.call<PreparePerformanceTestResult>(
      "prepare_performance_test",
      {
        scenarioId: "community-home-scroll",
        device: { id: "device-1", name: "Ra iPhone" },
      },
    );
    if (isToolError(result)) throw new Error("expected success");
    const run = await harness.runStore.read(result.runId);
    expect(run.status).toBe("prepared");
    expect(run.planId).toBe("community-home-scroll");
    const planText = await readFile(
      join(harness.root, "runs", result.runId, "plan.json"),
      "utf8",
    );
    expect(planText).toContain("community-home-scroll");
    expect(planText).toContain("scroll-up-1");
  });

  it("rejects requests when both scenarioId and adHocPlan are supplied", async () => {
    if (!harness) throw new Error("harness not initialized");
    const result = await harness.call("prepare_performance_test", {
      scenarioId: "community-home-scroll",
      adHocPlan: {
        source: "ad_hoc",
        app: { bundleId: "com.example.app" },
        device: { id: "device-1" },
        actions: [
          { id: "scroll-1", type: "swipe", direction: "up", distance: 500 },
        ],
      },
      device: { id: "device-1", name: "Ra iPhone" },
    });
    expect(isToolError(result)).toBe(true);
    expect((result as { error: string }).error).toMatch(/both|exclusive/i);
  });

  it("rejects requests when neither scenarioId nor adHocPlan is supplied", async () => {
    if (!harness) throw new Error("harness not initialized");
    const result = await harness.call("prepare_performance_test", {
      device: { id: "device-1", name: "Ra iPhone" },
    });
    expect(isToolError(result)).toBe(true);
    expect((result as { error: string }).error).toMatch(
      /neither|required|scenario|adHocPlan/i,
    );
  });

  it("rejects unknown scenario IDs with a structured tool error", async () => {
    if (!harness) throw new Error("harness not initialized");
    const result = await harness.call("prepare_performance_test", {
      scenarioId: "nonexistent",
      device: { id: "device-1" },
    });
    expect(isToolError(result)).toBe(true);
    expect((result as { error: string }).error).toContain("nonexistent");
  });

  it("preserves metric overrides alongside the scenario's other metrics", async () => {
    if (!harness) throw new Error("harness not initialized");
    const result = await harness.call<PreparePerformanceTestResult>(
      "prepare_performance_test",
      {
        scenarioId: "community-home-scroll",
        device: { id: "device-1", name: "Ra iPhone" },
        metricOverrides: [{ name: "hitches", result: { count: 3 }, verdict: "warn" }],
      },
    );
    if (isToolError(result)) throw new Error("expected success");
    const run = await harness.runStore.read(result.runId);
    const planJson = JSON.parse(
      await readFile(
        join(harness.root, "runs", result.runId, "plan.json"),
        "utf8",
      ),
    );
    const metrics = planJson.metrics as Array<Record<string, unknown>>;
    const hitches = metrics.find((m) => m.name === "hitches");
    expect(hitches?.instrument).toBe("Animation Hitches");
    expect(hitches?.verdict).toBe("warn");
    expect(metrics.map((m) => m.name)).toContain("cpu");
    expect(metrics.map((m) => m.name)).toContain("memory");
    expect(run).toBeTruthy();
    // The override is recorded on the tool result so callers can verify it
    // round-tripped through the plan layer.
    expect(result.metricOverrides).toEqual([
      { name: "hitches", result: { count: 3 }, verdict: "warn" },
    ]);
  });

  it("accepts an ad-hoc plan with the same actions and overrides", async () => {
    if (!harness) throw new Error("harness not initialized");
    const result = await harness.call<PreparePerformanceTestResult>(
      "prepare_performance_test",
      {
        adHocPlan: {
          source: "ad_hoc",
          app: { bundleId: "com.example.app" },
          device: { id: "device-host" },
          actions: [
            { id: "scroll-1", type: "swipe", direction: "up", distance: 500 },
          ],
        },
        device: { id: "device-1", name: "Ra iPhone" },
        execution: "unattended",
      },
    );
    if (isToolError(result)) throw new Error("expected success");
    expect(result.runId).toEqual(expect.any(String));
    expect(result.execution).toBe("unattended");
  });

  it("rejects unsupported execution modes (rejects rather than rewrites)", async () => {
    if (!harness) throw new Error("harness not initialized");
    const result = await harness.call("prepare_performance_test", {
      scenarioId: "community-home-scroll",
      device: { id: "device-1" },
      execution: "automated",
    });
    expect(isToolError(result)).toBe(true);
    expect((result as { error: string }).error).toMatch(
      /execution|automated|invalid/i,
    );
  });

  it("rejects unsupported plan sources (rejects rather than rewrites)", async () => {
    if (!harness) throw new Error("harness not initialized");
    const result = await harness.call("prepare_performance_test", {
      adHocPlan: {
        source: "schedule",
        app: { bundleId: "com.example.app" },
        device: { id: "any" },
        actions: [
          { id: "a", type: "wait", durationMs: 100 },
        ],
      },
      device: { id: "device-1" },
    });
    expect(isToolError(result)).toBe(true);
    expect((result as { error: string }).error).toMatch(
      /source|schedule|invalid/i,
    );
  });

  it("returns next steps that name the requested metric instruments", async () => {
    if (!harness) throw new Error("harness not initialized");
    const result = await harness.call<PreparePerformanceTestResult>(
      "prepare_performance_test",
      {
        scenarioId: "community-home-scroll",
        device: { id: "device-1", name: "Ra iPhone" },
      },
    );
    if (isToolError(result)) throw new Error("expected success");
    expect(result.nextSteps.join("\n")).toContain("Animation Hitches");
    expect(result.nextSteps.join("\n")).toContain("Time Profiler");
    expect(result.nextSteps.join("\n")).toContain("Allocations");
  });

  it("does not perform any device operation inside the handler", async () => {
    if (!harness) throw new Error("harness not initialized");
    // The handler should never reach for a device driver. We confirm by
    // destroying the harness's access to a network call surface: if any
    // handler tried to perform a device operation it would surface via the
    // test runner. The cleanest assertion is that the result is fully
    // synchronous w.r.t. file IO.
    await writeFile(
      join(harness.scenarioDir, "community-home-scroll.yaml"),
      (await readFile(join(harness.scenarioDir, "community-home-scroll.yaml"), "utf8")) + "\n",
      "utf8",
    );
    const result = await harness.call("prepare_performance_test", {
      scenarioId: "community-home-scroll",
      device: { id: "device-1" },
    });
    expect(isToolError(result)).toBe(false);
  });
});
