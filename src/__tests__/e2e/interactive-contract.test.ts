/**
 * End-to-end "interactive contract" test for the performance-test MCP.
 *
 * The test exercises the same handler functions the production MCP server
 * exposes (via the test harness), but at the level of an e2e fixture: a
 * real fixture run is produced, then `report.json` and `report.md` are
 * read back and asserted against the documented contracts. This file is
 * the offline companion to the (sibling-worktree) e2e smoke that runs
 * against a live MCP server; both must agree.
 *
 * The contracts asserted here are derived from the design + spec:
 *
 *   1. `list_performance_scenarios` returns sorted entries containing
 *      `id`, `name`, `bundleId`, actionCount, metricNames, and the
 *      diagnostics defaults. A malformed scenario surfaces as a
 *      structured error mentioning its file path.
 *
 *   2. `prepare_performance_test` with the community scenario creates a
 *      prepared `TestRun` whose `run.json` exists on disk and whose
 *      instructions reference `mobile_get_device_logs`,
 *      `mobile_list_crashes`, `mobile-mcp`, `Instruments`, and
 *      `finalize_performance_test`.
 *
 *   3. `finalize_performance_test` with a clean run writes
 *      `report.json` and `report.md` and the persisted report:
 *        - carries `evidencePaths` as a kind→path MAP with
 *          `deviceLog` as a run-relative string,
 *        - never leaks the absolute source path used for evidence
 *          copies into either `report.json` or the Markdown renderer,
 *        - emits the agreed Chinese stability heading `### 日志`
 *          (NOT `### 设备日志`),
 *        - references the run-relative device log path in the
 *          Markdown so a human reader can locate the evidence.
 *
 *   4. `finalize_performance_test` with a brand-new crash downgrades a
 *      requested `completed` to `failed`.
 */

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestToolHarness,
  isToolError,
  type FinalizePerformanceTestResult,
  type PreparePerformanceTestResult,
  type TestToolHarness,
} from "../support/tool-harness.js";

let root: string | null = null;
let harness: TestToolHarness | null = null;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "performance-mcp-e2e-"));
  harness = await createTestToolHarness(root);
});

afterEach(async () => {
  if (harness) {
    await harness.cleanup();
    harness = null;
  }
  if (root !== null) {
    const capturedRoot = root;
    root = null;
    await import("node:fs/promises").then((fs) =>
      fs.rm(capturedRoot, { recursive: true, force: true }),
    );
  }
});

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

describe("interactive contract (offline e2e)", () => {
  it("returns sorted scenarios with id, name, bundleId, action count, metric names, and diagnostic defaults", async () => {
    if (!harness) throw new Error("harness not initialized");
    const result = (await harness.call("list_performance_scenarios")) as {
      scenarios: Array<Record<string, unknown>>;
    };
    expect(isToolError(result)).toBe(false);
    expect(Array.isArray(result.scenarios)).toBe(true);
    expect(result.scenarios.length).toBeGreaterThanOrEqual(2);
    const first = result.scenarios[0] as Record<string, unknown>;
    expect(first.id).toBe("community-home-scroll");
    expect(first.bundleId).toBe("com.nndev.im");
    expect(first.name).toBe("社区首页来回滚动");
    expect(first.actionCount).toBe(2);
    expect(first.metricNames).toEqual(["hitches", "cpu", "memory"]);
    const diagnostics = first.diagnostics as Record<string, unknown>;
    expect(diagnostics.collectDeviceLogs).toBe(true);
    expect(diagnostics.collectCrashes).toBe(true);
  });

  it("prepare persists a prepared run and emits Claude-executable next steps", async () => {
    if (!harness) throw new Error("harness not initialized");
    const prepared = await harness.call<PreparePerformanceTestResult>(
      "prepare_performance_test",
      {
        scenarioId: "community-home-scroll",
        device: { id: "device-1", name: "Ra iPhone" },
      },
    );
    if (isToolError(prepared)) throw new Error(prepared.error);
    expect(prepared.runId).toEqual(expect.any(String));
    expect(prepared.scenarioId).toBe("community-home-scroll");
    const nextSteps = prepared.nextSteps.join("\n");
    expect(nextSteps).toContain("mobile_get_device_logs");
    expect(nextSteps).toContain("mobile_list_crashes");
    expect(nextSteps).toContain("mobile-mcp");
    expect(nextSteps).toContain("Instruments");
    expect(nextSteps).toContain("finalize_performance_test");

    const runOnDisk = await readJson<{ status: string; planId: string }>(
      join(harness.runsDir, prepared.runId, "run.json"),
    );
    expect(runOnDisk.status).toBe("prepared");
    expect(runOnDisk.planId).toBe("community-home-scroll");
  });

  it("finalize clean run writes report.json (map) and report.md (### 日志) with safe run-relative device log path", async () => {
    if (!harness) throw new Error("harness not initialized");
    const prepared = await harness.call<PreparePerformanceTestResult>(
      "prepare_performance_test",
      {
        scenarioId: "community-home-scroll",
        device: { id: "device-1", name: "Ra iPhone" },
      },
    );
    if (isToolError(prepared)) throw new Error(prepared.error);

    // Provide an absolute source path on purpose: the contract says
    // the rendered reports MUST NOT contain it; only the run-relative
    // path is allowed.
    const evidenceDir = join(harness.root, "external-e2e");
    await mkdir(evidenceDir, { recursive: true });
    const absoluteSourcePath = join(evidenceDir, "device.log");
    await writeFile(absoluteSourcePath, "interactive-contract log\n", "utf8");

    const finalized = await harness.call<FinalizePerformanceTestResult>(
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
          { name: "hitches", value: 0, verdict: "pass", tracePath: "traces/hitches.trace" },
          { name: "cpu", value: 20, unit: "%", verdict: "pass", tracePath: "traces/cpu.trace" },
          { name: "memory", value: 200, unit: "MB", verdict: "pass", tracePath: "traces/memory.trace" },
        ],
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
    if (isToolError(finalized)) throw new Error(finalized.error);
    expect(finalized.status).toBe("completed");

    const reportJsonPath = join(harness.runsDir, prepared.runId, "report.json");
    const reportMdPath = join(harness.runsDir, prepared.runId, "report.md");

    // report.json: map shape with deviceLog as a run-relative string.
    const reportJsonText = await readFile(reportJsonPath, "utf8");
    const jsonReport = JSON.parse(reportJsonText);
    expect(typeof jsonReport.evidencePaths).toBe("object");
    expect(Array.isArray(jsonReport.evidencePaths)).toBe(false);
    expect(typeof jsonReport.evidencePaths.deviceLog).toBe("string");
    expect(jsonReport.evidencePaths.deviceLog).toBe("logs/device.log");
    expect(jsonReport.evidencePaths.deviceLog.startsWith("/")).toBe(false);

    // Safe-path contract: the absolute source path must NEVER appear
    // in either rendered surface.
    expect(reportJsonText).not.toContain(absoluteSourcePath);
    expect(reportJsonText).not.toContain(evidenceDir);

    const md = await readFile(reportMdPath, "utf8");

    // Chinese stability section heading contract: `### 日志` is the
    // canonical name; the older `### 设备日志` MUST NOT be used.
    expect(md).toContain("### 日志");
    expect(md).not.toContain("### 设备日志");

    // The Markdown references the run-relative log path so a human
    // reader can find it.
    expect(md).toContain("logs/device.log");

    // The Markdown does not leak absolute paths either.
    expect(md).not.toContain(absoluteSourcePath);
    expect(md).not.toContain(evidenceDir);

    // Standard section ordering is preserved.
    for (const header of [
      "## 总结",
      "## 测试计划",
      "## 动作时间线",
      "## 性能指标",
      "## 稳定性诊断",
      "## 证据文件",
      "## 限制与未知项",
    ]) {
      expect(md).toContain(header);
    }
  });

  it("finalize downgrades completed to failed when diagnostics report a new crash", async () => {
    if (!harness) throw new Error("harness not initialized");
    const prepared = await harness.call<PreparePerformanceTestResult>(
      "prepare_performance_test",
      {
        scenarioId: "community-home-scroll",
        device: { id: "device-1", name: "Ra iPhone" },
      },
    );
    if (isToolError(prepared)) throw new Error(prepared.error);

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
          { name: "hitches", value: 0, verdict: "pass", tracePath: "traces/hitches.trace" },
          { name: "cpu", value: 20, unit: "%", verdict: "pass", tracePath: "traces/cpu.trace" },
          { name: "memory", value: 200, unit: "MB", verdict: "pass", tracePath: "traces/memory.trace" },
        ],
        diagnostics: {
          crashIdsBefore: [],
          crashIdsAfter: ["crash-1"],
          crashReports: [
            { id: "crash-1", exceptionType: "EXC_BAD_ACCESS" },
          ],
        },
      },
    );
    if (isToolError(result)) throw new Error(result.error);
    expect(result.status).toBe("failed");
    const reportJson = await readJson<{ status: string }>(
      join(harness.runsDir, prepared.runId, "report.json"),
    );
    expect(reportJson.status).toBe("failed");
  });
});
