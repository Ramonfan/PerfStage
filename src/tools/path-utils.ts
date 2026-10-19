import { posix } from "node:path";

/**
 * Build a workspace-relative path to a file inside the run directory.
 *
 * When `runsRoot` is supplied (the production workspace path), the
 * returned string is the full workspace-relative POSIX path
 * (`<runsRoot>/<runId>/<fileName>`). This is the path the README and
 * verification note promise: "report lives at the current project's
 * `.performance-test/runs/<runId>/…`".
 *
 * When `runsRoot` is omitted (legacy harnesses that bootstrap a
 * scenario directory without a workspace), the helper falls back to
 * returning the run-relative path so existing tests stay honest.
 */
export function buildRunRelativePath(
  runsRoot: string | undefined,
  runId: string,
  fileName: string,
): string {
  if (typeof runsRoot === "string" && runsRoot.length > 0) {
    return posix.join(runsRoot, runId, fileName);
  }
  return posix.join(fileName);
}