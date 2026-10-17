import { expect, it } from "vitest";
import { parseScenarioDocument } from "../../scenario/parser.js";

it("converts a scenario document into a current TestPlan", () => {
  const plan = parseScenarioDocument({
    id: "community-home-scroll",
    name: "社区首页滚动",
    app: { bundleId: "com.nndev.im" },
    device: { name: "Ra iPhone" },
    preconditions: { foregroundBundleId: "com.nndev.im", accessibilityText: "社区" },
    warmup: [{ id: "open-community", type: "tap", target: "社区" }],
    actions: [{ id: "scroll-up", type: "swipe", direction: "up", distance: 700, durationMs: 500 }],
  });
  expect(plan.id).toBe("community-home-scroll");
  expect(plan.warmup[0]?.type).toBe("tap");
  expect(plan.actions[0]?.type).toBe("swipe");
});

it("fails with the source field when the YAML action is invalid", () => {
  expect(() => parseScenarioDocument({
    id: "bad",
    app: { bundleId: "com.nndev.im" },
    actions: [{ id: "x", type: "unknown" }],
  })).toThrow();
});
