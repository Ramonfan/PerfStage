import { describe, expect, it } from "vitest";
import { buildTrend, type TrendRun } from "../../analysis/trend.js";
import { renderTrendText } from "../../reports/trend-text.js";
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

describe("renderTrendText", () => {
  it("renders a grouped metric summary with statistics and delta", () => {
    const trend = buildTrend({
      sceneId: "scene-a",
      runs: [
        run({
          runId: "a",
          startedAt: "2026-11-15T00:00:00.000Z",
          metrics: [metric("hitches", 470, "次")],
        }),
        run({
          runId: "b",
          startedAt: "2026-11-16T00:00:00.000Z",
          metrics: [metric("hitches", 512, "次")],
        }),
        run({
          runId: "c",
          startedAt: "2026-11-17T00:00:00.000Z",
          metrics: [metric("hitches", 480, "次")],
        }),
      ],
    });

    const text = renderTrendText(trend);
    expect(text).toContain("场景：scene-a");
    expect(text).toContain("匹配 3 条，每分组最多 20 条");
    expect(text).toContain("分组：device-1 / iOS 27.0.1");
    expect(text).toContain("3 次 Take（2026-11-15 → 2026-11-17）");
    expect(text).toContain("状态：completed 3、partial 0");
    expect(text).toContain("hitches（次）");
    expect(text).toContain("最近 480");
    expect(text).toContain("中位数 480");
    expect(text).toContain("范围 470–512");
    expect(text).toContain("较上次测量 -32（-6.25%）");
    expect(text).toContain("排除（当前筛选）：invalid 0、failed 0、cancelled 0、不可读 0");
  });

  it("shows how many included Takes are partial", () => {
    const trend = buildTrend({
      sceneId: "scene-a",
      runs: [
        run({ runId: "a", startedAt: "2026-11-16T00:00:00.000Z" }),
        run({
          runId: "b",
          status: "partial",
          startedAt: "2026-11-16T01:00:00.000Z",
        }),
      ],
    });

    expect(renderTrendText(trend)).toContain(
      "状态：completed 1、partial 1",
    );
  });

  it("marks the delta as uncomputable for a single Take", () => {
    const trend = buildTrend({
      sceneId: "scene-a",
      runs: [run({ runId: "only" })],
    });

    const text = renderTrendText(trend);
    expect(text).toContain("最近 10");
    expect(text).toContain("较上次测量 无法计算");
  });

  it("shows unknown device and iOS instead of nulls", () => {
    const trend = buildTrend({
      sceneId: "scene-a",
      runs: [run({ runId: "a", deviceId: null, osVersion: null })],
    });

    const text = renderTrendText(trend);
    expect(text).toContain("分组：未知 / iOS 未知");
    expect(text).not.toContain("null");
    expect(text).not.toContain("undefined");
  });

  it("says so when there is no usable history", () => {
    const trend = buildTrend({
      sceneId: "scene-a",
      runs: [
        run({ runId: "a", status: "failed" }),
        run({ runId: "b", status: "invalid" }),
      ],
      scanned: 2,
    });

    const text = renderTrendText(trend);
    expect(text).toContain("没有可用于趋势的运行。");
    expect(text).toContain("排除（当前筛选）：invalid 1、failed 1、cancelled 0、不可读 0");
  });

  it("flags a group whose Takes carry no numeric metrics", () => {
    const trend = buildTrend({
      sceneId: "scene-a",
      runs: [run({ runId: "a", metrics: [metric("hitches", null, "次")] })],
    });

    expect(renderTrendText(trend)).toContain("无可用数值指标。");
  });
});
