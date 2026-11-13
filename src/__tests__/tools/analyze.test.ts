import { describe, expect, it } from "vitest";
import {
  analyzePerformanceTrace,
  hitchesMetrics,
  launchMetrics,
  memoryMetrics,
} from "../../tools/analyze.js";
import type { AnimationHitchesAnalysis } from "../../analysis/parsers/animation-hitches.js";
import type { AppLaunchAnalysis } from "../../analysis/parsers/app-launch.js";
import type { ActivityMonitorAnalysis } from "../../analysis/parsers/activity-monitor.js";

const TRACE = "/tmp/take-hitches.trace";

function hitchesAnalysis(
  overrides: Partial<AnimationHitchesAnalysis> = {},
): AnimationHitchesAnalysis {
  return {
    template: "Animation Hitches",
    table: "hitches-frame-lifetimes",
    frameCount: 100,
    targetFrameMs: 16.7,
    hitchThresholdMs: 21.7,
    hitches: 7,
    blockMs: 92.5,
    estimatedHitchTimeMs: 140,
    colorCounts: { green: 90, purple: 10, brown: 0, yellow: 0, other: 0, none: 0 },
    severityCounts: { micro: 7, minor: 0, warning: 0, critical: 0 },
    topHitches: [],
    warnings: [],
    ...overrides,
  };
}

describe("hitchesMetrics", () => {
  it("maps one Animation Hitches pass to hitches and blockMs", () => {
    const metrics = hitchesMetrics(hitchesAnalysis(), TRACE);
    expect(metrics).toHaveLength(2);
    expect(metrics[0]).toMatchObject({
      name: "hitches",
      value: 7,
      unit: "次",
      instrument: "Animation Hitches",
      tracePath: TRACE,
    });
    expect(metrics[1]).toMatchObject({
      name: "blockMs",
      value: 92.5,
      unit: "ms",
      instrument: "Animation Hitches",
      tracePath: TRACE,
    });
  });
});

describe("launchMetrics", () => {
  function launchAnalysis(overrides: Partial<AppLaunchAnalysis> = {}): AppLaunchAnalysis {
    return {
      template: "App Launch",
      processName: "NN",
      launchType: "cold",
      launchMs: 274.3,
      phases: [],
      rowCount: 11,
      dyld: null,
      warnings: [],
      ...overrides,
    };
  }

  it("maps launchMs from the launch analysis", () => {
    expect(launchMetrics(launchAnalysis(), "/tmp/launch.trace")[0]).toMatchObject({
      name: "launchMs",
      value: 274.3,
      unit: "ms",
      instrument: "App Launch",
      tracePath: "/tmp/launch.trace",
    });
  });

  it("omits the value when no launch phase was found", () => {
    const metric = launchMetrics(launchAnalysis({ launchMs: null }), "/tmp/launch.trace")[0];
    expect(metric.name).toBe("launchMs");
    expect(metric).not.toHaveProperty("value");
    expect(metric.tracePath).toBe("/tmp/launch.trace");
  });
});

describe("memoryMetrics", () => {
  it("uses the median physical footprint (D12)", () => {
    const analysis = {
      template: "Activity Monitor",
      pid: 6764,
      processName: "NNIM",
      selection: "pid",
      summary: { medianMiB: 113.5 },
      seriesMiB: [114.85, 113.5],
      processes: [],
      warnings: [],
    } as unknown as ActivityMonitorAnalysis;

    expect(memoryMetrics(analysis, "/tmp/memory.trace")[0]).toMatchObject({
      name: "memoryMB",
      value: 113.5,
      unit: "MB",
      instrument: "Activity Monitor",
      tracePath: "/tmp/memory.trace",
    });
  });
});

describe("analyzePerformanceTrace", () => {
  it("rejects malformed input with a structured error", async () => {
    const result = await analyzePerformanceTrace({ template: "hitches" });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/analyze_performance_trace/);
    }
  });

  it("returns a structured error when the trace cannot be read", async () => {
    const result = await analyzePerformanceTrace({
      template: "hitches",
      tracePath: "/tmp/definitely-missing-perfstage.trace",
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/分析 hitches trace 失败/);
    }
  });
});
