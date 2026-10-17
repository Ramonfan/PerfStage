import type { JsonReport, ReportFinding } from "./json.js";
import type { DiagnosticEvidence, LogCategories } from "../diagnostics/normalize.js";

const UNKNOWN = "未知";

const LOG_CATEGORY_LABELS: Record<keyof LogCategories, string> = {
  errorOrFault: "Error/Fault",
  watchdog: "Watchdog",
  memoryWarning: "内存压力",
  jetsam: "Jetsam",
  uikitOrCoreAnimation: "UIKit/CoreAnimation",
  reactNativeOrJSC: "React Native/JavaScriptCore",
  imageNetworkUrl: "网络/图像",
};

const SEVERITY_LABELS: Record<ReportFinding["severity"], string> = {
  none: "无影响",
  warning: "告警",
  failure: "失败",
};

function triState(value: boolean | null): string {
  if (value === true) return "命中";
  if (value === false) return "未命中";
  return "未知（无法读取日志）";
}

function summarizeCrashes(diagnostics: DiagnosticEvidence): string {
  const crashes = diagnostics.crashes;
  if (crashes.status === "unavailable") {
    return `未能读取 Crash 列表，不能据此证明没有崩溃（${crashes.error ?? "无错误细节"}）`;
  }
  const newIds = crashes.newIds;
  if (newIds.length === 0) {
    return "未发现新增 Crash。";
  }
  return `发现 ${newIds.length} 个新增 Crash：${newIds.join("、")}`;
}

function summarizeLogs(diagnostics: DiagnosticEvidence): string {
  const logs = diagnostics.logs;
  if (logs.status === "unavailable") {
    return `未能读取设备日志，无法评估稳定性（${logs.error ?? "无错误细节"}）`;
  }
  return `日志共 ${logs.lineCount} 行，按类别的命中情况见下表。`;
}

function summarizeLifecycle(diagnostics: DiagnosticEvidence): string {
  const lifecycle = diagnostics.lifecycle;
  if (lifecycle.status === "unavailable") {
    return `未能读取生命周期事件（${lifecycle.error ?? "无错误细节"}）`;
  }
  if (lifecycle.events.length === 0) {
    return "本次运行未记录到生命周期事件。";
  }
  const samples = lifecycle.events
    .map((event) => `${event.kind}@${event.occurredAt}`)
    .join("，");
  return `共 ${lifecycle.events.length} 个生命周期事件：${samples}`;
}

function renderLogCategories(diagnostics: DiagnosticEvidence): string {
  const cats = diagnostics.logs.categories;
  return Object.keys(LOG_CATEGORY_LABELS)
    .map((key) => {
      const k = key as keyof LogCategories;
      return `- ${LOG_CATEGORY_LABELS[k]}：${triState(cats[k])}`;
    })
    .join("\n");
}

function renderFindings(findings: ReportFinding[]): string {
  if (findings.length === 0) {
    return "- 无额外发现。";
  }
  return findings
    .map((f) => `- [${SEVERITY_LABELS[f.severity]}] \`${f.code}\`：${f.message}`)
    .join("\n");
}

function renderMetricSection(report: JsonReport): string {
  if (report.metrics.length === 0) {
    return "- 性能指标：未采集。";
  }
  return report.metrics
    .map((metric) => {
      const value = metric.value === undefined ? "未知" : String(metric.value);
      const verdict = metric.verdict ? `（${metric.verdict}）` : "";
      return `- ${metric.name}${metric.unit ? `（${metric.unit}）` : ""}：${value}${verdict}`;
    })
    .join("\n");
}

function renderActionSection(report: JsonReport): string {
  if (report.actions.length === 0) {
    return "- 动作时间线为空。";
  }
  return report.actions
    .map((action) => {
      const ended =
        !action.endedAt || action.endedAt === "unknown" ? "未知" : action.endedAt;
      const duration =
        action.durationMs === undefined ? "未知" : `${action.durationMs}ms`;
      const error = action.error ? `\n  错误：${action.error}` : "";
      return `- ${action.actionId} [${action.outcome}] 起：${action.startedAt} 止：${ended} 持续：${duration}${error}`;
    })
    .join("\n");
}

function renderEvidence(report: JsonReport): string {
  const entries = Object.entries(report.evidencePaths);
  if (entries.length === 0) {
    return "- 未提供额外证据。";
  }
  return entries
    .map(([key, path]: [string, string]) => `- ${key}: ${path}`)
    .join("\n");
}

function renderLimits(report: JsonReport): string {
  const limits: string[] = [];
  if (report.run.endedAt === "unknown") {
    limits.push("- 结束时间戳缺失，报告中显示为 `未知`。");
  }
  if (report.diagnostics.crashes.status === "unavailable") {
    limits.push("- Crash 列表不可用，本工具不据此判定稳定性。");
  }
  if (report.diagnostics.logs.status === "unavailable") {
    limits.push("- 设备日志不可用，本工具不据此判定稳定性。");
  }
  if (report.diagnostics.lifecycle.status === "unavailable") {
    limits.push("- 生命周期事件不可用，本工具不据此判定稳定性。");
  }
  if (report.metrics.length === 0) {
    limits.push("- 未采集性能指标，结果仅供参考。");
  }
  if (limits.length === 0) {
    return "- 未发现额外限制。";
  }
  return limits.join("\n");
}

function renderPlan(report: JsonReport): string {
  if (!report.plan) {
    return [
      `**计划 ID**：${report.run.planId}`,
      "**备注**：详细方案未在本次报告中提供。",
    ].join("\n");
  }
  return [
    `**场景/计划**：${report.plan.name ?? report.plan.id ?? "未命名"}`,
    `**应用 Bundle ID**：${report.plan.app.bundleId}`,
    `**执行模式**：${report.plan.execution}`,
    `**重复次数**：${report.run.repetitions}`,
    `**备注**：${report.plan.notes ?? "无"}`,
  ].join("\n");
}

/**
 * Render a Chinese Markdown report following the section order required by
 * the brief: 总结、测试计划、动作时间线、性能指标、稳定性诊断、证据文件、
 * 限制与未知项. Unknown phase timestamps are rendered as `未知` instead of
 * being guessed, and the report tolerates a `null` plan (degrading the
 * "测试计划" section to a small note).
 */
export function renderMarkdownReport(report: JsonReport): string {
  const header = `# 性能测试报告`;

  const summary = [
    `**运行 ID**：${report.run.id}`,
    `**计划 ID**：${report.run.planId}`,
    `**开始时间**：${report.run.startedAt}`,
    `**结束时间**：${report.run.endedAt === "unknown" ? UNKNOWN : report.run.endedAt}`,
    `**最终状态**：\`${report.status}\``,
  ].join("\n");

  const stabilitySection = [
    "### 日志",
    summarizeLogs(report.diagnostics),
    "",
    renderLogCategories(report.diagnostics),
    "",
    "### Crash 列表",
    summarizeCrashes(report.diagnostics),
    "",
    "### 生命周期",
    summarizeLifecycle(report.diagnostics),
  ].join("\n");

  const evidenceLines = renderEvidence(report);
  const limitLines = renderLimits(report);
  const findingsBlock = renderFindings(report.findings);

  return [
    header,
    "",
    "## 总结",
    summary,
    "",
    "## 测试计划",
    renderPlan(report),
    "",
    "## 动作时间线",
    renderActionSection(report),
    "",
    "## 性能指标",
    renderMetricSection(report),
    "",
    "## 稳定性诊断",
    stabilitySection,
    "",
    "## 证据文件",
    evidenceLines,
    "",
    "## 限制与未知项",
    limitLines,
    "",
    "## 发现项",
    findingsBlock,
  ].join("\n");
}
