import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EXIT_ENVIRONMENT,
  EXIT_GATE_FAIL,
  EXIT_INVALID_TAKE,
  EXIT_OK,
  EXIT_REGRESSION,
  exitCodeFor,
  exitCodeForRegression,
} from "../../cli/exit-codes.js";
import { main, type CliContext, type CliIO } from "../../cli/index.js";
import { createFakeDriver } from "../../device/fake.js";
import { createFakeRecorder } from "../../recording/fake.js";
import type { TraceAnalyzer } from "../../runner/execute.js";
import { listPerformanceRuns } from "../../tools/runs.js";
import { comparePerformanceRuns } from "../../tools/compare.js";
import { evaluateRegressionGate } from "../../tools/regression.js";
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
  status?: string;
  gate?: string;
  /** `false` writes an empty metrics array (e.g. an `invalid` Take). */
  withMetrics?: boolean;
  rules?: Record<
    string,
    {
      worse: "higher" | "lower";
      maxWorseningPercent?: number;
      maxWorseningAbsolute?: number;
    }
  >;
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
      status: input.status ?? "completed",
      startedAt: input.startedAt,
      endedAt: input.startedAt,
      gate: input.gate ?? "pass",
      metrics:
        input.withMetrics === false
          ? []
          : [{ name: "hitches", value: input.hitches ?? 10, unit: "次" }],
    }),
    "utf8",
  );
  await writeFile(
    join(runDir, "plan.json"),
    JSON.stringify({
      id: "scene-a",
      source: "scenario",
      device: { id: "device-1" },
      metrics: Object.entries(input.rules ?? {}).map(([name, regression]) => ({
        name,
        regression,
      })),
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

describe("perfstage gate", () => {
  it("renders a pass and matches the handler output", async () => {
    await initWorkspace();
    await seedComparisonRun({
      id: "base-1",
      startedAt: "2026-11-16T01:00:00.000Z",
      hitches: 90,
    });
    await seedComparisonRun({
      id: "base-2",
      startedAt: "2026-11-16T02:00:00.000Z",
      hitches: 100,
    });
    await seedComparisonRun({
      id: "base-3",
      startedAt: "2026-11-16T03:00:00.000Z",
      hitches: 110,
    });
    await seedComparisonRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      hitches: 110,
      rules: {
        hitches: { worse: "higher", maxWorseningPercent: 20 },
      },
    });

    const text = capture();
    expect(await main(["gate", "target", "--dir", root], { io: text.io })).toBe(
      EXIT_OK,
    );
    const rendered = text.out.join("\n");
    expect(rendered).toContain("派生基线 3 条");
    expect(rendered).toContain("regression=pass");
    expect(rendered).toContain("结论：pass");

    const json = capture();
    expect(
      await main(["gate", "target", "--dir", root, "--json"], {
        io: json.io,
      }),
    ).toBe(EXIT_OK);
    const payload = JSON.parse(json.out.join("\n")) as Record<string, unknown>;
    expect(payload).toMatchObject({
      status: "comparable",
      regression: {
        status: "pass",
        configured: 1,
        evaluated: 1,
        failed: 0,
      },
    });

    const viaHandler = await evaluateRegressionGate(
      { runId: "target" },
      {
        runStore: createRunStore(join(root, ".performance-test", "runs"), root),
        now: () => new Date(),
      },
    );
    expect(viaHandler).toEqual(payload);
  });

  it("returns exit 4 when the regression fails", async () => {
    await initWorkspace();
    await seedComparisonRun({
      id: "base-1",
      startedAt: "2026-11-16T01:00:00.000Z",
      hitches: 90,
    });
    await seedComparisonRun({
      id: "base-2",
      startedAt: "2026-11-16T02:00:00.000Z",
      hitches: 100,
    });
    await seedComparisonRun({
      id: "base-3",
      startedAt: "2026-11-16T03:00:00.000Z",
      hitches: 110,
    });
    await seedComparisonRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      hitches: 125,
      rules: {
        hitches: { worse: "higher", maxWorseningPercent: 20 },
      },
    });

    const text = capture();
    expect(await main(["gate", "target", "--dir", root], { io: text.io })).toBe(
      EXIT_REGRESSION,
    );
    const rendered = text.out.join("\n");
    expect(rendered).toContain("regression=fail");
    expect(rendered).toContain("结论：fail");
    expect(rendered).toContain("超过容差");
  });

  it("fails closed on not-evaluated and allows the explicit opt-out", async () => {
    await initWorkspace();
    for (const [id, hour] of [
      ["base-1", "01"],
      ["base-2", "02"],
      ["base-3", "03"],
    ] as const) {
      await seedComparisonRun({
        id,
        startedAt: `2026-11-16T${hour}:00:00.000Z`,
        hitches: 100,
      });
    }
    await seedComparisonRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      hitches: 110,
    });

    const strict = capture();
    expect(
      await main(["gate", "target", "--dir", root], { io: strict.io }),
    ).toBe(EXIT_REGRESSION);
    expect(strict.out.join("\n")).toContain("无法评估");
    expect(strict.out.join("\n")).toContain("no-rules");

    const relaxed = capture();
    expect(
      await main(
        ["gate", "target", "--dir", root, "--allow-not-evaluated"],
        { io: relaxed.io },
      ),
    ).toBe(EXIT_OK);
    expect(relaxed.out.join("\n")).toContain("无法评估");
  });

  it("returns exit 2 for a terminal but untrustworthy Take", async () => {
    await initWorkspace();
    await seedComparisonRun({
      id: "base-1",
      startedAt: "2026-11-16T01:00:00.000Z",
      hitches: 100,
    });
    await seedComparisonRun({
      id: "base-2",
      startedAt: "2026-11-16T02:00:00.000Z",
      hitches: 100,
    });
    await seedComparisonRun({
      id: "base-3",
      startedAt: "2026-11-16T03:00:00.000Z",
      hitches: 100,
    });
    await seedComparisonRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      hitches: 110,
      status: "failed",
      rules: {
        hitches: { worse: "higher", maxWorseningPercent: 20 },
      },
    });

    const text = capture();
    expect(await main(["gate", "target", "--dir", root], { io: text.io })).toBe(
      EXIT_INVALID_TAKE,
    );
    expect(text.out.join("\n")).toContain("target-not-completed");
  });

  it("returns exit 2 for an untrustworthy Take without numeric metrics", async () => {
    await initWorkspace();
    await seedComparisonRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      status: "invalid",
      withMetrics: false,
      rules: {
        hitches: { worse: "higher", maxWorseningPercent: 20 },
      },
    });

    const text = capture();
    expect(await main(["gate", "target", "--dir", root], { io: text.io })).toBe(
      EXIT_INVALID_TAKE,
    );
    const rendered = text.out.join("\n");
    expect(rendered).toContain("target-not-completed");
    expect(rendered).toContain("未成功完成");

    const json = capture();
    expect(
      await main(["gate", "target", "--dir", root, "--json"], { io: json.io }),
    ).toBe(EXIT_INVALID_TAKE);
    const payload = JSON.parse(json.out.join("\n")) as {
      target: { status: string };
      regression: { status: string; reason: string };
    };
    expect(payload.target.status).toBe("invalid");
    expect(payload.regression).toMatchObject({
      status: "not-evaluated",
      reason: "target-not-completed",
    });

    // `--allow-not-evaluated` must not relax an untrustworthy Take.
    const relaxed = capture();
    expect(
      await main(
        ["gate", "target", "--dir", root, "--allow-not-evaluated"],
        { io: relaxed.io },
      ),
    ).toBe(EXIT_INVALID_TAKE);
  });

  it("rejects an invalid --against for an untrustworthy Take with exit 3", async () => {
    await initWorkspace();
    await seedComparisonRun({
      id: "target",
      startedAt: "2026-11-16T04:00:00.000Z",
      status: "invalid",
      withMetrics: false,
    });

    const self = capture();
    expect(
      await main(["gate", "target", "--against", "target", "--dir", root], {
        io: self.io,
      }),
    ).toBe(EXIT_ENVIRONMENT);
    expect(self.err.join(" ")).toContain("相同");

    const missing = capture();
    expect(
      await main(["gate", "target", "--against", "nope", "--dir", root], {
        io: missing.io,
      }),
    ).toBe(EXIT_ENVIRONMENT);
    expect(missing.err.join(" ")).toContain("nope");

    const both = capture();
    expect(
      await main(
        ["gate", "target", "--against", "nope", "--samples", "3", "--dir", root],
        { io: both.io },
      ),
    ).toBe(EXIT_ENVIRONMENT);
    expect(both.err.join(" ")).toContain("只能选其一");
  });

  it("rejects invalid gate arguments with exit 3", async () => {
    await initWorkspace();

    const missing = capture();
    expect(await main(["gate", "--dir", root], { io: missing.io })).toBe(
      EXIT_ENVIRONMENT,
    );
    expect(missing.err.join(" ")).toContain("gate 需要");

    const badSamples = capture();
    expect(
      await main(["gate", "target", "--samples", "2", "--dir", root], {
        io: badSamples.io,
      }),
    ).toBe(EXIT_ENVIRONMENT);
    expect(badSamples.err.join(" ")).toContain("--samples");

    const both = capture();
    expect(
      await main(
        [
          "gate",
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
      await main(["gate", "nope", "--dir", root], { io: unknown.io }),
    ).toBe(EXIT_ENVIRONMENT);
    expect(unknown.err.join(" ")).toContain("nope");
  });

  it("maps regression verdicts onto exit codes", () => {
    expect(
      exitCodeForRegression({ takeStatus: "completed", status: "pass" }),
    ).toBe(EXIT_OK);
    expect(
      exitCodeForRegression({ takeStatus: "completed", status: "fail" }),
    ).toBe(EXIT_REGRESSION);
    expect(
      exitCodeForRegression({
        takeStatus: "completed",
        status: "not-evaluated",
      }),
    ).toBe(EXIT_REGRESSION);
    expect(
      exitCodeForRegression({
        takeStatus: "completed",
        status: "not-evaluated",
        allowNotEvaluated: true,
      }),
    ).toBe(EXIT_OK);
    expect(
      exitCodeForRegression({ takeStatus: "failed", status: "not-evaluated" }),
    ).toBe(EXIT_INVALID_TAKE);
  });

  it("advertises gate in --help", async () => {
    const help = capture();
    expect(await main(["--help"], { io: help.io })).toBe(EXIT_OK);
    expect(help.out.join("\n")).toContain("perfstage gate <runId>");
  });
});

describe("perfstage report --format", () => {
  async function completedRun(): Promise<{ runId: string; runDir: string }> {
    await initWorkspace();
    const planPath = await writePlan();
    const json = capture();
    const code = await main(
      ["run", "--plan", planPath, "--device", DEVICE_ID, "--dir", root, "--json"],
      runnerContext(
        { hitches: 10, blockMs: 40, launchMs: 300, memoryMB: 100 },
        json.io,
      ),
    );
    expect(code).toBe(EXIT_OK);
    const summary = JSON.parse(json.out.join("\n")) as {
      runId: string;
      reportPath: string;
    };
    return { runId: summary.runId, runDir: dirname(summary.reportPath) };
  }

  it("exports HTML next to report.json without touching existing reports", async () => {
    const { runId, runDir } = await completedRun();
    const jsonBefore = await readFile(join(runDir, "report.json"), "utf8");
    const markdownBefore = await readFile(join(runDir, "report.md"), "utf8");

    const out = capture();
    const code = await main(
      ["report", runId, "--format", "html", "--dir", root],
      { io: out.io },
    );

    expect(code).toBe(EXIT_OK);
    const target = join(runDir, "report.html");
    expect(out.out.join("\n")).toContain(target);
    const html = await readFile(target, "utf8");
    expect(html).toContain("性能测试报告");
    expect(html).toContain('<html lang="zh-CN">');
    expect(await readFile(join(runDir, "report.json"), "utf8")).toBe(jsonBefore);
    expect(await readFile(join(runDir, "report.md"), "utf8")).toBe(markdownBefore);
  });

  it("exports JUnit and is byte-stable across repeated exports", async () => {
    const { runId, runDir } = await completedRun();
    const out = capture();

    expect(
      await main(["report", runId, "--format", "junit", "--dir", root], {
        io: out.io,
      }),
    ).toBe(EXIT_OK);
    const target = join(runDir, "report.junit.xml");
    expect(out.out.join("\n")).toContain(target);
    const first = await readFile(target, "utf8");
    expect(first).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(first).toContain("<testsuites ");

    expect(
      await main(["report", runId, "--format", "junit", "--dir", root], {
        io: out.io,
      }),
    ).toBe(EXIT_OK);
    expect(await readFile(target, "utf8")).toBe(first);
  });

  it("is byte-stable for repeated HTML exports", async () => {
    const { runId, runDir } = await completedRun();
    const out = capture();
    expect(
      await main(["report", runId, "--format", "html", "--dir", root], {
        io: out.io,
      }),
    ).toBe(EXIT_OK);
    const target = join(runDir, "report.html");
    const first = await readFile(target, "utf8");
    expect(
      await main(["report", runId, "--format", "html", "--dir", root], {
        io: out.io,
      }),
    ).toBe(EXIT_OK);
    expect(await readFile(target, "utf8")).toBe(first);
  });

  it("fails with exit 3 and leaves no temporary file when the rename fails", async () => {
    const { runId, runDir } = await completedRun();
    const jsonBefore = await readFile(join(runDir, "report.json"), "utf8");
    // A directory at the target path makes `rename` fail deterministically.
    await mkdir(join(runDir, "report.html"));

    const out = capture();
    const code = await main(
      ["report", runId, "--format", "html", "--dir", root],
      { io: out.io },
    );

    expect(code).toBe(EXIT_ENVIRONMENT);
    expect(out.err.join(" ")).toContain("导出 report.html 失败");
    expect(await readFile(join(runDir, "report.json"), "utf8")).toBe(jsonBefore);
    const entries = await readdir(runDir);
    expect(entries.some((name) => name.startsWith(".report.html.tmp-"))).toBe(
      false,
    );
  });

  it("exports even when the gate failed, without changing the exit code", async () => {
    await initWorkspace();
    const planPath = await writePlan();
    const json = capture();
    await main(
      ["run", "--plan", planPath, "--device", DEVICE_ID, "--dir", root, "--json"],
      runnerContext(
        { hitches: 5_000, blockMs: 40, launchMs: 300, memoryMB: 100 },
        json.io,
      ),
    );
    const summary = JSON.parse(json.out.join("\n")) as {
      runId: string;
      gate: string;
      reportPath: string;
    };
    expect(summary.gate).toBe("fail");

    const out = capture();
    const code = await main(
      ["report", summary.runId, "--format", "html", "--dir", root],
      { io: out.io },
    );
    expect(code).toBe(EXIT_OK);
    const html = await readFile(join(dirname(summary.reportPath), "report.html"), "utf8");
    expect(html).toContain("fail");
  });

  it("rejects --format together with --json", async () => {
    const { runId } = await completedRun();
    const out = capture();
    const code = await main(
      ["report", runId, "--format", "html", "--json", "--dir", root],
      { io: out.io },
    );
    expect(code).toBe(EXIT_ENVIRONMENT);
    expect(out.err.join(" ")).toContain("--format");
  });

  it("rejects unknown formats", async () => {
    const { runId } = await completedRun();
    const out = capture();
    const code = await main(
      ["report", runId, "--format", "pdf", "--dir", root],
      { io: out.io },
    );
    expect(code).toBe(EXIT_ENVIRONMENT);
    expect(out.err.join(" ")).toContain("pdf");
  });

  it("fails with exit 3 when report.json is missing", async () => {
    await initWorkspace();
    const runId = "manual-run";
    const runDir = join(root, ".performance-test", "runs", runId);
    await mkdir(runDir, { recursive: true });

    const out = capture();
    const code = await main(["report", runId, "--format", "html", "--dir", root], {
      io: out.io,
    });
    expect(code).toBe(EXIT_ENVIRONMENT);
    expect(out.err.join(" ")).toContain("report.json");
    await expect(readFile(join(runDir, "report.html"), "utf8")).rejects.toThrow();
  });
});

async function seedTrendRun(input: {
  id: string;
  startedAt: string;
  deviceId?: string | null;
  osVersion?: string | null;
  status?: string;
  gate?: string;
  metrics?: Array<{ name: string; value?: unknown; unit?: string }>;
  planDevice?: { id: string; osVersion?: string };
}): Promise<void> {
  const runsDir = join(root, ".performance-test", "runs");
  const runDir = join(runsDir, input.id);
  await mkdir(runDir, { recursive: true });
  const deviceId = input.deviceId === undefined ? "device-1" : input.deviceId;
  const osVersion = input.osVersion === undefined ? "27.0.1" : input.osVersion;
  await writeFile(
    join(runDir, "run.json"),
    JSON.stringify({
      id: input.id,
      planId: "scene-a",
      ...(deviceId !== null
        ? {
            device: {
              id: deviceId,
              ...(osVersion !== null ? { osVersion } : {}),
            },
          }
        : {}),
      status: input.status ?? "completed",
      startedAt: input.startedAt,
      endedAt: input.startedAt,
      gate: input.gate ?? "pass",
      metrics: input.metrics ?? [{ name: "hitches", value: 10, unit: "次" }],
    }),
    "utf8",
  );
  await writeFile(
    join(runDir, "plan.json"),
    JSON.stringify({
      id: "scene-a",
      source: "scenario",
      ...(input.planDevice !== undefined ? { device: input.planDevice } : {}),
    }),
    "utf8",
  );
}

describe("perfstage trend", () => {
  it("advertises trend in --help", async () => {
    const help = capture();
    expect(await main(["--help"], { io: help.io })).toBe(EXIT_OK);
    expect(help.out.join("\n")).toContain("perfstage trend <sceneId>");
  });

  it("prints a text trend for the scene", async () => {
    await initWorkspace();
    await seedTrendRun({
      id: "r1",
      startedAt: "2026-11-15T00:00:00.000Z",
      metrics: [{ name: "hitches", value: 10, unit: "次" }],
    });
    await seedTrendRun({
      id: "r2",
      startedAt: "2026-11-16T00:00:00.000Z",
      metrics: [{ name: "hitches", value: 20, unit: "次" }],
    });
    await seedTrendRun({
      id: "r3",
      startedAt: "2026-11-17T00:00:00.000Z",
      metrics: [{ name: "hitches", value: 30, unit: "次" }],
    });

    const out = capture();
    const code = await main(["trend", "scene-a", "--dir", root], { io: out.io });

    expect(code).toBe(EXIT_OK);
    const text = out.out.join("\n");
    expect(text).toContain("场景：scene-a");
    expect(text).toContain("匹配 3 条，每分组最多 20 条");
    expect(text).toContain("分组：device-1 / iOS 27.0.1");
    expect(text).toContain("3 次 Take（2026-11-15 → 2026-11-17）");
    expect(text).toContain("状态：completed 3、partial 0");
    expect(text).toContain("最近 30");
    expect(text).toContain("较上次测量 +10（+50%）");
  });

  it("filters by device and trims each group with --limit", async () => {
    await initWorkspace();
    await seedTrendRun({
      id: "d1-old",
      startedAt: "2026-11-15T00:00:00.000Z",
      deviceId: "device-1",
    });
    await seedTrendRun({
      id: "d1-new",
      startedAt: "2026-11-16T00:00:00.000Z",
      deviceId: "device-1",
    });
    await seedTrendRun({
      id: "d2",
      startedAt: "2026-11-17T00:00:00.000Z",
      deviceId: "device-2",
    });

    const filtered = capture();
    expect(
      await main(["trend", "scene-a", "--device", "device-2", "--dir", root], {
        io: filtered.io,
      }),
    ).toBe(EXIT_OK);
    const onlySecond = filtered.out.join("\n");
    expect(onlySecond).toContain("分组：device-2 / iOS 27.0.1");
    expect(onlySecond).not.toContain("device-1");

    const limited = capture();
    expect(
      await main(["trend", "scene-a", "--device", "device-1", "--limit", "1", "--dir", root], {
        io: limited.io,
      }),
    ).toBe(EXIT_OK);
    expect(limited.out.join("\n")).toContain("1 次 Take");
  });

  it("falls back to plan.json for legacy device and iOS facts", async () => {
    await initWorkspace();
    await seedTrendRun({
      id: "legacy",
      startedAt: "2026-11-16T00:00:00.000Z",
      deviceId: null,
      planDevice: { id: "legacy-device", osVersion: "26.4" },
    });

    const out = capture();
    expect(await main(["trend", "scene-a", "--dir", root], { io: out.io })).toBe(
      EXIT_OK,
    );
    expect(out.out.join("\n")).toContain("分组：legacy-device / iOS 26.4");
  });

  it("counts excluded terminal states without drawing them", async () => {
    await initWorkspace();
    await seedTrendRun({ id: "ok", startedAt: "2026-11-16T00:00:00.000Z" });
    await seedTrendRun({
      id: "failed",
      startedAt: "2026-11-16T01:00:00.000Z",
      status: "failed",
    });
    await seedTrendRun({
      id: "invalid",
      startedAt: "2026-11-16T02:00:00.000Z",
      status: "invalid",
    });

    const out = capture();
    expect(await main(["trend", "scene-a", "--dir", root], { io: out.io })).toBe(
      EXIT_OK,
    );
    const text = out.out.join("\n");
    expect(text).toContain("1 次 Take");
    expect(text).toContain("排除（当前筛选）：invalid 1、failed 1、cancelled 0、不可读 0");
  });

  it("writes an offline trends/<scene>.html and is byte-stable", async () => {
    await initWorkspace();
    await seedTrendRun({
      id: "r1",
      startedAt: "2026-11-16T00:00:00.000Z",
      metrics: [{ name: "hitches", value: 10, unit: "次" }],
    });
    await seedTrendRun({
      id: "r2",
      startedAt: "2026-11-17T00:00:00.000Z",
      metrics: [{ name: "hitches", value: 12, unit: "次" }],
    });
    const runJson = await readFile(
      join(root, ".performance-test", "runs", "r1", "run.json"),
      "utf8",
    );

    const out = capture();
    expect(
      await main(["trend", "scene-a", "--format", "html", "--dir", root], {
        io: out.io,
      }),
    ).toBe(EXIT_OK);

    const target = join(root, ".performance-test", "trends", "scene-a.html");
    expect(out.out.join("\n")).toContain(target);
    const first = await readFile(target, "utf8");
    expect(first).toContain("性能趋势");
    expect(first).toContain("<svg ");
    expect(first).not.toMatch(/https?:\/\//);
    expect(first).not.toContain("<script");
    expect(
      await readFile(join(root, ".performance-test", "runs", "r1", "run.json"), "utf8"),
    ).toBe(runJson);

    expect(
      await main(["trend", "scene-a", "--format", "html", "--dir", root], {
        io: out.io,
      }),
    ).toBe(EXIT_OK);
    expect(await readFile(target, "utf8")).toBe(first);
  });

  it("writes trends under the workspace data root when runs live elsewhere", async () => {
    await initWorkspace();
    const configPath = join(root, ".performance-test", "config.json");
    const config = JSON.parse(
      await readFile(configPath, "utf8"),
    ) as Record<string, unknown>;
    await writeFile(
      configPath,
      JSON.stringify({
        ...config,
        runsDirectory: ".performance-test/data/runs",
      }),
      "utf8",
    );
    await mkdir(join(root, ".performance-test", "data", "runs"), {
      recursive: true,
    });

    const out = capture();
    expect(
      await main(["trend", "scene-a", "--format", "html", "--dir", root], {
        io: out.io,
      }),
    ).toBe(EXIT_OK);

    const target = join(root, ".performance-test", "trends", "scene-a.html");
    expect(out.out.join("\n")).toContain(target);
    expect(await readFile(target, "utf8")).toContain("性能趋势");
    await expect(
      readFile(
        join(root, ".performance-test", "data", "trends", "scene-a.html"),
        "utf8",
      ),
    ).rejects.toThrow();
  });

  it("keeps exit 0 when the newest Take failed its gate", async () => {
    await initWorkspace();
    await seedTrendRun({
      id: "r1",
      startedAt: "2026-11-16T00:00:00.000Z",
      gate: "fail",
      metrics: [{ name: "hitches", value: 9000, unit: "次" }],
    });

    const out = capture();
    expect(await main(["trend", "scene-a", "--dir", root], { io: out.io })).toBe(
      EXIT_OK,
    );
    expect(out.out.join("\n")).toContain("最近 9000");
  });

  it("reports no data instead of failing on an empty scene", async () => {
    await initWorkspace();

    const out = capture();
    expect(await main(["trend", "scene-a", "--dir", root], { io: out.io })).toBe(
      EXIT_OK,
    );
    expect(out.out.join("\n")).toContain("没有可用于趋势的运行。");
  });

  it("rejects an unsafe scene id", async () => {
    await initWorkspace();

    const out = capture();
    const code = await main(
      ["trend", "../evil", "--format", "html", "--dir", root],
      { io: out.io },
    );
    expect(code).toBe(EXIT_ENVIRONMENT);
    expect(out.err.join(" ")).toContain("不能用作文件名");
    await expect(
      readFile(join(root, ".performance-test", "evil.html"), "utf8"),
    ).rejects.toThrow();
  });

  it("rejects unsupported formats, --json and bad limits", async () => {
    await initWorkspace();

    const junit = capture();
    expect(
      await main(["trend", "scene-a", "--format", "junit", "--dir", root], {
        io: junit.io,
      }),
    ).toBe(EXIT_ENVIRONMENT);
    expect(junit.err.join(" ")).toContain("junit");

    const json = capture();
    expect(
      await main(["trend", "scene-a", "--json", "--dir", root], { io: json.io }),
    ).toBe(EXIT_ENVIRONMENT);
    expect(json.err.join(" ")).toContain("--json");

    const limit = capture();
    expect(
      await main(["trend", "scene-a", "--limit", "0", "--dir", root], {
        io: limit.io,
      }),
    ).toBe(EXIT_ENVIRONMENT);
    expect(limit.err.join(" ")).toContain("--limit");

    const emptyDevice = capture();
    expect(
      await main(["trend", "scene-a", "--device", "", "--dir", root], {
        io: emptyDevice.io,
      }),
    ).toBe(EXIT_ENVIRONMENT);
    expect(emptyDevice.err.join(" ")).toContain("--device");
  });

  it("refuses to write through a symlinked trends directory", async () => {
    await initWorkspace();
    await seedTrendRun({ id: "r1", startedAt: "2026-11-16T00:00:00.000Z" });

    const outside = await mkdtemp(join(tmpdir(), "perfstage-trends-outside-"));
    try {
      await symlink(outside, join(root, ".performance-test", "trends"));

      const out = capture();
      const code = await main(
        ["trend", "scene-a", "--format", "html", "--dir", root],
        { io: out.io },
      );
      expect(code).toBe(EXIT_ENVIRONMENT);
      expect(out.err.join(" ")).toContain("趋势目录");
      expect(await readdir(outside)).toHaveLength(0);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
