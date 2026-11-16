import { describe, expect, it } from "vitest";
import {
  evaluateRegression,
  type RegressionInput,
} from "../../analysis/regression.js";
import type { MetricComparison } from "../../analysis/compare.js";

function comparison(
  overrides: Partial<MetricComparison> & { name: string },
): MetricComparison {
  return {
    unit: "ms",
    current: 110,
    baselineMedian: 100,
    delta: 10,
    deltaPercent: 10,
    direction: "increase",
    baselineRange: { min: 90, max: 100 },
    withinRange: false,
    samples: 3,
    status: "ok",
    ...overrides,
  };
}

function input(overrides: Partial<RegressionInput> = {}): RegressionInput {
  return {
    targetStatus: "completed",
    planReadable: true,
    baselineStatus: "comparable",
    baselineKind: "derived",
    metrics: [comparison({ name: "hitches" })],
    rules: new Map([
      ["hitches", { worse: "higher", maxWorseningPercent: 20 }],
    ]),
    ...overrides,
  };
}

describe("evaluateRegression verdicts", () => {
  it("passes when worsening is inside the percentage tolerance", () => {
    const result = evaluateRegression(input());
    expect(result.summary).toMatchObject({
      status: "pass",
      configured: 1,
      evaluated: 1,
      failed: 0,
      notEvaluated: 0,
      reason: null,
    });
    expect(result.metrics[0]?.regression).toMatchObject({
      status: "pass",
      worse: "higher",
      worseningPercent: 10,
      worseningAbsolute: 10,
      exceeded: [],
      reason: null,
    });
  });

  it("fails when worsening exceeds the percentage tolerance", () => {
    const result = evaluateRegression(
      input({
        metrics: [
          comparison({
            name: "hitches",
            current: 125,
            delta: 25,
            deltaPercent: 25,
          }),
        ],
      }),
    );
    expect(result.summary).toMatchObject({
      status: "fail",
      failed: 1,
      evaluated: 1,
    });
    expect(result.metrics[0]?.regression).toMatchObject({
      status: "fail",
      exceeded: ["maxWorseningPercent"],
      reason: null,
    });
  });

  it("treats exactly the tolerance as pass and just above as fail", () => {
    const atTolerance = evaluateRegression(
      input({
        metrics: [
          comparison({ name: "hitches", delta: 20, deltaPercent: 20 }),
        ],
      }),
    );
    expect(atTolerance.summary.status).toBe("pass");

    const above = evaluateRegression(
      input({
        metrics: [
          comparison({ name: "hitches", delta: 20.001, deltaPercent: 20.001 }),
        ],
      }),
    );
    expect(above.summary.status).toBe("fail");
  });

  it("normalizes direction for lower-is-worse metrics", () => {
    const worse = evaluateRegression(
      input({
        metrics: [
          comparison({
            name: "fps",
            current: 75,
            baselineMedian: 100,
            delta: -25,
            deltaPercent: -25,
            direction: "decrease",
          }),
        ],
        rules: new Map([
          ["fps", { worse: "lower", maxWorseningPercent: 20 }],
        ]),
      }),
    );
    expect(worse.summary.status).toBe("fail");
    expect(worse.metrics[0]?.regression?.worseningPercent).toBe(25);

    const better = evaluateRegression(
      input({
        metrics: [
          comparison({
            name: "fps",
            current: 125,
            delta: 25,
            deltaPercent: 25,
          }),
        ],
        rules: new Map([
          ["fps", { worse: "lower", maxWorseningPercent: 20 }],
        ]),
      }),
    );
    expect(better.summary.status).toBe("pass");
    expect(better.metrics[0]?.regression?.worseningPercent).toBe(-25);
  });

  it("combines percentage and absolute tolerances with OR", () => {
    const result = evaluateRegression(
      input({
        metrics: [
          comparison({
            name: "hitches",
            delta: 30,
            deltaPercent: 10,
          }),
        ],
        rules: new Map([
          [
            "hitches",
            {
              worse: "higher",
              maxWorseningPercent: 20,
              maxWorseningAbsolute: 5,
            },
          ],
        ]),
      }),
    );
    expect(result.summary.status).toBe("fail");
    expect(result.metrics[0]?.regression?.exceeded).toEqual([
      "maxWorseningAbsolute",
    ]);
  });
});

describe("evaluateRegression missing-data boundaries", () => {
  it("uses the absolute tolerance when the baseline median is zero", () => {
    const pass = evaluateRegression(
      input({
        metrics: [
          comparison({
            name: "hitches",
            baselineMedian: 0,
            delta: 4,
            deltaPercent: null,
            current: 4,
          }),
        ],
        rules: new Map([
          [
            "hitches",
            { worse: "higher", maxWorseningAbsolute: 5 },
          ],
        ]),
      }),
    );
    expect(pass.summary.status).toBe("pass");
    expect(pass.metrics[0]?.regression).toMatchObject({
      worseningPercent: null,
      worseningAbsolute: 4,
    });

    const fail = evaluateRegression(
      input({
        metrics: [
          comparison({
            name: "hitches",
            baselineMedian: 0,
            delta: 6,
            deltaPercent: null,
            current: 6,
          }),
        ],
        rules: new Map([
          [
            "hitches",
            { worse: "higher", maxWorseningAbsolute: 5 },
          ],
        ]),
      }),
    );
    expect(fail.summary.status).toBe("fail");
  });

  it("never turns a non-finite comparison into a verdict", () => {
    const infinitePercent = evaluateRegression(
      input({
        metrics: [
          comparison({
            name: "hitches",
            delta: 5,
            deltaPercent: Number.POSITIVE_INFINITY,
          }),
        ],
      }),
    );
    expect(infinitePercent.summary.status).toBe("not-evaluated");
    expect(infinitePercent.metrics[0]?.regression).toMatchObject({
      status: "not-evaluated",
      worseningPercent: null,
      reason: "zero-baseline",
    });

    const nanDelta = evaluateRegression(
      input({
        metrics: [
          comparison({
            name: "hitches",
            delta: Number.NaN,
            deltaPercent: 10,
          }),
        ],
        rules: new Map([
          ["hitches", { worse: "higher", maxWorseningAbsolute: 5 }],
        ]),
      }),
    );
    expect(nanDelta.summary.status).toBe("not-evaluated");
    expect(nanDelta.metrics[0]?.regression?.reason).toBe(
      "metric-not-in-target",
    );
  });

  it("reports zero-baseline when only a percentage rule is configured", () => {
    const result = evaluateRegression(
      input({
        metrics: [
          comparison({
            name: "hitches",
            baselineMedian: 0,
            delta: 6,
            deltaPercent: null,
            current: 6,
          }),
        ],
      }),
    );
    expect(result.summary.status).toBe("not-evaluated");
    expect(result.metrics[0]?.regression).toMatchObject({
      status: "not-evaluated",
      reason: "zero-baseline",
    });
  });

  it("does not evaluate a metric missing from the target", () => {
    const result = evaluateRegression(
      input({
        metrics: [comparison({ name: "hitches", status: "missing-current", current: null, delta: null, deltaPercent: null })],
      }),
    );
    expect(result.summary.status).toBe("not-evaluated");
    expect(result.metrics[0]?.regression?.reason).toBe("metric-not-in-target");
  });

  it("does not evaluate a metric missing from the baseline", () => {
    const result = evaluateRegression(
      input({
        metrics: [
          comparison({
            name: "hitches",
            status: "missing-baseline",
            baselineMedian: null,
            delta: null,
            deltaPercent: null,
            samples: 0,
          }),
        ],
      }),
    );
    expect(result.summary.status).toBe("not-evaluated");
    expect(result.metrics[0]?.regression?.reason).toBe(
      "metric-not-in-baseline",
    );
  });

  it("does not evaluate a unit mismatch", () => {
    const result = evaluateRegression(
      input({
        metrics: [comparison({ name: "hitches", status: "unit-mismatch" })],
      }),
    );
    expect(result.summary.status).toBe("not-evaluated");
    expect(result.metrics[0]?.regression?.reason).toBe("unit-mismatch");
  });

  it("requires three samples on a derived baseline", () => {
    const short = evaluateRegression(
      input({
        metrics: [comparison({ name: "hitches", samples: 2 })],
      }),
    );
    expect(short.metrics[0]?.regression?.reason).toBe(
      "insufficient-metric-samples",
    );
    expect(short.summary.status).toBe("not-evaluated");
  });

  it("allows a single explicitly chosen --against sample", () => {
    const result = evaluateRegression(
      input({
        baselineKind: "against",
        metrics: [comparison({ name: "hitches", samples: 1 })],
      }),
    );
    expect(result.summary.status).toBe("pass");
    expect(result.metrics[0]?.regression?.status).toBe("pass");
  });

  it("appends a configured metric that is absent from the comparison", () => {
    const result = evaluateRegression(
      input({
        metrics: [comparison({ name: "hitches" })],
        rules: new Map([
          ["hitches", { worse: "higher", maxWorseningPercent: 20 }],
          ["launchMs", { worse: "higher", maxWorseningPercent: 20 }],
        ]),
      }),
    );
    expect(result.summary).toMatchObject({
      status: "not-evaluated",
      configured: 2,
      evaluated: 1,
      notEvaluated: 1,
    });
    const added = result.metrics.find((metric) => metric.name === "launchMs");
    expect(added).toMatchObject({
      current: null,
      samples: 0,
      status: "missing-current",
      regression: { status: "not-evaluated", reason: "metric-not-in-target" },
    });
  });
});

describe("evaluateRegression aggregation", () => {
  it("keeps unconfigured metrics with their C2 numbers and null regression", () => {
    const result = evaluateRegression(
      input({
        metrics: [
          comparison({ name: "hitches" }),
          comparison({ name: "blockMs", delta: 0, deltaPercent: 0 }),
        ],
      }),
    );
    expect(result.metrics).toHaveLength(2);
    expect(result.metrics[1]).toMatchObject({
      name: "blockMs",
      baselineMedian: 100,
      regression: null,
    });
    expect(result.summary.configured).toBe(1);
  });

  it("does not turn a mixed pass/not-evaluated result into pass", () => {
    const result = evaluateRegression(
      input({
        metrics: [
          comparison({ name: "hitches" }),
          comparison({
            name: "launchMs",
            status: "missing-current",
            current: null,
            delta: null,
            deltaPercent: null,
          }),
        ],
        rules: new Map([
          ["hitches", { worse: "higher", maxWorseningPercent: 20 }],
          ["launchMs", { worse: "higher", maxWorseningPercent: 20 }],
        ]),
      }),
    );
    expect(result.summary).toMatchObject({
      status: "not-evaluated",
      evaluated: 1,
      notEvaluated: 1,
    });
    expect(result.summary.reasons).toEqual(["metric-not-in-target"]);
  });

  it("lets fail win over not-evaluated", () => {
    const result = evaluateRegression(
      input({
        metrics: [
          comparison({
            name: "hitches",
            delta: 50,
            deltaPercent: 50,
          }),
          comparison({
            name: "launchMs",
            status: "missing-current",
            current: null,
            delta: null,
            deltaPercent: null,
          }),
        ],
        rules: new Map([
          ["hitches", { worse: "higher", maxWorseningPercent: 20 }],
          ["launchMs", { worse: "higher", maxWorseningPercent: 20 }],
        ]),
      }),
    );
    expect(result.summary).toMatchObject({
      status: "fail",
      failed: 1,
      notEvaluated: 1,
    });
    expect(result.summary.reason).toBeNull();
  });

  it("reports no-rules when the plan declares none", () => {
    const result = evaluateRegression(
      input({
        metrics: [comparison({ name: "hitches" })],
        rules: new Map(),
      }),
    );
    expect(result.summary).toMatchObject({
      status: "not-evaluated",
      configured: 0,
      evaluated: 0,
      notEvaluated: 0,
      reason: "no-rules",
      reasons: [],
    });
    expect(result.metrics[0]?.regression).toBeNull();
  });

  it("reports target-not-completed before any data-shape reason", () => {
    const result = evaluateRegression(
      input({
        targetStatus: "failed",
        metrics: [
          comparison({ name: "hitches", status: "missing-current" }),
        ],
      }),
    );
    expect(result.summary.status).toBe("not-evaluated");
    expect(result.summary.reason).toBe("target-not-completed");
  });

  it("reports plan-unreadable when rules cannot be trusted", () => {
    const result = evaluateRegression(
      input({
        planReadable: false,
        rules: new Map(),
      }),
    );
    expect(result.summary.status).toBe("not-evaluated");
    expect(result.summary.reason).toBe("plan-unreadable");
  });

  it("reports baseline-no-samples and baseline-insufficient-samples", () => {
    const empty = evaluateRegression(
      input({ baselineStatus: "no-baseline" }),
    );
    expect(empty.summary.reason).toBe("baseline-no-samples");
    expect(empty.metrics[0]?.regression?.status).toBe("not-evaluated");

    const short = evaluateRegression(
      input({ baselineStatus: "insufficient-samples" }),
    );
    expect(short.summary.reason).toBe("baseline-insufficient-samples");
  });
});
