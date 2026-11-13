# M2 真机重复性验证（3 次 Take）

> 目标：验证 H1 —— 同一个 Scene 连续执行 3 次，状态与指标都可重复，且证据完整可追溯。
> 设备：`Ra的iPhone`（iPhone18,3，iOS 27.0.1，UDID `00008150-001E49E40128C01C`）。
> 被测应用：`com.nndev.im` 6.7.1（容器 `B224D589-5720-4605-A245-60800386CE83`）。

## 1. 方法

M2 阶段还没有 Runner 与 CLI（M3 范围），所以本次验证用一个一次性驱动脚本
扮演 Skill 的角色：

```text
scripts/m2-takes.mjs
  ├─ prepare_performance_test          ← 真实 PerfStage 工具
  ├─ xctrace 录制 3 个 pass            ← 录制层（D13：只负责产出 trace）
  ├─ analyze_performance_trace ×3      ← 真实 PerfStage 解析
  └─ finalize_performance_test         ← 真实证据门禁 + 阈值 + 报告
```

驱动脚本不复制任何判定逻辑：指标解析、证据门禁、`status`/`gate` 优先级、
报告渲染全部走已发布的 PerfStage 代码路径。

### 每个 Take 的 3 个 pass

| pass | 模板 | 录制方式 | 产出指标 |
| --- | --- | --- | --- |
| 1 | Animation Hitches | 先 `mobilecli` 启动 App，`xctrace --attach <pid>` 后执行场景动作 | `hitches`、`blockMs` |
| 2 | App Launch | `xctrace --launch -- com.nndev.im` | `launchMs` |
| 3 | Activity Monitor | App 重新前台后 `--all-processes` 录制 12s | `memoryMB` |

多指标必须顺序录制：Instruments 一次只能跑一个模板（D4）。

### 场景与阈值

场景：`scenarios/community-home-scroll.yaml`（2 次滑动：上滑 700px / 下滑
700px，各 500ms，动作后停留 1500ms）。

| 指标 | warn | fail |
| --- | --- | --- |
| `hitches` | 5 | 15 |
| `blockMs` | 100 | 250 |
| `launchMs` | 800 | 1500 |
| `memoryMB` | 300 | 500 |

阈值属于项目定义，来自场景 YAML；`finalize` 自动推导每个指标的 verdict
与整体 `gate`。

### 证据口径

- **动作**：每个动作记录 `outcome` / `startedAt` / `endedAt` / `durationMs`。
- **指标**：每条指标都有 `tracePath`，trace 落在运行目录的 `traces/` 下。
- **日志**：按 `process=NNIM` 抓取 App 作用域的设备日志，原始流写入
  `device.log`。
- **Crash**：每个 Take 前后各取一次 Crash id 列表，做差集。
- **生命周期**：记录实际观测到的 `foreground` 事件；不推测未观测到的状态。

### 复现

```bash
cd performance-test-mcp
npm run build

node scripts/m2-takes.mjs \
  --workspace "/Users/leigod/雷神/性能分析/perfstage-m2-workspace-final" \
  --device 00008150-001E49E40128C01C \
  --scenario community-home-scroll \
  --takes 3 \
  --out docs/m2-takes.json
```

运行结果写入工作区 `.performance-test/runs/<runId>/`（`run.json`、
`plan.json`、`report.json`、`report.md`、`device.log`、`traces/`）。
本次三次的机器可读摘要见 [`m2-takes.json`](m2-takes.json)。

## 2. 结果

### 2.1 三次连续 Take

| # | runId | status | gate | hitches | blockMs | launchMs | memoryMB | 总耗时 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `2026-11-13T05-19-44.477Z-T1wM16z8` | `completed` | `fail` | 366 | 41.8 ms | 313.64 ms | 116.10 MB | 3m38s |
| 2 | `2026-11-13T05-23-47.396Z-asbbXG1T` | `completed` | `fail` | 350 | 45.8 ms | 302.52 ms | 115.05 MB | 2m54s |
| 3 | `2026-11-13T05-27-06.869Z-xdDOaOCq` | `completed` | `fail` | 242 | 50.6 ms | 316.16 ms | 114.89 MB | 3m05s |

三次都是 `status=completed`：四个指标齐全、都有 `tracePath`、动作全部
`executed`、Crash 差集为空、日志无 jetsam/watchdog。`gate=fail` 只由
`hitches` 触发，其余三个指标都是 `pass`。

`report.md` 里的指标行现在会带上单项 verdict：

```text
- hitches（次）：242（fail）
- blockMs（ms）：50.6（pass）
- launchMs（ms）：316.16（pass）
- memoryMB（MB）：114.89（pass）
```

### 2.2 指标波动

| 指标 | 中位数 | 最小 | 最大 | 极差 / 中位数 |
| --- | --- | --- | --- | --- |
| `hitches` | 350 | 242 | 366 | 35.4% |
| `blockMs` | 45.8 ms | 41.8 ms | 50.6 ms | 19.2% |
| `launchMs` | 313.64 ms | 302.52 ms | 316.16 ms | 4.3% |
| `memoryMB` | 115.05 MB | 114.89 MB | 116.10 MB | 1.1% |

结论很清晰：

- **`memoryMB` 与 `launchMs` 足以支撑单次门禁。** 跨三次的最大偏差分别约
  1.1% 与 4.3%，低于大多数项目愿意接受的噪声。
- **`blockMs` 中等稳定。** 41.8–50.6 ms 的区间意味着“最长卡顿帧”会随
  内容命中变化，单次值适合做上限告警，不适合做精确回归对比。
- **`hitches` 噪声最大。** 242–366 的跨度说明它高度依赖这两次滑动实际
  滚过的内容（图片、视频、分页加载）。用单次 `hitches` 卡死阈值会制造
  假回归；应取多次中位数，或只在基线对比中使用。

### 2.3 耗时

| pass | 第 1 次 | 第 2 次 | 第 3 次 |
| --- | --- | --- | --- |
| Animation Hitches（含解析） | 113.0s | 78.8s | 82.8s |
| App Launch（含解析） | 66.3s | 55.1s | 63.6s |
| Activity Monitor（含解析） | 28.0s | 31.5s | 29.4s |
| **单次 Take 合计** | **3m38s** | **2m54s** | **3m05s** |

第 1 次偏慢是因为 Hitches 录制第一次启动失败后按 30s 退避重试了一次
（kperf 锁未释放），报告里保留了 `hitches pass needed 2 attempts` 的备注。

### 2.4 试点数据（同一场景，非本次连续序列）

在最终 3 次之前还有 3 次可用的指标采集，用于观察跨会话稳定性：

| 时间 | status | hitches | blockMs | launchMs | memoryMB |
| --- | --- | --- | --- | --- | --- |
| 11:53 | `failed`（watchdog 误报，已修复） | 386 | 45.9 ms | 306.54 ms | 114.86 MB |
| 11:58 | `completed` | 341 | 50.0 ms | 358.96 ms | 114.86 MB |
| 12:01 | `completed` | 408 | 36.9 ms | 333.16 ms | 115.14 MB |

把 6 次合起来看，`memoryMB` 始终落在 114.86–116.10 MB，`launchMs` 落在
302–359 ms；`hitches` 落在 242–408。波动结构与最终 3 次一致。

## 3. 验证结论

| 假设 / 验收 | 结果 | 依据 |
| --- | --- | --- |
| H1：同一 Scene 可重复执行 | ✅ 成立 | 3/3 `completed`，产出同一组 4 个指标 |
| A1：Skill 能跑通真实场景 | ✅ 成立 | prepare → 3 pass → analyze → finalize 全链路 |
| A6：重复结果可用于判断回归 | ⚠️ 部分成立 | `memoryMB` / `launchMs` 稳定；`hitches` 需多次取中位数 |
| A4：缺证据不得 `completed` | ✅ 未被绕过 | 三次都有 trace、动作、Crash 差集与日志 |
| D6：阈值失败不污染 `status` | ✅ 成立 | `status=completed` + `gate=fail` |

**最重要的结论：单次 Take 的 `hitches` 不足以作为回归判据。** 这正是 M4
基线能力要解决的问题：保存多次 Take 的中位数与分布，再用“本次 vs 基线”
判断回归，而不是把单次绝对值直接写死成阈值。

### 阈值标定

场景里的 `hitches: warn 5 / fail 15` 是设计阶段的占位值。真实设备在两次
滑动窗口内稳定产生 242–408 个卡顿帧，说明这组阈值低了两个数量级。本次
**没有**为了让结果变绿而修改阈值；正确做法是在 M4 用基线分布重新标定，
并由项目自己决定可接受区间。

## 4. 本次暴露的问题

<!-- ISSUES -->

### 已在本次验证中修复

1. **`watchdog` 误报会让每个 Take 判为失败。**
   App 作用域日志里出现 WebKit 的 `XPCConnectionTerminationWatchdog`
   断言和 hangtracer 的 `Watchdog monitoring` 调试行，旧实现按整段文本正则
   匹配 `watchdog`，直接把 Take 判成 `failed`。
   现在按行判断，并排除这两类良性短语；真实的 `watchdog timeout` 仍然命中。

2. **指标 verdict 没有落盘。**
   `report.md` 只显示数值，看不到单个指标是 `pass` / `warn` / `fail`。
   现在 `finalizeRun` 会把推导出的 verdict 写回 `run.json` 与 `report.json`。

3. **`xctrace` 录制在连续 pass 之间会争抢 kperf。**
   上一次会话未完全释放时，`record` 可能挂起或直接失败。驱动现在会在
   启动失败时退避重试（最多 3 次），并记录重试次数。

### 工具链行为（写入驱动，避免踩坑）

| 现象 | 处理 |
| --- | --- |
| 两个已安装构建的进程都叫 `NNIM` / `NN` | 按容器 UUID 解析 `com.nndev.im` 的 pid，用 `--attach <pid>` |
| `--attach <pid>` 在录音过程中可能因 pid 变化失败 | 每次 pass 前重新解析 pid |
| `App Launch` 模板忽略 `--output` | 在 trace 目录按 mtime 找最新的 `Launch_*.trace` |
| 成功录制也可能返回退出码 1（warning） | 以 `Failed to start the recording` 是否出现为准，不看退出码 |
| `Activity Monitor` 不支持 `--launch` | 先启动 App，再用 `--all-processes` 录制 |
| 设备休眠 / 拔线会让 `devicectl` 报 4016 | 驱动直接失败，不伪造结果；恢复连接后重跑 |

### 仍未解决

- **`hitches` 的口径需要写清楚。** 当前值是 “卡顿帧数”（非绿色帧，或时长
  超过中位帧 1.3 倍的绿色帧），不是 sparse hang 事件数。两种口径的数量
  差异很大，报告与阈值必须注明用的是哪一种。
- **日志是 App 作用域快照。** 跨进程 jetsam 只能靠 Crash 差集发现。
- **生命周期只有一个 `foreground` 事件。** 驱动没有持续轮询前后台切换，
  不能用它证明“测试期间从未退后台”。



## 5. 边界

- 3 个指标需要 3 个顺序 pass，单次 Take 约 3 分钟；这是 D4 的硬约束。
- 日志是 App 作用域的快照，不是全设备日志；跨进程的 jetsam 只能通过
  Crash 差集发现。报告里的 `logText` 截取最后 5000 行，完整流保留在
  `device.log`。
- 生命周期只记录轮询观测到的前台事件，不代表完整状态机。
- 基线对比、历史趋势与 CI 门禁仍属规划（M4）。
