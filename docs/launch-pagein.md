# 冷启动页换入诊断（launch-pagein）

本文件固定 `add-launch-pagein-diagnostics` 的归因口径、样本数字和复算方法。它只回答
「一次 `launchMs` 偏高是否主要来自设备侧文件页换入」，不定义阈值、回归容差或
`gate`。指标口径仍以 `docs/threshold-calibration.md` 和长期主规格为准。

## 1. 结论先行

`launchMs` 是**测量值**，不是代码质量分数。同一 App、同一构建的两次冷启动之间，
差值可以主要来自主线程等待文件页换入；这类偏高不是解析错误，也不是热降频。

因此：

- `pageFaults` 是**只读诊断**，写入 `run.json` 的 pass 记录并在报告「执行记录」呈现一行；
- 它**不参与**阈值、回归容差、`gate` 或样本筛选；
- `launchMs` 的算法、单位、名称、阈值和回归语义均未改变；
- 不要把 page-in 偏高当成放宽阈值的理由。

## 2. 环境与被测对象

| 项 | 值 |
| --- | --- |
| 设备 | `Ra的iPhone`，iPhone18,3，iOS 27.0.1，UDID `00008150-001E49E40128C01C` |
| 被测应用 | `com.nndev.im`（显示名 `NN`，可执行名 `NNIM`） |
| 工具链 | macOS 26.7.1、Xcode 27.2、`xctrace` 27.2 |
| 样本 | 5 个 `completed` 的既有 App Launch trace，未新增真机执行 |
| 分析日期 | 2026-11-17 |

## 3. 作用域定义

`pageFaults` 与 `launchMs` 使用**同一进程、同一时间窗**：

- 进程：`virtual-memory` 行的 `process` 归一化后等于 `life-cycle-period` 选中的显示名
  （如 `NN`）；无法解析时省略字段，不回退到其它进程。
- 线程：`thread` 归一化后以 `Main Thread` 开头。
- 时间：`start` 落在 `[min(launch phase start), max(launch phase end))`，与
  `launchMs` 的首尾同源同界。窗口直接取自报告里的 `phases` 边界（2 位小数），
  而 `launchMs` 用未舍入端点，两者最多相差 0.01 ms。
- 单位：`virtual-memory` 的 `duration` 原始值以纳秒计（`fmt` 显示为 µs），
  落盘统一换算为毫秒并保留 1 位小数。
- 统计：`File Backed Page In` 计入 `fileBackedPageIns` / `fileBackedPageInMs`；
  所有 operation 计入 `totalFaults` / `totalFaultMs`。

```jsonc
"pageFaults": {
  "fileBackedPageIns": 3229,
  "fileBackedPageInMs": 280.3,
  "totalFaults": 8792,
  "totalFaultMs": 298.3
}
```

字段缺失表示「未测量」，不得当作 0。

## 4. 样本

| Take（后 8 位） | `launchMs` | File Backed Page In 次数 | Page In 累计 | 全部 fault 次数 | 全部 fault 累计 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `HNZpxn_4` | 559.46 | 3,229 | 280.3 ms | 8,792 | 298.3 ms |
| `a7TaIH1X` | 463.63 | 1,419 | 148.9 ms | 8,461 | 187.9 ms |
| `5oUcc697` | 396.76 | 575 | 25.2 ms | 8,291 | 66.6 ms |
| `cM66VIEv` | 386.11 | 1,093 | 89.7 ms | 8,142 | 125.4 ms |
| `dJFHZ_tm` | 333.45 | 752 | 27.1 ms | 8,522 | 66.6 ms |

按 `launchMs` 排序的最低样本 `dJFHZ_tm` 与最高样本 `HNZpxn_4` 相比，page-in
次数差 **4.3 倍**，累计时长差 **10.3 倍**。

> 注：fault 累计时长与线程状态统计存在重叠（页内 I/O 等待在调度上可能计为
> on-core），因此以**次数差**和**量级差**作为主要证据，不要把它与 `launchMs`
> 做精确加减。

## 5. 主线程状态：差值在等待，不在计算

`thread-state` 表按主线程状态拆分同一窗口。窗口取 §4 两个样本的 lifecycle
相位边界，`thread-state` 行按重叠时间裁剪，只统计主线程：

| 窗口 | 高样本 `HNZpxn_4` Running / Blocked | 低样本 `dJFHZ_tm` Running / Blocked |
| --- | --- | --- |
| 生命周期空档（51.5 vs 7.0 ms） | 22.8 / **28.3 ms** | 6.4 / 0.5 ms |
| `sceneWillConnectTo`（252.4 vs 151.4 ms） | 136.5 / **114.3 ms** | 130.3 / 20.4 ms |
| `Initial Frame Rendering`（42.9 vs 40.7 ms） | 38.4 / 4.3 ms | 38.9 / 1.7 ms |

`Running`（真正占 CPU）几乎相等，差异集中在 `Blocked`，且阻塞是碎片化的：
先把相邻阻塞段按间隔 <0.05 ms 合并，再取 ≥1 ms 的段，生命周期空档内只有
2 段、合计 4.7 ms，不是死锁或单点锁等待。

旁证：两个样本在 `sceneWillConnectTo` 窗口的元数据 syscall 逐项一致——54 次
`open`、179 次 `getattrlist`、105 次 `stat`、68 次 `fstat64`；唯一显著差异是
数据读取：低样本 945 次 `pread`，高样本 87 次。相同的文件访问模式、不同的
缓存命中，正是 I/O 冷态的特征。

## 6. 已排除的解释

| 解释 | 证据 | 结论 |
| --- | --- | --- |
| 解析错误 | 用 trace 重解析得到的 `launchMs` 与落盘值逐位一致 | 排除 |
| 热降频 | `thread-state` 的 `thermal-throttled` 全表 0 条；`device.log` 无 thermal 事件 | 排除 |
| pass 顺序 / 冷却差异 | launch 永远是第 2 个 pass，`passCooldownMs` 与 `launchSettleMs` 相同，高低样本顺序一致 | 排除 |
| 录制配置差异 | 对比的两个样本 launch pass 均为 `full` / `App Launch` / `12s` / `full-session`；旧 run 仅缺 `liveTimeoutMs` 字段 | 排除 |

## 7. 已知边界：386–397 ms 档是另一类模式

`5oUcc697`（396.76 ms）的 page-in 只有 25.2 ms，与低样本基线（27.1 ms）相当，
但 `sceneWillConnectTo` 主线程 **Running 160.1 ms**（基线 130.3 ms）且
**Preempted 9.2 ms**（基线 0）。这说明 `launchMs` 至少存在两种独立偏高模式：

1. **I/O 冷态**：file-backed page-in 显著升高（515–580 ms 档）；
2. **启动 CPU 波动**：真实 `Running` 增加并伴随调度竞争（386–397 ms 档）。

本诊断只解释第 1 种。第 2 种不会因为 `pageFaults` 而被解释，读取时不要过度归因。

## 8. 对 gate 的实际影响（仅作背景）

| 场景 | 阈值 | 观测 | 后果 |
| --- | --- | --- | --- |
| `community-home-scroll` | warn 428 / fail 519 | 08:10 `559.46`、08:15 `515.07`、08:21 `557.15` | 2 次 fail、1 次 warn，代码未变 |
| `message-list-scroll` | warn 398 / fail 497 | `396.76` | 距 warn 仅 1.24 ms |
| `message-list-scroll` 回归 | 容差 10% | `396.76` 对基线 333.4（+19.0%） | 退出码 4，实际是 I/O 冷态 |

这些数字说明单次 `launchMs` 的判定力有限。**本诊断不修改这些阈值或容差**；
需要改变判定语义时必须另立 change 并通过方案门禁。

## 9. 复算方法

导出 `virtual-memory` 表（每次约 20 MB，5–8 秒）：

```bash
RUN=perfstage-c4-workspace/.performance-test/runs/2026-11-17T08-10-18.163Z-HNZpxn_4
xcrun xctrace export \
  --input "$RUN/traces/launch.trace" \
  --xpath '/trace-toc/run[@number="1"]/data/table[@schema="virtual-memory"]' \
  > /tmp/vm.xml
```

汇总规则：

1. 只保留 `thread` 以 `Main Thread` 开头、`process` 归一化为 `NN` 的行；
2. 把 `start`（纳秒）除以 `1e6` 得到毫秒，只保留落在
   `[第一个 launch 生命周期起点, 最后一个终点)` 内的行；
3. 每行计 1 次 fault，`duration`（纳秒）累加后除以 `1e6`；
4. `operation` 等于 `File Backed Page In` 的行另行计数与累加；
5. 毫秒结果保留 1 位小数。

变更后的 `run.json` 会直接保存同样的四个标量：

```bash
jq '.passes[] | select(.template == "launch") | .pageFaults' <run-dir>/run.json
```

若字段缺失，说明该 Take 未测量（trace 缺表、导出失败或作用域内没有匹配行），
**不要**用 0 代替。

## 10. 如何读取

- 先看 `pageFaults.fileBackedPageInMs / launchMs` 的占比，再看绝对值。
- 占比高且 `Running` 与基线相近：优先怀疑设备 I/O 冷态，而不是代码回归。
- 占比低但 `Running` 明显升高：属于启动 CPU 波动，本字段解释不了。
- 单次 `launchMs` 不足以判定回归；回归结论应结合多次 Take 的中位数与回归门禁。
- 需要让 page-in 影响判定（例如剔除样本或降级）时，必须新建 change，
  明确作用范围与证据语义；不得在本字段上直接加隐式阈值。
