import { describe, expect, it } from "vitest";
import { deriveFindings } from "../../reports/findings.js";

function findings(overrides: {
  reasons: string[];
  severity: "none" | "warning" | "failure";
}) {
  return deriveFindings({
    diagnosticsImpact: {
      severity: overrides.severity,
      reasons: overrides.reasons,
    },
    missingEvidence: [],
    metricFailures: [],
    requestedStatus: "completed",
    finalStatus: "completed",
  });
}

describe("deriveFindings", () => {
  it("labels each diagnostic reason with its own severity", () => {
    // Real-device Take: a new crash made the Take untrustworthy while the
    // device log was also unreadable. The log loss is a warning, not a second
    // failure — reporting it as `failure` reads like the log itself broke.
    const result = findings({
      reasons: ["new-crash", "log-evidence-unavailable"],
      severity: "failure",
    });

    expect(result).toEqual([
      expect.objectContaining({ code: "new-crash", severity: "failure" }),
      expect.objectContaining({
        code: "log-evidence-unavailable",
        severity: "warning",
      }),
    ]);
  });

  it("keeps availability warnings as warnings when nothing failed", () => {
    const result = findings({
      reasons: ["crash-detection-unavailable", "lifecycle-evidence-unavailable"],
      severity: "warning",
    });

    expect(result.every((finding) => finding.severity === "warning")).toBe(true);
  });

  it("treats observed instability as failures", () => {
    const result = findings({
      reasons: ["jetsam", "watchdog", "device-disconnect"],
      severity: "failure",
    });

    expect(result.every((finding) => finding.severity === "failure")).toBe(true);
  });
});
