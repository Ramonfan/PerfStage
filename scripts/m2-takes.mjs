#!/usr/bin/env node
/**
 * M2 real-device repeatability driver.
 *
 * Runs the same Scene N times against a physical iPhone and records each Take
 * with the *real* PerfStage pipeline:
 *
 *   prepare_performance_test → record traces → analyze_performance_trace
 *   → finalize_performance_test
 *
 * Why a driver instead of the MCP server: the one-shot Runner and CLI are M3
 * scope. Skill orchestration is what M2 has to prove, so this script plays the
 * Skill's role — but every plan/analysis/finalize decision is delegated to the
 * shipped PerfStage handlers (no re-implemented logic).
 *
 * Recording uses `xcrun xctrace` directly plus `mobilecli` for input, because
 * instruments-mcp-server only knows how to start/stop one template at a time
 * and this validation must sequence three passes. The parsing still belongs to
 * PerfStage (D13).
 *
 * Usage:
 *   node scripts/m2-takes.mjs \
 *     --workspace "/Users/leigod/雷神/性能分析/perfstage-m2-workspace" \
 *     --device 00008150-001E49E40128C01C \
 *     --scenario community-home-scroll \
 *     --takes 3 \
 *     --out docs/m2-takes.json
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createRunStore } from "../dist/storage/runs.js";
import { createWorkspaceManager } from "../dist/workspace/manager.js";
import { preparePerformanceTest } from "../dist/tools/plan.js";
import { finalizePerformanceTest } from "../dist/tools/report.js";
import { analyzePerformanceTrace } from "../dist/tools/analyze.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_ID = "com.nndev.im";
const APP_PROCESS_NAME = "NNIM";
const APP_DISPLAY_NAME = "NN";

const DEFAULTS = {
  workspace: join(REPO_ROOT, "..", "perfstage-m2-workspace"),
  device: process.env.PERFSTAGE_DEVICE ?? "00008150-001E49E40128C01C",
  scenario: "community-home-scroll",
  takes: 3,
  out: join(REPO_ROOT, "docs", "m2-takes.json"),
  betweenTakesMs: 25_000,
  mobilecli: "",
};

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--workspace":
        args.workspace = value;
        index += 1;
        break;
      case "--device":
        args.device = value;
        index += 1;
        break;
      case "--scenario":
        args.scenario = value;
        index += 1;
        break;
      case "--takes":
        args.takes = Number(value);
        index += 1;
        break;
      case "--out":
        args.out = value;
        index += 1;
        break;
      case "--mobilecli":
        args.mobilecli = value;
        index += 1;
        break;
      default:
        throw new Error(`Unknown flag ${flag}`);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

function log(message) {
  process.stderr.write(`[m2] ${message}\n`);
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/** Run a command to completion, capturing stdout/stderr. */
function exec(command, commandArgs, options = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer =
      options.timeoutMs === 0
        ? null
        : setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 120_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      fail(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });
}

function findMobilecli() {
  if (args.mobilecli) {
    return args.mobilecli;
  }
  const root = join(process.env.HOME ?? "", ".npm", "_npx");
  if (!existsSync(root)) {
    throw new Error("mobilecli not found; pass --mobilecli <path>.");
  }
  for (const entry of readdirSync(root)) {
    const candidate = join(
      root,
      entry,
      "node_modules",
      "@mobilenext",
      "mobilecli-darwin-arm64",
      "mobilecli-darwin-arm64",
    );
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("mobilecli not found; pass --mobilecli <path>.");
}

const MOBILECLI = findMobilecli();

async function mobilecli(commandArgs, options = {}) {
  const result = await exec(MOBILECLI, commandArgs, {
    timeoutMs: options.timeoutMs ?? 60_000,
  });
  if (result.code !== 0) {
    throw new Error(
      `mobilecli ${commandArgs.join(" ")} failed (${result.code}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

async function mobilecliJson(commandArgs, options = {}) {
  const stdout = await mobilecli(commandArgs, options);
  return JSON.parse(stdout);
}

/**
 * Resolve the app container UUID for the bundle id so we can tell the two
 * installed NN builds apart. `com.nndev.im` is the workspace build; the
 * TestFlight `com.nnhuyu.im` runs the same executable name and must never be
 * profiled by accident.
 */
async function resolveContainerUuid() {
  const tmp = join(args.workspace, "devicectl-apps.json");
  await fs.mkdir(dirname(tmp), { recursive: true });
  const result = await exec(
    "xcrun",
    ["devicectl", "device", "info", "apps", "--device", args.device, "--json-output", tmp],
    { timeoutMs: 120_000 },
  );
  if (result.code !== 0) {
    throw new Error(`devicectl apps failed: ${result.stderr.trim()}`);
  }
  const json = JSON.parse(await fs.readFile(tmp, "utf8"));
  const app = (json.result?.apps ?? []).find(
    (entry) => entry.bundleIdentifier === BUNDLE_ID,
  );
  if (!app?.url) {
    throw new Error(`${BUNDLE_ID} is not installed on ${args.device}.`);
  }
  const match = /Application\/([0-9A-F-]+)\//i.exec(app.url);
  if (!match) {
    throw new Error(`Could not parse container UUID from ${app.url}`);
  }
  return match[1];
}

async function resolveAppPid(containerUuid) {
  const result = await exec(
    "xcrun",
    ["devicectl", "device", "info", "processes", "--device", args.device],
    { timeoutMs: 60_000 },
  );
  const line = result.stdout
    .split("\n")
    .find((entry) => entry.includes(containerUuid) && entry.includes("NNIM.app/NNIM"));
  if (!line) {
    return null;
  }
  const pid = Number(line.trim().split(/\s+/)[0]);
  return Number.isInteger(pid) ? pid : null;
}

async function foregroundApp() {
  const json = await mobilecliJson([
    "apps",
    "foreground",
    "--device",
    args.device,
  ]);
  return json.data ?? {};
}

async function waitForForeground(bundleId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const app = await foregroundApp();
    if (app.packageName === bundleId) {
      return app;
    }
    await sleep(500);
  }
  throw new Error(`${bundleId} did not reach the foreground within ${timeoutMs}ms.`);
}

async function crashIds() {
  const json = await mobilecliJson([
    "device",
    "crashes",
    "list",
    "--device",
    args.device,
  ]);
  return (json.data ?? []).map((entry) => entry.id).filter(Boolean).sort();
}

/**
 * Start an app-scoped device log stream. Returns a stop() that resolves with
 * the captured text. The stream is best-effort: if mobilecli cannot start it,
 * the Take records `logQueryError` instead of pretending logs were clean.
 */
function startLogStream() {
  const child = spawn(
    MOBILECLI,
    ["device", "logs", "--device", args.device, "--filter", `process=${APP_PROCESS_NAME}`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let text = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    text += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("error", (error) => {
    stderr += `\n${String(error)}`;
  });

  return {
    async stop() {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((done) => child.once("close", done)),
        sleep(3000),
      ]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      return { text, stderr };
    },
  };
}

/**
 * Start an xctrace recording and expose the "recording is live" signal so the
 * caller can time gestures precisely. xctrace prints
 * `Ctrl-C to stop the recording` once the session is established.
 */
function startRecording({ outputPath, extraArgs, cwd }) {
  const childArgs = [
    "xctrace",
    "record",
    "--template",
    "Animation Hitches",
    ...extraArgs,
    "--device",
    args.device,
    "--output",
    outputPath,
    "--no-prompt",
  ];
  const child = spawn("xcrun", childArgs, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let liveResolve;
  let liveReject;
  const live = new Promise((done, fail) => {
    liveResolve = done;
    liveReject = fail;
  });
  let liveSettled = false;
  const exit = new Promise((done, fail) => {
    const append = (chunk) => {
      output += chunk.toString();
      if (liveSettled) {
        return;
      }
      if (/Failed to start the recording/.test(output)) {
        liveSettled = true;
        liveReject(new Error(firstIssue(output) ?? "xctrace failed to start"));
        return;
      }
      if (output.includes("Ctrl-C to stop the recording")) {
        liveSettled = true;
        liveResolve();
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const watchdog = setTimeout(() => {
      child.kill("SIGKILL");
    }, 180_000);
    child.on("error", (error) => {
      clearTimeout(watchdog);
      liveReject(error);
      fail(error);
    });
    child.on("close", (code) => {
      clearTimeout(watchdog);
      if (!liveSettled) {
        liveSettled = true;
        const tail = output.trim().split("\n").slice(-6).join(" | ");
        liveReject(
          new Error(
            `xctrace exited before the recording was live (code ${code}): ${tail || "(no output)"}`,
          ),
        );
      }
      done({ code, output });
    });
  });
  return {
    live,
    exit,
    output: () => output,
    stop: () => child.kill("SIGINT"),
  };
}

function firstIssue(output) {
  const line = output
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("* [Error]") || entry.startsWith("* [Warning]"));
  return line;
}

/**
 * Record an Animation Hitches pass. `during` runs after the session is live.
 * A kperf lock collision is a real possibility when a previous session has not
 * been released; retry after the device settles instead of failing the Take on
 * infrastructure noise.
 */
async function recordHitches({ pid, outputPath, during }) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (existsSync(outputPath)) {
      await fs.rm(outputPath, { recursive: true, force: true });
    }
    const recording = startRecording({
      outputPath,
      extraArgs: ["--attach", String(pid), "--time-limit", "20s"],
      cwd: dirname(outputPath),
    });
    try {
      let liveTimer;
      try {
        await Promise.race([
          recording.live,
          new Promise((_, reject) => {
            liveTimer = setTimeout(
              () =>
                reject(
                  new Error(
                    `hitches recording did not become live within 90s: ${recording
                      .output()
                      .trim()
                      .split("\n")
                      .slice(-4)
                      .join(" | ")}`,
                  ),
                ),
              90_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(liveTimer);
      }
      await sleep(1200);
      await during();
      await sleep(1500);
      recording.stop();
      const result = await recording.exit;
      if (/Failed to start the recording/.test(result.output)) {
        throw new Error(firstIssue(result.output) ?? "recording failed to start");
      }
      return { attempts: attempt, output: result.output };
    } catch (error) {
      recording.stop();
      await Promise.race([recording.exit.catch(() => undefined), sleep(10_000)]);
      const message = `${error instanceof Error ? error.message : String(error)}\n${recording.output()}`;
      const infrastructure =
        /_lockKPerf|did not become live|exited before the recording was live|Failed to start the recording/.test(
          message,
        );
      if (attempt === 3 || !infrastructure) {
        throw new Error(message.trim());
      }
      log(`hitches recording attempt ${attempt} failed; retrying in 30s`);
      await sleep(30_000);
    }
  }
  throw new Error("unreachable");
}

/** Record an App Launch pass. xctrace names the trace itself for this template. */
async function recordLaunch({ cwd, before }) {
  const startedAt = Date.now();
  const result = await exec(
    "xcrun",
    [
      "xctrace",
      "record",
      "--template",
      "App Launch",
      "--device",
      args.device,
      "--launch",
      "--",
      BUNDLE_ID,
      "--time-limit",
      "12s",
      "--no-prompt",
    ],
    { cwd, timeoutMs: 120_000 },
  );
  if (/Failed to start the recording/.test(result.stdout + result.stderr)) {
    throw new Error(firstIssue(result.stdout + result.stderr) ?? "launch recording failed");
  }
  const candidates = readdirSync(cwd)
    .filter((name) => name.startsWith("Launch_") && name.endsWith(".trace"))
    .map((name) => join(cwd, name))
    .filter((path) => path !== before)
    .filter((path) => {
      try {
        return statSync(path).mtimeMs >= startedAt - 5_000;
      } catch {
        return false;
      }
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (candidates.length === 0) {
    throw new Error("App Launch trace was not produced.");
  }
  return candidates[0];
}

/** Record an Activity Monitor pass over all processes. */
async function recordMemory({ outputPath }) {
  if (existsSync(outputPath)) {
    await fs.rm(outputPath, { recursive: true, force: true });
  }
  const result = await exec(
    "xcrun",
    [
      "xctrace",
      "record",
      "--template",
      "Activity Monitor",
      "--device",
      args.device,
      "--all-processes",
      "--time-limit",
      "12s",
      "--output",
      outputPath,
      "--no-prompt",
    ],
    { timeoutMs: 120_000 },
  );
  if (/Failed to start the recording/.test(result.stdout + result.stderr)) {
    throw new Error(firstIssue(result.stdout + result.stderr) ?? "memory recording failed");
  }
  if (!existsSync(outputPath)) {
    throw new Error("Activity Monitor trace was not produced.");
  }
  return result;
}

function swipeCoordinates(direction, distance) {
  const centerX = 200;
  if (direction === "up") {
    return `${centerX},${Math.min(780, 80 + distance)},${centerX},80`;
  }
  if (direction === "down") {
    return `${centerX},80,${centerX},${Math.min(780, 80 + distance)}`;
  }
  throw new Error(`Unsupported swipe direction "${direction}".`);
}

async function uiElements() {
  const json = await mobilecliJson(["dump", "ui", "--device", args.device], {
    timeoutMs: 30_000,
  });
  return json.data?.elements ?? [];
}

async function tapTarget(target, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const element = (await uiElements()).find(
      (entry) => entry.label === target || entry.name === target,
    );
    if (element?.rect) {
      const x = Math.round(element.rect.x + element.rect.width / 2);
      const y = Math.round(element.rect.y + element.rect.height / 2);
      await mobilecli(["io", "tap", `${x},${y}`, "--device", args.device]);
      return true;
    }
    await sleep(800);
  }
  return false;
}

/** Execute one plan action and return an ActionRecord. */
async function executeAction(action) {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const base = { actionId: action.id, attempts: 1, startedAt, outcome: "executed" };
  try {
    switch (action.type) {
      case "wait":
        await sleep(action.durationMs);
        break;
      case "swipe":
        await mobilecli([
          "io",
          "swipe",
          swipeCoordinates(action.direction, action.distance ?? 700),
          "--duration",
          String(action.durationMs ?? 400),
          "--device",
          args.device,
        ]);
        break;
      case "tap": {
        const found = await tapTarget(action.target, 8000);
        if (!found) {
          throw new Error(`element "${action.target}" was not found`);
        }
        break;
      }
      case "wait_for": {
        const found = await tapTarget(action.target, action.timeoutMs ?? 10_000);
        if (!found) {
          throw new Error(`element "${action.target}" never appeared`);
        }
        break;
      }
      default:
        throw new Error(`unsupported action type "${action.type}"`);
    }
    if (action.waitAfterMs) {
      await sleep(action.waitAfterMs);
    }
    return { ...base, endedAt: new Date().toISOString(), durationMs: Date.now() - start };
  } catch (error) {
    return {
      ...base,
      outcome: "failed",
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function analyze(descriptor) {
  const result = await analyzePerformanceTrace(descriptor);
  if (result.error) {
    throw new Error(result.error);
  }
  return result;
}

/**
 * One Take: prepare → three passes → finalize. Returns a plain summary object;
 * the report itself lives in the workspace run directory.
 */
async function runTake({ runNumber, containerUuid, options, scenarioDir, runStore }) {
  log(`take ${runNumber}: prepare`);
  const prepared = await preparePerformanceTest(
    { scenarioId: args.scenario, device: { id: args.device } },
    options,
  );
  if (prepared.error) {
    throw new Error(prepared.error);
  }
  const { runId, plan } = prepared;
  const runDir = runStore.runDirectory(runId);
  const tracesDir = join(runDir, "traces");
  await fs.mkdir(tracesDir, { recursive: true });
  log(`take ${runNumber}: runId=${runId}`);

  const diagnostics = { lifecycle: [] };
  const metrics = [];
  const notes = [];
  const passes = {};
  const timings = {};
  const takeStartedAt = Date.now();

  const crashIdsBefore = await crashIds();
  log(`take ${runNumber}: crashes before=${crashIdsBefore.length}`);

  // The app is launched by mobilecli (not xctrace) so the Hitches pass can
  // attach to a stable pid and the actions run inside an already-warm UI.
  await mobilecli(["apps", "terminate", "--device", args.device, BUNDLE_ID]).catch(
    () => undefined,
  );
  await sleep(1500);
  log(`take ${runNumber}: launching app`);
  await mobilecli(["apps", "launch", "--device", args.device, BUNDLE_ID]);
  const foreground = await waitForForeground(BUNDLE_ID);
  log(`take ${runNumber}: foreground ${foreground.activity ?? "unknown"}`);
  await sleep(4000);
  const logStream = startLogStream();
  diagnostics.lifecycle.push({
    kind: "foreground",
    occurredAt: new Date().toISOString(),
    notes: `mobilecli foreground ${foreground.activity ?? "unknown"}`,
  });

  let pid = await resolveAppPid(containerUuid);
  if (!pid) {
    throw new Error("could not resolve the com.nndev.im pid after launch");
  }

  // ── Pass 1: Animation Hitches (hitches + blockMs) ──────────────────
  const hitchesStartedAt = Date.now();
  const hitchesTrace = join(tracesDir, "hitches.trace");
  log(`take ${runNumber}: hitches pass (pid ${pid})`);
  const actionRecords = [];
  const hitchesRecording = await recordHitches({
    pid,
    outputPath: hitchesTrace,
    during: async () => {
      for (const action of plan.actions) {
        actionRecords.push(await executeAction(action));
      }
    },
  });
  if (hitchesRecording.attempts > 1) {
    notes.push(`hitches pass needed ${hitchesRecording.attempts} attempts (kperf lock).`);
  }
  passes.hitches = { trace: hitchesTrace, attempts: hitchesRecording.attempts };
  const hitches = await analyze({ template: "hitches", tracePath: hitchesTrace });
  metrics.push(...hitches.metrics);
  timings.hitchesMs = Date.now() - hitchesStartedAt;

  // ── Pass 2: App Launch (launchMs) ───────────────────────────────────
  log(`take ${runNumber}: launch pass`);
  const launchStartedAt = Date.now();
  await mobilecli(["apps", "terminate", "--device", args.device, BUNDLE_ID]).catch(
    () => undefined,
  );
  await sleep(2000);
  const launchTrace = await recordLaunch({ cwd: tracesDir, before: "" });
  passes.launch = { trace: launchTrace };
  const launch = await analyze({
    template: "launch",
    tracePath: launchTrace,
    processName: APP_DISPLAY_NAME,
  });
  metrics.push(...launch.metrics);
  timings.launchMs = Date.now() - launchStartedAt;

  // ── Pass 3: Activity Monitor (memoryMB) ─────────────────────────────
  log(`take ${runNumber}: memory pass`);
  const memoryStartedAt = Date.now();
  await mobilecli(["apps", "launch", "--device", args.device, BUNDLE_ID]);
  await waitForForeground(BUNDLE_ID);
  await sleep(8000);
  pid = await resolveAppPid(containerUuid);
  if (!pid) {
    throw new Error("could not resolve the com.nndev.im pid before the memory pass");
  }
  const memoryTrace = join(tracesDir, "memory.trace");
  await recordMemory({ outputPath: memoryTrace });
  passes.memory = { trace: memoryTrace, pid };
  const memory = await analyze({
    template: "memory",
    tracePath: memoryTrace,
    pid,
    processName: APP_PROCESS_NAME,
  });
  metrics.push(...memory.metrics);
  timings.memoryMs = Date.now() - memoryStartedAt;

  const crashIdsAfter = await crashIds();
  const captured = await logStream.stop();
  const filteredLog = captured.text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(-5000)
    .join("\n");
  await runStore.writeText(runId, "device.log", filteredLog);
  if (captured.stderr.trim().length > 0) {
    notes.push(`device log stream stderr: ${captured.stderr.trim().slice(0, 500)}`);
  }

  log(`take ${runNumber}: finalize`);
  const finalized = await finalizePerformanceTest(
    {
      runId,
      requestedStatus: "completed",
      actions: actionRecords,
      metrics,
      diagnostics: {
        logText: filteredLog,
        logPath: "device.log",
        crashIdsBefore,
        crashIdsAfter,
        lifecycle: diagnostics.lifecycle,
      },
      notes: notes.join(" ") || undefined,
    },
    options,
  );
  if (finalized.error) {
    throw new Error(finalized.error);
  }

  const metricValues = Object.fromEntries(
    metrics.map((metric) => [metric.name, metric.value]),
  );
  return {
    runNumber,
    runId,
    runDirectory: runDir,
    status: finalized.status,
    gate: finalized.gate,
    metrics: metricValues,
    findings: finalized.findings.map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      message: finding.message,
    })),
    actions: actionRecords.map((action) => ({
      actionId: action.actionId,
      outcome: action.outcome,
      durationMs: action.durationMs,
      error: action.error ?? null,
    })),
    passes,
    notes,
    timings: { ...timings, totalMs: Date.now() - takeStartedAt },
  };
}

async function main() {
  const workspaceRoot = resolve(args.workspace);
  await fs.mkdir(workspaceRoot, { recursive: true });
  const manager = createWorkspaceManager(workspaceRoot);
  const state = await manager.inspect();
  if (state.kind === "uninitialized") {
    await manager.initialize({ bundleId: BUNDLE_ID, appName: "NN" });
  }
  const ready = await manager.requireReady();
  const scenarioDir = ready.paths.scenarioDirectory;
  const runsDir = ready.paths.runsDirectory;

  // Seed / refresh the validation scenario from the repo's sample scene.
  const sourceScenario = join(REPO_ROOT, "scenarios", `${args.scenario}.yaml`);
  if (!existsSync(sourceScenario)) {
    throw new Error(`Unknown scenario ${args.scenario}: ${sourceScenario} is missing.`);
  }
  await fs.copyFile(sourceScenario, join(scenarioDir, `${args.scenario}.yaml`));

  const runStore = createRunStore(runsDir, workspaceRoot);
  const options = {
    workspaceManager: manager,
    scenarioDir,
    runStore,
    now: () => new Date(),
  };

  const containerUuid = await resolveContainerUuid();
  log(`device=${args.device} bundle=${BUNDLE_ID} container=${containerUuid}`);

  const takes = [];
  for (let index = 1; index <= args.takes; index += 1) {
    const summary = await runTake({
      runNumber: index,
      containerUuid,
      options,
      scenarioDir,
      runStore,
    });
    takes.push(summary);
    log(
      `take ${index}: status=${summary.status} gate=${summary.gate} ` +
        JSON.stringify(summary.metrics),
    );
    if (index < args.takes) {
      await sleep(args.betweenTakesMs);
    }
  }

  const document = {
    generatedAt: new Date().toISOString(),
    device: args.device,
    bundleId: BUNDLE_ID,
    scenarioId: args.scenario,
    workspace: workspaceRoot,
    takes,
  };
  await fs.mkdir(dirname(resolve(args.out)), { recursive: true });
  await fs.writeFile(resolve(args.out), `${JSON.stringify(document, null, 2)}\n`);
  log(`wrote ${resolve(args.out)}`);
}

main().catch((error) => {
  log(`FAILED: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
