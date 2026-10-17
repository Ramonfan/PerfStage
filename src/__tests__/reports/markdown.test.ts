import { describe, expect, it } from "vitest";
import { buildJsonReport } from "../../reports/json.js";
import { renderMarkdownReport } from "../../reports/markdown.js";
import {
  normalizeDiagnostics,
  type DiagnosticEvidence,
} from "../../diagnostics/normalize.js";
import type {
  ActionRecord,
  MetricResult,
  TestRun,
} from "../../model/test-run.js";

function buildRun(overrides: Partial<TestRun> = {}): TestRun {
  return {
    id: "run-2026-10-17-001",
    planId: "plan-baseline",
    status: "completed",
    startedAt: "2026-10-17T00:00:00.000Z",
    endedAt: "2026-10-17T00:01:00.000Z",
    durationMs: 60000,
    repetitions: 1,
    currentRepetition: 0,
    actions: [],
    metrics: [],
    evidence: {
      deviceLogPath: "logs/device.log",
      crashReportPath: "crashes/run.ips",
      screenshotPaths: ["screenshots/01.png"],
      traceArchivePaths: ["traces/startup.trace"],
    },
    lifecycle: [],
    ...overrides,
  };
}

function diagnosticsFor(
  run: TestRun,
  input: Parameters<typeof normalizeDiagnostics>[0] = {},
): DiagnosticEvidence {
  return normalizeDiagnostics(input, run.startedAt, run.endedAt ?? run.startedAt);
}

describe("buildJsonReport (public 2-argument signature)", () => {
  it("uses the brief's exact two-argument signature", () => {
    // Compile-time guard: if anyone accidentally re-adds a required third
    // argument, the call below stops compiling.
    const fn: (
      run: TestRun,
      diagnostics: DiagnosticEvidence,
    ) => ReturnType<typeof buildJsonReport> = buildJsonReport;
    expect(fn.length).toBe(2);
    const run = buildRun();
    const diagnostics = diagnosticsFor(run);
    expect(fn(run, diagnostics)).toBeDefined();
  });

  it("preserves an unknown metric payload under metrics[].raw", () => {
    const metric: MetricResult = {
      name: "experimental_gpu_spike",
      value: { count: 3, frames: [1, 5, 9] },
      verdict: "pass",
      customInstrument: "metal-frame-collector",
      experimentalField: "should survive",
    } as unknown as MetricResult;
    const run = buildRun({ metrics: [metric] });
    const report = buildJsonReport(run, diagnosticsFor(run));

    expect(report.metrics).toHaveLength(1);
    expect(report.metrics[0]?.raw).toMatchObject({
      name: "experimental_gpu_spike",
      customInstrument: "metal-frame-collector",
      experimentalField: "should survive",
    });
    expect(report.metrics[0]?.verdict).toBe("pass");
  });

  it("classifies swipe action phases into drag, wait, and unknown when needed", () => {
    const dragAction: ActionRecord = {
      actionId: "swipe-1",
      action: {
        id: "swipe-1",
        type: "swipe",
        direction: "up",
        distance: 500,
        durationMs: 200,
        waitAfterMs: 500,
      },
      outcome: "executed",
      attempts: 1,
      startedAt: "2026-10-17T00:00:00.000Z",
      endedAt: "2026-10-17T00:00:00.700Z",
    };
    const tapAction: ActionRecord = {
      actionId: "tap-1",
      action: {
        id: "tap-1",
        type: "tap",
        target: "button",
        waitAfterMs: 250,
      },
      outcome: "executed",
      attempts: 1,
      startedAt: "2026-10-17T00:00:01.000Z",
      endedAt: "2026-10-17T00:00:01.250Z",
    };
    const unknownAction: ActionRecord = {
      actionId: "missing-1",
      action: {
        id: "missing-1",
        type: "wait",
        durationMs: 100,
      },
      outcome: "skipped",
      attempts: 0,
      startedAt: "2026-10-17T00:00:02.000Z",
      endedAt: null,
    };
    const run = buildRun({
      actions: [dragAction, tapAction, unknownAction],
    });
    const report = buildJsonReport(run, diagnosticsFor(run));

    const phases = (id: string) =>
      report.actions.find((entry) => entry.actionId === id)?.phases ?? [];

    expect(phases("swipe-1").map((p) => p.phase)).toEqual(["drag", "wait"]);
    expect(phases("swipe-1")[0]?.startedAt).toBe("2026-10-17T00:00:00.000Z");
    expect(phases("swipe-1")[0]?.endedAt).toBe("2026-10-17T00:00:00.200Z");
    expect(phases("swipe-1")[1]?.endedAt).toBe("2026-10-17T00:00:00.700Z");
    expect(phases("tap-1").map((p) => p.phase)).toEqual(["wait"]);
    expect(phases("missing-1")).toEqual([
      {
        phase: "unknown",
        startedAt: "2026-10-17T00:00:02.000Z",
        endedAt: "unknown",
      },
    ]);
  });

  it("derives failed status when new Crash diagnostics are present", () => {
    const run = buildRun({ status: "completed" });
    const diagnostics = diagnosticsFor(run, {
      crashIdsBefore: [],
      crashIdsAfter: ["c-1"],
      crashReports: [{ id: "c-1" }],
    });
    const report = buildJsonReport(run, diagnostics);
    expect(report.status).toBe("failed");
    expect(report.downgradedFromCompleted).toBe(true);
  });

  it("derives partial status from metric failures via the run's verdict field", () => {
    const run = buildRun({
      metrics: [
        {
          name: "hitches",
          value: 12,
          verdict: "fail",
          measuredAt: "2026-10-17T00:00:30.000Z",
        },
      ],
    });
    const report = buildJsonReport(run, diagnosticsFor(run));
    expect(report.status).toBe("partial");
    expect(
      report.findings.some((f) => f.code === "metric:hitches"),
    ).toBe(true);
  });

  it("derives partial status and a missing trace finding when archives are absent", () => {
    const run = buildRun({
      metrics: [
        {
          name: "startup_time",
          value: 1200,
          verdict: "pass",
          measuredAt: "2026-10-17T00:00:05.000Z",
        },
      ],
      evidence: {
        deviceLogPath: "logs/device.log",
        crashReportPath: undefined,
        screenshotPaths: [],
        traceArchivePaths: [],
      },
    });
    const report = buildJsonReport(run, diagnosticsFor(run));
    expect(report.status).toBe("partial");
    expect(
      report.findings.some((f) => f.code === "missing:trace_archive"),
    ).toBe(true);
  });

  it("returns completed when the run and diagnostics are both clean", () => {
    const run = buildRun();
    const diagnostics = diagnosticsFor(run, {
      logText: "everything is fine",
    });
    const report = buildJsonReport(run, diagnostics);
    expect(report.status).toBe("completed");
    expect(report.downgradedFromCompleted).toBe(false);
    expect(report.findings).toEqual([]);
  });
});

describe("renderMarkdownReport", () => {
  it("renders sections in the required order and exposes all evidence", () => {
    const run = buildRun();
    const diagnostics = diagnosticsFor(run, {
      logText: "everything is fine",
    });
    const report = buildJsonReport(run, diagnostics);
    const markdown = renderMarkdownReport(report);

    const order: string[] = [
      "总结",
      "测试计划",
      "动作时间线",
      "性能指标",
      "稳定性诊断",
      "证据文件",
      "限制与未知项",
    ];
    let cursor = 0;
    for (const heading of order) {
      const idx = markdown.indexOf(heading);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeGreaterThanOrEqual(cursor);
      cursor = idx;
    }
    expect(markdown).toContain("logs/device.log");
    expect(markdown).toContain("traces/startup.trace");
    expect(markdown).toContain("run-2026-10-17-001");
  });

  it("uses the explicit phrase when crash detection is unavailable", () => {
    const run = buildRun({ status: "completed" });
    const diagnostics = diagnosticsFor(run, {
      crashQueryError: "device disconnected",
    });
    const report = buildJsonReport(run, diagnostics);
    const markdown = renderMarkdownReport(report);
    expect(markdown).toContain("未能读取 Crash 列表，不能据此证明没有崩溃");
    expect(markdown).toContain("Crash 差异");
  });

  it("lists logs, Crash diff, lifecycle, categories, and downgrade in stability section", () => {
    const run = buildRun({
      actions: [
        {
          actionId: "swipe-1",
          action: {
            id: "swipe-1",
            type: "swipe",
            direction: "down",
            distance: 800,
            durationMs: 150,
            waitAfterMs: 500,
          },
          outcome: "executed",
          attempts: 1,
          startedAt: "2026-10-17T00:00:00.000Z",
          endedAt: "2026-10-17T00:00:00.650Z",
        },
      ],
      status: "completed",
    });
    const diagnostics = diagnosticsFor(run, {
      logText: "jetsam killing process 42",
      crashIdsBefore: [],
      crashIdsAfter: ["c-1"],
      crashReports: [{ id: "c-1", process: "Demo", exceptionType: "EXC_BAD" }],
      lifecycle: [
        {
          kind: "foreground",
          occurredAt: "2026-10-17T00:00:05.000Z",
        },
      ],
    });
    const report = buildJsonReport(run, diagnostics);
    const markdown = renderMarkdownReport(report);
    const stability = markdown.slice(markdown.indexOf("稳定性诊断"));
    expect(stability).toContain("日志");
    expect(stability).toContain("Crash 差异");
    expect(stability).toContain("生命周期事件");
    expect(stability).toContain("识别出的类别");
    expect(stability).toContain("Jetsam");
    expect(stability).toMatch(/状态评定/);
    expect(stability).toMatch(/从[“"]已完成[”"]状态降级|最终被降级/);
  });

  it("marks missing phase timestamps as unknown rather than fabricating durations", () => {
    const run = buildRun({
      actions: [
        {
          actionId: "open",
          action: { id: "open", type: "tap", target: "x", waitAfterMs: 100 },
          outcome: "timeout",
          attempts: 2,
          startedAt: "2026-10-17T00:00:00.000Z",
          endedAt: null,
        },
      ],
      status: "failed",
    });
    const report = buildJsonReport(run, diagnosticsFor(run));
    const markdown = renderMarkdownReport(report);
    expect(markdown).toMatch(/起止时间未知/);
    expect(markdown).not.toMatch(/0ms\s*→\s*100ms/);
  });
});