---
name: perf-<scene-id>
description: <一句话说明测什么、在什么设备上测、关注哪些指标。>
---

# <Scene 名称>性能测试

> 这是 PerfStage 的 **Thin Skill** 模板：Skill 只调用一次
> `run_performance_test`，设备动作、录制、解析与报告都由 Runner 完成。

## 参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `deviceId` | 是 | 目标设备 UDID；**不要写死在场景 YAML 里**；对应工具字段 `device.id` |
| `scenarioId` | 是 | 默认 `<scene-id>` |
| `repeat` | 否 | 重复次数（工具字段 `repetitions`）；Runner 取中位数并保留样本 |
| `notes` | 否 | 追加到本次 Take 的备注 |

## 前置条件

1. 设备已连接且解锁：`xcrun devicectl list devices` 显示 `connected`。
2. 目标 App 已安装，bundleId 与场景一致。
3. 关闭自动锁定，或测试期间保持屏幕常亮。
4. 同一台设备只运行一个 Take，避免争抢 kperf 锁。

## 执行

```jsonc
// run_performance_test
{
  "scenarioId": "<scene-id>",
  "device": { "id": "<deviceId>" },
  "repetitions": 1
}
```

也可以传 `adHocPlan`（一次性计划）代替 `scenarioId`；
一次调用只能二选一。

## 输出契约

```jsonc
{
  "runId": "...",
  "scenarioId": "<scene-id>",
  "status": "completed",   // completed | partial | failed | invalid | cancelled
  "gate": "pass",          // pass | warn | fail | unknown
  "metrics": { "hitches": 3, "blockMs": 84.2, "launchMs": 274.3, "memoryMB": 113.5 },
  "findings": [],
  "reportPath": ".performance-test/runs/<runId>/report.json",
  "reportMarkdownPath": ".performance-test/runs/<runId>/report.md"
}
```

规则：

- `status` 表示证据是否完整可信；`gate` 表示阈值是否达标。超阈值是
  `completed` + `gate=fail`，不是 `partial`。
- 缺指标、缺值、缺 `tracePath`、日志/Crash 查询失败都会让 `status=partial`。
- 新增 Crash、jetsam、watchdog、设备断连会让 `status=failed`。
- 汇报时原样输出 `status` / `gate` / `findings`，不要自行改写成「通过」。

## 连续执行（Encore）

`repeat > 1` 时 Runner 在同一 `runId` 内逐轮执行并取中位数，
原始样本保留在 `metrics[].samples`。如果更希望每轮一个独立报告，
对 Skill 说「连续执行 N 次」，每次调用一次 `run_performance_test`。

## 需要人工接管时

如果场景需要 Runner 无法表达的自定义录制窗口，仍可使用
`prepare_performance_test` → 自行采集 → `finalize_performance_test`。
两条路径共享同一个证据门禁，输出结构一致。
