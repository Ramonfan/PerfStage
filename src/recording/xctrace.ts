import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  DEFAULT_LIVE_TIMEOUT_MS,
  HITCHES_PROFILES,
  RecordingError,
  TEMPLATE_TO_INSTRUMENTS,
  WINDOW_DURATION_PATTERN,
  type HitchesProfile,
  type RecordedTrace,
  type RecordRequest,
  type RecordingErrorKind,
  type RecordingIssue,
  type TraceRecorder,
  recordingConfigFor,
  resolveRecording,
} from "./types.js";

const XCTRACE = "xctrace";

const DEFAULT_GRACE_MS = 1_500;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 30_000;
/**
 * How long a timed-out xctrace gets to close its device session after SIGINT
 * before we stop asking.
 *
 * This used to be 10 s, which on a real device is far too short: xctrace saves
 * a large trace for a minute or more after Ctrl-C, and killing it mid-save
 * leaves the on-device Instruments service holding the session. Enough of
 * those and `com.apple.instruments.deviceservice` (DTServiceHub) wedges: every
 * later recording fails with `Failed starting ktrace session`, app launches
 * through it start failing, and only a device restart recovers. A few minutes
 * of patience is much cheaper than that.
 */
const DEFAULT_SIGKILL_GRACE_MS = 300_000;

const WEDGED_MESSAGE =
  "xctrace could not start the device recording session (Failed starting ktrace session): " +
  "the on-device Instruments service is wedged and needs a device restart. " +
  "Retrying or reopening Xcode does not recover it.";
/**
 * `xctrace --attach <pid>` intermittently rejects a live pid with
 * `Cannot find process for provided pid` and then accepts the very same pid a
 * few seconds later (observed repeatedly on iOS 27.0.1 + Xcode 27.2). The
 * device-side process table lags behind `devicectl`'s view, so retrying the
 * same pid is worth a short wait; the 30 s kperf backoff is too slow for it.
 */
const PID_GONE_RETRY_DELAY_MS = 5_000;
/**
 * xctrace writes the trace itself for `--launch`, and its name embeds a
 * timestamp with second precision. Allow a little clock skew when matching
 * files against our own start time.
 */
const LAUNCH_TRACE_SKEW_MS = 5_000;

export interface XctraceRecorderOptions {
  /** Override the xctrace binary (tests). */
  command?: string;
  /** Override waits/timers (tests keep them near zero). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * How long SIGINT gets to close the device session before SIGKILL.
   * Defaults to 5 minutes; tests shorten it.
   */
  sigkillGraceMs?: number;
  /** Receive human-readable progress lines. Defaults to a no-op. */
  log?: (message: string) => void;
  /**
   * Hitches profile. Defaults to `PERFSTAGE_HITCHES_PROFILE` (`full` when
   * unset). This is the internal A/B/revert switch; it is not a plan field.
   */
  hitchesProfile?: HitchesProfile;
  /**
   * Hitches `--window` duration. Defaults to `PERFSTAGE_HITCHES_WINDOW`
   * (absent when unset). Applies only to the hitches pass.
   */
  hitchesWindow?: string;
}

/**
 * Parse the internal C2 window switch.
 *
 * Absent/empty means `full-session`. This is an A/B knob, not a plan field:
 * a fixed duration is only safe when the scenario's action window plus margin
 * fits, which the caller must validate after recording.
 */
export function hitchesWindowFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env.PERFSTAGE_HITCHES_WINDOW?.trim().toLowerCase();
  if (raw === undefined || raw === "") return undefined;
  if (!WINDOW_DURATION_PATTERN.test(raw)) {
    throw new Error(
      `PERFSTAGE_HITCHES_WINDOW must look like 500ms, 10s or 2m, got "${env.PERFSTAGE_HITCHES_WINDOW}"`,
    );
  }
  return raw;
}

/**
 * Parse the internal profile switch.
 *
 * Unknown values fail loudly: a typo must not silently record the full
 * profile and quietly invalidate an A/B run.
 */
export function hitchesProfileFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): HitchesProfile {
  const raw = env.PERFSTAGE_HITCHES_PROFILE?.trim().toLowerCase();
  if (raw === undefined || raw === "") return "full";
  if ((HITCHES_PROFILES as readonly string[]).includes(raw)) {
    return raw as HitchesProfile;
  }
  throw new Error(
    `PERFSTAGE_HITCHES_PROFILE must be one of ${HITCHES_PROFILES.join(" | ")}, got "${env.PERFSTAGE_HITCHES_PROFILE}"`,
  );
}

/**
 * Parse xctrace's "run issues" block.
 *
 * A successful recording can still report issues, and a failed one always
 * does. We collect them verbatim so the report can show *why* a trace is
 * suspect instead of silently trusting it.
 */
export function parseRecordingIssues(output: string): RecordingIssue[] {
  const issues: RecordingIssue[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("* [Error]")) {
      issues.push({
        level: "error",
        message: line.replace(/^\* \[Error\]\s*/, ""),
        line,
      });
      continue;
    }
    if (line.startsWith("* [Warning]")) {
      issues.push({
        level: "warning",
        message: line.replace(/^\* \[Warning\]\s*/, ""),
        line,
      });
    }
  }
  return issues;
}

function isKperfLockFailure(output: string): boolean {
  return /_lockKPerf|could not lock kperf/i.test(output);
}

function isStartFailure(output: string): boolean {
  return /Failed to start the recording/i.test(output);
}

/**
 * The device-side recording service refused to open a session.
 *
 * Observed on iOS 27.0.1 + Xcode 27.2 after a burst of interrupted recordings:
 * every subsequent attempt fails immediately, and no amount of waiting,
 * restarting the host-side DTServiceHub, or relaunching the app recovers it.
 * Only a device restart does, so retrying is pure device wear.
 */
function isInstrumentsWedged(output: string): boolean {
  return /Failed starting ktrace session/i.test(output);
}

/**
 * `xctrace --attach <pid>` answers `Cannot find process for provided pid` for
 * two very different situations:
 *
 * 1. the pid really is gone (app terminated), and
 * 2. the device-side process table has not caught up with a recent
 *    launch/foreground yet.
 *
 * We cannot tell them apart from the output, and case 2 is common on this
 * toolchain: the same pid succeeded on the next attempt in real-device runs.
 * So the error stays its own kind (the Runner may relaunch and re-resolve) but
 * is retried on the same pid with a short backoff first.
 */
function isPidGoneOutput(output: string): boolean {
  return /cannot find process for provided pid/i.test(output);
}

function classifyStartFailure(output: string): {
  kind: RecordingErrorKind;
  retryable: boolean;
} {
  if (isInstrumentsWedged(output)) {
    return { kind: "instruments-wedged", retryable: false };
  }
  if (isPidGoneOutput(output)) {
    return { kind: "pid-gone", retryable: true };
  }
  if (isKperfLockFailure(output)) {
    return { kind: "kperf-lock", retryable: true };
  }
  return { kind: "failed-to-start", retryable: true };
}

/**
 * Turn a completed-but-useless recording into a hard failure.
 *
 * xctrace exits 0 and still writes a `.trace` when the target app dies or when
 * the transfer back from the device is incomplete. Those traces parse as "no
 * frames", which reads exactly like a healthy app that never hitched — M3
 * shipped one such report before this guard existed. Neither condition is
 * retryable: retrying hammers an already-unhealthy device.
 */
function classifyFatalRecording(output: string): {
  kind: RecordingErrorKind;
  message: string;
} | null {
  if (/Transferred trace file is malformed/i.test(output)) {
    return {
      kind: "malformed-trace",
      message:
        "xctrace transferred a malformed trace: the device-side recording buffer was incomplete. " +
        "This happens when the on-device Instruments service is unhealthy or the app died mid-recording; " +
        "restart the device before recording again.",
    };
  }
  if (/Target app exited/i.test(output)) {
    return {
      kind: "app-exited",
      message:
        "the app exited while the recording was running, so the trace cannot measure the scenario. " +
        "Check device.log for a fatal error or crash report before retrying.",
    };
  }
  return null;
}

function isLive(output: string): boolean {
  return output.includes("Ctrl-C to stop the recording");
}

/**
 * Build the `xctrace record` argv for a request.
 *
 * Ordering note: every option goes *before* `--launch --`. Everything after
 * `--` is the child command, so putting `--time-limit` there would silently
 * turn it into an app argument.
 */
export function buildRecordArgs(
  request: RecordRequest,
  profile: HitchesProfile = "full",
): string[] {
  const resolved = resolveRecording(request, profile);
  const args = ["record", "--template", resolved.template];
  for (const instrument of resolved.instruments ?? []) {
    args.push("--instrument", instrument);
  }
  args.push(
    "--device",
    request.device,
    "--time-limit",
    resolved.timeLimit,
    "--no-prompt",
  );
  if (resolved.window !== "full-session") {
    // `--window` is a recording-time ring buffer. It must come before the
    // target subcommand like every other option.
    args.push("--window", resolved.window);
  }

  switch (request.target.kind) {
    case "attach":
      args.push("--attach", String(request.target.pid));
      // `--output` is reliable for attach/all-processes; only `--launch`
      // ignores it (see resolveTracePath).
      args.push("--output", request.outputPath);
      break;
    case "launch": {
      args.push("--output", request.outputPath);
      // `--env` is an xctrace option, so it must come before `--launch --`;
      // after the separator it would be handed to the app as an argument.
      for (const [key, value] of Object.entries(
        request.launch?.environment ?? {},
      )) {
        args.push("--env", `${key}=${value}`);
      }
      args.push("--launch", "--", request.target.bundleId);
      // Everything after the bundle id is the launched app's argv.
      args.push(...(request.launch?.arguments ?? []));
      break;
    }
    case "allProcesses":
      args.push("--all-processes");
      args.push("--output", request.outputPath);
      break;
  }

  return args;
}

interface ExitedProcess {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}

interface LiveSpawn {
  child: ChildProcess;
  live: Promise<void>;
  exited: Promise<ExitedProcess>;
  output: () => string;
  /** Epoch ms when the save phase was first observed, if ever. */
  saveStartedAt: () => number | undefined;
  stop: () => void;
}

/**
 * Spawn xctrace and resolve `live` as soon as the recording session starts.
 *
 * Timing matters: tapping the device before the session is live records
 * nothing, and waiting for exit would serialise the interaction with the
 * recording. The "Ctrl-C to stop the recording" banner is the only reliable
 * signal xctrace gives us.
 */
function spawnRecording(
  args: string[],
  options: {
    command: string;
    cwd: string;
    liveTimeoutMs: number;
    hardTimeoutMs: number;
    sigkillGraceMs: number;
  },
): LiveSpawn {
  const child = spawn(options.command, args, {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let saveStartedAt: number | undefined;
  let liveSettled = false;
  let settleLive: () => void = () => undefined;
  let rejectLive: (error: Error) => void = () => undefined;

  const live = new Promise<void>((resolve, reject) => {
    settleLive = () => {
      if (liveSettled) return;
      liveSettled = true;
      resolve();
    };
    rejectLive = (error) => {
      if (liveSettled) return;
      liveSettled = true;
      reject(error);
    };
  });
  // Nobody may await `live` (e.g. launch recordings): keep a rejection from
  // becoming an unhandled promise rejection.
  live.catch(() => undefined);

  const append = (chunk: Buffer | string): void => {
    output += chunk.toString();
    // xctrace may print the save banner before the trace is fully written.
    // Keep the first observation: retries create a fresh session, and the
    // pass wall clock must not be used as a fallback.
    if (saveStartedAt === undefined && output.includes("Saving output file")) {
      saveStartedAt = Date.now();
    }
    if (liveSettled) return;
    if (isStartFailure(output)) {
      const failure = classifyStartFailure(output);
      rejectLive(
        new RecordingError(
          failure.kind === "instruments-wedged"
            ? WEDGED_MESSAGE
            : firstIssue(output) ?? "xctrace failed to start the recording",
          failure.kind,
          failure.retryable,
          output,
        ),
      );
      return;
    }
    if (isLive(output)) {
      settleLive();
    }
  };

  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  let killTimer: NodeJS.Timeout | undefined;

  const hardTimer = setTimeout(() => {
    // A hung xctrace keeps the kperf lock forever, so the session must end.
    // SIGKILL alone leaves the device-side tap session behind, and the next
    // recording then hangs before it ever goes live (observed on a real
    // device). Ask politely first — SIGINT is what Ctrl-C does and lets
    // xctrace close the session — then force it after a long grace period.
    child.kill("SIGINT");
    killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, options.sigkillGraceMs);
    killTimer.unref();
  }, options.hardTimeoutMs);

  const liveTimer = setTimeout(() => {
    rejectLive(
      new RecordingError(
        `recording did not become live within ${options.liveTimeoutMs}ms`,
        "never-live",
        true,
        output,
      ),
    );
  }, options.liveTimeoutMs);

  const exited = new Promise<ExitedProcess>((resolve, reject) => {
    child.on("error", (error) => {
      clearTimeout(hardTimer);
      clearTimeout(liveTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      reject(
        new RecordingError(
          `failed to spawn ${options.command}: ${error.message}`,
          "spawn",
          false,
        ),
      );
    });
    child.on("close", (code, signal) => {
      clearTimeout(hardTimer);
      clearTimeout(liveTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (!liveSettled) {
        // The process died before the session banner: report the tail of its
        // output; an empty message is useless for debugging.
        const tail = output.trim().split(/\r?\n/).slice(-8).join(" | ");
        const failure = classifyStartFailure(output);
        rejectLive(
          new RecordingError(
            failure.kind === "instruments-wedged"
              ? WEDGED_MESSAGE
              : `xctrace exited before the recording was live (code ${code}): ${tail || "(no output)"}`,
            failure.kind,
            failure.retryable,
            output,
          ),
        );
      }
      resolve({ code, signal, output });
    });
  });

  return {
    child,
    live,
    exited,
    output: () => output,
    saveStartedAt: () => saveStartedAt,
    stop: () => {
      child.kill("SIGINT");
    },
  };
}

function firstIssue(output: string): string | undefined {
  const issue = parseRecordingIssues(output).find(
    (entry) => entry.level === "error",
  );
  return issue?.message;
}

/**
 * Wait for a child to exit, but never longer than `ms`.
 *
 * Uses a real (unref'd) timer rather than the injected `sleep` so a five-minute
 * grace period cannot keep the Runner alive after the Take is over, and tests
 * do not have to fake it out.
 */
function waitForClose(child: ChildProcess, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.removeListener("close", onClose);
      resolve();
    }, ms);
    timer.unref();
    function onClose(): void {
      clearTimeout(timer);
      resolve();
    }
    child.once("close", onClose);
  });
}

/**
 * Find the trace a recording produced.
 *
 * `--launch` ignores `--output` and writes
 * `Launch_<bundle>_<timestamp>_<hash>.trace` into the working directory, so
 * the only reliable identification is "newest file we did not have before".
 */
export function resolveLaunchTrace(input: {
  directory: string;
  startedAt: number;
  existing: ReadonlySet<string>;
}): string | null {
  if (!existsSync(input.directory)) {
    return null;
  }
  const candidates = readdirSync(input.directory)
    .filter((name) => name.startsWith("Launch_") && name.endsWith(".trace"))
    .map((name) => join(input.directory, name))
    .filter((path) => !input.existing.has(path))
    .map((path) => {
      try {
        return { path, mtimeMs: statSync(path).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(
      (entry): entry is { path: string; mtimeMs: number } => entry !== null,
    )
    .filter((entry) => entry.mtimeMs >= input.startedAt - LAUNCH_TRACE_SKEW_MS)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  return candidates[0]?.path ?? null;
}

function listLaunchTraces(directory: string): Set<string> {
  if (!existsSync(directory)) {
    return new Set();
  }
  return new Set(
    readdirSync(directory)
      .filter((name) => name.startsWith("Launch_") && name.endsWith(".trace"))
      .map((name) => join(directory, name)),
  );
}

/**
 * xctrace-backed recorder.
 *
 * One instance is stateless apart from options: every `record()` call spawns
 * its own process, so a failed pass cannot poison the next one.
 */
export function createXctraceRecorder(
  options: XctraceRecorderOptions = {},
): TraceRecorder {
  const command = options.command ?? XCTRACE;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const log = options.log ?? (() => undefined);
  const hitchesProfile = options.hitchesProfile ?? hitchesProfileFromEnv();
  if (hitchesProfile === "compact") {
    log("hitches profile: compact (Blank + Hitches)");
  }
  const hitchesWindow = options.hitchesWindow ?? hitchesWindowFromEnv();
  if (hitchesWindow !== undefined) {
    log(`hitches window: last ${hitchesWindow}`);
  }

  return {
    async record(request: RecordRequest): Promise<RecordedTrace> {
      const maxAttempts = request.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
      const retryDelayMs = request.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
      const directory = dirname(request.outputPath);
      await fs.mkdir(directory, { recursive: true });
      // The window is a hitches-only A/B knob; launch/memory keep their
      // full-session recordings even when the switch is on.
      const effectiveRequest =
        hitchesWindow !== undefined && request.template === "hitches"
          ? { ...request, window: hitchesWindow }
          : request;

      let lastError: RecordingError | null = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (attempt > 1) {
          // A stale device process table clears in seconds, a kperf lock only
          // after the previous session drains. One delay per error kind keeps
          // both honest.
          const delay =
            lastError?.kind === "pid-gone"
              ? Math.min(retryDelayMs, PID_GONE_RETRY_DELAY_MS)
              : retryDelayMs;
          log(
            `recording attempt ${attempt - 1} failed (${lastError?.kind}); retrying in ${delay}ms`,
          );
          await sleep(delay);
        }

        try {
          return await recordOnce({
            request: effectiveRequest,
            command,
            directory,
            sleep,
            attempt,
            profile: hitchesProfile,
            sigkillGraceMs: options.sigkillGraceMs ?? DEFAULT_SIGKILL_GRACE_MS,
          });
        } catch (error) {
          const recordingError =
            error instanceof RecordingError
              ? error
              : new RecordingError(
                  error instanceof Error ? error.message : String(error),
                  "aborted",
                  false,
                  // Keep the original error reachable: `during` runs the
                  // Runner's own checks, so the caller must still be able to
                  // tell a precondition violation from a recording failure.
                  undefined,
                  { cause: error },
                );
          lastError = recordingError;
          if (!recordingError.retryable || attempt === maxAttempts) {
            throw recordingError;
          }
        }
      }

      throw lastError ??
        new RecordingError("recording failed without an error", "aborted", false);
    },
  };
}

async function recordOnce(input: {
  request: RecordRequest;
  command: string;
  directory: string;
  sleep: (ms: number) => Promise<void>;
  attempt: number;
  profile: HitchesProfile;
  sigkillGraceMs: number;
}): Promise<RecordedTrace> {
  const { request, command, directory, sleep, attempt, profile, sigkillGraceMs } =
    input;
  const startedAt = Date.now();
  const isLaunch = request.target.kind === "launch";

  // For `--launch` the output path is a hint only; clear any stale file so a
  // failed attempt cannot be mistaken for a fresh trace.
  if (existsSync(request.outputPath)) {
    await fs.rm(request.outputPath, { recursive: true, force: true });
  }
  const existingBefore = isLaunch ? listLaunchTraces(directory) : new Set<string>();

  const liveTimeoutMs = request.liveTimeoutMs ?? DEFAULT_LIVE_TIMEOUT_MS;
  const hardTimeoutMs =
    liveTimeoutMs + parseTimeLimitMs(request.timeLimit) + 180_000;

  const session = spawnRecording(buildRecordArgs(request, profile), {
    command,
    cwd: directory,
    liveTimeoutMs,
    hardTimeoutMs,
    sigkillGraceMs,
  });

  let interrupted = false;
  try {
    // Only interactive passes need to wait for the live signal. Launch and
    // all-processes passes are fire-and-forget windows.
    if (request.during) {
      await session.live;
      await runDuring(request.during, request.duringTimeoutMs);
      await sleep(request.graceMs ?? DEFAULT_GRACE_MS);
      session.stop();
      interrupted = true;
    }

    const exited = await session.exited;
    const issues = parseRecordingIssues(exited.output);
    // The save banner is the only observable boundary between recording and
    // host-side transfer. Measuring it directly keeps `saveMs` honest when
    // the trace is large; the pass wall clock includes startup and actions.
    const saveStartedAt = session.saveStartedAt();
    // A save phase cut short by a signal has no complete duration. The trace
    // may still exist and be worth recording, so keep `bytes` but omit
    // `saveMs` instead of reporting a partial (faster-looking) value.
    const saveMs =
      saveStartedAt === undefined || exited.signal !== null
        ? undefined
        : Math.max(0, Date.now() - saveStartedAt);

    if (isStartFailure(exited.output)) {
      await cleanupTrace(request.outputPath);
      const failure = classifyStartFailure(exited.output);
      throw new RecordingError(
        failure.kind === "instruments-wedged"
          ? WEDGED_MESSAGE
          : firstIssue(exited.output) ?? "recording failed to start",
        failure.kind,
        failure.retryable,
        exited.output,
      );
    }

    // xctrace 27.2 honours `--output` even for `--launch`, but older builds
    // wrote `Launch_*.trace` into the working directory instead. Accept both:
    // the requested path wins when it exists, otherwise scan for the name
    // xctrace chose.
    const tracePath = existsSync(request.outputPath)
      ? request.outputPath
      : isLaunch
        ? resolveLaunchTrace({
            directory,
            startedAt,
            existing: existingBefore,
          })
        : null;

    if (tracePath === null || !existsSync(tracePath)) {
      throw new RecordingError(
        isLaunch
          ? `App Launch trace was not produced in ${directory}`
          : `trace file was not produced at ${request.outputPath}`,
        "no-trace",
        true,
        exited.output,
      );
    }

    // A trace that exists is not automatically evidence: xctrace exits 0 for a
    // target that died and for an incomplete transfer from the device. Those
    // must not reach the analyzer, which would report "no frames" and let a
    // broken Take look like a healthy app.
    const fatal = classifyFatalRecording(exited.output);
    if (fatal !== null) {
      await cleanupTrace(tracePath);
      throw new RecordingError(fatal.message, fatal.kind, false, exited.output);
    }

    // A successful recording still needs an auditable footprint. If the
    // bundle cannot be read, omit the number and surface the reason instead of
    // reporting 0 (which would look like an empty trace).
    //
    // Snapshot the pass wall clock first: walking a large bundle only collects
    // metadata, but it must not become part of the recording duration the
    // baseline and candidates are compared on.
    const durationMs = Date.now() - startedAt;
    let bytes: number | undefined;
    try {
      const measured = await measureTraceBytes(tracePath);
      if (measured === 0) {
        // A bundle with no measurable bytes (empty or only zero-length files)
        // carries no evidence and must be distinguishable from "not measured".
        throw new Error("trace bundle has no measurable bytes");
      }
      bytes = measured;
    } catch (error) {
      issues.push({
        level: "warning",
        message: `could not measure trace size: ${
          error instanceof Error ? error.message : String(error)
        }`,
        line: "",
      });
    }

    return {
      tracePath,
      template: request.template,
      attempts: attempt,
      recording: recordingConfigFor(request, profile),
      issues,
      durationMs,
      ...(bytes !== undefined ? { bytes } : {}),
      ...(saveMs !== undefined ? { saveMs } : {}),
    };
  } catch (error) {
    if (!interrupted) {
      // A session that already went live must be asked to close: SIGKILL
      // leaves the device-side tap session behind, and the next recording then
      // hangs before it ever goes live (observed on a real device). Send the
      // same SIGINT Ctrl-C would, then wait out the full save window before
      // forcing it — a hard kill mid-save is what wedges the device service.
      session.stop();
      await waitForClose(session.child, sigkillGraceMs);
      if (
        session.child.exitCode === null &&
        session.child.signalCode === null
      ) {
        session.child.kill("SIGKILL");
      }
    }
    await session.exited.catch(() => undefined);
    await cleanupTrace(request.outputPath);
    throw error;
  }
}

async function cleanupTrace(path: string): Promise<void> {
  // A failed session can leave a 52 KB zip-shaped `.trace` behind. Leaving it
  // would let a later pass "find" a trace that contains no data.
  if (existsSync(path)) {
    await fs.rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Sum regular-file bytes inside a trace bundle.
 *
 * `.trace` is a directory, so `stat(path).size` is meaningless. Symlinks are
 * deliberately skipped: following them could double count files or escape the
 * bundle. The caller turns a read failure into a warning instead of a 0.
 */
async function measureTraceBytes(path: string): Promise<number> {
  const info = await fs.lstat(path);
  if (info.isFile()) {
    return info.size;
  }
  if (!info.isDirectory()) {
    throw new Error(`${path} is not a regular file or directory`);
  }
  let total = 0;
  for (const entry of await fs.readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      total += await measureTraceBytes(child);
    } else if (entry.isFile()) {
      total += (await fs.lstat(child)).size;
    }
  }
  return total;
}

/**
 * Run the scenario callback with an optional deadline.
 *
 * The callback talks to the device, and a single unanswered query is enough to
 * keep xctrace recording long past the scenario. Rejecting here makes the
 * caller's `catch` stop the session now instead of at `timeLimit`.
 */
async function runDuring(
  during: () => Promise<void>,
  timeoutMs: number | undefined,
): Promise<void> {
  if (timeoutMs === undefined) {
    await during();
    return;
  }
  const pending = during();
  // The abandoned callback may settle (or reject) after the deadline; never
  // let that become an unhandled rejection.
  pending.catch(() => undefined);

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new RecordingError(
              `scenario actions did not finish within ${timeoutMs}ms; stopping the recording. ` +
                "A device call inside the actions hung.",
              "aborted",
              false,
            ),
          );
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function parseTimeLimitMs(timeLimit: string | undefined): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(timeLimit ?? "20s");
  if (!match) return 20_000;
  const value = Number(match[1]);
  switch (match[2]) {
    case "ms":
      return value;
    case "s":
      return value * 1_000;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
    default:
      return 20_000;
  }
}

/** Human-readable label used in logs and reports. */
export function describeTarget(target: RecordRequest["target"]): string {
  switch (target.kind) {
    case "attach":
      return `pid ${target.pid}`;
    case "launch":
      return `launch ${target.bundleId}`;
    case "allProcesses":
      return "all processes";
  }
}

/** Exported for tests: template display names as xctrace expects them. */
export const INSTRUMENTS_TEMPLATE_NAMES = TEMPLATE_TO_INSTRUMENTS;

/** Exported for tests: the default trace file name for a non-launch pass. */
export function traceFileName(template: string): string {
  return `${template}.trace`;
}

/** Exported for tests: base name helper mirroring xctrace's own naming. */
export function launchTraceBaseName(path: string): string {
  return basename(path);
}
