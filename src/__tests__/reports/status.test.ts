import { describe, expect, it } from "vitest";
import {
  deriveFinalStatus,
  type StatusDerivationInput,
} from "../../reports/status.js";

function input(
  overrides: Partial<StatusDerivationInput> = {},
): StatusDerivationInput {
  return {
    requestedStatus: "completed",
    diagnosticsImpact: { severity: "none", reasons: [] },
    missingEvidence: [],
    metricFailures: [],
    ...overrides,
  };
}

describe("deriveFinalStatus", () => {
  it("does not return completed when a new Crash exists", () => {
    expect(
      deriveFinalStatus(
        input({
          diagnosticsImpact: { severity: "failure", reasons: ["new-crash"] },
        }),
      ),
    ).toBe("failed");
  });

  it("returns partial when metrics are present but diagnostics are unavailable", () => {
    expect(
      deriveFinalStatus(
        input({
          diagnosticsImpact: {
            severity: "warning",
            reasons: ["crash-detection-unavailable"],
          },
        }),
      ),
    ).toBe("partial");
  });

  it("preserves explicit invalid status even when diagnostics fail", () => {
    expect(
      deriveFinalStatus(
        input({
          requestedStatus: "invalid",
          diagnosticsImpact: { severity: "failure", reasons: ["new-crash"] },
        }),
      ),
    ).toBe("invalid");
  });

  it("preserves explicit cancelled status even with metric failures", () => {
    expect(
      deriveFinalStatus(
        input({
          requestedStatus: "cancelled",
          metricFailures: ["jank_threshold_exceeded"],
        }),
      ),
    ).toBe("cancelled");
  });

  it("promotes requested failed even without diagnostics impact", () => {
    expect(
      deriveFinalStatus(
        input({ requestedStatus: "failed" }),
      ),
    ).toBe("failed");
  });

  it("returns partial when required trace evidence is missing", () => {
    expect(
      deriveFinalStatus(
        input({ missingEvidence: ["trace_archive:startup.trace"] }),
      ),
    ).toBe("partial");
  });

  it("returns partial when metric thresholds fail", () => {
    expect(
      deriveFinalStatus(
        input({ metricFailures: ["hitches"] }),
      ),
    ).toBe("partial");
  });

  it("returns failed when a main flow interruption coincides with missing evidence", () => {
    expect(
      deriveFinalStatus(
        input({
          requestedStatus: "failed",
          missingEvidence: ["trace_archive:scroll.trace"],
        }),
      ),
    ).toBe("failed");
  });

  it("returns completed only when everything is clean and requestedStatus is completed", () => {
    expect(deriveFinalStatus(input())).toBe("completed");
  });
});