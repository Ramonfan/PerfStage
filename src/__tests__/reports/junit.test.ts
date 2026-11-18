import { describe, expect, it } from "vitest";
import { renderJUnitReport } from "../../reports/junit.js";
import type { JsonReport } from "../../reports/json.js";
import type { TestRun } from "../../model/test-run.js";
import type { TestPlan } from "../../model/test-plan.js";
import type { DiagnosticEvidence } from "../../diagnostics/normalize.js";

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
    actions: [],
    metrics: [],
    evidence: { screenshotPaths: [], traceArchivePaths: [] },
    lifecycle: [],
    ...overrides,
  };
}

const PLAN: TestPlan = {
  source: "scenario",
  app: { bundleId: "com.example.app", launchArguments: [], environmentVariables: {} },
  device: { id: "device-1" },
  preconditions: [],
  warmup: [],
  actions: [],
  metrics: [{ name: "hitches" }],
  repetitions: 1,
  createdAt: "2026-10-17T00:00:00.000Z",
};

const DIAGNOSTICS: DiagnosticEvidence = {
  startedAt: "2026-10-17T00:00:00.000Z",
  endedAt: "2026-10-17T00:01:00.000Z",
  logs: {
    lineCount: 0,
    status: "available",
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
  crashes: { status: "available", reports: [], before: [], after: [], newIds: [] },
  lifecycle: { status: "available", events: [] },
};

function makeReport(overrides: Partial<JsonReport> = {}): JsonReport {
  return {
    run: makeRun(),
    plan: PLAN,
    actions: [],
    metrics: [],
    diagnostics: DIAGNOSTICS,
    findings: [],
    status: "completed",
    gate: "pass",
    evidencePaths: {},
    generatedAt: "2026-10-17T00:02:00.000Z",
    ...overrides,
  };
}

function counts(xml: string): { tests: number; failures: number; skipped: number } {
  return {
    tests: (xml.match(/<testcase /g) ?? []).length,
    failures: (xml.match(/<failure /g) ?? []).length,
    skipped: (xml.match(/<skipped /g) ?? []).length,
  };
}

describe("renderJUnitReport", () => {
  it("emits a well-formed testsuites document with a suite per Take", () => {
    const xml = renderJUnitReport(makeReport());
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain("<testsuites ");
    expect(xml).toContain('<testsuite name="PerfStage run-1"');
    expect(xml.trimEnd().endsWith("</testsuites>")).toBe(true);
    expect(xml).toContain('time="60.000"');
  });

  it("maps failed metrics and gate to failures with consistent counts", () => {
    const xml = renderJUnitReport(
      makeReport({
        metrics: [
          { name: "hitches", value: 120, unit: "次", verdict: "fail" },
          { name: "blockMs", value: 40, unit: "ms", verdict: "pass" },
        ],
        gate: "fail",
        findings: [
          {
            code: "metric:hitches",
            severity: "failure",
            message: "指标 hitches 未通过阈值。",
          },
        ],
      }),
    );

    expect(xml).toContain('<testcase name="metric:hitches"');
    expect(xml).toContain('name="gate"');
    expect(xml).toContain('<failure message="指标 hitches 未通过阈值');

    const actual = counts(xml);
    expect(actual.tests).toBe(5);
    expect(actual.failures).toBe(3);
    expect(actual.skipped).toBe(0);
    expect(xml).toContain(
      `tests="${actual.tests}" failures="${actual.failures}" skipped="${actual.skipped}"`,
    );
  });

  it("marks an untrustworthy Take as a failure and an unknown gate as skipped", () => {
    const xml = renderJUnitReport(
      makeReport({
        run: makeRun({ status: "partial" }),
        status: "partial",
        gate: "unknown",
      }),
    );

    expect(xml).toContain('<testcase name="run-status"');
    expect(xml).toContain("运行状态为 partial");
    expect(xml).toContain('<skipped message="门禁无法评估');

    const actual = counts(xml);
    expect(actual.tests).toBe(2);
    expect(actual.failures).toBe(1);
    expect(actual.skipped).toBe(1);
  });

  it("keeps warning findings green but records their message", () => {
    const xml = renderJUnitReport(
      makeReport({
        findings: [
          {
            code: "log-truncated",
            severity: "warning",
            message: "设备日志流在 Take 结束前中断。",
          },
        ],
      }),
    );

    expect(xml).toContain('<testcase name="finding:log-truncated"');
    expect(xml).not.toMatch(
      /<testcase name="finding:log-truncated"[^>]*>\s*<failure/,
    );
    expect(xml).toContain("设备日志流在 Take 结束前中断。");
    expect(counts(xml).failures).toBe(0);
  });

  it("escapes XML special characters and drops illegal control characters", () => {
    const xml = renderJUnitReport(
      makeReport({
        metrics: [
          { name: 'a<b&c"d\'', value: 1, unit: "次", verdict: "pass" },
        ],
        findings: [
          {
            code: "weird",
            severity: "failure",
            message: `before\u0000after <tag> & "quoted"`,
          },
        ],
      }),
    );

    expect(xml).toContain("a&lt;b&amp;c&quot;d&apos;");
    expect(xml).toContain("beforeafter &lt;tag&gt; &amp; &quot;quoted&quot;");
    expect(xml).not.toContain("\u0000");
    expect(xml).not.toContain("undefined");
    expect(xml).not.toContain("null");
  });

  it("skips metrics without a usable verdict or value", () => {
    const xml = renderJUnitReport(
      makeReport({
        metrics: [
          { name: "unknown-metric", value: 1, unit: "次", verdict: "unknown" },
          { name: "skipped-metric", value: 2, unit: "次", verdict: "skipped" },
          { name: "missing-value", value: undefined, unit: "ms" },
        ],
      }),
    );

    expect(counts(xml).skipped).toBe(3);
    expect(counts(xml).failures).toBe(0);
    expect(xml).toContain('<skipped message="指标 unknown-metric 未产生可用判定"');
  });

  it("keeps a warn gate green but explains it", () => {
    const xml = renderJUnitReport(makeReport({ gate: "warn" }));
    expect(xml).toContain(
      '<testcase name="gate" classname="gate"><system-out>gate=warn',
    );
    expect(counts(xml).failures).toBe(0);
  });

  it("treats a missing gate as skipped instead of green", () => {
    const xml = renderJUnitReport(
      makeReport({ gate: undefined as unknown as JsonReport["gate"] }),
    );
    expect(xml).toContain(
      '<testcase name="gate" classname="gate"><skipped message="门禁无法评估',
    );
    expect(counts(xml).skipped).toBe(1);
    expect(counts(xml).failures).toBe(0);
  });

  it("treats an unrecognised gate value as skipped instead of green", () => {
    const xml = renderJUnitReport(
      makeReport({ gate: "PASS" as unknown as JsonReport["gate"] }),
    );
    expect(xml).toContain(
      '<testcase name="gate" classname="gate"><skipped message="门禁无法评估',
    );
    expect(counts(xml).skipped).toBe(1);
  });

  it("renders an explicit null metric value as unknown", () => {
    const xml = renderJUnitReport(
      makeReport({
        metrics: [
          { name: "hitches", value: null, unit: "次", verdict: "skipped" },
        ],
      }),
    );
    expect(xml).toContain("数值：未知");
    expect(xml).not.toContain("null");
    expect(counts(xml).skipped).toBe(1);
  });

  it("omits the duration when the end time is unknown", () => {
    const xml = renderJUnitReport(
      makeReport({ run: makeRun({ endedAt: null }) }),
    );
    expect(xml).not.toContain(" time=");
  });
});
