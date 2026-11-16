import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listPerformanceRuns, runsQuerySchema } from "../../tools/runs.js";
import type { TestRun } from "../../model/test-run.js";
import type { RunIndexEntry } from "../../storage/runs.js";
import {
  createTestToolHarness,
  type TestToolHarness,
} from "../support/tool-harness.js";

let harness: TestToolHarness | null = null;

beforeEach(async () => {
  harness = await createTestToolHarness();
});

afterEach(async () => {
  if (harness) {
    await harness.cleanup();
    harness = null;
  }
});

interface SeedOptions {
  id: string;
  planId?: string;
  status?: TestRun["status"];
  startedAt?: string;
  gate?: "pass" | "warn" | "fail" | "unknown";
  passes?: TestRun["passes"];
  plan?: Record<string, unknown> | false;
}

async function seedRun(
  input: SeedOptions,
): Promise<void> {
  if (!harness) throw new Error("harness not initialized");
  const status = input.status ?? "completed";
  await harness.runStore.create({
    id: input.id,
    planId: input.planId ?? "community-home-scroll",
    status,
    startedAt: input.startedAt ?? "2026-11-16T00:00:00.000Z",
    endedAt: "2026-11-16T00:01:00.000Z",
    durationMs: 60_000,
    repetitions: 1,
    currentRepetition: 0,
    ...(input.gate !== undefined ? { gate: input.gate } : {}),
    actions: [],
    metrics: [
      { name: "hitches", value: 12, unit: "次", verdict: "pass" },
    ],
    ...(input.passes !== undefined ? { passes: input.passes } : {}),
    evidence: { screenshotPaths: [], traceArchivePaths: [] },
    lifecycle: [],
  });
  if (input.plan !== false) {
    await harness.runStore.writeText(
      input.id,
      "plan.json",
      JSON.stringify(
        input.plan ?? {
          id: input.planId ?? "community-home-scroll",
          source: "scenario",
          device: { id: "device-1" },
        },
      ),
    );
  }
}

function query(input: Record<string, unknown> = {}) {
  if (!harness) throw new Error("harness not initialized");
  return listPerformanceRuns(input, {
    runStore: harness.runStore,
    now: () => new Date(),
  });
}

describe("listPerformanceRuns", () => {
  it("rebuilds a workspace that has no index at all", async () => {
    await seedRun({ id: "run-a", startedAt: "2026-11-16T00:00:00.000Z" });
    await seedRun({
      id: "run-b",
      planId: "adhoc-plan",
      startedAt: "2026-11-16T02:00:00.000Z",
      plan: { id: "adhoc-plan", source: "ad_hoc", device: { id: "device-2" } },
    });

    const result = await query();
    if ("error" in result) throw new Error(result.error);
    expect(result.unindexed).toBe(2);
    expect(result.invalidLines).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.runs.map((run) => run.runId)).toEqual(["run-b", "run-a"]);
    // Legacy runs have no passes: report "not recorded", never 0.
    expect(result.runs[0]?.passCount).toBeNull();
    expect(result.runs[1]?.scenarioId).toBe("community-home-scroll");
    expect(result.runs[0]?.scenarioId).toBeNull();
    expect(result.runs[0]?.deviceId).toBe("device-2");
  });

  it("lists a run whose plan.json is missing", async () => {
    await seedRun({ id: "run-a", plan: false });

    const result = await query();
    if ("error" in result) throw new Error(result.error);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.scenarioId).toBeNull();
    expect(result.runs[0]?.deviceId).toBeNull();
    expect(result.unindexed).toBe(1);
  });

  it("reads indexed rows and reports persisted pass counts", async () => {
    await seedRun({
      id: "run-a",
      passes: [
        {
          template: "hitches",
          tracePath: "traces/hitches.trace",
          attempts: 1,
          durationMs: 1000,
          metrics: ["hitches"],
          errorCount: 0,
          warningCount: 0,
        },
      ],
    });
    const entry: RunIndexEntry = {
      v: 1,
      runId: "run-a",
      planId: "community-home-scroll",
      scenarioId: "community-home-scroll",
      deviceId: "device-1",
      status: "completed",
      gate: "pass",
      startedAt: "2026-11-16T00:00:00.000Z",
      endedAt: "2026-11-16T00:01:00.000Z",
      durationMs: 60_000,
      passCount: 1,
      metrics: [{ name: "hitches", value: 12, unit: "次", verdict: "pass" }],
    };
    await harness?.runStore.appendIndex(entry);

    const result = await query();
    if ("error" in result) throw new Error(result.error);
    expect(result.unindexed).toBe(0);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.passCount).toBe(1);
    expect(result.runs[0]?.metrics).toEqual([
      { name: "hitches", value: 12, unit: "次", verdict: "pass" },
    ]);
  });

  it("tolerates corrupt lines, ghost rows and incomplete run directories", async () => {
    await seedRun({ id: "run-a" });
    await seedRun({ id: "run-b", startedAt: "2026-11-16T01:00:00.000Z" });
    await seedRun({ id: "run-prepared", status: "prepared" });
    await mkdir(join(harness?.runsDir ?? "", "run-no-run-json"), {
      recursive: true,
    });

    await harness?.runStore.appendIndex({
      v: 1,
      runId: "run-a",
      planId: "community-home-scroll",
      scenarioId: "community-home-scroll",
      deviceId: "device-1",
      status: "completed",
      gate: "pass",
      startedAt: "2026-11-16T00:00:00.000Z",
      endedAt: "2026-11-16T00:01:00.000Z",
      passCount: null,
      metrics: [],
    });
    await harness?.runStore.appendIndex({
      v: 1,
      runId: "deleted-run",
      planId: "gone",
      scenarioId: "gone",
      deviceId: "device-1",
      status: "completed",
      startedAt: "2026-11-16T03:00:00.000Z",
      endedAt: "2026-11-16T03:01:00.000Z",
      passCount: null,
      metrics: [],
    });
    const indexPath = join(harness?.runsDir ?? "", "index.jsonl");
    const existing = await readFile(indexPath, "utf8");
    await writeFile(indexPath, `${existing}{"truncated":`, "utf8");

    const result = await query();
    if ("error" in result) throw new Error(result.error);
    expect(result.runs.map((run) => run.runId)).toEqual(["run-b", "run-a"]);
    expect(result.unindexed).toBe(1);
    expect(result.invalidLines).toBe(1);
    // ghost row + prepared run + directory without run.json
    expect(result.skipped).toBe(3);
  });

  it("filters by scenario or plan, by status, and applies the limit", async () => {
    await seedRun({
      id: "run-a",
      startedAt: "2026-11-16T00:00:00.000Z",
      gate: "pass",
    });
    await seedRun({
      id: "run-b",
      startedAt: "2026-11-16T01:00:00.000Z",
      gate: "fail",
      status: "invalid",
    });
    await seedRun({
      id: "run-c",
      planId: "adhoc-plan",
      startedAt: "2026-11-16T02:00:00.000Z",
      plan: { id: "adhoc-plan", source: "ad_hoc", device: { id: "device-2" } },
    });

    const byScenario = await query({ scenarioId: "community-home-scroll" });
    if ("error" in byScenario) throw new Error(byScenario.error);
    expect(byScenario.runs.map((run) => run.runId)).toEqual([
      "run-b",
      "run-a",
    ]);

    const byPlan = await query({ scenarioId: "adhoc-plan" });
    if ("error" in byPlan) throw new Error(byPlan.error);
    expect(byPlan.runs.map((run) => run.runId)).toEqual(["run-c"]);

    const byStatus = await query({ status: "invalid" });
    if ("error" in byStatus) throw new Error(byStatus.error);
    expect(byStatus.runs.map((run) => run.runId)).toEqual(["run-b"]);

    const limited = await query({ limit: 1 });
    if ("error" in limited) throw new Error(limited.error);
    expect(limited.runs.map((run) => run.runId)).toEqual(["run-c"]);
  });

  it("rejects invalid query values and defaults the limit to 20", async () => {
    expect(runsQuerySchema.parse({}).limit).toBe(20);
    const zero = await query({ limit: 0 });
    expect("error" in zero).toBe(true);
    const tooMany = await query({ limit: 201 });
    expect("error" in tooMany).toBe(true);
    const badStatus = await query({ status: "unknown-status" });
    expect("error" in badStatus).toBe(true);
  });

  it("deduplicates repeated index rows for the same run", async () => {
    await seedRun({ id: "run-a" });
    const entry: RunIndexEntry = {
      v: 1,
      runId: "run-a",
      planId: "community-home-scroll",
      scenarioId: "community-home-scroll",
      deviceId: "device-1",
      status: "completed",
      gate: "pass",
      startedAt: "2026-11-16T00:00:00.000Z",
      endedAt: "2026-11-16T00:01:00.000Z",
      passCount: null,
      metrics: [],
    };
    await harness?.runStore.appendIndex(entry);
    await harness?.runStore.appendIndex(entry);

    const result = await query();
    if ("error" in result) throw new Error(result.error);
    expect(result.runs).toHaveLength(1);
    expect(result.unindexed).toBe(0);
  });

  it("never modifies run artifacts or the index while querying", async () => {
    await seedRun({ id: "run-a" });
    const runsDir = harness?.runsDir ?? "";
    // Hash every file (name + bytes) so a rewrite with identical length would
    // still fail the snapshot comparison.
    const snapshot = async (): Promise<string> => {
      const lines: string[] = [];
      const walk = async (dir: string, prefix: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const name =
            prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
          if (entry.isDirectory()) {
            await walk(join(dir, entry.name), name);
          } else {
            const digest = createHash("sha256")
              .update(await readFile(join(dir, entry.name)))
              .digest("hex");
            lines.push(`${name}:${digest}`);
          }
        }
      };
      await walk(runsDir, "");
      return lines.sort().join("\n");
    };

    const before = await snapshot();
    await query();
    await query({ scenarioId: "community-home-scroll" });
    expect(await snapshot()).toBe(before);
  });
});
