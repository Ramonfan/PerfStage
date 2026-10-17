import { describe, expect, it } from "vitest";
import { testPlanSchema } from "../../model/test-plan.js";

describe("testPlanSchema", () => {
  it("expands default metrics and diagnostics", () => {
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
      "cpu",
      "memory",
    ]);
    expect(plan.diagnostics.collectDeviceLogs).toBe(true);
    expect(plan.diagnostics.collectCrashes).toBe(true);
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
});
