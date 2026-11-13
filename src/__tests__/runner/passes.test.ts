import { describe, expect, it } from "vitest";
import {
  planPasses,
  templateForMetric,
} from "../../runner/passes.js";

describe("planPasses", () => {
  it("collapses hitches and blockMs into a single pass", () => {
    const { passes, unsupported } = planPasses([
      "hitches",
      "blockMs",
      "launchMs",
      "memoryMB",
    ]);
    expect(unsupported).toEqual([]);
    expect(passes.map((pass) => pass.template)).toEqual([
      "hitches",
      "launch",
      "memory",
    ]);
    expect(passes[0]?.metrics).toEqual(["hitches", "blockMs"]);
  });

  it("records only the passes the plan actually needs", () => {
    expect(planPasses(["launchMs"]).passes.map((pass) => pass.template)).toEqual([
      "launch",
    ]);
    expect(planPasses(["memoryMB"]).passes.map((pass) => pass.template)).toEqual([
      "memory",
    ]);
  });

  it("resolves aliases to the canonical metric", () => {
    const { passes } = planPasses(["hitch", "memory", "blockingMs"]);
    expect(passes.map((pass) => pass.template)).toEqual(["hitches", "memory"]);
    expect(passes[0]?.metrics).toEqual(["hitches", "blockMs"]);
    expect(passes[1]?.metrics).toEqual(["memoryMB"]);
  });

  it("deduplicates repeated canonical names", () => {
    const { passes } = planPasses(["hitches", "hitch", "hitches"]);
    expect(passes[0]?.metrics).toEqual(["hitches"]);
  });

  it("reports metrics PerfStage cannot collect instead of silently dropping them", () => {
    const { passes, unsupported } = planPasses(["hitches", "cpu", "fps"]);
    expect(passes.map((pass) => pass.template)).toEqual(["hitches"]);
    expect(unsupported).toEqual(["cpu", "fps"]);
  });

  it("numbers passes in report order", () => {
    const { passes } = planPasses(["memoryMB", "hitches", "launchMs"]);
    expect(passes.map((pass) => pass.index)).toEqual([1, 2, 3]);
  });

  it("maps a single metric to its template", () => {
    expect(templateForMetric("blockMs")).toBe("hitches");
    expect(templateForMetric("launch")).toBe("launch");
    expect(templateForMetric("cpu")).toBeNull();
  });
});
