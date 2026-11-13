import { describe, expect, it } from "vitest";
import {
  deriveGate,
  evaluateMetricVerdict,
  resolveMetricVerdict,
} from "../../analysis/thresholds.js";

describe("evaluateMetricVerdict", () => {
  const threshold = { warn: 3, fail: 5 };

  it("returns unknown when no threshold is configured", () => {
    expect(evaluateMetricVerdict(10, undefined)).toBe("unknown");
    expect(evaluateMetricVerdict(10, {})).toBe("unknown");
  });

  it("returns pass below the warn threshold", () => {
    expect(evaluateMetricVerdict(2, threshold)).toBe("pass");
  });

  it("returns warn exactly at the warn threshold", () => {
    expect(evaluateMetricVerdict(3, threshold)).toBe("warn");
    expect(evaluateMetricVerdict(4, threshold)).toBe("warn");
  });

  it("returns fail at and above the fail threshold", () => {
    expect(evaluateMetricVerdict(5, threshold)).toBe("fail");
    expect(evaluateMetricVerdict(99, threshold)).toBe("fail");
  });

  it("gives fail precedence when thresholds are inverted", () => {
    expect(evaluateMetricVerdict(5, { warn: 10, fail: 5 })).toBe("fail");
  });

  it("treats only-fail thresholds as pass below fail", () => {
    expect(evaluateMetricVerdict(4, { fail: 5 })).toBe("pass");
  });

  it("returns unknown for a missing or non-numeric value", () => {
    expect(evaluateMetricVerdict(undefined, threshold)).toBe("unknown");
    expect(evaluateMetricVerdict(null, threshold)).toBe("unknown");
    expect(evaluateMetricVerdict("7", threshold)).toBe("unknown");
    expect(evaluateMetricVerdict(Number.NaN, threshold)).toBe("unknown");
  });
});

describe("resolveMetricVerdict", () => {
  it("prefers the derived verdict when a threshold exists", () => {
    expect(
      resolveMetricVerdict({
        name: "hitches",
        value: 7,
        threshold: { warn: 3, fail: 5 },
        verdict: "pass",
      }),
    ).toBe("fail");
  });

  it("falls back to the explicit verdict when there is no threshold", () => {
    expect(
      resolveMetricVerdict({ name: "cpu", value: 30, verdict: "warn" }),
    ).toBe("warn");
  });

  it("returns unknown when neither threshold nor verdict is available", () => {
    expect(resolveMetricVerdict({ name: "cpu", value: 30 })).toBe("unknown");
  });
});

describe("deriveGate", () => {
  it("fails when any metric fails", () => {
    expect(deriveGate(["pass", "warn", "fail"])).toBe("fail");
  });

  it("warns when the worst metric warns", () => {
    expect(deriveGate(["pass", "warn"])).toBe("warn");
  });

  it("passes when every metric passes", () => {
    expect(deriveGate(["pass", "pass"])).toBe("pass");
  });

  it("returns unknown when there are no metrics", () => {
    expect(deriveGate([])).toBe("unknown");
  });

  it("returns unknown when every metric is unknown", () => {
    expect(deriveGate(["unknown", "unknown"])).toBe("unknown");
  });

  it("ignores skipped metrics", () => {
    expect(deriveGate(["skipped", "pass"])).toBe("pass");
    expect(deriveGate(["skipped"])).toBe("unknown");
  });
});
