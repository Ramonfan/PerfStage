import { describe, expect, it } from "vitest";
import {
  classifyDiagnosticImpact,
  diffCrashIds,
  normalizeDiagnostics,
} from "../../diagnostics/normalize.js";

describe("diffCrashIds", () => {
  it("finds only crashes created during the run", () => {
    expect(diffCrashIds(["old", "same"], ["same", "new"])).toEqual(["new"]);
  });

  it("returns an empty list when nothing is new", () => {
    expect(diffCrashIds(["a", "b"], ["a", "b"])).toEqual([]);
  });

  it("returns sorted new ids even when input order differs", () => {
    expect(diffCrashIds([], ["zeta", "alpha", "mu"])).toEqual([
      "alpha",
      "mu",
      "zeta",
    ]);
  });
});

describe("normalizeDiagnostics", () => {
  it("detects jetsam and watchdog without requiring a Crash report", () => {
    const evidence = normalizeDiagnostics(
      {
        logText:
          "memorystatus: jetsam killing process NN\nwatchdog timeout",
        crashIdsBefore: [],
        crashIdsAfter: [],
        lifecycle: [],
      },
      "2026-10-17T00:00:00.000Z",
      "2026-10-17T00:01:00.000Z",
    );
    const impact = classifyDiagnosticImpact(evidence);
    expect(impact.severity).toBe("failure");
    expect(impact.reasons).toEqual(expect.arrayContaining(["jetsam", "watchdog"]));
  });

  it("ignores benign watchdog mentions from WebKit and hangtracer", () => {
    const evidence = normalizeDiagnostics(
      {
        logText: [
          "ProcessAssertion::acquireSync Trying to take RBS assertion 'XPCConnectionTerminationWatchdog'",
          "Watchdog monitoring: starting monitor",
          "Watchdog monitoring: watchdog enabled, no assertion active",
        ].join("\n"),
        crashIdsBefore: ["old"],
        crashIdsAfter: ["old"],
        lifecycle: [{ kind: "foreground", occurredAt: "2026-11-13T03:53:17.445Z" }],
      },
      "2026-11-13T03:53:00.000Z",
      "2026-11-13T03:56:00.000Z",
    );
    expect(evidence.logs.categories.watchdog).toBe(false);
    expect(classifyDiagnosticImpact(evidence).reasons).not.toContain("watchdog");
  });

  it("still flags a real watchdog termination line", () => {
    const evidence = normalizeDiagnostics(
      {
        logText: "watchdog timeout: NNIM failed to check in\ncom.apple.watchdog",
        crashIdsBefore: ["old"],
        crashIdsAfter: ["old"],
        lifecycle: [{ kind: "foreground", occurredAt: "2026-11-13T03:53:17.445Z" }],
      },
      "2026-11-13T03:53:00.000Z",
      "2026-11-13T03:56:00.000Z",
    );
    expect(evidence.logs.categories.watchdog).toBe(true);
    expect(classifyDiagnosticImpact(evidence).reasons).toContain("watchdog");
  });

  it("makes an incomplete Crash query unavailable rather than clean", () => {    const evidence = normalizeDiagnostics(
      { crashQueryError: "device disconnected" },
      "2026-10-17T00:00:00.000Z",
      "2026-10-17T00:01:00.000Z",
    );
    expect(evidence.crashes.status).toBe("unavailable");
    expect(classifyDiagnosticImpact(evidence).reasons).toContain(
      "crash-detection-unavailable",
    );
  });

  it("preserves the raw log path/text and counts lines", () => {
    const evidence = normalizeDiagnostics(
      {
        logPath: "/tmp/device.log",
        logText: "line one\nline two\nline three",
        crashIdsBefore: [],
        crashIdsAfter: [],
      },
      "2026-10-17T00:00:00.000Z",
      "2026-10-17T00:01:00.000Z",
    );
    expect(evidence.logs.path).toBe("/tmp/device.log");
    expect(evidence.logs.text).toBe("line one\nline two\nline three");
    expect(evidence.logs.lineCount).toBe(3);
  });

  it("records new crash ids in evidence", () => {
    const evidence = normalizeDiagnostics(
      {
        crashIdsBefore: ["pre-1"],
        crashIdsAfter: ["pre-1", "post-1"],
        crashReports: [
          { id: "post-1", exceptionType: "EXC_BAD_ACCESS" },
        ],
      },
      "2026-10-17T00:00:00.000Z",
      "2026-10-17T00:01:00.000Z",
    );
    expect(evidence.crashes.newIds).toEqual(["post-1"]);
    expect(evidence.crashes.reports[0].exceptionType).toBe("EXC_BAD_ACCESS");
  });

  it("marks a category as unknown rather than absent when logs are unavailable", () => {
    const evidence = normalizeDiagnostics(
      { logQueryError: "log archive missing" },
      "2026-10-17T00:00:00.000Z",
      "2026-10-17T00:01:00.000Z",
    );
    expect(evidence.logs.status).toBe("unavailable");
    expect(evidence.logs.categories.watchdog).toBeNull();
    expect(evidence.logs.categories.jetsam).toBeNull();
    expect(classifyDiagnosticImpact(evidence).reasons).toContain(
      "log-evidence-unavailable",
    );
  });
});

describe("classifyDiagnosticImpact", () => {
  it("reports a new crash as a failure", () => {
    const evidence = normalizeDiagnostics(
      {
        crashIdsBefore: [],
        crashIdsAfter: ["only-one"],
        crashReports: [{ id: "only-one" }],
      },
      "2026-10-17T00:00:00.000Z",
      "2026-10-17T00:01:00.000Z",
    );
    const impact = classifyDiagnosticImpact(evidence);
    expect(impact.severity).toBe("failure");
    expect(impact.reasons).toContain("new-crash");
  });

  it("reports a device disconnect lifecycle event as a failure", () => {
    const evidence = normalizeDiagnostics(
      {
        lifecycle: [
          {
            kind: "device_disconnect",
            occurredAt: "2026-10-17T00:00:30.000Z",
          },
        ],
      },
      "2026-10-17T00:00:00.000Z",
      "2026-10-17T00:01:00.000Z",
    );
    const impact = classifyDiagnosticImpact(evidence);
    expect(impact.severity).toBe("failure");
    expect(impact.reasons).toContain("device-disconnect");
  });

  it("reports a memory warning as a warning, not a failure", () => {
    const evidence = normalizeDiagnostics(
      {
        logText: "memory pressure detected",
        crashIdsBefore: [],
        crashIdsAfter: [],
      },
      "2026-10-17T00:00:00.000Z",
      "2026-10-17T00:01:00.000Z",
    );
    const impact = classifyDiagnosticImpact(evidence);
    expect(impact.severity).toBe("warning");
    expect(impact.reasons).toContain("memory-warning");
  });

  it("reports no impact when diagnostics are clean and fully supplied", () => {
    const evidence = normalizeDiagnostics(
      {
        logText: "everything is fine",
        crashIdsBefore: ["pre-existing"],
        crashIdsAfter: ["pre-existing"],
        lifecycle: [
          {
            kind: "foreground",
            occurredAt: "2026-10-17T00:00:10.000Z",
          },
        ],
      },
      "2026-10-17T00:00:00.000Z",
      "2026-10-17T00:01:00.000Z",
    );
    const impact = classifyDiagnosticImpact(evidence);
    expect(impact.severity).toBe("none");
    expect(impact.reasons).toEqual([]);
  });

  it("marks logs/crashes/lifecycle as unavailable when nothing is supplied", () => {
    const evidence = normalizeDiagnostics(
      {},
      "2026-10-17T00:00:00.000Z",
      "2026-10-17T00:01:00.000Z",
    );
    expect(evidence.logs.status).toBe("unavailable");
    expect(evidence.crashes.status).toBe("unavailable");
    expect(evidence.lifecycle.status).toBe("unavailable");
    const impact = classifyDiagnosticImpact(evidence);
    expect(impact.severity).toBe("warning");
    expect(impact.reasons).toEqual(
      expect.arrayContaining([
        "log-evidence-unavailable",
        "crash-detection-unavailable",
        "lifecycle-evidence-unavailable",
      ]),
    );
  });

  it("upgrades springboard and system_alert lifecycle events to warning; app_exit to failure", () => {
    const cases = [
      { kind: "springboard" as const, severity: "warning" as const, code: "app-backgrounded" },
      { kind: "system_alert" as const, severity: "warning" as const, code: "system-alert" },
      { kind: "app_exit" as const, severity: "failure" as const, code: "app-exit" },
    ];
    for (const c of cases) {
      const evidence = normalizeDiagnostics(
        {
          logText: "noop",
          crashIdsBefore: [],
          crashIdsAfter: [],
          lifecycle: [
            {
              kind: c.kind,
              occurredAt: "2026-10-17T00:00:30.000Z",
            },
          ],
        },
        "2026-10-17T00:00:00.000Z",
        "2026-10-17T00:01:00.000Z",
      );
      const impact = classifyDiagnosticImpact(evidence);
      expect(impact.severity).toBe(c.severity);
      expect(impact.reasons).toContain(c.code);
    }
  });
});