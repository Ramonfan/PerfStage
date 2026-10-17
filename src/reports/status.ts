import type { RunStatus } from "../model/test-run.js";
import type { DiagnosticImpact } from "../diagnostics/normalize.js";

export interface FinalStatusInput {
  requestedStatus: RunStatus;
  diagnosticsImpact: DiagnosticImpact;
  missingEvidence: string[];
  metricFailures: string[];
  interrupted?: boolean;
}

/**
 * Resolve the final status of a performance test run using a single, documented
 * precedence rule:
 *
 * 1. Explicit terminal overrides (`invalid`, `cancelled`) win immediately.
 * 2. Diagnostic `failure` impact OR a requested `failed` collapses everything
 *    to `failed` — a new Crash, jetsam, watchdog, or device disconnect means
 *    the run cannot be considered successful in any form.
 * 3. Missing trace/metric evidence or any metric failure downgrades the run
 *    to at least `partial`. If the test flow was interrupted the result is
 *    `failed`, otherwise `partial` so the user understands the test ended
 *    without the full picture.
 * 4. Warning/unavailable diagnostics still marks the run `partial` — we never
 *    claim a clean pass when logs or crash listings could not be verified.
 * 5. Only a `completed` request, with no missing evidence, no metric failures,
 *    and no diagnostic impact, stays `completed`.
 *
 * Input validation: `requestedStatus` is required, but `diagnosticsImpact`,
 * `missingEvidence`, `metricFailures`, and `interrupted` all have sane
 * defaults so callers can omit fields they don't track.
 */
export function deriveFinalStatus(input: FinalStatusInput): RunStatus {
  const requested = input.requestedStatus;
  if (requested === "invalid" || requested === "cancelled") {
    return requested;
  }

  // Explicit `partial` requests are preserved verbatim regardless of
  // any failure impact, missing evidence, or interruption. The
  // caller has already accepted that the run is partial; coercing
  // it to `failed` would conceal the intent of the caller.
  if (requested === "partial") {
    return "partial";
  }

  // Prepared / running are not valid terminal outcomes; we never
  // accept them in the finalize surface (the tool layer rejects them
  // up front), but if somehow invoked we still do NOT coerce them
  // into a terminal status — we treat them as `invalid` so the
  // discrepancy is visible.
  if (requested === "prepared" || requested === "running") {
    return "invalid";
  }

  const impact = input.diagnosticsImpact ?? {
    severity: "none",
    reasons: [],
  };
  const missingEvidence = input.missingEvidence ?? [];
  const metricFailures = input.metricFailures ?? [];
  const interrupted = input.interrupted ?? false;

  const hasFailureImpact = impact.severity === "failure";
  const hasExplicitFailure = requested === "failed";

  if (hasFailureImpact || hasExplicitFailure) {
    return "failed";
  }

  const hasMissingCritical =
    missingEvidence.length > 0 || metricFailures.length > 0;
  if (hasMissingCritical) {
    return interrupted ? "failed" : "partial";
  }

  const hasWarningImpact = impact.severity === "warning";
  if (hasWarningImpact) {
    return "partial";
  }

  if (requested === "completed") {
    return "completed";
  }

  // Any other requested status falls through — by this point the
  // only remaining options are the terminal ones already handled
  // above. Returning the caller's value keeps the function tolerant
  // of new statuses without silently coalescing them.
  return requested;
}
