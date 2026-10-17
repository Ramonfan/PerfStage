# 交互式性能测试工作流验收记录

**日期：** 2026-10-17
**任务：** Task 8 — 完成 README、手动交互流程和全量验收
**关联计划：** `docs/superpowers/plans/2026-10-17-performance-test-mcp-plan.md`
**关联设计：** `docs/superpowers/specs/2026-10-17-performance-test-mcp-design.md`

## 摘要

本次验收完成三件事：

1. 在 `src/__tests__/e2e/interactive-contract.test.ts` 增加离线交互式契约测试，覆盖 `list_performance_scenarios → prepare_performance_test → finalize_performance_test` 完整链路，并校验 `device.log`、`lifecycle.json` 和新增 Crash 文件被引用。
2. 更新 `README.md`，使其描述真实工具输入输出、`runs/<run-id>/` 目录布局、场景编辑流程，以及交互式先于无人值守实现的现状。
3. 在编写契约测试时发现 `src/tools/report.ts` 中 `buildJsonReport` 调用残留了旧 5 参形式（commit `4bda5dd` 把公共签名改为 2 参），顺手把最小负责模块修好；其它无关文件未做改动。

## 离线契约测试

测试文件：`src/__tests__/e2e/interactive-contract.test.ts`

执行命令：

```bash
npm test -- --run src/__tests__/e2e/interactive-contract.test.ts
```

测试结果：3 / 3 通过。

测试内容：

- **正向流程**：写入 `device.log`、`lifecycle.json`、`crash-001.ips` 三个 fixture 文件 → 调用 `list_performance_scenarios` 校验 `community-home-scroll` 存在 → `prepare_performance_test` 创建 run 并校验 `nextSteps` 引导 Claude 调用 `mobile_get_device_logs` / `mobile_list_crashes` / `finalize_performance_test` → `finalize_performance_test` 注入 actions / metrics / diagnostics（含 crashIdBefore / crashIdsAfter / crashReports / lifecycle），并通过 `evidencePaths` 复制 lifecycle 与 crash 文件 → 读取 `runs/<run-id>/report.json` 和 `runs/<run-id>/report.md` → 断言：
  - `reportJson.evidencePaths.deviceLog` 等于 `diagnostics.logPath` 指向的 fixture 路径；
  - `lifecycle.json` 被复制到 `runs/<run-id>/lifecycle.json`，并且 `report.md` 包含 `foreground` 事件与对应时间戳；
  - 新增 Crash `crash-001` 通过 `evidencePaths` 复制到 `runs/<run-id>/crashes/crash-001.ips`；`report.json.diagnostics.crashes.newIds` 包含该 ID；`report.md` 包含 `crash-001` 与 `EXC_BAD_ACCESS`。
- **不可重复 finalize**：对已经到达终态的 run 再次调用 `finalize_performance_test`，断言返回结构化错误（消息含 `terminal` 或 `already`）。
- **runId 不存在**：对不存在的 `runId` 调用 `finalize_performance_test`，断言返回结构化错误。

测试仅访问文件系统与 fixture，不依赖真实设备或外部 MCP。

## 最小负责模块修复

编写契约测试时直接运行 `npm test -- --run src/__tests__/e2e/interactive-contract.test.ts` 触发的失败指向 `src/tools/report.ts` 的 `buildJsonReport` 调用：

```typescript
// 残留的旧 5 参形式
const jsonReport: JsonReport = buildJsonReport(
  updatedRun,
  plan ?? ({} as TestPlan),
  evidence,
  findings,
  copiedPaths,
);
```

`buildJsonReport` 公共签名在 commit `4bda5dd` 已被改回两参 `(run, diagnostics)`，但 `src/tools/report.ts` 内的调用未同步，导致第二个参数实际传入 `TestPlan` 对象，`diagnostics.crashes` 读取即抛 `Cannot read properties of undefined`。

最小修复：把该处调用改成 `buildJsonReport(updatedRun, evidence)`，与公共签名对齐。其余模块（`src/reports/json.ts` 内的 `inferMissingEvidence` 启发式、`src/tools/report.ts` 内的 `deriveMissingEvidence` 等）未做任何改动，避免触碰已有契约与既有测试。

附带：原 `deriveFindings` 使用了 `ReportFinding` 接口中没有的 `category` 字段，build 阶段会因 `noEmitOnError` 失败。为使 `npm run build` 通过，把该函数内构造成的 finding 改成 `severity` + `code` + `message`，与 `ReportFinding` 接口一致；行为语义保持一致（诊断原因继续按 impact 等级映射 severity，`status-downgrade` 维持 warning）。

## 手动真机集成测试 — 待人工验收

> 状态：**pending / manual acceptance**

本次自动验收在沙箱环境中完成，无 iOS 真机或模拟器，因此**未执行** Task 8 描述的真机手动集成步骤：

- 未选定具体 `mobile-mcp` 设备（依赖 Claude 运行的 `mobile_list_available_devices`）。
- 未调用 `mobile_get_device_logs` / `mobile_list_crashes` / `mobile_launch_app` 等真实设备接口。
- 未通过 `instruments-mcp-server` 抓取 hitches / cpu / memory trace。
- 未在真机上执行 `community-home-scroll` 方案的 warmup / actions。
- 未保存真机产生的 `device.log` / Crash 报告 / lifecycle.json。
- 未修改 NN 业务代码。

> **后续手动验收步骤（不在本次自动验收范围内）：**

1. 运行 `npm install && npm run build`，确保本地构建无错误。
2. 在 MCP 配置中启用 `performance-test-mcp` 与 `mobile-mcp` / `instruments-mcp-server`。
3. 通过 `mobile_list_available_devices` 选定一台可用 iOS 设备，记录 device id。
4. 按 README 中描述的顺序调用三个工具，按 `prepare_performance_test.nextSteps` 引导 Claude 完整执行一次 `community-home-scroll` 流程。
5. 检查 `runs/<run-id>/report.json` 和 `report.md`，确保：
   - `deviceLog`、`crashReport`（如新增）、`lifecycleTrace` 路径被引用；
   - 真实 metric 结果与方案里的 `metricNames` 一一对应；
   - 新增 Crash 报告与 crashId 列表一致。
6. 记录最终报告路径、Diagnostics 是否齐全、以及任何 xctrace 设备相关限制。
7. 验证完毕后再把真机报告路径、限制记录补回本文件。

## 已知限制

- `npm test` 在 commit `1cb3422` 上存在一处历史失败的预存在测试 `src/__tests__/tools/report.test.ts > finalize_performance_test > completes a clean run and writes report.json and report.md`：测试期望 `report.json.status === "completed"`，但 `src/reports/json.ts` 中 `inferMissingEvidence` 的 `trace_archive` 启发式会把缺 trace 的 run 降级为 `partial`。本地 `deriveMissingEvidence` 不检查 trace，两侧判定产生分歧。本次 Task 8 未对 `src/reports/json.ts` 或该既有测试做任何修改；按用户约束"不要修改无关文件"保留原状，待后续任务统一处理。
- 沙箱内没有真机，因此本验证文件没有真实的 `runs/<run-id>/` 报告路径可供引用；后续人工验收步骤需补回。