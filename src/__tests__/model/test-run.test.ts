import { describe, expect, it } from "vitest";
import {
  passRecordSchema,
  testRunSchema,
  transitionRunStatus,
} from "../../model/test-run.js";

describe("transitionRunStatus", () => {
  it("allows prepared -> running -> completed", () => {
    expect(transitionRunStatus("prepared", "running")).toBe("running");
    expect(transitionRunStatus("running", "completed")).toBe("completed");
  });

  it("rejects completed -> running", () => {
    expect(() => transitionRunStatus("completed", "running")).toThrow(
      /completed/,
    );
  });
});

function baseRun(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "run-1",
    planId: "plan-1",
    status: "completed",
    startedAt: "2026-11-16T00:00:00.000Z",
    endedAt: "2026-11-16T00:01:00.000Z",
    ...overrides,
  };
}

describe("passRecordSchema", () => {
  it("defaults attempts, metrics and issue counts", () => {
    const parsed = passRecordSchema.parse({
      template: "hitches",
      tracePath: "traces/hitches.trace",
      durationMs: 1200,
    });
    expect(parsed.attempts).toBe(1);
    expect(parsed.metrics).toEqual([]);
    expect(parsed.errorCount).toBe(0);
    expect(parsed.warningCount).toBe(0);
  });

  it("rejects an absolute trace path", () => {
    expect(() =>
      passRecordSchema.parse({
        template: "hitches",
        tracePath: "/tmp/hitches.trace",
        durationMs: 1,
      }),
    ).toThrow(/run-relative/);
  });

  it("allows a pass record without a trace path", () => {
    const parsed = passRecordSchema.parse({
      template: "hitches",
      durationMs: 1,
    });
    expect(parsed.tracePath).toBeUndefined();
  });

  it("rejects a trace path that escapes the run directory", () => {
    expect(() =>
      passRecordSchema.parse({
        template: "hitches",
        tracePath: "../hitches.trace",
        durationMs: 1,
      }),
    ).toThrow(/run-relative/);
  });

  it("carries the trace footprint when it was measured", () => {
    const parsed = passRecordSchema.parse({
      template: "hitches",
      tracePath: "traces/hitches.trace",
      durationMs: 1200,
      traceBytes: 441_327_926,
      saveMs: 8_400,
    });
    expect(parsed.traceBytes).toBe(441_327_926);
    expect(parsed.saveMs).toBe(8_400);
  });

  it("keeps legacy passes without footprint fields distinct from zero", () => {
    const parsed = passRecordSchema.parse({
      template: "hitches",
      tracePath: "traces/hitches.trace",
      durationMs: 1200,
    });
    // Absence means "not measured"; a 0 would look like an empty trace.
    expect(parsed.traceBytes).toBeUndefined();
    expect(parsed.saveMs).toBeUndefined();
  });

  it("rejects negative or fractional footprint values", () => {
    expect(() =>
      passRecordSchema.parse({
        template: "hitches",
        durationMs: 1,
        traceBytes: -1,
      }),
    ).toThrow();
    expect(() =>
      passRecordSchema.parse({
        template: "hitches",
        durationMs: 1,
        traceBytes: 0,
      }),
    ).toThrow();
    expect(() =>
      passRecordSchema.parse({
        template: "hitches",
        durationMs: 1,
        saveMs: -1,
      }),
    ).toThrow();
    expect(() =>
      passRecordSchema.parse({
        template: "hitches",
        durationMs: 1,
        traceBytes: 1.5,
      }),
    ).toThrow();
  });
});

describe("testRunSchema device", () => {
  it("keeps a legacy run without device parseable", () => {
    const parsed = testRunSchema.parse(baseRun());
    expect(parsed.device).toBeUndefined();
  });

  it("accepts device facts captured during preflight", () => {
    const parsed = testRunSchema.parse(
      baseRun({
        device: {
          id: "device-1",
          name: "Test iPhone",
          osVersion: "27.0.1",
          modelIdentifier: "iPhone17,3",
        },
      }),
    );
    expect(parsed.device).toEqual({
      id: "device-1",
      name: "Test iPhone",
      osVersion: "27.0.1",
      modelIdentifier: "iPhone17,3",
    });
  });

  it("ignores unknown keys so newer runs stay readable", () => {
    const parsed = testRunSchema.parse(
      baseRun({ device: { id: "device-1", futureField: true } }),
    );
    expect(parsed.device).toEqual({ id: "device-1" });
  });
});

describe("testRunSchema passes", () => {
  it("keeps a legacy run without passes parseable", () => {
    const parsed = testRunSchema.parse(baseRun());
    expect(parsed.passes).toBeUndefined();
  });

  it("accepts persisted pass records", () => {
    const parsed = testRunSchema.parse(
      baseRun({
        passes: [
          {
            template: "hitches",
            tracePath: "traces/hitches.trace",
            attempts: 2,
            durationMs: 1500,
            metrics: ["hitches", "blockMs"],
            errorCount: 1,
            warningCount: 0,
          },
        ],
      }),
    );
    expect(parsed.passes?.[0]?.attempts).toBe(2);
    expect(parsed.passes?.[0]?.metrics).toEqual(["hitches", "blockMs"]);
  });

  it("keeps legacy pass records without footprint fields unmeasured", () => {
    const parsed = testRunSchema.parse(
      baseRun({
        passes: [
          {
            template: "hitches",
            tracePath: "traces/hitches.trace",
            durationMs: 1_500,
          },
        ],
      }),
    );
    expect(parsed.passes?.[0]?.traceBytes).toBeUndefined();
    expect(parsed.passes?.[0]?.saveMs).toBeUndefined();
    expect(parsed.passes?.[0]?.recording).toBeUndefined();
  });

  it("accepts the recording config persisted with a compact pass", () => {
    const parsed = testRunSchema.parse(
      baseRun({
        passes: [
          {
            template: "hitches",
            tracePath: "traces/hitches.trace",
            durationMs: 1_500,
            recording: {
              profile: "compact",
              template: "Blank",
              instruments: ["Hitches"],
              timeLimit: "40s",
              duringTimeoutMs: 30_000,
              liveTimeoutMs: 30_000,
              window: "full-session",
              missingDiagnostics: ["Time Profiler (time-profile)"],
            },
          },
        ],
      }),
    );
    expect(parsed.passes?.[0]?.recording).toEqual({
      profile: "compact",
      template: "Blank",
      instruments: ["Hitches"],
      timeLimit: "40s",
      duringTimeoutMs: 30_000,
      liveTimeoutMs: 30_000,
      window: "full-session",
      missingDiagnostics: ["Time Profiler (time-profile)"],
    });
  });

  it("rejects an unknown recording profile", () => {
    expect(() =>
      testRunSchema.parse(
        baseRun({
          passes: [
            {
              template: "hitches",
              durationMs: 1_000,
              recording: { profile: "tiny", template: "Blank", timeLimit: "40s" },
            },
          ],
        }),
      ),
    ).toThrow();
  });
});
