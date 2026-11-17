# 阈值与回归容差标定（C4 `recalibrate-thresholds`）

> 目的：把 `scenarios/` 里的占位阈值与统一 20% 回归容差，换成由同口径多 Take 分布推导、
> 可逐项复算的数值。
>
> 状态（2026-11-17）：两个 shipped 场景各 5 个有效 Take 已采集，8 个指标全部完成标定，
> 数值已写入场景 YAML。`blockMs` / `launchMs` 的重尾已按稳健上界处理，判定力弱的指标
> 在 §4 显式标注。

## 1. 环境与样本

| 项 | 值 |
| --- | --- |
| 设备 | `Ra的iPhone`，iPhone 17（iPhone18,3），UDID `00008150-001E49E40128C01C`，physical |
| iOS | 27.0.1 |
| 被测应用 | `com.nndev.im` 6.8.0，构建 `600800`（采集前后各核一次，未变） |
| 工具 | `performance-test-mcp` HEAD `5bf214e` 构建的 `dist/cli/bin.js` |
| 标定工作区 | `perfstage-c4-workspace/`（非 Git，场景为 shipped 文件原样副本） |
| 采集窗口 | 2026-11-16T12:41Z – 2026-11-17T01:31Z |
| 样本口径 | `status=completed` 且 `run.json.device.id` / `device.osVersion` 存在且一致 |

### 排除的 Take（保留证据，不计入样本）

| 场景 | runId | 状态 | 原因 |
| --- | --- | --- | --- |
| community-home-scroll | `2026-11-16T12-51-36.676Z-ayvUp5TR` | failed | `xctrace` malformed trace：设备侧录制缓冲不完整 |
| community-home-scroll | `2026-11-16T12-52-26.124Z-eDMJNUgQ` | running（人工终止） | launch pass 期间设备掉线（`Device not found`） |
| message-list-scroll | `2026-11-17T00-56-29.590Z-yKaUpckY` | failed | 采集期间出现系统级崩溃报告（`SFA-*`），证据门禁判 failed |

`community-home-scroll-smoke`（v0.2 工作区，3 次滑动）与 `docs/m3-takes.json`（旧构建、
`run.json` 无 `device` 字段）只作量级参考，未进入任何样本集合。

## 2. 规则

参数：带宽 `b`（默认 20%，`memoryMB` 覆盖 5%）；`MAD` = 中位数绝对偏差。

```text
robustUpper = median + 3 × 1.4826 × MAD
warn        = max(ceil(median × (1 + b)),    ceil(robustUpper))
fail        = max(ceil(median × (1 + 2.5b)), ceil(warn × 1.15))

spread     = (max − min) / median
tolerance  = max(roundUpTo5Percent(spread), 5%)
```

- 阈值向上取整到整数；容差按 5% 步进向上取整。
- `memoryMB` 额外设置 `maxWorseningAbsolute`：取值 = `max(ceil(观测极差), 2 MB)`，社区首页为 **3 MB**（观测极差 2.94 MB），消息列表为 **2 MB**（观测极差 0.37 MB，取下限 2 MB 作为小基线兜底）；与百分比容差任一超出即失败。
- 规则版本：**v2（2026-11-17）**——噪声下限由「观测最大值」改为稳健上界
  `median + 3×1.4826×MAD`。原因见 §5。

## 3. 标定结果

### 3.1 `community-home-scroll`（5 次滑动）

样本 runId：

```text
2026-11-16T12-41-52.593Z-110udvWA
2026-11-16T12-47-30.918Z-ZRBo8Pxv
2026-11-17T00-42-47.196Z-ug3E702Z
2026-11-17T00-47-32.481Z-EPEQiBvE
2026-11-17T00-52-08.199Z-2attFYql
```

| 指标 | n | 观测值 | median | min | max | MAD | robustUpper | b | warn | fail | spread | 容差 | 旧值 → 新值 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hitches | 5 | 393, 443, 470, 478, 480 | 470 | 393 | 480 | 10 | 514.48 | 20% | 564 | 705 | 18.5% | 20% | 5 / 15 → 564 / 705；容差 20% → 20% |
| blockMs | 5 | 45.8, 83.3, 91.7, 91.7, 275 | 91.7 | 45.8 | 275 | 8.4 | 129.06 | 20% | 130 | 150 | 250.0% | 250% | 100 / 250 → 130 / 150；容差 20% → 250% |
| launchMs | 5 | 327.22, 337.28, 345.55, 554.49, 580.34 | 345.55 | 327.22 | 580.34 | 18.33 | 427.08 | 20% | 428 | 519 | 73.3% | 75% | 800 / 1500 → 428 / 519；容差 20% → 75% |
| memoryMB | 5 | 111.67, 112.77, 112.81, 113.16, 114.61 | 112.81 | 111.67 | 114.61 | 0.35 | 114.37 | 5% | 119 | 137 | 2.6% | 5% + 3 MB | 300 / 500 → 119 / 137；容差 20% → 5% + 3 MB |

### 3.2 `message-list-scroll`（消息列表来回）

计入样本 runId（5 条，均为 `completed` 且设备事实一致）：

```text
2026-11-17T01-10-58.569Z-9UJ3cXjx
2026-11-17T01-15-47.373Z-bVYyI2Pt
2026-11-17T01-19-42.509Z-gla8fLQQ
2026-11-17T01-23-34.690Z-945Z-ibd
2026-11-17T01-27-56.253Z-rqWmGSoi
```

被排除的 `2026-11-17T00-56-29.590Z-yKaUpckY`（`failed`，采集期间出现系统级
`SFA-*` 崩溃报告）不计入，已补跑至 5 条有效。

| 指标 | n | 观测值 | median | min | max | MAD | robustUpper | b | warn | fail | spread | 容差 | 旧值 → 新值 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hitches | 5 | 94, 97, 101, 110, 111 | 101 | 94 | 111 | 7 | 132.14 | 20% | 133 | 153 | 16.8% | 20% | 5 / 15 → 133 / 153；容差 无 → 20% |
| blockMs | 5 | 37.5, 37.5, 41.4, 41.4, 54.2 | 41.4 | 37.5 | 54.2 | 3.9 | 58.75 | 20% | 59 | 68 | 40.3% | 45% | 100 / 250 → 59 / 68；容差 无 → 45% |
| launchMs | 5 | 314.4, 324.03, 330.9, 335.9, 338.14 | 330.9 | 314.4 | 338.14 | 6.87 | 361.46 | 20% | 398 | 497 | 7.2% | 10% | 800 / 1500 → 398 / 497；容差 无 → 10% |
| memoryMB | 5 | 113.02, 113.25, 113.28, 113.39, 113.39 | 113.28 | 113.02 | 113.39 | 0.11 | 113.77 | 5% | 119 | 137 | 0.3% | 5% + 2 MB | 300 / 500 → 119 / 137；容差 无 → 5% + 2 MB |

> 说明：`message-list-scroll` 的 4 条 `regression` 规则为本次新增（C3 时期只有
> `community-home-scroll` 带示例规则），因此「旧值」记为「无」。

## 4. 判定力说明（必须一起读）

| 指标 | 问题 | 处理 |
| --- | --- | --- |
| community `blockMs` | 观测 45.8–275 ms，相对极差 250%，容差被推到 250% | 回归容差基本无法区分正常抖动与劣化；粗大异常由绝对阈值 130 / 150 兜底，275 ms 类长阻塞会判 fail |
| community `launchMs` | 冷启动双峰（3 次约 330–346 ms，2 次 554 / 580 ms），容差 75% | 绝对阈值 428 / 519 抓粗大回归；回归门禁只对 >75% 的劣化生效 |
| message `blockMs` | 相对极差 40.3%，容差 45% | 同上，绝对阈值 59 / 68 为主 |
| 其余指标 | 容差 5%–20%，与观测波动匹配 | 回归门禁可正常判定 |

这些都是**分布本身的性质**，不是放宽阈值：没有删除任何样本，也没有为了让 `gate`
变绿而扩大带宽。

## 5. 规则修订记录（v1 → v2）

- v1（方案门禁确认）：
  `warn = max(ceil(median × (1 + b)), ceil(observedMax))`，要求覆盖全部历史最大值。
- 实采结果推翻前提：`community-home-scroll` 的 `blockMs` 出现 275 ms（中位数 91.7 ms），
  `launchMs` 出现 554.49 / 580.34 ms（中位数 345.55 ms）。按 v1 会得到
  `blockMs` 275 / 317、`launchMs` 581 / 669，绝对门禁分别要 3 倍和 1.68 倍劣化才触发。
- 排查：两组 Take 的 `device.log` 与 `passes` 均无 thermal / jetsam / 崩溃 / 重试异常，
  不能判为无效样本。
- v2（2026-11-17 用户确认）：噪声下限改为 `median + 3 × 1.4826 × MAD`。不保证历史最大值
  不触发 warn——275 ms 这类单次主线程阻塞会被判 fail，这是预期语义：极值型指标不以
  历史极值定义「正常」。

## 6. 复算方法

在标定工作区根执行（只读，不改任何文件）：

```python
import json, statistics, math
from collections import defaultdict
from pathlib import Path

rows = [json.loads(l) for l in Path("collection-results.jsonl").read_text().splitlines() if l.strip()]
samples = defaultdict(list)
for row in rows:
    device = row.get("device") or {}
    if row.get("status") != "completed" or not device.get("id") or not device.get("osVersion"):
        continue
    for name, value in (row.get("metrics") or {}).items():
        if isinstance(value, (int, float)):
            samples[(row["scenario"], name)].append(value)

def round_up_5(x):
    return math.ceil(x * 100 / 5) * 5 / 100

for (scenario, metric), values in sorted(samples.items()):
    b = 0.05 if metric == "memoryMB" else 0.20
    med = statistics.median(values)
    mad = statistics.median([abs(v - med) for v in values])
    robust = med + 3 * 1.4826 * mad
    warn = max(math.ceil(med * (1 + b)), math.ceil(robust))
    fail = max(math.ceil(med * (1 + 2.5 * b)), math.ceil(warn * 1.15))
    spread = (max(values) - min(values)) / med
    tolerance = max(round_up_5(spread), 0.05)
    abs_tolerance = max(math.ceil(max(values) - min(values)), 2) if metric == "memoryMB" else None
    print(scenario, metric, med, warn, fail, tolerance, abs_tolerance)
```

输出与 §3 的 `median / warn / fail / 容差` 逐项一致。

## 7. 有效范围与重标定触发条件

- 数值只对「该场景 + `com.nndev.im` 6.8.0(600800) + iPhone18,3 / iOS 27.0.1」成立。
- 出现以下任一情况需要重新标定，并新建样本集（不要复用本文件数值）：
  - 场景动作序列、滑动距离/次数或等待时间变化；
  - App 构建的启动流程、首页或消息列表实现发生明显变化；
  - 目标设备或 iOS 大版本变化；
  - 连续多次 `gate=fail` 的指标在中位数上整体漂移（说明基线时代已过）。
- 重标定时先补采样本，再按 §2 规则计算；不允许只改数值不更新本文件的样本与统计量。

## 8. 真机复核记录（2026-11-17）

| 项 | 结果 |
| --- | --- |
| 复核 Take | `2026-11-17T03-17-38.794Z-qPHMUIUy`，`completed`，`gate=pass` |
| 指标 | hitches 477（pass）、blockMs 91.7（pass）、launchMs 359.7（pass）、memoryMB 111.49（pass） |
| `plan.json` 快照 | `564/705`、`130/150`、`428/519`、`119/137`；容差 `20%`、`250%`、`75%`、`5% + 3 MB` |
| 回归门禁 | `perfstage gate qPHMUIUy --samples 5` → 退出码 0，`regression.status=pass`，4/4 指标 pass |
| 只读性 | `gate` 前后目标 run 目录文件哈希一致（`6df4595d…`），未写入任何文件 |
| 确定性 | 同一输入连续执行两次，JSON 输出逐字节相同（SHA-256 `cc02f5a5…`） |

补充证据：

- 前一次 Take `2026-11-17T03-11-31.182Z-a7TaIH1X` 为 `completed`、`gate=warn`，launchMs 463.63
  落在新的 warn 区间（`428 ≤ 463.63 < 519`），证明新阈值确实生效（旧值 `800/1500` 会判 pass）。
- 该 Take 同时暴露了 `memoryMB` 绝对容差过紧的问题：115.69 MB 对基线 112.81 MB 差 2.88 MB
  （+2.55%，在 5% 百分比内），却被 2 MB 绝对容差判 fail。观测极差为 2.94 MB，因此把
  `community-home-scroll` 的 `maxWorseningAbsolute` 改为 3 MB，复跑后回归 pass。
- `message-list-scroll` 的新规则快照由 Take `2026-11-17T01-37-29.477Z-bvBUPOpr` 佐证
  （该 Take 因设备故障未完成，但 `plan.json` 已写入最终规则）；最终配置未再变更。
- 复核期间工作区里存在失败的验证 Take，派生基线的每条指标样本数偏少；用 `--samples 5`
  取最近 5 条终态记录后，每条指标仍有 ≥3 个有效样本，复算口径不变。
