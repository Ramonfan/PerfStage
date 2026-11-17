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

/**
 * Default recording window per template, tuned on a physical iPhone.
 *
 * Resolved here (not in the xctrace adapter) so the config recorded with a
 * pass matches the argv even when the caller passed no `timeLimit`.
 */
export const DEFAULT_TIME_LIMIT: Record<string, string> = {
  hitches: "20s",
  launch: "12s",
  memory: "12s",
};

/** How long to wait for the session to go live. Shared with the argv/config. */
export const DEFAULT_LIVE_TIMEOUT_MS = 90_000;

/**
 * Hitches profiles.
 *
 * `full` is the historical `Animation Hitches` template. `compact` is the
 * candidate C1 profile: only the table the hitches parser reads, without the
 * kdebug/time-profile/Metal set that made one trace 480MB on a real device
 * (docs/trace-footprint.md §9). C1 did not pass the metric-stability gate and
 * is not adopted; the switch stays for a future re-baselining change. The
 * profile is an internal recording choice, never a plan field.
 */
export const HITCHES_PROFILES = ["full", "compact"] as const;

export type HitchesProfile = (typeof HITCHES_PROFILES)[number];

/** `Blank` is the template that can take an explicit `--instrument`. */
export const COMPACT_HITCHES_TEMPLATE = "Blank";
/** `Frame Lifetimes` alone does not emit `hitches-frame-lifetimes`. */
export const COMPACT_HITCHES_INSTRUMENTS = ["Hitches"] as const;
/**
 * Diagnostics the compact profile does not record.
 *
 * The full `Animation Hitches` trace exported 59 table schemas on a real
 * device; `Blank + Hitches` exported 12. This list names the major diagnostic
 * families that disappear, not every individual table: readers must not treat
 * a compact trace as a full diagnostic trace. Re-record with `full` when CPU
 * stacks, Metal details or system-call context are needed.
 */
export const COMPACT_HITCHES_MISSING_DIAGNOSTICS = [
  "Time Profiler（time-profile / time-sample / thread-state / context-switch）",
  "CPU 使用率（ProcessCPUUsage / SystemCPUUsage / ThreadCPUUsage / ThreadActivity）",
  "Metal / GPU（metal-* / device-gpu-info）",
  "图形与显示（display-* / visual-chain / visual-connection / displayed-surfaces-*）",
  "线程快照（thread-snapshot / stackshot-info）",
  "系统调用（syscall / syscall-name-map）",
  "日志与 signpost（os-log / os-signpost）",
  "hang 风险（hang-risks / potential-hangs）",
  "生命周期（life-cycle-period）",
  "虚拟内存与热状态（virtual-memory / device-thermal-state-intervals）",
  "runloop（runloop-events）",
] as const;

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

/** Launch-time configuration forwarded to the recorded cold start. */
export interface LaunchOptions {
  /** Arguments appended after the bundle id, e.g. `["-UITestMode", "1"]`. */
  arguments?: readonly string[];
  /** Environment variables forwarded as `--env KEY=VALUE`. */
  environment?: Readonly<Record<string, string>>;
}

export interface RecordRequest {
  template: RecordingTemplate;
  /** Device UDID, as reported by `xcrun devicectl list devices`. */
  device: string;
  target: RecordingTarget;
  /**
   * Cold-start options for `target.kind === "launch"`.
   *
   * xctrace documents both: `--env KEY=VALUE` (launch-only) and
   * `--launch -- command [arguments]`, where everything after `--` is the
   * child command. The Runner passes the plan's
   * `app.launchArguments` / `app.environmentVariables` here so the recorded
   * launch matches the declared configuration. Ignored for attach /
   * all-processes targets, which never start the app.
   */
  launch?: LaunchOptions;
  /**
   * Where the `.trace` should live. For `launch` this is only a hint:
   * xctrace ignores `--output` for that template and names the trace itself,
   * so the recorder scans `dirname(outputPath)` for the newest `Launch_*.trace`.
   */
  outputPath: string;
  /** xctrace `--time-limit`, e.g. `20s`. Defaults per template. */
  timeLimit?: string;
  /**
   * xctrace `--window`, e.g. `11s`: keep only events from the last N of the
   * recording (a ring buffer, not a post-hoc crop). Absent means
   * `full-session`. Only set this when the declared action window plus a
   * safety margin is known to fit; a too-short window silently drops the
   * interaction and the Take must then be rejected by the window checks.
   */
  window?: string;
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

/**
 * The `--template` / `--instrument` / `--time-limit` a request resolves to.
 *
 * `buildRecordArgs` and the persisted config both read this, so a trace can
 * never be analysed under a different profile than the one recorded.
 */
export interface ResolvedRecording {
  template: string;
  instruments?: readonly string[];
  timeLimit: string;
  /** Effective bound on `during`; absent when the request has none. */
  duringTimeoutMs?: number;
  /** Effective live-session timeout. */
  liveTimeoutMs: number;
  /**
   * `full-session` means no `--window` was passed. C1 does not clip the
   * recording; keeping the value explicit means a later window profile cannot
   * silently omit what it cut.
   */
  window: string;
}

/** xctrace `--window` accepts ms/s/m, but not hours. */
export const WINDOW_DURATION_PATTERN = /^\d+(ms|s|m)$/;

export function resolveRecording(
  request: RecordRequest,
  profile: HitchesProfile = "full",
): ResolvedRecording {
  const window = request.window?.trim();
  if (window !== undefined && !WINDOW_DURATION_PATTERN.test(window)) {
    throw new Error(
      `xctrace --window must look like 500ms, 10s or 2m, got "${request.window}"`,
    );
  }
  // Only the hitches pass has a compact variant: launch needs App Launch's
  // life-cycle tables, and memory is already ~1.6MB.
  const compact = profile === "compact" && request.template === "hitches";
  return {
    template: compact
      ? COMPACT_HITCHES_TEMPLATE
      : (TEMPLATE_TO_INSTRUMENTS[request.template] ?? request.template),
    ...(compact ? { instruments: COMPACT_HITCHES_INSTRUMENTS } : {}),
    timeLimit:
      request.timeLimit ?? DEFAULT_TIME_LIMIT[request.template] ?? "20s",
    liveTimeoutMs: request.liveTimeoutMs ?? DEFAULT_LIVE_TIMEOUT_MS,
    ...(request.duringTimeoutMs !== undefined
      ? { duringTimeoutMs: request.duringTimeoutMs }
      : {}),
    window: window ?? "full-session",
  };
}

/**
 * Recording configuration persisted with a pass.
 *
 * `profile` describes *this pass*, not the Take: launch and memory always run
 * their default templates, so they report `full` even when the hitches pass is
 * compact.
 */
export interface RecordingConfig {
  profile: HitchesProfile;
  /** xctrace `--template` value, e.g. `Animation Hitches` or `Blank`. */
  template: string;
  /** Explicit `--instrument` values; omitted when the template supplies them. */
  instruments?: string[];
  /** xctrace `--time-limit` value. */
  timeLimit: string;
  /**
   * Effective bound on the `during` action replay. Present for the hitches
   * pass (the only pass with a `during` phase); a healthy Take needs ~14s.
   */
  duringTimeoutMs?: number;
  /** Effective bound on waiting for the recording session to go live. */
  liveTimeoutMs: number;
  /** `full-session`, or the `--window` value once one is used. */
  window: string;
  /**
   * Diagnostics this profile does not record. Present for `compact`, absent
   * for `full`; a compact trace is not a full diagnostic trace.
   */
  missingDiagnostics?: string[];
}

export function recordingConfigFor(
  request: RecordRequest,
  profile: HitchesProfile = "full",
): RecordingConfig {
  const resolved = resolveRecording(request, profile);
  // Only the hitches pass has a compact variant; launch and memory keep their
  // default templates and must not be labelled compact.
  const compact = profile === "compact" && request.template === "hitches";
  const instruments = resolved.instruments;
  return {
    profile: compact ? "compact" : "full",
    template: resolved.template,
    ...(instruments !== undefined ? { instruments: [...instruments] } : {}),
    timeLimit: resolved.timeLimit,
    ...(resolved.duringTimeoutMs !== undefined
      ? { duringTimeoutMs: resolved.duringTimeoutMs }
      : {}),
    liveTimeoutMs: resolved.liveTimeoutMs,
    window: resolved.window,
    ...(compact
      ? { missingDiagnostics: [...COMPACT_HITCHES_MISSING_DIAGNOSTICS] }
      : {}),
  };
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
   * The recording configuration the trace was actually produced with.
   *
   * Persisted with the pass so a compact profile can never be mistaken for a
   * full diagnostic trace after the fact.
   */
  recording: RecordingConfig;
  /**
   * xctrace "run issues". Warnings are normal (sampling-period mismatches);
   * errors that did not abort the recording are surfaced so the Take can
   * record them instead of silently trusting a partial trace.
   */
  issues: RecordingIssue[];
  durationMs: number;
  /**
   * Regular-file bytes inside the trace bundle.
   *
   * Omitted when the bundle cannot be read, or when the regular files sum to
   * zero (empty bundle / only zero-length files): both cases carry no
   * evidence, and the recorder adds a warning issue instead of reporting a
   * fabricated 0. `du` is not used because block allocation makes sizes
   * incomparable across volumes.
   */
  bytes?: number;
  /**
   * Time from xctrace's "Saving output file..." line to process exit.
   *
   * Omitted when that phase was never observed (killed session, older
   * xctrace). Never derived from the pass wall clock.
   */
  saveMs?: number;
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
    /**
     * Original error, when this one wraps a caller failure.
     *
     * `during` callbacks run inside the recording session, so a Runner error
     * thrown there comes back out through the recorder. Wrapping would
     * otherwise erase its identity (a precondition violation would look like a
     * generic aborted recording), so the cause is preserved for the caller to
     * inspect.
     */
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface TraceRecorder {
  record(request: RecordRequest): Promise<RecordedTrace>;
}
