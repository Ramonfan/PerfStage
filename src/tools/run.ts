import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createMobilecliDriver } from "../device/mobilecli.js";
import { createXctraceRecorder } from "../recording/xctrace.js";
import { runTake, type RunTakeSummary } from "../runner/run.js";
import { prepareInputSchema, preparePerformanceTest } from "./plan.js";
import { resolveReadyWorkspace, type RegisterOptions } from "./index.js";

/**
 * `run_performance_test` — the one-shot Runner tool.
 *
 * This is the whole point of M3: a Skill stops orchestrating passes and becomes
 * a single call. `prepare_performance_test` and `finalize_performance_test`
 * still exist and still work; this tool is simply both of them plus execution,
 * so a Skill that needs manual control can keep using the lower-level pair.
 */

export const runInputSchema = prepareInputSchema
  .extend({
    /** Override the plan's `repetitions` (median aggregation). */
    repetitions: z.number().int().positive().max(10).optional(),
  })
  .strict();

export type RunPerformanceTestInput = z.infer<typeof runInputSchema>;

/**
 * The tool returns the Runner's summary verbatim. Typing it as the shared
 * {@link RunTakeSummary} (instead of a loose record shape) is what lets the
 * CLI render it and keeps A12 — `--json` is structurally identical to the
 * MCP payload — true by construction.
 */
export type RunPerformanceTestResult = RunTakeSummary;

export interface RunPerformanceTestError {
  error: string;
}

export type RunPerformanceTestOutcome =
  | RunPerformanceTestResult
  | RunPerformanceTestError;

export async function runPerformanceTest(
  rawInput: unknown,
  options: RegisterOptions,
): Promise<RunPerformanceTestOutcome> {
  const resolved = await resolveReadyWorkspace(options);
  if (resolved.kind === "error") {
    return { error: resolved.error };
  }

  const parsed = runInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      error: `run_performance_test 输入校验失败：${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    };
  }
  const input = parsed.data;

  // Prepare first: this validates the scenario, materializes the plan and
  // creates the run. Running without a plan would bypass the evidence contract.
  const prepared = await preparePerformanceTest(
    stripRunOnlyFields(input),
    {
      ...options,
      scenarioDir: resolved.scenarioDir,
      runStore: resolved.runStore,
      runsRoot: resolved.runsRoot,
    },
  );
  if ("error" in prepared) {
    return { error: prepared.error };
  }

  const plan =
    input.repetitions === undefined
      ? prepared.plan
      : { ...prepared.plan, repetitions: input.repetitions };

  const device =
    options.device ??
    createMobilecliDriver({
      scratchDir: join(tmpdir(), "perfstage-devicectl"),
      ...(options.log !== undefined ? { log: options.log } : {}),
    });
  const recorder =
    options.recorder ??
    createXctraceRecorder({
      ...(options.log !== undefined ? { log: options.log } : {}),
    });

  const outcome = await runTake(
    { runId: prepared.runId, plan, deviceId: plan.device.id },
    {
      runStore: resolved.runStore,
      now: options.now,
      device,
      recorder,
      ...(options.analyze !== undefined ? { analyze: options.analyze } : {}),
      ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
      ...(options.log !== undefined ? { log: options.log } : {}),
      ...(options.settleMs !== undefined ? { settleMs: options.settleMs } : {}),
      ...(options.launchSettleMs !== undefined
        ? { launchSettleMs: options.launchSettleMs }
        : {}),
      ...(options.memorySettleMs !== undefined
        ? { memorySettleMs: options.memorySettleMs }
        : {}),
      ...(options.passCooldownMs !== undefined
        ? { passCooldownMs: options.passCooldownMs }
        : {}),
      ...(options.healthCheck !== undefined
        ? { healthCheck: options.healthCheck }
        : {}),
      ...(options.healthCheckSettleMs !== undefined
        ? { healthCheckSettleMs: options.healthCheckSettleMs }
        : {}),
      ...(options.foregroundTimeoutMs !== undefined
        ? { foregroundTimeoutMs: options.foregroundTimeoutMs }
        : {}),
      ...(options.postLaunchSampleMs !== undefined
        ? { postLaunchSampleMs: options.postLaunchSampleMs }
        : {}),
      ...(options.elementTimeoutMs !== undefined
        ? { elementTimeoutMs: options.elementTimeoutMs }
        : {}),
      ...(options.minimumWindowMs !== undefined
        ? { minimumWindowMs: options.minimumWindowMs }
        : {}),
    },
  );

  switch (outcome.kind) {
    case "ok":
      return outcome.summary;
    case "missing":
      return { error: `运行 ${outcome.runId} 不存在。` };
    case "terminal":
      return {
        error: `运行 ${outcome.runId} 已经结束（${outcome.status}），不能重复执行。`,
      };
    case "invalid":
      return { error: `运行 ${outcome.runId} 无法收尾：${outcome.reason}` };
  }
}

/** Strip Runner-only fields before handing the payload to `prepare`. */
function stripRunOnlyFields(input: RunPerformanceTestInput): Record<string, unknown> {
  const { repetitions: _repetitions, ...rest } = input;
  return rest;
}
