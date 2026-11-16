import { z, ZodError } from "zod";
import { describeInputIssues } from "../diagnostics/removed-config.js";
import {
  appTargetSchema,
  deviceTargetSchema,
  preconditionSchema,
  testPlanSchema,
  warmupActionSchema,
  type TestPlan,
} from "../model/test-plan.js";

/**
 * A precondition must assert something the Runner can evaluate.
 *
 * `description` is report text. Allowing it alone would let a scene declare a
 * precondition that is printed as "verified" while nothing was compared, which
 * is the exact failure mode this contract removes.
 */
const PRECONDITION_NEEDS_FIELD =
  "预置条件至少需要一个可校验字段：foregroundBundleId 或 accessibilityText（description 仅用于报告展示）";

const preconditionInputSchema = z
  .object({
    foregroundBundleId: z.string().min(1).optional(),
    accessibilityText: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.foregroundBundleId !== undefined ||
      value.accessibilityText !== undefined,
    { message: PRECONDITION_NEEDS_FIELD },
  );

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
    preconditions: preconditionInputSchema.optional(),
    warmup: z.array(warmupActionSchema).optional(),
    actions: z.array(z.unknown()).min(1),
    metrics: z.array(z.unknown()).optional(),
    repetitions: z.number().int().positive().optional(),
    notes: z.string().optional(),
  })
  .strict();

/**
 * Turn the YAML precondition object into the structured form the Runner
 * enforces. The old `check` pseudo-expression (`foregroundBundleId === "..."`)
 * is gone: nothing evaluated it, so keeping it would have documented a
 * guarantee the Runner did not give.
 */
function buildPreconditionFromInput(
  input: z.infer<typeof preconditionInputSchema>,
): Array<z.infer<typeof preconditionSchema>> {
  const parts: string[] = [];
  if (input.foregroundBundleId) {
    parts.push(`Foreground bundleId is ${input.foregroundBundleId}`);
  }
  if (input.accessibilityText) {
    parts.push(`Accessibility text contains ${input.accessibilityText}`);
  }
  const description = input.description ?? parts.join("; ");
  return [
    {
      description,
      ...(input.foregroundBundleId !== undefined
        ? { foregroundBundleId: input.foregroundBundleId }
        : {}),
      ...(input.accessibilityText !== undefined
        ? { accessibilityText: input.accessibilityText }
        : {}),
    },
  ];
}

function describeZodError(error: ZodError, source?: string): string {
  const prefix = source ? `${source}: ` : "";
  return `${prefix}${describeInputIssues(error.issues)}`;
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
  if (input.warmup !== undefined) planInput.warmup = input.warmup;
  if (input.metrics !== undefined) planInput.metrics = input.metrics;
  if (input.repetitions !== undefined) planInput.repetitions = input.repetitions;
  if (input.notes !== undefined) planInput.notes = input.notes;
  if (preconditions.length > 0) planInput.preconditions = preconditions;

  const result = testPlanSchema.safeParse(planInput);
  if (!result.success) {
    throw new Error(describeZodError(result.error, source));
  }
  return result.data;
}
