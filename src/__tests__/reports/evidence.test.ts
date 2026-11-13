import { describe, expect, it } from "vitest";
import { evaluateMetricEvidence } from "../../reports/evidence.js";
import { testPlanSchema, type MetricRequest } from "../../model/test-plan.js";
import type { MetricResult } from "../../model/test-run.js";

function makePlan(metrics: MetricRequest[]) {
  return testPlanSchema.parse({
    source: "ad_hoc",
    app: { bundleId: "com.example.app" },
    device: { id: "device-1" },
    actions: [{ id: "a", type: "wait", durationMs: 1 }],
    metrics,
  });
}

const TRACE = "traces/metric.trace";

describe("evaluateMetricEvidence", () => {
  it("reports a missing metric", () => {
    const evaluation = evaluateMetricEvidence(
      makePlan([{ name: "hitches" }, { name: "cpu", instrument: "Time Profiler" }]),
      [{ name: "hitches", value: 2, tracePath: TRACE }],
    );
    expect(evaluation.gaps).toEqual([
      expect.objectContaining({
        kind: "missing-metric",
        code: "metric:cpu",
        metric: "cpu",
      }),
    ]);
    expect(evaluation.gate).toBe("unknown");
  });

  it("reports a missing value", () => {
    const evaluation = evaluateMetricEvidence(
      makePlan([{ name: "cpu", instrument: "Time Profiler" }]),
      [{ name: "cpu", tracePath: TRACE }],
    );
    expect(evaluation.gaps.map((gap) => gap.code)).toContain("value:cpu");
  });

  it("reports a missing trace for an instrument-backed metric", () => {
    const evaluation = evaluateMetricEvidence(
      makePlan([{ name: "hitches", instrument: "Animation Hitches" }]),
      [{ name: "hitches", value: 2 }],
    );
    expect(evaluation.gaps.map((gap) => gap.code)).toContain("trace:hitches");
  });

  it("requires a trace for canonical MVP metrics even without a plan instrument", () => {
    const evaluation = evaluateMetricEvidence(
      makePlan([{ name: "memoryMB" }]),
      [{ name: "memoryMB", value: 113.5 }],
    );
    expect(evaluation.gaps.map((gap) => gap.code)).toContain("trace:memoryMB");
  });

  it("accepts a complete metric", () => {
    const evaluation = evaluateMetricEvidence(
      makePlan([{ name: "hitches", instrument: "Animation Hitches" }]),
      [{ name: "hitches", value: 2, verdict: "pass", tracePath: TRACE }],
    );
    expect(evaluation.gaps).toEqual([]);
    expect(evaluation.gate).toBe("pass");
  });

  it("does not require a trace for an explicitly skipped metric", () => {
    const evaluation = evaluateMetricEvidence(
      makePlan([{ name: "hitches", instrument: "Animation Hitches" }]),
      [{ name: "hitches", verdict: "skipped" }],
    );
    expect(evaluation.gaps).toEqual([]);
    expect(evaluation.gate).toBe("unknown");
  });

  it("matches aliases so memory and memoryMB are the same metric", () => {
    const evaluation = evaluateMetricEvidence(
      makePlan([{ name: "memory", instrument: "Activity Monitor" }]),
      [{ name: "memoryMB", value: 113.5, verdict: "pass", tracePath: TRACE }],
    );
    expect(evaluation.gaps).toEqual([]);
    expect(evaluation.gate).toBe("pass");
  });

  it("requires a trace for supplied metrics that the plan omitted", () => {
    const evaluation = evaluateMetricEvidence(
      makePlan([{ name: "hitches" }]),
      [
        { name: "hitches", value: 1, tracePath: TRACE },
        { name: "memory", value: 100 },
      ],
    );
    expect(evaluation.gaps.map((gap) => gap.code)).toContain("trace:memoryMB");
  });

  it("derives the gate from thresholds when evidence is complete", () => {
    const evaluation = evaluateMetricEvidence(
      makePlan([
        { name: "hitches", instrument: "Animation Hitches", threshold: { warn: 3, fail: 5 } },
        { name: "memoryMB", instrument: "Activity Monitor", threshold: { warn: 200 } },
      ]),
      [
        { name: "hitches", value: 7, tracePath: TRACE },
        { name: "memoryMB", value: 100, tracePath: TRACE },
      ] as MetricResult[],
    );
    expect(evaluation.gaps).toEqual([]);
    expect(evaluation.verdicts).toEqual(["fail", "pass"]);
    expect(evaluation.gate).toBe("fail");
  });
});
