import type { JsonReport, ReportMetric } from "./json.js";
import type { GateResult, RunStatus } from "../model/test-run.js";

/**
 * Render a JUnit XML report from an already-persisted `report.json`.
 *
 * One Take maps to one `<testsuite>` so a CI job can publish individual runs
 * without merging them first. The exporter never re-judges the Take: the
 * verdicts come from the stored report, and a successful export always exits
 * 0 regardless of `gate`. What CI does with the failures is the caller's
 * decision.
 *
 * The output is a well-formed XML 1.0 document: report text is sanitised
 * (illegal control characters and lone surrogates removed) and escaped before
 * interpolation. No XML library is used, keeping the runtime dependency-free.
 */

type JUnitStatus = "passed" | "failed" | "skipped";

interface JUnitCase {
  name: string;
  className: string;
  status: JUnitStatus;
  message?: string;
  systemOut?: string[];
}

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/**
 * Drop characters that XML 1.0 cannot represent. `for..of` iterates code
 * points, so a well-formed surrogate pair arrives as one code point > 0xFFFF
 * and is kept; a lone surrogate arrives as itself and is dropped.
 */
function sanitizeXmlText(value: string): string {
  let out = "";
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd) {
      out += char;
      continue;
    }
    if (codePoint < 0x20) continue;
    if (codePoint === 0xfffe || codePoint === 0xffff) continue;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
    out += char;
  }
  return out;
}

function escapeXml(value: string): string {
  return sanitizeXmlText(value).replace(
    /[&<>"']/g,
    (char) => XML_ESCAPES[char] ?? char,
  );
}

function display(value: unknown, fallback = "未知"): string {
  if (value === undefined || value === null) return fallback;
  const rendered = String(value);
  return rendered.length === 0 ? fallback : rendered;
}

function metricValue(metric: ReportMetric): string {
  if (metric.value === undefined || metric.value === null) return "未知";
  return `${display(metric.value)}${metric.unit ? ` ${metric.unit}` : ""}`;
}

function metricCase(metric: ReportMetric): JUnitCase {
  const name = `metric:${metric.name}`;
  const systemOut = [`数值：${metricValue(metric)}`];
  if (metric.threshold !== undefined) {
    systemOut.push(`阈值：${JSON.stringify(metric.threshold)}`);
  }
  const verdict = metric.verdict;
  if (verdict === "fail") {
    return {
      name,
      className: "metrics",
      status: "failed",
      message: `指标 ${metric.name} 未通过阈值（${metricValue(metric)}）`,
      systemOut,
    };
  }
  const hasValue = metric.value !== undefined && metric.value !== null;
  if (verdict === "unknown" || verdict === "skipped" || !hasValue) {
    return {
      name,
      className: "metrics",
      status: "skipped",
      message: `指标 ${metric.name} 未产生可用判定`,
      systemOut,
    };
  }
  if (verdict === "warn") {
    systemOut.push("verdict=warn：触发告警阈值，未越过失败阈值");
  }
  return { name, className: "metrics", status: "passed", systemOut };
}

function gateCase(gate: GateResult | null | undefined): JUnitCase {
  // Only an explicit pass/warn may look green. Everything else — including
  // `unknown`, a missing field or an unrecognised future value — is a gate
  // that could not be evaluated and must stay visible in CI.
  if (gate === "fail") {
    return {
      name: "gate",
      className: "gate",
      status: "failed",
      message: "阈值门禁失败（gate=fail）",
    };
  }
  if (gate === "pass") {
    return { name: "gate", className: "gate", status: "passed" };
  }
  if (gate === "warn") {
    return {
      name: "gate",
      className: "gate",
      status: "passed",
      systemOut: ["gate=warn：存在告警，未构成失败"],
    };
  }
  return {
    name: "gate",
    className: "gate",
    status: "skipped",
    message: "门禁无法评估（gate=unknown 或未记录）",
  };
}

function runStatusCase(status: RunStatus | string | undefined): JUnitCase {
  if (status === "completed") {
    return { name: "run-status", className: "run", status: "passed" };
  }
  return {
    name: "run-status",
    className: "run",
    status: "failed",
    message: `运行状态为 ${display(status)}，不是 completed`,
  };
}

function findingCases(report: JsonReport): JUnitCase[] {
  return (report.findings ?? []).map((finding) => {
    if (finding.severity === "failure") {
      return {
        name: `finding:${finding.code}`,
        className: "findings",
        status: "failed" as const,
        message: finding.message,
        systemOut: [`severity=${finding.severity}`],
      };
    }
    // JUnit has no warning verdict: keep the case green so a warning does not
    // fail the build, but never drop its message from the artifact.
    return {
      name: `finding:${finding.code}`,
      className: "findings",
      status: "passed" as const,
      systemOut: [`severity=${finding.severity}`, finding.message],
    };
  });
}

function runDurationSeconds(report: JsonReport): number | undefined {
  const startedAt = report.run?.startedAt;
  const endedAt = report.run?.endedAt;
  if (
    startedAt === undefined ||
    endedAt === undefined ||
    endedAt === null ||
    endedAt === "unknown"
  ) {
    return undefined;
  }
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return undefined;
  }
  return (end - start) / 1000;
}

function renderCase(testCase: JUnitCase): string {
  const attributes = [
    `name="${escapeXml(testCase.name)}"`,
    `classname="${escapeXml(testCase.className)}"`,
  ].join(" ");
  const body: string[] = [];
  if (testCase.status === "failed") {
    const message = escapeXml(testCase.message ?? "失败");
    const details = testCase.systemOut?.join("\n") ?? "";
    body.push(
      `<failure message="${message}">${escapeXml(details)}</failure>`,
    );
  }
  if (testCase.status === "skipped") {
    const message = escapeXml(testCase.message ?? "未评估");
    body.push(`<skipped message="${message}" />`);
  }
  if (testCase.systemOut !== undefined && testCase.systemOut.length > 0) {
    body.push(`<system-out>${escapeXml(testCase.systemOut.join("\n"))}</system-out>`);
  }
  if (body.length === 0) {
    return `<testcase ${attributes} />`;
  }
  return `<testcase ${attributes}>${body.join("")}</testcase>`;
}

export function renderJUnitReport(report: JsonReport): string {
  const runId = display(report.run?.id);
  const cases: JUnitCase[] = [
    ...(report.metrics ?? []).map(metricCase),
    gateCase(report.gate),
    runStatusCase(report.status),
    ...findingCases(report),
  ];

  const failures = cases.filter((testCase) => testCase.status === "failed").length;
  const skipped = cases.filter((testCase) => testCase.status === "skipped").length;
  const duration = runDurationSeconds(report);
  const timeAttribute =
    duration === undefined ? "" : ` time="${duration.toFixed(3)}"`;
  const counts = `tests="${cases.length}" failures="${failures}" skipped="${skipped}"`;

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites ${counts}>`,
    `  <testsuite name="${escapeXml(`PerfStage ${runId}`)}" ${counts}${timeAttribute}>`,
    ...cases.map((testCase) => `    ${renderCase(testCase)}`),
    "  </testsuite>",
    "</testsuites>",
    "",
  ];
  return lines.join("\n");
}
