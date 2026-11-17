import type { PageFaults } from "../../model/test-run.js";
import { exportTraceTable } from "../trace/export.js";
import {
  columnFmt,
  columnText,
  parseTraceTable,
  type TraceTable,
} from "../trace/xml.js";

export type LaunchType = "cold" | "warm" | "resume" | "unknown";

export interface LaunchPhase {
  /** Lifecycle period label, e.g. `Launching - Initial Frame Rendering`. */
  name: string;
  startMs: number;
  endMs: number;
  durationMs: number;
}

export interface DyldActivitySummary {
  activityCount: number;
  /** Earliest dyld activity start, relative to the trace start. */
  firstStartMs: number;
  /** Latest dyld activity end, relative to the trace start. */
  lastEndMs: number;
  spanMs: number;
  /** Duration reported for the process-creation (`Launch Executable`) row. */
  launchExecutableMs: number | null;
}

export interface AppLaunchAnalysis {
  template: "App Launch";
  processName: string | null;
  launchType: LaunchType;
  /** End of the last launch phase minus start of the first one. */
  launchMs: number | null;
  phases: LaunchPhase[];
  rowCount: number;
  dyld: DyldActivitySummary | null;
  /**
   * Main-thread fault summary from `virtual-memory`, scoped to the same
   * process and window as `launchMs`. Absent means "not measured"; it is never
   * an implicit 0. Purely diagnostic: it must not feed thresholds or `gate`.
   */
  pageFaults?: PageFaults;
  warnings: string[];
}

export interface AppLaunchOptions {
  /** Target process display name (`NN`), matched case-insensitively. */
  processName?: string;
  /** Export and summarize the dyld table as well. Defaults to true. */
  includeDyld?: boolean;
  /**
   * Export and summarize `virtual-memory` as well. Defaults to true; pass
   * `false` when a caller only needs `launchMs`.
   */
  includePageFaults?: boolean;
}

interface LaunchRow {
  startMs: number;
  endMs: number;
  processName: string;
  period: string;
}

const NS_PER_MS = 1_000_000;
const FOREGROUND_PREFIXES = ["foreground", "background", "terminated"];

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Turn `NNIM (6764)` into `NNIM`; leave names without a pid suffix alone. */
export function normalizeProcessName(displayName: string): string {
  return displayName.replace(/\s*\(\d+\)\s*$/, "").trim();
}

function isLaunchPeriod(period: string): boolean {
  const normalized = period.trim().toLowerCase();
  if (FOREGROUND_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return false;
  }
  return (
    normalized.startsWith("initializing") ||
    normalized.startsWith("launching") ||
    normalized.includes("initial frame") ||
    normalized.includes("pre-main") ||
    normalized.includes("process creation")
  );
}

function readLaunchRows(table: TraceTable): LaunchRow[] {
  const rows: LaunchRow[] = [];
  for (const row of table.rows) {
    const period = columnText(table, row, "period");
    const startNs = columnText(table, row, "start");
    const durationNs = columnText(table, row, "duration");
    if (!period || !startNs) {
      continue;
    }
    const startMs = Number(startNs) / NS_PER_MS;
    const durationMs = durationNs ? Number(durationNs) / NS_PER_MS : 0;
    if (!Number.isFinite(startMs)) {
      continue;
    }
    const processFmt = columnFmt(table, row, "process") ?? "";
    rows.push({
      startMs,
      endMs: startMs + (Number.isFinite(durationMs) ? durationMs : 0),
      processName: normalizeProcessName(processFmt),
      period: period.trim(),
    });
  }
  return rows;
}

function selectProcess(
  rows: LaunchRow[],
  requested: string | undefined,
  warnings: string[],
): string | null {
  const names = [...new Set(rows.map((row) => row.processName).filter(Boolean))];
  if (requested) {
    const match = names.find(
      (name) => name.toLowerCase() === normalizeProcessName(requested).toLowerCase(),
    );
    if (match) {
      return match;
    }
    warnings.push(
      `Process "${requested}" had no lifecycle periods in this trace; available: ${
        names.join(", ") || "(none)"
      }.`,
    );
    return null;
  }
  if (names.length === 0) {
    return null;
  }
  if (names.length === 1) {
    return names[0];
  }

  // Several processes can appear in an all-processes launch trace. Prefer the
  // one with the most lifecycle rows; that is the app the template launched.
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.processName, (counts.get(row.processName) ?? 0) + 1);
  }
  const selected = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  warnings.push(
    `Multiple processes reported lifecycle periods (${names.join(", ")}); using "${selected}".`,
  );
  return selected;
}

function toPhases(rows: LaunchRow[]): LaunchPhase[] {
  // Lifecycle rows are a hierarchy, not a flat phase list: short child rows can
  // repeat the parent's period label and are interleaved with sibling phases.
  // Preserve each row as its own phase (sorted by start) so the report never
  // hides measured intervals behind a label-keyed merge.
  return rows
    .map((row) => ({
      name: row.period,
      startMs: round(row.startMs, 2),
      endMs: round(row.endMs, 2),
      durationMs: round(row.endMs - row.startMs, 2),
    }))
    .sort((a, b) => a.startMs - b.startMs);
}

function detectLaunchType(phases: LaunchPhase[]): LaunchType {
  const names = phases.map((phase) => phase.name.toLowerCase());
  if (names.some((name) => name.startsWith("initializing"))) {
    return "cold";
  }
  if (names.some((name) => name.includes("resume"))) {
    return "resume";
  }
  if (names.length > 0) {
    return "warm";
  }
  return "unknown";
}

/**
 * Parse the `life-cycle-period` table of an App Launch trace.
 *
 * `launchMs` spans the first launch-related lifecycle period through the end of
 * the last one (normally `Launching - Initial Frame Rendering`). Foreground and
 * background periods are excluded so a long recording does not inflate the
 * launch number.
 */
export function parseAppLaunchTable(
  xml: string,
  options: AppLaunchOptions = {},
): AppLaunchAnalysis {
  const table = parseTraceTable(xml);
  const warnings: string[] = [];

  if (table.columns.length === 0) {
    return {
      template: "App Launch",
      processName: null,
      launchType: "unknown",
      launchMs: null,
      phases: [],
      rowCount: 0,
      dyld: null,
      warnings: ["Trace table has no schema columns."],
    };
  }

  const rows = readLaunchRows(table);
  const processName = selectProcess(rows, options.processName, warnings);
  // When a caller explicitly requested a process that is absent, do not fall
  // back to every process in the trace — that would silently report another
  // app's launch time.
  const selectedRows =
    options.processName !== undefined
      ? rows.filter((row) => row.processName === processName)
      : rows;
  const launchRows = selectedRows.filter((row) => isLaunchPeriod(row.period));

  if (launchRows.length === 0) {
    warnings.push(
      "No launch lifecycle periods found. Use launch_path (bundle id) when recording so xctrace starts the app.",
    );
    return {
      template: "App Launch",
      processName,
      launchType: "unknown",
      launchMs: null,
      phases: [],
      rowCount: selectedRows.length,
      dyld: null,
      warnings,
    };
  }

  const phases = toPhases(launchRows);
  const firstStart = Math.min(...launchRows.map((row) => row.startMs));
  const lastEnd = Math.max(...launchRows.map((row) => row.endMs));
  const launchMs = round(lastEnd - firstStart, 2);

  return {
    template: "App Launch",
    processName,
    launchType: detectLaunchType(phases),
    launchMs: launchMs > 0 ? launchMs : null,
    phases,
    rowCount: selectedRows.length,
    dyld: null,
    warnings,
  };
}

/** Parse `dyld-activity-interval` into a diagnostic pre-main summary. */
export function parseDyldActivityTable(
  xml: string,
  options: Pick<AppLaunchOptions, "processName"> = {},
): DyldActivitySummary | null {
  const table = parseTraceTable(xml);
  const target = options.processName
    ? normalizeProcessName(options.processName).toLowerCase()
    : undefined;

  const activities: Array<{ startMs: number; endMs: number; type: string }> = [];
  for (const row of table.rows) {
    const startNs = columnText(table, row, "start");
    if (!startNs) {
      continue;
    }
    const processFmt = columnFmt(table, row, "process") ?? "";
    const processName = normalizeProcessName(processFmt).toLowerCase();
    if (target && processName !== target) {
      continue;
    }
    const startMs = Number(startNs) / NS_PER_MS;
    const durationNs = columnText(table, row, "duration");
    const durationMs = durationNs ? Number(durationNs) / NS_PER_MS : 0;
    activities.push({
      startMs,
      endMs: startMs + (Number.isFinite(durationMs) ? durationMs : 0),
      type: columnText(table, row, "type") ?? "",
    });
  }

  if (activities.length === 0) {
    return null;
  }

  const firstStartMs = Math.min(...activities.map((row) => row.startMs));
  const lastEndMs = Math.max(...activities.map((row) => row.endMs));
  const launchExecutable = activities.find((row) => row.type === "Launch Executable");

  return {
    activityCount: activities.length,
    firstStartMs: round(firstStartMs, 2),
    lastEndMs: round(lastEndMs, 2),
    spanMs: round(lastEndMs - firstStartMs, 2),
    launchExecutableMs:
      launchExecutable === undefined
        ? null
        : round(launchExecutable.endMs - launchExecutable.startMs, 2),
  };
}

/**
 * Summarize `virtual-memory` faults for one process's main thread inside a
 * trace-relative window.
 *
 * The window must be the same one `launchMs` spans. Counts and durations are
 * measurement facts only: callers may persist them, but they must not change
 * metric values, thresholds or `gate`. Returns `null` when the table has no
 * row in scope so callers can distinguish "not measured" from "zero faults".
 */
export function parseVirtualMemoryTable(
  xml: string,
  options: { processName?: string; window: { fromMs: number; toMs: number } },
): PageFaults | null {
  const table = parseTraceTable(xml);
  if (table.columns.length === 0) {
    return null;
  }
  const target =
    options.processName !== undefined
      ? normalizeProcessName(options.processName).toLowerCase()
      : undefined;
  if (target === undefined || target.length === 0) {
    return null;
  }

  let fileBackedPageIns = 0;
  let fileBackedNs = 0;
  let totalFaults = 0;
  let totalNs = 0;

  for (const row of table.rows) {
    const thread = columnFmt(table, row, "thread") ?? "";
    if (!thread.startsWith("Main Thread")) {
      continue;
    }
    const processName = normalizeProcessName(
      columnFmt(table, row, "process") ?? "",
    ).toLowerCase();
    if (processName !== target) {
      continue;
    }
    const startNs = Number(columnText(table, row, "start"));
    if (!Number.isFinite(startNs)) {
      continue;
    }
    const startMs = startNs / NS_PER_MS;
    // Same bounds as `launchMs`: first lifecycle start inclusive, last end
    // exclusive, so a fault exactly at the end is not double counted as tail.
    if (startMs < options.window.fromMs || startMs >= options.window.toMs) {
      continue;
    }
    // A row without a usable duration still counts as a fault: dropping it
    // would undercount the event, while treating it as 0 ms only undercounts
    // time for that one row. `virtual-memory` normally always reports it.
    const durationNs = Number(columnText(table, row, "duration") ?? 0);
    const faultNs = Number.isFinite(durationNs) ? durationNs : 0;
    const operation = columnText(table, row, "operation") ?? "";
    totalFaults += 1;
    totalNs += faultNs;
    if (operation === "File Backed Page In") {
      fileBackedPageIns += 1;
      fileBackedNs += faultNs;
    }
  }

  if (totalFaults === 0) {
    return null;
  }
  return {
    fileBackedPageIns,
    fileBackedPageInMs: round(fileBackedNs / NS_PER_MS, 1),
    totalFaults,
    totalFaultMs: round(totalNs / NS_PER_MS, 1),
  };
}

/**
 * Best-effort page-fault attachment.
 *
 * A diagnostic field must never make `launchMs` fail: every failure path here
 * records a warning and leaves `pageFaults` absent. The exporter is injectable
 * so those failure paths are testable without a device or a real `xctrace`.
 */
export async function attachPageFaults(
  tracePath: string,
  analysis: AppLaunchAnalysis,
  exportTable: (tracePath: string, schema: string) => Promise<string> = exportTraceTable,
): Promise<void> {
  // Without a launch span there is no shared window to scope to, and the
  // lifecycle parser has already explained why (`launchMs` is null).
  if (analysis.phases.length === 0) {
    return;
  }
  // The spec requires a warning, not a silent omission, when the lifecycle
  // rows exist but do not identify a process: otherwise the reader cannot tell
  // "not measured" from "measured and zero".
  if (analysis.processName === null) {
    analysis.warnings.push(
      "virtual-memory page faults not measured: launch lifecycle rows did not identify a process.",
    );
    return;
  }
  // Reuse the reported phase bounds (rounded to 0.01 ms) so the window is
  // reproducible from `analysis.phases`. `launchMs` itself uses the unrounded
  // endpoints, so they can differ by at most 0.01 ms at the edges.
  const fromMs = Math.min(...analysis.phases.map((phase) => phase.startMs));
  const toMs = Math.max(...analysis.phases.map((phase) => phase.endMs));
  try {
    const xml = await exportTable(tracePath, "virtual-memory");
    const summary = parseVirtualMemoryTable(xml, {
      processName: analysis.processName,
      window: { fromMs, toMs },
    });
    if (summary === null) {
      analysis.warnings.push(
        "virtual-memory table contained no matching main-thread faults in the launch window (table missing, other process, or out of window).",
      );
      return;
    }
    analysis.pageFaults = summary;
  } catch (error) {
    analysis.warnings.push(
      `Could not read page faults: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Export and analyze an App Launch trace, optionally including the dyld summary.
 */
export async function analyzeAppLaunchTrace(
  tracePath: string,
  options: AppLaunchOptions = {},
): Promise<AppLaunchAnalysis> {
  const lifecycleXml = await exportTraceTable(tracePath, "life-cycle-period");
  const analysis = parseAppLaunchTable(lifecycleXml, options);

  if (options.includePageFaults !== false) {
    await attachPageFaults(tracePath, analysis);
  }

  if (options.includeDyld === false) {
    return analysis;
  }

  try {
    const dyldXml = await exportTraceTable(tracePath, "dyld-activity-interval");
    analysis.dyld = parseDyldActivityTable(dyldXml, {
      ...(options.processName !== undefined ? { processName: options.processName } : {}),
    });
    if (analysis.dyld === null) {
      analysis.warnings.push("dyld-activity-interval table contained no matching rows.");
    }
  } catch (error) {
    analysis.warnings.push(
      `Could not read dyld activity: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return analysis;
}

/** Convenience accessor for report/metric callers. */
export function launchMetricValue(analysis: AppLaunchAnalysis): number | null {
  return analysis.launchMs;
}
