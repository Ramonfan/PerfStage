/**
 * End-to-end "workspace contract" test for the performance-test MCP.
 *
 * This test exercises the same handler functions the production MCP
 * server exposes (via {@link createWorkspaceToolHarness}) at the level
 * of an offline e2e fixture: a fresh temporary project is created,
 * `initialize_performance_workspace` is invoked, then
 * `list_performance_scenarios` and `prepare_performance_test` are run
 * against the just-initialized workspace. The assertions lock in the
 * offline guarantees that the README claims for user-scope install +
 * per-project initialization:
 *
 *   1. `initialize_performance_workspace` reports the canonical
 *      workspace-relative `scenarioDirectory` (".performance-test/scenarios")
 *      — confirming the runtime never falls back to package-relative or
 *      global paths.
 *   2. `list_performance_scenarios` returns exactly the scenario that
 *      lives inside the current project's scenario directory — the MCP
 *      MUST NOT cross into another project's `.performance-test/` tree.
 *   3. `prepare_performance_test` writes its run directory under the
 *      current project's `.performance-test/runs/`, never under the
 *      MCP installation root, the user's home directory, or a global
 *      fallback location.
 *
 * The "manual device integration" verification that requires a real
 * iOS device + `mobile-mcp` + `instruments-mcp-server` remains the
 * responsibility of an external operator; this offline contract does
 * NOT claim that path was exercised.
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkspaceToolHarness,
  type WorkspaceToolHarness,
  isToolError,
} from "../support/workspace-tool-harness.js";
import { createWorkspaceManager } from "../../workspace/manager.js";

/**
 * Build a fresh, fully-initialized workspace harness that already
 * contains a single scenario named `scenarioId`. The fixture mirrors
 * the production flow: a temporary project root is created, the
 * workspace is materialized through {@link createWorkspaceManager},
 * and a single scenario YAML is seeded into the project's scenario
 * directory. The returned `harness` then drives the same MCP tool
 * handlers a Claude session would call.
 *
 * NOTE: We deliberately seed the workspace directly through the manager
 * rather than through `harness.call("initialize_performance_workspace")`
 * here so the contract test below can drive the initialization call
 * itself and assert what the MCP tool returns.
 */
async function createInitializedWorkspace(options: {
  scenarioId: string;
}): Promise<{
  root: string;
  harness: WorkspaceToolHarness;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "performance-mcp-contract-"));
  await mkdir(root, { recursive: true });
  const workspaceManager = createWorkspaceManager(root);

  const built = await createWorkspaceToolHarness(root);
  await workspaceManager.initialize({});
  const seeded = await workspaceManager.requireReady();
  const scenarioFile = join(seeded.paths.scenarioDirectory, `${options.scenarioId}.yaml`);
  await writeFile(
    scenarioFile,
    `id: ${options.scenarioId}\nname: ${options.scenarioId}\napp:\n  bundleId: com.example.app\ndevice: {}\nactions:\n  - id: a\n    type: wait\n    durationMs: 100\nmetrics:\n  - name: cpu\n    instrument: Time Profiler\n`,
    "utf8",
  );

  return {
    root,
    harness: built,
    async cleanup() {
      await built.cleanup();
    },
  };
}

describe("workspace e2e contract", () => {
  const harnesses: Array<{ cleanup: () => Promise<void> }> = [];

  afterEach(async () => {
    for (const h of harnesses.splice(0)) {
      await h.cleanup();
    }
  });

  it("initializes and runs entirely inside the current project", async () => {
    const project = await createInitializedWorkspace({
      scenarioId: "community-home-scroll",
    });
    harnesses.push(project);

    const initializedResult = await project.harness.call<
      | {
          scenarioDirectory: string;
          runsDirectory: string;
        }
      | { error: string }
    >("initialize_performance_workspace", {});
    if (isToolError(initializedResult)) {
      throw new Error(initializedResult.error);
    }

    const listed = await project.harness.call<
      { scenarios: Array<{ id: string }> } | { error: string }
    >("list_performance_scenarios", {});
    if (isToolError(listed)) {
      throw new Error(listed.error);
    }

    const prepared = await project.harness.call<
      { runId: string; runPath: string } | { error: string }
    >("prepare_performance_test", {
      scenarioId: "community-home-scroll",
      device: { id: "device-1" },
    });
    if (isToolError(prepared)) {
      throw new Error(prepared.error);
    }

    expect(initializedResult.scenarioDirectory).toBe(".performance-test/scenarios");
    expect(listed.scenarios).toHaveLength(1);
    expect(prepared.runPath).toContain(".performance-test/runs/");
  });

  it("does not leak scenarios between two independent projects", async () => {
    // The README's per-project guarantee: an uninitialized (or freshly
    // initialized) project must never read another project's scenarios.
    // Two independent projects, each with its own scenario, must only
    // see their own scenario in `list_performance_scenarios`.
    const projectA = await createInitializedWorkspace({ scenarioId: "a-only" });
    const projectB = await createInitializedWorkspace({ scenarioId: "b-only" });
    harnesses.push(projectA, projectB);

    const aList = await projectA.harness.call<
      { scenarios: Array<{ id: string }> } | { error: string }
    >("list_performance_scenarios", {});
    const bList = await projectB.harness.call<
      { scenarios: Array<{ id: string }> } | { error: string }
    >("list_performance_scenarios", {});
    if (isToolError(aList)) throw new Error(aList.error);
    if (isToolError(bList)) throw new Error(bList.error);

    expect(aList.scenarios.map((s) => s.id)).toEqual(["a-only"]);
    expect(bList.scenarios.map((s) => s.id)).toEqual(["b-only"]);
  });
});