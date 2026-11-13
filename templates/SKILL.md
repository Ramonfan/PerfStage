---
name: perf-<scene-id>
description: <一句话说明测什么、在什么设备上测、关注哪些指标。>
---

# <Scene 名称>性能测试

> 这是 PerfStage 的 **Thick Skill** 模板（MVP 阶段）。Skill 负责编排
> `mobile-mcp`、`instruments-mcp-server` 与 PerfStage，直到 `run_performance_test`
> 落地后再缩短为一次调用。

## 参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `deviceId` | 是 | 目标设备 UDID；**不要写死在场景 YAML 里** |
| `sceneId` | 是 | 默认 `<scene-id>` |
| `repeat` | 否 | 连续执行次数，默认 `1`；多次执行逐次报告，不做聚合 |
| `baselineRunId` | 否 | 规划中：历史对比基线 |

## 前置条件

1. 设备已连接且解锁：`xcrun devicectl list devices` 显示 `connected`。
2. 目标 App 已安装，bundleId 与场景一致。
3. 关闭自动锁定，或测试期间定期点状态栏防锁屏。
4. 只允许一个 Take 同时使用 `instruments-mcp-server`（它一次只能录一个模板）。

## 执行流程

### 1. 准备

```jsonc
// prepare_performance_test
{
  "scenarioId": "<scene-id>",
  "device": { "id": "<deviceId>" }
}
```

记录返回的 `runId`、`plan` 和 `runPath`。`plan` 已内联，无需再读 `plan.json`。

### 2. 每个 Take 开始前

1. 用 `mobile-mcp` 启动 App（`mobile_launch_app`），确认前台 bundleId 与
   `plan.preconditions` 一致。
2. 执行 `plan.warmup`，等待页面稳定。
3. 记录测试前 Crash 列表：`mobile_list_crashes`。
4. 设备日志是 best-effort：`mobile_get_device_logs` 可能阻塞，优先用独立
   client 后台采集；采集失败必须在 `finalize` 中写 `logQueryError`，不能伪造为空。

### 3. 采集指标（3 个 pass）

指标按 Instruments 模板分组，同一模板只录一次：

| pass | 模板 | 产出指标 | 录制方式 |
| --- | --- | --- | --- |
| 1 | `Animation Hitches` | `hitches`、`blockMs` | 录滑动/交互窗口 |
| 2 | `App Launch` | `launchMs` | `launch_path` 冷启动 |
| 3 | `Activity Monitor` | `memoryMB` | `--all-processes`，按进程名选目标 |

每个 pass 的标准动作：

1. `start_profiling({ device, template, process | launch_path })`
2. 执行 `plan.actions`（动画类指标）或启动 App（launch）或静置采样（memory）
3. `stop_profiling()`，拿到 `tracePath`；客户端超时至少 300s
4. `analyze_performance_trace({ template, tracePath, processName?, pid? })`
5. 把返回的 `metrics` 累积到最终 `metrics` 数组，并保留 `warnings`

> 若某个指标没有采到，**不要编造数值**：传给 `finalize` 时省略该指标，
> 让证据门禁把它判为 `partial`。

### 4. 执行动作

按 `plan.actions` 顺序执行，遵守每个动作的 `waitAfterMs`：

- `tap` / `wait_for`：先用 `mobile_list_elements_on_screen` 找到目标，再点击。
- `swipe`：`mobile_swipe_on_screen(direction, distance)`。
- `wait`：直接等待。

记录每个动作的 `actionId`、`outcome`、`attempts`、`startedAt`、`endedAt`。
动作最终失败时 `outcome: "failed"`，并在 `error` 中写原因。

### 5. 收尾

```jsonc
// finalize_performance_test
{
  "runId": "<runId>",
  "requestedStatus": "completed",
  "actions": [/* ... */],
  "metrics": [/* analyze_performance_trace 的 metrics 累积结果 */],
  "diagnostics": {
    "logText": "<可选>",
    "crashIdsBefore": ["..."],
    "crashIdsAfter": ["..."],
    "lifecycle": [/* ... */]
  },
  "notes": "<可选：异常、口径说明>"
}
```

读取 `report.md`，向用户汇报：

- `status`：这次 Take 是否有效
- `gate`：指标是否达标
- `reportPath`：`.performance-test/runs/<runId>/report.md`
- 失败/降级原因与缺失证据

## 输出契约

```jsonc
{
  "runId": "...",
  "sceneId": "<scene-id>",
  "status": "completed",   // completed | partial | failed | invalid | cancelled
  "gate": "pass",          // pass | warn | fail | unknown
  "metrics": { "hitches": 3, "blockMs": 84.2, "launchMs": 274.3, "memoryMB": 113.5 },
  "findings": [],
  "reportPath": ".performance-test/runs/<runId>/report.md"
}
```

规则：

- `status` 表示证据是否完整可信；`gate` 表示阈值是否达标。超阈值是
  `completed` + `gate=fail`，不是 `partial`。
- 缺指标、缺值、缺 `tracePath`、日志/Crash 查询失败都会让 `status=partial`。
- 新增 Crash、jetsam、watchdog、设备断连会让 `status=failed`。

## 连续执行（Encore）

`repeat > 1` 时逐次执行完整流程，每次都产生独立 `runId` 与报告。
不要复用上一次的 trace 或指标；只对比结果，不覆盖证据。
