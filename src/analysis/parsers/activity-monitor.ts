import { exportTraceTable } from "../trace/export.js";
import {
  columnFmt,
  columnInteger,
  columnNumber,
  columnText,
  parseTraceTable,
  type TraceTable,
} from "../trace/xml.js";
import { normalizeProcessName } from "./app-launch.js";

export interface ActivityMonitorSample {
  index: number;
  /** Sample start relative to the beginning of the trace. */
  startMs: number;
  footprintBytes: number;
  realBytes: number;
  privateBytes: number;
  cpuPercent: number | null;
  threadCount: number | null;
}

export interface MemorySeriesSummary {
  sampleCount: number;
  firstMiB: number;
  lastMiB: number;
  minMiB: number;
  maxMiB: number;
  /** D12: the reported `memoryMB` value is this median footprint. */
  medianMiB: number;
  netGrowthMiB: number;
  slopeMiBPerMin: number;
  realLastMiB: number;
  realMaxMiB: number;
  privateLastMiB: number;
  privateMaxMiB: number;
}

export interface ActivityMonitorProcess {
  pid: number;
  name: string;
  summary: MemorySeriesSummary;
  samples: ActivityMonitorSample[];
}

export type ProcessSelectionStrategy = "pid" | "name" | "largest-median";

export interface ActivityMonitorAnalysis {
  template: "Activity Monitor";
  pid: number;
  processName: string;
  summary: MemorySeriesSummary;
  /** Footprint series in MiB, in sample order. */
  seriesMiB: number[];
  processes: ActivityMonitorProcess[];
  selection: ProcessSelectionStrategy;
  warnings: string[];
}

export interface ActivityMonitorSelection {
  pid?: number;
  /** Base process name (`NNIM`), matched case-insensitively. */
  processName?: string;
}

export class ActivityMonitorSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActivityMonitorSelectionError";
  }
}

const NS_PER_MS = 1_000_000;
const BYTES_PER_MIB = 1024 * 1024;

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function toMiB(bytes: number): number {
  return round(bytes / BYTES_PER_MIB, 2);
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/**
 * Least-squares slope in MiB per minute, using the real sample timestamps
 * rather than assuming a fixed one-second interval.
 */
function slopeMiBPerMinute(samples: ActivityMonitorSample[]): number {
  if (samples.length < 2) {
    return 0;
  }
  const origin = samples[0].startMs;
  const xs = samples.map((sample) => (sample.startMs - origin) / 60_000);
  const ys = samples.map((sample) => sample.footprintBytes / BYTES_PER_MIB);
  const count = xs.length;
  const meanX = xs.reduce((sum, value) => sum + value, 0) / count;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / count;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < count; index += 1) {
    const dx = xs[index] - meanX;
    numerator += dx * (ys[index] - meanY);
    denominator += dx * dx;
  }
  if (denominator === 0) {
    return 0;
  }
  return round(numerator / denominator, 3);
}

function summarize(samples: ActivityMonitorSample[]): MemorySeriesSummary {
  const footprints = samples.map((sample) => sample.footprintBytes);
  const reals = samples.map((sample) => sample.realBytes);
  const privates = samples.map((sample) => sample.privateBytes);
  const firstMiB = toMiB(footprints[0]);
  const lastMiB = toMiB(footprints[footprints.length - 1]);

  return {
    sampleCount: samples.length,
    firstMiB,
    lastMiB,
    minMiB: toMiB(Math.min(...footprints)),
    maxMiB: toMiB(Math.max(...footprints)),
    medianMiB: toMiB(median(footprints)),
    netGrowthMiB: round(lastMiB - firstMiB, 2),
    slopeMiBPerMin: slopeMiBPerMinute(samples),
    realLastMiB: toMiB(reals[reals.length - 1]),
    realMaxMiB: toMiB(Math.max(...reals)),
    privateLastMiB: toMiB(privates[privates.length - 1]),
    privateMaxMiB: toMiB(Math.max(...privates)),
  };
}

function readSamples(table: TraceTable): Map<number, ActivityMonitorProcess> {
  const groups = new Map<
    number,
    { pid: number; name: string; samples: ActivityMonitorSample[] }
  >();

  for (const row of table.rows) {
    const pid = columnInteger(table, row, "pid");
    const startNs = columnText(table, row, "start");
    const footprint = columnNumber(table, row, "memory-physical-footprint");
    if (pid === undefined || startNs === undefined || footprint === undefined) {
      continue;
    }
    const name =
      normalizeProcessName(columnFmt(table, row, "process") ?? "") ||
      normalizeProcessName(columnFmt(table, row, "responsible-process") ?? "") ||
      `pid ${pid}`;

    const startMs = Number(startNs) / NS_PER_MS;
    if (!Number.isFinite(startMs)) {
      continue;
    }

    const sample: ActivityMonitorSample = {
      index: 0,
      startMs: round(startMs, 2),
      footprintBytes: footprint,
      realBytes: columnNumber(table, row, "memory-real") ?? 0,
      privateBytes: columnNumber(table, row, "memory-real-private") ?? 0,
      cpuPercent: columnNumber(table, row, "cpu-percent") ?? null,
      threadCount: columnInteger(table, row, "thread-count") ?? null,
    };

    const group = groups.get(pid) ?? { pid, name, samples: [] };
    if (group.name.startsWith("pid ") && !name.startsWith("pid ")) {
      group.name = name;
    }
    group.samples.push(sample);
    groups.set(pid, group);
  }

  const processes: ActivityMonitorProcess[] = [];
  for (const group of groups.values()) {
    group.samples.sort((a, b) => a.startMs - b.startMs);
    group.samples.forEach((sample, index) => {
      sample.index = index;
    });
    processes.push({
      pid: group.pid,
      name: group.name,
      summary: summarize(group.samples),
      samples: group.samples,
    });
  }

  return new Map(processes.map((process) => [process.pid, process]));
}

function chooseProcess(
  processes: ActivityMonitorProcess[],
  selection: ActivityMonitorSelection,
  warnings: string[],
): { selected: ActivityMonitorProcess; strategy: ProcessSelectionStrategy } {
  if (selection.pid !== undefined) {
    const selected = processes.find((process) => process.pid === selection.pid);
    if (!selected) {
      throw new ActivityMonitorSelectionError(
        `PID ${selection.pid} has no Activity Monitor samples. Processes: ${summarizeCandidates(processes)}`,
      );
    }
    return { selected, strategy: "pid" };
  }

  if (selection.processName !== undefined) {
    const target = normalizeProcessName(selection.processName).toLowerCase();
    const matches = processes.filter(
      (process) => process.name.toLowerCase() === target,
    );
    if (matches.length === 0) {
      throw new ActivityMonitorSelectionError(
        `Process "${selection.processName}" has no Activity Monitor samples. Processes: ${summarizeCandidates(processes)}`,
      );
    }
    if (matches.length === 1) {
      return { selected: matches[0], strategy: "name" };
    }
    const selected = matches.sort(
      (a, b) => b.summary.sampleCount - a.summary.sampleCount,
    )[0];
    warnings.push(
      `Multiple processes named "${selection.processName}" (pids ${matches
        .map((process) => process.pid)
        .join(", ")}); using pid ${selected.pid} with the most samples. Pass a pid to disambiguate.`,
    );
    return { selected, strategy: "name" };
  }

  if (processes.length === 1) {
    return { selected: processes[0], strategy: "largest-median" };
  }

  // Last resort: the foreground app is normally the largest footprint in an
  // all-processes recording. Callers that know the pid or name should pass it.
  const selected = [...processes].sort(
    (a, b) => b.summary.medianMiB - a.summary.medianMiB,
  )[0];
  warnings.push(
    `No pid or process name supplied; selected "${selected.name}" (pid ${selected.pid}) because it has the largest median footprint.`,
  );
  return { selected, strategy: "largest-median" };
}

function summarizeCandidates(processes: ActivityMonitorProcess[]): string {
  return processes
    .slice(0, 12)
    .map((process) => `${process.name} (${process.pid})`)
    .join(", ");
}

/**
 * Parse `activity-monitor-process-live` into per-process memory series.
 *
 * The same pid can appear many times (once per sample); rows are grouped by
 * pid and sorted by start time before summaries are computed.
 */
export function parseActivityMonitorTable(xml: string): ActivityMonitorProcess[] {
  const table = parseTraceTable(xml);
  return [...readSamples(table).values()];
}

/** Parse and select one process from an Activity Monitor table export. */
export function analyzeActivityMonitorTable(
  xml: string,
  selection: ActivityMonitorSelection = {},
): ActivityMonitorAnalysis {
  const processes = parseActivityMonitorTable(xml);
  if (processes.length === 0) {
    throw new ActivityMonitorSelectionError(
      "No Activity Monitor samples were parsed from the trace.",
    );
  }
  const warnings: string[] = [];
  const { selected, strategy } = chooseProcess(processes, selection, warnings);

  return {
    template: "Activity Monitor",
    pid: selected.pid,
    processName: selected.name,
    summary: selected.summary,
    seriesMiB: selected.samples.map((sample) => toMiB(sample.footprintBytes)),
    processes,
    selection: strategy,
    warnings,
  };
}

/** Export and analyze an Activity Monitor trace for one target process. */
export async function analyzeActivityMonitorTrace(
  tracePath: string,
  selection: ActivityMonitorSelection = {},
): Promise<ActivityMonitorAnalysis> {
  const xml = await exportTraceTable(tracePath, "activity-monitor-process-live");
  return analyzeActivityMonitorTable(xml, selection);
}

/** D12: the reported `memoryMB` metric is the median physical footprint. */
export function memoryMetricValue(analysis: ActivityMonitorAnalysis): number {
  return analysis.summary.medianMiB;
}
