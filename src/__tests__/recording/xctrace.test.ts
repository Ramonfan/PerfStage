import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRecordArgs,
  createXctraceRecorder,
  hitchesProfileFromEnv,
  hitchesWindowFromEnv,
  parseRecordingIssues,
  resolveLaunchTrace,
} from "../../recording/xctrace.js";
import { COMPACT_HITCHES_MISSING_DIAGNOSTICS } from "../../recording/types.js";
import type { RecordRequest } from "../../recording/types.js";

const DEVICE = "00008150-001E49E40128C01C";

function request(overrides: Partial<RecordRequest>): RecordRequest {
  return {
    template: "hitches",
    device: DEVICE,
    target: { kind: "attach", pid: 4242 },
    outputPath: "/tmp/run/traces/hitches.trace",
    ...overrides,
  };
}

describe("buildRecordArgs", () => {
  it("attaches by pid and writes to the requested output", () => {
    const args = buildRecordArgs(request({ template: "hitches" }));
    expect(args.slice(0, 2)).toEqual(["record", "--template"]);
    expect(args).toContain("Animation Hitches");
    expect(args).toContain("--device");
    expect(args[args.indexOf("--device") + 1]).toBe(DEVICE);
    expect(args[args.indexOf("--attach") + 1]).toBe("4242");
    expect(args[args.indexOf("--output") + 1]).toBe(
      "/tmp/run/traces/hitches.trace",
    );
  });

  it("keeps every option before the `--launch --` separator", () => {
    const args = buildRecordArgs(
      request({
        template: "launch",
        target: { kind: "launch", bundleId: "com.nndev.im" },
        outputPath: "/tmp/run/traces/launch.trace",
      }),
    );
    const separator = args.indexOf("--");
    expect(separator).toBeGreaterThan(-1);
    // `--time-limit` after `--` would be passed to the app, not xctrace.
    expect(args.indexOf("--time-limit")).toBeLessThan(separator);
    expect(args.indexOf("--output")).toBeLessThan(separator);
    expect(args.slice(separator + 1)).toEqual(["com.nndev.im"]);
    expect(args).toContain("App Launch");
  });

  it("forwards launch arguments and environment to the launched app", () => {
    const args = buildRecordArgs(
      request({
        template: "hitches",
        target: { kind: "launch", bundleId: "com.nndev.im" },
        launch: {
          arguments: ["-UITestMode", "1"],
          environment: { LOG_LEVEL: "debug", RUM: "1" },
        },
      }),
    );
    const separator = args.indexOf("--");
    // `--env` is an xctrace option: after the separator it would become an
    // app argument and the variable would never be set.
    const envIndices = args.flatMap((arg, index) =>
      arg === "--env" ? [index] : [],
    );
    expect(envIndices).toHaveLength(2);
    for (const index of envIndices) {
      expect(index).toBeLessThan(separator);
    }
    expect(args[args.indexOf("--env") + 1]).toBe("LOG_LEVEL=debug");
    // Everything after the bundle id is the app's argv.
    expect(args.slice(separator + 1)).toEqual([
      "com.nndev.im",
      "-UITestMode",
      "1",
    ]);
  });

  it("omits launch options when the plan declares none", () => {
    const args = buildRecordArgs(
      request({ target: { kind: "launch", bundleId: "com.nndev.im" } }),
    );
    expect(args).not.toContain("--env");
    expect(args.slice(args.indexOf("--") + 1)).toEqual(["com.nndev.im"]);
  });

  it("records every process for the memory template", () => {
    const args = buildRecordArgs(
      request({ template: "memory", target: { kind: "allProcesses" } }),
    );
    expect(args).toContain("Activity Monitor");
    expect(args).toContain("--all-processes");
    expect(args).not.toContain("--attach");
  });

  it("applies per-template default time limits", () => {
    expect(buildRecordArgs(request({ template: "hitches" }))).toContain("20s");
    expect(buildRecordArgs(request({ template: "launch" }))).toContain("12s");
    expect(buildRecordArgs(request({ template: "memory" }))).toContain("12s");
  });

  it("keeps the historical argv when the hitches profile is full", () => {
    // The switch must be a no-op by default: same template, no --instrument,
    // same option order. A later default flip can then be reverted byte for
    // byte by setting the profile back to full.
    expect(
      buildRecordArgs(request({ template: "hitches", timeLimit: "40s" }), "full"),
    ).toEqual([
      "record",
      "--template",
      "Animation Hitches",
      "--device",
      DEVICE,
      "--time-limit",
      "40s",
      "--no-prompt",
      "--attach",
      "4242",
      "--output",
      "/tmp/run/traces/hitches.trace",
    ]);
  });

  it("switches only the hitches pass to Blank + Hitches when compact", () => {
    const args = buildRecordArgs(
      request({ template: "hitches", timeLimit: "40s" }),
      "compact",
    );
    expect(args.slice(0, 5)).toEqual([
      "record",
      "--template",
      "Blank",
      "--instrument",
      "Hitches",
    ]);
    expect(args).not.toContain("Animation Hitches");
    expect(args[args.indexOf("--time-limit") + 1]).toBe("40s");
    // The target and output handling stay exactly as before.
    expect(args.slice(args.indexOf("--attach"))).toEqual([
      "--attach",
      "4242",
      "--output",
      "/tmp/run/traces/hitches.trace",
    ]);
  });

  it("adds --window before the target only when the request sets it", () => {
    const plain = buildRecordArgs(request({ template: "hitches" }), "full");
    expect(plain).not.toContain("--window");

    const clipped = buildRecordArgs(
      request({ template: "hitches", window: "11s" }),
      "full",
    );
    expect(clipped[clipped.indexOf("--window") + 1]).toBe("11s");
    // Options must stay before `--attach`: xctrace treats everything after a
    // launch `--` as the child command.
    expect(clipped.indexOf("--window")).toBeLessThan(
      clipped.indexOf("--attach"),
    );
  });

  it("rejects a malformed --window duration", () => {
    expect(() =>
      buildRecordArgs(request({ template: "hitches", window: "11" })),
    ).toThrow(/--window/);
  });

  it("leaves launch and memory on their templates under the compact profile", () => {
    const launch = buildRecordArgs(
      request({
        template: "launch",
        target: { kind: "launch", bundleId: "com.nndev.im" },
      }),
      "compact",
    );
    expect(launch).toContain("App Launch");
    expect(launch).not.toContain("--instrument");
    const memory = buildRecordArgs(
      request({ template: "memory", target: { kind: "allProcesses" } }),
      "compact",
    );
    expect(memory).toContain("Activity Monitor");
    expect(memory).not.toContain("--instrument");
  });
});

describe("hitchesProfileFromEnv", () => {
  it("defaults to full and accepts compact case-insensitively", () => {
    expect(hitchesProfileFromEnv({})).toBe("full");
    expect(hitchesProfileFromEnv({ PERFSTAGE_HITCHES_PROFILE: "" })).toBe("full");
    expect(
      hitchesProfileFromEnv({ PERFSTAGE_HITCHES_PROFILE: "compact" }),
    ).toBe("compact");
    expect(
      hitchesProfileFromEnv({ PERFSTAGE_HITCHES_PROFILE: " Compact " }),
    ).toBe("compact");
  });

  it("rejects unknown values instead of silently recording the full profile", () => {
    // A typo must not quietly invalidate an A/B run.
    expect(() =>
      hitchesProfileFromEnv({ PERFSTAGE_HITCHES_PROFILE: "tiny" }),
    ).toThrow(/PERFSTAGE_HITCHES_PROFILE/);
  });
});

describe("hitchesWindowFromEnv", () => {
  it("defaults to full-session and accepts ms/s/m", () => {
    expect(hitchesWindowFromEnv({})).toBeUndefined();
    expect(hitchesWindowFromEnv({ PERFSTAGE_HITCHES_WINDOW: "  " })).toBeUndefined();
    expect(hitchesWindowFromEnv({ PERFSTAGE_HITCHES_WINDOW: "11s" })).toBe("11s");
    expect(hitchesWindowFromEnv({ PERFSTAGE_HITCHES_WINDOW: "500ms" })).toBe(
      "500ms",
    );
    expect(hitchesWindowFromEnv({ PERFSTAGE_HITCHES_WINDOW: "2m" })).toBe("2m");
  });

  it("rejects values xctrace would not accept", () => {
    expect(() =>
      hitchesWindowFromEnv({ PERFSTAGE_HITCHES_WINDOW: "11" }),
    ).toThrow(/PERFSTAGE_HITCHES_WINDOW/);
    expect(() =>
      hitchesWindowFromEnv({ PERFSTAGE_HITCHES_WINDOW: "1h" }),
    ).toThrow(/PERFSTAGE_HITCHES_WINDOW/);
  });
});

describe("parseRecordingIssues", () => {
  it("collects errors and warnings verbatim", () => {
    const issues = parseRecordingIssues(
      [
        "Run issues were detected (trace is still ready to be viewed):",
        "* [Error] Failed to start the recording: _lockKPerf",
        "* [Warning] Warning while binding 'time-sample' table",
      ].join("\n"),
    );
    expect(issues).toHaveLength(2);
    expect(issues[0]?.level).toBe("error");
    expect(issues[0]?.message).toContain("_lockKPerf");
    expect(issues[1]?.level).toBe("warning");
  });

  it("returns an empty list for a clean session", () => {
    expect(
      parseRecordingIssues("Recording completed. Saving output file..."),
    ).toEqual([]);
  });
});

describe("resolveLaunchTrace", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "perfstage-launch-trace-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function makeTrace(name: string, mtimeMs: number): Promise<string> {
    const path = join(root, name);
    await mkdir(path, { recursive: true });
    const seconds = mtimeMs / 1000;
    await utimes(path, seconds, seconds);
    return path;
  }

  it("picks the newest Launch_*.trace created after the recording started", async () => {
    const startedAt = Date.now();
    await makeTrace("Launch_com.nndev.im_old.trace", startedAt - 60_000);
    const fresh = await makeTrace(
      "Launch_com.nndev.im_new.trace",
      startedAt + 1_000,
    );

    const resolved = resolveLaunchTrace({
      directory: root,
      startedAt,
      existing: new Set([join(root, "Launch_com.nndev.im_old.trace")]),
    });
    expect(resolved).toBe(fresh);
  });

  it("ignores traces that already existed before the run", async () => {
    const startedAt = Date.now();
    const stale = await makeTrace("Launch_stale.trace", startedAt + 1_000);
    const resolved = resolveLaunchTrace({
      directory: root,
      startedAt,
      existing: new Set([stale]),
    });
    expect(resolved).toBeNull();
  });

  it("returns null when the directory does not exist", () => {
    expect(
      resolveLaunchTrace({
        directory: join(root, "missing"),
        startedAt: Date.now(),
        existing: new Set(),
      }),
    ).toBeNull();
  });
});

describe("createXctraceRecorder retry", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "perfstage-recorder-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("uses the requested output path when xctrace honours --output for --launch", async () => {
    const script = join(root, "fake-xctrace.sh");
    await writeFile(
      script,
      [
        "#!/bin/bash",
        "out=",
        'prev=',
        'for arg in "$@"; do',
        '  if [ "$prev" = "--output" ]; then out="$arg"; fi',
        '  prev="$arg"',
        "done",
        'mkdir -p "$out"',
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const outputPath = join(root, "launch.trace");
    const recorded = await createXctraceRecorder({
      command: script,
      sleep: async () => undefined,
    }).record({
      template: "launch",
      device: DEVICE,
      target: { kind: "launch", bundleId: "com.example.app" },
      outputPath,
      maxAttempts: 1,
    });

    expect(recorded.tracePath).toBe(outputPath);
    expect(recorded.attempts).toBe(1);
  });

  it("records the configuration the trace was produced with", async () => {
    const script = join(root, "fake-xctrace.sh");
    await writeFile(
      script,
      [
        "#!/bin/bash",
        "out=",
        "prev=",
        'for arg in "$@"; do',
        '  if [ "$prev" = "--output" ]; then out="$arg"; fi',
        '  prev="$arg"',
        "done",
        'mkdir -p "$out"',
        'printf x > "$out/payload"',
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const base = {
      template: "hitches" as const,
      device: DEVICE,
      target: { kind: "attach" as const, pid: 4242 },
      maxAttempts: 1,
    };
    const compact = await createXctraceRecorder({
      command: script,
      sleep: async () => undefined,
      hitchesProfile: "compact",
    }).record({
      ...base,
      outputPath: join(root, "compact.trace"),
      timeLimit: "40s",
    });
    expect(compact.recording).toEqual({
      profile: "compact",
      template: "Blank",
      instruments: ["Hitches"],
      timeLimit: "40s",
      liveTimeoutMs: 90_000,
      window: "full-session",
      missingDiagnostics: [...COMPACT_HITCHES_MISSING_DIAGNOSTICS],
    });

    // Default stays the historical template, and the record states it.
    const full = await createXctraceRecorder({
      command: script,
      sleep: async () => undefined,
    }).record({ ...base, outputPath: join(root, "full.trace") });
    expect(full.recording).toEqual({
      profile: "full",
      template: "Animation Hitches",
      timeLimit: "20s",
      liveTimeoutMs: 90_000,
      window: "full-session",
    });
  });

  it("reads the internal profile switch from PERFSTAGE_HITCHES_PROFILE", async () => {
    const script = join(root, "fake-xctrace.sh");
    await writeFile(
      script,
      [
        "#!/bin/bash",
        "out=",
        "prev=",
        'for arg in "$@"; do',
        '  if [ "$prev" = "--output" ]; then out="$arg"; fi',
        '  prev="$arg"',
        "done",
        'mkdir -p "$out"',
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const previous = process.env.PERFSTAGE_HITCHES_PROFILE;
    process.env.PERFSTAGE_HITCHES_PROFILE = "compact";
    try {
      const recorded = await createXctraceRecorder({
        command: script,
        sleep: async () => undefined,
      }).record({
        template: "hitches",
        device: DEVICE,
        target: { kind: "attach", pid: 4242 },
        outputPath: join(root, "env-compact.trace"),
        maxAttempts: 1,
      });
      expect(recorded.recording.profile).toBe("compact");
      expect(recorded.recording.template).toBe("Blank");
    } finally {
      if (previous === undefined) {
        delete process.env.PERFSTAGE_HITCHES_PROFILE;
      } else {
        process.env.PERFSTAGE_HITCHES_PROFILE = previous;
      }
    }
  });

  it("applies PERFSTAGE_HITCHES_WINDOW to the hitches pass only", async () => {
    // Capture the argv so the assertion covers the xctrace call, not just the
    // persisted config: the env value must reach the process.
    const argvFile = join(root, "argv.txt");
    const script = join(root, "fake-xctrace.sh");
    await writeFile(
      script,
      [
        "#!/bin/bash",
        `for arg in "$@"; do printf '%s\\n' "$arg" >> ${JSON.stringify(argvFile)}; done`,
        `printf '%s\\n' '---' >> ${JSON.stringify(argvFile)}`,
        "out=",
        "prev=",
        'for arg in "$@"; do',
        '  if [ "$prev" = "--output" ]; then out="$arg"; fi',
        '  prev="$arg"',
        "done",
        'mkdir -p "$out"',
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const previous = process.env.PERFSTAGE_HITCHES_WINDOW;
    process.env.PERFSTAGE_HITCHES_WINDOW = "11s";
    try {
      const recorder = createXctraceRecorder({
        command: script,
        sleep: async () => undefined,
      });
      const hitches = await recorder.record({
        template: "hitches",
        device: DEVICE,
        target: { kind: "attach", pid: 4242 },
        outputPath: join(root, "window-hitches.trace"),
        maxAttempts: 1,
      });
      expect(hitches.recording.window).toBe("11s");

      // The switch is a hitches A/B knob; other passes stay full-session.
      const launch = await recorder.record({
        template: "launch",
        device: DEVICE,
        target: { kind: "launch", bundleId: "com.nndev.im" },
        outputPath: join(root, "window-launch.trace"),
        maxAttempts: 1,
      });
      expect(launch.recording.window).toBe("full-session");

      const calls = (await readFile(argvFile, "utf8"))
        .split("---\n")
        .filter((call) => call.trim() !== "");
      expect(calls).toHaveLength(2);
      const [hitchesArgs, launchArgs] = calls.map((call) =>
        call.trimEnd().split("\n"),
      );
      expect(hitchesArgs).toContain("--window");
      expect(hitchesArgs?.[hitchesArgs.indexOf("--window") + 1]).toBe("11s");
      expect(launchArgs).not.toContain("--window");
    } finally {
      if (previous === undefined) {
        delete process.env.PERFSTAGE_HITCHES_WINDOW;
      } else {
        process.env.PERFSTAGE_HITCHES_WINDOW = previous;
      }
    }
  });

  it("retries a kperf lock collision and reports the attempt count", async () => {
    const counter = join(root, "counter");
    const script = join(root, "fake-xctrace.sh");
    await writeFile(
      script,
      [
        "#!/bin/bash",
        'set -e',
        `n=$(cat "${counter}" 2>/dev/null || echo 0)`,
        "n=$((n + 1))",
        `echo "$n" > "${counter}"`,
        'if [ "$n" -lt 2 ]; then',
        '  echo "* [Error] Failed to start the recording: _lockKPerf: could not lock kperf"',
        "  exit 1",
        "fi",
        // App Launch ignores --output on real xctrace too: write our own name.
        // `cwd` is already the trace directory; $PWD would be inherited.
        'mkdir -p "Launch_com.example.app_fake.trace"',
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const recorder = createXctraceRecorder({
      command: script,
      sleep: async () => undefined,
    });

    const recorded = await recorder.record({
      template: "launch",
      device: DEVICE,
      target: { kind: "launch", bundleId: "com.example.app" },
      outputPath: join(root, "launch.trace"),
      maxAttempts: 3,
      retryDelayMs: 0,
    });

    expect(recorded.attempts).toBe(2);
    expect(recorded.tracePath).toContain("Launch_com.example.app_fake.trace");
    expect((await readFile(counter, "utf8")).trim()).toBe("2");
  });

  it("retries the same pid when the device has not caught up yet", async () => {
    const counter = join(root, "counter");
    const script = join(root, "fake-xctrace.sh");
    await writeFile(
      script,
      [
        "#!/bin/bash",
        'set -e',
        `n=$(cat "${counter}" 2>/dev/null || echo 0)`,
        "n=$((n + 1))",
        `echo "$n" > "${counter}"`,
        'echo "* [Error] Cannot find process for provided pid: 4242"',
        "exit 21",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const recorder = createXctraceRecorder({
      command: script,
      sleep: async () => undefined,
    });

    const attempt = recorder.record({
      template: "hitches",
      device: DEVICE,
      target: { kind: "attach", pid: 4242 },
      outputPath: join(root, "hitches.trace"),
      during: async () => undefined,
      maxAttempts: 3,
      retryDelayMs: 0,
    });

    await expect(attempt).rejects.toMatchObject({ kind: "pid-gone", retryable: true });
    // The device-side process table often lags a fresh launch by a few
    // seconds and then accepts the same pid. Burning one attempt and handing
    // the relaunch to the Runner misses that window, so the recorder retries
    // the same pid first (real-device evidence: pid 623 failed 3x, then
    // recorded successfully).
    expect((await readFile(counter, "utf8")).trim()).toBe("3");
  });
});

describe("createXctraceRecorder fatal-trace guards", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "perfstage-recorder-fatal-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function script(lines: string[], counterName = "counter"): Promise<{
    path: string;
    counter: string;
  }> {
    const counter = join(root, counterName);
    const path = join(root, "fake-xctrace.sh");
    await writeFile(
      path,
      [
        "#!/bin/bash",
        'out=""; prev=""',
        'for arg in "$@"; do',
        '  if [ "$prev" = "--output" ]; then out="$arg"; fi',
        '  prev="$arg"',
        "done",
        `n=$(cat "${counter}" 2>/dev/null || echo 0)`,
        "n=$((n + 1))",
        `echo "$n" > "${counter}"`,
        ...lines,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    return { path, counter };
  }

  it("fails a malformed transfer instead of analysing a shell of a trace", async () => {
    const { path, counter } = await script([
      'mkdir -p "$out"',
      'echo "* [Error] Transferred trace file is malformed"',
      "exit 0",
    ]);
    const outputPath = join(root, "hitches.trace");

    await expect(
      createXctraceRecorder({ command: path, sleep: async () => undefined }).record({
        template: "hitches",
        device: DEVICE,
        target: { kind: "launch", bundleId: "com.example.app" },
        outputPath,
        maxAttempts: 3,
        retryDelayMs: 0,
      }),
    ).rejects.toMatchObject({ kind: "malformed-trace", retryable: false });

    // Not retryable: a retry only puts more load on a device that is already
    // failing to transfer its recording buffer.
    expect((await readFile(counter, "utf8")).trim()).toBe("1");
    // The empty shell must not be left behind for the analyzer to trust.
    await expect(readFile(outputPath, "utf8")).rejects.toThrow();
  });

  it("fails when the app exits during the recording", async () => {
    const { path } = await script([
      'mkdir -p "$out"',
      'echo "Target app exited, ending recording..."',
      "exit 0",
    ]);

    await expect(
      createXctraceRecorder({ command: path, sleep: async () => undefined }).record({
        template: "hitches",
        device: DEVICE,
        target: { kind: "launch", bundleId: "com.example.app" },
        outputPath: join(root, "hitches.trace"),
        maxAttempts: 3,
        retryDelayMs: 0,
      }),
    ).rejects.toMatchObject({ kind: "app-exited", retryable: false });
  });

  it("does not retry a wedged device recording service", async () => {
    const { path, counter } = await script([
      'echo "* [Error] Failed to start the recording: Failed starting ktrace session."',
      "exit 1",
    ]);

    const error = (await createXctraceRecorder({
      command: path,
      sleep: async () => undefined,
    })
      .record({
        template: "hitches",
        device: DEVICE,
        target: { kind: "launch", bundleId: "com.example.app" },
        outputPath: join(root, "hitches.trace"),
        maxAttempts: 3,
        retryDelayMs: 0,
      })
      .catch((caught: unknown) => caught)) as { kind: string; message: string };

    expect(error.kind).toBe("instruments-wedged");
    expect(error.message).toContain("device restart");
    expect((await readFile(counter, "utf8")).trim()).toBe("1");
  });
});

describe("createXctraceRecorder footprint", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "perfstage-recorder-footprint-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeScript(lines: string[]): Promise<string> {
    const path = join(root, "fake-xctrace.sh");
    await writeFile(
      path,
      [
        "#!/bin/bash",
        'out=""; prev=""',
        'for arg in "$@"; do',
        '  if [ "$prev" = "--output" ]; then out="$arg"; fi',
        '  prev="$arg"',
        "done",
        ...lines,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    return path;
  }

  it("sums regular files in the bundle and times the save phase", async () => {
    const script = await writeScript([
      'mkdir -p "$out/nested"',
      `printf '0123456789' > "$out/top.bin"`,
      `printf 'abcd' > "$out/nested/leaf.bin"`,
      // Symlinks are skipped: following them would double count the target.
      `ln -s "$out/top.bin" "$out/link.bin"`,
      // Delay before the banner proves the timer starts at the banner rather
      // than at spawn: if it started at `startedAt`, saveMs would ~= durationMs.
      "sleep 0.3",
      'echo "Recording completed. Saving output file..."',
      "sleep 0.3",
    ]);

    const recorded = await createXctraceRecorder({
      command: script,
      sleep: async () => undefined,
    }).record({
      template: "hitches",
      device: DEVICE,
      target: { kind: "attach", pid: 4242 },
      outputPath: join(root, "hitches.trace"),
      maxAttempts: 1,
    });

    expect(recorded.bytes).toBe(14);
    // The banner is observed before the child exits; the measured span must
    // come from that boundary, not from the pass wall clock.
    expect(recorded.saveMs).toBeGreaterThanOrEqual(200);
    expect(recorded.durationMs - (recorded.saveMs ?? 0)).toBeGreaterThanOrEqual(200);
    expect(recorded.issues).toEqual([]);
  });

  it("omits saveMs when the session never announces the save phase", async () => {
    const script = await writeScript([
      'mkdir -p "$out"',
      `printf 'abc' > "$out/data.bin"`,
      "exit 0",
    ]);

    const recorded = await createXctraceRecorder({
      command: script,
      sleep: async () => undefined,
    }).record({
      template: "hitches",
      device: DEVICE,
      target: { kind: "attach", pid: 4242 },
      outputPath: join(root, "hitches.trace"),
      maxAttempts: 1,
    });

    expect(recorded.bytes).toBe(3);
    // Never guessed from durationMs: an unobserved phase stays absent.
    expect(recorded.saveMs).toBeUndefined();
  });

  it("records saveMs when a normal SIGINT stop saves and exits cleanly", async () => {
    const script = await writeScript([
      `trap 'mkdir -p "$out"; printf abc > "$out/data.bin"; echo "Recording completed. Saving output file..."; sleep 0.3; exit 0' INT`,
      'echo "Starting recording."',
      'echo "Ctrl-C to stop the recording"',
      "while true; do sleep 0.02; done",
    ]);

    const recorded = await createXctraceRecorder({
      command: script,
      sleep: async () => undefined,
      sigkillGraceMs: 500,
    }).record({
      template: "hitches",
      device: DEVICE,
      target: { kind: "attach", pid: 4242 },
      outputPath: join(root, "hitches.trace"),
      during: async () => undefined,
      duringTimeoutMs: 5_000,
      graceMs: 0,
      maxAttempts: 1,
      retryDelayMs: 0,
    });

    // Normal interactive stop is SIGINT; xctrace handles it, saves and exits 0.
    // Only a signal-terminated process omits saveMs.
    expect(recorded.bytes).toBe(3);
    expect(recorded.saveMs).toBeGreaterThanOrEqual(200);
  });

  it("omits saveMs when the save phase is cut short by a signal", async () => {
    const script = await writeScript([
      'mkdir -p "$out"',
      `printf 'abc' > "$out/data.bin"`,
      'echo "Recording completed. Saving output file..."',
      "kill -TERM $$",
    ]);

    const recorded = await createXctraceRecorder({
      command: script,
      sleep: async () => undefined,
    }).record({
      template: "hitches",
      device: DEVICE,
      target: { kind: "attach", pid: 4242 },
      outputPath: join(root, "hitches.trace"),
      maxAttempts: 1,
    });

    // The trace is still evidence, but the save phase never completed.
    expect(recorded.bytes).toBe(3);
    expect(recorded.saveMs).toBeUndefined();
  });

  it("treats a bundle with no measurable bytes as unmeasured", async () => {
    const script = await writeScript([
      'mkdir -p "$out/nested"',
      "exit 0",
    ]);

    const recorded = await createXctraceRecorder({
      command: script,
      sleep: async () => undefined,
    }).record({
      template: "hitches",
      device: DEVICE,
      target: { kind: "attach", pid: 4242 },
      outputPath: join(root, "hitches.trace"),
      maxAttempts: 1,
    });

    expect(recorded.bytes).toBeUndefined();
    expect(recorded.issues).toEqual([
      expect.objectContaining({
        level: "warning",
        message: expect.stringContaining("no measurable bytes"),
      }),
    ]);
  });

  it("reports a warning and omits bytes when the bundle cannot be measured", async () => {
    // A FIFO exists but is neither a regular file nor a directory, so the
    // measurement fails. Recording the reason beats persisting a fake 0.
    const script = await writeScript([
      'mkfifo "$out"',
      "exit 0",
    ]);

    const recorded = await createXctraceRecorder({
      command: script,
      sleep: async () => undefined,
    }).record({
      template: "hitches",
      device: DEVICE,
      target: { kind: "attach", pid: 4242 },
      outputPath: join(root, "hitches.trace"),
      maxAttempts: 1,
    });

    expect(recorded.bytes).toBeUndefined();
    expect(recorded.issues).toEqual([
      expect.objectContaining({
        level: "warning",
        message: expect.stringContaining("could not measure trace size"),
      }),
    ]);
  });
});

describe("createXctraceRecorder during deadline", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "perfstage-recorder-during-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("stops the session when the scenario callback hangs", async () => {
    const stopped = join(root, "stopped");
    const path = join(root, "fake-xctrace.sh");
    await writeFile(
      path,
      [
        "#!/bin/bash",
        `trap 'echo stopped > "${stopped}"; exit 0' INT`,
        'echo "Starting recording."',
        'echo "Ctrl-C to stop the recording"',
        "while true; do sleep 0.02; done",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const started = Date.now();
    await expect(
      createXctraceRecorder({
        command: path,
        sleep: async () => undefined,
        sigkillGraceMs: 500,
      }).record({
        template: "hitches",
        device: DEVICE,
        target: { kind: "attach", pid: 4242 },
        outputPath: join(root, "hitches.trace"),
        duringTimeoutMs: 100,
        // Models a device query that never answers.
        during: () => new Promise<void>(() => undefined),
        maxAttempts: 1,
        retryDelayMs: 0,
      }),
    ).rejects.toMatchObject({ kind: "aborted", retryable: false });

    // The session was asked to stop instead of waiting for `timeLimit`.
    expect(await readFile(stopped, "utf8")).toContain("stopped");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("createXctraceRecorder caller failures", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "perfstage-recorder-cause-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("preserves the caller's error as the cause of the recording error", async () => {
    const path = join(root, "fake-xctrace.sh");
    await writeFile(
      path,
      [
        "#!/bin/bash",
        "trap 'exit 0' INT",
        'echo "Starting recording."',
        'echo "Ctrl-C to stop the recording"',
        "while true; do sleep 0.02; done",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    class CallerFailure extends Error {}
    const failure = new CallerFailure("precondition failed");

    const error = (await createXctraceRecorder({
      command: path,
      sleep: async () => undefined,
      sigkillGraceMs: 500,
    })
      .record({
        template: "hitches",
        device: DEVICE,
        target: { kind: "attach", pid: 4242 },
        outputPath: join(root, "hitches.trace"),
        duringTimeoutMs: 30_000,
        during: async () => {
          throw failure;
        },
        maxAttempts: 1,
        retryDelayMs: 0,
      })
      .catch((caught: unknown) => caught)) as {
      kind?: string;
      cause?: unknown;
    };

    // The recording layer wraps the error so its own classification stays
    // intact; the caller's identity must survive on the cause chain, otherwise
    // a precondition violation is indistinguishable from a device failure.
    expect(error.kind).toBe("aborted");
    expect(error.cause).toBe(failure);
  });
});
