import { describe, expect, it } from "vitest";
import { renderHtmlReport } from "../../reports/html.js";
import type { JsonReport } from "../../reports/json.js";
import type { TestRun } from "../../model/test-run.js";
import type { TestPlan } from "../../model/test-plan.js";
import type { DiagnosticEvidence } from "../../diagnostics/normalize.js";

function makePlan(overrides: Partial<TestPlan> = {}): TestPlan {
  return {
    source: "scenario",
    app: { bundleId: "com.example.app", launchArguments: [], environmentVariables: {} },
    device: { id: "device-1" },
    preconditions: [],
    warmup: [],
    actions: [],
    metrics: [{ name: "hitches" }],
    repetitions: 1,
    createdAt: "2026-10-17T00:00:00.000Z",
    notes: "no notes",
    ...overrides,
  };
}

function makeRun(overrides: Partial<TestRun> = {}): TestRun {
  return {
    id: "run-1",
    planId: "plan-1",
    status: "completed",
    startedAt: "2026-10-17T00:00:00.000Z",
    endedAt: "2026-10-17T00:01:00.000Z",
    durationMs: 60000,
    repetitions: 1,
    currentRepetition: 0,
    actions: [
      {
        actionId: "scroll-up",
        outcome: "executed",
        attempts: 1,
        startedAt: "2026-10-17T00:00:10.000Z",
        endedAt: "2026-10-17T00:00:11.000Z",
        durationMs: 1000,
      },
    ],
    metrics: [],
    evidence: { screenshotPaths: [], traceArchivePaths: [] },
    lifecycle: [],
    notes: "hitches window 1000-2000ms | analyzer ok",
    ...overrides,
  };
}

function makeDiagnostics(
  overrides: Partial<DiagnosticEvidence> = {},
): DiagnosticEvidence {
  return {
    startedAt: "2026-10-17T00:00:00.000Z",
    endedAt: "2026-10-17T00:01:00.000Z",
    logs: {
      path: "logs/device.log",
      lineCount: 12,
      status: "available",
      categories: {
        errorOrFault: false,
        watchdog: null,
        memoryWarning: false,
        jetsam: false,
        uikitOrCoreAnimation: true,
        reactNativeOrJSC: false,
        imageNetworkUrl: null,
      },
    },
    crashes: {
      status: "available",
      reports: [],
      before: [],
      after: [],
      newIds: [],
    },
    lifecycle: { status: "available", events: [] },
    ...overrides,
  };
}

function makeReport(overrides: Partial<JsonReport> = {}): JsonReport {
  return {
    run: makeRun(),
    plan: makePlan(),
    actions: [
      {
        actionId: "scroll-up",
        outcome: "executed",
        attempts: 1,
        startedAt: "2026-10-17T00:00:10.000Z",
        endedAt: "2026-10-17T00:00:11.000Z",
        durationMs: 1000,
      },
    ],
    metrics: [
      { name: "hitches", value: 2, unit: "次", verdict: "pass" },
      { name: "launchMs", value: 320.5, unit: "ms", verdict: "warn" },
    ],
    diagnostics: makeDiagnostics(),
    findings: [
      { code: "metric:memoryMB", severity: "failure", message: "指标 memoryMB 未通过阈值。" },
    ],
    status: "completed",
    gate: "fail",
    evidencePaths: { deviceLog: "logs/device.log" },
    generatedAt: "2026-10-17T00:02:00.000Z",
    ...overrides,
  };
}

describe("renderHtmlReport", () => {
  it("renders the report sections in the Markdown order", () => {
    const html = renderHtmlReport(makeReport());
    const headings = [
      "总结",
      "测试计划",
      "动作时间线",
      "性能指标",
      "执行记录",
      "录制配置",
      "稳定性诊断",
      "证据文件",
      "限制与未知项",
      "发现项",
    ].map((heading) => `<h2>${heading}</h2>`);

    const positions = headings.map((heading) => html.indexOf(heading));
    for (const [index, position] of positions.entries()) {
      expect(position, `section ${headings[index]} missing`).toBeGreaterThan(-1);
      if (index > 0) {
        expect(position).toBeGreaterThan(positions[index - 1]!);
      }
    }
  });

  it("is a standalone offline document", () => {
    const html = renderHtmlReport(makeReport());
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<link");
    expect(html).not.toContain("src=");
    expect(html).not.toContain("@import");
  });

  it("escapes run data instead of interpreting it as markup", () => {
    const hostile = '</td><script>alert("x")</script>';
    const html = renderHtmlReport(
      makeReport({ plan: makePlan({ notes: hostile }) }),
    );
    expect(html).toContain("&lt;/td&gt;&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain('</td><script>');
  });

  it("renders legacy reports without a plan or end time", () => {
    const html = renderHtmlReport(
      makeReport({
        plan: null,
        run: makeRun({ endedAt: null, passes: undefined, notes: undefined }),
        metrics: [],
        findings: [],
        diagnostics: undefined as unknown as DiagnosticEvidence,
      }),
    );
    expect(html).toContain("详细方案未在本次报告中提供（未记录）");
    expect(html).toContain("未知");
    expect(html).toContain("未记录 pass 信息");
    expect(html).toContain("未记录设备日志证据");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("null");
  });

  it("renders explicit null values as unknown instead of the literal null", () => {
    const baseDiagnostics = makeDiagnostics();
    const html = renderHtmlReport(
      makeReport({
        metrics: [
          { name: "hitches", value: null, unit: "次", verdict: "unknown" },
        ],
        run: makeRun({ endedAt: null }),
        actions: [
          {
            actionId: "scroll-up",
            outcome: "executed",
            attempts: 1,
            startedAt: "2026-10-17T00:00:10.000Z",
            endedAt: null,
            durationMs: null as unknown as number | undefined,
          },
        ],
        diagnostics: {
          ...baseDiagnostics,
          logs: {
            ...baseDiagnostics.logs,
            lineCount: null as unknown as number,
          },
        },
        evidencePaths: { deviceLog: null as unknown as string },
      }),
    );
    expect(html).not.toContain("null");
    expect(html).not.toContain("undefined");
    expect(html).toContain("<td>未知</td>");
    expect(html).toContain("日志共 未记录 行");
    expect(html).toContain("deviceLog: 未记录");
  });

  it("labels findings by severity", () => {
    const html = renderHtmlReport(makeReport());
    expect(html).toContain("[失败] metric:memoryMB");
  });

  it("shows unknown log categories instead of claiming no hit", () => {
    const html = renderHtmlReport(makeReport());
    expect(html).toContain("未知（无法读取日志）");
  });
});
