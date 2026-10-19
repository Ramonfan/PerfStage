import { z } from "zod";
import { loadAllScenarios } from "../scenario/loader.js";
import type { TestPlan } from "../model/test-plan.js";
import type { RegisterOptions } from "./index.js";

/**
 * Input shape for `list_performance_scenarios`. The tool takes no parameters;
 * it scans the current scenario directory on every call so updates become
 * visible without restarting the server.
 */
export const listScenariosInputSchema = z.object({});

export interface ListPerformanceScenariosEntry {
  id: string;
  name: string;
  bundleId: string;
  actionCount: number;
  metricNames: string[];
  diagnostics: TestPlan["diagnostics"];
  analysisFocus: TestPlan["analysisFocus"];
}

export interface ListPerformanceScenariosResult {
  scenarios: ListPerformanceScenariosEntry[];
}

export interface ListPerformanceScenariosError {
  error: string;
}

type HandlerResult =
  | ListPerformanceScenariosResult
  | ListPerformanceScenariosError;

function toEntry(plan: TestPlan): ListPerformanceScenariosEntry {
  const id = plan.id ?? plan.name ?? "未命名场景";
  return {
    id,
    name: plan.name ?? id,
    bundleId: plan.app.bundleId,
    actionCount: plan.actions.length,
    metricNames: plan.metrics.map((m) => m.name),
    diagnostics: plan.diagnostics,
    analysisFocus: plan.analysisFocus,
  };
}

/**
 * Implementation backing both the production MCP tool and the test harness.
 *
 * The directory is re-read on every invocation so editing YAML files is
 * reflected immediately. The scenario directory comes from the resolved
 * workspace (or a legacy test injection) — never from a package-relative
 * default — so each project only sees its own scenarios. Malformed
 * scenarios propagate as a structured tool error containing the
 * originating file path; they are not silently dropped.
 */
export async function listPerformanceScenarios(
  options: RegisterOptions,
): Promise<HandlerResult> {
  if (typeof options.scenarioDir !== "string" || options.scenarioDir.length === 0) {
    return {
      error:
        "list_performance_scenarios 缺少工作区 scenarioDirectory；请先调用 initialize_performance_workspace。",
    };
  }
  let plans: TestPlan[];
  try {
    plans = await loadAllScenarios(options.scenarioDir);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    return {
      error: `无法枚举场景：${message}`,
    };
  }

  const sorted: TestPlan[] = [...plans].sort((left, right) => {
    const leftId = left.id ?? left.name ?? "";
    const rightId = right.id ?? right.name ?? "";
    return leftId.localeCompare(rightId);
  });
  const entries = sorted.map(toEntry);
  return { scenarios: entries };
}
