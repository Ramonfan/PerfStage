import { promises as fs } from "node:fs";
import { posix, relative, resolve, sep } from "node:path";
import { extractDeviceFailureCause } from "../diagnostics/cause.js";
import type { DiagnosticInput } from "../diagnostics/normalize.js";
import type { DeviceDriver, ForegroundApp } from "../device/types.js";
import type { TestPlan } from "../model/test-plan.js";
import type { ActionRecord, MetricResult } from "../model/test-run.js";
import type {
  RecordedTrace,
  RecordingIssue,
  RecordingTemplate,
  TraceRecorder,
} from "../recording/types.js";
import { analyzePerformanceTrace } from "../tools/analyze.js";
import { executeAction } from "./actions.js";
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
  /** Metrics this pass produced (canonical names). */
  metrics: string[];
}

export interface TakeExecution {
  actions: ActionRecord[];
  metrics: MetricResult[];
  diagnostics: DiagnosticInput;
  passes: PassRecord[];
  notes: string[];
  /** Set when a fatal device/recording error ended the Take early. */
  fatalError?: string;
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
  return { metrics: result.metrics, warnings: result.warnings };
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
  await fs.mkdir(tracesDir, { recursive: true });

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
  let logStream: ReturnType<DeviceDriver["startLogStream"]> | null = null;
  let fullLogText: string | undefined;

  try {
    // ── Preflight ────────────────────────────────────────────────────
    const device = await deps.device.requireDevice(deviceId);
    log(`device ${device.name} (${device.id}) ${device.version}`);
    const installation = await deps.device.resolveInstallation(
      deviceId,
      plan.app.bundleId,
    );
    log(
      `app ${installation.name} ${installation.version} container=${installation.containerUuid}`,
    );
    diagnostics.crashIdsBefore = await deps.device.crashIds(deviceId);
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
      const before = await deps.device
        .resolvePid(deviceId, installation.containerUuid)
        .catch(() => null);
      if (before === null) {
        await deps.device.launch(deviceId, plan.app.bundleId);
      }
      await sleep(settle);
      const after = await deps.device
        .resolvePid(deviceId, installation.containerUuid)
        .catch(() => null);
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
      const crashes = await deps.device.crashIds(deviceId).catch(() => []);
      const known = new Set(diagnostics.crashIdsBefore ?? []);
      const fresh = crashes.filter((id) => !known.has(id));
      if (fresh.length > 0) {
        lifecycle.push({
          kind: "app_exit",
          occurredAt: nowIso(),
          notes: `new crash reports: ${fresh.join(", ")}`,
        });
        throw new Error(
          `${plan.app.bundleId} crashed during the health check (${fresh.join(", ")}); ` +
            "refusing to record until the app starts cleanly",
        );
      }
      log(`health check ok (pid ${after} alive after ${settle}ms)`);
    };

    await checkAppHealth();

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
    log(`take failed: ${fatalError}`);
    notes.push(`fatal: ${fatalError}`);
  } finally {
    // Evidence is collected even when the Take fails: a failed report with logs
    // and crashes is how the operator learns why it failed.
    try {
      diagnostics.crashIdsAfter = await deps.device.crashIds(deviceId);
    } catch (error) {
      notes.push(
        `crash list after failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (logStream !== null) {
      const captured = await logStream.stop().catch(() => ({ text: "", stderr: "" }));
      // Keep the whole stream for the category scan. `report.json` drops the
      // text itself once `device.log` exists (see `buildJsonReport`), so the
      // report stays small while diagnostics still see every line — capping
      // the text here would silently hide errors from the first half of a
      // long log.
      diagnostics.logText = captured.text;
      diagnostics.logQueryError = captured.stderr.trim() || undefined;
      fullLogText = captured.text;
      // The device log is the only place that says *why* the app died. On a
      // failed Take, put the first actionable line in the report instead of
      // making the reader search `device.log`.
      const cause = extractDeviceFailureCause(captured.text);
      if (cause !== null && fatalError !== undefined) {
        notes.push(`device log: ${cause}`);
        fatalError = `${fatalError}; device log: ${cause}`;
      }
      const known = new Set(diagnostics.crashIdsBefore ?? []);
      const fresh = (diagnostics.crashIdsAfter ?? []).filter(
        (id) => !known.has(id),
      );
      if (fresh.length > 0) {
        notes.push(`new crash reports during the take: ${fresh.join(", ")}`);
      }
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
    ...(fatalError !== undefined ? { fatalError } : {}),
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
  const sleep = deps.sleep;
  const log = deps.log;
  const { actions, metrics, notes } = input.sink;
  const recorded = input.sink.passes;

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

  const analyzeTrace = async (
    pass: PassPlan,
    trace: RecordedTrace,
    extra: {
      processName?: string;
      pid?: number;
      window?: { fromMs: number; toMs: number };
    },
  ): Promise<void> => {
    const relativePath = toRunRelative(deps.runDir, trace.tracePath);
    const analyzed = await deps.analyze({
      template: pass.template,
      tracePath: trace.tracePath,
      ...extra,
    });
    if ("error" in analyzed) {
      throw new Error(
        `analyze_performance_trace failed for ${pass.template}: ${analyzed.error}`,
      );
    }
    for (const metric of analyzed.metrics) {
      metrics.push({ ...metric, tracePath: relativePath });
    }
    // Analyzer warnings matter to trust: "no frames in the window" or a
    // skipped row means the number may under-count. They must reach the
    // report instead of living only in the trace-analysis response.
    if (analyzed.warnings !== undefined && analyzed.warnings.length > 0) {
      notes.push(
        `${pass.template} analysis: ${analyzed.warnings.join("; ")}`,
      );
    }
    recorded.push({
      template: pass.template,
      passIndex: pass.index,
      tracePath: relativePath,
      absoluteTracePath: trace.tracePath,
      attempts: trace.attempts,
      issues: trace.issues,
      durationMs: trace.durationMs,
      metrics: pass.metrics,
    });
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
      outputPath: resolve(tracesDir, "hitches.trace"),
      // `during` stops the session right after the last action; this is only a
      // safety cap. `duringTimeoutMs` is the real bound: it keeps a hung
      // device call from recording until the cap (M3 produced a 4.7GB trace
      // that way, §4.10). A healthy Take needs ~14s here.
      timeLimit: "40s",
      duringTimeoutMs: 30_000,
      liveTimeoutMs: 30_000,
      during: async () => {
        sessionStart = Date.now();
        const activity = await waitForForeground();
        input.lifecycle.push({
          kind: "foreground",
          occurredAt: input.nowIso(),
          notes: `activity ${activity}`,
        });
        await sleep(deps.settleMs ?? DEFAULTS.settleMs);
        // A fresh launch always starts on the initial screen, so warmup must
        // run for this attempt.
        await runWarmup(true);
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
    await analyzeTrace(pass, trace, { window });
  } else if (plan.actions.length > 0) {
    if (launchPass !== undefined) {
      notes.push(
        "scenario actions skipped: the plan has no frame-recording pass to replay them in",
      );
    } else {
      await bringToForeground();
      await runWarmup();
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
    const trace = await deps.recorder.record({
      template: "launch",
      device: deviceId,
      target: { kind: "launch", bundleId: plan.app.bundleId },
      outputPath: resolve(tracesDir, "launch.trace"),
    });
    // App Launch rows are keyed by the process display name (`NN`), not the
    // executable (`NNIM`) and not the bundle id.
    await analyzeTrace(launchPass, trace, {
      ...(installation.name.length > 0 ? { processName: installation.name } : {}),
    });
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
    const foreground = await deps.device.foreground(deviceId).catch(() => null);
    if (foreground === null || foreground.bundleId !== plan.app.bundleId) {
      await bringToForeground();
    }
    await runWarmup();
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
      outputPath: resolve(tracesDir, "memory.trace"),
    });
    await analyzeTrace(memoryPass, trace, { pid });
  }
}
