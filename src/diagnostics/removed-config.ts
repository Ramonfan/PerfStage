import type { ZodIssue } from "zod";

/**
 * Removed input fields used to fail as a bare zod `Unrecognized key` line:
 * the field name appears, but not what replaced it. Every rejected input path
 * (`prepare_performance_test`, `run_performance_test`, scenario YAML) funnels
 * through {@link describeInputIssues}, so the migration pointer is attached in
 * one place.
 *
 * Groups are kept separate because the removals happened for different reasons
 * and point at different replacements.
 */
interface RemovedFieldGroup {
  fields: ReadonlySet<string>;
  hint: string;
  /**
   * When set, the hint only applies if the rejection path mentions this
   * segment. `preconditions[].check` is a nested key; a generic top-level
   * `check` typo must not receive the precondition migration advice.
   */
  pathIncludes?: string;
}

const REMOVED_FIELD_GROUPS: readonly RemovedFieldGroup[] = [
  {
    fields: new Set(["diagnostics", "diagnosticOverrides"]),
    hint: "诊断采集字段已在 v0.1 移除；设备日志 / Crash / 生命周期证据按既有行为采集，网络抓包与失败截图不在范围。迁移说明见 docs/release-notes/v0.1.0.md",
  },
  {
    fields: new Set(["analysisFocus", "execution"]),
    hint: "analysisFocus 与 execution 已移除且不再有任何效果：分析范围由 metrics 决定，交互与非交互由调用的工具入口表达（run_performance_test 一键执行，prepare + finalize 人工接管）。迁移说明见 README §8",
  },
  {
    fields: new Set(["check"]),
    hint: "preconditions[].check 已移除：它是从未被求值的伪表达式，请改用 foregroundBundleId / accessibilityText，由运行期在评分窗口前校验",
    pathIncludes: "preconditions",
  },
];

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
 * caller still sends a field that no longer exists.
 */
export function describeInputIssues(issues: readonly ZodIssue[]): string {
  const parts = issues.map(
    (issue) => `${issue.path.join(".") || "(root)"}: ${issueMessage(issue)}`,
  );
  const unrecognized = issues.filter(
    (issue): issue is Extract<ZodIssue, { code: "unrecognized_keys" }> =>
      issue.code === "unrecognized_keys",
  );
  for (const group of REMOVED_FIELD_GROUPS) {
    const hit = unrecognized.some(
      (issue) =>
        issue.keys.some((key) => group.fields.has(key)) &&
        (group.pathIncludes === undefined ||
          issue.path.join(".").includes(group.pathIncludes)),
    );
    if (hit) {
      parts.push(group.hint);
    }
  }
  return parts.join("; ");
}
