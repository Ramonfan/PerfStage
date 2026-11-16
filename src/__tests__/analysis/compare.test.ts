import { describe, expect, it } from "vitest";
import {
  baselineWindow,
  compareMetrics,
  comparisonStatusForSamples,
  median,
  selectBaseline,
  type ComparisonRun,
} from "../../analysis/compare.js";
import type { MetricResult } from "../../model/test-run.js";

function run(
  overrides: Partial<ComparisonRun> & { runId: string },
): ComparisonRun {
  return {
    planId: "scene-1",
    status: "completed",
    startedAt: "2026-11-16T00:00:00.000Z",
    deviceId: "device-1",
    osVersion: "27.0.1",
    metrics: [{ name: "hitches", value: 10, unit: "次" }],
    ...overrides,
  };
}

function metric(
  name: string,
  value: unknown,
  unit?: string,
): MetricResult {
  return {
    name,
    value,
    ...(unit !== undefined ? { unit } : {}),
  };
}

describe("median", () => {
  it("handles odd and even sample counts", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
  });

  it("returns null for an empty set", () => {
    expect(median([])).toBeNull();
  });
});

describe("selectBaseline", () => {
  const target = run({
    runId: "target",
    startedAt: "2026-11-16T03:00:00.000Z",
  });

  it("keeps only same plan, device and iOS, earlier and terminal", () => {
    const candidates = [
      run({ runId: "same-1", startedAt: "2026-11-16T01:00:00.000Z" }),
      run({
        runId: "other-plan",
        planId: "scene-2",
        startedAt: "2026-11-16T01:10:00.000Z",
      }),
      run({
        runId: "other-device",
        deviceId: "device-2",
        startedAt: "2026-11-16T01:20:00.000Z",
      }),
      run({
        runId: "other-os",
        osVersion: "26.0",
        startedAt: "2026-11-16T01:30:00.000Z",
      }),
      run({
        runId: "running",
        status: "running",
        startedAt: "2026-11-16T01:40:00.000Z",
      }),
      run({ runId: "later", startedAt: "2026-11-16T04:00:00.000Z" }),
      run({ runId: "target", startedAt: target.startedAt }),
    ];

    const selection = selectBaseline(target, candidates);
    expect(selection.selected.map((entry) => entry.runId)).toEqual(["same-1"]);
    expect(selection.excluded).toEqual({
      differentPlan: 1,
      differentDevice: 1,
      differentOs: 1,
      nonTerminal: 1,
      notBefore: 1,
    });
  });

  it("sorts newest first and truncates to the requested sample count", () => {
    const candidates = [
      run({ runId: "oldest", startedAt: "2026-11-16T00:00:00.000Z" }),
      run({ runId: "newest", startedAt: "2026-11-16T02:00:00.000Z" }),
      run({ runId: "middle", startedAt: "2026-11-16T01:00:00.000Z" }),
      run({ runId: "extra", startedAt: "2026-11-16T00:30:00.000Z" }),
    ];

    const selection = selectBaseline(target, candidates, { samples: 3 });
    expect(selection.selected.map((entry) => entry.runId)).toEqual([
      "newest",
      "middle",
      "extra",
    ]);
  });

  it("tie-breaks identical timestamps by run id descending", () => {
    const at = "2026-11-16T01:00:00.000Z";
    const selection = selectBaseline(target, [
      run({ runId: "a-run", startedAt: at }),
      run({ runId: "b-run", startedAt: at }),
    ]);
    expect(selection.selected.map((entry) => entry.runId)).toEqual([
      "b-run",
      "a-run",
    ]);
  });

  it("selects by epoch when timestamp precision differs", () => {
    const preciseTarget = run({
      runId: "target",
      startedAt: "2026-11-16T03:00:00.500Z",
    });
    const selection = selectBaseline(preciseTarget, [
      // Same second but earlier by 0.5 s; string ordering would invert this.
      run({ runId: "earlier", startedAt: "2026-11-16T03:00:00Z" }),
      run({ runId: "later", startedAt: "2026-11-16T03:00:00.700Z" }),
    ]);
    expect(selection.selected.map((entry) => entry.runId)).toEqual(["earlier"]);
    expect(selection.excluded.notBefore).toBe(1);
  });

  it("does not mix unknown iOS with a known iOS", () => {
    const legacyTarget = run({
      runId: "legacy-target",
      osVersion: null,
      startedAt: "2026-11-16T03:00:00.000Z",
    });
    const selection = selectBaseline(legacyTarget, [
      run({ runId: "known-os", osVersion: "27.0.1", startedAt: "2026-11-16T01:00:00.000Z" }),
      run({ runId: "unknown-os", osVersion: null, startedAt: "2026-11-16T02:00:00.000Z" }),
    ]);
    expect(selection.selected.map((entry) => entry.runId)).toEqual(["unknown-os"]);
    expect(selection.excluded.differentOs).toBe(1);
  });
});

describe("comparisonStatusForSamples", () => {
  it("maps sample counts onto honest statuses", () => {
    expect(comparisonStatusForSamples(0)).toBe("no-baseline");
    expect(comparisonStatusForSamples(1)).toBe("insufficient-samples");
    expect(comparisonStatusForSamples(2)).toBe("insufficient-samples");
    expect(comparisonStatusForSamples(3)).toBe("comparable");
  });
});

describe("compareMetrics", () => {
  it("reports median, range, delta, percent and direction", () => {
    const result = compareMetrics(
      [metric("hitches", 12, "次")],
      [
        run({ runId: "a", metrics: [metric("hitches", 8, "次")] }),
        run({ runId: "b", metrics: [metric("hitches", 10, "次")] }),
        run({ runId: "c", metrics: [metric("hitches", 15, "次")] }),
      ],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "hitches",
      unit: "次",
      current: 12,
      baselineMedian: 10,
      baselineRange: { min: 8, max: 15 },
      delta: 2,
      direction: "increase",
      samples: 3,
      status: "ok",
      withinRange: true,
    });
    expect(result[0]?.deltaPercent).toBeCloseTo(20, 6);
  });

  it("keeps delta but drops percent when the median is zero", () => {
    const [comparison] = compareMetrics(
      [metric("blockMs", 5, "ms")],
      [
        run({ runId: "a", metrics: [metric("blockMs", 0, "ms")] }),
        run({ runId: "b", metrics: [metric("blockMs", 0, "ms")] }),
      ],
    );
    expect(comparison?.delta).toBe(5);
    expect(comparison?.deltaPercent).toBeNull();
    expect(comparison?.direction).toBe("increase");
  });

  it("marks a metric the target lacks as missing-current", () => {
    const comparisons = compareMetrics(
      [metric("hitches", 12, "次")],
      [run({ runId: "a", metrics: [metric("memoryMB", 100, "MB")] })],
    );
    const memory = comparisons.find((entry) => entry.name === "memoryMB");
    const hitches = comparisons.find((entry) => entry.name === "hitches");
    expect(memory).toMatchObject({
      current: null,
      baselineMedian: 100,
      delta: null,
      direction: null,
      status: "missing-current",
    });
    expect(hitches?.status).toBe("missing-baseline");
  });

  it("marks a metric no baseline sample has as missing-baseline", () => {
    const [comparison] = compareMetrics(
      [metric("launchMs", 300, "ms")],
      [run({ runId: "a", metrics: [metric("hitches", 10, "次")] })],
    );
    expect(comparison).toMatchObject({
      name: "launchMs",
      current: 300,
      baselineMedian: null,
      baselineRange: null,
      delta: null,
      samples: 0,
      status: "missing-baseline",
    });
  });

  it("refuses to diff mismatched units", () => {
    const [comparison] = compareMetrics(
      [metric("launchMs", 300, "ms")],
      [run({ runId: "a", metrics: [metric("launchMs", 0.3, "s")] })],
    );
    expect(comparison?.status).toBe("unit-mismatch");
    expect(comparison?.delta).toBeNull();
    // The aggregate itself is suppressed: mixing ms and s would still be a
    // misleading number even without a delta.
    expect(comparison?.baselineMedian).toBeNull();
    expect(comparison?.baselineRange).toBeNull();
  });

  it("suppresses the aggregate for a missing target metric when baseline units are mixed", () => {
    const [comparison] = compareMetrics(
      [],
      [
        run({ runId: "a", metrics: [metric("launchMs", 300, "ms")] }),
        run({ runId: "b", metrics: [metric("launchMs", 0.3, "s")] }),
      ],
    );
    expect(comparison).toMatchObject({
      name: "launchMs",
      current: null,
      status: "missing-current",
      baselineMedian: null,
      baselineRange: null,
      delta: null,
      samples: 2,
    });
  });

  it("treats non-finite values as missing and never emits NaN/Infinity", () => {
    const [comparison] = compareMetrics(
      [metric("hitches", Number.NaN)],
      [run({ runId: "a", metrics: [metric("hitches", 10, "次")] })],
    );
    expect(comparison).toMatchObject({
      current: null,
      status: "missing-current",
      delta: null,
    });
    const payload = JSON.stringify(comparison);
    expect(payload).not.toContain("NaN");
    expect(payload).not.toContain("Infinity");
  });

  it("appends baseline-only metrics in first-seen order", () => {
    const result = compareMetrics(
      [metric("hitches", 12, "次")],
      [
        run({
          runId: "a",
          metrics: [metric("memoryMB", 100, "MB"), metric("blockMs", 4, "ms")],
        }),
      ],
    );
    expect(result.map((entry) => entry.name)).toEqual([
      "hitches",
      "memoryMB",
      "blockMs",
    ]);
  });

  it("counts only samples that actually carry the metric", () => {
    const [comparison] = compareMetrics(
      [metric("hitches", 12, "次")],
      [
        run({ runId: "a", metrics: [metric("hitches", 8, "次")] }),
        run({ runId: "b", metrics: [metric("hitches", null, "次")] }),
        run({ runId: "c", metrics: [] }),
      ],
    );
    expect(comparison?.samples).toBe(1);
    expect(comparison?.baselineMedian).toBe(8);
  });
});

describe("baselineWindow", () => {
  it("spans the earliest and latest sample", () => {
    expect(
      baselineWindow([
        run({ runId: "b", startedAt: "2026-11-16T02:00:00.000Z" }),
        run({ runId: "a", startedAt: "2026-11-16T01:00:00.000Z" }),
      ]),
    ).toEqual({
      from: "2026-11-16T01:00:00.000Z",
      to: "2026-11-16T02:00:00.000Z",
    });
  });

  it("returns null for no samples", () => {
    expect(baselineWindow([])).toBeNull();
  });

  it("orders mixed timestamp precision by epoch, not string", () => {
    expect(
      baselineWindow([
        run({ runId: "late", startedAt: "2026-11-16T03:00:00.700Z" }),
        run({ runId: "early", startedAt: "2026-11-16T03:00:00Z" }),
      ]),
    ).toEqual({
      from: "2026-11-16T03:00:00Z",
      to: "2026-11-16T03:00:00.700Z",
    });
  });
});
