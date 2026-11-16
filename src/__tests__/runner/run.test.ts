import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeDriver, type FakeDriver } from "../../device/fake.js";
import {
  createFakeRecorder,
  type FakeRecorder,
  type FakeRecorderOptions,
} from "../../recording/fake.js";
import { RecordingError, type TraceRecorder } from "../../recording/types.js";
import { runTake, type RunDependencies } from "../../runner/run.js";
import type { TraceAnalyzer } from "../../runner/execute.js";
import type { TestPlan } from "../../model/test-plan.js";
import {
  callExpectingSuccess,
  createTestToolHarness,
  isToolError,
  type RunPerformanceTestResult,
  type TestToolHarness,
} from "../support/tool-harness.js";

const DEVICE_ID = "00000000-0000000000000000";

interface MetricValues {
  hitches?: number | null;
  blockMs?: number | null;
  launchMs?: number | null;
  memoryMB?: number | null;
}

/**
 * Analyzer stand-in: the real one shells out to xctrace, which cannot run in a
 * unit test. Returning the canonical metric shapes keeps everything downstream
 * (evidence gate, thresholds, report) on the production path.
 */
function createFakeAnalyzer(values: MetricValues): TraceAnalyzer {
  return async ({ template, tracePath }) => {
    const measuredAt = new Date().toISOString();
    const metric = (
      name: string,
      value: number | null | undefined,
      unit: string,
      instrument: string,
    ) => ({
      name,
      ...(value !== null && value !== undefined ? { value } : {}),
      unit,
      instrument,
      tracePath,
      measuredAt,
    });

    if (template === "hitches") {
      return {
        metrics: [
          metric("hitches", values.hitches, "次", "Animation Hitches"),
          metric("blockMs", values.blockMs, "ms", "Animation Hitches"),
        ],
      };
    }
    if (template === "launch") {
      return { metrics: [metric("launchMs", values.launchMs, "ms", "App Launch")] };
    }
    return {
      metrics: [metric("memoryMB", values.memoryMB, "MB", "Activity Monitor")],
    };
  };
}

/**
 * Recorder stand-in wired to the fake device.
 *
 * The hitches pass records with `xctrace --launch`, so xctrace starts the app:
 * the Runner never calls `device.launch` for it. Wiring `onLaunch` to
 * `simulateExternalLaunch` keeps the tests on that real path instead of having
 * the Runner fake a foreground state it did not produce.
 */
function createDeviceRecorder(
  device: FakeDriver,
  options: FakeRecorderOptions = {},
): FakeRecorder {
  return createFakeRecorder({
    ...options,
    onLaunch: () => device.simulateExternalLaunch(),
  });
}

/**
 * Dependencies for a Take that must not spend real time.
 *
 * Actions complete instantly here, so the production minimum window (250 ms)
 * would reject every unit Take. The guard itself has its own test below.
 */
function takeDeps(
  harness: TestToolHarness,
  input: {
    device: FakeDriver;
    recorder: TraceRecorder;
  } & Partial<RunDependencies>,
): RunDependencies {
  return {
    runStore: harness.runStore,
    now: () => new Date(),
    sleep: async () => undefined,
    settleMs: 0,
    launchSettleMs: 0,
    memorySettleMs: 0,
    passCooldownMs: 0,
    healthCheck: false,
    postLaunchSampleMs: 0,
    foregroundProbeTimeoutMs: 20,
    ...input,
    minimumWindowMs: input.minimumWindowMs ?? 0,
  };
}

function adHocPlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    app: { bundleId: "com.example.app" },
    actions: [
      {
        id: "scroll-1",
        type: "swipe",
        direction: "up",
        distance: 600,
        durationMs: 300,
        waitAfterMs: 0,
      },
    ],
    metrics: [
      { name: "hitches", threshold: { warn: 50, fail: 100 } },
      { name: "blockMs", threshold: { warn: 100, fail: 250 } },
      { name: "launchMs", threshold: { warn: 800, fail: 1500 } },
      { name: "memoryMB", threshold: { warn: 300, fail: 500 } },
    ],
    ...overrides,
  };
}

async function prepare(
  harness: TestToolHarness,
  plan: Record<string, unknown>,
): Promise<{ runId: string; plan: TestPlan }> {
  return callExpectingSuccess<{ runId: string; plan: TestPlan }>(
    harness,
    "prepare_performance_test",
    { adHocPlan: plan, device: { id: DEVICE_ID } },
  );
}

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

describe("runTake", () => {
  it("records all three passes and finalizes a passing Take", async () => {
    if (!harness) throw new Error("harness not initialized");
    const device = createFakeDriver({
      elements: [{ rect: { x: 0, y: 0, width: 393, height: 852 } }],
    });
    const recorder = createDeviceRecorder(device);
    const prepared = await prepare(harness, adHocPlan());

    const outcome = await runTake(
      { runId: prepared.runId, plan: prepared.plan, deviceId: DEVICE_ID },
      takeDeps(harness, {
        device,
        recorder,
        analyze: createFakeAnalyzer({
          hitches: 10,
          blockMs: 40,
          launchMs: 300,
          memoryMB: 100,
        }),
      }),
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;

    expect(outcome.summary.status).toBe("completed");
    expect(outcome.summary.gate).toBe("pass");
    expect(outcome.summary.passes.map((pass) => pass.template)).toEqual([
      "hitches",
      "launch",
      "memory",
    ]);
    expect(outcome.summary.metrics.map((metric) => metric.name)).toEqual([
      "hitches",
      "blockMs",
      "launchMs",
      "memoryMB",
    ]);
    // One action, executed inside the hitches recording window.
    expect(outcome.summary.actions).toEqual([
      expect.objectContaining({ actionId: "scroll-1", outcome: "executed" }),
    ]);
    expect(device.calls).toContain("swipe");

    const report = JSON.parse(
      await readFile(join(harness.root, "runs", prepared.runId, "report.json"), "utf8"),
    );
    expect(report.status).toBe("completed");
    expect(report.gate).toBe("pass");
    const hitches = report.run.metrics.find(
      (metric: { name: string }) => metric.name === "hitches",
    );
    expect(hitches.verdict).toBe("pass");
    // Trace paths are run-relative so the report stays portable.
    expect(hitches.tracePath).toBe("traces/hitches.trace");

    // Pass facts are persisted, not just returned in-memory.
    const stored = JSON.parse(
      await readFile(join(harness.root, "runs", prepared.runId, "run.json"), "utf8"),
    );
    expect(stored.passes).toHaveLength(3);
    expect(stored.passes[0]).toMatchObject({
      template: "hitches",
      tracePath: "traces/hitches.trace",
      attempts: 1,
    });
    expect(stored.passes[0]).not.toHaveProperty("absoluteTracePath");
    expect(stored.passes.map((pass: { durationMs: number }) => pass.durationMs)).toEqual(
      outcome.summary.passes.map((pass) => pass.durationMs),
    );

    // Device facts from preflight are persisted for baseline grouping.
    expect(stored.device).toEqual({
      id: DEVICE_ID,
      name: "Fake iPhone",
      osVersion: "27.0",
      modelIdentifier: "iPhone18,3",
    });

    // Every finalized Take leaves exactly one append-only index row.
    const rows = (
      await readFile(join(harness.root, "runs", "index.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId: prepared.runId,
      status: "completed",
      gate: "pass",
      passCount: 3,
      scenarioId: null,
      deviceId: DEVICE_ID,
    });
  });

  it("keeps a Take finalizable when a pass trace lands outside the run directory", async () => {
    if (!harness) throw new Error("harness not initialized");
    const device = createFakeDriver({
      elements: [{ rect: { x: 0, y: 0, width: 393, height: 852 } }],
    });
    const recorder = createDeviceRecorder(device);
    const root = harness.root;
    // `toRunRelative` deliberately returns the absolute path when the recorder
    // wrote outside the run directory. That must not turn a successful Take
    // into an unfinalizable one.
    const escapingRecorder: TraceRecorder = {
      async record(request) {
        const trace = await recorder.record(request);
        return {
          ...trace,
          tracePath: join(root, "outside", `${request.template}.trace`),
        };
      },
    };
    const prepared = await prepare(harness, adHocPlan());

    const outcome = await runTake(
      { runId: prepared.runId, plan: prepared.plan, deviceId: DEVICE_ID },
      takeDeps(harness, {
        device,
        recorder: escapingRecorder,
        analyze: createFakeAnalyzer({
          hitches: 10,
          blockMs: 40,
          launchMs: 300,
          memoryMB: 100,
        }),
      }),
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.summary.status).toBe("completed");
    const stored = JSON.parse(
      await readFile(join(harness.root, "runs", prepared.runId, "run.json"), "utf8"),
    );
    expect(stored.passes).toHaveLength(3);
    // The count and duration survive; only the unusable path is dropped.
    expect(
      stored.passes.every(
        (pass: { tracePath?: string }) => pass.tracePath === undefined,
      ),
    ).toBe(true);
  });

  it("keeps the Take valid when the index append fails", async () => {
    if (!harness) throw new Error("harness not initialized");
    const device = createFakeDriver({
      elements: [{ rect: { x: 0, y: 0, width: 393, height: 852 } }],
    });
    const prepared = await prepare(harness, adHocPlan());
    const failingStore = {
      ...harness.runStore,
      appendIndex: async (): Promise<void> => {
        throw new Error("disk full");
      },
    };

    const outcome = await runTake(
      { runId: prepared.runId, plan: prepared.plan, deviceId: DEVICE_ID },
      takeDeps(harness, {
        device,
        recorder: createDeviceRecorder(device),
        analyze: createFakeAnalyzer({
          hitches: 10,
          blockMs: 40,
          launchMs: 300,
          memoryMB: 100,
        }),
        runStore: failingStore,
      }),
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.summary.status).toBe("completed");
    expect(outcome.summary.notes.join(" ")).toContain("运行索引未记录");
    // The report is still authoritative and complete.
    const stored = JSON.parse(
      await readFile(join(harness.root, "runs", prepared.runId, "run.json"), "utf8"),
    );
    expect(stored.status).toBe("completed");
    await expect(
      readFile(join(harness.root, "runs", "index.jsonl"), "utf8"),
    ).rejects.toThrow();
  });

  it("records the hitches pass with --launch and scores only the action window", async () => {
    if (!harness) throw new Error("harness not initialized");
    const device = createFakeDriver({
      elements: [
        { label: "社区", rect: { x: 300, y: 80, width: 40, height: 20 } },
        { rect: { x: 0, y: 0, width: 393, height: 852 } },
      ],
    });
    const recorder = createDeviceRecorder(device);
    const windows: Array<{ fromMs: number; toMs: number } | undefined> = [];
    const analyzer: TraceAnalyzer = async (input) => {
      const result = await createFakeAnalyzer({
        hitches: 10,
        blockMs: 40,
        launchMs: 300,
        memoryMB: 100,
      })(input);
      if (input.template !== "hitches" || "error" in result) {
        return result;
      }
      windows.push(input.window);
      return { ...result, warnings: ["synthetic frame warning"] };
    };
    const prepared = await prepare(
      harness,
      adHocPlan({
        warmup: [
          { id: "open-community", type: "tap", target: "社区", waitAfterMs: 0 },
        ],
      }),
    );

    const outcome = await runTake(
      { runId: prepared.runId, plan: prepared.plan, deviceId: DEVICE_ID },
      takeDeps(harness, { device, recorder, analyze: analyzer }),
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.summary.status).toBe("completed");

    // `--attach <pid>` read the pid from the device's process table, which is
    // what failed on a real device (stale table, duplicate executables). The
    // hitches pass must let xctrace own the launch instead.
    expect(
      recorder.requests.some((request) => request.target.kind === "attach"),
    ).toBe(false);
    const hitchesRequests = recorder.requests.filter(
      (request) => request.template === "hitches",
    );
    expect(hitchesRequests).toHaveLength(1);
    expect(hitchesRequests[0]?.target).toEqual({
      kind: "launch",
      bundleId: "com.example.app",
    });
    // The Runner never launches the app itself for the hitches pass; only
    // xctrace does (modelled by the fake recorder's `onLaunch`).
    expect(device.calls).not.toContain("launch");

    // `--launch` recordings also contain the cold-start frames, so the metric
    // must be restricted to the part that holds the scene actions.
    expect(windows).toHaveLength(1);
    const window = windows[0];
    expect(window).toBeDefined();
    expect(window?.fromMs).toBeGreaterThanOrEqual(0);
    expect(window?.toMs).toBeGreaterThanOrEqual(window?.fromMs ?? 0);

    // The scored part of the trace and the analyzer's warnings are part of the
    // evidence: a reader must be able to tell a healthy scene from a window
    // that missed it.
    const notes = outcome.summary.notes.join(" ");
    expect(notes).toContain("hitches window");
    expect(notes).toContain("synthetic frame warning");
  });

  it("runs warmup before the recorded actions so the screen under test is reached", async () => {
    if (!harness) throw new Error("harness not initialized");
    const device = createFakeDriver({
      elements: [
        { label: "社区", rect: { x: 300, y: 80, width: 40, height: 20 } },
        { rect: { x: 0, y: 0, width: 393, height: 852 } },
      ],
    });
    const recorder = createDeviceRecorder(device);
    const prepared = await prepare(
      harness,
      adHocPlan({
        warmup: [{ id: "open-community", type: "tap", target: "社区", waitAfterMs: 0 }],
      }),
    );

    const outcome = await runTake(
      { runId: prepared.runId, plan: prepared.plan, deviceId: DEVICE_ID },
      takeDeps(harness, {
        device,
        recorder,
        analyze: createFakeAnalyzer({
          hitches: 10,
          blockMs: 40,
          launchMs: 300,
          memoryMB: 100,
        }),
      }),
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    const warmup = outcome.summary.actions.find((action) =>
      action.actionId === "open-community",
    );
    expect(warmup?.outcome).toBe("executed");
    // The tap must happen before the recorded swipe, otherwise the Take
    // measures whatever screen the app happened to be on.
    expect(device.calls.indexOf("tap")).toBeLessThan(device.calls.indexOf("swipe"));
  });

  it("fails the hitches pass when a gesture leaves the app", async () => {
    if (!harness) throw new Error("harness not initialized");
    // Real-device case: a swipe started below the home indicator, iOS sent the
    // app to the background, and the trace then contained SpringBoard frames.
    // The Take must fail, not score the system UI as scenario hitches.
    const device = createFakeDriver({ backgroundOnSwipe: true });
    const prepared = await prepare(harness, adHocPlan());

    const outcome = await runTake(
      { runId: prepared.runId, plan: prepared.plan, deviceId: DEVICE_ID },
      takeDeps(harness, {
        device,
        recorder: createDeviceRecorder(device),
        analyze: createFakeAnalyzer({
          hitches: 0,
          blockMs: 0,
          launchMs: 300,
          memoryMB: 100,
        }),
      }),
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.summary.status).toBe("failed");
    const notes = outcome.summary.notes.join(" ");
    expect(notes).toContain("left com.example.app");
    expect(notes).toContain("refusing to score system UI");
    // No hitches value may be attributed to a window that held system UI.
    expect(outcome.summary.metrics.map((metric) => metric.name)).not.toContain(
      "hitches",
    );
  });

  it("fails the Take when the action window is too short to measure", async () => {
    if (!harness) throw new Error("harness not initialized");
    const device = createFakeDriver();
    const recorder = createDeviceRecorder(device);
    const prepared = await prepare(harness, adHocPlan());

    const outcome = await runTake(
      { runId: prepared.runId, plan: prepared.plan, deviceId: DEVICE_ID },
      takeDeps(harness, {
        device,
        recorder,
        analyze: createFakeAnalyzer({ hitches: 0, blockMs: 0 }),
        // Production default: an empty window must not become "0 hitches".
        minimumWindowMs: 250,
      }),
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.summary.status).toBe("failed");
    expect(outcome.summary.notes.join(" ")).toContain("measurement window");
    // The trace itself was recorded; only the measurement refusal failed the
    // Take, so the operator can see the evidence rather than a generic error.
    expect(
      recorder.requests.some((request) => request.template === "hitches"),
    ).toBe(true);
  });

  it("keeps status completed and gate fail when a threshold is missed", async () => {
    if (!harness) throw new Error("harness not initialized");
    const prepared = await prepare(harness, adHocPlan());
    const device = createFakeDriver();

    const outcome = await runTake(
      { runId: prepared.runId, plan: prepared.plan, deviceId: DEVICE_ID },
      takeDeps(harness, {
        device,
        recorder: createDeviceRecorder(device),
        analyze: createFakeAnalyzer({
          hitches: 5_000,
          blockMs: 40,
          launchMs: 300,
          memoryMB: 100,
        }),
      }),
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.summary.status).toBe("completed");
    expect(outcome.summary.gate).toBe("fail");
    expect(
      outcome.summary.metrics.find((metric) => metric.name === "hitches")?.verdict,
    ).toBe("fail");
    expect(
      outcome.summary.findings.some((finding) => finding.code === "metric:hitches"),
    ).toBe(true);
  });

  it("marks the Take partial when a requested metric produced no value", async () => {
    if (!harness) throw new Error("harness not initialized");
    const prepared = await prepare(harness, adHocPlan());
    const device = createFakeDriver();

    const outcome = await runTake(
      { runId: prepared.runId, plan: prepared.plan, deviceId: DEVICE_ID },
      takeDeps(harness, {
        device,
        recorder: createDeviceRecorder(device),
        analyze: createFakeAnalyzer({
          hitches: 10,
          blockMs: 40,
          launchMs: null,
          memoryMB: 100,
        }),
      }),
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.summary.status).toBe("partial");
    expect(outcome.summary.gate).toBe("unknown");
  });

  it("omits device facts when preflight fails before the device is reached", async () => {
    if (!harness) throw new Error("harness not initialized");
    const device = createFakeDriver();
    const prepared = await prepare(harness, adHocPlan());

    const outcome = await runTake(
      { runId: prepared.runId, plan: prepared.plan, deviceId: "not-this-device" },
      takeDeps(harness, {
        device,
        recorder: createDeviceRecorder(device),
        analyze: createFakeAnalyzer({ hitches: 1 }),
      }),
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.summary.status).toBe("failed");
    const stored = JSON.parse(
      await readFile(join(harness.root, "runs", prepared.runId, "run.json"), "utf8"),
    );
    // No device was reached: never fabricate a version.
    expect(stored).not.toHaveProperty("device");
  });

  it("still writes a failed report when the device disappears", async () => {
    if (!harness) throw new Error("harness not initialized");
    const device = createFakeDriver({
      // Both the install lookup and the post-Take crash query fail: this is
      // what an unplugged device looks like mid-Take.
      failOn: { resolveInstallation: 1, crashIds: 1 },
    });
    const prepared = await prepare(harness, adHocPlan());

    const outcome = await runTake(
      { runId: prepared.runId, plan: prepared.plan, deviceId: DEVICE_ID },
      takeDeps(harness, {
        device,
        recorder: createDeviceRecorder(device),
        analyze: createFakeAnalyzer({ hitches: 1 }),
      }),
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.summary.status).toBe("failed");
    expect(outcome.summary.gate).toBe("unknown");
    expect(outcome.summary.notes.join(" ")).toContain("resolveInstallation");

    const stored = JSON.parse(
      await readFile(join(harness.root, "runs", prepared.runId, "run.json"), "utf8"),
    );
    // Preflight succeeded, so the device facts must still be recorded even
    // though the Take failed later.
    expect(stored.device).toMatchObject({
      id: DEVICE_ID,
      osVersion: "27.0",
    });

    const report = JSON.parse(
      await readFile(join(harness.root, "runs", prepared.runId, "report.json"), "utf8"),
    );
    expect(report.status).toBe("failed");
    // A Take that dies early must still leave a diagnosable record.
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.diagnostics.crashes.status).toBe("unavailable");
  });

  it("keeps the metrics measured before a late pass fails", async () => {
    if (!harness) throw new Error("harness not initialized");
    // Real-device case: the cable is pulled during the memory pass, after the
    // hitches and launch traces were already recorded and analyzed.
    const device = createFakeDriver({ failOn: { resolvePid: 1 } });
    const prepared = await prepare(harness, adHocPlan());

    const outcome = await runTake(
      { runId: prepared.runId, plan: prepared.plan, deviceId: DEVICE_ID },
      takeDeps(harness, {
        device,
        recorder: createDeviceRecorder(device),
        analyze: createFakeAnalyzer({
          hitches: 42,
          blockMs: 55,
          launchMs: 300,
          memoryMB: 100,
        }),
      }),
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    // The Take is not valid (no memory metric, no crash diff)...
    expect(outcome.summary.status).toBe("failed");
    expect(outcome.summary.gate).toBe("unknown");
    expect(outcome.summary.notes.join(" ")).toContain("resolvePid");
    // ...but the measurements that did happen are evidence, not noise.
    expect(outcome.summary.metrics.map((metric) => metric.name)).toEqual([
      "hitches",
      "blockMs",
      "launchMs",
    ]);
    expect(
      outcome.summary.metrics.every((metric) => metric.tracePath !== undefined),
    ).toBe(true);
    expect(outcome.summary.passes.map((pass) => pass.template)).toEqual([
      "hitches",
      "launch",
    ]);

    // The requirement is about the artifact, not only the in-memory summary:
    // completed passes must survive in run.json when a later pass dies.
    const stored = JSON.parse(
      await readFile(join(harness.root, "runs", prepared.runId, "run.json"), "utf8"),
    );
    expect(stored.status).toBe("failed");
    expect(stored.passes.map((pass: { template: string }) => pass.template)).toEqual([
      "hitches",
      "launch",
    ]);
    expect(
      stored.passes.every(
        (pass: { tracePath?: string }) =>
          pass.tracePath !== undefined && pass.tracePath.startsWith("traces/"),
      ),
    ).toBe(true);

    const report = JSON.parse(
      await readFile(join(harness.root, "runs", prepared.runId, "report.json"), "utf8"),
    );
    const hitches = report.run.metrics.find(
      (metric: { name: string }) => metric.name === "hitches",
    );
    expect(hitches?.value).toBe(42);
    expect(hitches?.tracePath).toBe("traces/hitches.trace");
  });

  it("names what is actually in front when the app never comes up", async () => {
    if (!harness) throw new Error("harness not initialized");
    // Real-device case: another app's local-network alert sits on top, so the
    // app is running but SpringBoard keeps the foreground.
    const device = createFakeDriver({ blockForeground: true });
    const prepared = await prepare(harness, adHocPlan());

    const outcome = await runTake(
      { runId: prepared.runId, plan: prepared.plan, deviceId: DEVICE_ID },
      takeDeps(harness, {
        device,
        recorder: createDeviceRecorder(device),
        analyze: createFakeAnalyzer({ hitches: 1 }),
        foregroundTimeoutMs: 30,
      }),
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.summary.status).toBe("failed");
    const notes = outcome.summary.notes.join(" ");
    expect(notes).toContain("did not reach the foreground");
    // The blocker must be named, otherwise the operator has to guess.
    expect(notes).toContain("com.apple.springboard");
    expect(notes).toContain("UIEditingOverlayViewController");
  });

  it("aggregates repetitions with the median and keeps every sample", async () => {
    if (!harness) throw new Error("harness not initialized");
    let call = 0;
    const analyzer: TraceAnalyzer = async (input) => {
      if (input.template !== "hitches") {
        return createFakeAnalyzer({
          launchMs: 300,
          memoryMB: 100,
        })(input);
      }
      call += 1;
      const hitches = call <= 2 ? 100 : 400;
      return createFakeAnalyzer({ hitches, blockMs: 40 })(input);
    };

    const prepared = await prepare(
      harness,
      adHocPlan({ repetitions: 3 }),
    );
    const device = createFakeDriver();

    const outcome = await runTake(
      { runId: prepared.runId, plan: prepared.plan, deviceId: DEVICE_ID },
      takeDeps(harness, {
        device,
        recorder: createDeviceRecorder(device),
        analyze: analyzer,
      }),
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    const hitches = outcome.summary.metrics.find(
      (metric) => metric.name === "hitches",
    );
    expect(hitches?.value).toBe(100);
    expect(hitches?.samples).toEqual([100, 100, 400]);
  });

  it("retries a retryable recording failure and records the attempt count", async () => {
    if (!harness) throw new Error("harness not initialized");
    const device = createFakeDriver();
    // Retries live inside the xctrace recorder, so the fake reports the attempt
    // count the real one would have returned.
    const recorder = createDeviceRecorder(device, {
      reportedAttempts: { hitches: 2 },
    });
    const prepared = await prepare(harness, adHocPlan());

    const outcome = await runTake(
      { runId: prepared.runId, plan: prepared.plan, deviceId: DEVICE_ID },
      takeDeps(harness, {
        device,
        recorder,
        analyze: createFakeAnalyzer({
          hitches: 10,
          blockMs: 40,
          launchMs: 300,
          memoryMB: 100,
        }),
      }),
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    const hitches = outcome.summary.passes.find(
      (pass) => pass.template === "hitches",
    );
    expect(hitches?.attempts).toBe(2);
    expect(outcome.summary.notes.join(" ")).toContain("2 attempts");

    // The retry count is persisted per pass; other passes keep attempts=1.
    const stored = JSON.parse(
      await readFile(join(harness.root, "runs", prepared.runId, "run.json"), "utf8"),
    );
    const persistedHitches = stored.passes.find(
      (pass: { template: string }) => pass.template === "hitches",
    );
    expect(persistedHitches?.attempts).toBe(2);
    expect(
      stored.passes
        .filter((pass: { template: string }) => pass.template !== "hitches")
        .every((pass: { attempts: number }) => pass.attempts === 1),
    ).toBe(true);
  });

  it("refuses to re-run a Take that already finished", async () => {
    if (!harness) throw new Error("harness not initialized");
    const prepared = await prepare(harness, adHocPlan());
    const device = createFakeDriver();
    const deps = takeDeps(harness, {
      device,
      recorder: createDeviceRecorder(device),
      analyze: createFakeAnalyzer({ hitches: 1, blockMs: 1, launchMs: 1, memoryMB: 1 }),
    });

    const first = await runTake(
      { runId: prepared.runId, plan: prepared.plan, deviceId: DEVICE_ID },
      deps,
    );
    expect(first.kind).toBe("ok");

    const second = await runTake(
      { runId: prepared.runId, plan: prepared.plan, deviceId: DEVICE_ID },
      deps,
    );
    expect(second.kind).toBe("terminal");
  });

  it("fails honestly when the plan requests no collectable metric", async () => {
    if (!harness) throw new Error("harness not initialized");
    const prepared = await prepare(
      harness,
      adHocPlan({ metrics: [{ name: "cpu" }] }),
    );
    const device = createFakeDriver();

    const outcome = await runTake(
      { runId: prepared.runId, plan: prepared.plan, deviceId: DEVICE_ID },
      takeDeps(harness, {
        device,
        recorder: createDeviceRecorder(device),
        analyze: createFakeAnalyzer({}),
      }),
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.summary.status).toBe("failed");
    expect(outcome.summary.notes.join(" ")).toContain("cpu");
  });
});

describe("run_performance_test tool", () => {
  it("runs a plan end to end and returns a compact summary", async () => {
    if (harness) {
      await harness.cleanup();
    }
    const device = createFakeDriver({
      elements: [{ rect: { x: 0, y: 0, width: 393, height: 852 } }],
    });
    harness = await createTestToolHarness(undefined, {
      device: device as FakeDriver,
      recorder: createDeviceRecorder(device) as FakeRecorder,
      analyze: createFakeAnalyzer({
        hitches: 12,
        blockMs: 45,
        launchMs: 320,
        memoryMB: 110,
      }),
      sleep: async () => undefined,
    });

    const result = await harness.call<RunPerformanceTestResult | { error: string }>(
      "run_performance_test",
      {
        adHocPlan: adHocPlan({
          actions: [
            { id: "scroll-up", type: "swipe", direction: "up", distance: 600, durationMs: 300, waitAfterMs: 0 },
            { id: "scroll-down", type: "swipe", direction: "down", distance: 600, durationMs: 300, waitAfterMs: 0 },
          ],
        }),
        device: { id: DEVICE_ID },
      },
    );

    expect(isToolError(result)).toBe(false);
    if (isToolError(result)) return;
    expect(result.status).toBe("completed");
    expect(["pass", "warn", "fail", "unknown"]).toContain(result.gate);
    expect(result.reportPath).toContain(result.runId);
    expect(result.metrics).toHaveLength(4);
    expect(result.actions).toHaveLength(2);
  });

  it("rejects a payload with both a scenario and an ad-hoc plan", async () => {
    if (!harness) throw new Error("harness not initialized");
    const result = await harness.call("run_performance_test", {
      scenarioId: "community-home-scroll",
      adHocPlan: adHocPlan(),
      device: { id: DEVICE_ID },
    });
    expect(isToolError(result)).toBe(true);
  });
});

/**
 * Guards added after the M3 device incident: repeated recording sessions plus
 * hard kills left the on-device Instruments service unusable, and a Take that
 * should have failed in five seconds instead spent 82 seconds producing three
 * broken traces (docs/m3-validation.md §4.9).
 */
describe("device-health guards", () => {
  it("refuses to record when the app cannot stay alive", async () => {
    if (!harness) throw new Error("harness not initialized");
    const device = createFakeDriver({ exitOnLaunch: true });
    const recorder = createDeviceRecorder(device);
    const prepared = await prepare(harness, adHocPlan());

    const outcome = await runTake(
      { runId: prepared.runId, plan: prepared.plan, deviceId: DEVICE_ID },
      takeDeps(harness, {
        device,
        recorder,
        healthCheck: true,
        healthCheckSettleMs: 0,
      }),
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.summary.status).toBe("failed");
    expect(outcome.summary.notes.join(" ")).toContain(
      "did not stay running",
    );
    // No recording session was opened: that is the point of the probe.
    expect(recorder.requests).toHaveLength(0);
  });

  it("refuses to record when a crash report appears during the probe", async () => {
    if (!harness) throw new Error("harness not initialized");
    const device = createFakeDriver({ crashOnLaunch: true });
    const recorder = createDeviceRecorder(device);
    const prepared = await prepare(harness, adHocPlan());

    const outcome = await runTake(
      { runId: prepared.runId, plan: prepared.plan, deviceId: DEVICE_ID },
      takeDeps(harness, {
        device,
        recorder,
        healthCheck: true,
        healthCheckSettleMs: 0,
      }),
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.summary.status).toBe("failed");
    expect(outcome.summary.notes.join(" ")).toContain("crashed during the health check");
    expect(recorder.requests).toHaveLength(0);
  });

  it("stops after the first unusable recording instead of recording again", async () => {
    if (!harness) throw new Error("harness not initialized");
    const device = createFakeDriver();
    const recorder = createDeviceRecorder(device, {
      failOn: { hitches: 1 },
      failureKind: "malformed-trace",
    });
    const prepared = await prepare(harness, adHocPlan());

    const outcome = await runTake(
      { runId: prepared.runId, plan: prepared.plan, deviceId: DEVICE_ID },
      takeDeps(harness, { device, recorder }),
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.summary.status).toBe("failed");
    // One attempt, one pass: no launch/memory recording on a device that
    // already failed to hand back a readable trace.
    expect(recorder.requests.map((request) => request.template)).toEqual([
      "hitches",
    ]);
    expect(outcome.summary.notes.join(" ")).toContain("malformed-trace");
  });

  it("quotes the device-side cause in the failure notes", async () => {
    if (!harness) throw new Error("harness not initialized");
    const device = createFakeDriver();
    device.pushLogLines([
      '{"process":"NNIM","message":"NNIM/DBBootstrap.swift:20: Fatal error: Database bootstrap failed: SQLite error 10: disk I/O error"}',
    ]);
    const recorder = createDeviceRecorder(device, {
      failOn: { hitches: 1 },
      failureKind: "instruments-wedged",
    });
    const prepared = await prepare(harness, adHocPlan());

    const outcome = await runTake(
      { runId: prepared.runId, plan: prepared.plan, deviceId: DEVICE_ID },
      takeDeps(harness, { device, recorder }),
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    const notes = outcome.summary.notes.join(" ");
    expect(notes).toContain("device log: app fatal error");
    expect(notes).toContain("Database bootstrap failed");
  });
});

/**
 * The recording window must stay closed even when a device call hangs.
 *
 * On 2026-11-13 an `apps foreground` query issued after the last action never
 * returned. `during` kept the session open, xctrace recorded to its 60s cap,
 * and an 8s action window produced a 4.7GB trace (docs/m3-validation.md §4.10).
 */
describe("recording-window guards", () => {
  it("stops the Take when the foreground probe never answers", async () => {
    if (!harness) throw new Error("harness not initialized");
    const device = createFakeDriver({ hangForegroundAfterSwipe: true });
    const recorder = createDeviceRecorder(device);
    const prepared = await prepare(harness, adHocPlan());

    const outcome = await runTake(
      { runId: prepared.runId, plan: prepared.plan, deviceId: DEVICE_ID },
      takeDeps(harness, { device, recorder, foregroundProbeTimeoutMs: 20 }),
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.summary.status).toBe("failed");
    expect(outcome.summary.notes.join(" ")).toContain("could not verify");
    // One pass only: the launch and memory sessions must not start on an
    // unverified recording.
    expect(recorder.requests.map((request) => request.template)).toEqual([
      "hitches",
    ]);
  });
});

/**
 * The plan input contract: fields that claim to change the run must change it.
 *
 * `launchArguments` / `environmentVariables` / `launchUrl` used to be accepted
 * by the schema and merged into `plan.json` while nothing read them; that made
 * `plan.json` look authoritative about a configuration the device never saw.
 */
describe("plan input contract", () => {
  it("forwards launch arguments and environment to every launch-based pass", async () => {
    if (!harness) throw new Error("harness not initialized");
    const device = createFakeDriver({
      elements: [{ rect: { x: 0, y: 0, width: 393, height: 852 } }],
    });
    const recorder = createDeviceRecorder(device);
    const prepared = await prepare(
      harness,
      adHocPlan({
        app: {
          bundleId: "com.example.app",
          launchArguments: ["-UITestMode", "1"],
          environmentVariables: { LOG_LEVEL: "debug" },
        },
      }),
    );

    const outcome = await runTake(
      { runId: prepared.runId, plan: prepared.plan, deviceId: DEVICE_ID },
      takeDeps(harness, {
        device,
        recorder,
        analyze: createFakeAnalyzer({
          hitches: 1,
          blockMs: 10,
          launchMs: 300,
          memoryMB: 100,
        }),
      }),
    );

    expect(outcome.kind).toBe("ok");
    const launchRequests = recorder.requests.filter(
      (request) => request.target.kind === "launch",
    );
    expect(launchRequests.map((request) => request.template)).toEqual([
      "hitches",
      "launch",
    ]);
    for (const request of launchRequests) {
      expect(request.launch?.arguments).toEqual(["-UITestMode", "1"]);
      expect(request.launch?.environment).toEqual({ LOG_LEVEL: "debug" });
    }
  });

  it("opens the deep link before the first scored action", async () => {
    if (!harness) throw new Error("harness not initialized");
    const url = "example://community";
    const device = createFakeDriver({
      elements: [{ rect: { x: 0, y: 0, width: 393, height: 852 } }],
    });
    const recorder = createDeviceRecorder(device);
    const prepared = await prepare(
      harness,
      adHocPlan({ app: { bundleId: "com.example.app", launchUrl: url } }),
    );

    const outcome = await runTake(
      { runId: prepared.runId, plan: prepared.plan, deviceId: DEVICE_ID },
      takeDeps(harness, {
        device,
        recorder,
        analyze: createFakeAnalyzer({
          hitches: 1,
          blockMs: 10,
          launchMs: 300,
          memoryMB: 100,
        }),
      }),
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(device.openedUrls.length).toBeGreaterThan(0);
    expect(device.openedUrls.every((opened) => opened === url)).toBe(true);
    // Navigation belongs before the hitches window, not inside it.
    const openIndex = device.calls.indexOf("openUrl");
    const swipeIndex = device.calls.indexOf("swipe");
    expect(openIndex).toBeGreaterThan(-1);
    expect(openIndex).toBeLessThan(swipeIndex);
    // The launch trace must stay a pure cold start.
    expect(outcome.summary.notes.join(" ")).toContain(
      "does not apply launchUrl",
    );
  });

  it("fails the Take when a precondition does not hold", async () => {
    if (!harness) throw new Error("harness not initialized");
    const device = createFakeDriver({
      elements: [{ label: "消息", rect: { x: 0, y: 0, width: 393, height: 852 } }],
    });
    const recorder = createDeviceRecorder(device);
    const prepared = await prepare(
      harness,
      adHocPlan({
        preconditions: [
          { description: "社区页已打开", accessibilityText: "社区" },
        ],
      }),
    );

    const outcome = await runTake(
      { runId: prepared.runId, plan: prepared.plan, deviceId: DEVICE_ID },
      takeDeps(harness, {
        device,
        recorder,
        analyze: createFakeAnalyzer({
          hitches: 1,
          blockMs: 10,
          launchMs: 300,
          memoryMB: 100,
        }),
      }),
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    // A mis-declared starting state is `invalid`, not `failed`: the device
    // did what it was told, the scenario asserted something untrue.
    expect(outcome.summary.status).toBe("invalid");
    expect(outcome.summary.gate).toBe("unknown");
    const notes = outcome.summary.notes.join(" ");
    expect(notes).toContain("precondition failed");
    expect(notes).toContain("社区页已打开");
  });

  it("records verified preconditions when they hold", async () => {
    if (!harness) throw new Error("harness not initialized");
    const device = createFakeDriver({
      elements: [{ label: "社区", rect: { x: 0, y: 0, width: 393, height: 852 } }],
    });
    const recorder = createDeviceRecorder(device);
    const prepared = await prepare(
      harness,
      adHocPlan({
        preconditions: [
          { description: "社区页已打开", accessibilityText: "社区" },
        ],
      }),
    );

    const outcome = await runTake(
      { runId: prepared.runId, plan: prepared.plan, deviceId: DEVICE_ID },
      takeDeps(harness, {
        device,
        recorder,
        analyze: createFakeAnalyzer({
          hitches: 1,
          blockMs: 10,
          launchMs: 300,
          memoryMB: 100,
        }),
      }),
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.summary.status).toBe("completed");
    expect(outcome.summary.notes.join(" ")).toContain("preconditions verified");
  });
});

/**
 * Precondition failures must stay distinguishable after the recording layer
 * wraps them: the default plan always runs the checks inside the hitches
 * session, so this is the common path, not an edge case.
 */
describe("precondition failure classification", () => {
  it("keeps the invalid status when the recorder wraps the failure", async () => {
    if (!harness) throw new Error("harness not initialized");
    const device = createFakeDriver({
      elements: [{ label: "消息", rect: { x: 0, y: 0, width: 393, height: 852 } }],
    });
    const recorder = createDeviceRecorder(device);
    // Mirrors `createXctraceRecorder`: any non-recording error comes back as a
    // RecordingError whose cause is the original one.
    const wrappingRecorder: TraceRecorder = {
      record: async (request) => {
        try {
          return await recorder.record(request);
        } catch (error) {
          throw new RecordingError(
            error instanceof Error ? error.message : String(error),
            "aborted",
            false,
            undefined,
            { cause: error },
          );
        }
      },
    };
    const prepared = await prepare(
      harness,
      adHocPlan({
        preconditions: [
          { description: "社区页已打开", accessibilityText: "社区" },
        ],
      }),
    );

    const outcome = await runTake(
      { runId: prepared.runId, plan: prepared.plan, deviceId: DEVICE_ID },
      {
        ...takeDeps(harness, { device, recorder }),
        recorder: wrappingRecorder,
      },
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.summary.status).toBe("invalid");
    expect(outcome.summary.gate).toBe("unknown");
    expect(outcome.summary.notes.join(" ")).toContain("precondition failed");
  });

  it("rejects preconditions on a plan with no window to verify them", async () => {
    if (!harness) throw new Error("harness not initialized");
    const device = createFakeDriver({
      elements: [{ label: "社区", rect: { x: 0, y: 0, width: 393, height: 852 } }],
    });
    const recorder = createDeviceRecorder(device);
    const prepared = await prepare(
      harness,
      adHocPlan({
        // App Launch only: the scenario window is skipped, and without a
        // memory pass nothing would ever evaluate the preconditions.
        metrics: [{ name: "launchMs", threshold: { warn: 800, fail: 1500 } }],
        preconditions: [
          { description: "社区页已打开", accessibilityText: "社区" },
        ],
      }),
    );

    const outcome = await runTake(
      { runId: prepared.runId, plan: prepared.plan, deviceId: DEVICE_ID },
      takeDeps(harness, {
        device,
        recorder,
        analyze: createFakeAnalyzer({ launchMs: 300 }),
      }),
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.summary.status).toBe("invalid");
    expect(outcome.summary.gate).toBe("unknown");
    expect(outcome.summary.notes.join(" ")).toContain(
      "no scenario window to verify",
    );
  });
});

describe("launchUrl application", () => {
  it("opens the deep link once per app start, not once per pass", async () => {
    if (!harness) throw new Error("harness not initialized");
    const url = "example://community";
    const device = createFakeDriver({
      elements: [{ rect: { x: 0, y: 0, width: 393, height: 852 } }],
    });
    const recorder = createDeviceRecorder(device);
    const prepared = await prepare(
      harness,
      adHocPlan({
        // No launch pass: the memory pass follows the hitches pass in the same
        // app process, so it must not navigate back to the entry screen.
        app: { bundleId: "com.example.app", launchUrl: url },
        metrics: [
          { name: "hitches", threshold: { warn: 50, fail: 100 } },
          { name: "blockMs", threshold: { warn: 100, fail: 250 } },
          { name: "memoryMB", threshold: { warn: 300, fail: 500 } },
        ],
      }),
    );

    const outcome = await runTake(
      { runId: prepared.runId, plan: prepared.plan, deviceId: DEVICE_ID },
      takeDeps(harness, {
        device,
        recorder,
        analyze: createFakeAnalyzer({
          hitches: 1,
          blockMs: 10,
          memoryMB: 100,
        }),
      }),
    );

    expect(outcome.kind).toBe("ok");
    expect(device.openedUrls).toEqual([url]);
  });
});
