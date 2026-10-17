import { describe, expect, it } from "vitest";
import {
  deriveFinalStatus,
  type FinalStatusInput,
  type StatusDerivationInput,
} from "../../reports/status.js";

describe("deriveFinalStatus", () => {
  it("preserves explicit invalid terminal status", () => {
    expect(
      deriveFinalStatus({
        requestedStatus: "invalid",
        diagnosticsImpact: { severity: "none", reasons: [] },
        missingEvidence: [],
        metricFailures: [],
      }),
    ).toBe("invalid");
  });

  it("preserves explicit cancelled terminal status", () => {
    expect(
      deriveFinalStatus({
        requestedStatus: "cancelled",
        diagnosticsImpact: { severity: "none", reasons: [] },
        missingEvidence: [],
        metricFailures: [],
      }),
    ).toBe("cancelled");
  });

  it("does not return completed when a new Crash exists", () => {
    expect(
      deriveFinalStatus({
        requestedStatus: "completed",
        diagnosticsImpact: { severity: "failure", reasons: ["new-crash"] },
        missingEvidence: [],
        metricFailures: [],
      }),
    ).toBe("failed");
  });

  it("collapses a requested failed result to failed", () => {
    expect(
      deriveFinalStatus({
        requestedStatus: "failed",
        diagnosticsImpact: { severity: "none", reasons: [] },
        missingEvidence: [],
        metricFailures: [],
      }),
    ).toBe("failed");
  });

  it("returns partial when diagnostics are unavailable but no failure", () => {
    expect(
      deriveFinalStatus({
        requestedStatus: "completed",
        diagnosticsImpact: {
          severity: "warning",
          reasons: ["crash-detection-unavailable"],
        },
        missingEvidence: [],
        metricFailures: [],
      }),
    ).toBe("partial");
  });

  it("returns partial when there is missing evidence and no failure", () => {
    expect(
      deriveFinalStatus({
        requestedStatus: "completed",
        diagnosticsImpact: { severity: "none", reasons: [] },
        missingEvidence: ["hitches.trace"],
        metricFailures: [],
      }),
    ).toBe("partial");
  });

  it("downgrades a missing-evidence run to failed when interrupted", () => {
    expect(
      deriveFinalStatus({
        requestedStatus: "completed",
        diagnosticsImpact: { severity: "none", reasons: [] },
        missingEvidence: ["hitches.trace"],
        metricFailures: [],
        interrupted: true,
      }),
    ).toBe("failed");
  });

  it("returns partial when there is a metric failure", () => {
    expect(
      deriveFinalStatus({
        requestedStatus: "completed",
        diagnosticsImpact: { severity: "none", reasons: [] },
        missingEvidence: [],
        metricFailures: ["hitches"],
      }),
    ).toBe("partial");
  });

  it("returns completed when no impact, evidence, or failure", () => {
    expect(
      deriveFinalStatus({
        requestedStatus: "completed",
        diagnosticsImpact: { severity: "none", reasons: [] },
        missingEvidence: [],
        metricFailures: [],
      }),
    ).toBe("completed");
  });

  it("treats jetsam as a failure regardless of evidence", () => {
    expect(
      deriveFinalStatus({
        requestedStatus: "completed",
        diagnosticsImpact: { severity: "failure", reasons: ["jetsam"] },
        missingEvidence: [],
        metricFailures: [],
      }),
    ).toBe("failed");
  });

  it("accepts inputs under the historical StatusDerivationInput alias", () => {
    const aliasInput: StatusDerivationInput = {
      requestedStatus: "completed",
      diagnosticsImpact: { severity: "none", reasons: [] },
      missingEvidence: [],
      metricFailures: [],
    };
    const baseline: FinalStatusInput = {
      requestedStatus: "completed",
      diagnosticsImpact: { severity: "none", reasons: [] },
      missingEvidence: [],
      metricFailures: [],
    };
    expect(deriveFinalStatus(aliasInput)).toBe(deriveFinalStatus(baseline));
  });
});
