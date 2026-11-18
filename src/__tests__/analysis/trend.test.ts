import { describe, expect, it } from "vitest";
import {
  buildTrend,
  formatTrendNumber,
  resolveTrendLimit,
  signedTrendNumber,
  trendSparkline,
  type TrendRun,
} from "../../analysis/trend.js";
import type { MetricResult } from "../../model/test-run.js";

function metric(name: string, value: unknown, unit?: string): MetricResult {
  return { name, value, ...(unit !== undefined ? { unit } : {}) };
}

function run(overrides: Partial<TrendRun> & { runId: string }): TrendRun {
  return {
    status: "completed",
    startedAt: "2026-11-16T00:00:00.000Z",
    deviceId: "device-1",
    osVersion: "27.0.1",
    metrics: [metric("hitches", 10, "次")],
    ...overrides,
  };
}

describe("buildTrend", () => {
  it("includes completed and partial while counting other terminal states", () => {
    const trend = buildTrend({
      sceneId: "scene-a",
      runs: [
        run({ runId: "a", startedAt: "2026-11-16T00:00:00.000Z" }),
        run({
          runId: "b",
          status: "partial",
          startedAt: "2026-11-16T01:00:00.000Z",
        }),
        run({
          runId: "c",
          status: "invalid",
          startedAt: "2026-11-16T02:00:00.000Z",
        }),
        run({
          runId: "d",
          status: "failed",
          startedAt: "2026-11-16T03:00:00.000Z",
        }),
        run({
          runId: "e",
          status: "cancelled",
          startedAt: "2026-11-16T04:00:00.000Z",
        }),
      ],
      unreadable: 2,
    });

    expect(trend.groups).toHaveLength(1);
    expect(trend.groups[0]?.runCount).toBe(2);
    expect(trend.groups[0]?.statusCounts).toEqual({ completed: 1, partial: 1 });
    expect(trend.groups[0]?.metrics[0]?.points.map((point) => point.runId)).toEqual([
      "a",
      "b",
    ]);
    expect(trend.exclusions).toEqual({
      invalid: 1,
      failed: 1,
      cancelled: 1,
      unreadable: 2,
    });
  });

  it("groups by device and iOS, keeping unknown facts separate", () => {
    const trend = buildTrend({
      sceneId: "scene-a",
      runs: [
        run({
          runId: "d1",
          startedAt: "2026-11-16T00:00:00.000Z",
          deviceId: "device-1",
          osVersion: "27.0.1",
        }),
        run({
          runId: "d2",
          startedAt: "2026-11-16T01:00:00.000Z",
          deviceId: "device-2",
          osVersion: "27.0.1",
        }),
        run({
          runId: "d3",
          startedAt: "2026-11-16T02:00:00.000Z",
          deviceId: "device-1",
          osVersion: "26.4",
        }),
        run({
          runId: "d4",
          startedAt: "2026-11-16T03:00:00.000Z",
          deviceId: null,
          osVersion: null,
        }),
      ],
    });

    expect(trend.groups).toHaveLength(4);
    // Groups are ordered by their most recent Take, descending.
    expect(trend.groups.map((group) => group.deviceId)).toEqual([
      null,
      "device-1",
      "device-2",
      "device-1",
    ]);
    const unknown = trend.groups[0];
    expect(unknown?.osVersion).toBeNull();
    expect(unknown?.metrics[0]?.points).toHaveLength(1);
  });

  it("applies --device before grouping without counting other devices", () => {
    const trend = buildTrend({
      sceneId: "scene-a",
      deviceId: "device-2",
      runs: [
        run({ runId: "a", deviceId: "device-1" }),
        run({ runId: "other-failed", deviceId: "device-1", status: "failed" }),
        run({ runId: "b", deviceId: "device-2" }),
        run({
          runId: "c",
          deviceId: "device-2",
          status: "failed",
        }),
      ],
    });

    expect(trend.groups).toHaveLength(1);
    expect(trend.groups[0]?.deviceId).toBe("device-2");
    expect(trend.groups[0]?.runCount).toBe(1);
    // Only the failed Take on the requested device is reported as excluded.
    expect(trend.exclusions.failed).toBe(1);
  });

  it("keeps the most recent N Takes per group and orders them ascending", () => {
    const trend = buildTrend({
      sceneId: "scene-a",
      limit: 2,
      runs: [
        run({ runId: "old", startedAt: "2026-11-16T00:00:00.000Z" }),
        run({ runId: "mid", startedAt: "2026-11-16T01:00:00.000Z" }),
        run({ runId: "new", startedAt: "2026-11-16T02:00:00.000Z" }),
      ],
    });

    const series = trend.groups[0]?.metrics[0];
    expect(series?.points.map((point) => point.runId)).toEqual(["mid", "new"]);
    expect(trend.limit).toBe(2);
  });

  it("ignores non-numeric measurements instead of filling zero", () => {
    const trend = buildTrend({
      sceneId: "scene-a",
      runs: [
        run({
          runId: "a",
          startedAt: "2026-11-16T00:00:00.000Z",
          metrics: [metric("hitches", 8, "次")],
        }),
        run({
          runId: "b",
          startedAt: "2026-11-16T01:00:00.000Z",
          metrics: [metric("hitches", null, "次")],
        }),
        run({
          runId: "c",
          startedAt: "2026-11-16T02:00:00.000Z",
          metrics: [metric("hitches", "n/a", "次")],
        }),
      ],
    });

    const series = trend.groups[0]?.metrics[0];
    expect(series?.points.map((point) => point.value)).toEqual([8]);
    expect(series?.latest).toBe(8);
  });

  it("drops a metric that never produced a finite value", () => {
    const trend = buildTrend({
      sceneId: "scene-a",
      runs: [
        run({
          runId: "a",
          metrics: [metric("hitches", 5, "次"), metric("launchMs", null, "ms")],
        }),
      ],
    });

    expect(trend.groups[0]?.metrics.map((series) => series.name)).toEqual([
      "hitches",
    ]);
  });

  it("derives statistics, delta and unit from the recent points", () => {
    const trend = buildTrend({
      sceneId: "scene-a",
      runs: [
        run({
          runId: "a",
          startedAt: "2026-11-16T00:00:00.000Z",
          metrics: [metric("launchMs", 400, "ms")],
        }),
        run({
          runId: "b",
          startedAt: "2026-11-16T01:00:00.000Z",
          metrics: [metric("launchMs", 500, "ms")],
        }),
        run({
          runId: "c",
          startedAt: "2026-11-16T02:00:00.000Z",
          metrics: [metric("launchMs", 450, "ms")],
        }),
      ],
    });

    const series = trend.groups[0]?.metrics[0];
    expect(series).toBeDefined();
    expect(series?.latest).toBe(450);
    expect(series?.median).toBe(450);
    expect(series?.min).toBe(400);
    expect(series?.max).toBe(500);
    expect(series?.delta).toBe(-50);
    expect(series?.deltaPercent).toBeCloseTo(-10, 5);
    expect(series?.unit).toBe("ms");
    expect(series?.sparkline).toHaveLength(3);
  });

  it("cannot compute a delta from a single Take", () => {
    const trend = buildTrend({
      sceneId: "scene-a",
      runs: [run({ runId: "only" })],
    });

    const series = trend.groups[0]?.metrics[0];
    expect(series?.delta).toBeNull();
    expect(series?.deltaPercent).toBeNull();
  });

  it("does not compute a percentage when the previous value is zero", () => {
    const trend = buildTrend({
      sceneId: "scene-a",
      runs: [
        run({
          runId: "a",
          startedAt: "2026-11-16T00:00:00.000Z",
          metrics: [metric("hitches", 0, "次")],
        }),
        run({
          runId: "b",
          startedAt: "2026-11-16T01:00:00.000Z",
          metrics: [metric("hitches", 4, "次")],
        }),
      ],
    });

    const series = trend.groups[0]?.metrics[0];
    expect(series?.delta).toBe(4);
    expect(series?.deltaPercent).toBeNull();
  });

  it("takes metric order from the newest Take", () => {
    const trend = buildTrend({
      sceneId: "scene-a",
      runs: [
        run({
          runId: "old",
          startedAt: "2026-11-16T00:00:00.000Z",
          metrics: [metric("hitches", 10), metric("memoryMB", 100)],
        }),
        run({
          runId: "new",
          startedAt: "2026-11-16T01:00:00.000Z",
          metrics: [metric("memoryMB", 90), metric("hitches", 11)],
        }),
      ],
    });

    expect(trend.groups[0]?.metrics.map((series) => series.name)).toEqual([
      "memoryMB",
      "hitches",
    ]);
  });

  it("orders mixed fractional-second timestamps by actual time", () => {
    const trend = buildTrend({
      sceneId: "scene-a",
      limit: 2,
      runs: [
        run({
          runId: "fraction",
          startedAt: "2026-11-16T00:00:00.500Z",
        }),
        run({
          runId: "whole-second",
          startedAt: "2026-11-16T00:00:00Z",
        }),
      ],
    });

    // Lexicographic order would put `.500Z` first because "." < "Z"; the
    // parsed order keeps the half second later in the same second.
    expect(
      trend.groups[0]?.metrics[0]?.points.map((point) => point.runId),
    ).toEqual(["whole-second", "fraction"]);
  });

  it("takes the unit from the plotted points, not a valueless Take", () => {
    const trend = buildTrend({
      sceneId: "scene-a",
      runs: [
        run({
          runId: "a",
          startedAt: "2026-11-16T00:00:00.000Z",
          metrics: [metric("launchMs", 400, "ms")],
        }),
        run({
          runId: "b",
          startedAt: "2026-11-16T01:00:00.000Z",
          metrics: [metric("launchMs", null, "seconds")],
        }),
      ],
    });

    expect(trend.groups[0]?.metrics[0]?.points).toHaveLength(1);
    expect(trend.groups[0]?.metrics[0]?.unit).toBe("ms");
  });

  it("reports how many candidates matched the scene", () => {
    const trend = buildTrend({
      sceneId: "scene-a",
      runs: [run({ runId: "a" })],
      scanned: 7,
      scanLimit: 200,
    });
    expect(trend.scanned).toBe(7);
    expect(trend.scanLimit).toBe(200);
    expect(trend.sceneId).toBe("scene-a");
  });
});

describe("resolveTrendLimit", () => {
  it("defaults to 20 and rejects out-of-range values", () => {
    expect(resolveTrendLimit(undefined)).toBe(20);
    expect(resolveTrendLimit(1)).toBe(1);
    expect(resolveTrendLimit(200)).toBe(200);
    for (const value of [0, 201, 1.5, Number.NaN]) {
      expect(() => resolveTrendLimit(value)).toThrow(/--limit/);
    }
  });
});

describe("trendSparkline", () => {
  it("uses the middle level for a flat series and a single point", () => {
    expect(trendSparkline([5, 5, 5])).toBe("▄▄▄");
    expect(trendSparkline([5])).toBe("▄");
    expect(trendSparkline([])).toBe("");
  });

  it("normalises to the series min and max", () => {
    expect(trendSparkline([0, 1, 2, 3])).toBe("▁▃▆█");
  });
});

describe("trend number formatting", () => {
  it("keeps integers and rounds fractions to two decimals", () => {
    expect(formatTrendNumber(470)).toBe("470");
    expect(formatTrendNumber(554.49)).toBe("554.49");
    expect(formatTrendNumber(45.8)).toBe("45.8");
    expect(formatTrendNumber(1.234)).toBe("1.23");
    expect(formatTrendNumber(1.239)).toBe("1.24");
  });

  it("adds a sign only for increases", () => {
    expect(signedTrendNumber(12.5)).toBe("+12.5");
    expect(signedTrendNumber(-35)).toBe("-35");
    expect(signedTrendNumber(0)).toBe("0");
  });
});
