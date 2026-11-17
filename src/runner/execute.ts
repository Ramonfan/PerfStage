import { promises as fs } from "node:fs";
import { posix, relative, resolve, sep } from "node:path";
import {
  alignHitchWindow,
  type HitchWindowMiss,
} from "../analysis/parsers/animation-hitches.js";
import { extractDeviceFailureCause } from "../diagnostics/cause.js";
import type { DiagnosticInput } from "../diagnostics/normalize.js";
import { DeviceError } from "../device/types.js";
import type {
  AppInstallation,
  CrashEntry,
  DeviceDriver,
  ForegroundApp,
  UiElement,
} from "../device/types.js";
import type { TestPlan } from "../model/test-plan.js";
import type { ActionRecord, MetricResult, TestRun } from "../model/test-run.js";
import type {
  RecordedTrace,
  RecordingConfig,
  RecordingIssue,
  RecordingTemplate,
  TraceRecorder,
} from "../recording/types.js";
import { analyzePerformanceTrace } from "../tools/analyze.js";
import { executeAction, containsAccessibilityText } from "./actions.js";
import { planPasses, type PassPlan } from "./passes.js";

/**
 * Take execution: the part of the Runner that touches a real device.
 *
 * `runPerformanceTest` (see `run.ts`) owns prepare/finalize and the run state
 * machine; this module owns "make a Take happen": bring the app up, record the
 * passes the plan asks for, replay the scenario actions inside the recorded
 * window, and return evidence. It never decides the final status — that is the
 * evidence gate's job (and it must stay that way, D6).
 */

export interface TraceAnalyzerInput {
  template: RecordingTemplate;
  tracePath: string;
  processName?: string;
  pid?: number;
  /**
   * Trace-relative window that holds the scenario interaction. Set for the
   * hitches pass, which records with `--launch` and therefore also contains
   * the cold-launch frames.
   */
  window?: { fromMs: number; toMs: number };
}

export interface TraceAnalyzerResult {
  metrics: MetricResult[];
  warnings?: string[];
  /**
   * Set by the hitches analyzer when the declared window contained no frames.
   * The Runner uses it for one bounded alignment attempt.
   */
  windowMiss?: HitchWindowMiss;
}

export type TraceAnalyzer = (
  input: TraceAnalyzerInput,
) => Promise<TraceAnalyzerResult | { error: string }>;

export interface PassRecord {
  template: RecordingTemplate;
  passIndex: number;
  /** Run-relative POSIX path, e.g. `traces/hitches.trace`. */
  tracePath: string;
  absoluteTracePath: string;
  attempts: number;
  issues: RecordingIssue[];
  durationMs: number;
  /** Template/instruments/time limit the trace was produced with. */
  recording: RecordingConfig;
  /** Regular-file bytes inside the trace bundle; omitted if unreadable. */
  traceBytes?: number;
  /** Observed xctrace save duration; omitted when the phase was not seen. */
  saveMs?: number;
  /** Metrics this pass produced (canonical names). */
  metrics: string[];
}

/**
 * The scenario declared a starting state the device did not satisfy.
 *
 * Distinguished from a device/recording failure because the request itself is
 * what was wrong: reporting it as `invalid` (gate unknown) is accurate, while
 * `failed` would blame the device for a mis-declared scene.
 */
export class PreconditionFailure extends Error {
  override readonly name = "PreconditionFailure";
}

/**
 * Recognise a precondition violation even after the recorder wrapped it.
 *
 * `during` callbacks run inside the recording session, so the recorder sees the
 * error first and rethrows its own `RecordingError` with the original one as
 * `cause`. Checking only `instanceof` would classify the most common path
 * (hitches pass) as a device failure.
 */
function isPreconditionFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current instanceof PreconditionFailure) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The declared hitches window missed every frame and no bounded shift could
 * recover it.
 *
 * This is a measurement failure, not a device failure: the trace is usable but
 * does not contain the declared interaction. Reporting `invalid` keeps the
 * Take out of regression baselines without inventing `hitches = 0`.
 */
export class WindowAlignmentFailure extends Error {
  override readonly name = "WindowAlignmentFailure";
}

function isWindowAlignmentFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current instanceof WindowAlignmentFailure) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Processes whose reports are device diagnostics, not app crashes.
 *
 * Deliberately a short allow-list: anything not matched below is treated as
 * app scope, so an unknown process still fails the Take. `JetsamEvent` is
 * intentionally absent — it can describe our app being memory-killed, and
 * ignoring it would hide a real failure.
 */
const KNOWN_SYSTEM_PROCESS_PATTERNS: readonly RegExp[] = [
  /^SFA-/,
  /^DTServiceHub(?:\.|$)/,
  /^WiFiLQMMetrics$/,
  /^locationd(?:\.|$)/,
  /^proactive_event_tracker-/,
  /^xp_amp_/,
];

/**
 * Decide whether a crash report belongs to the app under test.
 *
 * `process` is the only stable attribution the device layer exposes. A report
 * without it is app scope: a missing field must never turn a real crash into a
 * silent "system report".
 */
export function isAppScopedCrash(
  entry: CrashEntry,
  installation: AppInstallation,
): boolean {
  const process = entry.process?.trim();
  if (process === undefined || process.length === 0) {
    return true;
  }
  if (
    process === installation.processName ||
    process === installation.bundleId ||
    process.startsWith(`${installation.bundleId}.`)
  ) {
    return true;
  }
  return !KNOWN_SYSTEM_PROCESS_PATTERNS.some((pattern) => pattern.test(process));
}

export function classifyFreshCrashes(
  entries: readonly CrashEntry[],
  knownIds: ReadonlySet<string>,
  installation: AppInstallation,
): { appScoped: CrashEntry[]; system: CrashEntry[] } {
  const appScoped: CrashEntry[] = [];
  const system: CrashEntry[] = [];
  for (const entry of entries) {
    if (knownIds.has(entry.id)) {
      continue;
    }
    if (isAppScopedCrash(entry, installation)) {
      appScoped.push(entry);
    } else {
      system.push(entry);
    }
  }
  return { appScoped, system };
}

export interface TakeExecution {
  actions: ActionRecord[];
  metrics: MetricResult[];
  diagnostics: DiagnosticInput;
  passes: PassRecord[];
  notes: string[];
  /**
   * Device facts captured by preflight. Absent when the Take failed before
   * the device was reached; finalize must not fabricate a version then.
   */
  device?: TestRun["device"];
  /** Set when a fatal device/recording error ended the Take early. */
  fatalError?: string;
  /**
   * Status to request when {@link fatalError} is set. Defaults to `failed`;
   * precondition violations resolve to `invalid`.
   */
  fatalStatus?: "failed" | "invalid";
  /** Full device log stream; the Runner persists it to `device.log`. */
  fullLogText?: string;
  repetitions: number;
}

export interface ExecuteTakeDependencies {
  device: DeviceDriver;
  recorder: TraceRecorder;
  /** Run directory (absolute). Traces are written under `<runDir>/traces`. */
  runDir: string;
  now: () => Date;
  analyze?: TraceAnalyzer;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  /** Wait after the app reaches the foreground before measuring. */
  settleMs?: number;
  /** Wait before the launch pass so the previous session fully releases. */
  launchSettleMs?: number;
  /** Wait after a cold launch before the memory pass. */
  memorySettleMs?: number;
  /**
   * Wait between recording passes. The device-side Instruments service needs
   * time to release a session; 2 s is not enough on a real device and a new
   * session started too early fails with `Failed starting ktrace session`.
   */
  passCooldownMs?: number;
  /**
   * Run a cheap "can the app stay alive?" probe before recording. Enabled by
   * the Runner; tests turn it off because they assert pass-by-pass device I/O.
   */
  healthCheck?: boolean;
  /** How long the health probe waits before expecting the app to be alive. */
  healthCheckSettleMs?: number;
  /**
   * Bound on one `apps foreground` query. Mainly a test knob; production uses
   * {@link FOREGROUND_PROBE_TIMEOUT_MS}.
   */
  foregroundProbeTimeoutMs?: number;
  foregroundTimeoutMs?: number;
  /** Best-effort post-launch lifecycle probe; never fails the Take. */
  postLaunchSampleMs?: number;
  elementTimeoutMs?: number;
  /**
   * Shortest action window that counts as a measurement. Tests run actions
   * instantly and override this to 0; production keeps the default so an empty
   * window cannot report "0 hitches".
   */
  minimumWindowMs?: number;
}

export interface ExecuteTakeInput {
  plan: TestPlan;
  deviceId: string;
  /** Map canonical metric name -> threshold from the plan. */
  thresholds?: Record<string, { warn?: number; fail?: number }>;
}

const DEFAULTS = {
  settleMs: 4_000,
  launchSettleMs: 2_000,
  memorySettleMs: 8_000,
  passCooldownMs: 10_000,
  healthCheckSettleMs: 3_000,
  foregroundTimeoutMs: 20_000,
  /**
   * A window shorter than this means the actions occupied no measurable time
   * (an empty plan, or every action failing instantly). Reporting 0 hitches
   * from such a window would look like a perfect score.
   */
  minimumWindowMs: 250,
};

/**
 * How long one `apps foreground` query may take before it is abandoned.
 *
 * The device-side Instruments service serves both the recording and this
 * query. A recording can starve the query for minutes, so a per-call bound is
 * what keeps `during` (and therefore the recording session) from running to
 * `timeLimit`. See docs/m3-validation.md §4.10.
 */
const FOREGROUND_PROBE_TIMEOUT_MS = 5_000;

const defaultAnalyzer: TraceAnalyzer = async (input) => {
  const result = await analyzePerformanceTrace({
    template: input.template,
    tracePath: input.tracePath,
    ...(input.processName !== undefined ? { processName: input.processName } : {}),
    ...(input.pid !== undefined ? { pid: input.pid } : {}),
    ...(input.window !== undefined ? { window: input.window } : {}),
  });
  if ("error" in result) {
    return { error: result.error };
  }
  return {
    metrics: result.metrics,
    warnings: result.warnings,
    ...(result.windowMiss !== undefined ? { windowMiss: result.windowMiss } : {}),
  };
};

function toRunRelative(runDir: string, absolutePath: string): string {
  const rel = relative(resolve(runDir), resolve(absolutePath));
  if (rel.startsWith("..") || rel.length === 0) {
    return absolutePath;
  }
  return rel.split(sep).join(posix.sep);
}

/** Median of a sorted copy; returns `null` for an empty list. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? null;
  }
  const left = sorted[middle - 1];
  const right = sorted[middle];
  if (left === undefined || right === undefined) return null;
  return (left + right) / 2;
}

/**
 * Execute the plan once (or `repetitions` times) against the device.
 *
 * Errors are captured rather than thrown so the caller can still finalize an
 * honest `failed` Take with whatever evidence was collected. A Runner that
 * throws instead of writing a report is worse than useless: the operator has no
 * record of what happened.
 */
export async function executeTake(
  input: ExecuteTakeInput,
  deps: ExecuteTakeDependencies,
): Promise<TakeExecution> {
  const { plan, deviceId } = input;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const log = deps.log ?? (() => undefined);
  const analyze = deps.analyze ?? defaultAnalyzer;
  const nowIso = () => deps.now().toISOString();

  const notes: string[] = [];
  const actions: ActionRecord[] = [];
  const passes: PassRecord[] = [];
  const lifecycle: NonNullable<DiagnosticInput["lifecycle"]> = [];
  const tracesDir = resolve(deps.runDir, "traces");

  const planning = planPasses(plan.metrics.map((metric) => metric.name));
  const repetitions = Math.max(1, plan.repetitions);
  const diagnostics: DiagnosticInput = { lifecycle };

  if (planning.unsupported.length > 0) {
    notes.push(
      `unsupported metrics skipped: ${planning.unsupported.join(", ")}`,
    );
  }

  const perMetricSamples = new Map<string, unknown[]>();
  const perMetricTraces = new Map<string, string[]>();
  const perMetricAttrs = new Map<
    string,
    { unit?: string; instrument?: string }
  >();

  let fatalError: string | undefined;
  let fatalStatus: "failed" | "invalid" | undefined;
  let logStream: ReturnType<DeviceDriver["startLogStream"]> | null = null;
  let fullLogText: string | undefined;
  let deviceFacts: TestRun["device"];
  /**
   * Preflight facts the finally block needs after the try scope ends. A Take
   * that failed before installation resolution leaves it undefined, and the
   * crash classifier then treats every new report conservatively.
   */
  let installationForDiagnostics: AppInstallation | undefined;
  /**
   * Whether the pre-Take crash baseline was actually read.
   *
   * Without a baseline every report on the device looks "new"; querying the
   * list anyway would turn the device's crash history into a fabricated
   * `new-crash` failure on a Take that failed before recording even started.
   */
  let crashBaselineCaptured = false;
  const knownCrashIds = new Set<string>();

  try {
    // ── Preflight ────────────────────────────────────────────────────
    const device = await deps.device.requireDevice(deviceId);
    log(`device ${device.name} (${device.id}) ${device.version}`);
    // `DeviceInfo` is a typed view over `mobilecli` JSON. Guard the optional
    // text fields at runtime so a partial device record cannot turn a healthy
    // Take into a failed one, and so an empty version is recorded as "not
    // reported" instead of an empty string.
    const knownText = (value: unknown): value is string =>
      typeof value === "string" && value.length > 0;
    deviceFacts = {
      id: device.id,
      ...(knownText(device.name) ? { name: device.name } : {}),
      ...(knownText(device.version) ? { osVersion: device.version } : {}),
      ...(knownText(device.model) ? { modelIdentifier: device.model } : {}),
    };
    const installation = await deps.device.resolveInstallation(
      deviceId,
      plan.app.bundleId,
    );
    log(
      `app ${installation.name} ${installation.version} container=${installation.containerUuid}`,
    );
    // A wedged WDA/agent turns every later device call into a 30s timeout.
    // Probe it before any trace so that failure costs one bounded query
    // instead of a recorded session plus repeated retries.
    try {
      await deps.device.probeAgent(deviceId);
    } catch (error) {
      // Keep the device error kind (`timeout`, `device-unavailable`, ...) so
      // callers can classify the failure without parsing the message.
      throw new DeviceError(
        `device preflight failed: the automation agent did not answer for ${plan.app.bundleId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof DeviceError ? error.kind : "device-unavailable",
        error instanceof DeviceError ? error.details : undefined,
      );
    }
    log("preflight: automation agent responded");
    const crashBaseline = await deps.device.crashReports(deviceId);
    diagnostics.crashIdsBefore = crashBaseline.map((entry) => entry.id);
    for (const entry of crashBaseline) {
      knownCrashIds.add(entry.id);
    }
    installationForDiagnostics = installation;
    crashBaselineCaptured = true;
    log(`crash list before: ${diagnostics.crashIdsBefore.length} entries`);
    logStream = deps.device.startLogStream(deviceId, installation.processName);

    if (planning.passes.length === 0) {
      throw new Error(
        `plan requests no collectable metrics (${plan.metrics
          .map((metric) => metric.name)
          .join(", ") || "none"})`,
      );
    }

    /**
     * Cheap health probe before any recording starts.
     *
     * Recording is the expensive, device-stressing part: each pass is a cold
     * launch plus a multi-hundred-megabyte session. If the app cannot stay up
     * for a few seconds, the Take is doomed — M3 spent 82 seconds producing
     * three broken traces before noticing (docs/m3-validation.md §4.9). This
     * probe costs ~5 seconds and turns that into a one-line failure.
     */
    const checkAppHealth = async (): Promise<void> => {
      if (deps.healthCheck !== true) {
        return;
      }
      const settle = deps.healthCheckSettleMs ?? DEFAULTS.healthCheckSettleMs;
      const before = await deps.device.resolvePid(
        deviceId,
        installation.containerUuid,
      );
      if (before === null) {
        await deps.device.launch(deviceId, plan.app.bundleId);
      }
      await sleep(settle);
      const after = await deps.device.resolvePid(
        deviceId,
        installation.containerUuid,
      );
      if (after === null) {
        lifecycle.push({
          kind: "app_exit",
          occurredAt: nowIso(),
          notes: `exited within ${settle}ms of launch`,
        });
        throw new Error(
          `${plan.app.bundleId} did not stay running for ${settle}ms after launch; ` +
            "refusing to record an app that cannot start (check device.log, then relaunch by hand)",
        );
      }
      const crashes = await deps.device.crashReports(deviceId).catch(() => []);
      const { appScoped, system } = classifyFreshCrashes(
        crashes,
        knownCrashIds,
        installation,
      );
      if (system.length > 0) {
        notes.push(
          `ignored system crash reports during the health check: ${system
            .map((entry) => entry.id)
            .join(", ")}`,
        );
      }
      if (appScoped.length > 0) {
        const ids = appScoped.map((entry) => entry.id);
        lifecycle.push({
          kind: "app_exit",
          occurredAt: nowIso(),
          notes: `new crash reports: ${ids.join(", ")}`,
        });
        throw new Error(
          `${plan.app.bundleId} crashed during the health check (${ids.join(", ")}); ` +
            "refusing to record until the app starts cleanly",
        );
      }
      log(`health check ok (pid ${after} alive after ${settle}ms)`);
    };

    await checkAppHealth();

    // Only now can a recording happen. Keeping the directory creation behind
    // preflight means a failed agent probe leaves no `traces/` directory at
    // all, not just an empty one.
    await fs.mkdir(tracesDir, { recursive: true });

    for (let round = 1; round <= repetitions; round += 1) {
      if (repetitions > 1) {
        log(`repetition ${round}/${repetitions}`);
      }
      const sink: RoundSink = {
        actions: [],
        metrics: [],
        passes: [],
        notes: [],
      };
      try {
        await measureRound({
          round,
          repetitions,
          plan,
          deviceId,
          installation,
          planning,
          tracesDir,
          screenSize: device.screenSize,
          deps: { ...deps, sleep, log, analyze },
          nowIso,
          lifecycle,
          sink,
        });
      } finally {
        // Merge even when the round threw: measurements taken before the
        // failure are real evidence and must survive into the failed report.
        actions.push(...sink.actions);
        passes.push(...sink.passes);
        notes.push(...sink.notes);
        for (const metric of sink.metrics) {
          const bucket = perMetricSamples.get(metric.name) ?? [];
          bucket.push(metric.value);
          perMetricSamples.set(metric.name, bucket);
          const traces = perMetricTraces.get(metric.name) ?? [];
          if (typeof metric.tracePath === "string") {
            traces.push(metric.tracePath);
          }
          perMetricTraces.set(metric.name, traces);
          perMetricAttrs.set(metric.name, {
            unit: metric.unit,
            instrument: metric.instrument,
          });
        }
      }
    }
  } catch (error) {
    fatalError = error instanceof Error ? error.message : String(error);
    if (isPreconditionFailure(error) || isWindowAlignmentFailure(error)) {
      fatalStatus = "invalid";
      // Metrics from earlier passes stay in the report as evidence, but they
      // must not read as a verdict on a scene whose starting state was wrong.
      if (perMetricSamples.size > 0) {
        notes.push(
          "take invalid: metrics from earlier passes are retained as evidence, not as a verdict on the declared scene",
        );
      }
    }
    log(`take failed: ${fatalError}`);
    notes.push(`fatal: ${fatalError}`);
  } finally {
    // Evidence is collected even when the Take fails: a failed report with logs
    // and crashes is how the operator learns why it failed.
    //
    // The post-Take crash diff is only meaningful against a baseline. When the
    // preflight failed before that baseline was read, querying the list would
    // label the device's whole crash history as new — a fabricated `new-crash`
    // failure. Report the evidence gap instead.
    if (!crashBaselineCaptured) {
      diagnostics.crashQueryError =
        "crash baseline was not captured before the preflight failed; new crashes cannot be determined";
      notes.push(
        "crash evidence unavailable: the pre-Take baseline was not read before the failure",
      );
    } else {
      try {
        const after = await deps.device.crashReports(deviceId);
        diagnostics.crashIdsAfter = after.map((entry) => entry.id);
        diagnostics.crashReports = after;
        const { appScoped, system } = classifyFreshCrashes(
          after,
          knownCrashIds,
          // A baseline implies an installation; the fallback keeps legacy
          // callers conservative if that invariant is ever broken.
          installationForDiagnostics ?? {
            bundleId: "",
            processName: "",
            name: "",
            version: "",
            containerUuid: "",
          },
        );
        if (system.length > 0) {
          diagnostics.ignoredIds = system.map((entry) => entry.id);
          notes.push(
            `ignored system crash reports during the take: ${system
              .map(
                (entry) =>
                  `${entry.id}${entry.process !== undefined ? ` (${entry.process})` : ""}`,
              )
              .join(", ")}`,
          );
        }
        if (appScoped.length > 0) {
          notes.push(
            `new crash reports during the take: ${appScoped
              .map((entry) => entry.id)
              .join(", ")}`,
          );
        }
      } catch (error) {
        // Cannot diff without the post-Take list either: mark the evidence
        // unavailable rather than letting an empty diff look clean.
        diagnostics.crashQueryError =
          error instanceof Error ? error.message : String(error);
        notes.push(`crash list after failed: ${diagnostics.crashQueryError}`);
      }
    }
    if (logStream !== null) {
      let captured:
        | {
            text: string;
            stderr: string;
            exitedEarly: boolean;
            lineCount: number;
            exitReason?: string;
          }
        | undefined;
      try {
        captured = await logStream.stop();
      } catch (error) {
        // A failed stop tells us nothing about the log's completeness. Falling
        // through with empty text would look exactly like a clean, empty log;
        // record the read failure instead.
        const message = error instanceof Error ? error.message : String(error);
        diagnostics.logQueryError = message;
        notes.push(`device log stream failed to stop: ${message}`);
      }
      if (captured !== undefined) {
        // Keep the whole stream for the category scan. `report.json` drops the
        // text itself once `device.log` exists (see `buildJsonReport`), so the
        // report stays small while diagnostics still see every line — capping
        // the text here would silently hide errors from the first half of a
        // long log.
        diagnostics.logText = captured.text;
        if (captured.exitedEarly) {
          // A stream that ended on its own is a fragment. Do not turn it into
          // `logQueryError` (that means "could not read"); expose it as a
          // truncation warning so the report can distinguish "empty", "partial"
          // and "unavailable".
          diagnostics.logTruncated = true;
          diagnostics.logTruncationReason =
            captured.exitReason ??
            (captured.stderr.trim() || "the log stream ended before the Take finished");
          notes.push(`device log truncated: ${diagnostics.logTruncationReason}`);
        } else {
          diagnostics.logQueryError = captured.stderr.trim() || undefined;
        }
        fullLogText = captured.text;
        log(`device log stream ended after ${captured.lineCount} line(s)`);
        // The device log is the only place that says *why* the app died. On a
        // failed Take, put the first actionable line in the report instead of
        // making the reader search `device.log`.
        const cause = extractDeviceFailureCause(captured.text);
        if (cause !== null && fatalError !== undefined) {
          notes.push(`device log: ${cause}`);
          fatalError = `${fatalError}; device log: ${cause}`;
        }
      }
    }
    // Recovery events are recorded by the device driver during this Take
    // (at most one daemon restart). Surface them as lifecycle evidence rather
    // than leaving the restart invisible in the report.
    for (const event of deps.device.drainRecoveryEvents()) {
      lifecycle.push({
        kind: "daemon_restart",
        // Use the Take clock for every lifecycle event; the driver has no
        // injected clock, and mixing its wall clock with `deps.now()` would
        // put this event outside the run window in tests and reports.
        occurredAt: nowIso(),
        notes: `${event.recovered ? "recovered" : "retry failed"} after ${event.context}: ${event.error}`,
      });
    }
  }

  const metrics = aggregateMetrics({
    samples: perMetricSamples,
    traces: perMetricTraces,
    attrs: perMetricAttrs,
    thresholds: input.thresholds,
  });

  return {
    actions,
    metrics,
    diagnostics,
    passes,
    notes,
    ...(deviceFacts !== undefined ? { device: deviceFacts } : {}),
    ...(fatalError !== undefined ? { fatalError } : {}),
    ...(fatalStatus !== undefined ? { fatalStatus } : {}),
    ...(fullLogText !== undefined ? { fullLogText } : {}),
    repetitions,
  };
}

function aggregateMetrics(input: {
  samples: Map<string, unknown[]>;
  traces: Map<string, string[]>;
  attrs: Map<string, { unit?: string; instrument?: string }>;
  thresholds?: Record<string, { warn?: number; fail?: number }>;
}): MetricResult[] {
  const metrics: MetricResult[] = [];
  const names = [...input.samples.keys()];

  for (const name of names) {
    const values = input.samples.get(name) ?? [];
    const numeric = values.filter(
      (value): value is number => typeof value === "number" && Number.isFinite(value),
    );
    const traces = input.traces.get(name) ?? [];
    const attrs = input.attrs.get(name) ?? {};
    const threshold = input.thresholds?.[name];
    const measuredAt = new Date().toISOString();

    // A metric with no samples is still reported: the evidence gate must see
    // that it was requested and produced nothing.
    const base: MetricResult = {
      name,
      ...(attrs.unit !== undefined ? { unit: attrs.unit } : {}),
      ...(attrs.instrument !== undefined ? { instrument: attrs.instrument } : {}),
      ...(traces.length > 0 ? { tracePath: traces[traces.length - 1] } : {}),
      ...(threshold !== undefined ? { threshold } : {}),
      measuredAt,
    };

    if (numeric.length === 0) {
      metrics.push(base);
      continue;
    }

    if (numeric.length === 1) {
      metrics.push({ ...base, value: numeric[0] });
      continue;
    }

    const middle = median(numeric);
    metrics.push({
      ...base,
      ...(middle !== null ? { value: middle } : {}),
      samples: numeric,
      aggregation: "median",
      ...(traces.length > 0 ? { tracePaths: traces } : {}),
    });
  }

  return metrics;
}

interface MeasureRoundInput {
  round: number;
  repetitions: number;
  plan: TestPlan;
  deviceId: string;
  installation: { bundleId: string; name: string; containerUuid: string };
  planning: { passes: PassPlan[]; unsupported: string[] };
  tracesDir: string;
  /** Real screen size from `requireDevice`; swipes fail without it. */
  screenSize?: { width: number; height: number };
  deps: ExecuteTakeDependencies & {
    sleep: (ms: number) => Promise<void>;
    log: (message: string) => void;
    analyze: TraceAnalyzer;
  };
  nowIso: () => string;
  lifecycle: NonNullable<DiagnosticInput["lifecycle"]>;
  /**
   * Accumulates results as they happen rather than at the end of the round.
   *
   * A Take can die late (a device unplugged during the memory pass) after two
   * traces were already recorded and analyzed. Returning only on success would
   * throw those measurements away and leave a `failed` report with no metrics,
   * which reads as "nothing was measured" instead of "the device went away
   * after the hitches and launch passes".
   */
  sink: RoundSink;
}

interface RoundSink {
  actions: ActionRecord[];
  metrics: MetricResult[];
  passes: PassRecord[];
  notes: string[];
}

async function measureRound(input: MeasureRoundInput): Promise<void> {
  const { deps, plan, deviceId, installation, planning, tracesDir } = input;
  // A multi-repetition Take records the same pass template several times. Keep
  // each round's trace in its own directory: overwriting `traces/hitches.trace`
  // would leave pass records whose bytes can no longer be recomputed from disk.
  const roundTracesDir =
    input.repetitions > 1
      ? resolve(tracesDir, `rep-${input.round}`)
      : tracesDir;
  const sleep = deps.sleep;
  const log = deps.log;
  const { actions, metrics, notes } = input.sink;
  const recorded = input.sink.passes;

  /**
   * Cold-start options every `xctrace --launch` in this Take must carry.
   *
   * Declared once so hitches and launch passes cannot drift: a scenario that
   * needs a test-mode flag must not silently measure a differently-configured
   * app in one of the two passes.
   */
  const launchOptions =
    plan.app.launchArguments.length > 0 ||
    Object.keys(plan.app.environmentVariables).length > 0
      ? {
          arguments: plan.app.launchArguments,
          environment: plan.app.environmentVariables,
        }
      : undefined;

  /** Notes are per round; keep repeated infrastructure facts to one line. */
  const noteOnce = (note: string): void => {
    if (!notes.includes(note)) {
      notes.push(note);
    }
  };

  /**
   * Whether `app.launchUrl` is already applied for the running app process.
   *
   * A deep link is only meaningful once per process start: opening it again
   * after warmup or actions would navigate back to the entry screen and make
   * the memory pass measure a different screen than the hitches pass. The flag
   * is cleared wherever the app is (re)started, so every repetition still
   * starts from the declared entry point.
   */
  let launchUrlApplied = false;

  const passFor = (template: RecordingTemplate): PassPlan | undefined =>
    planning.passes.find((entry) => entry.template === template);

  const waitForForeground = async (): Promise<string> => {
    const deadline = Date.now() + (deps.foregroundTimeoutMs ?? DEFAULTS.foregroundTimeoutMs);
    // Remember what was actually in front: "did not reach the foreground" alone
    // sends the operator looking at the app, but on a real device the usual
    // cause is another app's system alert (local-network / notification
    // permission) sitting on top. Naming it turns a mystery into a one-tap fix.
    let blockedBy: string | null = null;
    while (Date.now() <= deadline) {
      const app = await probeForeground();
      if (app !== null && app.bundleId === plan.app.bundleId) {
        return app.activity ?? "unknown";
      }
      if (app !== null) {
        blockedBy =
          app.activity === undefined || app.activity === null
            ? app.bundleId
            : `${app.bundleId} (${app.activity})`;
      }
      await sleep(500);
    }
    throw new Error(
      `${plan.app.bundleId} did not reach the foreground within ${
        deps.foregroundTimeoutMs ?? DEFAULTS.foregroundTimeoutMs
      }ms${blockedBy === null ? "" : `; foreground was ${blockedBy}`}`,
    );
  };

  /**
   * Query the foreground app with a hard per-call bound.
   *
   * `apps foreground` and the recording session share the device-side
   * Instruments service. During a recording the query can go unanswered for
   * minutes; on 2026-11-13 one never returned and kept an 8s action window
   * recording for 60s (4.7 GB, docs/m3-validation.md §4.10). Returning `null`
   * keeps every caller's own deadline meaningful.
   */
  const probeTimeoutMs =
    deps.foregroundProbeTimeoutMs ?? FOREGROUND_PROBE_TIMEOUT_MS;
  const probeForeground = async (): Promise<ForegroundApp | null> => {
    const query = deps.device.foreground(deviceId);
    // The abandoned query still settles eventually; do not turn that into an
    // unhandled rejection.
    query.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        query,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), probeTimeoutMs);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  /**
   * Best-effort foreground probe used for lifecycle evidence only.
   *
   * It must not fail the Take: a missed poll is a gap in the lifecycle record,
   * not proof that the app never came up. The memory pass re-establishes the
   * foreground explicitly, so nothing downstream depends on this answer.
   */
  const sampleForeground = async (
    timeoutMs = deps.postLaunchSampleMs ?? 3_000,
  ): Promise<string | null> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const app = await probeForeground();
      if (app !== null && app.bundleId === plan.app.bundleId) {
        return app.activity ?? "unknown";
      }
      await sleep(250);
    }
    return null;
  };

  const bringToForeground = async (): Promise<void> => {
    await deps.device.terminate(deviceId, plan.app.bundleId).catch(() => undefined);
    await sleep(1_500);
    await deps.device.launch(deviceId, plan.app.bundleId);
    // A new process starts on its own initial screen, so the deep link must be
    // applied again for this launch.
    launchUrlApplied = false;
    // `mobilecli apps launch` accepts no argv and no environment, so a warm
    // relaunch cannot reproduce the declared cold-start configuration. Say so
    // instead of letting the report imply both paths were identical.
    if (launchOptions !== undefined) {
      noteOnce(
        "warm relaunch via mobilecli does not carry launch arguments/environment",
      );
    }
    const activity = await waitForForeground();
    input.lifecycle.push({
      kind: "foreground",
      occurredAt: input.nowIso(),
      notes: `activity ${activity}`,
    });
    await sleep(deps.settleMs ?? DEFAULTS.settleMs);
  };

  const runOne = async (
    action: (typeof plan.actions)[number],
    notes: string | undefined,
  ): Promise<void> => {
    const record = await executeAction(action, {
      device: deps.device,
      deviceId,
      now: deps.now,
      ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
      ...(deps.elementTimeoutMs !== undefined
        ? { elementTimeoutMs: deps.elementTimeoutMs }
        : {}),
      ...(input.screenSize !== undefined
        ? { screenSize: input.screenSize }
        : {}),
    });
    const mergedNotes = [notes, record.notes].filter(Boolean).join(" | ");
    actions.push(
      mergedNotes.length > 0 ? { ...record, notes: mergedNotes } : record,
    );
    // Name the failure or the gesture coordinates in the live log too: the
    // report has them, but the operator watching the run needs them as it
    // happens.
    const detail =
      record.error !== undefined
        ? ` (${record.error})`
        : record.notes !== undefined
          ? ` (${record.notes})`
          : "";
    log(`action ${action.id}: ${record.outcome}${detail}`);
  };

  const runActions = async (): Promise<void> => {
    const notes = input.repetitions > 1
      ? `repetition ${input.round}/${input.repetitions}`
      : undefined;
    for (const action of plan.actions) {
      await runOne(action, notes);
    }
  };

  /**
   * Warmup actions navigate to the screen under test (the 社区/消息 tab).
   *
   * They must not be scored: in the hitches pass they run inside the trace but
   * before `actionStart`, so the analyzer's window excludes them; in the
   * memory pass they run before the measurement starts. They run once per
   * repetition so a Take that starts from a cold app measures the same screen
   * every time.
   */
  let warmedUp = false;
  const runWarmup = async (force = false): Promise<void> => {
    if (warmedUp && !force) {
      return;
    }
    warmedUp = true;
    if (plan.warmup.length === 0) {
      return;
    }
    for (const action of plan.warmup) {
      await runOne(action, "warmup");
    }
  };

  /**
   * Open `app.launchUrl` after the app is in front and before warmup.
   *
   * Ordering is the whole point: the deep link navigates to the screen under
   * test, so it must land inside the recording but before `actionStart`, where
   * the hitches window begins. Doing it after warmup would waste recorded
   * frames; doing it before launch would hide the app's real cold start.
   */
  const applyLaunchUrl = async (): Promise<void> => {
    if (plan.app.launchUrl === undefined || launchUrlApplied) {
      return;
    }
    log(`open ${plan.app.launchUrl}`);
    try {
      await deps.device.openUrl(deviceId, plan.app.launchUrl);
    } catch (error) {
      throw new Error(
        `could not open ${plan.app.launchUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    launchUrlApplied = true;
    // The link starts a navigation; give it a moment before actions assume the
    // target screen is interactive.
    await sleep(deps.settleMs ?? DEFAULTS.settleMs);
  };

  /**
   * Enforce the scenario's preconditions before anything gets scored.
   *
   * A Take that measures the wrong screen produces plausible numbers, which is
   * worse than no numbers: it enters history as a valid baseline. Failing here
   * keeps the run `failed` and the reason in `notes`.
   */
  const enforcePreconditions = async (): Promise<void> => {
    if (plan.preconditions.length === 0) {
      return;
    }
    const foreground = await probeForeground();
    if (foreground === null) {
      throw new PreconditionFailure(
        `could not read the foreground app within ${probeTimeoutMs}ms to check preconditions`,
      );
    }
    let elements: UiElement[] | null = null;
    for (const condition of plan.preconditions) {
      if (
        condition.foregroundBundleId !== undefined &&
        foreground.bundleId !== condition.foregroundBundleId
      ) {
        throw new PreconditionFailure(
          `precondition failed: ${condition.description} (foreground was ${foreground.bundleId})`,
        );
      }
      if (condition.accessibilityText !== undefined) {
        elements ??= await deps.device.dumpElements(deviceId);
        if (!containsAccessibilityText(elements, condition.accessibilityText)) {
          throw new PreconditionFailure(
            `precondition failed: ${condition.description} (no element contains "${condition.accessibilityText}")`,
          );
        }
      }
      log(`precondition ok: ${condition.description}`);
    }
    noteOnce(
      `preconditions verified: ${plan.preconditions
        .map((condition) => condition.description)
        .join("; ")}`,
    );
  };

  /**
   * Persist a pass as soon as its trace is written.
   *
   * Analysis and the hitches window check can fail afterwards, but the trace
   * that already landed on disk is evidence: its path, wall clock, bytes and
   * save duration must survive so a failed Take stays auditable instead of
   * leaving an orphan trace with no pass record.
   */
  const recordTrace = (pass: PassPlan, trace: RecordedTrace): PassRecord => {
    const record: PassRecord = {
      template: pass.template,
      passIndex: pass.index,
      tracePath: toRunRelative(deps.runDir, trace.tracePath),
      absoluteTracePath: trace.tracePath,
      attempts: trace.attempts,
      issues: trace.issues,
      durationMs: trace.durationMs,
      recording: trace.recording,
      ...(trace.bytes !== undefined ? { traceBytes: trace.bytes } : {}),
      ...(trace.saveMs !== undefined ? { saveMs: trace.saveMs } : {}),
      // Filled after analysis succeeds: a pass that never produced a value
      // must not claim its requested metrics as evidence.
      metrics: [],
    };
    recorded.push(record);
    if (trace.attempts > 1) {
      notes.push(
        `${pass.template} pass needed ${trace.attempts} attempts (recording infrastructure)`,
      );
    }
    const errors = trace.issues.filter((issue) => issue.level === "error");
    if (errors.length > 0) {
      notes.push(
        `${pass.template} pass reported ${errors.length} xctrace error(s): ${errors
          .map((issue) => issue.message)
          .join("; ")}`,
      );
    }
    return record;
  };

  const analyzeTrace = async (
    pass: PassPlan,
    trace: RecordedTrace,
    extra: {
      processName?: string;
      pid?: number;
      window?: { fromMs: number; toMs: number };
    },
    passRecord: PassRecord,
  ): Promise<void> => {
    const relativePath = toRunRelative(deps.runDir, trace.tracePath);
    const pushWarnings = (result: TraceAnalyzerResult): void => {
      // Analyzer warnings matter to trust: "no frames in the window" or a
      // skipped row means the number may under-count. They must reach the
      // report instead of living only in the trace-analysis response.
      if (result.warnings !== undefined && result.warnings.length > 0) {
        notes.push(`${pass.template} analysis: ${result.warnings.join("; ")}`);
      }
    };

    let analyzed = await deps.analyze({
      template: pass.template,
      tracePath: trace.tracePath,
      ...extra,
    });
    if ("error" in analyzed) {
      throw new Error(
        `analyze_performance_trace failed for ${pass.template}: ${analyzed.error}`,
      );
    }
    // A declared window can miss the interaction when the recording session
    // starts later than `during` observed. Retry once with a bounded shift
    // derived from the trace's own frame timeline; never report the empty
    // window as `hitches = 0`.
    const alignmentAttempted =
      pass.template === "hitches" &&
      extra.window !== undefined &&
      analyzed.windowMiss !== undefined;
    if (alignmentAttempted) {
      // The parser's original reasons must reach the report before alignment
      // is attempted; the trace has already been recorded by `recordTrace`.
      pushWarnings(analyzed);
      const declared = extra.window!;
      const alignment = alignHitchWindow(analyzed.windowMiss!);
      if (!alignment.ok) {
        throw new WindowAlignmentFailure(
          `hitches window ${Math.round(declared.fromMs)}–${Math.round(declared.toMs)}ms ` +
            `missed the recorded interaction and could not be aligned: ${alignment.reason}`,
        );
      }
      const aligned = alignment.alignment;
      notes.push(
        `hitches window realigned: declared ${Math.round(declared.fromMs)}–${Math.round(
          declared.toMs,
        )}ms, shift ${Math.round(aligned.shiftMs)}ms, aligned ${Math.round(
          aligned.window.fromMs,
        )}–${Math.round(aligned.window.toMs)}ms (${aligned.frameCount} frames)`,
      );
      const realigned = await deps.analyze({
        template: pass.template,
        tracePath: trace.tracePath,
        ...extra,
        window: aligned.window,
      });
      if ("error" in realigned) {
        throw new WindowAlignmentFailure(
          `analyze_performance_trace failed for ${pass.template} after a bounded window alignment: ${realigned.error}`,
        );
      }
      if (realigned.windowMiss !== undefined) {
        throw new WindowAlignmentFailure(
          `hitches window ${Math.round(aligned.window.fromMs)}–${Math.round(
            aligned.window.toMs,
          )}ms still contained no frames after alignment`,
        );
      }
      analyzed = realigned;
    }
    for (const metric of analyzed.metrics) {
      metrics.push({ ...metric, tracePath: relativePath });
    }
    pushWarnings(analyzed);
    // Analysis succeeded, so the pass can now claim the metrics it produced.
    passRecord.metrics = pass.metrics;
  };

  const hitchesPass = passFor("hitches");
  const launchPass = passFor("launch");
  const memoryPass = passFor("memory");

  // `xctrace --launch` ends the App Launch recording by backgrounding the app,
  // so the launch pass cannot produce lifecycle evidence on its own. Observe a
  // real foreground state first; the measurement stays cold because the app is
  // terminated again right before the recording starts.
  if (hitchesPass === undefined && launchPass !== undefined) {
    await bringToForeground();
  }

  // ── Pass 1: Animation Hitches (hitches + blockMs) ───────────────────
  if (hitchesPass !== undefined) {
    const pass = hitchesPass;

    // Record with `--launch`, never `--attach <pid>`.
    //
    // The M0 spike already found attach race-prone on this toolchain
    // (`Cannot find process for provided pid` for a live pid, sometimes for
    // tens of minutes) and `--launch` stable. M2/M3 used attach anyway to keep
    // warmup out of the recording window; that traded a permanent measurement
    // guarantee for a device-side race we cannot control. Instead we let
    // xctrace launch the app and restrict the metric to the action window
    // (see `window` below), which keeps warmup out of the numbers without
    // touching the process table at all.
    await deps.device
      .terminate(deviceId, plan.app.bundleId)
      .catch(() => undefined);
    await sleep(deps.launchSettleMs ?? DEFAULTS.launchSettleMs);

    // Trace time 0 is the live session, and `during` starts right after the
    // recorder observes it, so host deltas from here are trace offsets.
    let sessionStart = 0;
    let actionStart = 0;
    let actionEnd = 0;

    log("hitches pass (launch)");
    const trace = await deps.recorder.record({
      template: "hitches",
      device: deviceId,
      target: { kind: "launch", bundleId: plan.app.bundleId },
      ...(launchOptions !== undefined ? { launch: launchOptions } : {}),
      outputPath: resolve(roundTracesDir, "hitches.trace"),
      // `during` stops the session right after the last action; this is only a
      // safety cap. `duringTimeoutMs` is the real bound: it keeps a hung
      // device call from recording until the cap (M3 produced a 4.7GB trace
      // that way, §4.10). A healthy Take needs ~14s here.
      timeLimit: "40s",
      duringTimeoutMs: 30_000,
      liveTimeoutMs: 30_000,
      during: async () => {
        sessionStart = Date.now();
        // xctrace just cold-started the app, so its initial screen is back.
        launchUrlApplied = false;
        const activity = await waitForForeground();
        input.lifecycle.push({
          kind: "foreground",
          occurredAt: input.nowIso(),
          notes: `activity ${activity}`,
        });
        await sleep(deps.settleMs ?? DEFAULTS.settleMs);
        await applyLaunchUrl();
        // A fresh launch always starts on the initial screen, so warmup must
        // run for this attempt.
        await runWarmup(true);
        await enforcePreconditions();
        actionStart = Date.now();
        await runActions();
        actionEnd = Date.now();
        // A gesture that lands in a system edge area backgrounds the app; the
        // rest of the actions then play against SpringBoard/Spotlight. The
        // trace would still contain frames, so without this check a Take could
        // "complete" while never touching the scenario screen.
        const afterActions = await probeForeground();
        if (afterActions === null) {
          throw new Error(
            `could not verify that ${plan.app.bundleId} stayed in the foreground: ` +
              `the device did not answer within ${probeTimeoutMs}ms. ` +
              "Refusing to score a Take whose foreground state is unknown; the recording was stopped early.",
          );
        }
        if (afterActions.bundleId !== plan.app.bundleId) {
          throw new Error(
            `the device left ${plan.app.bundleId} while the actions ran (foreground was ${
              afterActions.bundleId
            }${
              afterActions.activity !== undefined &&
              afterActions.activity !== null
                ? ` (${afterActions.activity})`
                : ""
            }); refusing to score system UI as scenario hitches`,
          );
        }
      },
    });

    const hitchesRecord = recordTrace(pass, trace);

    const window = {
      fromMs: Math.max(0, actionStart - sessionStart),
      toMs: Math.max(0, actionEnd - sessionStart),
    };
    if (
      window.toMs - window.fromMs <
      (deps.minimumWindowMs ?? DEFAULTS.minimumWindowMs)
    ) {
      throw new Error(
        `hitches measurement window is ${window.toMs - window.fromMs}ms; the plan needs at least one action that takes measurable time`,
      );
    }
    log(
      `hitches window ${Math.round(window.fromMs)}–${Math.round(window.toMs)}ms of the trace`,
    );
    // Persist the scored part of the trace: without it a reader cannot tell
    // whether a low count came from a healthy scene or from a window that
    // missed the interaction.
    notes.push(
      `hitches window ${Math.round(window.fromMs)}–${Math.round(window.toMs)}ms of the trace`,
    );
    await analyzeTrace(pass, trace, { window }, hitchesRecord);
  } else if (plan.actions.length > 0) {
    if (launchPass !== undefined) {
      if (plan.preconditions.length > 0 && memoryPass === undefined) {
        // The scenario window is skipped here, so there is nothing to check
        // the declared starting state against. A memory pass would still
        // verify them before its measurement, so only reject when no pass
        // runs the checks at all.
        throw new PreconditionFailure(
          "preconditions were declared but this plan has no scenario window to verify them: the App Launch pass measures a cold start and skips the scenario actions",
        );
      }
      notes.push(
        "scenario actions skipped: the plan has no frame-recording pass to replay them in",
      );
    } else {
      await bringToForeground();
      await applyLaunchUrl();
      await runWarmup();
      await enforcePreconditions();
      await runActions();
    }
  }

  // ── Pass 2: App Launch (launchMs) ───────────────────────────────────
  if (launchPass !== undefined) {
    // Let the previous recording session finish releasing the device-side
    // tap. Starting a new one too early fails with `Failed starting ktrace
    // session`, which on this toolchain does not recover without a reboot.
    await sleep(deps.passCooldownMs ?? DEFAULTS.passCooldownMs);
    await deps.device.terminate(deviceId, plan.app.bundleId).catch(() => undefined);
    await sleep(deps.launchSettleMs ?? DEFAULTS.launchSettleMs);
    log("launch pass");
    if (plan.app.launchUrl !== undefined) {
      noteOnce(
        "launchMs pass does not apply launchUrl: it measures the app's own cold start",
      );
    }
    const trace = await deps.recorder.record({
      template: "launch",
      device: deviceId,
      target: { kind: "launch", bundleId: plan.app.bundleId },
      ...(launchOptions !== undefined ? { launch: launchOptions } : {}),
      outputPath: resolve(roundTracesDir, "launch.trace"),
    });
    const launchRecord = recordTrace(launchPass, trace);
    // App Launch rows are keyed by the process display name (`NN`), not the
    // executable (`NNIM`) and not the bundle id.
    await analyzeTrace(
      launchPass,
      trace,
      {
        ...(installation.name.length > 0 ? { processName: installation.name } : {}),
      },
      launchRecord,
    );
    // The pass cold-started the app and left it on its initial screen, so a
    // later pass must navigate again.
    launchUrlApplied = false;
    const activity = await sampleForeground();
    if (activity !== null) {
      input.lifecycle.push({
        kind: "foreground",
        occurredAt: input.nowIso(),
        notes: `post-launch activity ${activity}`,
      });
    } else {
      notes.push(
        "post-launch foreground probe found no app in front (xctrace ends App Launch by backgrounding it)",
      );
    }
  }

  // ── Pass 3: Activity Monitor (memoryMB) ─────────────────────────────
  if (memoryPass !== undefined) {
    await sleep(deps.passCooldownMs ?? DEFAULTS.passCooldownMs);
    // The launch pass already left the app running; otherwise bring it up.
    // Use the bounded probe: a wedged WDA between passes must not hold the
    // Take open indefinitely (the preflight only proves it was healthy then).
    const foreground = await probeForeground();
    if (foreground === null || foreground.bundleId !== plan.app.bundleId) {
      await bringToForeground();
    }
    await applyLaunchUrl();
    await runWarmup();
    await enforcePreconditions();
    await sleep(deps.memorySettleMs ?? DEFAULTS.memorySettleMs);
    const pid = await deps.device.resolvePid(deviceId, installation.containerUuid);
    if (pid === null) {
      throw new Error("could not resolve the app pid before the memory pass");
    }
    log(`memory pass (pid ${pid})`);
    const trace = await deps.recorder.record({
      template: "memory",
      device: deviceId,
      target: { kind: "allProcesses" },
      outputPath: resolve(roundTracesDir, "memory.trace"),
    });
    const memoryRecord = recordTrace(memoryPass, trace);
    await analyzeTrace(memoryPass, trace, { pid }, memoryRecord);
  }
}
