import type { JsonReport, ReportFinding } from "./json.js";
import type {
  CrashEvidence,
  DiagnosticEvidence,
  LifecycleEvidence,
  LogCategories,
  LogEvidence,
} from "../diagnostics/normalize.js";

/**
 * Render a self-contained HTML report from an already-persisted
 * `report.json`.
 *
 * The exporter deliberately takes the stored report as its only input: what
 * the user opens must be exactly the Take that was judged, not a second
 * derivation from `run.json` that could drift from `report.md`. The renderer
 * is therefore pure — no filesystem access, no clock, no network — so the
 * same report always produces the same bytes.
 *
 * The page must work offline: all styling is inline, there is no JavaScript,
 * and no external stylesheet, font, image or URL is referenced. Everything
 * that comes from run data is escaped before interpolation.
 */

const UNKNOWN = "未知";
const NOT_RECORDED = "未记录";

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

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** Coerce report data to display text without ever rendering `undefined`. */
function text(value: unknown, fallback: string = UNKNOWN): string {
  if (value === undefined || value === null) return fallback;
  const rendered = String(value);
  return rendered.length === 0 ? fallback : rendered;
}

function paragraph(value: unknown, fallback: string = UNKNOWN): string {
  return `<p>${escapeHtml(text(value, fallback))}</p>`;
}

function list(items: readonly string[]): string {
  if (items.length === 0) {
    return "<p>无。</p>";
  }
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function triState(value: boolean | null | undefined): string {
  if (value === true) return "命中";
  if (value === false) return "未命中";
  return "未知（无法读取日志）";
}

function summarizeCrashes(crashes: CrashEvidence | null | undefined): string {
  if (crashes === undefined || crashes === null) {
    return "未记录 Crash 证据。";
  }
  if (crashes.status === "unavailable") {
    return `未能读取 Crash 列表，不能据此证明没有崩溃（${
      crashes.error ?? "无错误细节"
    }）`;
  }
  const newIds = crashes.newIds ?? [];
  const ignoredIds = crashes.ignoredIds ?? [];
  const ignored =
    ignoredIds.length > 0
      ? `（另有 ${ignoredIds.length} 个已知系统报告记录为证据：${ignoredIds.join(
          "、",
        )}）`
      : "";
  if (newIds.length === 0) {
    return `未发现新增 App Crash。${ignored}`.trim();
  }
  return `发现 ${newIds.length} 个新增 Crash：${newIds.join("、")}${ignored}`;
}

function summarizeLogs(logs: LogEvidence | null | undefined): string {
  if (logs === undefined || logs === null) {
    return "未记录设备日志证据。";
  }
  if (logs.status === "unavailable") {
    return `未能读取设备日志，无法评估稳定性（${
      logs.error ?? "无错误细节"
    }）`;
  }
  if (logs.truncated === true) {
    return `日志共 ${text(logs.lineCount, NOT_RECORDED)} 行，但日志流在 Take 结束前中断，内容不完整（${
      logs.truncationReason ?? "未提供原因"
    }）。`;
  }
  return `日志共 ${text(logs.lineCount, NOT_RECORDED)} 行。`;
}

function summarizeLifecycle(
  lifecycle: LifecycleEvidence | null | undefined,
): string {
  if (lifecycle === undefined || lifecycle === null) {
    return "未记录生命周期证据。";
  }
  if (lifecycle.status === "unavailable") {
    return `未能读取生命周期事件（${lifecycle.error ?? "无错误细节"}）`;
  }
  const events = lifecycle.events ?? [];
  if (events.length === 0) {
    return "本次运行未记录到生命周期事件。";
  }
  const samples = events
    .map((event) => `${event.kind}@${event.occurredAt}`)
    .join("，");
  return `共 ${events.length} 个生命周期事件：${samples}`;
}

function renderLogCategories(logs: LogEvidence | undefined): string {
  const categories = logs?.categories;
  const rows = Object.keys(LOG_CATEGORY_LABELS)
    .map((key) => {
      const category = key as keyof LogCategories;
      return `<tr><th scope="row">${escapeHtml(
        LOG_CATEGORY_LABELS[category],
      )}</th><td>${escapeHtml(triState(categories?.[category]))}</td></tr>`;
    })
    .join("");
  return `<table><tbody>${rows}</tbody></table>`;
}

function renderSummary(report: JsonReport): string {
  const rows: Array<[string, string]> = [
    ["运行 ID", text(report.run?.id)],
    ["计划 ID", text(report.run?.planId)],
    ["开始时间", text(report.run?.startedAt)],
    ["结束时间", text(report.run?.endedAt === "unknown" ? UNKNOWN : report.run?.endedAt)],
    ["最终状态", text(report.status)],
    ["门禁结果", text(report.gate)],
  ];
  const body = rows
    .map(
      ([label, value]) =>
        `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(
          value,
        )}</td></tr>`,
    )
    .join("");
  return `<table class="summary"><tbody>${body}</tbody></table>`;
}

function renderPlan(report: JsonReport): string {
  if (!report.plan) {
    return list([
      `计划 ID：${text(report.run?.planId)}`,
      "详细方案未在本次报告中提供（未记录）。",
    ]);
  }
  return list([
    `场景/计划：${text(report.plan.name ?? report.plan.id)}`,
    `应用 Bundle ID：${text(report.plan.app?.bundleId)}`,
    `重复次数：${text(report.run?.repetitions)}`,
    `备注：${text(report.plan.notes, "无")}`,
  ]);
}

function renderActions(report: JsonReport): string {
  const actions = report.actions ?? [];
  if (actions.length === 0) {
    return "<p>动作时间线为空。</p>";
  }
  const rows = actions
    .map((action) => {
      const ended =
        action.endedAt === undefined ||
        action.endedAt === null ||
        action.endedAt === "unknown"
          ? UNKNOWN
          : action.endedAt;
      const duration =
        action.durationMs === undefined || action.durationMs === null
          ? UNKNOWN
          : `${action.durationMs}ms`;
      return [
        "<tr>",
        `<td>${escapeHtml(text(action.actionId))}</td>`,
        `<td>${escapeHtml(text(action.outcome))}</td>`,
        `<td>${escapeHtml(text(action.attempts))}</td>`,
        `<td>${escapeHtml(text(action.startedAt))}</td>`,
        `<td>${escapeHtml(text(ended))}</td>`,
        `<td>${escapeHtml(duration)}</td>`,
        `<td>${escapeHtml(text(action.error, "—"))}</td>`,
        "</tr>",
      ].join("");
    })
    .join("");
  return [
    "<table>",
    "<thead><tr>",
    "<th scope=\"col\">动作</th>",
    "<th scope=\"col\">结果</th>",
    "<th scope=\"col\">尝试</th>",
    "<th scope=\"col\">开始</th>",
    "<th scope=\"col\">结束</th>",
    "<th scope=\"col\">持续</th>",
    "<th scope=\"col\">错误</th>",
    "</tr></thead>",
    `<tbody>${rows}</tbody>`,
    "</table>",
  ].join("");
}

function renderMetrics(report: JsonReport): string {
  const metrics = report.metrics ?? [];
  if (metrics.length === 0) {
    return "<p>性能指标：未采集。</p>";
  }
  const rows = metrics
    .map((metric) => {
      const value =
        metric.value === undefined || metric.value === null
          ? UNKNOWN
          : String(metric.value);
      return [
        "<tr>",
        `<td>${escapeHtml(text(metric.name))}</td>`,
        `<td>${escapeHtml(value)}</td>`,
        `<td>${escapeHtml(text(metric.unit, "—"))}</td>`,
        `<td>${escapeHtml(text(metric.verdict, "—"))}</td>`,
        "</tr>",
      ].join("");
    })
    .join("");
  return [
    "<table>",
    "<thead><tr>",
    "<th scope=\"col\">指标</th>",
    "<th scope=\"col\">数值</th>",
    "<th scope=\"col\">单位</th>",
    "<th scope=\"col\">判定</th>",
    "</tr></thead>",
    `<tbody>${rows}</tbody>`,
    "</table>",
  ].join("");
}

function renderNotes(report: JsonReport): string {
  const notes = report.run?.notes;
  if (typeof notes !== "string" || notes.trim().length === 0) {
    return "<p>无执行备注。</p>";
  }
  const items = notes
    .split(" | ")
    .map((note) => note.trim())
    .filter((note) => note.length > 0);
  return list(items);
}

function renderRecording(report: JsonReport): string {
  const passes = report.run?.passes ?? [];
  if (passes.length === 0) {
    return "<p>未记录 pass 信息。</p>";
  }
  const items = passes.map((pass) => {
    const recording = pass.recording;
    if (recording === undefined || recording === null) {
      return `${pass.template}：未记录录制配置（早于 profile 字段的 run）。`;
    }
    const facts = [
      `profile ${recording.profile}`,
      `模板 ${recording.template}`,
    ];
    if (recording.instruments !== undefined && recording.instruments.length > 0) {
      facts.push(`instrument ${recording.instruments.join("、")}`);
    }
    facts.push(`时间上限 ${recording.timeLimit}`);
    if (recording.duringTimeoutMs !== undefined) {
      facts.push(`动作回放超时 ${recording.duringTimeoutMs}ms`);
    }
    if (recording.liveTimeoutMs !== undefined) {
      facts.push(`等待 live 超时 ${recording.liveTimeoutMs}ms`);
    }
    facts.push(`窗口 ${recording.window ?? NOT_RECORDED}`);
    const missing =
      recording.missingDiagnostics !== undefined &&
      recording.missingDiagnostics.length > 0
        ? `。未记录：${recording.missingDiagnostics.join("；")}；该 trace 不是完整诊断 trace`
        : "";
    return `${pass.template}：${facts.join("，")}${missing}`;
  });
  return list(items);
}

function renderDiagnostics(report: JsonReport): string {
  const diagnostics = report.diagnostics as
    | Partial<DiagnosticEvidence>
    | undefined;
  return [
    "<h3>日志</h3>",
    paragraph(summarizeLogs(diagnostics?.logs)),
    renderLogCategories(diagnostics?.logs),
    "<h3>Crash 列表</h3>",
    paragraph(summarizeCrashes(diagnostics?.crashes)),
    "<h3>生命周期</h3>",
    paragraph(summarizeLifecycle(diagnostics?.lifecycle)),
  ].join("");
}

function renderEvidence(report: JsonReport): string {
  const entries = Object.entries(report.evidencePaths ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  if (entries.length === 0) {
    return "<p>未提供额外证据。</p>";
  }
  return list(entries.map(([kind, path]) => `${kind}: ${text(path, NOT_RECORDED)}`));
}

function renderLimits(report: JsonReport): string {
  const limits: string[] = [];
  const compactPasses = (report.run?.passes ?? []).filter(
    (pass) => pass.recording?.profile === "compact",
  );
  if (compactPasses.length > 0) {
    limits.push(
      `${compactPasses
        .map((pass) => pass.template)
        .join("、")} pass 使用紧凑录制配置，缺少 Time Profiler、Metal 等诊断表；不要当作完整诊断 trace。`,
    );
  }
  if (report.run?.endedAt === "unknown" || report.run?.endedAt === null) {
    limits.push("结束时间戳缺失，报告中显示为「未知」。");
  }
  const diagnostics = report.diagnostics as
    | Partial<DiagnosticEvidence>
    | undefined;
  if (diagnostics?.crashes?.status === "unavailable") {
    limits.push("Crash 列表不可用，本工具不据此判定稳定性。");
  }
  if (diagnostics?.logs?.status === "unavailable") {
    limits.push("设备日志不可用，本工具不据此判定稳定性。");
  }
  if (diagnostics?.logs?.truncated === true) {
    limits.push("设备日志不完整，结论按 partial 处理。");
  }
  if (diagnostics?.lifecycle?.status === "unavailable") {
    limits.push("生命周期事件不可用，本工具不据此判定稳定性。");
  }
  if ((report.metrics ?? []).length === 0) {
    limits.push("未采集性能指标，结果仅供参考。");
  }
  if (limits.length === 0) {
    return "<p>未发现额外限制。</p>";
  }
  return list(limits);
}

function renderFindings(report: JsonReport): string {
  const findings = report.findings ?? [];
  if (findings.length === 0) {
    return "<p>无额外发现。</p>";
  }
  return list(
    findings.map(
      (finding) =>
        `[${SEVERITY_LABELS[finding.severity] ?? finding.severity}] ${
          finding.code
        }：${finding.message}`,
    ),
  );
}

const STYLE = [
  ":root{color-scheme:light dark}",
  "body{margin:0;padding:2rem 1rem;font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7f7f8;color:#1c1c1e}",
  "main{max-width:60rem;margin:0 auto;background:#fff;padding:2rem;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.08)}",
  "h1{font-size:1.6rem;margin:0 0 .25rem}",
  "h2{font-size:1.2rem;margin:2rem 0 .75rem;padding-bottom:.35rem;border-bottom:1px solid #e5e5ea}",
  "h3{font-size:1rem;margin:1.25rem 0 .5rem}",
  "p{margin:.35rem 0}",
  "ul{margin:.35rem 0;padding-left:1.25rem}",
  "table{width:100%;border-collapse:collapse;margin:.5rem 0}",
  "th,td{text-align:left;padding:.45rem .6rem;border-bottom:1px solid #ececf0;vertical-align:top}",
  "th{font-weight:600;background:#fafafc}",
  "footer{margin-top:2rem;padding-top:1rem;border-top:1px solid #e5e5ea;color:#6e6e73;font-size:.85rem}",
  "@media (prefers-color-scheme:dark){body{background:#111113;color:#f2f2f7}main{background:#1c1c1e;box-shadow:none}th{background:#2c2c2e}th,td{border-color:#3a3a3c}h2,footer{border-color:#3a3a3c}footer{color:#98989d}}",
].join("");

export function renderHtmlReport(report: JsonReport): string {
  const runId = text(report.run?.id);
  const generatedAt = text(report.generatedAt);

  return [
    "<!DOCTYPE html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>性能测试报告 — ${escapeHtml(runId)}</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    "<main>",
    "<h1>性能测试报告</h1>",
    `<p>运行 ${escapeHtml(runId)} · 状态 ${escapeHtml(
      text(report.status),
    )} · 门禁 ${escapeHtml(text(report.gate))}</p>`,
    "<h2>总结</h2>",
    renderSummary(report),
    "<h2>测试计划</h2>",
    renderPlan(report),
    "<h2>动作时间线</h2>",
    renderActions(report),
    "<h2>性能指标</h2>",
    renderMetrics(report),
    "<h2>执行记录</h2>",
    renderNotes(report),
    "<h2>录制配置</h2>",
    renderRecording(report),
    "<h2>稳定性诊断</h2>",
    renderDiagnostics(report),
    "<h2>证据文件</h2>",
    renderEvidence(report),
    "<h2>限制与未知项</h2>",
    renderLimits(report),
    "<h2>发现项</h2>",
    renderFindings(report),
    `<footer>由 PerfStage 从 report.json 生成 · ${escapeHtml(generatedAt)}</footer>`,
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
