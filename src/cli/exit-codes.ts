/**
 * CLI exit codes.
 *
 * These are the contract CI and shell scripts consume (A11), so they are
 * defined in one place and never inferred at call sites.
 *
 *   0  the Take is valid and did not miss a threshold (warn/unknown allowed)
 *   1  the Take is valid but `gate=fail` (with `--strict`, `warn` too)
 *   2  the Take itself is not trustworthy (`partial`/`failed`/`invalid`/`cancelled`)
 *   3  PerfStage could not run at all (workspace, device, dependency, input)
 *   4  the regression gate failed, or could not be evaluated
 */
export const EXIT_OK = 0;
export const EXIT_GATE_FAIL = 1;
export const EXIT_INVALID_TAKE = 2;
export const EXIT_ENVIRONMENT = 3;
export const EXIT_REGRESSION = 4;

export type ExitCode =
  | typeof EXIT_OK
  | typeof EXIT_GATE_FAIL
  | typeof EXIT_INVALID_TAKE
  | typeof EXIT_ENVIRONMENT
  | typeof EXIT_REGRESSION;

export interface ExitInput {
  status: string;
  gate: string;
  /** `--strict` promotes `warn` to a build failure. */
  strict?: boolean;
}

/**
 * Map the independent `status` / `gate` pair (D6) onto an exit code.
 *
 * Order matters: an invalid Take is code 2 even when it also missed a
 * threshold, because a failed gate on untrustworthy evidence means nothing.
 */
export function exitCodeFor(input: ExitInput): ExitCode {
  if (input.status !== "completed") {
    return EXIT_INVALID_TAKE;
  }
  if (input.gate === "fail") {
    return EXIT_GATE_FAIL;
  }
  if (input.gate === "warn" && input.strict === true) {
    return EXIT_GATE_FAIL;
  }
  return EXIT_OK;
}

export interface RegressionExitInput {
  /** The Take's own status, independent from the regression verdict. */
  takeStatus: string;
  status: "pass" | "fail" | "not-evaluated";
  /**
   * `--allow-not-evaluated` keeps a green build when the gate could not
   * answer. A `fail` is never relaxed; the JSON still records the reason.
   */
  allowNotEvaluated?: boolean;
}

/**
 * Map the regression verdict (C3) onto an exit code.
 *
 * This deliberately does not look at `target.gate`: regression against the
 * baseline and the absolute threshold are two independent signals. An
 * untrustworthy Take stays code 2 because a verdict on bad evidence is
 * meaningless; `not-evaluated` is fail-closed by default.
 */
export function exitCodeForRegression(input: RegressionExitInput): ExitCode {
  if (input.takeStatus !== "completed") {
    return EXIT_INVALID_TAKE;
  }
  if (input.status === "fail") {
    return EXIT_REGRESSION;
  }
  if (input.status === "not-evaluated") {
    return input.allowNotEvaluated === true ? EXIT_OK : EXIT_REGRESSION;
  }
  return EXIT_OK;
}
