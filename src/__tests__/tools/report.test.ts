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
          logText: "everything is fine",
          crashIdsBefore: ["pre-existing"],
          crashIdsAfter: ["pre-existing"],
          lifecycle: [{ kind: "foreground", occurredAt: "2026-10-17T00:00:30.000Z" }],
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
        diagnostics: { logText: "everything is fine", crashIdsBefore: ["pre-existing"], crashIdsAfter: ["pre-existing"], lifecycle: [{ kind: "foreground", occurredAt: "2026-10-17T00:00:30.000Z" }] },
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
        diagnostics: { logText: "everything is fine", crashIdsBefore: ["pre-existing"], crashIdsAfter: ["pre-existing"], lifecycle: [{ kind: "foreground", occurredAt: "2026-10-17T00:00:30.000Z" }] },
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
        expect.objectContaining({ kind: "deviceLog", relativePath: "logs/device.log" }),
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
        diagnostics: { logText: "everything is fine", crashIdsBefore: ["pre-existing"], crashIdsAfter: ["pre-existing"], lifecycle: [{ kind: "foreground", occurredAt: "2026-10-17T00:00:30.000Z" }] },
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

  it("map report.evidencePaths has deviceLog as a string run-relative path (e2e contract)", async () => {
    if (!harness) throw new Error("harness not initialized");
    const prepared = await prepareCommunity(harness);
    const externalDir = join(harness.root, "external-e2e");
    await mkdir(externalDir, { recursive: true });
    const externalLog = join(externalDir, "device.log");
    await writeFile(externalLog, "hello device\n", "utf8");
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
        diagnostics: { logText: "everything is fine", crashIdsBefore: ["pre-existing"], crashIdsAfter: ["pre-existing"], lifecycle: [{ kind: "foreground", occurredAt: "2026-10-17T00:00:30.000Z" }] },
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
    // The tool's own result exposes evidencePaths as an array of copied
    // descriptors so callers can use `result.evidencePaths.map(...)`.
    expect(Array.isArray(result.evidencePaths)).toBe(true);
    const deviceLogEntry = result.evidencePaths.find(
      (e) => e.kind === "deviceLog",
    );
    expect(deviceLogEntry?.relativePath).toBe("logs/device.log");
    // The persisted report.json keeps the map shape; downstream consumers
    // (Task 8 e2e tests) read `reportJson.evidencePaths.deviceLog` as a
    // string.
    const jsonReport = JSON.parse(
      await readFile(
        join(harness.root, "runs", prepared.runId, "report.json"),
        "utf8",
      ),
    );
    expect(typeof jsonReport.evidencePaths).toBe("object");
    expect(typeof jsonReport.evidencePaths.deviceLog).toBe("string");
    expect(jsonReport.evidencePaths.deviceLog).toBe("logs/device.log");
    expect(jsonReport.evidencePaths.deviceLog.startsWith("/")).toBe(false);
  });

  it("populates reportJson.evidencePaths.deviceLog from diagnostics.logPath when no copy is supplied", async () => {
    if (!harness) throw new Error("harness not initialized");
    const prepared = await prepareCommunity(harness);
    // No evidencePaths array supplied: the caller only passes the run-
    // relative log path through `diagnostics.logPath`. The persisted
    // report.json must still expose this as `evidencePaths.deviceLog`
    // so interactive-contract consumers (Task 8 e2e) can find it.
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
          logPath: "logs/device.log",
        },
      },
    );
    if (isToolError(result)) throw new Error(result.error);
    const jsonReport = JSON.parse(
      await readFile(
        join(harness.root, "runs", prepared.runId, "report.json"),
        "utf8",
      ),
    );
    expect(typeof jsonReport.evidencePaths.deviceLog).toBe("string");
    expect(jsonReport.evidencePaths.deviceLog).toBe("logs/device.log");
  });

  it("offline interactive contract: report.json + report.md agree with the safe-path/e2e contract", async () => {
    if (!harness) throw new Error("harness not initialized");
    const prepared = await prepareCommunity(harness);
    // Supply an absolute source path on purpose — the safe-path contract
    // is that it MUST NOT appear anywhere in the persisted or rendered
    // reports, and the run-relative path is the only one allowed.
    const externalDir = join(harness.root, "interactive-contract");
    await mkdir(externalDir, { recursive: true });
    const absoluteSourcePath = join(externalDir, "device.log");
    await writeFile(
      absoluteSourcePath,
      "interactive contract device log\n",
      "utf8",
    );
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
        diagnostics: { logText: "everything is fine", crashIdsBefore: ["pre-existing"], crashIdsAfter: ["pre-existing"], lifecycle: [{ kind: "foreground", occurredAt: "2026-10-17T00:00:30.000Z" }] },
        evidencePaths: [
          {
            kind: "deviceLog",
            sourcePath: absoluteSourcePath,
            relativePath: "logs/device.log",
          },
        ],
      },
    );
    if (isToolError(result)) throw new Error(result.error);

    // Contract A: report.json stays a MAP with deviceLog as a string.
    const jsonReportText = await readFile(
      join(harness.root, "runs", prepared.runId, "report.json"),
      "utf8",
    );
    const jsonReport = JSON.parse(jsonReportText);
    expect(typeof jsonReport.evidencePaths).toBe("object");
    expect(Array.isArray(jsonReport.evidencePaths)).toBe(false);
    expect(typeof jsonReport.evidencePaths.deviceLog).toBe("string");
    expect(jsonReport.evidencePaths.deviceLog).toBe("logs/device.log");
    expect(jsonReport.evidencePaths.deviceLog.startsWith("/")).toBe(false);

    // Contract B: the absolute source path NEVER leaks into report.json.
    expect(jsonReportText).not.toContain(externalDir);
    expect(jsonReportText).not.toContain(absoluteSourcePath);

    // Contract C: the rendered Markdown uses the agreed Chinese section
    // heading `### 日志` (NOT a different name) and references the
    // run-relative device log path so the human reader can locate it.
    const md = await readFile(
      join(harness.root, "runs", prepared.runId, "report.md"),
      "utf8",
    );
    expect(md).toContain("### 日志");
    expect(md).not.toContain("### 设备日志");
    expect(md).toContain("logs/device.log");
    // The absolute source path must not leak into the Markdown either.
    expect(md).not.toContain(externalDir);
    expect(md).not.toContain(absoluteSourcePath);
  });

  it("finalize result exposes an array of descriptors and report.json exposes a map (dual contract)", async () => {
    if (!harness) throw new Error("harness not initialized");
    const prepared = await prepareCommunity(harness);
    const externalDir = join(harness.root, "dual-contract");
    await mkdir(externalDir, { recursive: true });
    const deviceLog = join(externalDir, "device.log");
    const crashReport = join(externalDir, "crash.ips");
    await writeFile(deviceLog, "log\n", "utf8");
    await writeFile(crashReport, "crash\n", "utf8");
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
        diagnostics: { logText: "everything is fine", crashIdsBefore: ["pre-existing"], crashIdsAfter: ["pre-existing"], lifecycle: [{ kind: "foreground", occurredAt: "2026-10-17T00:00:30.000Z" }] },
        evidencePaths: [
          { kind: "deviceLog", sourcePath: deviceLog, relativePath: "logs/device.log" },
          { kind: "crashReport", sourcePath: crashReport, relativePath: "logs/crash.ips" },
        ],
      },
    );
    if (isToolError(result)) throw new Error(result.error);

    // Contract 1: finalize tool result is an ARRAY of copied descriptors
    // so consumers can call `result.evidencePaths.map(...)`.
    expect(Array.isArray(result.evidencePaths)).toBe(true);
    const kinds = result.evidencePaths.map((e) => e.kind).sort();
    expect(kinds).toEqual(["crashReport", "deviceLog"]);
    const devicesFromArray = result.evidencePaths.map(
      (e) => e.relativePath,
    );
    expect(devicesFromArray).toEqual(
      expect.arrayContaining(["logs/device.log", "logs/crash.ips"]),
    );

    // Contract 2: report.json keeps the kind→path MAP shape with each
    // value being a run-relative string. No entry leaks the absolute
    // source path passed to copyEvidence.
    const jsonReport = JSON.parse(
      await readFile(
        join(harness.root, "runs", prepared.runId, "report.json"),
        "utf8",
      ),
    );
    expect(typeof jsonReport.evidencePaths).toBe("object");
    expect(Array.isArray(jsonReport.evidencePaths)).toBe(false);
    expect(typeof jsonReport.evidencePaths.deviceLog).toBe("string");
    expect(jsonReport.evidencePaths.deviceLog).toBe("logs/device.log");
    expect(typeof jsonReport.evidencePaths.crashReport).toBe("string");
    expect(jsonReport.evidencePaths.crashReport).toBe("logs/crash.ips");
    // Absolute paths never appear in either surface.
    expect(JSON.stringify(jsonReport.evidencePaths)).not.toContain(
      externalDir,
    );
    expect(JSON.stringify(result.evidencePaths)).not.toContain(externalDir);
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
        diagnostics: { logText: "everything is fine", crashIdsBefore: ["pre-existing"], crashIdsAfter: ["pre-existing"], lifecycle: [{ kind: "foreground", occurredAt: "2026-10-17T00:00:30.000Z" }] },
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
        diagnostics: { logText: "everything is fine", crashIdsBefore: ["pre-existing"], crashIdsAfter: ["pre-existing"], lifecycle: [{ kind: "foreground", occurredAt: "2026-10-17T00:00:30.000Z" }] },
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
        diagnostics: { logText: "everything is fine", crashIdsBefore: ["pre-existing"], crashIdsAfter: ["pre-existing"], lifecycle: [{ kind: "foreground", occurredAt: "2026-10-17T00:00:30.000Z" }] },
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
        diagnostics: { logText: "everything is fine", crashIdsBefore: ["pre-existing"], crashIdsAfter: ["pre-existing"], lifecycle: [{ kind: "foreground", occurredAt: "2026-10-17T00:00:30.000Z" }] },
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

  it("never leaks absolute source paths through report.json or report.md", async () => {
    if (!harness) throw new Error("harness not initialized");
    const prepared = await prepareCommunity(harness);
    const externalDir = join(harness.root, "absolute-source");
    await mkdir(externalDir, { recursive: true });
    const absoluteSourcePath = join(externalDir, "device.log");
    await writeFile(absoluteSourcePath, "absolute only\n", "utf8");
    // No copy is requested, but the caller still hands us an absolute
    // path through diagnostics.logPath. The persistent report must
    // omit it entirely.
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
          crashIdsBefore: ["pre-existing"],
          crashIdsAfter: ["pre-existing"],
          lifecycle: [
            { kind: "foreground", occurredAt: "2026-10-17T00:00:30.000Z" },
          ],
          logPath: absoluteSourcePath,
        },
        evidencePaths: [
          {
            kind: "deviceLog",
            sourcePath: absoluteSourcePath,
            relativePath: "logs/device.log",
          },
        ],
      },
    );
    if (isToolError(result)) throw new Error(result.error);
    const reportJsonText = await readFile(
      join(harness.root, "runs", prepared.runId, "report.json"),
      "utf8",
    );
    const reportJson = JSON.parse(reportJsonText);
    const md = await readFile(
      join(harness.root, "runs", prepared.runId, "report.md"),
      "utf8",
    );
    expect(reportJsonText).not.toContain(absoluteSourcePath);
    expect(md).not.toContain(absoluteSourcePath);
    // The run-relative copy value must win.
    expect(reportJson.evidencePaths.deviceLog).toBe("logs/device.log");
  });

  it("preserves metric tracePath and unknown metric extras through finalize", async () => {
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
          {
            name: "hitches",
            instrument: "Animation Hitches",
            tracePath: "traces/hitches.trace",
            result: { raw: { count: 3 }, instruments: ["x"] },
            threshold: { warn: 5, fail: 10 },
            verdict: "pass",
            customField: "preserve-me",
          } as Record<string, unknown> & {
            name: string;
            value?: unknown;
            verdict?: string;
          },
        ],
        diagnostics: {
          logText: "everything is fine",
          crashIdsBefore: ["pre-existing"],
          crashIdsAfter: ["pre-existing"],
          lifecycle: [
            { kind: "foreground", occurredAt: "2026-10-17T00:00:30.000Z" },
          ],
        },
      },
    );
    if (isToolError(result)) throw new Error(result.error);
    const runOnDisk = JSON.parse(
      await readFile(
        join(harness.root, "runs", prepared.runId, "run.json"),
        "utf8",
      ),
    );
    const metric = runOnDisk.metrics.find(
      (m: { name: string }) => m.name === "hitches",
    );
    expect(metric.tracePath).toBe("traces/hitches.trace");
    expect(metric.result).toEqual({
      raw: { count: 3 },
      instruments: ["x"],
    });
    expect(metric.customField).toBe("preserve-me");
  });

  it("preserves an explicitly requested partial status (no coercion to completed)", async () => {
    if (!harness) throw new Error("harness not initialized");
    const prepared = await prepareCommunity(harness);
    const result = await harness.call<FinalizePerformanceTestResult>(
      "finalize_performance_test",
      {
        runId: prepared.runId,
        requestedStatus: "partial",
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
          logText: "everything is fine",
          crashIdsBefore: ["pre-existing"],
          crashIdsAfter: ["pre-existing"],
          lifecycle: [
            { kind: "foreground", occurredAt: "2026-10-17T00:00:30.000Z" },
          ],
        },
      },
    );
    if (isToolError(result)) throw new Error(result.error);
    expect(result.status).toBe("partial");
  });

  it("preserves an explicitly requested partial status even when a new crash is detected (no coercion to failed)", async () => {
    if (!harness) throw new Error("harness not initialized");
    const prepared = await prepareCommunity(harness);
    const result = await harness.call<FinalizePerformanceTestResult>(
      "finalize_performance_test",
      {
        runId: prepared.runId,
        requestedStatus: "partial",
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
          logText: "jetsam killing process NN",
          crashIdsBefore: [],
          crashIdsAfter: ["crash-1"],
          crashReports: [{ id: "crash-1" }],
        },
      },
    );
    if (isToolError(result)) throw new Error(result.error);
    expect(result.status).toBe("partial");
  });

  it.each(["prepared", "running"])(
    "rejects finalize requestedStatus %s with a structured tool error (no coercion)",
    async (nonTerminal) => {
      if (!harness) throw new Error("harness not initialized");
      const prepared = await prepareCommunity(harness);
      const result = await harness.call("finalize_performance_test", {
        runId: prepared.runId,
        requestedStatus: nonTerminal,
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
          logText: "everything is fine",
          crashIdsBefore: ["pre-existing"],
          crashIdsAfter: ["pre-existing"],
          lifecycle: [
            { kind: "foreground", occurredAt: "2026-10-17T00:00:30.000Z" },
          ],
        },
      });
      expect(isToolError(result)).toBe(true);
      expect((result as { error: string }).error).toMatch(
        new RegExp(nonTerminal, "i"),
      );
      expect((result as { error: string }).error).toMatch(
        /terminal|invalid|complete|partial|failed/i,
      );
    },
  );
});
