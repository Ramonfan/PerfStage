import {
  DeviceError,
  type AppInstallation,
  type CrashEntry,
  type DeviceDriver,
  type DeviceInfo,
  type DeviceRecoveryEvent,
  type ForegroundApp,
  type LogStream,
  type UiElement,
} from "./types.js";

/**
 * Scriptable in-memory device.
 *
 * The Runner needs to be testable without a plugged-in iPhone and without
 * spawning `mobilecli`/`devicectl`. This fake models just enough behaviour to
 * exercise the real orchestration: app lifecycle, pid identity per
 * installation, UI lookup by label, crash lists and log capture.
 */
export interface FakeDriverOptions {
  device?: Partial<DeviceInfo>;
  app?: Partial<AppInstallation>;
  elements?: UiElement[];
  /** Log lines served to any log stream. */
  logLines?: string[];
  /** Crash ids visible at start. */
  crashIds?: string[];
  /** Crash entries visible at start, including their process. */
  crashEntries?: CrashEntry[];
  /** Process used by `crashOnLaunch`; defaults to the app's process name. */
  crashOnLaunchProcess?: string;
  /** Fail the preflight agent probe as a wedged WDA would. */
  agentUnavailable?: boolean;
  /** Report the device log stream as having exited before the Take ended. */
  logExitsEarly?: boolean;
  /** Make `LogStream.stop()` throw, as a killed log process would. */
  logStopFails?: boolean;
  /** Recovery events the driver should hand to the Runner on drain. */
  recoveryEvents?: DeviceRecoveryEvent[];
  /** Throw on the Nth call of a given operation (1-based). */
  failOn?: Partial<Record<FakeOperation, number>>;
  /** Simulated delay applied to every operation. */
  latencyMs?: number;
  /**
   * Launch the app but keep SpringBoard in the foreground.
   *
   * This is what a real device does when another app's system alert (local
   * network, notifications) is on screen: the app is running, but it never
   * becomes frontmost and its activity is reported as SpringBoard's.
   */
  blockForeground?: boolean;
  /**
   * Background the app when a swipe is synthesized.
   *
   * Models a gesture that lands in a system edge area: iOS leaves the app, so
   * the following action hits SpringBoard/Spotlight instead of the scenario.
   */
  backgroundOnSwipe?: boolean;
  /**
   * Exit immediately after `launch()`, as an app that crashes during startup
   * does. The health check must notice instead of recording an empty Take.
   */
  exitOnLaunch?: boolean;
  /** Register a fresh crash report on every `launch()`. */
  crashOnLaunch?: boolean;
  /**
   * Stop answering `foreground()` once a swipe has run.
   *
   * Models the device-side Instruments service starving during a recording:
   * the query never returns, so `during` would keep the session open until the
   * recording's time limit (docs/m3-validation.md §4.10).
   */
  hangForegroundAfterSwipe?: boolean;
}

/** Bundle id reported while a system alert owns the foreground. */
export const FAKE_BLOCKING_APP = {
  bundleId: "com.apple.springboard",
  activity: "UIEditingOverlayViewController",
};

export type FakeOperation =
  | "requireDevice"
  | "resolveInstallation"
  | "resolvePid"
  | "launch"
  | "openUrl"
  | "terminate"
  | "foreground"
  | "dumpElements"
  | "tap"
  | "swipe"
  | "crashIds"
  | "crashReports"
  | "probeAgent";

export interface FakeDriver extends DeviceDriver {
  /** Calls observed so far, in order, for assertions. */
  readonly calls: string[];
  /** Swipes observed so far, with the coordinates the Runner sent. */
  readonly swipes: Array<{
    from: { x: number; y: number };
    to: { x: number; y: number };
    durationMs: number;
  }>;
  /** URLs opened through the device, in order. */
  readonly openedUrls: string[];
  /** Currently "foreground" bundle id. */
  readonly foregroundBundleId: string;
  /** Set the visible UI tree. */
  setElements(elements: UiElement[]): void;
  /** Replace the crash id list (simulates a crash mid-Take). */
  setCrashIds(ids: string[]): void;
  /** Replace the crash entries, including process names. */
  setCrashEntries(entries: CrashEntry[]): void;
  /** Append lines that future log streams will emit. */
  pushLogLines(lines: string[]): void;
  /** Simulate the app being killed by the system. */
  killApp(): void;
  /**
   * Simulate the app being launched by something other than the Runner.
   *
   * The hitches pass records with `xctrace --launch`, so the Runner never
   * calls `device.launch` for it: xctrace starts the app. From the device's
   * point of view that is still a launch (new pid, app in front), so tests
   * must model it without pretending the Runner issued the launch itself.
   */
  simulateExternalLaunch(): void;
  /** True once the fake app is running. */
  readonly appRunning: boolean;
}

const DEFAULT_DEVICE: DeviceInfo = {
  id: "00000000-0000000000000000",
  name: "Fake iPhone",
  platform: "ios",
  type: "real",
  version: "27.0",
  model: "iPhone18,3",
  state: "online",
  screenSize: { width: 393, height: 852, scale: 3 },
};

const DEFAULT_APP: AppInstallation = {
  bundleId: "com.example.app",
  name: "Example",
  processName: "Example",
  version: "1.0.0",
  containerUuid: "11111111-2222-3333-4444-555555555555",
};

export function createFakeDriver(options: FakeDriverOptions = {}): FakeDriver {
  const device: DeviceInfo = { ...DEFAULT_DEVICE, ...options.device };
  const app: AppInstallation = { ...DEFAULT_APP, ...options.app };
  const counts = new Map<FakeOperation, number>();
  const calls: string[] = [];
  const swipes: FakeDriver["swipes"] = [];
  const openedUrls: string[] = [];

  let elements = options.elements ?? [];
  let crashEntries: CrashEntry[] =
    options.crashEntries !== undefined
      ? [...options.crashEntries]
      : [...(options.crashIds ?? [])].map((id) => ({ id }));
  let recoveryEvents: DeviceRecoveryEvent[] = [...(options.recoveryEvents ?? [])];
  let logLines = [...(options.logLines ?? [])];
  let running = false;
  let foregroundBundleId = "com.apple.springboard";
  let pid: number | null = null;
  let nextPid = 4242;

  const record = (operation: FakeOperation): void => {
    calls.push(operation);
    const seen = (counts.get(operation) ?? 0) + 1;
    counts.set(operation, seen);
    const failAt = options.failOn?.[operation];
    if (failAt !== undefined && seen === failAt) {
      throw new DeviceError(
        `fake ${operation} failure at call ${seen}`,
        "command-failed",
      );
    }
  };

  const delay = async (): Promise<void> => {
    if (options.latencyMs !== undefined && options.latencyMs > 0) {
      await new Promise((done) => setTimeout(done, options.latencyMs));
    }
  };

  return {
    get calls() {
      return calls;
    },
    get swipes() {
      return swipes;
    },
    get openedUrls() {
      return openedUrls;
    },
    get foregroundBundleId() {
      return foregroundBundleId;
    },
    get appRunning() {
      return running;
    },

    setElements(next) {
      elements = next;
    },
    setCrashIds(ids) {
      crashEntries = [...ids].map((id) => ({ id }));
    },
    setCrashEntries(entries) {
      crashEntries = [...entries];
    },
    pushLogLines(lines) {
      logLines = [...logLines, ...lines];
    },
    killApp() {
      running = false;
      pid = null;
      foregroundBundleId = "com.apple.springboard";
    },
    simulateExternalLaunch() {
      // Deliberately not recorded in `calls`: the Runner did not ask for this
      // launch, xctrace did. Recording it would make `calls` lie about what
      // PerfStage requested.
      if (!running) {
        running = true;
        pid = nextPid;
        nextPid += 1;
      }
      if (options.blockForeground !== true) {
        foregroundBundleId = app.bundleId;
      }
    },

    async requireDevice(deviceId) {
      record("requireDevice");
      await delay();
      if (deviceId !== device.id) {
        throw new DeviceError(
          `device ${deviceId} is not visible`,
          "device-unavailable",
        );
      }
      return device;
    },

    async resolveInstallation(_deviceId, bundleId) {
      record("resolveInstallation");
      await delay();
      if (bundleId !== app.bundleId) {
        throw new DeviceError(`${bundleId} is not installed`, "app-not-installed");
      }
      return app;
    },

    async resolvePid(_deviceId, _containerUuid) {
      record("resolvePid");
      await delay();
      return pid;
    },

    async launch(_deviceId, bundleId) {
      record("launch");
      await delay();
      if (bundleId !== app.bundleId) {
        throw new DeviceError(`${bundleId} is not installed`, "app-not-installed");
      }
      if (!running) {
        running = true;
        pid = nextPid;
        nextPid += 1;
      }
      if (options.blockForeground !== true) {
        foregroundBundleId = bundleId;
      }
      if (options.crashOnLaunch === true) {
        crashEntries = [
          ...crashEntries,
          {
            id: `FakeCrash-${crashEntries.length + 1}.ips`,
            process: options.crashOnLaunchProcess ?? app.processName,
          },
        ].sort((left, right) => left.id.localeCompare(right.id));
      }
      if (options.exitOnLaunch === true) {
        running = false;
        pid = null;
        foregroundBundleId = "com.apple.springboard";
      }
    },

    async openUrl(_deviceId, url) {
      record("openUrl");
      await delay();
      openedUrls.push(url);
      // A deep link brings the owning app to the front. Tests that model a
      // rejected link flip `blockForeground` or fail the call.
      if (url.length === 0) {
        throw new DeviceError("empty url", "command-failed");
      }
      if (!running) {
        running = true;
        pid = nextPid;
        nextPid += 1;
      }
      if (options.blockForeground !== true) {
        foregroundBundleId = app.bundleId;
      }
    },

    async terminate(_deviceId, bundleId) {
      record("terminate");
      await delay();
      if (bundleId === foregroundBundleId || bundleId === app.bundleId) {
        running = false;
        pid = null;
        foregroundBundleId = "com.apple.springboard";
      }
    },

    async foreground(_deviceId) {
      record("foreground");
      if (options.hangForegroundAfterSwipe === true && swipes.length > 0) {
        // Never resolves: the caller must bound this itself.
        return new Promise<ForegroundApp>(() => undefined);
      }
      await delay();
      const entry: ForegroundApp = {
        bundleId: foregroundBundleId,
        appName: foregroundBundleId === app.bundleId ? app.name : undefined,
        version: foregroundBundleId === app.bundleId ? app.version : undefined,
        activity:
          foregroundBundleId === app.bundleId
            ? "FakeScene"
            : foregroundBundleId === FAKE_BLOCKING_APP.bundleId
              ? FAKE_BLOCKING_APP.activity
              : undefined,
      };
      return entry;
    },

    async dumpElements(_deviceId) {
      record("dumpElements");
      await delay();
      return elements;
    },

    async tap(_deviceId, x, y) {
      record("tap");
      await delay();
      const hit = elements.find((element) => {
        const rect = element.rect;
        if (rect === undefined) return false;
        return (
          x >= rect.x &&
          x <= rect.x + rect.width &&
          y >= rect.y &&
          y <= rect.y + rect.height
        );
      });
      if (hit === undefined) {
        throw new DeviceError(`no element at ${x},${y}`, "element-not-found");
      }
    },

    async swipe(_deviceId, from, to, durationMs) {
      record("swipe");
      swipes.push({
        from: { x: from.x, y: from.y },
        to: { x: to.x, y: to.y },
        durationMs,
      });
      await delay();
      if (options.backgroundOnSwipe === true) {
        foregroundBundleId = "com.apple.springboard";
      }
    },

    async crashIds(_deviceId) {
      record("crashIds");
      await delay();
      return crashEntries
        .map((entry) => entry.id)
        .sort((left, right) => left.localeCompare(right));
    },

    async crashReports(_deviceId) {
      record("crashReports");
      await delay();
      return [...crashEntries]
        .map((entry) => ({ ...entry }))
        .sort((left, right) => left.id.localeCompare(right.id));
    },

    async probeAgent(_deviceId) {
      record("probeAgent");
      await delay();
      if (options.agentUnavailable === true) {
        throw new DeviceError(
          "apps foreground preflight timed out; the automation agent is not responding",
          "timeout",
        );
      }
    },

    drainRecoveryEvents() {
      return recoveryEvents.splice(0, recoveryEvents.length);
    },

    startLogStream(_deviceId: string, _processName: string): LogStream {
      calls.push("startLogStream");
      const captured = logLines.join("\n");
      const exitedEarly = options.logExitsEarly === true;
      return {
        async stop() {
          calls.push("stopLogStream");
          if (options.logStopFails === true) {
            throw new Error("fake log stream stop failed");
          }
          return {
            text: captured,
            stderr: "",
            exitedEarly,
            lineCount:
              captured.length === 0 ? 0 : captured.split(/\r?\n/).length,
            ...(exitedEarly
              ? { exitReason: "log stream ended before the Take finished" }
              : {}),
          };
        },
      };
    },
  };
}
