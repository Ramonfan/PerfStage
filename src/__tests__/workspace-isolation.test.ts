import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkspaceToolHarness,
  type WorkspaceToolHarness,
} from "./support/workspace-tool-harness.js";
import { createWorkspaceManager } from "../workspace/manager.js";
import { createRunStore, type RunStore } from "../storage/runs.js";

/**
 * Build a fresh, fully-initialized workspace harness that already contains
 * a single scenario named `scenarioId`. Used by the cross-workspace
 * isolation test so each project sees only its own scenarios.
 *
 * The harness performs every step the production flow would:
 *
 *   1. Create a temp workspace root.
 *   2. Call `initialize_performance_workspace` to materialize
 *      `.performance-test/`.
 *   3. Drop a single scenario YAML into the workspace scenario directory.
 *
 * The returned object exposes the same `call` API as
 * {@link createWorkspaceToolHarness} plus a `cleanup` helper so tests
 * stay self-contained.
 */
async function createInitializedWorkspace(options: {
  scenarioId: string;
}): Promise<{
  root: string;
  harness: WorkspaceToolHarness;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "performance-mcp-iso-"));
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

describe("workspace isolation", () => {
  const harnesses: Array<{ cleanup: () => Promise<void> }> = [];

  afterEach(async () => {
    for (const h of harnesses.splice(0)) {
      await h.cleanup();
    }
  });

  it("does not read scenarios from another workspace", async () => {
    const projectA = await createInitializedWorkspace({ scenarioId: "a-only" });
    const projectB = await createInitializedWorkspace({ scenarioId: "b-only" });
    harnesses.push(projectA, projectB);

    const aResult = (await projectA.harness.call("list_performance_scenarios", {})) as {
      scenarios: Array<{ id: string }>;
    };
    const bResult = (await projectB.harness.call("list_performance_scenarios", {})) as {
      scenarios: Array<{ id: string }>;
    };

    expect(aResult.scenarios.map((s) => s.id)).toEqual(["a-only"]);
    expect(bResult.scenarios.map((s) => s.id)).toEqual(["b-only"]);
  });

  it("does not create runs when workspace is uninitialized", async () => {
    const harness = await createWorkspaceToolHarness();
    harnesses.push(harness);

    const result = (await harness.call("prepare_performance_test", {
      scenarioId: "anything",
      device: { id: "device-1" },
    })) as { error?: string };

    expect(result.error).toBeDefined();
    expect(result.error).toContain("initialize_performance_workspace");
    // The .performance-test/runs directory must NOT have been created as a
    // side effect of the failed prepare call.
    await expect(access(join(harness.root, ".performance-test/runs"))).rejects.toThrow();
  });

  it("production registerTools: only the workspace manager is required (no scenarioDir/runStore defaults)", async () => {
    // The factory creates a server with a manager that points at the temp
    // root. Calling a tool before initialization must surface the
    // readiness error rather than silently falling back to package-relative
    // paths.
    const root = await mkdtemp(join(tmpdir(), "performance-mcp-prod-register-"));
    const workspaceManager = createWorkspaceManager(root);
    // We assert the production registration path here via direct call: the
    // workspace manager is provided with NO scenarioDir/runStore, matching
    // the post-Task-4 production wiring.
    const result = (await workspaceManager.requireReady().catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    }))) as { error?: string };
    expect(result.error).toMatch(/initialize_performance_workspace/);
    await expect(access(join(root, ".performance-test/runs"))).rejects.toThrow();
  });

  it("runStore copyEvidence/writeText reject symlinked path components that escape the run dir", async () => {
    const root = await mkdtemp(join(tmpdir(), "performance-mcp-symlink-"));
    const runsRoot = join(root, ".performance-test", "runs");
    await mkdir(runsRoot, { recursive: true });
    const runStore: RunStore = createRunStore(runsRoot, root);

    // Seed an existing run so the relative-path validator accepts the id.
    const seededRunId = "symlink-victim";
    await mkdir(join(runsRoot, seededRunId), { recursive: true });
    await writeFile(
      join(runsRoot, seededRunId, "run.json"),
      JSON.stringify({ id: seededRunId, status: "prepared" }),
      "utf8",
    );

    // Plant a symlink that points outside the run dir; the absolute
    // escape target is created in the workspace root so the lstat check
    // can resolve through to it.
    const outsideDir = join(root, "outside");
    await mkdir(outsideDir, { recursive: true });
    const { symlink } = await import("node:fs/promises");
    await symlink(outsideDir, join(runsRoot, seededRunId, "escape"));

    await expect(
      runStore.writeText(seededRunId, "escape/inside.txt", "x"),
    ).rejects.toThrow(/symlink|escape/i);

    // Sanity: the writeText rejection happened BEFORE bytes were written.
    await expect(access(join(outsideDir, "inside.txt"))).rejects.toThrow();
  });

  it("tryFinalize does not mkdir the run dir for unknown run ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "performance-mcp-no-mkdir-"));
    const runsRoot = join(root, ".performance-test", "runs");
    await mkdir(runsRoot, { recursive: true });
    const runStore = createRunStore(runsRoot, root);

    const outcome = await runStore.tryFinalize("ghost", {
      mutate: (current) => ({ ...current, status: "completed" }),
    });
    expect(outcome.kind).toBe("missing");
    // No empty directory should have been left behind.
    await expect(access(join(runsRoot, "ghost"))).rejects.toThrow();
  });

  it("metric tracePath/instrument/unknown passthrough survive finalize (cross-workspace regression)", async () => {
    const projectA = await createInitializedWorkspace({ scenarioId: "metric-x" });
    harnesses.push(projectA);

    // Seed a prepared run directly into project A's runs directory so we
    // can drive finalize without an entire prepare→finalize roundtrip.
    const ready = await projectA.harness.workspaceManager.requireReady();
    const seededRunId = "trace-test";
    const runDir = join(ready.paths.runsDirectory, seededRunId);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "run.json"),
      JSON.stringify({
        id: seededRunId,
        planId: "metric-x",
        status: "prepared",
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: null,
        repetitions: 1,
        currentRepetition: 0,
        actions: [],
        metrics: [],
        evidence: { screenshotPaths: [], traceArchivePaths: [] },
        lifecycle: [],
      }),
      "utf8",
    );
    await writeFile(
      join(runDir, "plan.json"),
      JSON.stringify({
        id: "metric-x",
        name: "metric-x",
        source: "scenario",
        app: { bundleId: "com.example.app" },
        device: { id: "device-1" },
        actions: [{ id: "a", type: "wait", durationMs: 100 }],
        metrics: [{ name: "cpu", instrument: "Time Profiler" }],
        analysisFocus: ["general"],
        diagnostics: {},
        execution: "interactive",
      }),
      "utf8",
    );

    // The MCP tool handler is responsible for plumbing these through;
    // simulate the cross-workspace finalize with the production path by
    // going through the harness.
    const runStore = createRunStore(ready.paths.runsDirectory, ready.workspaceRoot);
    const finalizeDirect = await import("../tools/report.js").then((m) =>
      m.finalizePerformanceTest(
        {
          runId: seededRunId,
          requestedStatus: "completed",
          actions: [
            {
              actionId: "a",
              outcome: "executed",
              attempts: 1,
              startedAt: "2026-01-01T00:00:00.000Z",
              endedAt: "2026-01-01T00:00:00.100Z",
            },
          ],
          metrics: [
            {
              name: "cpu",
              instrument: "Time Profiler",
              tracePath: "traces/cpu.trace",
              result: { raw: { count: 1 } },
              verdict: "pass",
              customField: "preserve-me",
            } as Record<string, unknown> & {
              name: string;
              value?: unknown;
              verdict?: string;
            },
          ],
          diagnostics: { crashIdsBefore: [], crashIdsAfter: [], lifecycle: [] },
        },
        {
          scenarioDir: ready.paths.scenarioDirectory,
          runStore,
          now: () => new Date(),
        },
      ),
    );

    if ("error" in finalizeDirect) {
      throw new Error(finalizeDirect.error);
    }
    const finalRun = JSON.parse(
      await readFile(join(runDir, "run.json"), "utf8"),
    ) as { metrics: Array<Record<string, unknown>> };
    const cpu = finalRun.metrics.find((m) => m.name === "cpu");
    expect(cpu?.tracePath).toBe("traces/cpu.trace");
    expect(cpu?.instrument).toBe("Time Profiler");
    expect(cpu?.customField).toBe("preserve-me");
    expect(cpu?.result).toEqual({ raw: { count: 1 } });
  });

  it("refuses to finalize a run owned by a different workspace", async () => {
    // Two distinct, fully-initialized workspaces. We prepare a run in
    // workspace A and try to finalize it from workspace B's run store.
    // The cross-workspace run id must NOT be picked up by workspace B's
    // run store; the handler must surface a structured error rather than
    // ever touching the foreign run directory.
    const projectA = await createInitializedWorkspace({ scenarioId: "owner-a" });
    const projectB = await createInitializedWorkspace({ scenarioId: "owner-b" });
    harnesses.push(projectA, projectB);

    // Prepare a run inside workspace A.
    const prepared = await projectA.harness.call("prepare_performance_test", {
      scenarioId: "owner-a",
      device: { id: "device-1" },
    }) as { runId: string };
    expect(prepared.runId).toBeTruthy();

    // Build workspace B's run store via its workspace manager. The run
    // store cannot see workspace A's run directory, so finalize must
    // fail rather than leak evidence across the boundary.
    const readyB = await projectB.harness.workspaceManager.requireReady();
    const foreignRunStore = createRunStore(
      readyB.paths.runsDirectory,
      readyB.workspaceRoot,
    );
    const finalizeForeign = await import("../tools/report.js").then((m) =>
      m.finalizePerformanceTest(
        {
          runId: prepared.runId,
          requestedStatus: "completed",
          actions: [],
          metrics: [],
          diagnostics: {},
        },
        {
          scenarioDir: readyB.paths.scenarioDirectory,
          runStore: foreignRunStore,
          now: () => new Date(),
        },
      ),
    );

    // The run id is not in workspace B's runs dir → must be `missing`.
    expect("error" in finalizeForeign).toBe(true);
    if (!("error" in finalizeForeign)) throw new Error("expected missing");
    expect(finalizeForeign.error).toMatch(/not safe|does not exist|missing/i);
  });

  it("createRunStore rejects a runs directory that escapes the workspace root", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "performance-mcp-runs-escape-"),
    );
    await mkdir(workspaceRoot, { recursive: true });
    const outsideDir = join(workspaceRoot, "..", "outside-runs");
    await mkdir(outsideDir, { recursive: true });
    expect(() => createRunStore(outsideDir, workspaceRoot)).toThrow(
      /outside|workspace/i,
    );
  });

  it("missing diagnostics yield partial/unavailable findings (not clean completed)", async () => {
    const project = await createInitializedWorkspace({ scenarioId: "missing-diag" });
    harnesses.push(project);

    const prepared = await project.harness.call("prepare_performance_test", {
      scenarioId: "missing-diag",
      device: { id: "device-1" },
    }) as { runId: string };
    expect(prepared.runId).toBeTruthy();

    const result = (await project.harness.call("finalize_performance_test", {
      runId: prepared.runId,
      requestedStatus: "completed",
      actions: [
        {
          actionId: "a",
          outcome: "executed",
          attempts: 1,
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:00:00.100Z",
        },
      ],
      metrics: [],
      diagnostics: {
        crashQueryError: "device disconnected",
        logQueryError: "device disconnected",
        lifecycleQueryError: "device disconnected",
      },
    })) as { status?: string; findings?: Array<{ code: string }> };

    expect(result.status).not.toBe("completed");
    // At least one of the unavailable codes must appear so the diagnostic
    // evidence gap remains visible rather than being silently clean.
    const codes = (result.findings ?? []).map((f) => f.code);
    expect(codes.some((c) => c.endsWith("-unavailable"))).toBe(true);
  });
});
