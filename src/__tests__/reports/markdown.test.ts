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
    repetitions: 1,
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
    gate: "pass",
    evidencePaths: { deviceLog: "logs/device.log" },
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
      "## 执行记录",
      "## 录制配置",
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

  it("renders runner notes so the measurement window is part of the report", () => {
    const md = renderMarkdownReport(
      makeReport({
        run: makeRun({
          notes:
            "hitches window 5951–13443ms of the trace | hitches analysis: No frames between 9000ms and 10000ms",
        }),
      }),
    );
    expect(md).toContain("## 执行记录");
    // The window and the analyzer warning are evidence: without them a low
    // count is indistinguishable from a window that missed the interaction.
    expect(md).toContain("hitches window 5951–13443ms");
    expect(md).toContain("No frames between 9000ms and 10000ms");
  });

  it("says so when there are no runner notes", () => {
    const md = renderMarkdownReport(makeReport({ run: makeRun({ notes: undefined }) }));
    expect(md).toContain("无执行备注");
  });

  it("never invents a recording config for a run that predates the field", () => {
    const md = renderMarkdownReport(
      makeReport({
        run: makeRun({
          passes: [
            {
              template: "hitches",
              tracePath: "traces/hitches.trace",
              attempts: 1,
              durationMs: 26_000,
              metrics: ["hitches", "blockMs"],
              errorCount: 0,
              warningCount: 0,
            },
          ],
        }),
      }),
    );

    expect(md).toContain("未记录录制配置");
    // A missing window must not be rendered as `undefined`.
    expect(md).not.toContain("undefined");
    expect(md).not.toContain("profile `");
  });

  it("renders a missing window as 未记录 instead of undefined", () => {
    const md = renderMarkdownReport(
      makeReport({
        run: makeRun({
          passes: [
            {
              template: "hitches",
              tracePath: "traces/hitches.trace",
              attempts: 1,
              durationMs: 26_000,
              metrics: ["hitches"],
              errorCount: 0,
              warningCount: 0,
              // A run written before `window` was persisted.
              recording: {
                profile: "full",
                template: "Animation Hitches",
                timeLimit: "40s",
              },
            },
          ],
        }),
      }),
    );

    expect(md).toContain("窗口 `未记录`");
    expect(md).not.toContain("undefined");
  });

  it("marks a compact pass and the diagnostics it did not record", () => {
    const md = renderMarkdownReport(
      makeReport({
        run: makeRun({
          passes: [
            {
              template: "hitches",
              tracePath: "traces/hitches.trace",
              attempts: 1,
              durationMs: 26_000,
              metrics: ["hitches", "blockMs"],
              errorCount: 0,
              warningCount: 0,
              recording: {
                profile: "compact",
                template: "Blank",
                instruments: ["Hitches"],
                timeLimit: "40s",
                duringTimeoutMs: 30_000,
                liveTimeoutMs: 30_000,
                window: "full-session",
                missingDiagnostics: ["Time Profiler（time-profile）"],
              },
            },
            {
              template: "launch",
              tracePath: "traces/launch.trace",
              attempts: 1,
              durationMs: 12_000,
              metrics: ["launchMs"],
              errorCount: 0,
              warningCount: 0,
              recording: {
                profile: "full",
                template: "App Launch",
                timeLimit: "12s",
                liveTimeoutMs: 90_000,
                window: "full-session",
              },
            },
          ],
        }),
      }),
    );

    expect(md).toContain("## 录制配置");
    expect(md).toContain("profile `compact`");
    expect(md).toContain("Time Profiler（time-profile）");
    // A human reader must not mistake the compact trace for a full one.
    expect(md).toContain("不是完整诊断 trace");
    expect(md).not.toContain("未发现额外限制");
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
