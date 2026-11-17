import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `defaultAnalyzer` is the only place where the launch summary crosses from
 * tool output into the persisted pass record. These cases pin the template
 * gate, the schema validation and the warning for malformed payloads without
 * needing a device or a real `xctrace` export.
 */
const state = vi.hoisted(() => ({
  result: undefined as unknown,
}));

vi.mock("../../tools/analyze.js", () => ({
  analyzePerformanceTrace: vi.fn(async () => state.result),
}));

import { defaultAnalyzer } from "../../runner/execute.js";

const VALID_PAGE_FAULTS = {
  fileBackedPageIns: 3_229,
  fileBackedPageInMs: 280.3,
  totalFaults: 8_792,
  totalFaultMs: 298.3,
};

describe("defaultAnalyzer launch diagnostics", () => {
  beforeEach(() => {
    state.result = {
      template: "launch",
      tracePath: "/tmp/launch.trace",
      metrics: [
        {
          name: "launchMs",
          value: 500,
          unit: "ms",
          instrument: "App Launch",
          tracePath: "/tmp/launch.trace",
          measuredAt: new Date().toISOString(),
        },
      ],
      warnings: [],
      analysis: { pageFaults: VALID_PAGE_FAULTS },
    };
  });

  it("carries a valid launch summary through to the pass record", async () => {
    const result = await defaultAnalyzer({
      template: "launch",
      tracePath: "/tmp/launch.trace",
      processName: "NN",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.pageFaults).toEqual(VALID_PAGE_FAULTS);
    expect(result.warnings).toBeUndefined();
  });

  it("drops a malformed summary and explains why", async () => {
    state.result = {
      template: "launch",
      tracePath: "/tmp/launch.trace",
      metrics: [],
      warnings: ["existing warning"],
      analysis: {
        pageFaults: { ...VALID_PAGE_FAULTS, fileBackedPageIns: -1 },
      },
    };

    const result = await defaultAnalyzer({
      template: "launch",
      tracePath: "/tmp/launch.trace",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.pageFaults).toBeUndefined();
    expect(result.warnings).toEqual([
      "existing warning",
      "launch page-fault summary was malformed and was dropped; launchMs is unaffected.",
    ]);
  });

  it("does not warn when the launch pass simply has no summary", async () => {
    state.result = {
      template: "launch",
      tracePath: "/tmp/launch.trace",
      metrics: [],
      warnings: [],
      analysis: {},
    };

    const result = await defaultAnalyzer({
      template: "launch",
      tracePath: "/tmp/launch.trace",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.pageFaults).toBeUndefined();
    expect(result.warnings).toBeUndefined();
  });

  it("ignores pageFaults on non-launch templates", async () => {
    state.result = {
      template: "hitches",
      tracePath: "/tmp/hitches.trace",
      metrics: [],
      warnings: [],
      analysis: { pageFaults: VALID_PAGE_FAULTS },
    };

    const result = await defaultAnalyzer({
      template: "hitches",
      tracePath: "/tmp/hitches.trace",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.pageFaults).toBeUndefined();
    expect(result.warnings).toBeUndefined();
  });

  it("passes tool errors through unchanged", async () => {
    state.result = { error: "analysis failed" };
    const result = await defaultAnalyzer({
      template: "launch",
      tracePath: "/tmp/launch.trace",
    });
    expect(result).toEqual({ error: "analysis failed" });
  });
});
