import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWorkspaceToolHarness,
  isToolError,
  type WorkspaceToolHarness,
} from "../support/workspace-tool-harness.js";

let harness: WorkspaceToolHarness | null = null;

beforeEach(async () => {
  harness = await createWorkspaceToolHarness();
});

afterEach(async () => {
  if (harness) {
    await harness.cleanup();
    harness = null;
  }
  // No other temp roots tracked here; harness owns its directory.
});

describe("initialize_performance_workspace", () => {
  it("initializes the current workspace and returns relative paths", async () => {
    if (!harness) throw new Error("harness not initialized");
    const result = await harness.call("initialize_performance_workspace", {
      bundleId: "com.example.app",
      appName: "Example",
    });
    expect(isToolError(result)).toBe(false);
    if (isToolError(result)) throw new Error(result.error);
    const payload = result as {
      initialized: boolean;
      scenarioDirectory: string;
      runsDirectory: string;
      firstInitialization: boolean;
    };
    expect(payload.initialized).toBe(true);
    expect(payload.scenarioDirectory).toBe(".performance-test/scenarios");
    expect(payload.runsDirectory).toBe(".performance-test/runs");
    expect(payload.firstInitialization).toBe(true);
  });

  it("does not copy embedded template scenarios unless explicitly requested", async () => {
    if (!harness) throw new Error("harness not initialized");
    const result = await harness.call("initialize_performance_workspace", {
      bundleId: "com.example.app",
    });
    expect(isToolError(result)).toBe(false);
    const entries = await harness.listScenarioFiles();
    expect(entries).toEqual([]);
  });

  it("is idempotent and reports firstInitialization false on a second call", async () => {
    if (!harness) throw new Error("harness not initialized");
    const first = await harness.call("initialize_performance_workspace", {
      bundleId: "com.example.app",
      appName: "Example",
    });
    expect(isToolError(first)).toBe(false);
    const second = await harness.call("initialize_performance_workspace", {
      bundleId: "com.other.app",
    });
    expect(isToolError(second)).toBe(false);
    if (isToolError(second)) throw new Error(second.error);
    expect((second as { firstInitialization: boolean }).firstInitialization).toBe(
      false,
    );
  });
});

describe("list_performance_scenarios without an initialized workspace", () => {
  it("tells Claude how to initialize via initialize_performance_workspace", async () => {
    if (!harness) throw new Error("harness not initialized");
    const result = await harness.call("list_performance_scenarios", {});
    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) throw new Error("expected tool error");
    expect(result.error).toContain("initialize_performance_workspace");
  });
});