import type {
  ActionPhase,
  JsonReport,
} from "./json.js";

/**
 * Render a `JsonReport` as a Chinese-language Markdown document.
 *
 * Sections are emitted in the order required by the brief:
 *   1. 总结 (summary)
 *   2. 测试计划 (test plan)
 *   3. 动作时间线 (action timeline)
 *   4. 性能指标 (metrics)
 *   5. 稳定性诊断 (stability diagnostics)
 *   6. 证据文件 (evidence files)
 *   7. 限制与未知项 (limitations and unknown items)
 *
 * The renderer is intentionally conservative: every unavailable signal is
 * surfaced with an explicit "未能..." phrase instead of being silently
 * omitted.
 */
export function renderMarkdownReport(report: JsonReport): string {
  const sections: string[] = [];
  sections.push(renderSummary(report));
  sections.push(renderPlan(report));
  sections.push(renderActions(report));
  sections.push(renderMetrics(report));
  sections.push(renderStability(report));
  sections.push(renderEvidence(report));
  sections.push(renderLimitations(report));
  return sections.join("\n\n") + "\n";
}

function header(level: number, text: string): string {
  return `${"#".repeat(level)} ${text}`;
}

function bullet(text: string, indent = 0): string {
  return `${"  ".repeat(indent)}- ${text}`;
}

function phaseLabel(phase: ActionPhase): string {
  switch (phase) {
    case "drag":
      return "拖动";
    case "wait":
      return "减速/等待";
    case "post-action":
      return "动作后";
    case "unknown":
      return "未知";
    default:
      return phase;
  }
}

function verdictLabel(verdict: string | undefined): string {
  switch (verdict) {
    case "pass":
      return "通过";
    case "warn":
      return "警告";
    case "fail":
      return "失败";
    case "skipped":
      return "跳过";
    default:
      return verdict ?? "未评定";
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "completed":
      return "已完成";
    case "partial":
      return "部分完成";
    case "failed":
      return "失败";
    case "invalid":
      return "无效";
    case "cancelled":
      return "已取消";
    default:
      return status;
  }
}

function renderSummary(report: JsonReport): string {
  const lines: string[] = [];
  lines.push(header(2, "总结"));
  lines.push("");
  lines.push(bullet(`运行 ID：${report.run.id}`));
  lines.push(bullet(`计划 ID：${report.plan.id}`));
  lines.push(bullet(`最终状态：${statusLabel(report.status)}`));
  lines.push(
    bullet(
      `运行开始：${report.run.startedAt ?? "未知"}；结束：${report.run.endedAt ?? "未结束"}`,
    ),
  );
  if (report.downgradedFromCompleted) {
    lines.push(
      bullet(
        "本次报告从请求的“已完成”状态降级而来，请查看后续小节以了解具体原因。",
      ),
    );
  }
  lines.push(bullet(`报告生成时间：${report.generatedAt}`));
  if (report.findings.length === 0) {
    lines.push(bullet("未发现需要处理的问题。"));
  } else {
    const failures = report.findings.filter(
      (f) => f.severity === "failure",
    ).length;
    const warnings = report.findings.filter(
      (f) => f.severity === "warning",
    ).length;
    lines.push(
      bullet(
        `发现项：${report.findings.length} 条（${failures} 失败 / ${warnings} 警告）。`,
      ),
    );
  }
  return lines.join("\n");
}

function renderPlan(report: JsonReport): string {
  const lines: string[] = [];
  lines.push(header(2, "测试计划"));
  lines.push("");
  lines.push(bullet(`计划 ID：${report.plan.id}`));
  lines.push(bullet(`请求状态：${statusLabel(report.run.status)}`));
  if (report.run.notes) {
    lines.push(bullet(`备注：${report.run.notes}`));
  }
  if (report.run.error) {
    lines.push(bullet(`运行错误：${report.run.error}`));
  }
  if (typeof report.run.durationMs === "number") {
    lines.push(bullet(`计划耗时：${report.run.durationMs}ms`));
  }
  lines.push(bullet(`重复次数：${report.run.repetitions}`));
  return lines.join("\n");
}

function renderActions(report: JsonReport): string {
  const lines: string[] = [];
  lines.push(header(2, "动作时间线"));
  lines.push("");
  if (report.actions.length === 0) {
    lines.push("- 未记录任何动作。");
    return lines.join("\n");
  }
  for (const entry of report.actions) {
    lines.push(
      bullet(
        `动作 ${entry.actionId}（${entry.type}）：结果 ${entry.outcome}，尝试 ${entry.attempts} 次`,
      ),
    );
    if (entry.error) {
      lines.push(bullet(`错误：${entry.error}`, 1));
    }
    if (entry.notes) {
      lines.push(bullet(`备注：${entry.notes}`, 1));
    }
    for (const phase of entry.phases) {
      const timing =
        phase.startedAt === "unknown" || phase.endedAt === "unknown"
          ? "起止时间未知"
          : `${phase.startedAt} → ${phase.endedAt}`;
      lines.push(bullet(`${phaseLabel(phase.phase)}：${timing}`, 1));
    }
  }
  return lines.join("\n");
}

function renderMetrics(report: JsonReport): string {
  const lines: string[] = [];
  lines.push(header(2, "性能指标"));
  lines.push("");
  if (report.metrics.length === 0) {
    lines.push("- 未采集任何性能指标。");
    return lines.join("\n");
  }
  lines.push("| 指标 | 数值 | 单位 | 阈值 | 结果 | 测量时间 |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const metric of report.metrics) {
    const value =
      metric.value === undefined || metric.value === null
        ? "-"
        : typeof metric.value === "string"
          ? metric.value
          : JSON.stringify(metric.value);
    const threshold =
      metric.threshold === undefined
        ? "-"
        : `warn=${metric.threshold.warn ?? "-"} / fail=${metric.threshold.fail ?? "-"}`;
    lines.push(
      `| ${metric.name} | ${value} | ${metric.unit ?? "-"} | ${threshold} | ${verdictLabel(metric.verdict)} | ${metric.measuredAt ?? "-"} |`,
    );
  }
  return lines.join("\n");
}

function renderStability(report: JsonReport): string {
  const lines: string[] = [];
  lines.push(header(2, "稳定性诊断"));
  lines.push("");
  const { diagnostics, downgradedFromCompleted } = report;

  // Logs
  lines.push(header(3, "日志"));
  lines.push("");
  if (diagnostics.logs.status === "available") {
    lines.push(
      bullet(
        `日志可用，共 ${diagnostics.logs.lineCount} 行；路径：${diagnostics.logs.path ?? "未提供"}。`,
      ),
    );
    const cats = diagnostics.logs.categories;
    lines.push(bullet("识别出的类别：", 0));
    const categoryEntries: Array<[string, string, boolean | null]> = [
      ["错误/故障", "errorOrFault", cats.errorOrFault],
      ["Watchdog", "watchdog", cats.watchdog],
      ["内存警告", "memoryWarning", cats.memoryWarning],
      ["Jetsam", "jetsam", cats.jetsam],
      ["UIKit/CoreAnimation", "uikitOrCoreAnimation", cats.uikitOrCoreAnimation],
      ["React Native/JSC", "reactNativeOrJSC", cats.reactNativeOrJSC],
      ["图像/网络/URL", "imageNetworkUrl", cats.imageNetworkUrl],
    ];
    for (const [label, , hit] of categoryEntries) {
      let verdict: string;
      if (hit === true) {
        verdict = "命中";
      } else if (hit === false) {
        verdict = "未命中";
      } else {
        verdict = "未知（日志不可用）";
      }
      lines.push(bullet(`${label}：${verdict}`, 1));
    }
  } else {
    lines.push(
      bullet(
        `未能读取设备日志，不能据此证明系统稳定。${
          diagnostics.logs.error ? `原因：${diagnostics.logs.error}` : ""
        }`,
      ),
    );
  }

  // Crash diff
  lines.push("");
  lines.push(header(3, "Crash 差异"));
  lines.push("");
  if (diagnostics.crashes.status === "available") {
    if (diagnostics.crashes.newIds.length === 0) {
      lines.push(bullet("本次运行未引入新的 Crash。"));
    } else {
      lines.push(
        bullet(`新增 Crash 数量：${diagnostics.crashes.newIds.length}`),
      );
      for (const id of diagnostics.crashes.newIds) {
        const report = diagnostics.crashes.reports.find((r) => r.id === id);
        const detail = report
          ? `${report.process ?? "未知进程"} (${report.exceptionType ?? report.terminationReason ?? "无异常类型"})`
          : "未提供报告详情";
        lines.push(bullet(`${id}：${detail}`, 1));
      }
    }
    lines.push(
      bullet(
        `运行前后快照：之前 ${diagnostics.crashes.before.length} 条，之后 ${diagnostics.crashes.after.length} 条。`,
      ),
    );
  } else {
    lines.push(
      bullet(
        `未能读取 Crash 列表，不能据此证明没有崩溃。${
          diagnostics.crashes.error ? `原因：${diagnostics.crashes.error}` : ""
        }`,
      ),
    );
  }

  // Lifecycle
  lines.push("");
  lines.push(header(3, "生命周期事件"));
  lines.push("");
  if (diagnostics.lifecycle.status === "available") {
    if (diagnostics.lifecycle.events.length === 0) {
      lines.push(bullet("未记录到生命周期事件。"));
    } else {
      for (const event of diagnostics.lifecycle.events) {
        lines.push(
          bullet(
            `${event.kind} @ ${event.occurredAt}${
              event.notes ? `（${event.notes}）` : ""
            }`,
          ),
        );
      }
    }
  } else {
    lines.push(
      bullet(
        `未能读取生命周期事件。${
          diagnostics.lifecycle.error
            ? `原因：${diagnostics.lifecycle.error}`
            : ""
        }`,
      ),
    );
  }

  // Downgrade
  lines.push("");
  lines.push(header(3, "状态评定"));
  lines.push("");
  if (downgradedFromCompleted) {
    lines.push(
      bullet(
        `原请求状态为“已完成”，但最终被降级为 ${statusLabel(report.status)}。请结合上方发现项定位根因。`,
      ),
    );
  } else {
    lines.push(
      bullet(`本次运行未从“已完成”状态降级，保持为 ${statusLabel(report.status)}。`),
    );
  }

  return lines.join("\n");
}

function renderEvidence(report: JsonReport): string {
  const lines: string[] = [];
  lines.push(header(2, "证据文件"));
  lines.push("");
  const { evidencePaths } = report;
  const entries: Array<[string, string | undefined | string[]]> = [
    ["设备日志", evidencePaths.deviceLog],
    ["Crash 报告", evidencePaths.crashReport],
    ["截图", evidencePaths.screenshots],
    ["Trace 归档", evidencePaths.traceArchives],
    ["网络抓包", evidencePaths.networkCapture],
    ["生命周期 Trace", evidencePaths.lifecycleTrace],
  ];
  let anyListed = false;
  for (const [label, value] of entries) {
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(bullet(`${label}：`, 0));
      for (const item of value) {
        lines.push(bullet(item, 1));
      }
      anyListed = true;
    } else if (value) {
      lines.push(bullet(`${label}：${value}`));
      anyListed = true;
    }
  }
  if (!anyListed) {
    lines.push("- 暂无关联的证据文件。");
  }
  return lines.join("\n");
}

function renderLimitations(report: JsonReport): string {
  const lines: string[] = [];
  lines.push(header(2, "限制与未知项"));
  lines.push("");
  if (report.findings.length === 0) {
    lines.push("- 本次报告未列出额外的限制项。");
    return lines.join("\n");
  }
  for (const finding of report.findings) {
    lines.push(
      bullet(`[${finding.severity}] ${finding.message}（${finding.code}）`),
    );
  }
  return lines.join("\n");
}