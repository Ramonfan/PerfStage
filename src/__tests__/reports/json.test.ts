import { describe, expect, it } from "vitest";
import { buildJsonReport } from "../../reports/json.js";
import type { TestRun } from "../../model/test-run.js";
import type { DiagnosticEvidence } from "../../diagnostics/normalize.js";

function makeRun(): TestRun {
  return {
    id: "run-1",
    planId: "plan-1",
    status: "completed",
    startedAt: "2026-11-13T00:00:00.000Z",
    endedAt: "2026-11-13T00:03:00.000Z",
    durationMs: 180000,
    repetitions: 1,
    currentRepetition: 1,
    actions: [],
    metrics: [],
    evidence: {
      deviceLogPath: "device.log",
      screenshotPaths: [],
      traceArchivePaths: [],
    },
    lifecycle: [],
  };
}

function makeDiagnostics(): DiagnosticEvidence {
  return {
    startedAt: "2026-11-13T00:00:00.000Z",
    endedAt: "2026-11-13T00:03:00.000Z",
    logs: {
      path: "device.log",
      text: "a very long device log line\n".repeat(1000),
      lineCount: 1000,
      status: "available",
      filters: {},
      categories: {
        errorOrFault: false,
        watchdog: false,
        memoryWarning: false,
        jetsam: false,
        uikitOrCoreAnimation: null,
        reactNativeOrJSC: null,
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
    lifecycle: {
      status: "available",
      events: [],
    },
  };
}

describe("buildJsonReport", () => {
  it("does not inline device log text that already lives in device.log", () => {
    const report = buildJsonReport(makeRun(), makeDiagnostics());
    expect(report.diagnostics.logs.text).toBeUndefined();
    expect(report.diagnostics.logs.path).toBe("device.log");
    expect(report.diagnostics.logs.lineCount).toBe(1000);
    expect(JSON.stringify(report).length).toBeLessThan(10_000);
  });

  it("keeps inline log text when there is no file to point at", () => {
    const diagnostics = makeDiagnostics();
    const report = buildJsonReport(makeRun(), {
      ...diagnostics,
      logs: { ...diagnostics.logs, path: undefined },
    });
    expect(report.diagnostics.logs.text).toContain("device log line");
  });
});
