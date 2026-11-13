import { describe, expect, it } from "vitest";
import { deriveRunOutcome } from "../../reports/outcome.js";

const NO_IMPACT = { severity: "none" as const, reasons: [] };
const WARNING = {
  severity: "warning" as const,
  reasons: ["crash-detection-unavailable"],
};
const FAILURE = { severity: "failure" as const, reasons: ["new-crash"] };

describe("deriveRunOutcome", () => {
  it("preserves invalid and cancelled with an unknown gate", () => {
    expect(
      deriveRunOutcome({
        requestedStatus: "invalid",
        diagnosticsImpact: NO_IMPACT,
        missingEvidence: [],
        metricVerdicts: [],
      }),
    ).toEqual({ status: "invalid", gate: "unknown" });

    expect(
      deriveRunOutcome({
        requestedStatus: "cancelled",
        diagnosticsImpact: NO_IMPACT,
        missingEvidence: [],
        metricVerdicts: [],
      }),
    ).toEqual({ status: "cancelled", gate: "unknown" });
  });

  it("fails the Take and the gate on a new Crash", () => {
    expect(
      deriveRunOutcome({
        requestedStatus: "completed",
        diagnosticsImpact: FAILURE,
        missingEvidence: [],
        metricVerdicts: ["pass"],
      }),
    ).toEqual({ status: "failed", gate: "fail" });
  });

  it("fails the Take but leaves the gate unknown when an action failed", () => {
    expect(
      deriveRunOutcome({
        requestedStatus: "completed",
        diagnosticsImpact: NO_IMPACT,
        missingEvidence: [],
        metricVerdicts: ["pass"],
        interrupted: true,
      }),
    ).toEqual({ status: "failed", gate: "unknown" });
  });

  it("returns partial/unknown when evidence is missing", () => {
    expect(
      deriveRunOutcome({
        requestedStatus: "completed",
        diagnosticsImpact: NO_IMPACT,
        missingEvidence: ["trace:hitches"],
        metricVerdicts: ["pass"],
      }),
    ).toEqual({ status: "partial", gate: "unknown" });
  });

  it("returns partial/unknown when diagnostics are unavailable", () => {
    expect(
      deriveRunOutcome({
        requestedStatus: "completed",
        diagnosticsImpact: WARNING,
        missingEvidence: [],
        metricVerdicts: ["pass"],
      }),
    ).toEqual({ status: "partial", gate: "unknown" });
  });

  it("keeps status completed and fails the gate on a metric failure (D6)", () => {
    expect(
      deriveRunOutcome({
        requestedStatus: "completed",
        diagnosticsImpact: NO_IMPACT,
        missingEvidence: [],
        metricVerdicts: ["pass", "fail"],
      }),
    ).toEqual({ status: "completed", gate: "fail" });
  });

  it("keeps status completed and warns the gate on a metric warning", () => {
    expect(
      deriveRunOutcome({
        requestedStatus: "completed",
        diagnosticsImpact: NO_IMPACT,
        missingEvidence: [],
        metricVerdicts: ["pass", "warn"],
      }),
    ).toEqual({ status: "completed", gate: "warn" });
  });

  it("returns completed/pass for a clean complete Take", () => {
    expect(
      deriveRunOutcome({
        requestedStatus: "completed",
        diagnosticsImpact: NO_IMPACT,
        missingEvidence: [],
        metricVerdicts: ["pass", "pass"],
      }),
    ).toEqual({ status: "completed", gate: "pass" });
  });

  it("returns completed/unknown when no metric was evaluated", () => {
    expect(
      deriveRunOutcome({
        requestedStatus: "completed",
        diagnosticsImpact: NO_IMPACT,
        missingEvidence: [],
        metricVerdicts: [],
      }),
    ).toEqual({ status: "completed", gate: "unknown" });
  });
});
