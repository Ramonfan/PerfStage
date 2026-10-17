import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestToolHarness,
  isToolError,
  type FinalizePerformanceTestResult,
  type ListPerformanceScenariosResult,
  type PreparePerformanceTestResult,
  type TestToolHarness,
} from "../support/tool-harness.js";

/**
 * Offline interactive-contract test.
 *
 * Exercises the full Claude-orchestrated workflow that production callers
 * rely on: enumerate scenarios, prepare the community-home-scroll fixture,
 * supply action/metric/diagnostic evidence (including `device.log`,
 * `lifecycle.json`, and a new Crash file), finalize the run, then read the
 * resulting `report.json` and `report.md`.
 *
 * The test never talks to a real device. Every piece of evidence is a
 * fixture file written into a temp directory before the MCP calls run.
 */

let harness: TestToolHarness | null = null;
let evidenceRoot: string | null = null;
const extraRoots: string[] = [];

beforeEach(async () => {
  harness = await createTestToolHarness();
  evidenceRoot = await mkdtemp(join(tmpdir(), "performance-mcp-evidence-"));
});

afterEach(async () => {
  if (harness) {
    await harness.cleanup();
    harness = null;
  }
  if (evidenceRoot) {
    const { rm } = await import("node:fs/promises");
    await rm(evidenceRoot, { recursive: true, force: true });
    evidenceRoot = null;
  }
  for (const root of extraRoots) {
    try {
      const { rm } = await import("node:fs/promises");
      await rm(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  extraRoots.length = 0;
});

describe("interactive performance-test contract (offline)", () => {
  it("completes the community-home-scroll flow with device log, lifecycle, and a new crash", async () => {
    if (!harness || !evidenceRoot) throw new Error("harness not initialized");

    // ---- 1. Build fixture evidence that the real Claude would have collected.
    const deviceLogSrc = join(evidenceRoot, "device.log");
    const lifecycleSrc = join(evidenceRoot, "lifecycle.json");
    const crashSrc = join(evidenceRoot, "crash-001.ips");
    const lifecycleEvidenceDir = join(evidenceRoot, "evidence");
    await mkdir(lifecycleEvidenceDir, { recursive: true });
    await writeFile(deviceLogSrc, "all good\n[com.nndev.im] foreground\n", "utf8");
    await writeFile(
      lifecycleSrc,
      JSON.stringify(
        {
          events: [
            {
              kind: "foreground",
              occurredAt: "2026-10-17T00:00:30.000Z",
              notes: "app resumed before swipe",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      crashSrc,
      "EXC_BAD_ACCESS in com.nndev.im\nframe #0 0x0000000100abcdef\n",
      "utf8",
    );

    // ---- 2. list_performance_scenarios surfaces community-home-scroll.
    const scenariosResult = await harness.call("list_performance_scenarios");
    expect(isToolError(scenariosResult)).toBe(false);
    const scenarios = scenariosResult as ListPerformanceScenariosResult;
    const scenarioIds = scenarios.scenarios.map((s) => s.id);
    expect(scenarioIds).toContain("community-home-scroll");
    const community = scenarios.scenarios.find(
      (s) => s.id === "community-home-scroll",
    );
    expect(community).toBeDefined();
    expect(community?.actionCount).toBeGreaterThanOrEqual(2);
    expect(community?.metricNames).toEqual(
      expect.arrayContaining(["hitches", "cpu", "memory"]),
    );

    // ---- 3. prepare_performance_test creates a run and returns next steps.
    const prepareResult = await harness.call("prepare_performance_test", {
      scenarioId: "community-home-scroll",
      device: { id: "device-fixture-1", name: "Fixture iPhone" },
    });
    expect(isToolError(prepareResult)).toBe(false);
    const prepared = prepareResult as PreparePerformanceTestResult;
    expect(prepared.runId).toEqual(expect.any(String));
    expect(prepared.scenarioId).toBe("community-home-scroll");
    expect(prepared.runPath).toBe(posix.join("run.json"));
    expect(prepared.planPath).toBe(posix.join("plan.json"));
    expect(prepared.execution).toBe("interactive");
    expect(prepared.nextSteps.join("\n")).toContain("mobile_get_device_logs");
    expect(prepared.nextSteps.join("\n")).toContain("mobile_list_crashes");
    expect(prepared.nextSteps.join("\n")).toContain("finalize_performance_test");

    // ---- 4. finalize_performance_test records action/metric/diagnostic evidence.
    const finalizeResult = await harness.call("finalize_performance_test", {
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
        logText: "[com.nndev.im] all good\n",
        logPath: deviceLogSrc,
        logFilters: { subsystem: "com.nndev.im" },
        crashIdsBefore: [],
        crashIdsAfter: ["crash-001"],
        crashReports: [
          {
            id: "crash-001",
            path: crashSrc,
            process: "com.nndev.im",
            exceptionType: "EXC_BAD_ACCESS",
            crashedThread: "0",
            keyStack: "EXC_BAD_ACCESS in com.nndev.im",
          },
        ],
        lifecycle: [
          {
            kind: "foreground",
            occurredAt: "2026-10-17T00:00:30.000Z",
            notes: "app resumed before swipe",
          },
        ],
      },
      evidencePaths: [
        {
          kind: "lifecycleTrace",
          sourcePath: lifecycleSrc,
          relativePath: "lifecycle.json",
        },
        {
          kind: "crashReport",
          sourcePath: crashSrc,
          relativePath: "crashes/crash-001.ips",
        },
      ],
      notes: "Offline fixture run for contract validation.",
    });
    expect(isToolError(finalizeResult)).toBe(false);
    const finalized = finalizeResult as FinalizePerformanceTestResult;
    expect(finalized.runId).toBe(prepared.runId);
    expect(finalized.runPath).toBe(posix.join("run.json"));
    expect(finalized.jsonPath).toBe(posix.join("report.json"));
    expect(finalized.markdownPath).toBe(posix.join("report.md"));
    // Both supplied evidence paths are copied into the run directory.
    const evidenceKinds = finalized.evidencePaths.map((e) => e.kind);
    expect(evidenceKinds).toEqual(
      expect.arrayContaining(["lifecycleTrace", "crashReport"]),
    );
    expect(finalized.diagnostics.logs.status).toBe("available");
    expect(finalized.diagnostics.crashes.status).toBe("available");
    expect(finalized.diagnostics.crashes.newIds).toEqual(["crash-001"]);
    expect(finalized.diagnostics.lifecycle.events).toHaveLength(1);

    // ---- 5. Read the generated report.json and report.md.
    const runDir = join(harness.runsDir, prepared.runId);
    const reportJsonText = await readFile(join(runDir, "report.json"), "utf8");
    const reportJson = JSON.parse(reportJsonText) as {
      status: string;
      evidencePaths: {
        deviceLog?: string;
        crashReport?: string;
        lifecycleTrace?: string;
      };
      diagnostics: {
        crashes: { newIds: string[]; reports: Array<{ id: string }> };
      };
    };
    const reportMd = await readFile(join(runDir, "report.md"), "utf8");

    // ---- 6. Assert every supplied evidence file is referenced.

    // device.log — diagnostics.logPath propagates into run.evidence.deviceLogPath,
    // which the report surfaces under evidencePaths.deviceLog.
    expect(typeof reportJson.evidencePaths.deviceLog).toBe("string");
    expect(reportJson.evidencePaths.deviceLog).toBe(deviceLogSrc);
    expect(reportMd).toContain("设备日志");
    expect(reportMd).toContain(deviceLogSrc);

    // lifecycle.json — copied into the run directory via evidencePaths and
    // surfaced both in the response and in the run evidence tree.
    const lifecycleCopied = join(runDir, "lifecycle.json");
    expect(finalized.evidencePaths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "lifecycleTrace",
          relativePath: "lifecycle.json",
        }),
      ]),
    );
    const lifecycleOnDisk = await readFile(lifecycleCopied, "utf8");
    expect(lifecycleOnDisk).toContain("foreground");
    expect(reportMd).toContain("foreground");
    expect(reportMd).toContain("2026-10-17T00:00:30.000Z");

    // Each new Crash file — the file is copied via evidencePaths, the run's
    // diagnostics surface the new ID, and the markdown report lists it.
    const crashCopiedRel = "crashes/crash-001.ips";
    const crashCopiedAbs = join(runDir, crashCopiedRel);
    expect(finalized.evidencePaths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "crashReport",
          relativePath: crashCopiedRel,
        }),
      ]),
    );
    const crashOnDisk = await readFile(crashCopiedAbs, "utf8");
    expect(crashOnDisk).toContain("EXC_BAD_ACCESS");
    expect(reportJson.diagnostics.crashes.newIds).toEqual(["crash-001"]);
    expect(reportJson.diagnostics.crashes.reports.map((r) => r.id)).toEqual(
      expect.arrayContaining(["crash-001"]),
    );
    expect(reportMd).toContain("crash-001");
    expect(reportMd).toContain("EXC_BAD_ACCESS");
    expect(reportMd).toContain("新增 Crash");
  });

  it("rejects finalize on a run that has already been finalized", async () => {
    if (!harness) throw new Error("harness not initialized");
    const preparedRaw = await harness.call("prepare_performance_test", {
      scenarioId: "community-home-scroll",
      device: { id: "device-fixture-1" },
    });
    if (isToolError(preparedRaw)) throw new Error(preparedRaw.error);
    const prepared = preparedRaw as PreparePerformanceTestResult;
    const first = await harness.call("finalize_performance_test", {
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
    });
    if (isToolError(first)) throw new Error(first.error);
    const second = await harness.call("finalize_performance_test", {
      runId: prepared.runId,
      requestedStatus: "completed",
      actions: [],
      metrics: [],
      diagnostics: {},
    });
    expect(isToolError(second)).toBe(true);
    expect((second as { error: string }).error).toMatch(/terminal|already/i);
  });

  it("rejects finalize when the requested runId does not exist", async () => {
    if (!harness) throw new Error("harness not initialized");
    const result = await harness.call("finalize_performance_test", {
      runId: "no-such-run-12345",
      requestedStatus: "completed",
      actions: [],
      metrics: [],
      diagnostics: {},
    });
    expect(isToolError(result)).toBe(true);
    expect((result as { error: string }).error).toMatch(/不存在|run/i);
  });
});