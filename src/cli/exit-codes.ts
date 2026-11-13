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
 */
export const EXIT_OK = 0;
export const EXIT_GATE_FAIL = 1;
export const EXIT_INVALID_TAKE = 2;
export const EXIT_ENVIRONMENT = 3;

export type ExitCode =
  | typeof EXIT_OK
  | typeof EXIT_GATE_FAIL
  | typeof EXIT_INVALID_TAKE
  | typeof EXIT_ENVIRONMENT;

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
