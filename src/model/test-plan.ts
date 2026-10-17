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

export const metricRequestSchema = z
  .object({
    name: z.string().min(1),
    instrument: z.string().optional(),
    tracePath: z.string().optional(),
    result: z.unknown().optional(),
    threshold: metricThresholdSchema.optional(),
  })
  .passthrough();

export type MetricRequest = z.infer<typeof metricRequestSchema>;

export const diagnosticSettingsSchema = z.object({
  collectDeviceLogs: z.boolean().default(true),
  collectCrashes: z.boolean().default(true),
  lifecycleSampling: z.boolean().default(true),
  includedLogSubsystems: z.array(z.string()).default([]),
  includedLogCategories: z.array(z.string()).default([]),
  excludedLogSubsystems: z.array(z.string()).default([]),
  networkCapture: z.boolean().default(false),
  screenshotOnFailure: z.boolean().default(true),
});

export type DiagnosticSettings = z.infer<typeof diagnosticSettingsSchema>;

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

export const executionModeSchema = z.enum([
  "interactive",
  "automated",
  "headless",
]);
export type ExecutionMode = z.infer<typeof executionModeSchema>;

export const preconditionSchema = z
  .object({
    description: z.string().min(1),
    check: z.string().optional(),
  })
  .strict();

export const warmupSchema = z.object({
  iterations: z.number().int().nonnegative().default(0),
  actionIds: z.array(z.string()).default([]),
});

export const analysisFocusSchema = z.enum([
  "jank",
  "startup",
  "memory",
  "battery",
  "network",
  "general",
]);
export type AnalysisFocus = z.infer<typeof analysisFocusSchema>;

const defaultMetrics: MetricRequest[] = [
  { name: "hitches" },
  { name: "cpu" },
  { name: "memory" },
];

export const testPlanSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().optional(),
  source: z.enum(["ad_hoc", "scenario", "schedule", "regression"]),
  app: appTargetSchema,
  device: deviceTargetSchema,
  execution: executionModeSchema.default("interactive"),
  preconditions: z.array(preconditionSchema).default([]),
  warmup: warmupSchema.prefault({}),
  actions: z.array(actionSchema).min(1),
  metrics: z.array(metricRequestSchema).default(defaultMetrics),
  analysisFocus: z.array(analysisFocusSchema).default([]),
  repetitions: z.number().int().positive().default(1),
  diagnostics: diagnosticSettingsSchema.prefault({}),
  createdAt: z.string().datetime().optional(),
  notes: z.string().optional(),
});

export type TestPlan = z.infer<typeof testPlanSchema>;
