import type { MetricResult } from "../model/test-run.js";

/**
 * Canonical metric vocabulary for the iOS MVP (A3).
 *
 * Every canonical metric has one unit and one Instruments template so a
 * report from one Take is directly comparable to the next. Aliases exist
 * because older scenarios and user-authored Skills used looser names
 * (`memory`, `launch`, `blockingMs`).
 */
export interface MetricDefinition {
  name: string;
  unit: string;
  instrument: string;
  aliases: readonly string[];
  description: string;
}

export const MVP_METRIC_DEFINITIONS: readonly MetricDefinition[] = Object.freeze([
  {
    name: "hitches",
    unit: "次",
    instrument: "Animation Hitches",
    aliases: ["hitch", "hangs"],
    description: "Animation hang count during the Take.",
  },
  {
    name: "blockMs",
    unit: "ms",
    instrument: "Animation Hitches",
    aliases: ["block", "blocking", "blockingMs", "mainThreadBlockMs"],
    description: "Longest main-thread hang derived from Animation Hitches (D11).",
  },
  {
    name: "launchMs",
    unit: "ms",
    instrument: "App Launch",
    aliases: ["launch", "launchTime", "launchTimeMs", "startup"],
    description: "Cold/warm launch span from life-cycle-period rows.",
  },
  {
    name: "memoryMB",
    unit: "MB",
    instrument: "Activity Monitor",
    aliases: ["memory", "footprint", "footprintMB", "memoryMb"],
    description: "Median physical footprint from Activity Monitor (D12).",
  },
]);

const BY_CANONICAL = new Map<string, MetricDefinition>();
const BY_ALIAS = new Map<string, MetricDefinition>();

for (const definition of MVP_METRIC_DEFINITIONS) {
  BY_CANONICAL.set(definition.name.toLowerCase(), definition);
  for (const alias of definition.aliases) {
    BY_ALIAS.set(alias.toLowerCase(), definition);
  }
}

/** Resolve a metric name (canonical or alias) to its canonical name. */
export function canonicalMetricName(name: string): string {
  const key = name.trim().toLowerCase();
  return BY_CANONICAL.get(key)?.name ?? BY_ALIAS.get(key)?.name ?? name.trim();
}

/** Look up the canonical definition for a metric name, if it is an MVP metric. */
export function metricDefinition(name: string): MetricDefinition | undefined {
  const key = name.trim().toLowerCase();
  return BY_CANONICAL.get(key) ?? BY_ALIAS.get(key);
}

/** True when two metric names refer to the same canonical metric. */
export function sameMetric(a: string, b: string): boolean {
  return canonicalMetricName(a) === canonicalMetricName(b);
}

/**
 * Fill in the canonical name, unit, and instrument when the caller omitted
 * them. Unknown metrics (e.g. `cpu`) pass through unchanged so projects can
 * still add custom measurements.
 */
export function normalizeMetricResult(metric: MetricResult): MetricResult {
  const definition = metricDefinition(metric.name);
  if (!definition) {
    return metric;
  }
  return {
    ...metric,
    name: definition.name,
    unit: metric.unit ?? definition.unit,
    instrument: metric.instrument ?? definition.instrument,
  };
}

/** Normalize a list of metric results in one pass. */
export function normalizeMetricResults(metrics: MetricResult[]): MetricResult[] {
  return metrics.map(normalizeMetricResult);
}
