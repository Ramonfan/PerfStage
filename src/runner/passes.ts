import { canonicalMetricName } from "../analysis/metrics.js";
import type { RecordingTemplate } from "../recording/types.js";

/**
 * Which recording passes a Take needs.
 *
 * Instruments records one template per process, so the requested metrics
 * determine the number of sequential passes (D4). This module is pure: given
 * metric names it answers "what do we record and in which order", which makes
 * the planning testable without a device.
 */
export interface PassPlan {
  template: RecordingTemplate;
  /** Canonical metric names this pass yields, in report order. */
  metrics: string[];
  /** Fixed enumeration for diagnostics and report ordering. */
  index: number;
}

export interface PassPlanResult {
  passes: PassPlan[];
  /** Requested metrics PerfStage cannot collect on iOS today. */
  unsupported: string[];
}

const METRIC_TO_TEMPLATE: Record<string, RecordingTemplate> = {
  hitches: "hitches",
  blockMs: "hitches",
  launchMs: "launch",
  memoryMB: "memory",
};

/** Pass order is fixed so two Takes' summaries line up field by field. */
const TEMPLATE_ORDER: readonly RecordingTemplate[] = [
  "hitches",
  "launch",
  "memory",
];

/**
 * Map requested metrics onto recording passes.
 *
 * `hitches` and `blockMs` share one Animation Hitches pass; that is what makes
 * the default four-metric Take cost three passes instead of four.
 */
export function planPasses(requested: readonly string[]): PassPlanResult {
  const byTemplate = new Map<RecordingTemplate, string[]>();
  const unsupported: string[] = [];

  for (const raw of requested) {
    const name = canonicalMetricName(raw);
    const template = METRIC_TO_TEMPLATE[name];
    if (template === undefined) {
      if (!unsupported.includes(name)) {
        unsupported.push(name);
      }
      continue;
    }
    const bucket = byTemplate.get(template);
    if (bucket === undefined) {
      byTemplate.set(template, [name]);
    } else if (!bucket.includes(name)) {
      bucket.push(name);
    }
  }

  const passes: PassPlan[] = [];
  for (const template of TEMPLATE_ORDER) {
    const metrics = byTemplate.get(template);
    if (metrics === undefined) continue;
    passes.push({ template, metrics, index: passes.length + 1 });
  }

  return { passes, unsupported };
}

/** Template by canonical metric name, or `null` when unsupported. */
export function templateForMetric(metric: string): RecordingTemplate | null {
  return METRIC_TO_TEMPLATE[canonicalMetricName(metric)] ?? null;
}
