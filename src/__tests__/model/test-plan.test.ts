import { describe, expect, it } from "vitest";
import { testPlanSchema } from "../../model/test-plan.js";

describe("testPlanSchema", () => {
  it("expands default metrics", () => {
    const plan = testPlanSchema.parse({
      source: "ad_hoc",
      app: { bundleId: "com.example.app" },
      device: { id: "device-1" },
      actions: [
        { id: "scroll-1", type: "swipe", direction: "up", distance: 500 },
      ],
    });
    expect(plan.metrics.map((metric) => metric.name)).toEqual([
      "hitches",
      "blockMs",
      "launchMs",
      "memoryMB",
    ]);
  });

  it("rejects an unknown action type", () => {
    expect(() =>
      testPlanSchema.parse({
        source: "ad_hoc",
        app: { bundleId: "com.example.app" },
        device: { id: "device-1" },
        actions: [{ id: "bad", type: "pinch" }],
      }),
    ).toThrow();
  });

  it("preserves an unknown metric name and extra fields for forward compatibility", () => {
    const plan = testPlanSchema.parse({
      source: "ad_hoc",
      app: { bundleId: "com.example.app" },
      device: { id: "device-1" },
      actions: [
        { id: "scroll-1", type: "swipe", direction: "up", distance: 500 },
      ],
      metrics: [
        {
          name: "experimental_gpu_spike",
          instrument: "metal-frame-collector",
          tracePath: "/traces/gpu.trace",
          extraField: "should survive",
        },
      ],
    });
    expect(plan.metrics[0]?.name).toBe("experimental_gpu_spike");
    expect(plan.metrics[0]?.instrument).toBe("metal-frame-collector");
    expect(plan.metrics[0]?.tracePath).toBe("/traces/gpu.trace");
    expect(
      (plan.metrics[0] as Record<string, unknown>)["extraField"],
    ).toBe("should survive");
  });

  it("preserves a valid regression policy on a metric", () => {
    const plan = testPlanSchema.parse({
      source: "ad_hoc",
      app: { bundleId: "com.example.app" },
      device: { id: "device-1" },
      actions: [
        { id: "scroll-1", type: "swipe", direction: "up", distance: 500 },
      ],
      metrics: [
        {
          name: "hitches",
          regression: {
            worse: "higher",
            maxWorseningPercent: 20,
            maxWorseningAbsolute: 5,
          },
        },
      ],
    });
    expect(plan.metrics[0]?.regression).toEqual({
      worse: "higher",
      maxWorseningPercent: 20,
      maxWorseningAbsolute: 5,
    });
  });

  it("rejects a regression policy without a tolerance", () => {
    expect(() =>
      testPlanSchema.parse({
        source: "ad_hoc",
        app: { bundleId: "com.example.app" },
        device: { id: "device-1" },
        actions: [
          { id: "scroll-1", type: "swipe", direction: "up", distance: 500 },
        ],
        metrics: [
          { name: "hitches", regression: { worse: "higher" } },
        ],
      }),
    ).toThrow(/maxWorseningPercent|maxWorseningAbsolute/);
  });

  it("rejects a regression policy without a direction", () => {
    expect(() =>
      testPlanSchema.parse({
        source: "ad_hoc",
        app: { bundleId: "com.example.app" },
        device: { id: "device-1" },
        actions: [
          { id: "scroll-1", type: "swipe", direction: "up", distance: 500 },
        ],
        metrics: [
          { name: "hitches", regression: { maxWorseningPercent: 20 } },
        ],
      }),
    ).toThrow();
  });

  it("rejects negative tolerances and unknown regression keys", () => {
    const base = {
      source: "ad_hoc" as const,
      app: { bundleId: "com.example.app" },
      device: { id: "device-1" },
      actions: [
        { id: "scroll-1", type: "swipe" as const, direction: "up" as const, distance: 500 },
      ],
    };
    expect(() =>
      testPlanSchema.parse({
        ...base,
        metrics: [
          {
            name: "hitches",
            regression: { worse: "higher", maxWorseningPercent: -1 },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      testPlanSchema.parse({
        ...base,
        metrics: [
          {
            name: "hitches",
            regression: {
              worse: "higher",
              maxWorseningPercent: 20,
              extra: true,
            },
          },
        ],
      }),
    ).toThrow();
  });
});
