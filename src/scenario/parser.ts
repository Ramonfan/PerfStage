import { z, ZodError } from "zod";
import {
  appTargetSchema,
  deviceTargetSchema,
  testPlanSchema,
  warmupActionSchema,
  type TestPlan,
} from "../model/test-plan.js";

const preconditionInputSchema = z
  .object({
    foregroundBundleId: z.string().min(1).optional(),
    accessibilityText: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
  })
  .strict();

const scenarioInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().optional(),
    app: appTargetSchema.passthrough().optional(),
    device: z
      .union([deviceTargetSchema, deviceTargetSchema.partial()])
      .optional()
      .transform((val) => {
        if (!val) return { id: "any" };
        const partial = val as { id?: string; [k: string]: unknown };
        return { ...partial, id: partial.id ?? "any" };
      }),
    execution: z.enum(["interactive", "automated", "headless"]).optional(),
    preconditions: preconditionInputSchema.optional(),
    warmup: z.array(warmupActionSchema).optional(),
    actions: z.array(z.unknown()).min(1),
    metrics: z.array(z.unknown()).optional(),
    analysisFocus: z.array(z.string()).optional(),
    repetitions: z.number().int().positive().optional(),
    notes: z.string().optional(),
  })
  .passthrough();

function buildPreconditionFromInput(
  input: z.infer<typeof preconditionInputSchema>,
): Array<{ description: string; check?: string }> {
  const parts: string[] = [];
  const checks: string[] = [];
  if (input.foregroundBundleId) {
    parts.push(`Foreground bundleId is ${input.foregroundBundleId}`);
    checks.push(
      `foregroundBundleId === "${input.foregroundBundleId}"`,
    );
  }
  if (input.accessibilityText) {
    parts.push(`Accessibility text contains ${input.accessibilityText}`);
    checks.push(
      `accessibility.contains("${input.accessibilityText}")`,
    );
  }
  const description =
    input.description ??
    (parts.length > 0 ? parts.join("; ") : "Scenario precondition satisfied");
  const conditionals = checks.length > 0 ? checks.join(" && ") : undefined;
  return [{ description, ...(conditionals ? { check: conditionals } : {}) }];
}

function describeZodError(error: ZodError, source?: string): string {
  const prefix = source ? `${source}: ` : "";
  return `${prefix}${error.message}`;
}

export function parseScenarioDocument(document: unknown, source?: string): TestPlan {
  if (document === null || typeof document !== "object") {
    throw new Error(
      describeZodError(
        new ZodError([
          {
            code: "custom",
            path: [],
            message: "Scenario document must be a YAML mapping.",
          },
        ]),
        source,
      ),
    );
  }

  const raw = document as Record<string, unknown>;
  const parsed = scenarioInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(describeZodError(parsed.error, source));
  }

  const input = parsed.data;
  const preconditions = input.preconditions
    ? buildPreconditionFromInput(input.preconditions)
    : [];

  const planInput: Record<string, unknown> = {
    source: "scenario",
    app: input.app,
    device: input.device,
    actions: input.actions,
  };
  if (input.id !== undefined) planInput.id = input.id;
  if (input.name !== undefined) planInput.name = input.name;
  if (input.execution !== undefined) planInput.execution = input.execution;
  if (input.warmup !== undefined) planInput.warmup = input.warmup;
  if (input.metrics !== undefined) planInput.metrics = input.metrics;
  if (input.analysisFocus !== undefined) planInput.analysisFocus = input.analysisFocus;
  if (input.repetitions !== undefined) planInput.repetitions = input.repetitions;
  if (input.notes !== undefined) planInput.notes = input.notes;
  if (preconditions.length > 0) planInput.preconditions = preconditions;

  const result = testPlanSchema.safeParse(planInput);
  if (!result.success) {
    throw new Error(describeZodError(result.error, source));
  }
  return result.data;
}
