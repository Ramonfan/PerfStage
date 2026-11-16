import { z } from "zod";

export const actionSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().min(1),
    type: z.literal("tap"),
    target: z.string().min(1),
    waitAfterMs: z.number().int().nonnegative().default(500),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("swipe"),
    direction: z.enum(["up", "down", "left", "right"]),
    distance: z.number().positive(),
    durationMs: z.number().int().positive().optional(),
    waitAfterMs: z.number().int().nonnegative().default(1000),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("wait"),
    durationMs: z.number().int().nonnegative(),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("wait_for"),
    target: z.string().min(1),
    timeoutMs: z.number().int().positive().default(10000),
  }),
]);

export type TestAction = z.infer<typeof actionSchema>;

export const metricThresholdSchema = z
  .object({
    warn: z.number().optional(),
    fail: z.number().optional(),
  })
  .strict();

/**
 * Optional regression policy for one metric (C3).
 *
 * `worse` is required on purpose: whether an increase is good or bad is a
 * product decision, not something the evaluator should guess. At least one
 * tolerance must be present; both are allowed and combine with OR.
 */
export const metricRegressionSchema = z
  .object({
    worse: z.enum(["higher", "lower"]),
    maxWorseningPercent: z.number().nonnegative().optional(),
    maxWorseningAbsolute: z.number().nonnegative().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.maxWorseningPercent !== undefined ||
      value.maxWorseningAbsolute !== undefined,
    {
      message:
        "regression 至少需要 maxWorseningPercent 或 maxWorseningAbsolute",
    },
  );

export type MetricRegression = z.infer<typeof metricRegressionSchema>;

export const metricRequestSchema = z
  .object({
    name: z.string().min(1),
    instrument: z.string().optional(),
    tracePath: z.string().optional(),
    result: z.unknown().optional(),
    threshold: metricThresholdSchema.optional(),
    regression: metricRegressionSchema.optional(),
  })
  .passthrough();

export type MetricRequest = z.infer<typeof metricRequestSchema>;

/**
 * App under test.
 *
 * The three launch fields are real inputs, not metadata: `launchArguments` and
 * `environmentVariables` reach every `xctrace --launch` cold start, and
 * `launchUrl` is opened through the device before warmup (see README §8).
 */
export const appTargetSchema = z.object({
  bundleId: z.string().min(1),
  launchUrl: z.string().url().optional(),
  launchArguments: z.array(z.string()).default([]),
  environmentVariables: z.record(z.string(), z.string()).default({}),
});

export const deviceTargetSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  osVersion: z.string().optional(),
  modelIdentifier: z.string().optional(),
});

/**
 * Pre-run assertions the Runner enforces before the scored window.
 *
 * These used to be rendered into human-readable `check` strings
 * (`foregroundBundleId === "..."`) that nothing ever evaluated. The Runner now
 * executes the structured fields directly, so a precondition that cannot be
 * verified never reaches a report as if it had been.
 */
export const preconditionSchema = z
  .object({
    description: z.string().min(1),
    foregroundBundleId: z.string().min(1).optional(),
    accessibilityText: z.string().min(1).optional(),
  })
  .strict()
  // `description` alone would be printed as "verified" without anything being
  // compared; a precondition must assert at least one checkable field.
  .refine(
    (value) =>
      value.foregroundBundleId !== undefined ||
      value.accessibilityText !== undefined,
    {
      message:
        "预置条件至少需要一个可校验字段：foregroundBundleId 或 accessibilityText（description 仅用于报告展示）",
    },
  );

export const warmupActionSchema = z.object({
  id: z.string().min(1),
  type: z.literal("tap"),
  target: z.string().min(1),
  waitAfterMs: z.number().int().nonnegative().default(500),
});
export type WarmupAction = z.infer<typeof warmupActionSchema>;

export const warmupSchema = z.array(warmupActionSchema).default([]);
export type Warmup = z.infer<typeof warmupSchema>;

/**
 * Default metric set for a Take.
 *
 * These are the four canonical iOS metrics PerfStage actually collects
 * (D11–D13). The previous `cpu`/`memory` pair predated the M1 vocabulary and
 * silently asked the Runner for metrics it cannot measure.
 */
const defaultMetrics: MetricRequest[] = [
  { name: "hitches" },
  { name: "blockMs" },
  { name: "launchMs" },
  { name: "memoryMB" },
];

export const testPlanSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().optional(),
  source: z.enum(["ad_hoc", "scenario"]),
  app: appTargetSchema,
  device: deviceTargetSchema,
  preconditions: z.array(preconditionSchema).default([]),
  warmup: warmupSchema,
  actions: z.array(actionSchema).min(1),
  metrics: z.array(metricRequestSchema).default(defaultMetrics),
  repetitions: z.number().int().positive().default(1),
  createdAt: z.string().datetime().optional(),
  notes: z.string().optional(),
});

export type TestPlan = z.infer<typeof testPlanSchema>;
