---
name: perf-community-scroll
description: 社区首页连续上滑滚动性能测试。用于回归卡顿（hitches/blockMs）、冷启动（launchMs）与内存占用（memoryMB）。
---

# 社区首页滚动性能测试

场景定义：`.performance-test/scenarios/community-home-scroll.yaml`
（bundleId `com.nndev.im`，5 次上滑，4 个规范指标）。

## 参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `deviceId` | 是 | 真机 UDID，例如 `00008150-001E49E40128C01C` |
| `repeat` | 否 | 重复次数；Runner 取中位数并保留每个样本 |
| `notes` | 否 | 追加到本次 Take 的备注 |

## 步骤

调用 `run_performance_test`，只调用一次：

```json
{
  "scenarioId": "community-home-scroll",
  "device": { "id": "<deviceId>" },
  "repetitions": 1
}
```

Runner 会自动完成：

1. 校验设备与安装，记录测试前 Crash 列表，启动 App 日志流；
2. 把 App 带到前台并执行 `plan.warmup`（本场景为空：App 直接进入社区首页）；
3. 录制 Animation Hitches，窗口内回放 5 次上滑，解析 `hitches` / `blockMs`；
4. 冷启动录制 App Launch，解析 `launchMs`；
5. 静置后录制 Activity Monitor，解析 `memoryMB`；
6. 收集日志、Crash 差集与生命周期，执行证据门禁并写出报告。

## 输出

把工具返回值原样汇报：

```jsonc
{
  "runId": "...",
  "status": "completed",   // completed | partial | failed | invalid | cancelled
  "gate": "fail",          // pass | warn | fail | unknown
  "metrics": {
    "hitches": 366,
    "blockMs": 41.8,
    "launchMs": 313.64,
    "memoryMB": 116.1
  },
  "findings": [/* ... */],
  "reportPath": ".performance-test/runs/<runId>/report.json",
  "reportMarkdownPath": ".performance-test/runs/<runId>/report.md"
}
```

- `status` 表示证据是否完整可信；`gate` 表示阈值是否达标。
  超阈值是 `completed` + `gate=fail`，不是 `partial`。
- `status` 不是 `completed` 时，逐条列出 `findings` 与 `notes`，
  不要重跑后复用旧结果，也不要手工补指标值。

## 阈值

| 指标 | warn | fail | 说明 |
| --- | --- | --- | --- |
| `hitches` | 5 | 15 | 滑动窗口内的卡顿帧数 |
| `blockMs` | 100 | 250 | 最长卡顿帧时长 |
| `launchMs` | 800 | 1500 | 冷启动 |
| `memoryMB` | 300 | 500 | 中位 `phys_footprint` |

阈值来自场景 YAML。示例阈值尚未按真机分布重新标定（M4），
因此 `hitches` 通常为 `fail`；这表示阈值偏紧，不表示测试无效。

## 已知限制

- 4 个指标需要 3 个顺序 pass，单次约 3 分钟。
- 设备锁屏、App 退后台或 USB 断连都会让本次 Take 失败；
  报告仍会落盘并说明原因。
- 基线对比与 CI 门禁仍属 M4。
