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
});
