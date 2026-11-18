import { describe, expect, it } from "vitest";
import { buildTrend, type TrendRun } from "../../analysis/trend.js";
import { renderTrendHtml } from "../../reports/trend-html.js";
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

describe("renderTrendHtml", () => {
  it("is a standalone offline document", () => {
    const html = renderTrendHtml(
      buildTrend({ sceneId: "scene-a", runs: [run({ runId: "a" })] }),
    );
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<link");
    expect(html).not.toContain("src=");
    expect(html).not.toContain("@import");
  });

  it("renders one SVG per metric per device/iOS group", () => {
    const trend = buildTrend({
      sceneId: "scene-a",
      runs: [
        run({
          runId: "a",
          deviceId: "device-1",
          osVersion: "27.0.1",
          startedAt: "2026-11-16T00:00:00.000Z",
          metrics: [metric("hitches", 10, "次"), metric("launchMs", 400, "ms")],
        }),
        run({
          runId: "b",
          deviceId: "device-2",
          osVersion: "27.0.1",
          startedAt: "2026-11-16T01:00:00.000Z",
          metrics: [metric("hitches", 12, "次"), metric("launchMs", 420, "ms")],
        }),
      ],
    });

    const html = renderTrendHtml(trend);
    expect((html.match(/<svg /g) ?? []).length).toBe(4);
    expect(html).toContain("设备 device-1 · iOS 27.0.1");
    expect(html).toContain("设备 device-2 · iOS 27.0.1");
    expect(html).toContain("状态：completed 1、partial 0");
  });

  it("keeps run id, value and status in every data point", () => {
    const html = renderTrendHtml(
      buildTrend({
        sceneId: "scene-a",
        runs: [
          run({
            runId: "run-1",
            status: "partial",
            gate: "unknown",
            startedAt: "2026-11-16T00:00:00.000Z",
            metrics: [metric("hitches", 11, "次")],
          }),
        ],
      }),
    );

    expect(html).toContain("<title>run-1");
    expect(html).toContain("hitches=11 次");
    expect(html).toContain("status=partial");
    expect(html).toContain("gate=unknown");
    expect(html).toContain("chart-dot-partial");
    expect(html).toContain("状态：completed 0、partial 1");
  });

  it("escapes scene, device and metric text", () => {
    const html = renderTrendHtml(
      buildTrend({
        sceneId: '</title><script>alert("x")</script>',
        runs: [
          run({
            runId: "a",
            deviceId: "device<&>",
            metrics: [metric("hit<ches", 1)],
          }),
        ],
      }),
    );

    expect(html).toContain("&lt;/title&gt;&lt;script&gt;");
    expect(html).toContain("device&lt;&amp;&gt;");
    expect(html).toContain("hit&lt;ches");
    expect(html).not.toContain("<script>alert");
  });

  it("renders single-point and flat series without NaN geometry", () => {
    const single = renderTrendHtml(
      buildTrend({ sceneId: "scene-a", runs: [run({ runId: "a" })] }),
    );
    expect(single).toContain("<circle");
    expect(single).not.toContain("NaN");

    const flat = renderTrendHtml(
      buildTrend({
        sceneId: "scene-a",
        runs: [
          run({
            runId: "a",
            startedAt: "2026-11-16T00:00:00.000Z",
            metrics: [metric("hitches", 7, "次")],
          }),
          run({
            runId: "b",
            startedAt: "2026-11-16T01:00:00.000Z",
            metrics: [metric("hitches", 7, "次")],
          }),
        ],
      }),
    );
    expect(flat).toContain("<polyline");
    expect(flat).not.toContain("NaN");
    expect(flat).not.toContain("Infinity");
  });

  it("is deterministic for identical input", () => {
    const trend = buildTrend({
      sceneId: "scene-a",
      runs: [
        run({ runId: "a", startedAt: "2026-11-16T00:00:00.000Z" }),
        run({ runId: "b", startedAt: "2026-11-16T01:00:00.000Z" }),
      ],
    });
    expect(renderTrendHtml(trend)).toBe(renderTrendHtml(trend));
  });

  it("uses the newest Take in the footer instead of the current time", () => {
    const html = renderTrendHtml(
      buildTrend({
        sceneId: "scene-a",
        runs: [
          run({ runId: "a", startedAt: "2026-11-16T00:00:00.000Z" }),
          run({ runId: "b", startedAt: "2026-11-17T08:30:00.000Z" }),
        ],
      }),
    );
    expect(html).toContain("最近一次 Take 2026-11-17T08:30:00.000Z");
  });

  it("picks the footer Take by parsed time, not string order", () => {
    const html = renderTrendHtml(
      buildTrend({
        sceneId: "scene-a",
        runs: [
          run({
            runId: "whole-second",
            deviceId: "device-1",
            startedAt: "2026-11-16T00:00:00Z",
          }),
          run({
            runId: "fraction",
            deviceId: "device-2",
            startedAt: "2026-11-16T00:00:00.500Z",
          }),
        ],
      }),
    );
    // "." sorts before "Z", so a lexicographic pick would report the earlier
    // whole-second Take as the newest.
    expect(html).toContain("最近一次 Take 2026-11-16T00:00:00.500Z");
  });

  it("says so when no Take qualifies", () => {
    const html = renderTrendHtml(
      buildTrend({
        sceneId: "scene-a",
        runs: [run({ runId: "a", status: "failed" })],
      }),
    );
    expect(html).toContain("没有可用于趋势的运行。");
    expect(html).toContain("排除（当前筛选）：invalid 0、failed 1");
    expect(html).toContain("最近一次 Take 未记录");
  });
});
