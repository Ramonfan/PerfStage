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
  --workspace "/Users/leigod/雷神/性能分析/perfstage-m2-workspace" \
  --device 00008150-001E49E40128C01C \
  --scenario community-home-scroll \
  --takes 3 \
  --out docs/m2-takes.json
```

运行结果写入工作区 `.performance-test/runs/<runId>/`（`run.json`、
`plan.json`、`report.json`、`report.md`、`device.log`、`traces/`）。

## 2. 结果

<!-- RESULTS -->

## 3. 验证结论

<!-- CONCLUSION -->

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


## 5. 边界

- 3 个指标需要 3 个顺序 pass，单次 Take 约 3 分钟；这是 D4 的硬约束。
- 日志是 App 作用域的快照，不是全设备日志；跨进程的 jetsam 只能通过
  Crash 差集发现。
- 生命周期只记录轮询观测到的前台事件，不代表完整状态机。
- 基线对比、历史趋势与 CI 门禁仍属规划（M4）。
