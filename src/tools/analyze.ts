import { z } from "zod";
import type {
  AnimationHitchesAnalysis,
  AnimationHitchesOptions,
} from "../analysis/parsers/animation-hitches.js";
import { analyzeHitchesTrace } from "../analysis/parsers/animation-hitches.js";
import type { AppLaunchAnalysis } from "../analysis/parsers/app-launch.js";
import { analyzeAppLaunchTrace } from "../analysis/parsers/app-launch.js";
import type { ActivityMonitorAnalysis } from "../analysis/parsers/activity-monitor.js";
import {
  analyzeActivityMonitorTrace,
  memoryMetricValue,
} from "../analysis/parsers/activity-monitor.js";
import type { MetricResult } from "../model/test-run.js";

const templateSchema = z.enum(["hitches", "launch", "memory"]);

export const analyzeTraceInputSchema = z
  .object({
    template: templateSchema,
    /** Absolute path to a `.trace` bundle produced by instruments-mcp. */
    tracePath: z.string().min(1),
    /** Target process display name (`NN` for xctrace, `NNIM` for memory). */
    processName: z.string().min(1).optional(),
    /** Target pid, preferred over process name when present. */
    pid: z.number().int().positive().optional(),
    /** Animation Hitches table; defaults to the full frame lifetime table. */
    table: z.enum(["hitches-frame-lifetimes", "hitches"]).optional(),
  })
  .strict();

export type AnalyzeTraceInput = z.infer<typeof analyzeTraceInputSchema>;

export interface AnalyzeTraceResult {
  template: AnalyzeTraceInput["template"];
  tracePath: string;
  metrics: MetricResult[];
  warnings: string[];
  /** Template-specific analysis, trimmed for tool output. */
  analysis: Record<string, unknown>;
}

/** Map an Animation Hitches analysis to the two canonical metrics (D11). */
export function hitchesMetrics(
  analysis: AnimationHitchesAnalysis,
  tracePath: string,
): MetricResult[] {
  return [
    {
      name: "hitches",
      value: analysis.hitches,
      unit: "次",
      instrument: "Animation Hitches",
      tracePath,
      measuredAt: new Date().toISOString(),
    },
    {
      name: "blockMs",
      value: analysis.blockMs,
      unit: "ms",
      instrument: "Animation Hitches",
      tracePath,
      measuredAt: new Date().toISOString(),
    },
  ];
}

/** Map an App Launch analysis to `launchMs`; omit the value when unknown. */
export function launchMetrics(
  analysis: AppLaunchAnalysis,
  tracePath: string,
): MetricResult[] {
  return [
    {
      name: "launchMs",
      ...(analysis.launchMs !== null ? { value: analysis.launchMs } : {}),
      unit: "ms",
      instrument: "App Launch",
      tracePath,
      measuredAt: new Date().toISOString(),
    },
  ];
}

/** Map an Activity Monitor analysis to `memoryMB` (median footprint, D12). */
export function memoryMetrics(
  analysis: ActivityMonitorAnalysis,
  tracePath: string,
): MetricResult[] {
  return [
    {
      name: "memoryMB",
      value: memoryMetricValue(analysis),
      unit: "MB",
      instrument: "Activity Monitor",
      tracePath,
      measuredAt: new Date().toISOString(),
    },
  ];
}

/**
 * Parse a recorded trace and return the canonical metric results.
 *
 * This is the bridge between D13 (PerfStage owns parsing) and the Skill
 * contract: the recorder produces a trace, this tool turns it into the
 * `metrics` array that `finalize_performance_test` consumes.
 */
export async function analyzePerformanceTrace(
  rawInput: unknown,
): Promise<AnalyzeTraceResult | { error: string }> {
  const parsed = analyzeTraceInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      error: `analyze_performance_trace 输入校验失败：${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    };
  }
  const input = parsed.data;

  try {
    if (input.template === "hitches") {
      const options: AnimationHitchesOptions = {
        ...(input.table !== undefined ? { table: input.table } : {}),
      };
      const analysis = await analyzeHitchesTrace(input.tracePath, options);
      const { topHitches, ...rest } = analysis;
      return {
        template: input.template,
        tracePath: input.tracePath,
        metrics: hitchesMetrics(analysis, input.tracePath),
        warnings: analysis.warnings,
        analysis: { ...rest, topHitches: topHitches.slice(0, 5) },
      };
    }

    if (input.template === "launch") {
      const analysis = await analyzeAppLaunchTrace(input.tracePath, {
        ...(input.processName !== undefined
          ? { processName: input.processName }
          : {}),
      });
      return {
        template: input.template,
        tracePath: input.tracePath,
        metrics: launchMetrics(analysis, input.tracePath),
        warnings: analysis.warnings,
        analysis: { ...analysis },
      };
    }

    const analysis = await analyzeActivityMonitorTrace(input.tracePath, {
      ...(input.pid !== undefined ? { pid: input.pid } : {}),
      ...(input.processName !== undefined
        ? { processName: input.processName }
        : {}),
    });
    return {
      template: input.template,
      tracePath: input.tracePath,
      metrics: memoryMetrics(analysis, input.tracePath),
      warnings: analysis.warnings,
      analysis: {
        pid: analysis.pid,
        processName: analysis.processName,
        selection: analysis.selection,
        summary: analysis.summary,
        seriesMiB: analysis.seriesMiB,
        processCount: analysis.processes.length,
      },
    };
  } catch (error) {
    return {
      error: `分析 ${input.template} trace 失败：${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
