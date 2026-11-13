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
| 结论 | **执行链路可行；指标层有 2 个必须修的缺口** |

## 1. 结论摘要

| 能力 | 结论 |
| --- | --- |
| 真机 xctrace 录制 | 可用 |
| `start_profiling` / `stop_profiling` | 可用，但 stop 必须放宽客户端超时 |
| Time Profiler（CPU） | 可用；`launch_path` 方式有符号，`attach` 方式在 release 包上常无符号 |
| Animation Hitches | 可用；真实滑动下采到 903 个 hang |
| App Launch | 能录到 trace，但解析器返回 `0ms / unknown`，**必须修** |
| Allocations（内存） | **不可用**：TOC 里没有任何 allocation 表 |
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
| `launchMs` | App Launch | trace 有 `life-cycle-period` / `dyld-activity-interval` / `time-profile`，解析器却返回 `0ms / unknown` | ❌ 需修解析器 |
| `memoryMB` | Allocations | 直接 attach、挂起后 attach、`--launch` 三种方式都没有 allocation 表；伴随 `dylibs overlap` 告警 | ❌ 当前不可用 |

Allocations 失败的伴生信息：

```text
Timeline modification failed -- dylibs overlap by 0x164000:
    0x104c90000-0x104df4000 [0x164000] ... /usr/lib/dyld
```

App 集成了 Pushy 热更新（`Pushy_iOS热更新操作流程.md`），注入的 dylib 与 `/usr/lib/dyld` 地址重叠，导致 Instruments 的内存时间线构建失败。这更像**该构建形态的限制**，不是 Allocations 模板本身不可用。

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

### P0-2：`start_profiling` 对“立即失败”仍返回 `recording`

即使 `xctrace` 已经报错退出，工具仍返回：

```json
{ "status": "recording", "tracePath": "…" }
```

Runner 无法从返回值判断 attach 是否真的成功。建议 M0 补一个 fail-fast 窗口（启动后 1–2s 内检查子进程是否已非零退出），否则 Runner 只能靠“stop 时报 No active recording”兜底。

### P0-3：App Launch 解析器与 TOC 表名不匹配

TOC 实际表名是 `life-cycle-period`，解析器查找的是 `app-launch` / `lifecycle` / `os-signpost`，因此返回：

```text
=== App Launch === severity: [OK] total: 0ms type: unknown
```

需要按 `life-cycle-period` + `dyld-activity-interval` 重写取值逻辑，并用这份 trace 做 fixture。

### P0-4：Allocations 在当前构建上不可用

三种采集方式均无可解析数据。MVP 必须先决定：

1. 用**非热更新构建**验证 Allocations 是否能恢复；
2. 或改用其他内存来源（VM Tracker / 设备日志 / 应用内埋点）；
3. 或把 `memoryMB` 移出 MVP 必选指标，标为 best-effort。

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
| `memoryMB` | 暂移出 MVP 必选；先验证非热更新构建 | 当前构建无 allocation 表 |

修订后一次 Take 只需 **2 个 pass**（hitches + launch），比原计划少一轮动作回放。

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

# 录制期间驱动 UI（两个 MCP 并行）
node scripts/spike-run.mjs

# 解析已有 trace
# profile_hitches({ trace_path: "<path>" })
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
