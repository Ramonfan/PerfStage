import { exportTraceTable } from "../trace/export.js";
import {
  columnNumber,
  columnText,
  parseTraceTable,
  type TraceTable,
} from "../trace/xml.js";

export type HitchSeverity = "micro" | "minor" | "warning" | "critical";

export interface HitchEvent {
  /** Start time relative to the trace start. */
  startMs: number;
  durationMs: number;
  /** Instruments frame color (`Green`, `Purple`, `Brown`, ...). */
  color: string | null;
  severity: HitchSeverity;
}

export interface ColorCounts {
  green: number;
  purple: number;
  brown: number;
  yellow: number;
  other: number;
  none: number;
}

export interface SeverityCounts {
  micro: number;
  minor: number;
  warning: number;
  critical: number;
}

export interface AnimationHitchesAnalysis {
  template: "Animation Hitches";
  /** Table the analyzer read: `hitches-frame-lifetimes` or `hitches`. */
  table: "hitches-frame-lifetimes" | "hitches";
  frameCount: number;
  /** Median frame duration, used as the observed vsync target. */
  targetFrameMs: number;
  /** Frames above this duration are hitches even when colored green. */
  hitchThresholdMs: number;
  /** `hitches` metric: number of hitched frames. */
  hitches: number;
  /** `blockMs` metric: longest hitched frame duration (D11). */
  blockMs: number | null;
  /** Sum of excess time over the target for hitched frames. */
  estimatedHitchTimeMs: number;
  colorCounts: ColorCounts;
  severityCounts: SeverityCounts;
  topHitches: HitchEvent[];
  warnings: string[];
}

export interface AnimationHitchesOptions {
  /**
   * Table to export. `hitches-frame-lifetimes` is the full frame table used
   * by current xctrace versions; `hitches` is the sparse legacy hang list.
   */
  table?: "hitches-frame-lifetimes" | "hitches";
  /** Keep at most this many of the longest hitches in `topHitches`. */
  topLimit?: number;
}

const NS_PER_MS = 1_000_000;
/** A green frame this much longer than the target still counts as a hitch. */
const HITCH_FACTOR = 1.3;

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index];
}

/** Mirrors the instruments-mcp severity bands so reports stay comparable. */
export function classifyHitch(durationMs: number): HitchSeverity {
  if (durationMs > 1000) return "critical";
  if (durationMs > 250) return "warning";
  if (durationMs > 100) return "minor";
  return "micro";
}

function emptyColorCounts(): ColorCounts {
  return { green: 0, purple: 0, brown: 0, yellow: 0, other: 0, none: 0 };
}

function emptySeverityCounts(): SeverityCounts {
  return { micro: 0, minor: 0, warning: 0, critical: 0 };
}

function countColor(counts: ColorCounts, color: string | null): void {
  switch (color) {
    case "Green":
      counts.green += 1;
      break;
    case "Purple":
      counts.purple += 1;
      break;
    case "Brown":
      counts.brown += 1;
      break;
    case "Yellow":
      counts.yellow += 1;
      break;
    case null:
      counts.none += 1;
      break;
    default:
      counts.other += 1;
      break;
  }
}

function isHitched(color: string | null, durationMs: number, thresholdMs: number): boolean {
  if (color !== null && color !== "Green") {
    return true;
  }
  return durationMs > thresholdMs;
}

/**
 * Parse the `hitches-frame-lifetimes` table: one row per displayed frame,
 * with a duration and an Instruments frame color.
 */
function analyzeFrameLifetimes(
  table: TraceTable,
  topLimit: number,
): AnimationHitchesAnalysis {
  const warnings: string[] = [];
  let skippedRows = 0;

  interface Frame {
    startMs: number;
    durationMs: number;
    color: string | null;
  }

  const frames: Frame[] = [];
  for (const row of table.rows) {
    const durationNs = columnNumber(table, row, "duration");
    const startNs = columnNumber(table, row, "start");
    if (durationNs === undefined || durationNs <= 0) {
      skippedRows += 1;
      continue;
    }
    frames.push({
      startMs: startNs === undefined ? 0 : startNs / NS_PER_MS,
      durationMs: durationNs / NS_PER_MS,
      color: columnText(table, row, "frame-color") ?? null,
    });
  }

  if (skippedRows > 0) {
    warnings.push(
      `Skipped ${skippedRows} frame row(s) without a usable duration.`,
    );
  }

  if (frames.length === 0) {
    return {
      template: "Animation Hitches",
      table: "hitches-frame-lifetimes",
      frameCount: 0,
      targetFrameMs: 0,
      hitchThresholdMs: 0,
      hitches: 0,
      blockMs: null,
      estimatedHitchTimeMs: 0,
      colorCounts: emptyColorCounts(),
      severityCounts: emptySeverityCounts(),
      topHitches: [],
      warnings: [...warnings, "No frame rows in the trace."],
    };
  }

  const durations = frames.map((frame) => frame.durationMs).sort((a, b) => a - b);
  const targetFrameMs = percentile(durations, 0.5);
  const hitchThresholdMs = targetFrameMs * HITCH_FACTOR;

  const colorCounts = emptyColorCounts();
  const severityCounts = emptySeverityCounts();
  const hitches: HitchEvent[] = [];
  let estimatedHitchTimeMs = 0;

  for (const frame of frames) {
    countColor(colorCounts, frame.color);
    if (!isHitched(frame.color, frame.durationMs, hitchThresholdMs)) {
      continue;
    }
    const severity = classifyHitch(frame.durationMs);
    severityCounts[severity] += 1;
    estimatedHitchTimeMs += Math.max(0, frame.durationMs - targetFrameMs);
    hitches.push({
      startMs: round(frame.startMs, 1),
      durationMs: round(frame.durationMs, 1),
      color: frame.color,
      severity,
    });
  }

  const longest = Math.max(0, ...hitches.map((hitch) => hitch.durationMs));

  return {
    template: "Animation Hitches",
    table: "hitches-frame-lifetimes",
    frameCount: frames.length,
    targetFrameMs: round(targetFrameMs, 2),
    hitchThresholdMs: round(hitchThresholdMs, 2),
    hitches: hitches.length,
    blockMs: hitches.length === 0 ? 0 : round(longest, 1),
    estimatedHitchTimeMs: round(estimatedHitchTimeMs, 1),
    colorCounts,
    severityCounts,
    topHitches: [...hitches]
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, topLimit),
    warnings,
  };
}

/**
 * Parse the legacy `hitches` table: already-classified hang rows, optionally
 * scoped to one process. Rows without a duration are skipped.
 */
function analyzeHangRows(
  table: TraceTable,
  topLimit: number,
): AnimationHitchesAnalysis {
  const warnings: string[] = [];
  const durations: number[] = [];
  const hitches: HitchEvent[] = [];
  const severityCounts = emptySeverityCounts();
  let skippedRows = 0;

  for (const row of table.rows) {
    const durationNs = columnNumber(table, row, "duration");
    if (durationNs === undefined || durationNs <= 0) {
      skippedRows += 1;
      continue;
    }
    const startNs = columnNumber(table, row, "start") ?? 0;
    const durationMs = durationNs / NS_PER_MS;
    const severity = classifyHitch(durationMs);
    durations.push(durationMs);
    severityCounts[severity] += 1;
    hitches.push({
      startMs: round(startNs / NS_PER_MS, 1),
      durationMs: round(durationMs, 1),
      color: null,
      severity,
    });
  }

  if (skippedRows > 0) {
    warnings.push(
      `Skipped ${skippedRows} hang row(s) without a usable duration.`,
    );
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const longest = sorted.length > 0 ? sorted[sorted.length - 1] : 0;

  return {
    template: "Animation Hitches",
    table: "hitches",
    frameCount: 0,
    targetFrameMs: 0,
    hitchThresholdMs: 0,
    hitches: hitches.length,
    blockMs: hitches.length === 0 ? 0 : round(longest, 1),
    estimatedHitchTimeMs: 0,
    colorCounts: emptyColorCounts(),
    severityCounts,
    topHitches: [...hitches]
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, topLimit),
    warnings,
  };
}

/** Analyze an Animation Hitches trace table. */
export function analyzeHitchesXml(
  xml: string,
  options: AnimationHitchesOptions = {},
): AnimationHitchesAnalysis {
  const table = parseTraceTable(xml);
  const topLimit = options.topLimit ?? 20;

  if (table.schemaName === "hitches-frame-lifetimes") {
    return analyzeFrameLifetimes(table, topLimit);
  }
  if (table.schemaName === "hitches") {
    return analyzeHangRows(table, topLimit);
  }
  throw new Error(
    `Unsupported Animation Hitches table "${table.schemaName || "(unknown)"}".`,
  );
}

/**
 * Export and analyze an Animation Hitches trace. PerfStage owns this parsing
 * (D13); `instruments-mcp` only records the trace.
 */
export async function analyzeHitchesTrace(
  tracePath: string,
  options: AnimationHitchesOptions & { timeoutMs?: number } = {},
): Promise<AnimationHitchesAnalysis> {
  const table = options.table ?? "hitches-frame-lifetimes";
  const xml = await exportTraceTable(tracePath, table, {
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  return analyzeHitchesXml(xml, options);
}
