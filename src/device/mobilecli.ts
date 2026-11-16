import { spawn } from "node:child_process";
import { existsSync, promises as fs, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  DeviceError,
  type AppInstallation,
  type DeviceDriver,
  type DeviceInfo,
  type ForegroundApp,
  type LogStream,
  type UiElement,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEVICECTL_TIMEOUT_MS = 120_000;

export interface MobilecliDriverOptions {
  /** Explicit path to the mobilecli binary; otherwise discovered. */
  binary?: string;
  /** Override `xcrun` for tests. */
  xcrun?: string;
  /** Directory for devicectl JSON scratch files. */
  scratchDir?: string;
  /** Command timeout. */
  timeoutMs?: number;
  log?: (message: string) => void;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Locate the mobilecli binary.
 *
 * `mobilecli` ships as a platform-specific optional dependency of the npm
 * package, so `npx` unpacks it under `~/.npm/_npx/<hash>/`. Scanning that
 * cache is ugly but reliable; `PERFSTAGE_MOBILECLI` and `PATH` win when set.
 */
export function findMobilecliBinary(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.PERFSTAGE_MOBILECLI;
  if (explicit && existsSync(explicit)) {
    return explicit;
  }

  const onPath = env.PATH?.split(":").find((entry) => {
    const candidate = join(entry, "mobilecli");
    return existsSync(candidate);
  });
  if (onPath) {
    return join(onPath, "mobilecli");
  }

  const roots = [
    env.HOME ? join(env.HOME, ".npm", "_npx") : undefined,
    env.HOME ? join(env.HOME, ".npm", "_npx", "node_modules") : undefined,
  ].filter((entry): entry is string => entry !== undefined);

  const relative = join(
    "node_modules",
    "@mobilenext",
    "mobilecli-darwin-arm64",
    "mobilecli-darwin-arm64",
  );

  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of safeReaddir(root)) {
      const candidate = join(root, entry, relative);
      if (existsSync(candidate)) {
        return candidate;
      }
      const nested = join(root, entry);
      if (existsSync(nested) && entry.startsWith("@mobilenext")) {
        const direct = join(root, entry, "mobilecli-darwin-arm64");
        if (existsSync(direct)) {
          return direct;
        }
      }
    }
  }

  throw new DeviceError(
    "mobilecli was not found. Install it (npx @mobilenext/mobilecli) or set PERFSTAGE_MOBILECLI.",
    "command-failed",
  );
}

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/**
 * Explain why a log stream is not trustworthy.
 *
 * Returning `undefined` for a stream we stopped ourselves is important: a
 * normal shutdown also emits `close`, and treating that as failure would mark
 * every healthy Take `partial`.
 */
export function logStreamExitError(
  exit: { code: number | null; signal: NodeJS.Signals | null } | null,
): string | undefined {
  if (exit === null) {
    return undefined;
  }
  const cause =
    exit.signal !== null
      ? `signal ${exit.signal}`
      : `exit ${exit.code === null ? "unknown" : exit.code}`;
  return `log stream ended before the Take finished (${cause}); captured log may be incomplete`;
}

function run(
  command: string,
  args: string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
      // Own process group so a stuck CLI and anything it forks can be killed
      // together. Without it a hung `apps foreground` survived its 60s timeout
      // for nine minutes during M3 (docs/m3-validation.md §4.10).
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let settled = false;
    let timedOut = false;

    const killGroup = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      releasePipes();
      resolve(result);
    };

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      releasePipes();
      reject(error);
    };

    /**
     * Drop our end of the pipes.
     *
     * If a grandchild inherited stdout/stderr it can hold them open after the
     * command exits; leaving our read end attached would keep the Node process
     * alive and, worse, hide the fact that the command is already done.
     */
    const releasePipes = (): void => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
      // Never wait for `close` here. A grandchild can inherit the stdout pipe
      // and keep it open forever, which is exactly how a 60s timeout turned
      // into a nine-minute stall: the child died, `close` never fired, and the
      // recording then ran to its 60s cap.
      fail(
        new DeviceError(
          `${command} did not finish within ${timeoutMs}ms; killed it (${args.slice(0, 3).join(" ")})`,
          "command-failed",
          stderr,
        ),
      );
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", fail);
    // `exit` fires even while a grandchild still holds the pipes; `close` waits
    // for every holder to let go. Prefer the former so a leaked descriptor
    // cannot hang the Take, but give the pipe a moment to drain first.
    child.on("exit", (code) => {
      const drain = setTimeout(() => {
        if (timedOut) return;
        finish({ code, stdout, stderr });
      }, 50);
      drain.unref();
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr });
    });
  });
}

/**
 * Parse mobilecli's `{"status":"ok","data":...}` envelope.
 *
 * A non-zero exit code is not always fatal: some subcommands report errors in
 * JSON with exit 0. Both signals are checked so a failure never looks like an
 * empty success.
 */
export function parseMobilecliJson<T>(
  output: string,
  context: string,
): T {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    throw new DeviceError(`${context} returned no output`, "command-failed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Some commands print a warning line before the JSON body.
    const firstBrace = trimmed.indexOf("{");
    if (firstBrace === -1) {
      throw new DeviceError(
        `${context} returned non-JSON output: ${trimmed.slice(0, 200)}`,
        "command-failed",
      );
    }
    try {
      parsed = JSON.parse(trimmed.slice(firstBrace));
    } catch {
      throw new DeviceError(
        `${context} returned malformed JSON: ${trimmed.slice(0, 200)}`,
        "command-failed",
      );
    }
  }

  if (parsed === null || typeof parsed !== "object") {
    throw new DeviceError(`${context} returned an unexpected payload`, "command-failed");
  }
  const envelope = parsed as { status?: string; data?: unknown; error?: unknown };
  if (envelope.status !== undefined && envelope.status !== "ok") {
    throw new DeviceError(
      `${context} failed: ${JSON.stringify(envelope.error ?? envelope.status)}`,
      "command-failed",
    );
  }
  return (envelope.data ?? envelope) as T;
}

/**
 * Extract the container UUID and executable name from a devicectl install URL.
 *
 *     file:///private/var/containers/Bundle/Application/<UUID>/NNIM.app/NNIM
 *
 * The executable (`NNIM`) is the OS process name; the app's display name
 * (`NN`) is a different string and cannot be used as a log filter.
 */
export function parseInstallUrl(
  url: string,
): { containerUuid: string; processName: string } | null {
  const match = /Application\/([0-9A-F-]+)\//i.exec(url);
  if (match === null) return null;
  const appMatch = /\/([^/]+)\.app(?:\/([^/?#]+))?/.exec(url);
  if (appMatch === null) return null;
  return {
    containerUuid: match[1]!,
    processName: appMatch[2] ?? appMatch[1]!,
  };
}

export function createMobilecliDriver(
  options: MobilecliDriverOptions = {},
): DeviceDriver {
  const log = options.log ?? (() => undefined);
  const xcrun = options.xcrun ?? "xcrun";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const scratchDir = options.scratchDir;
  let binary: string | null = options.binary ?? null;

  const mobilecliPath = (): string => {
    if (binary === null) {
      binary = findMobilecliBinary();
      log(`using mobilecli at ${binary}`);
    }
    return binary;
  };

  const mobilecli = async (
    args: string[],
    context: string,
  ): Promise<string> => {
    const result = await run(mobilecliPath(), args, { timeoutMs });
    if (result.code !== 0) {
      throw new DeviceError(
        `${context} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
        "command-failed",
        result.stderr,
      );
    }
    return result.stdout;
  };

  const mobilecliData = async <T>(args: string[], context: string): Promise<T> => {
    const stdout = await mobilecli(args, context);
    return parseMobilecliJson<T>(stdout, context);
  };

  return {
    async requireDevice(deviceId: string): Promise<DeviceInfo> {
      const data = await mobilecliData<{ devices: DeviceInfo[] }>(
        ["devices"],
        "mobilecli devices",
      );
      const device = data.devices.find((entry) => entry.id === deviceId);
      if (!device) {
        throw new DeviceError(
          `device ${deviceId} is not visible to mobilecli. Available: ${data.devices
            .map((entry) => `${entry.name} (${entry.id})`)
            .join(", ")}`,
          "device-unavailable",
        );
      }
      if (device.state !== "online") {
        throw new DeviceError(
          `device ${device.name} (${deviceId}) is ${device.state}, not online`,
          "device-unavailable",
        );
      }
      // `devices` lists identity and state but not the screen. Ask `device info`
      // for it: gesture math must use the real screen, never a guess inferred
      // from the app's UI tree (a scroll view can report a frame taller than the
      // display, which puts swipes below the home indicator).
      let screenSize: DeviceInfo["screenSize"];
      try {
        const info = await mobilecliData<{ device?: DeviceInfo }>(
          ["device", "info", "--device", deviceId],
          "device info",
        );
        screenSize = info.device?.screenSize;
      } catch (error) {
        // Non-gesture passes still work without it; swipes fail honestly.
        log(
          `device info failed; screen size unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return {
        ...device,
        ...(screenSize !== undefined ? { screenSize } : {}),
      };
    },

    async resolveInstallation(
      deviceId: string,
      bundleId: string,
    ): Promise<AppInstallation> {
      if (scratchDir === undefined) {
        throw new DeviceError(
          "resolveInstallation requires a scratchDir for devicectl JSON output",
          "command-failed",
        );
      }
      await fs.mkdir(scratchDir, { recursive: true });
      const target = join(scratchDir, `devicectl-apps-${process.pid}.json`);
      const result = await run(
        xcrun,
        [
          "devicectl",
          "device",
          "info",
          "apps",
          "--device",
          deviceId,
          "--json-output",
          target,
        ],
        { timeoutMs: DEVICECTL_TIMEOUT_MS },
      );
      if (result.code !== 0) {
        throw new DeviceError(
          `devicectl could not list apps on ${deviceId}: ${result.stderr.trim()}`,
          result.stderr.includes("4016") ? "device-unavailable" : "command-failed",
          result.stderr,
        );
      }
      const json = JSON.parse(await fs.readFile(target, "utf8")) as {
        result?: { apps?: Array<Record<string, unknown>> };
      };
      const app = (json.result?.apps ?? []).find(
        (entry) => entry.bundleIdentifier === bundleId,
      );
      if (!app) {
        throw new DeviceError(
          `${bundleId} is not installed on ${deviceId}`,
          "app-not-installed",
        );
      }
      const url = String(app.url ?? "");
      const identity = parseInstallUrl(url);
      if (identity === null) {
        throw new DeviceError(
          `could not parse the bundle path from ${url}`,
          "command-failed",
        );
      }
      return {
        bundleId,
        name: String(app.name ?? bundleId),
        processName: identity.processName,
        version: String(app.version ?? "unknown"),
        containerUuid: identity.containerUuid,
      };
    },

    async resolvePid(deviceId: string, containerUuid: string): Promise<number | null> {
      const result = await run(
        xcrun,
        ["devicectl", "device", "info", "processes", "--device", deviceId],
        { timeoutMs: DEVICECTL_TIMEOUT_MS },
      );
      if (result.code !== 0) {
        throw new DeviceError(
          `devicectl could not list processes on ${deviceId}: ${result.stderr.trim()}`,
          result.stderr.includes("4016") ? "device-unavailable" : "command-failed",
          result.stderr,
        );
      }
      const lines = result.stdout
        .split(/\r?\n/)
        .filter((entry) => /\.app\/[^/]+\s*$/.test(entry.trim()));
      const line = lines.find((entry) => entry.includes(containerUuid));
      if (!line) {
        return null;
      }
      // Two installs of the same app (different containers, same executable
      // name) can run side by side. That used to be fatal because the hitches
      // pass attached by pid; since D15 it records with `--launch`, and the
      // memory pass selects the exact pid from Activity Monitor rows. So a
      // collision is normal, not an error: matching the container UUID already
      // picks the process this Take measures.
      const pid = Number(line.trim().split(/\s+/)[0]);
      return Number.isFinite(pid) ? pid : null;
    },

    async launch(deviceId: string, bundleId: string): Promise<void> {
      await mobilecli(
        ["apps", "launch", "--device", deviceId, bundleId],
        `launch ${bundleId}`,
      );
    },

    async openUrl(deviceId: string, url: string): Promise<void> {
      await mobilecli(["url", "--device", deviceId, url], `url ${url}`);
    },

    async terminate(deviceId: string, bundleId: string): Promise<void> {
      const result = await run(
        mobilecliPath(),
        ["apps", "terminate", "--device", deviceId, bundleId],
        { timeoutMs },
      );
      // Terminating an app that is not running is not an error for us.
      if (result.code !== 0 && !/not running|no such process/i.test(result.stderr)) {
        log(`terminate ${bundleId} exited ${result.code}: ${result.stderr.trim()}`);
      }
    },

    async foreground(deviceId: string): Promise<ForegroundApp> {
      const data = await mobilecliData<{
        packageName?: string;
        appName?: string;
        version?: string;
        activity?: string;
      }>(["apps", "foreground", "--device", deviceId], "apps foreground");
      return {
        bundleId: data.packageName ?? "unknown",
        appName: data.appName,
        version: data.version,
        activity: data.activity,
      };
    },

    async dumpElements(deviceId: string): Promise<UiElement[]> {
      const data = await mobilecliData<{ elements?: UiElement[] }>(
        ["dump", "ui", "--device", deviceId],
        "dump ui",
      );
      return data.elements ?? [];
    },

    async tap(deviceId: string, x: number, y: number): Promise<void> {
      await mobilecli(
        ["io", "tap", `${Math.round(x)},${Math.round(y)}`, "--device", deviceId],
        "io tap",
      );
    },

    async swipe(deviceId, from, to, durationMs): Promise<void> {
      const coords = `${Math.round(from.x)},${Math.round(from.y)},${Math.round(to.x)},${Math.round(to.y)}`;
      await mobilecli(
        [
          "io",
          "swipe",
          coords,
          "--duration",
          String(Math.max(1, Math.round(durationMs))),
          "--device",
          deviceId,
        ],
        "io swipe",
      );
    },

    async crashIds(deviceId: string): Promise<string[]> {
      const data = await mobilecliData<Array<{ id?: string }>>(
        ["device", "crashes", "list", "--device", deviceId],
        "device crashes list",
      );
      return data
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
        .sort();
    },

    startLogStream(deviceId: string, processName: string): LogStream {
      const child = spawn(
        mobilecliPath(),
        [
          "device",
          "logs",
          "--device",
          deviceId,
          "--filter",
          `process=${processName}`,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let text = "";
      let stderr = "";
      let stopping = false;
      /**
       * `mobilecli device logs` streams until killed. If it exits on its own,
       * whatever we captured is a fragment — and a fragment that still looks
       * "available" would let a partial Take pass as complete. Remember the
       * exit so `stop()` can turn it into an explicit evidence error.
       */
      let earlyExit: { code: number | null; signal: NodeJS.Signals | null } | null =
        null;
      child.stdout.on("data", (chunk) => {
        text += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        stderr += `\n${String(error)}`;
      });
      child.on("close", (code, signal) => {
        if (!stopping) {
          earlyExit = { code, signal };
        }
      });

      return {
        async stop() {
          stopping = true;
          if (child.exitCode === null && earlyExit === null) {
            child.kill("SIGTERM");
            await Promise.race([
              new Promise<void>((done) => child.once("close", () => done())),
              new Promise<void>((done) => setTimeout(done, 3_000)),
            ]);
            if (child.exitCode === null) {
              child.kill("SIGKILL");
            }
          }
          const exitError = logStreamExitError(earlyExit);
          return {
            text,
            stderr: [stderr.trim(), exitError].filter(Boolean).join("\n"),
          };
        },
      };
    },
  };
}

/**
 * A driver that refuses every operation with a clear message.
 *
 * Used when the user runs against a device PerfStage cannot drive, so the Take
 * fails honestly instead of throwing an opaque spawn error.
 */
export function createUnavailableDriver(reason: string): DeviceDriver {
  const fail = (): never => {
    throw new DeviceError(reason, "device-unavailable");
  };
  return {
    requireDevice: async () => fail(),
    resolveInstallation: async () => fail(),
    resolvePid: async () => fail(),
    launch: async () => fail(),
    openUrl: async () => fail(),
    terminate: async () => fail(),
    foreground: async () => fail(),
    dumpElements: async () => fail(),
    tap: async () => fail(),
    swipe: async () => fail(),
    crashIds: async () => fail(),
    startLogStream: () => ({
      stop: async () => ({ text: "", stderr: reason }),
    }),
  };
}
