import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestToolHarness,
  isToolError,
  type PreparePerformanceTestResult,
  type TestToolHarness,
} from "../support/tool-harness.js";
import { finalizeRun } from "../../runner/finalize.js";
import type { DiagnosticInput } from "../../diagnostics/normalize.js";
import type { TestPlan } from "../../model/test-plan.js";
import type { ActionRecord, MetricResult } from "../../model/test-run.js";

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

const CLEAN_DIAGNOSTICS: DiagnosticInput = {
  logText: "everything is fine",
  crashIdsBefore: ["pre-existing"],
  crashIdsAfter: ["pre-existing"],
  lifecycle: [{ kind: "foreground", occurredAt: "2026-11-13T00:00:10.000Z" }],
};

const EXECUTED_ACTION = {
  actionId: "scroll-up-1",
  outcome: "executed" as const,
  attempts: 1,
  startedAt: "2026-11-13T00:00:10.000Z",
  endedAt: "2026-11-13T00:00:11.500Z",
  durationMs: 1500,
};

const COMPLETE_METRICS: MetricResult[] = [
  { name: "hitches", value: 1, verdict: "pass", tracePath: "traces/hitches.trace" },
  { name: "cpu", value: 20, unit: "%", verdict: "pass", tracePath: "traces/cpu.trace" },
  { name: "memory", value: 180, unit: "MB", verdict: "pass", tracePath: "traces/memory.trace" },
];

async function prepare(
  h: TestToolHarness,
): Promise<{ runId: string; plan: TestPlan }> {
  const prepared = await h.call<PreparePerformanceTestResult>(
    "prepare_performance_test",
    {
      scenarioId: "community-home-scroll",
      device: { id: "device-1", name: "Ra iPhone" },
    },
  );
  if (isToolError(prepared)) throw new Error(prepared.error);
  const plan = JSON.parse(
    await readFile(join(h.root, "runs", prepared.runId, "plan.json"), "utf8"),
  ) as TestPlan;
  return { runId: prepared.runId, plan };
}

function deps(h: TestToolHarness) {
  return { runStore: h.runStore, now: () => new Date(Date.now() + 1000) };
}

describe("finalizeRun", () => {
  it("completes a clean Take with gate=pass", async () => {
    if (!harness) throw new Error("harness not initialized");
    const { runId, plan } = await prepare(harness);

    const outcome = await finalizeRun(
      {
        runId,
        requestedStatus: "completed",
        plan,
        actions: [EXECUTED_ACTION as ActionRecord],
        metrics: COMPLETE_METRICS,
        diagnostics: CLEAN_DIAGNOSTICS,
      },
      deps(harness),
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.result.status).toBe("completed");
    expect(outcome.result.gate).toBe("pass");
    expect(outcome.result.findings).toEqual([]);
  });

  it("persists gate on run.json and report.json", async () => {
    if (!harness) throw new Error("harness not initialized");
    const { runId, plan } = await prepare(harness);

    const outcome = await finalizeRun(
      {
        runId,
        requestedStatus: "completed",
        plan,
        actions: [EXECUTED_ACTION as ActionRecord],
        metrics: COMPLETE_METRICS,
        diagnostics: CLEAN_DIAGNOSTICS,
      },
      deps(harness),
    );
    expect(outcome.kind).toBe("ok");

    const run = JSON.parse(
      await readFile(join(harness.root, "runs", runId, "run.json"), "utf8"),
    );
    expect(run.status).toBe("completed");
    expect(run.gate).toBe("pass");

    const report = JSON.parse(
      await readFile(join(harness.root, "runs", runId, "report.json"), "utf8"),
    );
    expect(report.status).toBe("completed");
    expect(report.gate).toBe("pass");
  });

  it("keeps status completed and sets gate=fail on a threshold miss (D6)", async () => {
    if (!harness) throw new Error("harness not initialized");
    const { runId, plan } = await prepare(harness);

    const metrics: MetricResult[] = [
      {
        name: "hitches",
        value: 7,
        threshold: { warn: 3, fail: 5 },
        tracePath: "traces/hitches.trace",
      },
      ...COMPLETE_METRICS.slice(1),
    ];

    const outcome = await finalizeRun(
      {
        runId,
        requestedStatus: "completed",
        plan,
        actions: [EXECUTED_ACTION as ActionRecord],
        metrics,
        diagnostics: CLEAN_DIAGNOSTICS,
      },
      deps(harness),
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.result.status).toBe("completed");
    expect(outcome.result.gate).toBe("fail");
    expect(
      outcome.result.findings.some((finding) => finding.code === "metric:hitches"),
    ).toBe(true);

    const persisted = JSON.parse(
      await readFile(join(harness.root, "runs", runId, "run.json"), "utf8"),
    );
    const hitches = persisted.metrics.find(
      (metric: { name: string }) => metric.name === "hitches",
    );
    expect(hitches.verdict).toBe("fail");
  });

  it("returns partial/unknown when an instrument-backed metric has no trace", async () => {
    if (!harness) throw new Error("harness not initialized");
    const { runId, plan } = await prepare(harness);

    const metrics = COMPLETE_METRICS.map((metric) =>
      metric.name === "hitches"
        ? { name: "hitches", value: 1, verdict: "pass" as const }
        : metric,
    );

    const outcome = await finalizeRun(
      {
        runId,
        requestedStatus: "completed",
        plan,
        actions: [EXECUTED_ACTION as ActionRecord],
        metrics,
        diagnostics: CLEAN_DIAGNOSTICS,
      },
      deps(harness),
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.result.status).toBe("partial");
    expect(outcome.result.gate).toBe("unknown");
    expect(outcome.result.evidenceGaps.map((gap) => gap.code)).toContain(
      "trace:hitches",
    );
  });

  it("fails the Take when an action ultimately failed", async () => {
    if (!harness) throw new Error("harness not initialized");
    const { runId, plan } = await prepare(harness);

    const failedAction: ActionRecord = {
      ...EXECUTED_ACTION,
      outcome: "failed",
      error: "device disconnected",
    };

    const outcome = await finalizeRun(
      {
        runId,
        requestedStatus: "completed",
        plan,
        actions: [failedAction],
        metrics: COMPLETE_METRICS,
        diagnostics: CLEAN_DIAGNOSTICS,
      },
      deps(harness),
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.result.status).toBe("failed");
    expect(outcome.result.gate).toBe("unknown");
  });

  it("renders the gate in report.md", async () => {
    if (!harness) throw new Error("harness not initialized");
    const { runId, plan } = await prepare(harness);

    const outcome = await finalizeRun(
      {
        runId,
        requestedStatus: "completed",
        plan,
        actions: [EXECUTED_ACTION as ActionRecord],
        metrics: COMPLETE_METRICS,
        diagnostics: CLEAN_DIAGNOSTICS,
      },
      deps(harness),
    );
    expect(outcome.kind).toBe("ok");

    const markdown = await readFile(
      join(harness.root, "runs", runId, "report.md"),
      "utf8",
    );
    expect(markdown).toContain("**门禁结果**：`pass`");
  });
});
