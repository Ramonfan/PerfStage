import { z } from "zod";

/**
 * Lifecycle event kinds recognized by the diagnostic normalizer.
 *
 * The brief restricts the surface area on purpose: downstream
 * consumers only need to know about stability-relevant transitions
 * (foreground/background/system_alert/etc.), not the full set of UI
 * states a process can report.
 */
export const lifecycleKindSchema = z.enum([
  "foreground",
  "background",
  "app_exit",
  "springboard",
  "system_alert",
  "device_disconnect",
]);

export type LifecycleKind = z.infer<typeof lifecycleKindSchema>;

export const lifecycleEventSchema = z.object({
  kind: lifecycleKindSchema,
  occurredAt: z.string().datetime(),
  notes: z.string().optional(),
});

export type LifecycleEvent = z.infer<typeof lifecycleEventSchema>;

/**
 * Normalized crash report.
 *
 * Only `id` is required: real-world crash directories often omit
 * one or more of the descriptive fields and we do not want to
 * pretend they exist. The shape is intentionally a superset of what
 * iOS `.ips` and Android `tombstone_*` files expose so that
 * collectors from either platform can be lossless.
 */
export const crashReportSchema = z.object({
  id: z.string().min(1),
  path: z.string().optional(),
  process: z.string().optional(),
  timestamp: z.string().optional(),
  exceptionType: z.string().optional(),
  terminationReason: z.string().optional(),
  crashedThread: z.string().optional(),
  keyStack: z.string().optional(),
});

export type CrashReport = z.infer<typeof crashReportSchema>;

export const logFiltersSchema = z
  .object({
    subsystem: z.string().optional(),
    category: z.string().optional(),
  })
  .optional();

export type LogFilters = z.infer<typeof logFiltersSchema>;

export const diagnosticInputSchema = z.object({
  logText: z.string().optional(),
  logPath: z.string().optional(),
  logFilters: logFiltersSchema,
  crashIdsBefore: z.array(z.string()).optional(),
  crashIdsAfter: z.array(z.string()).optional(),
  crashReports: z.array(crashReportSchema).optional(),
  lifecycle: z.array(lifecycleEventSchema).optional(),
  crashQueryError: z.string().optional(),
  logQueryError: z.string().optional(),
  lifecycleQueryError: z.string().optional(),
});

export type DiagnosticInput = z.infer<typeof diagnosticInputSchema>;

/**
 * Tri-state category hit.
 *
 * - `true`  -> the category was matched in the captured log text.
 * - `false` -> the log text was scanned and did not contain it.
 * - `null`  -> the log text was unavailable; absence cannot be
 *              claimed. Downstream classifiers must treat `null`
 *              as "unknown" and refuse to mark the run as clean on
 *              its basis alone.
 */
export type CategoryHit = boolean | null;

export interface LogCategories {
  errorOrFault: CategoryHit;
  watchdog: CategoryHit;
  memoryWarning: CategoryHit;
  jetsam: CategoryHit;
  uikitOrCoreAnimation: CategoryHit;
  reactNativeOrJSC: CategoryHit;
  imageNetworkUrl: CategoryHit;
}

/**
 * Case-insensitive bounded regular expressions for each log
 * category.
 *
 * "Bounded" means non-anchored substring-style patterns instead of
 * greedy `.+`-anchored ones. Each pattern matches at least one of
 * the alternatives from the brief.
 */
const CATEGORY_PATTERNS: Record<keyof LogCategories, RegExp> = {
  errorOrFault: /error|fault/i,
  watchdog: /watchdog/i,
  memoryWarning: /memory warning|memory pressure/i,
  jetsam: /jetsam/i,
  uikitOrCoreAnimation: /uikit|core animation/i,
  reactNativeOrJSC: /react native|javascriptcore/i,
  imageNetworkUrl: /image|network|url loading/i,
};

const UNKNOWN_CATEGORIES: LogCategories = {
  errorOrFault: null,
  watchdog: null,
  memoryWarning: null,
  jetsam: null,
  uikitOrCoreAnimation: null,
  reactNativeOrJSC: null,
  imageNetworkUrl: null,
};

function scanCategories(logText: string | undefined): LogCategories {
  const haystack = logText ?? "";
  const categories = {} as LogCategories;
  for (const key of Object.keys(CATEGORY_PATTERNS) as (keyof LogCategories)[]) {
    categories[key] = CATEGORY_PATTERNS[key].test(haystack);
  }
  return categories;
}

function countLines(text: string | undefined): number {
  if (!text) {
    return 0;
  }
  // `split` on a non-empty string always yields at least one entry,
  // so the result equals the visible line count even when the text
  // does not terminate in a newline.
  return text.split(/\r?\n/).length;
}

export interface LogEvidence {
  path?: string;
  text?: string;
  lineCount: number;
  status: "available" | "unavailable";
  error?: string;
  filters?: LogFilters;
  categories: LogCategories;
}

export interface CrashEvidence {
  status: "available" | "unavailable";
  error?: string;
  reports: CrashReport[];
  before: string[];
  after: string[];
  newIds: string[];
}

export interface LifecycleEvidence {
  status: "available" | "unavailable";
  error?: string;
  events: LifecycleEvent[];
}

export interface DiagnosticEvidence {
  startedAt: string;
  endedAt: string;
  logs: LogEvidence;
  crashes: CrashEvidence;
  lifecycle: LifecycleEvidence;
}

export interface DiagnosticImpact {
  severity: "none" | "warning" | "failure";
  reasons: string[];
}

/**
 * Returns the sorted IDs present in `after` but not in `before`.
 *
 * Sorting is part of the public contract so callers can rely on a
 * stable order for reports and snapshot diffs.
 */
export function diffCrashIds(before: string[], after: string[]): string[] {
  const beforeSet = new Set(before);
  return after.filter((id) => !beforeSet.has(id)).sort();
}

export function normalizeDiagnostics(
  input: DiagnosticInput,
  startedAt: string,
  endedAt: string,
): DiagnosticEvidence {
  const logs: LogEvidence = input.logQueryError
    ? {
        path: input.logPath,
        text: input.logText,
        lineCount: countLines(input.logText),
        status: "unavailable",
        error: input.logQueryError,
        filters: input.logFilters,
        categories: UNKNOWN_CATEGORIES,
      }
    : {
        path: input.logPath,
        text: input.logText,
        lineCount: countLines(input.logText),
        status: "available",
        filters: input.logFilters,
        categories: scanCategories(input.logText),
      };

  const beforeIds = input.crashIdsBefore ?? [];
  const afterIds = input.crashIdsAfter ?? [];
  const reports = input.crashReports ?? [];

  const crashes: CrashEvidence = input.crashQueryError
    ? {
        // When the crash query itself failed we cannot claim
        // anything about new vs. old crash IDs; record zero so the
        // classifier can only blame the unavailability.
        status: "unavailable",
        error: input.crashQueryError,
        reports,
        before: beforeIds,
        after: afterIds,
        newIds: [],
      }
    : {
        status: "available",
        reports,
        before: beforeIds,
        after: afterIds,
        newIds: diffCrashIds(beforeIds, afterIds),
      };

  const lifecycle: LifecycleEvidence = input.lifecycleQueryError
    ? {
        status: "unavailable",
        error: input.lifecycleQueryError,
        events: input.lifecycle ?? [],
      }
    : {
        status: "available",
        events: input.lifecycle ?? [],
      };

  return {
    startedAt,
    endedAt,
    logs,
    crashes,
    lifecycle,
  };
}

export function classifyDiagnosticImpact(
  evidence: DiagnosticEvidence,
): DiagnosticImpact {
  const reasons: string[] = [];
  let failure = false;
  let warning = false;

  if (evidence.crashes.status === "unavailable") {
    warning = true;
    reasons.push("crash-detection-unavailable");
  } else if (evidence.crashes.newIds.length > 0) {
    failure = true;
    reasons.push("new-crash");
  }

  if (evidence.logs.status === "unavailable") {
    warning = true;
    reasons.push("log-evidence-unavailable");
  } else {
    const cats = evidence.logs.categories;
    if (cats.jetsam === true) {
      failure = true;
      reasons.push("jetsam");
    }
    if (cats.watchdog === true) {
      failure = true;
      reasons.push("watchdog");
    }
    if (cats.memoryWarning === true) {
      warning = true;
      reasons.push("memory-warning");
    }
  }

  if (evidence.lifecycle.status === "unavailable") {
    warning = true;
    reasons.push("lifecycle-evidence-unavailable");
  } else {
    for (const event of evidence.lifecycle.events) {
      if (event.kind === "device_disconnect") {
        failure = true;
        reasons.push("device-disconnect");
        break;
      }
    }
  }

  let severity: DiagnosticImpact["severity"];
  if (failure) {
    severity = "failure";
  } else if (warning) {
    severity = "warning";
  } else {
    severity = "none";
  }

  return { severity, reasons };
}