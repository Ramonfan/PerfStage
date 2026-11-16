import type { ZodIssue } from "zod";

/**
 * Diagnostic settings were removed in v0.1 because the runner never read them.
 * A bare zod "Unrecognized key" line names the field but not the reason, so
 * every rejected input path also gets the migration pointer.
 */
const REMOVED_DIAGNOSTIC_FIELDS = new Set([
  "diagnostics",
  "diagnosticOverrides",
]);

const REMOVED_DIAGNOSTIC_HINT =
  "诊断采集字段已在 v0.1 移除；设备日志 / Crash / 生命周期证据按既有行为采集，网络抓包与失败截图不在 v0.1 范围。迁移说明见 docs/release-notes/v0.1.0.md";

/**
 * Union issues only carry `Invalid input` at the top level; without the branch
 * messages a mistyped `device: { id: 5 }` loses the useful detail.
 */
function issueMessage(issue: ZodIssue): string {
  if (issue.code === "invalid_union") {
    const nested = [...new Set(issue.errors.flat().map((entry) => entry.message))];
    if (nested.length > 0) {
      return `${issue.message}（${nested.join(" / ")}）`;
    }
  }
  return issue.message;
}

/**
 * Render zod issues as one human-readable line, adding the removal hint when a
 * caller still sends a removed diagnostic field.
 */
export function describeInputIssues(issues: readonly ZodIssue[]): string {
  const parts = issues.map(
    (issue) => `${issue.path.join(".") || "(root)"}: ${issueMessage(issue)}`,
  );
  const removedDiagnosticField = issues.some(
    (issue) =>
      issue.code === "unrecognized_keys" &&
      issue.keys.some((key) => REMOVED_DIAGNOSTIC_FIELDS.has(key)),
  );
  if (removedDiagnosticField) {
    parts.push(REMOVED_DIAGNOSTIC_HINT);
  }
  return parts.join("; ");
}
