import type { RunStatus } from "../model/test-run.js";
import type { DiagnosticImpact } from "../diagnostics/normalize.js";

export interface StatusDerivationInput {
  requestedStatus: RunStatus;
  diagnosticsImpact: DiagnosticImpact;
  missingEvidence: string[];
  metricFailures: string[];
}

/**
 * Determines the final status of a test run by combining the runtime-reported
 * status with the outcomes of the metric, evidence, and stability checks.
 *
 * Precedence (most restrictive wins):
 *   1. `invalid` and `cancelled` are sticky — callers declared the run could
 *      not start or was aborted intentionally, and no downstream signal may
 *      promote them to a healthier status.
 *   2. A `failure` diagnostic impact or a `failed` requested status forces
 *      `failed`. The main flow was interrupted, so missing evidence or
 *      threshold failures must not mask that with a `partial` verdict.
 *   3. Missing required evidence, threshold failures, or a `warning`
 *      diagnostic impact degrade the run to `partial`. The run executed,
 *      but the report can only cover part of what was promised.
 *   4. Only a clean run that requested `completed` keeps `completed`.
 */
export function deriveFinalStatus(input: StatusDerivationInput): RunStatus {
  if (input.requestedStatus === "invalid") {
    return "invalid";
  }
  if (input.requestedStatus === "cancelled") {
    return "cancelled";
  }

  if (
    input.diagnosticsImpact.severity === "failure" ||
    input.requestedStatus === "failed"
  ) {
    return "failed";
  }

  const hasMissingEvidence = input.missingEvidence.length > 0;
  const hasMetricFailures = input.metricFailures.length > 0;
  const warningImpact = input.diagnosticsImpact.severity === "warning";

  if (hasMissingEvidence || hasMetricFailures || warningImpact) {
    return "partial";
  }

  if (input.requestedStatus === "completed") {
    return "completed";
  }

  // `prepared` or `running` cannot legitimately reach this code path because
  // status derivation is only meaningful at end-of-run. Surface the anomaly
  // by reporting `failed` rather than fabricating a healthy verdict.
  return "failed";
}