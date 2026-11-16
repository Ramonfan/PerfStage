# M3 真机验证：Runner 与一键执行（2 个场景 × 3 次 Take）

> 目标：验证 H2（Claude 退出执行链）与 H3（重复测试只需执行一次 Skill/命令）。
> 结论先行：**一条 `perfstage run` 能在真机上独立完成一次 Take**，状态、指标与
> 证据都可重复；`hitches` 的场景内波动仍然最大，单次值不足以判断回归（与 M2
> 结论一致，M4 处理）。

> **状态（2026-11-16）：矩阵已完成并通过。** 2 场景 × 3 Take 全部
> `status=completed`，跑在同一个固定构建上（HEAD `0c6b77a`，`dist` 构建于
> 08:54:26）；`docs/m3-takes.json` 已生成，§2 结果与 §3 验收对照已补齐。
> `gate=fail` 来自占位阈值的 `hitches` 线，是预期结果。矩阵途中排除的两次
> 失败——主机侧 `xctrace` 保存崩溃、系统级 `JetsamEvent` 误判——见 §5。

- **设备**：`Ra的iPhone`（iPhone18,3，iOS 27.0.1，UDID `00008150-001E49E40128C01C`）
- **被测应用**：`com.nndev.im` 6.7.1（可执行名 `NNIM`，显示名 `NN`）
- **工具链**：macOS 26.7.1、Xcode 27.2、`xctrace` 27.2、Node 20+
- **构建**：`npm run build` 后的 `dist/cli/bin.js`，被测代码即本次提交
- **工作区**：`/Users/leigod/雷神/性能分析/perfstage-m3-workspace`

## 1. 方法

M2 用一个一次性驱动脚本扮演 Skill；M3 不再需要脚本。每次 Take 只有一条命令：

```bash
perfstage run <sceneId> \
  --device 00008150-001E49E40128C01C \
  --dir /Users/leigod/雷神/性能分析/perfstage-m3-workspace \
  --json
```

命令行内部走的是与 `run_performance_test` 完全相同的 `runTake`：

```text
runTake
├─ prepare            解析场景 → TestPlan → run.json / plan.json
├─ pass 1  Animation Hitches   --launch 冷启动 App；warmup + actions 都在录制内回放，
│                              指标只取 actions 所在的时间窗（D15），冷启动帧不计分
├─ pass 2  App Launch          --launch，冷启动测 launchMs
├─ pass 3  Activity Monitor    --all-processes，按 pid 取 phys_footprint
├─ analyze             每个 pass 结束立即用 PerfStage 自带解析器解析
└─ finalize            证据门禁 + 阈值 + report.json / report.md
```

`--json` 输出与 MCP 工具返回同构；进程退出码用于脚本消费：

| 退出码 | 含义 | 本次矩阵 |
| --- | --- | --- |
| `0` | 测试有效，未越过阈值 | — |
| `1` | 测试有效，`gate=fail` | 全部 Take |
| `2` | 测试本身不可信（`partial` / `failed` / …） | — |
| `3` | 无法运行（工作区、设备、依赖、输入） | — |

矩阵脚本按场景串行执行 3 次；同一时刻只有一台设备、一个 `xctrace` 会话。
机器可读汇总见 [`m3-takes.json`](m3-takes.json)。

设备与工作区前置条件：

1. 同名可执行文件的第二份构建可以并存运行。hitches pass 用 `--launch`，不受
   影响；memory pass 按容器 UUID 选择进程（`0c6b77a`），也不再要求单实例。
   矩阵脚本仍会在每个 Take 前终止另一份 NN（`com.nnhuyu.im`），作为保守清理；
   双构建并存的 memory pass 尚未在真机复测，M4 需补证据。
2. 设备必须处于干净的前台状态：别的 App 的系统弹窗会让被测 App 拿不到前台，
   `--launch` 录制同样会因等不到前台而失败（原因见 §4.3 / §4.4）。

### 场景

| 场景 | 前置 | 录制窗口内动作 | 说明 |
| --- | --- | --- | --- |
| `community-home-scroll` | App 冷启动即进入社区首页 | 连续上滑 5 次：每次 700pt（受安全区限制实际约 524pt）、500ms + 0.5s 停留 | 无 warmup |
| `message-list-scroll` | warmup 点「消息」tab | 上滑 700pt / 下滑 700pt，各 500ms + 1.5s 停留 | 验证带导航的 warmup |

两个场景的阈值相同，都是 M0 的占位值：`hitches` warn 5 / fail 15，
`blockMs` 100 / 250，`launchMs` 800 / 1500，`memoryMB` 300 / 500。
本次**没有**为了变绿而改阈值。

## 2. 结果

全部 6 个 Take 在**同一个固定构建**上完成：`performance-test-mcp` HEAD `0c6b77a`，
`dist/cli/bin.js` 构建于 2026-11-16 08:54:26，矩阵期间没有重建、没有换构建。
设备 `Ra的iPhone`（iPhone18,3，iOS 27.0.1，UDID `00008150-001E49E40128C01C`）。
机器可读记录见 [`m3-takes.json`](m3-takes.json)，其中 `passes` 指向每个 Take 的
实际 trace 文件。

### 2.1 每 Take 结果

| 场景 | Take | status | gate | hitches | blockMs | launchMs | memoryMB |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `community-home-scroll` | T1 | completed | fail | 484 | 104.2 | 295.51 | 111.38 |
| `community-home-scroll` | T2 | completed | fail | 483 | 37.5 | 311.31 | 113.53 |
| `community-home-scroll` | T3 | completed | fail | 448 | 91.7 | 344.76 | 111.77 |
| `message-list-scroll` | T1 | completed | fail | 94 | 37.5 | 452.97 | 113.52 |
| `message-list-scroll` | T2 | completed | fail | 84 | 41.7 | 315.99 | 112.49 |
| `message-list-scroll` | T3 | completed | fail | 89 | 37.5 | 485.24 | 112.11 |

**6/6 为 `status=completed`**，没有一个是靠放宽阈值或改写状态得到的。
`gate=fail` 全部来自 `hitches` 的占位阈值（fail 线 15），是预期结果，
不代表产品回归——本次**没有**为了变绿而改任何阈值。

完整 runId 见 `m3-takes.json`；原始产物在
`perfstage-m3-workspace/.performance-test/runs/<runId>/`（`run.json`、
`plan.json`、`report.json`、`report.md`、`device.log`、`traces/`）。Crash 报告
只以 id 形式记录在 `report.json` 的 `diagnostics.crashes` 里，运行目录下没有
单独的报告副本。

`m3-takes.json` 与 `m2-takes.json` 同构，只有一处不同：本次覆盖两个场景，
所以顶层用 `scenarios`、每条记录带自己的 `scenarioId`（M2 只有一个场景，
用的是顶层 `scenarioId`）。

### 2.2 采集完整性

| 检查 | 结果 |
| --- | --- |
| 动作 | `community-home-scroll` 5/5 `executed`（`swipe 201,699 → 201,175 on 402x874`）；`message-list-scroll` 3/3（`open-message-tab` + 上滑 + 下滑） |
| pass | 每 Take 3 个 pass（hitches / launch / memory）全部成功，`attempts` 均为 1 |
| trace | `duration` 17.247584–17.745639s，`end-reason` 全部为 `User pressed Stop` |
| 动作窗口 | community 6.09–14.19s；message 9.10–14.74s（均落在 trace 内，未截断） |
| 新 Crash | 6/6 的 `newIds` 为空 |
| 日志 | `lineCount` 202–30 457，三态均为 `available`（差异原因见 §5） |

### 2.3 波动

| 指标 | community 中位数 | 极差 | message 中位数 | 极差 |
| --- | --- | --- | --- | --- |
| `hitches` | 483 | 448–484（36，7.5%） | 89 | 84–94（10，11.2%） |
| `blockMs` | 91.7 | 37.5–104.2（66.7） | 37.5 | 37.5–41.7（4.2） |
| `launchMs` | 311.31 | 295.51–344.76（49.25） | 452.97 | 315.99–485.24（169.25） |
| `memoryMB` | 111.77 | 111.38–113.53（2.15） | 112.49 | 112.11–113.52（1.41） |
| 单 Take 墙钟 | 257s | 249–260 | 231s | 206–252 |

两个场景的 `hitches` Take 间波动分别是 7.5% 和 11.2%，而两场景之间的绝对值差了
约 5 倍（483 vs 89）。这说明**场景差异远大于同一场景的 Take 间波动**，
用单次 `hitches` 跨场景比较没有意义；同场景多 Take 的中位数与极差可用，
这也再次印证 M4 的基线必须按场景分别建立。

## 3. 验收对照

| 编号 | 验收项 | 结论 | 证据 |
| --- | --- | --- | --- |
| A2 | 一次调用完成，无中间人工步骤 | 通过 | 每个 Take 只执行一条 `perfstage run <scene> --device … --dir … --json`；6/6 `completed`，矩阵脚本无人工介入 |
| A3 | 至少 4 个指标带 trace 落盘 | 通过 | 每 Take 3 个 trace：`hitches.trace`（`hitches`/`blockMs`）、`launch.trace`（`launchMs`）、`memory.trace`（`memoryMB`）；路径记录在 `m3-takes.json` 的 `passes` |
| A8 | 单次运行 ≤ 8 分钟（15s 场景 + 4 指标） | 通过 | 墙钟 206–260s（3.4–4.3 分钟），最慢 260s |
| A9 | 既有用例保持通过，新增 ≥ 30 | 通过 | `npm test` → 40 files / 360 tests 全通过（2026-11-16 09:49，源码未变） |
| A10 | 2 个真实场景在真机跑通 | 通过 | 2 场景 × 3 Take，6/6 `completed` |
| A6 | 同一场景连续 3 次结果有效 | 观察（支持，不计入本 change 主张） | 两个场景各 3 次均为 `completed`，无采集/设备错误；波动见 §2.3。M3 的验收行只列 A2/A3/A8/A9/A10，这里只作观察，不单独声明通过 |
| A5 | 新增 Crash 时状态为 `failed` | 观察到的真实实例 | `community-home-scroll` T1 第 1 次尝试因新增 `JetsamEvent-2026-11-16-091522.ips` 被判 `failed`、未计入矩阵（见 §5）；这是真实触发，但没有用一次 App 自身 Crash 构造用例 |

**结论：M3 的矩阵验收通过。** 6 个 Take 全部来自同一固定构建、证据完整、
无假通过。`gate=fail` 是占位阈值的预期结果；阈值重标定按路线图留到 M4，
本次不调整。

## 4. 本次暴露并修复的问题

### 4.1 日志流提前退出，却被当成“有日志”

消息列表的原始 T2（run `2026-11-13T06-30-00.373Z-9S8KXpwe`）只采到
147 行 / 44 KB 日志，却仍是 `status=completed`。对比同一场景的 T1
（24 935 行）可以确认：`mobilecli device logs` 在 Take 中途退出了，
`Runner` 只看到“有文本”，于是把一段残片当成完整证据。

修复：`startLogStream` 记录子进程是否在 `stop()` 之前自行退出；若是，
`stop()` 返回明确的错误文本，`finalize` 因此把日志判为
`unavailable` → `status=partial`。**宁可降级，也不把残片当完整日志。**

### 4.2 全量日志把 App 启动期的良性噪声带了进来

M2 只保留日志尾部 5 000 行；M3 改成让诊断扫描完整日志后，消息场景的一次
复跑（run `2026-11-13T06-37-48.948Z-74yKj6cz`）被判 `failed`：

- `watchdog`：`XPCConnectionTerminationWatchdog` 断言、
  `Watchdog monitoring: starting monitor`、
  `defaultWatchdogBehavior` / `watchdogTransitionContext` 方法注册；
- `jetsam`：`registering method "jetsamPriority"`。

过滤掉前两类之后，紧接着的一次 probe（run
`2026-11-13T06-48-30.879Z-ThvdpkSz`）又因 WebKit 的
`Memory pressure relief: Total: res = …` 被判 `partial`——那是 WebKit
**回收完内存后的正常日志**，不是发给 App 的 `memory warning`。

这些都在 App 启动的前几千行，旧实现因为只看尾部而从未见过。修复方式是
按短语排除（而不是按位置），真实 `watchdog timeout` /
`memorystatus: jetsam` / `Received memory warning` 仍然命中。这也是
**全量日志必须配全量过滤** 的直接证据：同一个 Tail→Full 的改动，一次性
暴露了三类原本看不见的良性噪声。

### 4.3 `--attach <pid>` 对**存活的** pid 报 `Cannot find process`（现已由 D15 绕开）

社区场景的 T1（run `2026-11-13T06-41-39.832Z-14-bZHj2`）在冷启动后解析到
pid `7236`，`xctrace` 却报 `Cannot find process for provided pid: 7236`。

最初的判断是“pid 已消失”，因此把 `pid-gone` 定为**不可重试**，交给 Runner
重新冷启动。真机复测推翻了这个判断：同一个仍然存活的 pid 会在几十秒后
**被同一个命令接受**。原始记录（pid 未变、进程一直在）：

| 时刻 | 操作 | 结果 |
| --- | --- | --- |
| 16:14 | `--attach 1040` | 挂住，22s 后被杀 |
| 16:16 | `--attach 1040` | `Cannot find process for provided pid` |
| 17:0x | `--attach 623` 连续 3 次 | 全部 `Cannot find process` |
| 17:0x+2min | `--attach 623` | 成功录制 |

设备侧日志给出了原因：请求确实到达设备，`DTServiceHub` 也把整个进程表
（578 个进程的 `RBSProcessHandle` + bundle 解析）枚举了一遍，但这次枚举的
结果与 `devicectl` 看到的不一致。**这是设备侧进程表的滞后，不是 pid 消失。**

修复（中间方案）：`pid-gone` 改为**可重试**，但用更短的退避（5s，而不是 kperf 的 30s），
先在**同一个 pid** 上重试；三次都失败后 Runner 仍然会重新冷启动、重新解析
pid 再试一次。

修复（最终方案，D15）：这类竞态无法在客户端彻底消除，所以 hitches pass 不再
`--attach`，改为 `xctrace --launch` 让 xctrace 自己拉起 App，并用**动作时间窗**
把冷启动帧排除在指标之外。M0 的 spike 已经给出同样的结论（`--attach` 有竞态、
`--launch` 稳定）；M2/M3 为了把 warmup 放在录制窗口之外又用回了 attach，D15
用「录制内 warmup + 时间窗」换回了可靠性。同一条真机 `--launch` trace 的实测：

| 口径 | hitches | blockMs |
| --- | --- | --- |
| 全量 trace（含冷启动） | 333 | 350.1ms |
| 动作窗 8–14s | 172 | 58.1ms |
| M2 attach 参考值 | 168 | 35.3ms |

窗口口径与 attach 参考值可比，且冷启动的 350ms 卡顿帧被正确排除。
`src/__tests__/recording/xctrace.test.ts` 仍断言同一 pid 重试 3 次——attach
作为底层能力保留，只是 Runner 不再使用。
`src/__tests__/runner/run.test.ts` 现在断言 hitches 请求的 target 是
`launch`（且整个 Take 不出现 `attach`），并断言分析器收到时间窗。

### 4.4 同名可执行文件会让 attach 永久失败（D15 后只影响 memory pass）

设备上同时装了两个 NN：

| Bundle | 容器 | 版本 | 可执行文件 |
| --- | --- | --- | --- |
| `com.nndev.im` | `B224D589-…` | 6.7.1 | `NNIM` |
| `com.nnhuyu.im` | `533869D3-…` | 10.0.0 | `NNIM` |

两个都在运行时，`--attach <pid>` 对**任意一个**都报
`Cannot find process for provided pid`；A/B 对照可复现：

```text
只运行 com.nndev.im      → --attach 551  成功
再启动 com.nnhuyu.im     → --attach 551  Cannot find process
终止 com.nnhuyu.im 并等待 → --attach 551  成功
```

按名字 attach 也会变成歧义（`--attach NN` 列出两个 pid 后退出码 20）。
所以这不是 PerfStage 的 bug，而是设备侧 Instruments 进程表以**可执行文件名**
索引造成的冲突；只要两份 `NNIM` 同时存在，该名字下的 pid 就查不到。

当时的修复：`resolvePid` 在解析目标 pid 时检查是否还有别的进程共用同一个可执行
文件名，命中就抛 `duplicate-process`，消息里带上两个 pid，直接告诉操作者
“有另一份同名进程在跑”。这比录 3 次、每次等 30 秒再报一个含糊的
`cannot find process` 有用得多。

D15 之后 hitches pass 不再 attach，这个冲突只剩 **memory pass** 会碰到。
`0c6b77a` 进一步把 `resolvePid` 改为按容器 UUID 选择目标进程（容器 UUID
唯一标识一次安装），同名构建因此不再被判为致命，`duplicate-process` 不再
触发；测试见 `src/__tests__/device/mobilecli.test.ts`
（`resolvePid container selection`）。双构建并存的 memory pass 还没有真机
复测，矩阵脚本的单实例前置终止保留为保守清理，而不是硬性前置条件。

### 4.5 工具链既有行为（已在 M2 记录，本次再次确认）

| 现象 | 处理 |
| --- | --- |
| 连续 pass 争抢 kperf，`record` 启动失败 | 录制层退避重试，最多 3 次（30s 间隔）；报告记录 attempts |
| `App Launch` 结束会把 App 退到后台 | 启动类计划先显式探一次前台，再进 launch pass |
| `terminate` 偶尔报 `process not found` / 超时 | 视为“已经不在运行”，不阻断 Take |
| `Activity Monitor` 不支持 `--launch` | 先启动 App，再 `--all-processes` 录制，按 pid 取值 |

### 4.6 别的 App 的系统弹窗会阻塞整轮矩阵

第一轮正式矩阵（18:03–18:17）**18 次尝试全部失败**，每条日志都是同一句：

```text
fatal: com.nndev.im did not reach the foreground within 20000ms;
        foreground was com.apple.springboard (_SBAlertController)
```

`dump ui` 显示屏幕上停着另一个 App 的系统授权弹窗
（`允许"Video Saver"使用无线数据？`）。PerfStage 的判定在这里是正确的：

- 18 次全部 `status=failed`、`gate=unknown`、指标为空；
- 报告写明当时前台的真实归属（`_SBAlertController`），操作者不需要猜。

**没有一次**被记成成功，也没有把“没抢到前台”算成 0 卡顿。点掉弹窗后
同一套命令立即恢复正常，这反过来证明失败归因是对的。

这条对产品有一个直接含义：**“设备就绪”不等于“屏幕干净”**。M4 可考虑在
preflight 里显式检查前台是否为 SpringBoard/被测 App，并把“有系统弹窗”作为
可读的前置失败，而不是等到 `waitForForeground` 超时。

### 4.7 设备中途断开时，已测到的指标曾被整体丢弃

第二轮矩阵的第一次 Take（`2026-11-13T10-17-34.827Z-cVxyTvjm`）跑满了 3m22s：
`hitches.trace`（577 MB）与 `launch.trace` 都已录制，随后 USB 断开，
memory pass 冷启动时失败：

```text
fatal: launch com.nndev.im failed (exit 1): … Device '…' not found.
        Is it attached to the machine?
```

报告是 `status=failed`（正确），但 `metrics` 是**空的** —— 看起来像“什么都没
测到”，实际上 `hitches` / `blockMs` / `launchMs` 已经录完并解析完。原因是
`measureRound` 只在整轮成功结束时才返回结果，中途抛错就把本轮的测量全部
丢掉了。

修复：`measureRound` 改为向 `RoundSink` 实时累积，`executeTake` 在 `finally`
里合并。语义没有放松——**`status` 仍是 `failed`，`gate` 仍是 `unknown`**——
只是把已经发生的测量当作证据保留下来，报告能说明“测到哪一步断的”。测试见
`src/__tests__/runner/run.test.ts`（`keeps the metrics measured before a late
pass fails`），断言 memory pass 失败后 hitches/blockMs/launchMs 及其
`tracePath` 仍然在报告里。

这也说明**矩阵必须用一个固定构建**：本次第一轮与第二轮用的是不同 `dist/`，
所以即使第一轮成功也不应混进最终结果。

### 4.8 滑动手势曾把 App 滑进后台，随后给系统 UI 打分

第三轮矩阵 6/6 次尝试在 `status=completed` 之前失败，用户观察到的现象是：
App 启动后第一次上滑，App 直接退到后台；紧接着的下滑落在 SpringBoard 上，
打开了 Spotlight。日志里每一步却都是：

```text
action scroll-up-1: executed
```

根因在坐标：`inferScreenSize` 用 App 的 UI 树推屏幕尺寸，社区首页的滚动视图
报出 `402×969`，而真机屏幕是 `402×874`。旧的 `EDGE_INSET = 80` 让“上滑”从
`y = 969 − 80 = 889` 开始——**已经在屏幕外**。iOS 把手势当作 Home 指示条上滑，
App 因此进入后台；下一条动作自然打在系统 UI 上。手势本身没有报错，录制也
“成功”了，于是失败被伪装成一次普通 Take。

手动验证：在真机上执行 `io swipe 201,700 → 201,200`，社区列表正常滚动，
`apps foreground` 仍是 `com.nndev.im (NNCommunity.CommunityHomeNextVC)`。

修复分三层：

1. **尺寸来自设备，不来自 UI 树。** `requireDevice` 额外调用
   `mobilecli device info`，把 `screenSize`（点，非像素）带回 `DeviceInfo`；
   `executeTake → measureRound → executeAction` 一路传递。拿不到尺寸时，
   滑动动作**直接失败**并说明原因，不再猜一个可能越界的坐标。
2. **手势限制在安全带内。** 纵/横轴都只用 20%–80% 区间：底部 20% 是 Home
   指示条，顶部 20% 是状态栏/灵动岛，左边缘是返回手势。`distance` 超过带宽
   时按带宽截断，起止点永远在屏幕内。
3. **动作后校验前台 App。** hitches pass 在 `runActions()` 之后检查
   `foreground.bundleId`；不是被测 App 就抛错：
   `the device left com.nndev.im while the actions ran …; refusing to score
   system UI as scenario hitches`。该错误发生在 `during` 内，录制层会先
   SIGINT 收尾再抛出，不会留下悬挂会话；Take 如实记为 `failed`。

坐标现在写进动作记录（`swipe 201,699 -> 201,175 on 402x874`），报告和实时日志
都能看到手势落在哪里，而不是只有一句 `executed`。测试见
`src/__tests__/runner/actions.test.ts`（安全带、真机尺寸优先、缺尺寸拒绝执行）
与 `src/__tests__/runner/run.test.ts`（`fails the hitches pass when a gesture
leaves the app`）。

**这推翻了此前唯一一次“成功”的 Take**（`community-home-scroll` T1，
19:12，hitches window 6755–15291ms）：它来自同一份含此 bug 的 `dist/`，
动作虽然跑完，但无法证明全程停留在社区页。按“不把失败的记成成功”的原则，
它不计入最终矩阵；最终结果必须由修复后的固定构建重跑。

### 4.9 反复录制 + 硬杀 xctrace 会把设备 Instruments 服务搞成“需要重启”

最后一轮排查里，App **每次启动就崩**，只有重启手机才恢复：

```text
NNIM/DBBootstrap.swift:20: Fatal error: Database bootstrap failed: SQLite error 10: disk I/O error
status:signal(2) code:SIGTRAP(5)          // 启动 1.2s 后
```

同期设备日志里出现内核 `ENOSPC`（`logd`、`cloudd`、`searchpartyd`、
`DTServiceHub` 都报 `No space left on device`），一度被误判为“手机存储满了”。
但 `TotalDataAvailable` 是 208GB，`app_v1.sqlite-wal` 的 mtime 也一直在更新——
写有时成功、有时失败，是**间歇性**的，不是真正的磁盘满。

根因是设备侧的 `com.apple.instruments.deviceservice`（宿主侧进程
`DTServiceHub`）被拖垮了：

- 之前每次停止录制，只给 xctrace **10 秒**收尾，超时就 `SIGKILL`。真机上
  几百 MB 的 trace 保存要 1–2 分钟，10 秒几乎必然硬杀；硬杀发生在保存中途，
  设备侧 tap session 就留在那里没释放。
- 每失败一次就重试（最多 3 次 × 3 个 pass），session 越积越多，最终
  `Failed starting ktrace session`。
- `mobilecli apps launch` 走的也是同一个 `com.apple.instruments.deviceservice`
  （不是独立启动通道），所以“App 启动就崩”其实是启动/容器服务不可用，
  App 自己拿到了坏掉的 I/O 状态才在 `DBBootstrap` 里 SIGTRAP。
- 重启手机清空设备侧服务后一切恢复——这也解释了为什么“以前一直好好的”。

修复（**先保护设备，再谈指标**）：

1. **不再硬杀。** SIGINT 后的宽限期从 10s 提到 **5 分钟**
   （`DEFAULT_SIGKILL_GRACE_MS = 300_000`），`waitForClose()` 用 unref 定时器，
   不会拖住进程退出；5 分钟仍不退出才 `SIGKILL`。杀掉 xctrace 比等它保存完
   贵得多。
2. **卡死的设备服务直接熔断，不重试。** `Failed starting ktrace session`
   归为新错误 `instruments-wedged`、`retryable: false`，错误文案直接写
   “需要重启设备”。重试只会继续磨损设备。
3. **损坏的 trace 不再当成“零卡顿”。** xctrace 对“目标 App 已退出”和
   “从设备传回的 trace 不完整”都返回 0，还留下一个能解析但没有任何帧的
   `.trace`，看起来就像“一次都没卡”。现在按输出内容判为
   `malformed-trace` / `app-exited`，**非重试**，并在分析前删掉空壳 trace。
4. **录制前先做 5 秒健康探测。** `checkAppHealth()` 先确认 App 能活着
   （pid 在、且没有新增 crash 报告），否则立刻失败、一个录制会话都不开。
   M3 曾用 82 秒产出 3 个坏 trace 才发现 App 根本起不来。
5. **pass 之间冷却 10s、Take 之间 30s。** 设备侧 session 需要时间释放；
   2s 不够，这正是 `Failed starting ktrace session` 的高发条件。
6. **失败时把设备日志里的原因写进报告。** `extractDeviceFailureCause()`
   优先摘 App 自己的 `Fatal error:`，其次数据库、磁盘、Instruments 相关行，
   报告里的 `fatalError` 从“no frames”变成
   “Database bootstrap failed: SQLite error 10: disk I/O error”。
7. **矩阵脚本遇设备不健康直接中止（退出码 2）。** `run-final.sh` 匹配
   `instruments-wedged|Failed starting ktrace session|malformed-trace|
   app-exited|did not stay running|crashed during the health check`，
   命中就停，提示重启手机后重跑，而不是继续重试。

测试见 `src/__tests__/recording/xctrace.test.ts`（`fatal-trace guards`）、
`src/__tests__/diagnostics/cause.test.ts`、`src/__tests__/runner/run.test.ts`
（`device-health guards`）。

**代价与取舍：** 5 分钟宽限意味着一次真正挂死的录制最坏要多等 5 分钟。
但把它和“设备需要重启、当轮矩阵全部作废、要重新插线重跑”相比，等待明显更便宜；
而且冷却和健康探测已经把“容易挂死”的场景提前挡掉了。

### 4.10 动作结束后的一次前台查询，让 8 秒窗口录成了 60 秒 / 4.7GB

修复 §4.9 后第一次跑矩阵，Take 1 的 hitches trace 是 **4.72GB**，整轮卡了
9 分钟。动作窗口本身是对的（`5965–13909ms`，5 次滑动全部 `executed`），
但录制并没有在动作结束时停下：

| 时刻 | 事件 |
| --- | --- |
| 20:43:25 | xctrace 启动，`--time-limit 60s` |
| 20:43:39 | 最后一个动作结束，窗口记为 8 秒 |
| 20:43:43 | 动作后的“App 是否还在前台”查询发出 |
| 20:44:25 | 60s 上限到，xctrace 自己停止录制 |
| 20:44:37 | 4.72GB 数据落盘，传输/收尾卡住 |
| 20:52:55 | 5 分钟宽限期到，录制层 SIGKILL |
| 20:53 | 分析失败（`Document Missing Template Error`），Take 记为 `failed` |

根因有三层，缺一层这个 Take 都不会变成 4.7GB：

1. **`apps foreground` 查询永远没有 settle。** mobilecli  runner 的超时确实
   在 60s 杀了子进程，但 Promise 等的是 `close` 事件；脚本/孙进程继承了
   stdout 管道时，子进程已经死了 `close` 也不会触发。于是 `during` 一直挂着，
   而 `session.stop()` 永远没被执行。
2. **`during` 没有上限。** 只要回调不返回，录制就只能等 `--time-limit`。
   8 秒的动作窗口因此变成 60 秒整段录制；这次内容视频多，约 79MB/s，
   正好 4.7GB。
3. **正常停止路径也没有上限。** `await session.exited` 只受 270s 硬超时和
   之后 5 分钟 SIGKILL 约束，所以一次卡住的收尾能拖到 9 分钟。

修复：

1. **命令 runner 以 `exit` 为准，不再等 `close`。** `mobilecli` 用独立进程组
   启动，超时杀整个进程组；超时直接 reject（带 `did not finish within`），
   并销毁管道读端。孙进程再也无法拖住宿主。
2. **前台查询加 5 秒上限。** `probeForeground()` 用 `Promise.race` 包住查询；
   动作后拿不到答案就**如实失败**：
   `could not verify that com.nndev.im stayed in the foreground … the recording
   was stopped early`，不再假装 Take 有效。`waitForForeground` 的轮询也用
   同一个上限，20 秒总超时因此是真的。
3. **`during` 加 30 秒上限（`duringTimeoutMs`）。** 超时由录制层 SIGINT
   收尾并抛 `aborted`（不可重试），hitches 的 `--time-limit` 同时从 60s
   降到 **40s**，作为第二道闸。健康路径约 14 秒，正常 trace 仍在
   400MB–1.4GB 量级（取决于内容），但一次卡住最多 30 秒。
4. **设备侧不健康信号命中即中止**（`instruments-wedged`、`Failed starting
   ktrace session`、malformed trace、`did not finish within`、
   `could not verify that` 等）。`Document Missing Template Error` /
   `Export failed` 是症状而不是归因：只有本次尝试期间新产生 `xctrace-*.ips`
   时（最多等 15 秒让它落盘）才认定为主机侧崩溃并重试该 Take（D7）；没有新
   崩溃报告时按设备侧失败立即中止，不盲目重试。

测试：`src/__tests__/device/mobilecli.test.ts`（孙进程占住管道仍能返回、
超时 reject）、`src/__tests__/recording/xctrace.test.ts`（`during` 卡住时
SIGINT 收尾）、`src/__tests__/runner/run.test.ts`（前台查询不返回 → Take
在第一个 pass 就失败）。

**关于体积：** 4.7GB 不是 8 秒动作的代价，是 **60 秒内容**的代价。同样
`--launch` 的冒烟 trace 是 17.8 秒 / 421MB（约 24MB/s），这次滚动到视频
内容后约 79MB/s。trace 体积与内容强相关，目前没有裁剪/降采样；M4 若要压缩
单次耗时，应先处理这块，而不是缩短动作窗口。

## 5. 仍未解决

- **`hitches` 对内容高度敏感。** 消息列表三次的中位数与极差见 §2.3；同一
  场景、同一设备，列表内容/加载时机不同就会差数倍。单次 `hitches` 只能
  做“本次是否异常”的参考，不能做回归判据。M4 的基线必须用多 Take 中位数
  与分布。
- **warmup 是固定等待，不是“等待页面就绪”。** 消息场景 warmup 点击后固定
  等 1.5s。网络慢时录制窗口可能覆盖列表仍在加载的阶段，这是 `hitches`
  波动的一个来源。项目可以在场景里加更长的 `waitAfterMs`，平台暂不提供
  “等元素出现再开始”的录制原语。
- **日志量低不等于流断了，但也不能证明订阅及时。** `message-list-scroll` T1
  报告记 202 行、产物文件 201 行（`lineCount` 比文件实际行数多 1，是本次 6 个
  run 的普遍现象），而 T2/T3 分别是 16 185 / 10 941 行。核查时间戳可以确认流在
  09:34:39–09:37:16 一直在推（Take 结束于 09:38:04，最后 48 秒确实无输出），
  201 行分布在 12 个不同的秒里，属于“App 本身安静”而不是提前退出。但现有
  门禁仍无法区分“设备日志本来就少”和“订阅生效晚”，完整性只能靠 `lineCount`
  人工判断。
- **pass 级记录没有落盘。** `attempts` 与每 pass 耗时只出现在 CLI/MCP 返回的
  `passes` / `timings` 里；`run.json` / `report.json` 只保存指标与证据路径
  （本次矩阵另存进 `docs/m3-takes.json`，产品侧没有持久化）。M4 若要做完整
  审计，应把 `passes` 持久化。
- **阈值仍是占位值。** `hitches` 的 fail 线（15）比真实值低一到两个数量级，
  `gate=fail` 是预期结果，不代表产品回归。
- **hitches pass 不再依赖 attach，但 `--launch` 有自己的失败模式。** `--launch`
  在 App 已经运行时可能停在 “Launching process” 之后不再进入 live。录制层会在
  30s live 超时后先 SIGINT、宽限期（5 分钟）后再 SIGKILL，并按既有策略重试；
  没有 trace 的 Take 会如实失败，不会记成成功。memory pass 的 pid 解析已改为
  按容器 UUID 选择（`0c6b77a`），但双构建并存场景尚未在真机复测。
- **动作时间窗与 trace 起点之间有一个保守的近似。** 窗口用 `during` 回调内的
  主机时间差计算，而 `during` 是会话进入 live 后立刻调用的，因此主机差被当作
  trace 相对时间使用。误差约 ±1s，方向是窗口可能**提前**开始（包含少量
  warmup 帧），而不是截断动作；`blockMs` 因此略偏高而非偏低。M4 若需要更紧的
  窗口，可用 `life-cycle-period` 或首帧时间做二次对齐。
- **hitches trace 的体积与保存时间由录制时长决定，而不是动作时长。** 一次约
  15s 的 Animation Hitches 录制约 350MB–1.4GB（取决于滚动到的内容，视频
  场景可达约 79MB/s），xctrace 保存要花 1–2 分钟，占整个 Take 墙钟时间的
  大头；动作结束后的 SIGINT 只是停止录制，保存仍要继续。这不影响结果有效性，
  但 M4 若要把单次耗时压到更低，应先解决 trace 体积（裁剪 trace、降低采样
  或换更轻的导出），而不是缩短动作。§4.10 的 30s `during` 上限保证一次卡住
  不会超过这个量级。
- **手机重启会让 `mobilecli` 守护进程握着的隧道失效。** 表现是
  `apps foreground` 报 `timed out waiting for WebDriverAgent to be ready`
  且 Runner 在第一步就失败，而 `apps launch` 单独执行却成功。执行
  `mobilecli daemon stop` 后，下一条命令会用新隧道重启守护进程，随即恢复。
  Runner 目前不会自动做这一步。
- **别的 App 的系统弹窗需要人工清理。** 本次矩阵一度 18/18 次尝试失败，报
  `com.nndev.im did not reach the foreground within 20000ms`，实际是
  “Video Saver” 的无线数据授权弹窗盖在最上层（`apps foreground` 返回
  `com.apple.springboard (_SBAlertController)`）。错误信息会带上
  `foreground was …`，直接指出阻塞者，但平台目前无法代劳点掉弹窗（见 §4.6）。
- **手势正确性依赖设备上报的屏幕尺寸。** 滑动现在要求
  `mobilecli device info` 给出 `screenSize`；拿不到就失败，不再从 UI 树推断。
  安全带固定为 20%–80%，因此单次可滑动的最大距离约为屏幕的 60%
  （402×874 上约 524pt）；需要更长位移时应拆成多个动作。动作后的前台校验
  能发现“App 被切到后台”，但无法证明没有被**被测 App 自己持有**的浮层
  （例如 App 内弹出的系统权限框）遮挡——那类浮层仍会把 App 报成前台。
- **设备侧 Instruments 服务一旦卡死，仍只有重启能恢复。** 新的健康探测、冷却、
  非重试熔断和 5 分钟宽限把“把它搞卡死”的概率降下来了（§4.9），但一旦设备已经
  报 `Failed starting ktrace session`，平台**没有**自动恢复手段，只能提示重启
  手机。M4 若要真正做到“无人值守”，需要在录制前加入设备健康检查
  （例如一次极短的探测录制）并在失败时阻止整轮矩阵。
- **主机侧 `xctrace` 会在保存 trace 时崩溃（本次新发现）。** 2026-11-16 冒烟的
  第 1 次尝试里，`xctrace` 27.2（64578.328）在保存阶段 SIGSEGV：崩溃线程队列是
  `com.apple.dt.frame.activity`，栈顶为
  `XRCallstackFixupOracle fixupCoreProfileCallstack` →
  `CSSymbolicatorFixupFrames` → `TMMapSymbolOwnerData::symbol_for_address`。
  `vmRegionInfo` 显示故障地址落在某线程栈区域末尾之后 17 字节（该区域标注为
  thread 21，不是 faulting thread 8），因此“符号化调用栈时栈溢出”只是**推断**：
  ips 能证明主机侧 `xctrace` 在处理 Time Profiler 调用栈时崩溃，不能证明具体
  的溢出机制。
  保存中断后 `.trace` 只剩 `Trace1.run/Attachments/trace-data.atrc`（5.2 GB
  原始数据）与 `RunIssues.storedata`，缺 `form.template` / `corespace/` /
  `instrument_data/`，因此 `xctrace export` 报 `Document Missing Template Error`。
  设备侧是健康的：崩溃后没有残留录制进程，同一构建紧接着重跑就产出了正常的
  463 MB trace。这是主机工具链的偶发崩溃，不是设备不健康；矩阵驱动已把这类
  信号从“立即中止整轮”拆成“确认有本次尝试新产生的 `xctrace-*.ips` 才重试该
  Take”（`run-final.sh` 的 `HOST_TRACE_CRASH_PATTERN`；同一报错但无新崩溃
  报告时仍按设备侧失败中止）。平台侧**没有**在录制层校验 trace 是否带
  `form.template`，这类残包要等到解析阶段才暴露；虽然最终仍如实判 `failed`，
  但应并入 M4 的 `harden-diagnostics`，在返回 trace 前先做结构校验。证据：
  `runs/2026-11-16T01-03-39.535Z-inOKZTpQ/xctrace-crash.ips`。
- **Crash 差集是全设备的，不区分进程。** `crashIds` 取的是设备的完整报告
  列表，因此别的进程留下的 `JetsamEvent-*` 只要恰好出现在 Take 的时间窗内，
  就会被算成“新增 Crash”并把 Take 降级为 `failed`。本次矩阵就撞到一次：
  `community-home-scroll` T1 第 1 次尝试（run `2026-11-16T01-15-11.686Z-wzOCgRbr`）
  指标其实齐全（`hitches` 451 / `blockMs` 79.2 / `launchMs` 377.69 /
  `memoryMB` 111.67），却因为新增 `JetsamEvent-2026-11-16-091522.ips` 被判
  `failed`。查报告内容：`largestProcess` 是 `News`（30 387 页），**没有任何进程
  处于 `killed` 状态**，NNIM 是 `frontmost` 且只占 13 页——这是一次系统级内存
  压力快照，不是 App 崩溃。原始报告已从设备取回，保存在
  `runs/2026-11-16T01-15-11.686Z-wzOCgRbr/jetsam-2026-11-16-091522.json`
  （`device crashes get` 的返回，`data.content` 为报告正文）。按规则该尝试
  不计入矩阵，第 2 次尝试 `completed` 后才计入。方向是**偏严**（不会漏报），
  但 M4 应按报告里实际被终止的进程过滤，而不是按报告类型过滤。

## 6. 复现

```bash
cd performance-test-mcp
npm ci
npm run build

cd /Users/leigod/雷神/性能分析/perfstage-m3-workspace
node /Users/leigod/雷神/性能分析/performance-test-mcp/dist/cli/bin.js \
  run community-home-scroll \
  --device 00008150-001E49E40128C01C \
  --dir "$PWD" --json
```

每个 Take 的产物在 `.performance-test/runs/<runId>/`：
`run.json`、`plan.json`、`report.json`、`report.md`、`device.log`、
`traces/{hitches,launch,memory}.trace`；Crash 报告 id 仅在
`report.json` 的 `diagnostics.crashes` 中。
