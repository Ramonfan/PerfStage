import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRecordArgs,
  createXctraceRecorder,
  parseRecordingIssues,
  resolveLaunchTrace,
} from "../../recording/xctrace.js";
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
