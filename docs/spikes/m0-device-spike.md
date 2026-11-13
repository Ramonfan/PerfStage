# M0 真机技术验证报告

| 项 | 内容 |
| --- | --- |
| 日期 | 2026-11-13 |
| 设备 | Ra 的 iPhone（iPhone18,3，iOS 27.0.1） |
| UDID | `00008150-001E49E40128C01C` |
| 工具链 | Xcode 27.2（27B52）、xctrace 27.2、macOS 26.7.1 |
| 被测 App | NN（`com.nndev.im`） |
| 工程 | `/Users/leigod/雷神/App改造/nnios`（NNIM.xcworkspace） |
| 工作区 | `/Users/leigod/雷神/App改造/.performance-test`（5 个场景） |
| 结论 | **执行链路与 4 个指标均可行；3 个代码缺口已修复** |

## 1. 结论摘要

| 能力 | 结论 |
| --- | --- |
| 真机 xctrace 录制 | 可用 |
| `start_profiling` / `stop_profiling` | 可用，但 stop 必须放宽客户端超时 |
| Time Profiler（CPU） | 可用；`launch_path` 方式有符号，`attach` 方式在 release 包上常无符号 |
| Animation Hitches | 可用；真实滑动下采到 903 个 hang |
| App Launch | 可用；PerfStage 解析冷启动 **274.3ms** |
| Allocations（内存） | **不可用**：TOC 里没有任何 allocation 表 |
| Activity Monitor（内存） | **可用**：`--all-processes` + `phys_footprint`，PerfStage 解析 NNIM 113.5 MiB |
| 指标解析归属 | **PerfStage 自解析 4 个指标**；instruments-mcp 只负责录制 |
| attach 稳定性 | 有竞态；推荐 `launch_path` 冷启动录制 |
| 失败时的 MCP server | 原实现会直接崩溃，**已修复** |

## 2. 验证结果明细

### 2.1 进程与 attach

| 尝试 | 结果 |
| --- | --- |
| `--attach NNIM` | `Cannot find process matching name: NNIM` |
| `--attach NN` | 两个安装实例并存时：`Provided process 'NN' is ambiguous` |
| `--attach <pid>` | 新启动后可 attach；旧进程/挂起进程会 `Cannot find process for provided pid` |
| `--launch -- com.nndev.im` | **稳定可用**，且符号解析正常 |
| `--all-processes` | 可用，但无法按进程过滤，不适合作为 Runner 默认路径 |

关键事实：

- 真机上的进程显示名是 **`NN`**，不是 `NNIM`。用 `mobile_list_apps` 拿到的 `appName` 才是同名来源。
- 设备上存在两个同 bundleId 的安装容器（`5338…` 与 `B224…`）。`--terminate-existing` 只清掉其中一个，导致按名字 attach 时出现歧义。
- 结论：**Runner 不要依赖进程名 attach**。默认用 `launch_path = bundleId` 让 xctrace 自己拉起 App。

### 2.2 指标可用性

| 指标 | 模板 | 实测 | 可用性 |
| --- | --- | --- | --- |
| `hitches` | Animation Hitches | 空闲 0；滑动后 903 hangs（1 minor 100ms + 902 micro） | ✅ |
| `blockMs`（原方案） | Time Profiler | `mainThreadBlockers` 为空；release 包 attach 时 `needsSymbolication=true`，hotspots 为 0 | ⚠️ 需改方案 |
| `launchMs` | App Launch | trace 有 `life-cycle-period` / `dyld-activity-interval`；PerfStage 解析 **274.3ms（cold）** | ✅ |
| `memoryMB`（原方案） | Allocations | 直接 attach、挂起后 attach、`--launch` 三种方式都没有 allocation 表；伴随 `dylibs overlap` 告警 | ❌ 工具链问题 |
| `memoryMB`（新方案） | Activity Monitor | `--all-processes` 产出 `activity-monitor-process-live` 表；`analyze_memory.py` 读到 NNIM 113.35 MiB | ✅ |

Allocations 失败的伴生信息：

```text
Timeline modification failed -- dylibs overlap by 0x164000:
    0x104c90000-0x104df4000 [0x164000] ... /usr/lib/dyld
```

**最初怀疑是 Pushy 热更新导致，但用非热更新的 `MiniAINotes` 复测后出现完全相同的 `dylibs overlap`。** 结论：这是 Xcode 27.2 + iOS 27.0.1 上 Allocations 模板的共性问题，与 NN 的构建形态无关。重装非热更新包不能解决。

### 2.4 内存的正确口径：Activity Monitor

你之前的 `.performance-test/tools/analyze_memory.py` 已经给出了可用方案：

```bash
xcrun xctrace record --template 'Activity Monitor' \
  --all-processes --time-limit 8s \
  --output /tmp/actmon.trace --no-prompt \
  --device 00008150-001E49E40128C01C

python3 -I analyze_memory.py /tmp/actmon.trace --pid <pid> --json out.json
```

实测：

| 项 | 值 |
| --- | --- |
| TOC schema | `activity-monitor-process-live` |
| trace 体积 | 1.7 MB（8s，全进程） |
| NNIM footprint | 首次 113.35 / 末次 113.35 / 中位 113.35 MiB |
| 系统总进程数 | 数十个，报告只应输出目标进程 |

口径：`phys_footprint` 是 Instruments 的 Memory 列，比 Allocations 的 `totalMB` 更接近用户感知的内存占用。

约束：

- Activity Monitor 不支持 `--launch -- bundleId`，只能 `--all-processes` 或 `--attach`。
- 当前设备上 `--attach <pid>` 很不稳定，**统一用 `--all-processes`**。
- 解析时按进程名 `NNIM` 或 PID 选取目标，忽略其它进程。

### 2.3 耗时与体积

| 场景 | 录制时长 | 端到端耗时 | trace 体积 |
| --- | --- | --- | --- |
| Time Profiler（`launch_path`） | 6s | ~20s | 15 MB |
| Animation Hitches（空闲） | 8s | 35.6s | 115 MB |
| Animation Hitches（12 次滑动） | ~12s | stop 超过 60s 客户端超时 | 316 MB |

结论：

- 默认 60s 的 MCP 客户端超时不够，`stop_profiling` 至少给 **300s**。
- 单次 pass 的实际耗时主要在 trace 落盘与解析，不在动作本身。
- 2 个 pass（hitches + launch）预计 60–120s，仍远低于 A8 的 8 分钟预算。

## 3. 发现的问题

### P0-1：attach 失败会导致 instruments-mcp 崩溃（已修复）

`src/tools/simulator.ts` 的自动清理逻辑：

```ts
recording.completion.finally(() => { ... });
```

`xctrace` 失败时 `completion` reject，`.finally()` 返回的 Promise 无人处理，Node 触发 unhandled rejection 直接退出。复现：

```text
Error: xctrace recording failed (exit 19): Cannot find process matching name: NOPE
Node.js v22.16.0
[transport closed]
```

已改为 `.finally(...).catch(() => {})`，并重新构建 `dist/`。修复后同样场景返回结构化错误 `No active recording`，server 不再退出。

### P0-2：`start_profiling` 失败即报错（已修复）

原实现即使 `xctrace` 已经报错退出，工具仍返回：

```json
{ "status": "recording", "tracePath": "…" }
```

Runner 无法从返回值判断 attach 是否真的成功。现已在 `instruments-mcp-server/src/tools/simulator.ts` 增加 **2.5s fail-fast 窗口**：启动后若 xctrace 已非零退出，直接返回结构化 `isError`，不再写入 `activeRecording`。

验证：

```text
# 负向：进程不存在
start => { "error": "xctrace exited before the recording started",
           "detail": "xctrace recording failed (exit 19): Cannot find process matching name: NOPE" }
stop  => No active recording（server 存活）

# 正向：bundleId 冷启动
start => { "status": "recording", "template": "Time Profiler", ... }
stop  => 1864 samples
```

该修改位于 sibling 仓库 `instruments-mcp-server`，目前**未提交**（该仓库存在用户未提交的 WIP 改动，仅修改了 `src/tools/simulator.ts` 并重建 `dist/`）。补丁已归档到 [`docs/patches/instruments-mcp-start-fail-fast.patch`](../patches/instruments-mcp-start-fail-fast.patch)，可在该仓库用 `git apply` 应用。

### P0-3：App Launch 解析器已适配 `life-cycle-period`（已修复）

原解析器查找 `app-launch` / `lifecycle` / `os-signpost`，但 TOC 实际表名是 `life-cycle-period`，因此返回：

```text
=== App Launch === severity: [OK] total: 0ms type: unknown
```

PerfStage 新增 `src/analysis/parsers/app-launch.ts`，按 `life-cycle-period` 的 `start` / `duration` / `period` / `process` 列计算：

- `launchMs` = 首个 launch 周期开始 → 最后一个 launch 周期结束（排除 Foreground / Background）；
- `launchType` = 出现 `Initializing` 判为 cold；
- `phases` 保留每一条生命周期记录；
- 附带 `dyld-activity-interval` 的 pre-main 摘要。

用 `/tmp/launch2.trace` 实测：**274.3ms / cold / 11 个 launch 阶段**。

### P0-4：Allocations 不可用，改用 Activity Monitor（已解决）

Allocations 在当前 Xcode / iOS 组合上系统性地产不出 allocation 表，非热更新 App 同样失败。**不再尝试修 Allocations**，内存指标改用 Activity Monitor + `phys_footprint`，复用 `analyze_memory.py` 的解析口径。

Python 口径已移植到 TypeScript（`src/analysis/parsers/activity-monitor.ts`）：按 pid / 进程名选择目标，输出 `memoryMB`（median footprint）、`netGrowth`、`slope` 与逐样本序列。

## 4. 对 Runner 的直接影响

推荐的单 pass 采集流程：

```text
1. start_profiling({ device, launch_path: bundleId, template, max_duration: "1m" })
2. 等待 settleMs（建议 2000ms）让录制真正开始
3. 执行 warmup / actions
4. stop_profiling，客户端超时 ≥ 300s
5. 记录 trace 路径、体积、耗时
```

设计约束：

- **每次 pass 冷启动 App**：`launch_path` 方式最稳定，也避免进程名歧义。
- **不要用进程名 attach**：同 bundleId 多容器时会歧义，旧进程会找不到。
- **动作前留 settle 窗口**：`start_profiling` 立即返回，但录制握手有延迟。
- **stop 必须长超时**：大 trace 落盘可能超过 60s。
- **冷启动噪声**：hitches pass 会包含启动阶段的 hang（本次 1.1–1.6s 的 micro hang）。报告需标注“含启动窗口”，或后续支持丢弃前 N 秒。
- **并发日志**：本次未验证；`mobile_get_device_logs` 仍需独立 client，列入 M0 剩余项。

## 5. 指标方案修订建议

| 指标 | 新方案 | 理由 |
| --- | --- | --- |
| `hitches` | Animation Hitches → `totalHangs` | 已验证 |
| `blockMs` | Animation Hitches → `max(hangs[].durationMs)` | 与 hitches 同一 pass，避免 Time Profiler 符号化与额外一轮回放 |
| `launchMs` | App Launch → 修解析器后取 `life-cycle-period` | 模板可录，解析待修 |
| `memoryMB` | Activity Monitor → 目标进程 `phys_footprint` 中位数 | 已验证；`--all-processes` 稳定，避免 attach |

修订后一次 Take 为 **3 个 pass**（hitches + launch + activity monitor），与最初计划持平，但每轮都不再依赖不稳定的 per-process attach。

## 6. 复现命令

```bash
# 设备与工程
xcrun xctrace list devices
xcrun devicectl device info processes --device 00008150-001E49E40128C01C

# 单模板录制（推荐：bundleId 冷启动）
node scripts/spike-attach.mjs \
  --launch-path com.nndev.im \
  --template "Animation Hitches" \
  --duration-ms 8000 \
  --out docs/spikes/spike-hitches-launchpath.json

# 内存：Activity Monitor 全进程录制
node scripts/spike-attach.mjs \
  --all-processes \
  --template "Activity Monitor" \
  --duration-ms 8000 \
  --out docs/spikes/activity-monitor-memory.json

# 录制期间驱动 UI（两个 MCP 并行）
node scripts/spike-run.mjs

# 解析已有 trace（PerfStage 自解析）
node scripts/analyze-trace.mjs --template launch --trace /tmp/launch2.trace --process NN
node scripts/analyze-trace.mjs --template memory --trace /tmp/actmon4.trace --pid 6764
```

## 7. 证据文件

| 文件 | 内容 |
| --- | --- |
| `attach-spike-time-profiler.json` | 按进程名 attach，无符号，hotspots 为空 |
| `attach-spike-launchpath.json` | `launch_path` 冷启动，1654 samples，有符号 |
| `attach-spike-hitches.json` | 空闲状态，0 hangs |
| `attach-spike-allocations.json` | Allocations 无数据 |
| `spike-hitches-launchpath.json` | 空闲 8s，端到端 35.6s，115MB |
| `spike-run-hitches.json` | 12 次滑动期间录制；stop 超时，trace 后续单独解析 |
| `hitches-with-swipes.txt` | 316MB trace 的解析结果：903 hangs |
| `activity-monitor-memory.json` | Activity Monitor 全进程内存序列，NNIM 113.35 MiB |
| `perfstage-parse-launch.json` | PerfStage 自解析结果：274.3ms / cold |
| `perfstage-parse-memory.json` | PerfStage 自解析结果：NNIM 113.5 MiB / 9 samples |
| `perfstage-parse-hitches.json` | PerfStage 自解析结果：1175 帧 / 764 hitches / blockMs 91.7 |

## 8. M0 修正落地（2026-11-13）

按「**PerfStage 自解析全部 trace 指标，instruments-mcp 只负责录制**」的决策，M0 的三个代码缺口已落地：

| 任务 | 实现 | 验证 |
| --- | --- | --- |
| E0-6 | `instruments-mcp-server` 的 `start_profiling` 增加 2.5s fail-fast 窗口 | 负向 attach 返回 `isError`；server 存活；正向冷启动 1864 samples |
| E0-7 | `src/analysis/parsers/app-launch.ts` 解析 `life-cycle-period` + `dyld-activity-interval` | 真实 trace：`launchMs=274.3`、`launchType=cold`、11 个阶段 |
| E0-8 | `src/analysis/parsers/activity-monitor.ts` 移植 Python 口径 | 真实 trace：NNIM `median=113.5 MiB`、`slope=-8.628 MiB/min`、9 samples |
| E0-9 | `src/analysis/parsers/animation-hitches.ts` 解析帧生命周期 | 真实 trace：1175 帧、764 hitches、`blockMs=91.7` |

配套模块：

| 模块 | 职责 |
| --- | --- |
| `src/analysis/trace/xml.ts` | 解析 xctrace XML，处理 `<schema>` 列顺序、`id`/`ref` 去重、`<sentinel/>` |
| `src/analysis/trace/export.ts` | `xcrun xctrace export --xpath` / `--toc` 封装 |
| `scripts/analyze-trace.mjs` | 对已有 trace 复跑两个解析器，产出 JSON |

复跑命令：

```bash
# App Launch
node scripts/analyze-trace.mjs --template launch \
  --trace /tmp/launch2.trace --process NN \
  --out docs/spikes/perfstage-parse-launch.json

# Activity Monitor
node scripts/analyze-trace.mjs --template memory \
  --trace /tmp/actmon4.trace --pid 6764 \
  --out docs/spikes/perfstage-parse-memory.json

# Animation Hitches
node scripts/analyze-trace.mjs --template hitches \
  --trace "/Users/leigod/雷神/性能分析/explore-traces/nn-community-hitches.trace" \
  --out docs/spikes/perfstage-parse-hitches.json
```

`launchMs` 的口径说明：life-cycle 表是层级结构，同一周期标签会出现在多条子记录中，因此解析器**不做按标签合并**，而是保留每条生命周期记录，并用「首个 launch 周期开始 → 最后一个 launch 周期结束」计算总时长。`Foreground - Active` 等前台周期被排除，避免把整段录制算成启动时间。

`memoryMB` 的口径：取目标进程 `phys_footprint` 的**中位数**；`slope` 用真实采样时间戳做最小二乘，而不是假设固定 1s 间隔。
