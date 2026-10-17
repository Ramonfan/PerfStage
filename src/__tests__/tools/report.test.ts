import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestToolHarness,
  isToolError,
  type FinalizePerformanceTestResult,
  type PreparePerformanceTestResult,
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

async function prepareCommunity(
  harnessRef: TestToolHarness,
): Promise<PreparePerformanceTestResult> {
  const result = await harnessRef.call<PreparePerformanceTestResult>(
    "prepare_performance_test",
    {
      scenarioId: "community-home-scroll",
      device: { id: "device-1", name: "Ra iPhone" },
    },
  );
  if (isToolError(result)) throw new Error(result.error);
  return result;
}

describe("finalize_performance_test", () => {
  it("completes a clean run and writes report.json and report.md", async () => {
    if (!harness) throw new Error("harness not initialized");
    const prepared = await prepareCommunity(harness);
    const result = await harness.call<FinalizePerformanceTestResult>(
      "finalize_performance_test",
      {
        runId: prepared.runId,
        requestedStatus: "completed",
        actions: [
          {
            actionId: "scroll-up-1",
            outcome: "executed",
            attempts: 1,
            startedAt: "2026-10-17T00:00:10.000Z",
            endedAt: "2026-10-17T00:00:11.500Z",
            durationMs: 1500,
          },
          {
            actionId: "scroll-down-1",
            outcome: "executed",
            attempts: 1,
            startedAt: "2026-10-17T00:00:13.000Z",
            endedAt: "2026-10-17T00:00:14.500Z",
            durationMs: 1500,
          },
        ],
        metrics: [
          { name: "hitches", value: 2, verdict: "pass" },
          { name: "cpu", value: 35, unit: "%", verdict: "pass" },
          { name: "memory", value: 187, unit: "MB", verdict: "pass" },
        ],
        diagnostics: {
          crashIdsBefore: [],
          crashIdsAfter: [],
        },
        notes: "no issues",
      },
    );
    if (isToolError(result)) throw new Error(result.error);
    expect(result.status).toBe("completed");
    expect(result.jsonPath).toBe("report.json");
    expect(result.markdownPath).toBe("report.md");
    expect(result.runPath).toBe("run.json");
    const json = JSON.parse(
      await readFile(
        join(harness.root, "runs", prepared.runId, "report.json"),
        "utf8",
      ),
    );
    expect(json.status).toBe("completed");
    expect(json.metrics.find((m: { name: string }) => m.name === "hitches").verdict).toBe("pass");
    const md = await readFile(
      join(harness.root, "runs", prepared.runId, "report.md"),
      "utf8",
    );
    expect(md).toContain("# 性能测试报告");
    expect(md).toContain("## 总结");
  });

  it("downgrades a requested completed result when diagnostics contain a new Crash", async () => {
    if (!harness) throw new Error("harness not initialized");
    const prepared = await prepareCommunity(harness);
    const result = await harness.call<FinalizePerformanceTestResult>(
      "finalize_performance_test",
      {
        runId: prepared.runId,
        requestedStatus: "completed",
        actions: [
          {
            actionId: "scroll-up-1",
            outcome: "executed",
            attempts: 1,
            startedAt: "2026-10-17T00:00:10.000Z",
            endedAt: "2026-10-17T00:00:11.500Z",
          },
        ],
        metrics: [{ name: "hitches", value: 0, verdict: "pass" }],
        diagnostics: {
          crashIdsBefore: [],
          crashIdsAfter: ["crash-1"],
          crashReports: [
            {
              id: "crash-1",
              exceptionType: "EXC_BAD_ACCESS",
              process: "com.nndev.im",
            },
          ],
        },
      },
    );
    if (isToolError(result)) throw new Error(result.error);
    expect(result.status).toBe("failed");
    expect(result.findings.some((f) => /crash/i.test(f.message))).toBe(true);
    const json = JSON.parse(
      await readFile(
        join(harness.root, "runs", prepared.runId, "report.json"),
        "utf8",
      ),
    );
    expect(json.status).toBe("failed");
  });

  it("returns a structured error for a missing runId", async () => {
    if (!harness) throw new Error("harness not initialized");
    const result = await harness.call("finalize_performance_test", {
      runId: "ghost",
      requestedStatus: "completed",
      actions: [],
      metrics: [],
      diagnostics: {},
    });
    expect(isToolError(result)).toBe(true);
    expect((result as { error: string }).error).toMatch(/run/i);
  });

  it("refuses to overwrite a run that has already reached a terminal status", async () => {
    if (!harness) throw new Error("harness not initialized");
    const prepared = await prepareCommunity(harness);
    // Run finalize once to reach a terminal status.
    const first = await harness.call<FinalizePerformanceTestResult>(
      "finalize_performance_test",
      {
        runId: prepared.runId,
        requestedStatus: "completed",
        actions: [
          {
            actionId: "scroll-up-1",
            outcome: "executed",
            attempts: 1,
            startedAt: "2026-10-17T00:00:10.000Z",
            endedAt: "2026-10-17T00:00:11.500Z",
          },
        ],
        metrics: [{ name: "hitches", value: 0, verdict: "pass" }],
        diagnostics: { crashIdsBefore: [], crashIdsAfter: [] },
      },
    );
    if (isToolError(first)) throw new Error(first.error);
    // Capture report.md so we can confirm it's unchanged after the second attempt.
    const mdPath = join(harness.root, "runs", prepared.runId, "report.md");
    const original = await readFile(mdPath, "utf8");
    const second = await harness.call("finalize_performance_test", {
      runId: prepared.runId,
      requestedStatus: "completed",
      actions: [
        {
          actionId: "scroll-down-1",
          outcome: "failed",
          attempts: 1,
          startedAt: "2026-10-17T00:00:13.000Z",
          endedAt: "2026-10-17T00:00:14.000Z",
          error: "device disconnected",
        },
      ],
      metrics: [{ name: "hitches", value: 99, verdict: "fail" }],
      diagnostics: {
        crashIdsBefore: [],
        crashIdsAfter: ["crash-1"],
        crashReports: [{ id: "crash-1" }],
      },
    });
    expect(isToolError(second)).toBe(true);
    expect((second as { error: string }).error).toMatch(/terminal|already/i);
    const after = await readFile(mdPath, "utf8");
    expect(after).toBe(original);
  });

  it("copies supplied evidence paths into the run directory", async () => {
    if (!harness) throw new Error("harness not initialized");
    const prepared = await prepareCommunity(harness);
    // Provide an evidence file from outside the run directory.
    const evidenceDir = join(harness.root, "evidence-source");
    await mkdir(evidenceDir, { recursive: true });
    const sourceLog = join(evidenceDir, "device.log");
    await writeFile(sourceLog, "all good\n", "utf8");
    const result = await harness.call<FinalizePerformanceTestResult>(
      "finalize_performance_test",
      {
        runId: prepared.runId,
        requestedStatus: "completed",
        actions: [
          {
            actionId: "scroll-up-1",
            outcome: "executed",
            attempts: 1,
            startedAt: "2026-10-17T00:00:10.000Z",
            endedAt: "2026-10-17T00:00:11.500Z",
          },
        ],
        metrics: [],
        diagnostics: { crashIdsBefore: [], crashIdsAfter: [] },
        evidencePaths: [
          {
            kind: "deviceLog",
            sourcePath: sourceLog,
            relativePath: "logs/device.log",
          },
        ],
      },
    );
    if (isToolError(result)) throw new Error(result.error);
    expect(result.evidencePaths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "deviceLog" }),
      ]),
    );
    const copied = await readFile(
      join(harness.root, "runs", prepared.runId, "logs", "device.log"),
      "utf8",
    );
    expect(copied).toBe("all good\n");
  });

  it("returns partial when diagnostics are unavailable but requested as completed", async () => {
    if (!harness) throw new Error("harness not initialized");
    const prepared = await prepareCommunity(harness);
    const result = await harness.call<FinalizePerformanceTestResult>(
      "finalize_performance_test",
      {
        runId: prepared.runId,
        requestedStatus: "completed",
        actions: [
          {
            actionId: "scroll-up-1",
            outcome: "executed",
            attempts: 1,
            startedAt: "2026-10-17T00:00:10.000Z",
            endedAt: "2026-10-17T00:00:11.500Z",
          },
        ],
        metrics: [],
        diagnostics: { crashQueryError: "device disconnected" },
      },
    );
    if (isToolError(result)) throw new Error(result.error);
    expect(result.status).toBe("partial");
  });

  it("includes a concise summary string in the response", async () => {
    if (!harness) throw new Error("harness not initialized");
    const prepared = await prepareCommunity(harness);
    const result = await harness.call<FinalizePerformanceTestResult>(
      "finalize_performance_test",
      {
        runId: prepared.runId,
        requestedStatus: "completed",
        actions: [
          {
            actionId: "scroll-up-1",
            outcome: "executed",
            attempts: 1,
            startedAt: "2026-10-17T00:00:10.000Z",
            endedAt: "2026-10-17T00:00:11.500Z",
          },
        ],
        metrics: [
          { name: "hitches", value: 0, verdict: "pass" },
          { name: "cpu", value: 25, unit: "%", verdict: "pass" },
          { name: "memory", value: 187, unit: "MB", verdict: "pass" },
        ],
        diagnostics: { crashIdsBefore: [], crashIdsAfter: [] },
      },
    );
    if (isToolError(result)) throw new Error(result.error);
    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.summary).toContain(prepared.runId);
    expect(result.summary).toContain("completed");
  });

  it("stores evidence as run-relative paths and does not leak absolute diagnostics.logPath", async () => {
    if (!harness) throw new Error("harness not initialized");
    const prepared = await prepareCommunity(harness);
    const externalDir = join(harness.root, "external-evidence");
    await mkdir(externalDir, { recursive: true });
    const externalLog = join(externalDir, "device.log");
    await writeFile(externalLog, "noise\n", "utf8");
    const result = await harness.call<FinalizePerformanceTestResult>(
      "finalize_performance_test",
      {
        runId: prepared.runId,
        requestedStatus: "completed",
        actions: [
          {
            actionId: "scroll-up-1",
            outcome: "executed",
            attempts: 1,
            startedAt: "2026-10-17T00:00:10.000Z",
            endedAt: "2026-10-17T00:00:11.500Z",
          },
        ],
        metrics: [],
        diagnostics: {
          crashIdsBefore: [],
          crashIdsAfter: [],
          logPath: "/should/not/leak/absolute.log",
        },
        evidencePaths: [
          {
            kind: "deviceLog",
            sourcePath: externalLog,
            relativePath: "logs/device.log",
          },
        ],
      },
    );
    if (isToolError(result)) throw new Error(result.error);
    const finalRun = JSON.parse(
      await readFile(
        join(harness.root, "runs", prepared.runId, "run.json"),
        "utf8",
      ),
    ) as { evidence: { deviceLogPath?: string } };
    expect(finalRun.evidence.deviceLogPath).toBe("logs/device.log");
    expect(finalRun.evidence.deviceLogPath?.startsWith("/")).toBe(false);
    const jsonReport = JSON.parse(
      await readFile(
        join(harness.root, "runs", prepared.runId, "report.json"),
        "utf8",
      ),
    );
    const dlRefs = JSON.stringify(jsonReport.evidencePaths);
    expect(dlRefs).not.toContain("/should/not/leak");
  });

  it("refuses concurrent finalize calls: only one can persist state", async () => {
    if (!harness) throw new Error("harness not initialized");
    const prepared = await prepareCommunity(harness);
    // Spawn two finalize calls in parallel. At most one may succeed; if
    // both succeed, the lock failed.
    const [first, second] = await Promise.all([
      harness.call<FinalizePerformanceTestResult>("finalize_performance_test", {
        runId: prepared.runId,
        requestedStatus: "completed",
        actions: [
          {
            actionId: "scroll-up-1",
            outcome: "executed",
            attempts: 1,
            startedAt: "2026-10-17T00:00:10.000Z",
            endedAt: "2026-10-17T00:00:11.500Z",
          },
        ],
        metrics: [{ name: "hitches", value: 0, verdict: "pass" }],
        diagnostics: { crashIdsBefore: [], crashIdsAfter: [] },
      }),
      harness.call("finalize_performance_test", {
        runId: prepared.runId,
        requestedStatus: "completed",
        actions: [
          {
            actionId: "scroll-up-1",
            outcome: "executed",
            attempts: 1,
            startedAt: "2026-10-17T00:00:10.000Z",
            endedAt: "2026-10-17T00:00:11.500Z",
          },
        ],
        metrics: [{ name: "hitches", value: 0, verdict: "pass" }],
        diagnostics: { crashIdsBefore: [], crashIdsAfter: [] },
      }),
    ]);
    const successes = [first, second].filter((r) => !isToolError(r));
    const errors = [first, second].filter(isToolError);
    // Exactly one must win; the other must surface a structured error.
    expect(successes).toHaveLength(1);
    expect(errors).toHaveLength(1);
    const errorMessage = (errors[0] as { error: string }).error;
    expect(errorMessage).toMatch(/concurrent|terminal|already/i);
  });

  it("includes findings for metric failures and missing evidence with severity and code", async () => {
    if (!harness) throw new Error("harness not initialized");
    const prepared = await prepareCommunity(harness);
    const result = await harness.call<FinalizePerformanceTestResult>(
      "finalize_performance_test",
      {
        runId: prepared.runId,
        requestedStatus: "completed",
        actions: [
          {
            actionId: "scroll-up-1",
            outcome: "executed",
            attempts: 1,
            startedAt: "2026-10-17T00:00:10.000Z",
            endedAt: "2026-10-17T00:00:11.500Z",
          },
        ],
        // Only hitches is provided; cpu/memory are missing. hitches fails its threshold.
        metrics: [{ name: "hitches", value: 7, verdict: "fail" }],
        diagnostics: { crashIdsBefore: [], crashIdsAfter: [] },
      },
    );
    if (isToolError(result)) throw new Error(result.error);
    const codes = result.findings.map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(["metric:cpu", "metric:memory", "metric:hitches"]));
    const hitchesFinding = result.findings.find((f) => f.code === "metric:hitches");
    expect(hitchesFinding?.severity).toBe("failure");
  });

  it("agrees with report.json on the final status (regression)", async () => {
    if (!harness) throw new Error("harness not initialized");
    const prepared = await prepareCommunity(harness);
    const result = await harness.call<FinalizePerformanceTestResult>(
      "finalize_performance_test",
      {
        runId: prepared.runId,
        requestedStatus: "completed",
        actions: [
          {
            actionId: "scroll-up-1",
            outcome: "executed",
            attempts: 1,
            startedAt: "2026-10-17T00:00:10.000Z",
            endedAt: "2026-10-17T00:00:11.500Z",
          },
        ],
        metrics: [
          { name: "hitches", value: 0, verdict: "pass" },
          { name: "cpu", value: 20, unit: "%", verdict: "pass" },
          { name: "memory", value: 200, unit: "MB", verdict: "pass" },
        ],
        diagnostics: { crashIdsBefore: [], crashIdsAfter: [] },
      },
    );
    if (isToolError(result)) throw new Error(result.error);
    const json = JSON.parse(
      await readFile(
        join(harness.root, "runs", prepared.runId, "report.json"),
        "utf8",
      ),
    );
    // The status returned to Claude and the status persisted in
    // report.json must agree, with no hidden partial-classification drift.
    expect(json.status).toBe(result.status);
    expect(json.status).toBe("completed");
  });

  it("agrees with report.json on the failed status when diagnostics detect new crash", async () => {
    if (!harness) throw new Error("harness not initialized");
    const prepared = await prepareCommunity(harness);
    const result = await harness.call<FinalizePerformanceTestResult>(
      "finalize_performance_test",
      {
        runId: prepared.runId,
        requestedStatus: "completed",
        actions: [
          {
            actionId: "scroll-up-1",
            outcome: "executed",
            attempts: 1,
            startedAt: "2026-10-17T00:00:10.000Z",
            endedAt: "2026-10-17T00:00:11.500Z",
          },
        ],
        metrics: [
          { name: "hitches", value: 0, verdict: "pass" },
          { name: "cpu", value: 20, unit: "%", verdict: "pass" },
          { name: "memory", value: 200, unit: "MB", verdict: "pass" },
        ],
        diagnostics: {
          crashIdsBefore: [],
          crashIdsAfter: ["crash-1"],
          crashReports: [{ id: "crash-1" }],
        },
      },
    );
    if (isToolError(result)) throw new Error(result.error);
    const json = JSON.parse(
      await readFile(
        join(harness.root, "runs", prepared.runId, "report.json"),
        "utf8",
      ),
    );
    expect(result.status).toBe("failed");
    expect(json.status).toBe("failed");
  });
});
