# 诊断加固（harden-diagnostics）

本文件记录 `harden-diagnostics` 的证据、决策与降级语义。它只回答「这次改动为什么可信」，
不复述接口细节；接口契约以 `openSpec/changes/harden-diagnostics/specs/` 为准。

## 1. 输入证据

| 证据 | 现象 | 旧行为 |
| --- | --- | --- |
| Take `2026-11-17T03-33-07.215Z-VfDA6EOn` | hitches 81 / blockMs 37.5 / launchMs 324.8 / memoryMB 112.28，四项全 pass | 因新增 `DTServiceHub.diskwrites_resource-2026-11-17-113330.ips` 判 `failed` |
| C4 采集 Take `yKaUpckY` | 指标正常 | 因 `SFA-*.json` 系统报告判 `failed` |
| 设备 Crash 列表（2026-11-17） | 16 条报告，14 条为 `SFA-*`、`DTServiceHub.*`、`WiFiLQMMetrics`、`locationd.*` 等系统报告 | 全部混入 App Crash 差集 |
| WDA 故障（2026-11-17） | `apps foreground` / 截图连续 30s 超时 | 录制前没有 agent 预检，多轮 Take 反复失败 |
| xctrace `never-live`（`UpJsPUul`） | 30s 退避重试 | 没有在录制前识别设备服务不健康 |
| 解析窗口告警 | `No frames between ...; the window missed the recorded interaction.` | 窗口内无 frame 时仍返回 `hitches = 0` 的结果 |

`DTServiceHub.diskwrites_resource` 是设备侧磁盘写入诊断，不是被测进程；它出现时 Take 的
指标本身全部通过。旧实现把所有新 Crash ID 都算作 App 崩溃，导致设备噪声污染 verdict。

## 2. 现在如何处理

### 2.1 Crash 按进程作用域归因

- 设备层读取 `mobilecli device crashes list` 的 `processName` 与 `timestamp`。
- 被测 App 作用域：`installation.processName`、`bundleId`、以 `bundleId.` 开头的扩展进程。
- 已知系统作用域（仅证据）：`SFA-*`、`DTServiceHub.*`、`WiFiLQMMetrics`、`locationd.*`、
  `proactive_event_tracker-*`、`xp_amp_*`。
- `process` 缺失或为空：仍按 App 作用域失败。`JetsamEvent` 特意不在忽略列表里，因为它可能
  描述被测 App 被内存终止。
- 系统报告写入 `report.json` 的 `diagnostics.crashes.ignoredIds` 与 notes，不改变
  `newIds`、状态或 `gate`。

可复核的断言：`src/__tests__/runner/crash-scope.test.ts` 直接覆盖身份分支（进程名、bundleId、
`bundleId.` 扩展、缺 `process`、六个系统模式、未知进程）；`src/__tests__/runner/run.test.ts`
的 `diagnostic hardening` 用例覆盖系统报告、App 报告、缺 `process`、健康检查期间系统报告、
预检在基线前失败、post-Take 崩溃查询失败六类路径。

### 2.2 日志完整性

- `LogStream.stop()` 返回 `exitedEarly`、`lineCount` 与 `exitReason`。
- 日志流在 Take 结束前自行退出时：`diagnostics.logTruncated = true`，归一化后
  `logs.truncated = true`，分类结果增加 `log-truncated` warning，最终状态按既有规则为
  `partial`。
- 主动停止的日志流 `truncated = false`；日志命令整体失败仍是 `logQueryError` →
  `unavailable`，不会被当成 clean。`LogStream.stop()` 自身抛错同样记为
  `logQueryError`（`unavailable`），不会落成 clean 的空日志。
- `lineCount = 0` 与 `truncated = true` 是两条独立信息，报告可以区分「空日志」与「截断日志」。
- 预检在读取 Crash 基线之前失败时，崩溃证据为 `unavailable`、`newIds = []`，不会用空基线
  去 diff Take 后的列表（也就不会把设备历史报告伪造成新增）。

### 2.3 录制前预检

顺序与预算：

1. `devices` / `requireDevice`；
2. 解析被测 App 安装；
3. `apps foreground` 探测自动化 agent（10s 上界）；
4. 读取 Crash 基线。

任何一步失败都在进入 `record` 之前结束 Take。预检失败不会产生新的 `traces/` 或设备侧长
trace；运行目录仍会保留失败报告与日志证据。预检复用同一条 `mobilecli` 命令封装，因此也
受 2.4 的一次性恢复约束。

预检之后，pass 之间的前台探测与动作结束后的「App 是否仍在前台」检查同样使用有界
`probeForeground()`。2026-11-17 首次真机运行曾在 memory pass 的裸 `apps foreground` 上
挂起约 15 分钟；有界探测把这类 WDA 挂起变成一次可归因失败，而不是拖住整条 Take。

### 2.4 `mobilecli` 传输故障的一次恢复

- 识别 `timed out`、`did not finish within`、`failed to start agent`、
  `Timed out waiting for response`、`WebDriverAgent`、`daemon`、`transport/tunnel`。
- 最多执行一次 `mobilecli daemon stop`，然后重试同一命令；每次 Take 共享一个恢复预算。
- 恢复事件以 lifecycle `daemon_restart` 写入报告，notes 记录成功或重试失败；时间戳统一使用
  Take 时钟，保证落在运行窗口内。
- 非传输错误（App 未安装、参数非法、JSON 解析失败）不触发重启；重试仍失败时抛出原始错误。
- `daemon stop` 的超时上界不超过原命令的超时，避免恢复本身拖长失败路径。

### 2.5 hitches 窗口二次对齐

- 解析器在声明窗口内无 frame 时返回 `windowMiss`（声明窗口 + trace 全域 frame 起始时间）。
- Runner 只尝试一次对齐：
  - 候选窗口宽度不变；
  - 起点相对原窗口的平移量不超过原窗口宽度；
  - 候选至少包含 2 个 frame；
  - 起点早于录制 1s 的候选被排除（冷启动帧不算场景）；
  - 排序固定为 frame 数降序、平移绝对值升序、起点升序。
- 命中后重新分析一次，notes 记录原窗口、平移量、对齐窗口与候选 frame 数。
- 无候选、平移越界、frame 元数据缺失：Take 判 `invalid`，不得 `completed`，也不得把
  `hitches` 记为 0。抛出前先写入解析器 warnings 与 pass 证据，trace 不会成为孤立文件。

**已知限制（设计 D5 已接受）**：trace 只有 frame 时间戳，没有动作相位元数据。1s 之后、
紧邻声明窗口的暖机帧或录制尾部帧无法仅凭时间戳与场景帧区分。对齐发生时 notes 会显式
列出原窗口、平移量与对齐窗口，读者可以据此审计；这不等同于「任意窗口都可信」。

**legacy `hitches` 表**：该表是已分类的 hang 行，不是 frame。窗口内没有 hang 行是合法的
`hitches = 0`，不会产生 `windowMiss`，也不会进入上面的对齐路径；若 trace 中存在 hang 行
但全部落在声明窗口外，报告会追加一条说明性 warning（`hitches=0` 只描述该窗口），而不是
把它当成整段 trace 都顺滑的证据。

## 3. 兼容与降级

- 新增字段全部可选：`crashReports[].process`、`ignoredIds`、`logs.truncated`、
  `logs.truncationReason`、lifecycle `daemon_restart`。旧 `run.json` 缺字段时解析成功，
  既有结论不变。
- 旧运行没有 `ignoredIds`：`diffCrashIds` 行为与之前一致（所有新 ID 都算 App Crash）。
- 无法归因的 Crash 仍失败；无法读取的日志仍是 `unavailable`；无法对齐的窗口仍是 `invalid`。
- 绝对阈值、回归容差与 `gate` 语义不变。

## 4. 真机验证记录

见 `openSpec/changes/harden-diagnostics/tasks.md` 的交付记录；此处只记录可复核结论：

- Take `2026-11-17T04-13-24.250Z-cM66VIEv`（iPhone 17 / iOS 27.0.1）：
  `completed`、`gate=pass`；hitches 78、blockMs 37.5ms、launchMs 386.11ms、
  memoryMB 113.02，四项绝对值 pass；`crash new [] ignored []`、
  `logs truncated False lineCount 13125`、findings 为空。
- 同一 Take 的回归检查（`gate --samples 5`）退出 4：`launchMs` 386.11ms 对
  5 样本基线中位数 337.02ms 为 **+14.57%**，超过既有 10% 容差。这是真实性能观测
  （此前 `5oUcc697` 为 +19.0%），不得为转绿而放宽容差；诊断加固未改变 launch 的
  采集与阈值路径，但该回归仍需重采样或排查冷启动环境后再交付。
- 真实数据重放：用 `VfDA6EOn` 的原始 `crashIdsBefore` / `crashIdsAfter` 跑新分类器，
  唯一新增的 `DTServiceHub.diskwrites_resource-2026-11-17-113330.ips` 被判为系统报告，
  `newIds=[]`、`ignoredIds=[该 ID]`、`severity=none`；旧实现的同一数据为
  `new-crash` → `failed`。
- `daemon_restart` 恢复路径以可控 fake 覆盖（`mobilecli.test.ts` 与
  `run.test.ts`）成功与重试失败两条分支；真机侧在 2026-11-17 用受控包装器触发了一次
  真实的「重试仍失败」路径（见下条）。
- 阻断 agent 的录制前失败测试（2026-11-17，Take `2026-11-17T05-07-06.442Z-ihcVP2Ya`）：
  只阻断 `apps foreground`、拦截 `daemon stop` 的包装器下，`run` 以 exit 2 在录制前失败，
  运行目录无 `traces/`，运行前后 `$TMPDIR/instruments*.ktrace` 均为 0；崩溃证据
  `unavailable`、`newIds=[]`、无 `new-crash`；lifecycle `daemon_restart` 时间戳落在
  run 窗口内。受控包装器没有真正停止 daemon，运行后设备仍可用。
- xctrace 在每次录制后会在 `$TMPDIR` 留下 `instruments*.ktrace` 临时 spool（本次
  3 个、合计约 5.5G）。这不是本 change 新增的代码路径，但会占用磁盘；已手工清理，
  清理后 `$TMPDIR` 为 315M。临时 spool 的自动清理列为后续事项，不并入本次范围。

## 5. 已知限制

- 系统进程允许列表是显式的，未知系统进程仍按 App Crash 处理。这是有意的保守选择。
- `process` 字段依赖 `mobilecli` 的 `processName`；若上游移除该字段，所有新报告都会回到
  保守失败路径。
- 窗口对齐只处理整体平移，不处理录制拉伸/压缩；密度与平移上界无法覆盖所有错位形态。
- 启动阶段上界固定为录制开头 1s；1s 之后紧邻窗口的暖机/尾部帧无法仅凭时间戳排除，
  对齐结果依赖 notes 审计（设计 D5 的已知限制）。
- 预检复用 driver 的默认单次超时（devices/crash 基线 ≤60s、安装解析 ≤120s），没有压缩到
  D3 初稿的 5/10/10/5s；更紧的预算需要设备层 per-call timeout，列为后续事项。
- 日志截断只给出 warning，不保证日志覆盖整个 Take 的每一行；它只是把「不完整」显式化。
