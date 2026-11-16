import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateRegressionGate } from "../../tools/regression.js";
import type { MetricRegression } from "../../model/test-plan.js";
import type { TestRun } from "../../model/test-run.js";
import {
  createTestToolHarness,
  type TestToolHarness,
} from "../support/tool-harness.js";

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

const DEVICE = { id: "device-1", osVersion: "27.0.1" };

interface SeedOptions {
  id: string;
  planId?: string;
  startedAt: string;
  status?: TestRun["status"];
  gate?: TestRun["gate"];
  device?: TestRun["device"];
  metrics?: TestRun["metrics"];
  /** Regression rules written into `plan.json`, keyed by metric name. */
  rules?: Record<string, MetricRegression>;
  /** Overrides the whole plan snapshot, for corruption cases. */
  planRaw?: string;
}

async function seedRun(input: SeedOptions): Promise<void> {
  if (!harness) throw new Error("harness not initialized");
  await harness.runStore.create({
    id: input.id,
    planId: input.planId ?? "scene-1",
    device: input.device ?? DEVICE,
    status: input.status ?? "completed",
    ...(input.gate !== undefined ? { gate: input.gate } : {}),
    startedAt: input.startedAt,
    endedAt: "2026-11-16T00:01:00.000Z",
    durationMs: 60_000,
    repetitions: 1,
    currentRepetition: 0,
    actions: [],
    metrics: input.metrics ?? [{ name: "hitches", value: 10, unit: "次" }],
    evidence: { screenshotPaths: [], traceArchivePaths: [] },
    lifecycle: [],
  });

  const plan =
    input.planRaw ??
    JSON.stringify({
      id: input.planId ?? "scene-1",
      source: "scenario",
      device: DEVICE,
      metrics: Object.entries(input.rules ?? {}).map(([name, regression]) => ({
        name,
        regression,
      })),
    });
  await harness.runStore.writeText(input.id, "plan.json", plan);
}

function gate(input: Record<string, unknown>) {
  if (!harness) throw new Error("harness not initialized");
  return evaluateRegressionGate(input, {
    runStore: harness.runStore,
    now: () => new Date(),
  });
}

async function seedBaselines(): Promise<void> {
  for (const [id, hour, value] of [
    ["base-1", "01", 90],
    ["base-2", "02", 100],
    ["base-3", "03", 110],
  ] as const) {
    await seedRun({
      id,
      startedAt: `2026-11-16T${hour}:00:00.000Z`,
      metrics: [{ name: "hitches", value, unit: "次" }],
    });
  }
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relative = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, relative);
      } else if (entry.isFile()) {
        out[relative] = createHash("sha256")
          .update(await readFile(absolute))
          .digest("hex");
      }
    }
  };
  await walk(dir, "");
  return out;
}

describe("evaluateRegressionGate", () => {
  it("passes when the target is inside the tolerance", async () => {
    await seedBaselines();
    await seedRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      metrics: [{ name: "hitches", value: 110, unit: "次" }],
      rules: {
        hitches: { worse: "higher", maxWorseningPercent: 20 },
      },
    });

    const result = await gate({ runId: "target" });
    if ("error" in result) throw new Error(result.error);
    expect(result.status).toBe("comparable");
    expect(result.baseline).toMatchObject({ kind: "derived", samples: 3 });
    expect(result.regression).toMatchObject({
      status: "pass",
      configured: 1,
      evaluated: 1,
      failed: 0,
      notEvaluated: 0,
      reason: null,
    });
    expect(result.metrics[0]).toMatchObject({
      name: "hitches",
      current: 110,
      baselineMedian: 100,
      delta: 10,
      samples: 3,
      regression: { status: "pass", worseningPercent: 10 },
    });
  });

  it("fails when the target exceeds the tolerance", async () => {
    await seedBaselines();
    await seedRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      metrics: [{ name: "hitches", value: 125, unit: "次" }],
      rules: {
        hitches: { worse: "higher", maxWorseningPercent: 20 },
      },
    });

    const result = await gate({ runId: "target" });
    if ("error" in result) throw new Error(result.error);
    expect(result.regression).toMatchObject({
      status: "fail",
      configured: 1,
      failed: 1,
    });
    expect(result.metrics[0]?.regression).toMatchObject({
      status: "fail",
      exceeded: ["maxWorseningPercent"],
    });
  });

  it("keeps the absolute threshold out of the regression verdict", async () => {
    await seedBaselines();
    await seedRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      metrics: [{ name: "hitches", value: 110, unit: "次" }],
      // The Take failed its absolute threshold, but regression is in tolerance.
      gate: "fail",
      rules: {
        hitches: { worse: "higher", maxWorseningPercent: 20 },
      },
    });

    const result = await gate({ runId: "target" });
    if ("error" in result) throw new Error(result.error);
    expect(result.target.gate).toBe("fail");
    expect(result.regression.status).toBe("pass");
  });

  it("reports no-rules for a plan without regression configuration", async () => {
    await seedBaselines();
    await seedRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      metrics: [{ name: "hitches", value: 110, unit: "次" }],
    });

    const result = await gate({ runId: "target" });
    if ("error" in result) throw new Error(result.error);
    expect(result.regression).toMatchObject({
      status: "not-evaluated",
      configured: 0,
      reason: "no-rules",
    });
    expect(result.metrics[0]?.regression).toBeNull();
  });

  it("reports insufficient baseline instead of passing", async () => {
    await seedRun({
      id: "base-1",
      startedAt: "2026-11-16T01:00:00.000Z",
      metrics: [{ name: "hitches", value: 90, unit: "次" }],
    });
    await seedRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      metrics: [{ name: "hitches", value: 110, unit: "次" }],
      rules: {
        hitches: { worse: "higher", maxWorseningPercent: 20 },
      },
    });

    const result = await gate({ runId: "target" });
    if ("error" in result) throw new Error(result.error);
    expect(result.regression).toMatchObject({
      status: "not-evaluated",
      reason: "baseline-insufficient-samples",
    });
  });

  it("reports plan-unreadable for a broken snapshot", async () => {
    await seedBaselines();
    await seedRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      metrics: [{ name: "hitches", value: 110, unit: "次" }],
      planRaw: "null",
    });

    const result = await gate({ runId: "target" });
    if ("error" in result) throw new Error(result.error);
    expect(result.regression).toMatchObject({
      status: "not-evaluated",
      reason: "plan-unreadable",
    });
    expect(result.warnings.join(" ")).toContain("plan.json");
  });

  it("reports invalid rules as plan-unreadable", async () => {
    await seedBaselines();
    await seedRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      metrics: [{ name: "hitches", value: 110, unit: "次" }],
      planRaw: JSON.stringify({
        metrics: [{ name: "hitches", regression: { worse: "sideways" } }],
      }),
    });

    const result = await gate({ runId: "target" });
    if ("error" in result) throw new Error(result.error);
    expect(result.regression.reason).toBe("plan-unreadable");
    expect(result.warnings.join(" ")).toContain("regression");
  });

  it("does not evaluate a terminal but untrustworthy Take", async () => {
    await seedBaselines();
    await seedRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      status: "failed",
      metrics: [{ name: "hitches", value: 110, unit: "次" }],
      rules: {
        hitches: { worse: "higher", maxWorseningPercent: 20 },
      },
    });

    const result = await gate({ runId: "target" });
    if ("error" in result) throw new Error(result.error);
    expect(result.target.status).toBe("failed");
    expect(result.regression).toMatchObject({
      status: "not-evaluated",
      reason: "target-not-completed",
    });
  });

  it("evaluates no metrics for an untrustworthy Take without numeric metrics", async () => {
    // An `invalid` Take (precondition failure, device drop) has no numeric
    // metrics at all. `compare` refuses such a target, but the gate must still
    // answer `target-not-completed` so the CLI can map it to exit 2.
    await seedBaselines();
    await seedRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      status: "invalid",
      metrics: [],
      rules: {
        hitches: { worse: "higher", maxWorseningPercent: 20 },
      },
    });

    const result = await gate({ runId: "target" });
    if ("error" in result) throw new Error(result.error);
    expect(result.target).toMatchObject({
      runId: "target",
      status: "invalid",
      deviceId: "device-1",
      osVersion: "27.0.1",
    });
    expect(result.baseline).toMatchObject({ kind: "derived", samples: 0 });
    expect(result.regression).toMatchObject({
      status: "not-evaluated",
      configured: 1,
      reason: "target-not-completed",
    });
    expect(result.metrics[0]).toMatchObject({
      name: "hitches",
      regression: { status: "not-evaluated", reason: "target-not-completed" },
    });
    expect(result.warnings.join(" ")).toContain("invalid");
  });

  it("uses only the target's rules when comparing against another run", async () => {
    await seedRun({
      id: "against",
      startedAt: "2026-11-16T01:00:00.000Z",
      metrics: [{ name: "hitches", value: 100, unit: "次" }],
      rules: {
        hitches: { worse: "higher", maxWorseningPercent: 1 },
      },
    });
    await seedRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      metrics: [{ name: "hitches", value: 200, unit: "次" }],
    });

    const result = await gate({ runId: "target", against: "against" });
    if ("error" in result) throw new Error(result.error);
    expect(result.regression).toMatchObject({
      status: "not-evaluated",
      configured: 0,
      reason: "no-rules",
    });
    expect(result.metrics[0]?.regression).toBeNull();
  });

  it("evaluates a single explicit --against sample", async () => {
    await seedRun({
      id: "against",
      startedAt: "2026-11-16T01:00:00.000Z",
      metrics: [{ name: "hitches", value: 100, unit: "次" }],
    });
    await seedRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      metrics: [{ name: "hitches", value: 110, unit: "次" }],
      rules: {
        hitches: { worse: "higher", maxWorseningPercent: 20 },
      },
    });

    const result = await gate({ runId: "target", against: "against" });
    if ("error" in result) throw new Error(result.error);
    expect(result.baseline).toMatchObject({ kind: "against", samples: 1 });
    expect(result.regression.status).toBe("pass");
    expect(result.metrics[0]?.samples).toBe(1);
  });

  it("appends a configured metric absent from the comparison", async () => {
    await seedBaselines();
    await seedRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      metrics: [{ name: "hitches", value: 110, unit: "次" }],
      rules: {
        hitches: { worse: "higher", maxWorseningPercent: 20 },
        launchMs: { worse: "higher", maxWorseningPercent: 20 },
      },
    });

    const result = await gate({ runId: "target" });
    if ("error" in result) throw new Error(result.error);
    expect(result.regression).toMatchObject({
      status: "not-evaluated",
      configured: 2,
      evaluated: 1,
      notEvaluated: 1,
    });
    const missing = result.metrics.find((metric) => metric.name === "launchMs");
    expect(missing?.regression).toMatchObject({
      status: "not-evaluated",
      reason: "metric-not-in-target",
    });
  });

  it("keeps the verdict when the scenario file changes after the run", async () => {
    if (!harness) throw new Error("harness not initialized");
    await seedBaselines();
    await seedRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      metrics: [{ name: "hitches", value: 125, unit: "次" }],
      rules: {
        hitches: { worse: "higher", maxWorseningPercent: 20 },
      },
    });

    const before = await gate({ runId: "target" });
    if ("error" in before) throw new Error(before.error);
    expect(before.regression.status).toBe("fail");

    // Rewriting the scenario must not move the verdict: rules come from the
    // target run's snapshot, not from the current YAML.
    await writeFile(
      join(harness.scenarioDir, "community-home-scroll.yaml"),
      "id: community-home-scroll\nname: changed\napp: { bundleId: com.nndev.im }\nactions: []\n",
      "utf8",
    );

    const after = await gate({ runId: "target" });
    expect(after).toEqual(before);
  });

  it("rejects an invalid --against even when the target is untrustworthy", async () => {
    await seedRun({
      id: "other-scene",
      planId: "scene-2",
      startedAt: "2026-11-16T01:00:00.000Z",
      metrics: [{ name: "hitches", value: 100, unit: "次" }],
    });
    await seedRun({
      id: "comparable",
      startedAt: "2026-11-16T02:00:00.000Z",
      metrics: [{ name: "hitches", value: 100, unit: "次" }],
    });
    await seedRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      status: "invalid",
      metrics: [],
      rules: {
        hitches: { worse: "higher", maxWorseningPercent: 20 },
      },
    });

    const self = await gate({ runId: "target", against: "target" });
    expect("error" in self && self.error).toContain("相同");

    const missing = await gate({ runId: "target", against: "missing-run" });
    expect("error" in missing && missing.error).toContain("missing-run");

    const both = await gate({
      runId: "target",
      against: "comparable",
      samples: 3,
    });
    expect("error" in both && both.error).toContain("只能选其一");

    const crossScene = await gate({ runId: "target", against: "other-scene" });
    expect("error" in crossScene && crossScene.error).toContain("场景不同");

    await seedRun({
      id: "other-device",
      startedAt: "2026-11-16T02:30:00.000Z",
      device: { id: "device-2", osVersion: "27.0.1" },
      metrics: [{ name: "hitches", value: 100, unit: "次" }],
    });
    const crossDevice = await gate({ runId: "target", against: "other-device" });
    expect("error" in crossDevice && crossDevice.error).toContain("设备不同");

    await seedRun({
      id: "running-against",
      startedAt: "2026-11-16T03:00:00.000Z",
      status: "running",
      metrics: [{ name: "hitches", value: 100, unit: "次" }],
    });
    const nonTerminal = await gate({
      runId: "target",
      against: "running-against",
    });
    expect("error" in nonTerminal && nonTerminal.error).toContain("尚未进入终态");

    const valid = await gate({ runId: "target", against: "comparable" });
    if ("error" in valid) throw new Error(valid.error);
    expect(valid.regression.reason).toBe("target-not-completed");
    expect(valid.baseline).toMatchObject({
      kind: "against",
      samples: 0,
      runIds: ["comparable"],
      osVersion: "27.0.1",
    });
  });

  it("keeps the against iOS and warns when it differs", async () => {
    await seedRun({
      id: "other-os",
      startedAt: "2026-11-16T02:00:00.000Z",
      device: { id: "device-1", osVersion: "26.0" },
      metrics: [{ name: "hitches", value: 100, unit: "次" }],
    });
    await seedRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      status: "invalid",
      metrics: [],
    });

    const result = await gate({ runId: "target", against: "other-os" });
    if ("error" in result) throw new Error(result.error);
    expect(result.baseline).toMatchObject({
      kind: "against",
      samples: 0,
      runIds: ["other-os"],
      osVersion: "26.0",
    });
    expect(result.warnings.join(" ")).toContain("iOS 版本不同");
  });

  it("keeps device facts even when the rules snapshot is invalid", async () => {
    await seedRun({
      id: "comparable",
      startedAt: "2026-11-16T02:00:00.000Z",
      metrics: [{ name: "hitches", value: 100, unit: "次" }],
    });
    await seedRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      status: "invalid",
      metrics: [],
      planRaw: JSON.stringify({
        id: "scene-1",
        device: { id: "device-1", osVersion: "27.0.1" },
        // `regression` without `name` makes the narrow rules schema fail.
        metrics: [{ regression: { worse: "higher", maxWorseningPercent: 20 } }],
      }),
    });

    const result = await gate({ runId: "target", against: "comparable" });
    if ("error" in result) throw new Error(result.error);
    expect(result.target).toMatchObject({
      deviceId: "device-1",
      osVersion: "27.0.1",
    });
    expect(result.regression.reason).toBe("target-not-completed");
    expect(result.warnings.join(" ")).toContain("regression 配置无效");
  });

  it("rejects --against together with --samples", async () => {
    const result = await gate({
      runId: "target",
      against: "against",
      samples: 3,
    });
    expect("error" in result && result.error).toContain("只能选其一");
  });

  it("is read-only and deterministic", async () => {
    if (!harness) throw new Error("harness not initialized");
    await seedBaselines();
    await seedRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      metrics: [{ name: "hitches", value: 110, unit: "次" }],
      rules: {
        hitches: { worse: "higher", maxWorseningPercent: 20 },
      },
    });

    const before = await snapshot(harness.root);
    const first = await gate({ runId: "target" });
    const second = await gate({ runId: "target" });
    const after = await snapshot(harness.root);

    expect(first).toEqual(second);
    expect(after).toEqual(before);
  });

  it("rejects an unknown target run", async () => {
    const result = await gate({ runId: "missing-run" });
    expect("error" in result && result.error).toContain("missing-run");
  });
});
