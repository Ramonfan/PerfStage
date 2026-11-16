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

it("keeps union branch detail for a mistyped device block", () => {
  expect(() =>
    parseScenarioDocument({
      id: "bad-device",
      app: { bundleId: "com.nndev.im" },
      device: { id: 5 },
      actions: [{ id: "wait", type: "wait", durationMs: 10 }],
    }),
  ).toThrow(/device: Invalid input（.*expected string.*number.*）/);
});

it("rejects a diagnostics block instead of silently dropping it", () => {
  expect(() =>
    parseScenarioDocument(
      {
        id: "community-home-scroll",
        app: { bundleId: "com.nndev.im" },
        actions: [
          { id: "scroll-up", type: "swipe", direction: "up", distance: 700 },
        ],
        diagnostics: { networkCapture: true },
      },
      "community-home-scroll.yaml",
    ),
  ).toThrow(/community-home-scroll\.yaml[\s\S]*diagnostics[\s\S]*已在 v0\.1 移除/);
});

it("keeps preconditions structured instead of rendering a pseudo-expression", () => {
  const plan = parseScenarioDocument({
    id: "community-home-scroll",
    app: { bundleId: "com.nndev.im" },
    preconditions: { foregroundBundleId: "com.nndev.im", accessibilityText: "社区" },
    actions: [{ id: "scroll-up", type: "swipe", direction: "up", distance: 700 }],
  });
  expect(plan.preconditions).toEqual([
    {
      description:
        "Foreground bundleId is com.nndev.im; Accessibility text contains 社区",
      foregroundBundleId: "com.nndev.im",
      accessibilityText: "社区",
    },
  ]);
  // `check` was a string nothing evaluated; it must not come back.
  expect(plan.preconditions[0]).not.toHaveProperty("check");
});

it("rejects analysisFocus with the removal hint", () => {
  expect(() =>
    parseScenarioDocument(
      {
        id: "community-home-scroll",
        app: { bundleId: "com.nndev.im" },
        actions: [{ id: "scroll-up", type: "swipe", direction: "up", distance: 700 }],
        analysisFocus: ["jank"],
      },
      "community-home-scroll.yaml",
    ),
  ).toThrow(/analysisFocus[\s\S]*由 metrics 决定/);
});

it("rejects execution with the removal hint", () => {
  expect(() =>
    parseScenarioDocument(
      {
        id: "community-home-scroll",
        app: { bundleId: "com.nndev.im" },
        actions: [{ id: "scroll-up", type: "swipe", direction: "up", distance: 700 }],
        execution: "unattended",
      },
      "community-home-scroll.yaml",
    ),
  ).toThrow(/execution[\s\S]*run_performance_test/);
});

it("rejects the removed preconditions[].check with a migration hint", () => {
  expect(() =>
    parseScenarioDocument(
      {
        id: "community-home-scroll",
        app: { bundleId: "com.nndev.im" },
        preconditions: {
          description: "社区页已打开",
          check: 'foregroundBundleId === "com.nndev.im"',
        },
        actions: [{ id: "scroll-up", type: "swipe", direction: "up", distance: 700 }],
      },
      "community-home-scroll.yaml",
    ),
  ).toThrow(/check[\s\S]*foregroundBundleId/);
});

it("rejects a description-only precondition instead of reporting it as verified", () => {
  expect(() =>
    parseScenarioDocument({
      id: "community-home-scroll",
      app: { bundleId: "com.nndev.im" },
      preconditions: { description: "Target app is installed and running" },
      actions: [{ id: "scroll-up", type: "swipe", direction: "up", distance: 700 }],
    }),
  ).toThrow(/至少需要一个可校验字段/);
});
