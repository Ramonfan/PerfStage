import { describe, expect, it } from "vitest";
import { renderMarkdownReport } from "../../reports/markdown.js";
import type { JsonReport } from "../../reports/json.js";
import type { TestRun } from "../../model/test-run.js";
import type { TestPlan } from "../../model/test-plan.js";
import type { DiagnosticEvidence } from "../../diagnostics/normalize.js";

function makePlan(): TestPlan {
  return {
    source: "scenario",
    app: { bundleId: "com.nndev.im", launchArguments: [], environmentVariables: {} },
    device: { id: "device-1" },
    execution: "interactive",
    preconditions: [],
    warmup: [],
    actions: [
      {
        id: "scroll-up",
        type: "swipe",
        direction: "up",
        distance: 700,
        durationMs: 500,
        waitAfterMs: 1500,
      },
    ],
    metrics: [{ name: "hitches" }, { name: "cpu" }, { name: "memory" }],
    analysisFocus: ["jank"],
    repetitions: 1,
    diagnostics: {
      collectDeviceLogs: true,
      collectCrashes: true,
      lifecycleSampling: true,
      includedLogSubsystems: [],
      includedLogCategories: [],
      excludedLogSubsystems: [],
      networkCapture: false,
      screenshotOnFailure: true,
    },
    createdAt: "2026-10-17T00:00:00.000Z",
    notes: "no notes",
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
    metrics: [
      {
        name: "hitches",
        value: 2,
        unit: "count",
        verdict: "pass",
        measuredAt: "2026-10-17T00:01:00.000Z",
      },
    ],
    evidence: {
      deviceLogPath: "logs/device.log",
      screenshotPaths: [],
      traceArchivePaths: ["traces/hitches.trace"],
    },
    lifecycle: [],
    ...overrides,
  };
}

function makeDiagnostics(overrides: Partial<DiagnosticEvidence> = {}): DiagnosticEvidence {
  return {
    startedAt: "2026-10-17T00:00:00.000Z",
    endedAt: "2026-10-17T00:01:00.000Z",
    logs: {
      path: "logs/device.log",
      text: "all quiet on the western front\nno issues\n",
      lineCount: 2,
      status: "available",
      filters: {},
      categories: {
        errorOrFault: false,
        watchdog: false,
        memoryWarning: false,
        jetsam: false,
        uikitOrCoreAnimation: false,
        reactNativeOrJSC: false,
        imageNetworkUrl: false,
      },
    },
    crashes: {
      status: "available",
      reports: [],
      before: [],
      after: [],
      newIds: [],
    },
    lifecycle: {
      status: "available",
      events: [],
    },
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
      {
        name: "hitches",
        value: 2,
        unit: "count",
        verdict: "pass",
        measuredAt: "2026-10-17T00:01:00.000Z",
      },
    ],
    diagnostics: makeDiagnostics(),
    findings: [],
    status: "completed",
    evidencePaths: [{ kind: "deviceLog", relativePath: "logs/device.log" }],
    generatedAt: "2026-10-17T00:02:00.000Z",
    ...overrides,
  };
}

describe("renderMarkdownReport", () => {
  it("renders the required section headers in order", () => {
    const md = renderMarkdownReport(makeReport());
    const headers = [
      "## 总结",
      "## 测试计划",
      "## 动作时间线",
      "## 性能指标",
      "## 稳定性诊断",
      "## 证据文件",
      "## 限制与未知项",
    ];
    const positions = headers.map((header) => md.indexOf(header));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // Every header must be present, even when overridden.
    for (const header of headers) {
      expect(md).toContain(header);
    }
  });

  it("includes a 'unknown' (未知) time when endedAt is unknown", () => {
    const md = renderMarkdownReport(makeReport({ status: "invalid" }));
    expect(md).toContain("未知");
    expect(md).toContain("结束时间");
  });

  it("includes the unavailability caveat when crash listing is unavailable", () => {
    const md = renderMarkdownReport(
      makeReport({
        diagnostics: makeDiagnostics({
          crashes: {
            status: "unavailable",
            error: "device disconnected",
            reports: [],
            before: [],
            after: [],
            newIds: [],
          },
        }),
      }),
    );
    expect(md).toContain("未能读取 Crash 列表");
  });

  it("lists new crashes in the stability section", () => {
    const md = renderMarkdownReport(
      makeReport({
        diagnostics: makeDiagnostics({
          crashes: {
            status: "available",
            reports: [{ id: "new-crash-1" }],
            before: [],
            after: ["new-crash-1"],
            newIds: ["new-crash-1"],
          },
        }),
        findings: [
          {
            code: "status-downgrade",
            severity: "warning",
            message: "diagnostics detected stability impact",
          },
        ],
      }),
    );
    expect(md).toContain("new-crash-1");
    expect(md).toContain("status-downgrade");
  });

  it("marks logs status as unknown when log query failed", () => {
    const md = renderMarkdownReport(
      makeReport({
        diagnostics: makeDiagnostics({
          logs: {
            status: "unavailable",
            error: "log file missing",
            lineCount: 0,
            categories: {
              errorOrFault: null,
              watchdog: null,
              memoryWarning: null,
              jetsam: null,
              uikitOrCoreAnimation: null,
              reactNativeOrJSC: null,
              imageNetworkUrl: null,
            },
          },
        }),
      }),
    );
    expect(md).toContain("未能读取设备日志");
  });

  it("renders metrics with their units and verdicts", () => {
    const md = renderMarkdownReport(makeReport());
    expect(md).toContain("hitches（count）：2（pass）");
  });
});
