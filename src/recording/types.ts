/**
 * Recording layer contracts.
 *
 * PerfStage owns the whole Take: it decides *what* to record, records it,
 * parses the trace itself (D13), and finalizes the evidence. This module is
 * the "what to record" boundary: it only knows how to produce a `.trace`
 * file, never how to interpret one.
 *
 * Why not keep calling `instruments-mcp` over MCP: the recording layer is
 * 200 lines of process management, and every failure mode we hit on a real
 * device (kperf lock collisions, `--launch` ignoring `--output`, unreliable
 * exit codes) had to be worked around at the call site anyway. Integrating
 * it removes a process hop, a network boundary and a version-skew surface.
 */

/** The three canonical passes a multi-metric Take needs (D4). */
export const RECORDING_TEMPLATES = [
  "hitches",
  "launch",
  "memory",
] as const;

export type RecordingTemplate = (typeof RECORDING_TEMPLATES)[number];

/**
 * xctrace accepts a template name or a path to a custom `.tracetemplate`.
 * PerfStage maps its three canonical templates onto Instruments templates,
 * but callers may pass a custom one through the scenario.
 */
export const TEMPLATE_TO_INSTRUMENTS: Record<RecordingTemplate, string> = {
  hitches: "Animation Hitches",
  launch: "App Launch",
  memory: "Activity Monitor",
};

/** What xctrace should attach to. */
export type RecordingTarget =
  | {
      kind: "attach";
      /**
       * A pid, not a process name. Two installed builds of the same app share
       * an executable name; only the container UUID disambiguates them.
       */
      pid: number;
    }
  | {
      kind: "launch";
      bundleId: string;
    }
  | {
      kind: "allProcesses";
    };

export interface RecordRequest {
  template: RecordingTemplate;
  /** Device UDID, as reported by `xcrun devicectl list devices`. */
  device: string;
  target: RecordingTarget;
  /**
   * Where the `.trace` should live. For `launch` this is only a hint:
   * xctrace ignores `--output` for that template and names the trace itself,
   * so the recorder scans `dirname(outputPath)` for the newest `Launch_*.trace`.
   */
  outputPath: string;
  /** xctrace `--time-limit`, e.g. `20s`. Defaults per template. */
  timeLimit?: string;
  /**
   * Runs once the recording session is live (after xctrace prints
   * `Ctrl-C to stop the recording`). This is where the scenario actions run,
   * so the recorded window contains the interaction, not just idle time.
   */
  during?: () => Promise<void>;
  /**
   * Upper bound on `during`.
   *
   * A hung device call inside the action callback must never keep the session
   * open: xctrace would record until `timeLimit`, produce a multi-gigabyte
   * trace, and hold the on-device Instruments service long after the scenario
   * ended. Observed during M3: a foreground query that never answered turned
   * an 8s action window into 60s of recording (4.7 GB, §4.10). On expiry the
   * session is stopped and the Take fails as non-retryable.
   */
  duringTimeoutMs?: number;
  /** Extra time to keep recording after `during` resolves. Default 1500ms. */
  graceMs?: number;
  /** How long to wait for the session to become live. Default 90s. */
  liveTimeoutMs?: number;
  /** Retry budget for retryable failures (kperf lock). Default 3 attempts. */
  maxAttempts?: number;
  /** Backoff between attempts. Default 30s. */
  retryDelayMs?: number;
}

export type RecordingIssueLevel = "error" | "warning";

export interface RecordingIssue {
  level: RecordingIssueLevel;
  message: string;
  /** Full raw line from xctrace, for the report. */
  line: string;
}

export interface RecordedTrace {
  tracePath: string;
  template: RecordingTemplate;
  /** 1 when the first attempt worked; >1 means a retry happened. */
  attempts: number;
  /**
   * xctrace "run issues". Warnings are normal (sampling-period mismatches);
   * errors that did not abort the recording are surfaced so the Take can
   * record them instead of silently trusting a partial trace.
   */
  issues: RecordingIssue[];
  durationMs: number;
}

export type RecordingErrorKind =
  | "kperf-lock"
  | "failed-to-start"
  | "never-live"
  | "no-trace"
  | "spawn"
  | "aborted"
  | "pid-gone"
  /** The device-side Instruments service could not open a recording session. */
  | "instruments-wedged"
  /** xctrace produced a trace whose device-side data is incomplete. */
  | "malformed-trace"
  /** The target app died while the recording was running. */
  | "app-exited";

/**
 * A recording failure with enough structure for the Runner to decide whether
 * to retry, mark the Take failed, or escalate to the user.
 */
export class RecordingError extends Error {
  override readonly name = "RecordingError";

  constructor(
    message: string,
    readonly kind: RecordingErrorKind,
    readonly retryable: boolean,
    readonly output?: string,
  ) {
    super(message);
  }
}

export interface TraceRecorder {
  record(request: RecordRequest): Promise<RecordedTrace>;
}
