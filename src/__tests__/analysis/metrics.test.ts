import { describe, expect, it } from "vitest";
import {
  canonicalMetricName,
  metricDefinition,
  normalizeMetricResult,
  normalizeMetricResults,
  sameMetric,
  MVP_METRIC_DEFINITIONS,
} from "../../analysis/metrics.js";

describe("canonicalMetricName", () => {
  it("maps aliases onto the canonical MVP metric names", () => {
    expect(canonicalMetricName("memory")).toBe("memoryMB");
    expect(canonicalMetricName("launch")).toBe("launchMs");
    expect(canonicalMetricName("blockingMs")).toBe("blockMs");
    expect(canonicalMetricName("hangs")).toBe("hitches");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(canonicalMetricName("  Memory  ")).toBe("memoryMB");
    expect(canonicalMetricName("HITCHES")).toBe("hitches");
  });

  it("leaves unknown metrics untouched", () => {
    expect(canonicalMetricName("cpu")).toBe("cpu");
    expect(canonicalMetricName("myCustomMetric")).toBe("myCustomMetric");
  });
});

describe("sameMetric", () => {
  it("treats an alias and its canonical name as the same metric", () => {
    expect(sameMetric("memory", "memoryMB")).toBe(true);
    expect(sameMetric("launch", "launchMs")).toBe(true);
  });

  it("keeps distinct metrics distinct", () => {
    expect(sameMetric("hitches", "blockMs")).toBe(false);
  });
});

describe("normalizeMetricResult", () => {
  it("fills the canonical name, unit, and instrument", () => {
    const normalized = normalizeMetricResult({ name: "memory", value: 113.5 });
    expect(normalized).toMatchObject({
      name: "memoryMB",
      value: 113.5,
      unit: "MB",
      instrument: "Activity Monitor",
    });
  });

  it("preserves caller-supplied unit and instrument", () => {
    const normalized = normalizeMetricResult({
      name: "launch",
      value: 274.3,
      unit: "ms",
      instrument: "Custom Launch",
    });
    expect(normalized.name).toBe("launchMs");
    expect(normalized.unit).toBe("ms");
    expect(normalized.instrument).toBe("Custom Launch");
  });

  it("passes unknown metrics through unchanged", () => {
    const metric = { name: "cpu", value: 35, unit: "%" };
    expect(normalizeMetricResult(metric)).toEqual(metric);
  });

  it("normalizes a list in one pass", () => {
    const normalized = normalizeMetricResults([
      { name: "memory", value: 100 },
      { name: "hitches", value: 2 },
    ]);
    expect(normalized.map((metric) => metric.name)).toEqual([
      "memoryMB",
      "hitches",
    ]);
  });
});

describe("MVP metric definitions", () => {
  it("covers the four metrics required by A3", () => {
    const names = MVP_METRIC_DEFINITIONS.map((definition) => definition.name);
    expect(names).toEqual(["hitches", "blockMs", "launchMs", "memoryMB"]);
  });

  it("resolves a definition by canonical name or alias", () => {
    expect(metricDefinition("hitches")?.instrument).toBe("Animation Hitches");
    expect(metricDefinition("memory")?.unit).toBe("MB");
    expect(metricDefinition("does-not-exist")).toBeUndefined();
  });
});
