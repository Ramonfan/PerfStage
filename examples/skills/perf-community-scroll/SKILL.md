---
name: perf-community-scroll
description: 社区首页上下滚动性能测试。用于回归卡顿（hitches/blockMs）、冷启动（launchMs）与内存占用（memoryMB）。
---

# 社区首页滚动性能测试

场景定义：`.performance-test/scenarios/community-home-scroll.yaml`
（bundleId `com.nndev.im`，2 次滑动，4 个规范指标）。

## 参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `deviceId` | 是 | 真机 UDID，例如 `00008150-001E49E40128C01C` |
| `repeat` | 否 | 连续执行次数，默认 `1` |
| `notes` | 否 | 追加到本次 Take 的备注 |

## 步骤

### 1. 准备

调用 `prepare_performance_test`：

```json
{ "scenarioId": "community-home-scroll", "device": { "id": "<deviceId>" } }
```

保存 `runId` 与 `plan`。

### 2. 前置检查

1. `mobile_launch_app` 启动 `com.nndev.im`。
2. `mobile_get_foreground_app` 确认前台是 `com.nndev.im`。
3. 执行 `plan.warmup`（点击「社区」，等待 1500ms）。
4. `mobile_list_crashes` 记录测试前 Crash id 列表。

### 3. Pass 1：卡顿

1. `start_profiling({ device: "<deviceId>", template: "Animation Hitches", process: "NN" })`
2. 按 `plan.actions` 执行两次滑动（上滑 700px/500ms，下滑 700px/500ms），
   每次滑动后等待 `waitAfterMs`。
3. `stop_profiling()`。若客户端超时，等待 300s 以上再重试。
4. `analyze_performance_trace({ template: "hitches", tracePath: "<tracePath>" })`

得到 `hitches` 与 `blockMs`。两个指标共用这一条 trace。

### 4. Pass 2：冷启动

1. 终止 App（或使用 `launch_path` 让 xctrace 自己拉起）。
2. `start_profiling({ device: "<deviceId>", template: "App Launch", launch_path: "com.nndev.im" })`
3. 等待 `stop_profiling()` 返回。
4. `analyze_performance_trace({ template: "launch", tracePath: "<tracePath>", processName: "NN" })`

得到 `launchMs`。若没有解析到 lifecycle 阶段，不要补 0：省略 `value`。

### 5. Pass 3：内存

1. App 保持前台，确认进程名（Activity Monitor 中通常显示为 `NNIM`）。
2. `start_profiling({ device: "<deviceId>", template: "Activity Monitor", process: "NNIM" })`
   —— 若该模板不支持 attach，改用 `--all-processes` 方式录制 8–10s。
3. `stop_profiling()`。
4. `analyze_performance_trace({ template: "memory", tracePath: "<tracePath>", processName: "NNIM" })`

得到 `memoryMB`（`phys_footprint` 中位数）。若设备上同名进程多于一个，
优先传 `pid`；仍无法确定时在 `notes` 中记录歧义，不要挑一个看起来合理的值。

### 6. 收尾

```json
{
  "runId": "<runId>",
  "requestedStatus": "completed",
  "actions": [/* 两次滑动的 actionId / outcome / startedAt / endedAt */],
  "metrics": [/* 三个 pass 的 metrics 合并 */],
  "diagnostics": {
    "crashIdsBefore": ["<before>"],
    "crashIdsAfter": ["<after>"],
    "lifecycle": []
  },
  "notes": "<可选>"
}
```

返回给用户：

- `status` 与 `gate`
- 四个指标值：`hitches` / `blockMs` / `launchMs` / `memoryMB`
- `reportPath`
- 任何 `partial` / `unknown` 的原因（缺 trace、缺值、日志不可用等）

## 阈值

| 指标 | warn | fail | 说明 |
| --- | --- | --- | --- |
| `hitches` | 5 | 15 | 两次滑动窗口内的 hitch 次数 |
| `blockMs` | 100 | 250 | 最长 hang 时长 |
| `launchMs` | 800 | 1500 | 冷启动 |
| `memoryMB` | 300 | 500 | 中位 footprint |

阈值来自场景 YAML；`finalize` 会自动推导 `verdict` 与 `gate`。
`gate=fail` 不代表测试无效：只要证据完整，`status` 仍是 `completed`。

## 已知限制

- 三个指标需要 3 个顺序 pass，总耗时约 3–6 分钟。
- Animation Hitches 若覆盖启动窗口，会把冷启动 hang 计入；本 Skill 在
  warmup 完成后才开始 Pass 1。
- 设备锁屏、App 退后台或 USB 断连都会让本次 Take 失败；不要静默重试后
  复用旧的 trace。
- 基线对比与 CI 门禁仍属规划。
