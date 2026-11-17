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

/**
 * The part of a trace that counts as the measurement.
 *
 * The hitches pass records with `xctrace --launch`, so the cold-launch frames
 * live in the same trace as the scene actions. Without a window the launch
 * hitch (hundreds of ms) would be scored as a scene regression, and the metric
 * would change meaning whenever launch time changed.
 */
export interface HitchWindow {
  /** Inclusive start, relative to the trace start. */
  fromMs: number;
  /** Exclusive end, relative to the trace start. */
  toMs: number;
}

/**
 * Evidence that the declared window contained no frames.
 *
 * The Runner uses the trace-wide frame timeline to attempt one bounded shift
 * instead of scoring the empty window as `hitches = 0`. Keeping this in the
 * analysis result (rather than auto-aligning here) preserves the parser's
 * contract: it reports what the trace contains, the Runner decides whether the
 * measurement can be salvaged.
 */
export interface HitchWindowMiss {
  /** Window the caller declared. */
  window: HitchWindow;
  /** Sorted frame starts across the whole trace, in trace-relative ms. */
  frameStartsMs: number[];
  /** Total frames in the trace before the window filter. */
  totalFrames: number;
}

export interface AnimationHitchesAnalysis {
  template: "Animation Hitches";
  /** Table the analyzer read: `hitches-frame-lifetimes` or `hitches`. */
  table: "hitches-frame-lifetimes" | "hitches";
  frameCount: number;
  /**
   * Window the metric was computed over. Absent means "the whole trace",
   * which is only correct for `--attach`/`--all-processes` recordings.
   */
  window?: HitchWindow & { framesOutside: number };
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
  /** Present when a declared window contained no frames. */
  windowMiss?: HitchWindowMiss;
}

export interface AnimationHitchesOptions {
  /**
   * Table to export. `hitches-frame-lifetimes` is the full frame table used
   * by current xctrace versions; `hitches` is the sparse legacy hang list.
   */
  table?: "hitches-frame-lifetimes" | "hitches";
  /** Keep at most this many of the longest hitches in `topHitches`. */
  topLimit?: number;
  /**
   * Restrict the metric to this trace-relative window. Required for
   * `--launch` recordings so the cold-start frames are not scored.
   */
  window?: HitchWindow;
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
  window?: HitchWindow,
): AnimationHitchesAnalysis {
  const warnings: string[] = [];
  let skippedRows = 0;

  interface Frame {
    startMs: number;
    durationMs: number;
    color: string | null;
  }

  let frames: Frame[] = [];
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

  // Frames before `fromMs` are the cold-launch burst: they are real hitches,
  // they just do not belong to the scene. Frames after `toMs` are the tail of
  // the recording (the session is stopped after the last action).
  //
  // Keep the full timeline for a possible alignment attempt: if the window
  // misses every frame, the Runner needs the trace's frame offsets to tell a
  // recording offset from a scene that genuinely produced no frames.
  const allFrameStarts = frames
    .map((frame) => frame.startMs)
    .sort((left, right) => left - right);
  let windowMiss: HitchWindowMiss | undefined;
  let framesOutside = 0;
  if (window !== undefined) {
    if (!(window.toMs > window.fromMs)) {
      throw new Error(
        `Animation Hitches window is empty (${window.fromMs}ms..${window.toMs}ms); the scenario actions must occupy measurable time`,
      );
    }
    const inside = frames.filter(
      (frame) => frame.startMs >= window.fromMs && frame.startMs < window.toMs,
    );
    framesOutside = frames.length - inside.length;
    frames = inside;
    if (frames.length === 0) {
      warnings.push(
        `No frames between ${window.fromMs}ms and ${window.toMs}ms; the window missed the recorded interaction.`,
      );
      windowMiss = { window, frameStartsMs: allFrameStarts, totalFrames: allFrameStarts.length };
    }
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
      ...(window !== undefined ? { window: { ...window, framesOutside } } : {}),
      ...(windowMiss !== undefined ? { windowMiss } : {}),
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
    ...(window !== undefined ? { window: { ...window, framesOutside } } : {}),
    ...(windowMiss !== undefined ? { windowMiss } : {}),
  };
}

/**
 * Parse the legacy `hitches` table: already-classified hang rows, optionally
 * scoped to one process. Rows without a duration are skipped.
 */
function analyzeHangRows(
  table: TraceTable,
  topLimit: number,
  window?: HitchWindow,
): AnimationHitchesAnalysis {
  const warnings: string[] = [];
  const durations: number[] = [];
  const hitches: HitchEvent[] = [];
  const severityCounts = emptySeverityCounts();
  let skippedRows = 0;
  let framesOutside = 0;

  if (window !== undefined && !(window.toMs > window.fromMs)) {
    throw new Error(
      `Animation Hitches window is empty (${window.fromMs}ms..${window.toMs}ms); the scenario actions must occupy measurable time`,
    );
  }

  for (const row of table.rows) {
    const durationNs = columnNumber(table, row, "duration");
    if (durationNs === undefined || durationNs <= 0) {
      skippedRows += 1;
      continue;
    }
    const startNs = columnNumber(table, row, "start") ?? 0;
    const startMs = startNs / NS_PER_MS;
    if (
      window !== undefined &&
      (startMs < window.fromMs || startMs >= window.toMs)
    ) {
      framesOutside += 1;
      continue;
    }
    const durationMs = durationNs / NS_PER_MS;
    const severity = classifyHitch(durationMs);
    durations.push(durationMs);
    severityCounts[severity] += 1;
    hitches.push({
      startMs: round(startMs, 1),
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
  // The legacy `hitches` table reports already-classified hang rows, not
  // frames. Zero rows in the window is a valid `hitches = 0` (a healthy,
  // smooth scene), so it must never be treated as a window miss or fed to the
  // frame-timeline alignment path.
  if (window !== undefined && framesOutside > 0 && hitches.length === 0) {
    // The trace did hang, just not inside the declared window. That is weak
    // evidence for the scene, not proof it was smooth: say so instead of
    // letting a bare `hitches = 0` read as healthy.
    warnings.push(
      `All ${framesOutside} hang row(s) fall outside the declared window ${window.fromMs}–${window.toMs}ms; hitches=0 only describes that window.`,
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
    ...(window !== undefined ? { window: { ...window, framesOutside } } : {}),
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
    return analyzeFrameLifetimes(table, topLimit, options.window);
  }
  if (table.schemaName === "hitches") {
    return analyzeHangRows(table, topLimit, options.window);
  }
  throw new Error(
    `Unsupported Animation Hitches table "${table.schemaName || "(unknown)"}".`,
  );
}

export interface HitchWindowAlignmentOptions {
  /** Maximum absolute shift from the declared window start. Defaults to its width. */
  maxShiftMs?: number;
  /** Frames the aligned window must contain. Defaults to 2. */
  minFrames?: number;
  /** Windows starting before this offset belong to startup, not the scene. */
  excludeBeforeMs?: number;
}

export interface HitchWindowAlignment {
  window: HitchWindow;
  shiftMs: number;
  frameCount: number;
}

export type HitchWindowAlignmentResult =
  | { ok: true; alignment: HitchWindowAlignment }
  | { ok: false; reason: string };

const DEFAULT_ALIGNMENT_MIN_FRAMES = 2;
const DEFAULT_ALIGNMENT_EXCLUDE_BEFORE_MS = 1_000;

function countFramesInRange(
  starts: readonly number[],
  fromMs: number,
  toMs: number,
): number {
  let count = 0;
  for (const start of starts) {
    if (start < fromMs) continue;
    if (start >= toMs) break;
    count += 1;
  }
  return count;
}

/**
 * Attempt one bounded shift of a window that missed every frame.
 *
 * The candidate window must keep the declared width (so hitches are comparable)
 * and may start at most one window-width away from the original. Candidates
 * that begin inside the first second are rejected: those frames are the cold
 * launch, not the scenario. Ranking is deterministic: most frames, then the
 * smallest shift, then the earliest start.
 */
export function alignHitchWindow(
  miss: HitchWindowMiss,
  options: HitchWindowAlignmentOptions = {},
): HitchWindowAlignmentResult {
  const width = miss.window.toMs - miss.window.fromMs;
  if (!Number.isFinite(width) || width <= 0) {
    return { ok: false, reason: `the declared window width is ${width}ms` };
  }
  const maxShiftMs = options.maxShiftMs ?? width;
  const minFrames = options.minFrames ?? DEFAULT_ALIGNMENT_MIN_FRAMES;
  const excludeBeforeMs =
    options.excludeBeforeMs ?? DEFAULT_ALIGNMENT_EXCLUDE_BEFORE_MS;

  const starts = miss.frameStartsMs
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (starts.length === 0) {
    return { ok: false, reason: "the trace contains no usable frame timestamps" };
  }

  const candidates: Array<{
    fromMs: number;
    shiftMs: number;
    frameCount: number;
  }> = [];
  for (const fromMs of starts) {
    const shiftMs = fromMs - miss.window.fromMs;
    if (fromMs < excludeBeforeMs || Math.abs(shiftMs) > maxShiftMs) {
      continue;
    }
    const frameCount = countFramesInRange(starts, fromMs, fromMs + width);
    if (frameCount < minFrames) {
      continue;
    }
    candidates.push({ fromMs, shiftMs, frameCount });
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      reason:
        `no ${width}ms window within ${maxShiftMs}ms of the declared window ` +
        `contains at least ${minFrames} frames after the first ${excludeBeforeMs}ms`,
    };
  }

  candidates.sort(
    (left, right) =>
      right.frameCount - left.frameCount ||
      Math.abs(left.shiftMs) - Math.abs(right.shiftMs) ||
      left.fromMs - right.fromMs,
  );
  const best = candidates[0]!;
  return {
    ok: true,
    alignment: {
      window: { fromMs: best.fromMs, toMs: best.fromMs + width },
      shiftMs: best.shiftMs,
      frameCount: best.frameCount,
    },
  };
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
