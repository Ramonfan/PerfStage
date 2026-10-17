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
});
