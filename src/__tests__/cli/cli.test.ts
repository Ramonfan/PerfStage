import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EXIT_ENVIRONMENT,
  EXIT_GATE_FAIL,
  EXIT_INVALID_TAKE,
  EXIT_OK,
  exitCodeFor,
} from "../../cli/exit-codes.js";
import { main, type CliContext, type CliIO } from "../../cli/index.js";
import { createFakeDriver } from "../../device/fake.js";
import { createFakeRecorder } from "../../recording/fake.js";
import type { TraceAnalyzer } from "../../runner/execute.js";
import { listPerformanceRuns } from "../../tools/runs.js";
import { comparePerformanceRuns } from "../../tools/compare.js";
import { createRunStore } from "../../storage/runs.js";

const DEVICE_ID = "00000000-0000000000000000";

interface TheMetrics {
  hitches?: number;
  blockMs?: number;
  launchMs?: number | null;
  memoryMB?: number;
}

function analyzer(values: TheMetrics): TraceAnalyzer {
  return async ({ template, tracePath }) => {
    const measuredAt = new Date().toISOString();
    const metric = (
      name: string,
      value: number | null | undefined,
      unit: string,
    ) => ({
      name,
      ...(value !== null && value !== undefined ? { value } : {}),
      unit,
      tracePath,
      measuredAt,
    });
    if (template === "hitches") {
      return {
        metrics: [
          metric("hitches", values.hitches, "次"),
          metric("blockMs", values.blockMs, "ms"),
        ],
      };
    }
    if (template === "launch") {
      return { metrics: [metric("launchMs", values.launchMs, "ms")] };
    }
    return { metrics: [metric("memoryMB", values.memoryMB, "MB")] };
  };
}

function plan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    app: { bundleId: "com.example.app" },
    actions: [
      {
        id: "scroll-1",
        type: "swipe",
        direction: "up",
        distance: 600,
        durationMs: 300,
        waitAfterMs: 0,
      },
    ],
    metrics: [
      { name: "hitches", threshold: { warn: 50, fail: 100 } },
      { name: "blockMs", threshold: { warn: 100, fail: 250 } },
      { name: "launchMs", threshold: { warn: 800, fail: 1500 } },
      { name: "memoryMB", threshold: { warn: 300, fail: 500 } },
    ],
    ...overrides,
  };
}

function capture(): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    },
    out,
    err,
  };
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "perfstage-cli-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function initWorkspace(): Promise<void> {
  const { io } = capture();
  const code = await main(["init", "--dir", root], { io });
  expect(code).toBe(EXIT_OK);
}

async function writePlan(overrides: Record<string, unknown> = {}): Promise<string> {
  const path = join(root, "plan.json");
  await writeFile(path, JSON.stringify(plan(overrides)), "utf8");
  return path;
}

function runnerContext(
  values: TheMetrics,
  io: CliIO,
  extra: Partial<CliContext> = {},
): Partial<CliContext> {
  const device = createFakeDriver({
    elements: [{ rect: { x: 0, y: 0, width: 393, height: 852 } }],
  });
  return {
    io,
    runner: {
      device,
      // The hitches pass records with `--launch`, so the fake recorder has to
      // do what xctrace does: start the app.
      recorder: createFakeRecorder({
        onLaunch: () => device.simulateExternalLaunch(),
      }),
      analyze: analyzer(values),
      sleep: async () => undefined,
    },
    ...extra,
  };
}

describe("exitCodeFor", () => {
  it("keeps a valid Take with warn/unknown green", () => {
    expect(exitCodeFor({ status: "completed", gate: "pass" })).toBe(EXIT_OK);
    expect(exitCodeFor({ status: "completed", gate: "warn" })).toBe(EXIT_OK);
    expect(exitCodeFor({ status: "completed", gate: "unknown" })).toBe(EXIT_OK);
  });

  it("promotes warn only under --strict", () => {
    expect(
      exitCodeFor({ status: "completed", gate: "warn", strict: true }),
    ).toBe(EXIT_GATE_FAIL);
  });

  it("treats an untrustworthy Take as invalid before considering the gate", () => {
    for (const status of ["partial", "failed", "invalid", "cancelled"]) {
      expect(exitCodeFor({ status, gate: "fail" })).toBe(EXIT_INVALID_TAKE);
    }
  });
});

describe("perfstage CLI", () => {
  it("init creates the workspace and list reads it back", async () => {
    await initWorkspace();
    const list = capture();
    const code = await main(["list", "--dir", root, "--json"], { io: list.io });
    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(list.out.join("\n")) as { scenarios: unknown[] };
    expect(payload.scenarios).toEqual([]);
  });

  it("returns 3 when the workspace was never initialized", async () => {
    const { io, err } = capture();
    const code = await main(["list", "--dir", root], { io });
    expect(code).toBe(EXIT_ENVIRONMENT);
    expect(err.join(" ")).toContain("perfstage init");
  });

  it("returns 3 when run is missing a device id", async () => {
    await initWorkspace();
    const planPath = await writePlan();
    const { io, err } = capture();
    const code = await main(["run", "--plan", planPath, "--dir", root], {
      io,
      env: {},
    });
    expect(code).toBe(EXIT_ENVIRONMENT);
    expect(err.join(" ")).toContain("--device");
  });

  it("returns 0 for a valid Take under every threshold", async () => {
    await initWorkspace();
    const planPath = await writePlan();
    const { io } = capture();
    const code = await main(
      ["run", "--plan", planPath, "--device", DEVICE_ID, "--dir", root],
      runnerContext({ hitches: 10, blockMs: 40, launchMs: 300, memoryMB: 100 }, io),
    );
    expect(code).toBe(EXIT_OK);
  });

  it("returns 1 when the gate fails", async () => {
    await initWorkspace();
    const planPath = await writePlan();
    const { io } = capture();
    const code = await main(
      ["run", "--plan", planPath, "--device", DEVICE_ID, "--dir", root],
      runnerContext({ hitches: 5_000, blockMs: 40, launchMs: 300, memoryMB: 100 }, io),
    );
    expect(code).toBe(EXIT_GATE_FAIL);
  });

  it("returns 1 for a warn only when --strict is set", async () => {
    await initWorkspace();
    const planPath = await writePlan();
    const { io } = capture();

    const lenient = await main(
      ["run", "--plan", planPath, "--device", DEVICE_ID, "--dir", root],
      runnerContext({ hitches: 60, blockMs: 40, launchMs: 300, memoryMB: 100 }, io),
    );
    expect(lenient).toBe(EXIT_OK);

    const strict = await main(
      [
        "run",
        "--plan",
        planPath,
        "--device",
        DEVICE_ID,
        "--dir",
        root,
        "--strict",
      ],
      runnerContext({ hitches: 60, blockMs: 40, launchMs: 300, memoryMB: 100 }, io),
    );
    expect(strict).toBe(EXIT_GATE_FAIL);
  });

  it("returns 2 when a requested metric has no evidence", async () => {
    await initWorkspace();
    const planPath = await writePlan();
    const { io } = capture();
    const code = await main(
      ["run", "--plan", planPath, "--device", DEVICE_ID, "--dir", root],
      runnerContext(
        { hitches: 10, blockMs: 40, launchMs: null, memoryMB: 100 },
        io,
      ),
    );
    expect(code).toBe(EXIT_INVALID_TAKE);
  });

  it("emits JSON on stdout that is structurally the Runner summary", async () => {
    await initWorkspace();
    const planPath = await writePlan();
    const { io, out } = capture();
    const code = await main(
      [
        "run",
        "--plan",
        planPath,
        "--device",
        DEVICE_ID,
        "--dir",
        root,
        "--json",
      ],
      {
        ...runnerContext({ hitches: 10, blockMs: 40, launchMs: 300, memoryMB: 100 }, io),
      },
    );
    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(out.join("\n")) as Record<string, unknown>;
    expect(payload.status).toBe("completed");
    expect(payload.gate).toBe("pass");
    expect(Array.isArray(payload.metrics)).toBe(true);
    expect(payload.reportPath).toBeTruthy();
  });

  it("prints an existing report by run id", async () => {
    await initWorkspace();
    const planPath = await writePlan();
    const json = capture();
    await main(
      ["run", "--plan", planPath, "--device", DEVICE_ID, "--dir", root, "--json"],
      {
        ...runnerContext({ hitches: 10, blockMs: 40, launchMs: 300, memoryMB: 100 }, json.io),
      },
    );
    const summary = JSON.parse(json.out.join("\n")) as { runId: string };

    const report = capture();
    const code = await main(
      ["report", summary.runId, "--dir", root, "--json"],
      { io: report.io },
    );
    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(report.out.join("\n")) as {
      run: { id: string };
    };
    expect(payload.run.id).toBe(summary.runId);
  });

  it("lists a committed Take through the runs command", async () => {
    await initWorkspace();
    const planPath = await writePlan();
    await main(
      ["run", "--plan", planPath, "--device", DEVICE_ID, "--dir", root],
      runnerContext({ hitches: 10, blockMs: 40, launchMs: 300, memoryMB: 100 }, capture().io),
    );

    const runs = capture();
    const code = await main(["runs", "--dir", root, "--json"], { io: runs.io });
    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(runs.out.join("\n")) as {
      runs: Array<Record<string, unknown>>;
      unindexed: number;
      invalidLines: number;
      skipped: number;
    };
    expect(payload.unindexed).toBe(0);
    expect(payload.invalidLines).toBe(0);
    expect(payload.runs).toHaveLength(1);
    expect(payload.runs[0]).toMatchObject({
      status: "completed",
      gate: "pass",
      passCount: 3,
      deviceId: DEVICE_ID,
    });
  });

  it("lists legacy runs without an index and matches the MCP handler", async () => {
    await initWorkspace();
    const runsDir = join(root, ".performance-test", "runs");
    const runDir = join(runsDir, "legacy-run");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "run.json"),
      JSON.stringify({
        id: "legacy-run",
        planId: "scene-a",
        status: "completed",
        startedAt: "2026-11-15T00:00:00.000Z",
        endedAt: "2026-11-15T00:01:00.000Z",
        gate: "pass",
      }),
      "utf8",
    );
    await writeFile(
      join(runDir, "plan.json"),
      JSON.stringify({
        id: "scene-a",
        source: "scenario",
        device: { id: "device-1" },
      }),
      "utf8",
    );

    const runs = capture();
    const code = await main(["runs", "--dir", root, "--json"], { io: runs.io });
    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(runs.out.join("\n")) as {
      runs: Array<Record<string, unknown>>;
      unindexed: number;
    };
    expect(payload.unindexed).toBe(1);
    expect(payload.runs[0]).toMatchObject({
      runId: "legacy-run",
      scenarioId: "scene-a",
      passCount: null,
    });

    const viaHandler = await listPerformanceRuns(
      {},
      { runStore: createRunStore(runsDir), now: () => new Date() },
    );
    expect(viaHandler).toEqual(payload);

    // Text output must not invent a duration for a run that never recorded one.
    const text = capture();
    expect(await main(["runs", "--dir", root], { io: text.io })).toBe(EXIT_OK);
    const line = text.out[0] ?? "";
    expect(line).toContain("legacy-run");
    expect(line).toContain("—");
    expect(line).not.toContain("0ms");
    expect(text.out.join("\n")).toContain("本工作区补全 1 条");
  });

  it("rejects an invalid runs filter", async () => {
    await initWorkspace();

    const badLimit = capture();
    expect(
      await main(["runs", "--dir", root, "--limit", "0"], { io: badLimit.io }),
    ).toBe(EXIT_ENVIRONMENT);
    expect(badLimit.err.join(" ")).toContain("--limit");

    const badStatus = capture();
    expect(
      await main(["runs", "--dir", root, "--status", "bogus"], {
        io: badStatus.io,
      }),
    ).toBe(EXIT_ENVIRONMENT);
    expect(badStatus.err.join(" ")).toContain("--status");
  });
});

async function seedComparisonRun(input: {
  id: string;
  startedAt: string;
  osVersion?: string | null;
  hitches?: number;
}): Promise<void> {
  const runsDir = join(root, ".performance-test", "runs");
  const runDir = join(runsDir, input.id);
  await mkdir(runDir, { recursive: true });
  const osVersion = input.osVersion === undefined ? "27.0.1" : input.osVersion;
  await writeFile(
    join(runDir, "run.json"),
    JSON.stringify({
      id: input.id,
      planId: "scene-a",
      ...(osVersion !== null
        ? { device: { id: "device-1", osVersion } }
        : {}),
      status: "completed",
      startedAt: input.startedAt,
      endedAt: input.startedAt,
      gate: "pass",
      metrics: [
        { name: "hitches", value: input.hitches ?? 10, unit: "次" },
      ],
    }),
    "utf8",
  );
  await writeFile(
    join(runDir, "plan.json"),
    JSON.stringify({
      id: "scene-a",
      source: "scenario",
      device: { id: "device-1" },
    }),
    "utf8",
  );
}

describe("perfstage compare", () => {
  it("renders a derived baseline in text and matches the handler", async () => {
    await initWorkspace();
    await seedComparisonRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      hitches: 12,
    });
    await seedComparisonRun({
      id: "base-1",
      startedAt: "2026-11-16T01:00:00.000Z",
      hitches: 8,
    });
    await seedComparisonRun({
      id: "base-2",
      startedAt: "2026-11-16T02:00:00.000Z",
      hitches: 14,
    });
    await seedComparisonRun({
      id: "base-3",
      startedAt: "2026-11-16T03:00:00.000Z",
      hitches: 10,
    });

    const text = capture();
    expect(
      await main(["compare", "target", "--dir", root], { io: text.io }),
    ).toBe(EXIT_OK);
    const rendered = text.out.join("\n");
    expect(rendered).toContain("派生基线 3 条");
    expect(rendered).toContain("hitches");
    expect(rendered).toContain("baseline=10");
    expect(rendered).toContain("samples=3");
    expect(rendered).not.toContain("注意：基线样本不足");

    const json = capture();
    expect(
      await main(["compare", "target", "--dir", root, "--json"], {
        io: json.io,
      }),
    ).toBe(EXIT_OK);
    const payload = JSON.parse(json.out.join("\n")) as Record<string, unknown>;
    expect(payload).toMatchObject({
      status: "comparable",
      baseline: {
        kind: "derived",
        samples: 3,
        runIds: ["base-3", "base-2", "base-1"],
      },
    });

    const viaHandler = await comparePerformanceRuns(
      { runId: "target" },
      {
        runStore: createRunStore(join(root, ".performance-test", "runs"), root),
        now: () => new Date(),
      },
    );
    expect(viaHandler).toEqual(payload);
  });

  it("compares directly against one Take with --against", async () => {
    await initWorkspace();
    await seedComparisonRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      hitches: 12,
    });
    await seedComparisonRun({
      id: "against",
      startedAt: "2026-11-16T03:00:00.000Z",
      hitches: 10,
    });

    const json = capture();
    expect(
      await main(
        ["compare", "target", "--against", "against", "--dir", root, "--json"],
        { io: json.io },
      ),
    ).toBe(EXIT_OK);
    const payload = JSON.parse(json.out.join("\n")) as {
      status: string;
      baseline: { kind: string; samples: number };
    };
    expect(payload.status).toBe("comparable");
    expect(payload.baseline).toMatchObject({ kind: "against", samples: 1 });
  });

  it("rejects invalid compare arguments with exit 3", async () => {
    await initWorkspace();

    const missing = capture();
    expect(await main(["compare", "--dir", root], { io: missing.io })).toBe(
      EXIT_ENVIRONMENT,
    );
    expect(missing.err.join(" ")).toContain("compare 需要");

    const badSamples = capture();
    expect(
      await main(["compare", "target", "--samples", "2", "--dir", root], {
        io: badSamples.io,
      }),
    ).toBe(EXIT_ENVIRONMENT);
    expect(badSamples.err.join(" ")).toContain("--samples");

    const both = capture();
    expect(
      await main(
        [
          "compare",
          "target",
          "--against",
          "other",
          "--samples",
          "3",
          "--dir",
          root,
        ],
        { io: both.io },
      ),
    ).toBe(EXIT_ENVIRONMENT);
    expect(both.err.join(" ")).toContain("只能选其一");

    const unknown = capture();
    expect(
      await main(["compare", "nope", "--dir", root], { io: unknown.io }),
    ).toBe(EXIT_ENVIRONMENT);
    expect(unknown.err.join(" ")).toContain("nope");
  });

  it("advertises compare in --help", async () => {
    const help = capture();
    expect(await main(["--help"], { io: help.io })).toBe(EXIT_OK);
    expect(help.out.join("\n")).toContain("perfstage compare <runId>");
  });
});
