import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { comparePerformanceRuns } from "../../tools/compare.js";
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

interface SeedOptions {
  id: string;
  planId?: string;
  status?: TestRun["status"];
  startedAt: string;
  device?: TestRun["device"];
  metrics?: TestRun["metrics"];
  /** `plan.json` device id; defaults to the run device id. */
  planDeviceId?: string | null;
  planOsVersion?: string;
  writePlan?: boolean;
}

async function seedRun(input: SeedOptions): Promise<void> {
  if (!harness) throw new Error("harness not initialized");
  const planId = input.planId ?? "scene-1";
  const metrics = input.metrics ?? [{ name: "hitches", value: 10, unit: "次" }];
  await harness.runStore.create({
    id: input.id,
    planId,
    ...(input.device !== undefined ? { device: input.device } : {}),
    status: input.status ?? "completed",
    startedAt: input.startedAt,
    endedAt: "2026-11-16T00:01:00.000Z",
    durationMs: 60_000,
    repetitions: 1,
    currentRepetition: 0,
    actions: [],
    metrics,
    evidence: { screenshotPaths: [], traceArchivePaths: [] },
    lifecycle: [],
  });

  if (input.writePlan !== false) {
    const planDeviceId =
      input.planDeviceId === undefined
        ? (input.device?.id ?? null)
        : input.planDeviceId;
    await harness.runStore.writeText(
      input.id,
      "plan.json",
      JSON.stringify({
        id: planId,
        source: "scenario",
        ...(planDeviceId !== null
          ? {
              device: {
                id: planDeviceId,
                ...(input.planOsVersion !== undefined
                  ? { osVersion: input.planOsVersion }
                  : {}),
              },
            }
          : {}),
      }),
    );
  }
}

function compare(input: Record<string, unknown>) {
  if (!harness) throw new Error("harness not initialized");
  return comparePerformanceRuns(input, {
    runStore: harness.runStore,
    now: () => new Date(),
  });
}

const DEVICE = { id: "device-1", osVersion: "27.0.1" };

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

describe("comparePerformanceRuns", () => {
  it("rejects an unknown target run", async () => {
    const result = await compare({ runId: "missing-run" });
    expect("error" in result && result.error).toContain("missing-run");
  });

  it("rejects a target that is not terminal", async () => {
    await seedRun({
      id: "target",
      status: "running",
      startedAt: "2026-11-16T04:00:00.000Z",
      device: DEVICE,
    });
    const result = await compare({ runId: "target" });
    expect("error" in result && result.error).toContain("尚未进入终态");
  });

  it("rejects a target without numeric metrics", async () => {
    await seedRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      device: DEVICE,
      metrics: [{ name: "hitches" }],
    });
    const result = await compare({ runId: "target" });
    expect("error" in result && result.error).toContain("数值指标");
  });

  it("derives a three-sample baseline and explains every exclusion", async () => {
    await seedRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      device: DEVICE,
      metrics: [
        { name: "hitches", value: 12, unit: "次" },
        { name: "blockMs", value: 5, unit: "ms" },
      ],
    });
    await seedRun({
      id: "base-new",
      startedAt: "2026-11-16T03:00:00.000Z",
      device: DEVICE,
      metrics: [
        { name: "hitches", value: 15, unit: "次" },
        { name: "blockMs", value: 6, unit: "ms" },
      ],
    });
    await seedRun({
      id: "base-mid",
      startedAt: "2026-11-16T02:00:00.000Z",
      device: DEVICE,
      metrics: [
        { name: "hitches", value: 10, unit: "次" },
        { name: "blockMs", value: 4, unit: "ms" },
      ],
    });
    await seedRun({
      id: "base-old",
      startedAt: "2026-11-16T01:00:00.000Z",
      device: DEVICE,
      metrics: [
        { name: "hitches", value: 8, unit: "次" },
        { name: "blockMs", value: 2, unit: "ms" },
      ],
    });
    await seedRun({
      id: "other-plan",
      planId: "scene-2",
      startedAt: "2026-11-16T01:10:00.000Z",
      device: DEVICE,
    });
    await seedRun({
      id: "other-device",
      startedAt: "2026-11-16T01:20:00.000Z",
      device: { id: "device-2", osVersion: "27.0.1" },
    });
    await seedRun({
      id: "other-os",
      startedAt: "2026-11-16T01:30:00.000Z",
      device: { id: "device-1", osVersion: "26.0" },
    });
    await seedRun({
      id: "still-running",
      status: "running",
      startedAt: "2026-11-16T01:40:00.000Z",
      device: DEVICE,
    });
    await seedRun({
      id: "later",
      startedAt: "2026-11-16T05:00:00.000Z",
      device: DEVICE,
    });
    if (!harness) throw new Error("harness not initialized");
    await mkdir(join(harness.runsDir, "broken-run"), { recursive: true });
    await writeFile(
      join(harness.runsDir, "broken-run", "run.json"),
      "{ not json",
      "utf8",
    );

    const result = await compare({ runId: "target" });
    if ("error" in result) throw new Error(result.error);
    expect(result.status).toBe("comparable");
    expect(result.baseline).toMatchObject({
      kind: "derived",
      samples: 3,
      runIds: ["base-new", "base-mid", "base-old"],
      osVersion: "27.0.1",
    });
    expect(result.baseline.window).toEqual({
      from: "2026-11-16T01:00:00.000Z",
      to: "2026-11-16T03:00:00.000Z",
    });
    expect(result.excluded).toEqual({
      differentPlan: 1,
      differentDevice: 1,
      differentOs: 1,
      nonTerminal: 1,
      notBefore: 1,
      unreadable: 1,
    });

    const hitches = result.metrics.find((metric) => metric.name === "hitches");
    expect(hitches).toMatchObject({
      current: 12,
      baselineMedian: 10,
      baselineRange: { min: 8, max: 15 },
      delta: 2,
      direction: "increase",
      samples: 3,
      withinRange: true,
      status: "ok",
    });
    expect(hitches?.deltaPercent).toBeCloseTo(20, 6);
    const block = result.metrics.find((metric) => metric.name === "blockMs");
    expect(block?.baselineMedian).toBe(4);
    expect(block?.direction).toBe("increase");
  });

  it("reports insufficient-samples without pretending it is comparable", async () => {
    await seedRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      device: DEVICE,
    });
    await seedRun({
      id: "base-1",
      startedAt: "2026-11-16T02:00:00.000Z",
      device: DEVICE,
      metrics: [{ name: "hitches", value: 8, unit: "次" }],
    });
    await seedRun({
      id: "base-2",
      startedAt: "2026-11-16T03:00:00.000Z",
      device: DEVICE,
      metrics: [{ name: "hitches", value: 14, unit: "次" }],
    });

    const result = await compare({ runId: "target" });
    if ("error" in result) throw new Error(result.error);
    expect(result.status).toBe("insufficient-samples");
    expect(result.baseline.samples).toBe(2);
    expect(result.metrics[0]).toMatchObject({
      baselineMedian: 11,
      samples: 2,
      status: "ok",
    });
  });

  it("returns no-baseline instead of fabricating one", async () => {
    await seedRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      device: DEVICE,
    });

    const result = await compare({ runId: "target" });
    if ("error" in result) throw new Error(result.error);
    expect(result.status).toBe("no-baseline");
    expect(result.baseline.samples).toBe(0);
    expect(result.baseline.window).toBeNull();
    expect(result.metrics[0]).toMatchObject({
      baselineMedian: null,
      delta: null,
      samples: 0,
      status: "missing-baseline",
    });
  });

  it("aggregates legacy runs only among unknown iOS records", async () => {
    await seedRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      planDeviceId: "device-1",
    });
    for (const [id, hour, value] of [
      ["legacy-a", "01", 8],
      ["legacy-b", "02", 10],
      ["legacy-c", "03", 12],
    ] as const) {
      await seedRun({
        id,
        startedAt: `2026-11-16T${hour}:00:00.000Z`,
        planDeviceId: "device-1",
        metrics: [{ name: "hitches", value, unit: "次" }],
      });
    }
    await seedRun({
      id: "known-os",
      startedAt: "2026-11-16T02:30:00.000Z",
      device: { id: "device-1", osVersion: "27.0.1" },
    });

    const result = await compare({ runId: "target" });
    if ("error" in result) throw new Error(result.error);
    expect(result.status).toBe("comparable");
    expect(result.target.osVersion).toBeNull();
    expect(result.baseline).toMatchObject({
      samples: 3,
      runIds: ["legacy-c", "legacy-b", "legacy-a"],
      osVersion: null,
    });
    expect(result.excluded.differentOs).toBe(1);
    expect(result.warnings.join(" ")).toContain("iOS 版本未记录");
  });

  it("compares directly against one Take with --against", async () => {
    await seedRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      device: DEVICE,
      metrics: [{ name: "hitches", value: 12, unit: "次" }],
    });
    await seedRun({
      id: "against",
      startedAt: "2026-11-16T03:00:00.000Z",
      device: DEVICE,
      metrics: [{ name: "hitches", value: 10, unit: "次" }],
    });

    const result = await compare({ runId: "target", against: "against" });
    if ("error" in result) throw new Error(result.error);
    expect(result.status).toBe("comparable");
    expect(result.baseline).toMatchObject({
      kind: "against",
      samples: 1,
      runIds: ["against"],
    });
    expect(result.metrics[0]).toMatchObject({
      baselineMedian: 10,
      baselineRange: { min: 10, max: 10 },
      delta: 2,
      samples: 1,
      status: "ok",
    });
  });

  it("warns but still compares when --against has a different known iOS", async () => {
    await seedRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      device: DEVICE,
    });
    await seedRun({
      id: "against",
      startedAt: "2026-11-16T03:00:00.000Z",
      device: { id: "device-1", osVersion: "26.0" },
    });

    const result = await compare({ runId: "target", against: "against" });
    if ("error" in result) throw new Error(result.error);
    expect(result.status).toBe("comparable");
    expect(result.baseline.osVersion).toBe("26.0");
    expect(result.warnings.join(" ")).toContain("iOS 版本不同");
  });

  it("rejects comparing a run with itself", async () => {
    await seedRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      device: DEVICE,
    });
    const result = await compare({ runId: "target", against: "target" });
    expect("error" in result && result.error).toContain("不能与目标");
    expect("error" in result && result.error).toContain("target");
  });

  it("rejects --against across plans or devices", async () => {
    await seedRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      device: DEVICE,
    });
    await seedRun({
      id: "other-plan",
      planId: "scene-2",
      startedAt: "2026-11-16T03:00:00.000Z",
      device: DEVICE,
    });
    await seedRun({
      id: "other-device",
      startedAt: "2026-11-16T02:00:00.000Z",
      device: { id: "device-2", osVersion: "27.0.1" },
    });

    const byPlan = await compare({ runId: "target", against: "other-plan" });
    expect("error" in byPlan && byPlan.error).toContain("场景不同");
    const byDevice = await compare({ runId: "target", against: "other-device" });
    expect("error" in byDevice && byDevice.error).toContain("设备不同");
  });

  it("rejects against with samples and out-of-range sample counts", async () => {
    await seedRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      device: DEVICE,
    });

    const both = await compare({ runId: "target", against: "target", samples: 3 });
    expect("error" in both && both.error).toContain("只能选其一");
    for (const samples of [0, 2, 21, 3.5]) {
      const invalid = await compare({ runId: "target", samples });
      expect("error" in invalid).toBe(true);
    }
  });

  it("honours a valid non-default sample count", async () => {
    await seedRun({
      id: "target",
      startedAt: "2026-11-16T10:00:00.000Z",
      device: DEVICE,
    });
    for (let index = 1; index <= 6; index += 1) {
      await seedRun({
        id: `base-${index}`,
        startedAt: `2026-11-16T0${index}:00:00.000Z`,
        device: DEVICE,
        metrics: [{ name: "hitches", value: index, unit: "次" }],
      });
    }

    const result = await compare({ runId: "target", samples: 5 });
    if ("error" in result) throw new Error(result.error);
    expect(result.status).toBe("comparable");
    expect(result.baseline.samples).toBe(5);
    expect(result.baseline.runIds).toEqual([
      "base-6",
      "base-5",
      "base-4",
      "base-3",
      "base-2",
    ]);
    expect(result.metrics[0]?.baselineMedian).toBe(4);
  });

  it("counts a legacy run with an unreadable plan as unreadable, not a device mismatch", async () => {
    await seedRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      device: DEVICE,
    });
    await seedRun({
      id: "valid-base",
      startedAt: "2026-11-16T02:00:00.000Z",
      device: DEVICE,
    });
    // Legacy run: no run.device and no plan.json to fall back to.
    await seedRun({
      id: "broken-plan",
      startedAt: "2026-11-16T03:00:00.000Z",
      writePlan: false,
    });

    const result = await compare({ runId: "target" });
    if ("error" in result) throw new Error(result.error);
    expect(result.excluded.unreadable).toBe(1);
    expect(result.excluded.differentDevice).toBe(0);
    expect(result.baseline.samples).toBe(1);
    expect(result.status).toBe("insufficient-samples");
  });

  it("treats a JSON null plan as unreadable instead of throwing", async () => {
    if (!harness) throw new Error("harness not initialized");
    await seedRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      device: DEVICE,
      writePlan: false,
    });
    await writeFile(join(harness.runsDir, "target", "plan.json"), "null", "utf8");
    await seedRun({
      id: "valid-base",
      startedAt: "2026-11-16T02:00:00.000Z",
      device: DEVICE,
    });
    // Legacy candidate without device facts whose plan is syntactically valid
    // JSON but not a plan object.
    await seedRun({
      id: "null-plan",
      startedAt: "2026-11-16T03:00:00.000Z",
      writePlan: false,
    });
    await writeFile(join(harness.runsDir, "null-plan", "plan.json"), "null", "utf8");

    const result = await compare({ runId: "target" });
    if ("error" in result) throw new Error(result.error);
    expect(result.excluded.unreadable).toBe(1);
    expect(result.excluded.differentDevice).toBe(0);
    expect(result.baseline.samples).toBe(1);
    expect(result.status).toBe("insufficient-samples");
  });

  it("is read-only and deterministic", async () => {
    if (!harness) throw new Error("harness not initialized");
    await seedRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      device: DEVICE,
    });
    for (const [id, hour] of [
      ["base-1", "01"],
      ["base-2", "02"],
      ["base-3", "03"],
    ] as const) {
      await seedRun({
        id,
        startedAt: `2026-11-16T${hour}:00:00.000Z`,
        device: DEVICE,
      });
    }

    const before = await snapshot(harness.root);
    const first = await compare({ runId: "target" });
    const second = await compare({ runId: "target" });
    const after = await snapshot(harness.root);

    expect(first).toEqual(second);
    expect(after).toEqual(before);
  });
});
