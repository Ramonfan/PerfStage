# Trace 体积与保存耗时基线（reduce-trace-footprint）

本文件固定 `reduce-trace-footprint` 的测量口径、改动前基线和复算方法。它只回答
「一次 Take 的 trace 有多大、保存花了多久、这些数字怎么复算」，不定义指标阈值或
`gate` 语义。指标口径与阈值仍以 `docs/threshold-calibration.md` 和长期主规格为准。

## 1. 环境与被测对象

| 项 | 值 |
| --- | --- |
| 设备 | `Ra的iPhone`，iPhone18,3，iOS 27.0.1，UDID `00008150-001E49E40128C01C` |
| 被测应用（M3 六次） | `com.nndev.im` 6.7.1，构建号未记录；可执行名 `NNIM` |
| 被测应用（`cM66VIEv`） | `com.nndev.im` 6.8.0（该 Take 的 `device.log` 可证）；构建号未在该 Take 核验。`docs/threshold-calibration.md` 的 `600800` 属于其自身采集窗口，不能直接套到本 Take |
| PerfStage 构建（M3 六次） | 矩阵脚本调用当次 `npm run build` 的 `dist/cli/bin.js`；提交哈希未记录 |
| PerfStage 构建（`cM66VIEv`） | 提交哈希未记录；该 Take 生成于当前 HEAD `26ae310`（2026-11-17 13:10）之前 |
| 工具链 | macOS 26.7.1、Xcode 27.2、`xctrace` 27.2、Node 20+ |
| 样本口径 | M3 `n=6`（2 场景 × 3，仅矩阵最终 accepted/completed Take，排除 pilot 与失败 attempt）；`cM66VIEv` `n=1`，只作格式/体积抽查，不并入 p50 |
| 基线来源 | `perfstage-m3-workspace/.performance-test/runs/` 六次 M3 Take；`perfstage-c4-workspace/.performance-test/runs/2026-11-17T04-13-24.250Z-cM66VIEv` 一次 C4 Take |
| M3 索引 | `docs/m3-takes.json`（六次 Take 的 `runId`、`runDirectory`、`timings` 与 notes） |

**`cM66VIEv` 与 M3 六次 Take 不是同一个 App 构建**：前者为 6.8.0（构建号未核验），
后者为 6.7.1。它只用于抽查最新 `run.json` 格式与 trace 体积，不并入 M3 的 p50 或
A/B 基线；跨构建的体积/时长差异不得解释为候选收益。

## 2. 字段口径

新增字段出现在 `run.json` 的 `passes[]`、Take summary 的 `passes[]`，以及
`report.json.run.passes[]`（报告直接展开同一个 `TestRun`）：

| 字段 | 单位 | 含义 | 缺失语义 |
| --- | --- | --- | --- |
| `traceBytes` | byte | `.trace` bundle 内**常规文件**的字节和 | 未测量；旧 run 或读取失败 |
| `saveMs` | ms | 从 xctrace 输出 `Saving output file` 到进程退出的时间 | 未观察到保存阶段；旧 run 或被中断的会话 |

约束：

- `traceBytes` 递归统计普通文件，跳过符号链接。不能使用 `stat(path).size`
  （`.trace` 是目录），也不使用 `du`：`du` 按分配块统计，在 APFS 上会偏小，
  且不同卷不可直接比较。
- 读取 bundle 失败或常规文件总字节为 0 时**省略** `traceBytes`，同时向该
  pass 的 `issues` 追加一条 `level: "warning"` 的
  `could not measure trace size: ...`。不得写 `0`，否则空 trace 和未测量无法区分。
  注意：`run.json` 的 pass 记录只保留 `warningCount`，该 warning 的完整文本只在
  本次录制的进程内 `issues` 中存在，当前不会写入 `run.json`、`notes` 或单独日志。
  因此 `warningCount: 1` 只能证明「发生了 1 条录制 warning」，不能单独证明它就是
  体积测量失败；这是当前证据链的已知缺口。
- `saveMs` 只覆盖保存/回传阶段，不包含启动、动作与暂停，也**不**由 pass 墙钟倒推。
  旧 `xctrace`、未出现该行或进程被信号终止时省略。当前实现的判据是
  `exited.signal !== null`。2026-11-17 真机已确认：3 次紧凑录制与 1 次完整 Take
  的正常停止均为 `code 0 / signal null`，`saveMs` 分别落盘（紧凑 577–1516ms；
  完整 Take 的 hitches/launch/memory 为 24,165 / 3,251 / 361ms）。若后续 xctrace
  版本改为以信号退出，则该字段会整体缺失，需按退出语义重新确认，不能用墙钟补造。
- 缺失一律表示「未测量」，与 `0` 不同。旧 run 的 `passes[]` 可以没有这两个字段。
  `traceBytes` 只接受正整数：写入端对 0 按测量失败处理，`passRecordSchema` 也会
  拒绝 0，因此 `0` 既不会出现在新 run 中，也不是可解析的旧值。
- `plan.repetitions > 1` 时，每轮 trace 放在 `traces/rep-<n>/`，pass 记录的
  `tracePath` 指向各自文件；不得让多轮共用同一个 trace 路径，否则早期 pass 的字节
  无法再从磁盘复算。代价是同一 Take 会保留约 `n` 倍 trace（M3 量级下 3 轮可达数
  GB）；清理或归档不得删除仍被 pass 记录引用的失败证据。

## 3. 基线：每 pass 墙钟与 Take 合计

单位为秒。M3 六次 Take 的 `run.json` 没有 `passes[]`，墙钟取自
`docs/m3-takes.json` 的 `timings`；`cM66VIEv` 的 pass 墙钟取自其
`run.json.passes[].durationMs`，Take 合计取自该 Take 的起止时间。合计列对 M3
等于 `timings.totalMs`，对 `cM66VIEv` 为 `04:13:24.253Z` → `04:17:33.897Z`。

`durationMs` 的边界：从 `xctrace` 进程启动到进程退出，**包含**保存/回传阶段
（即 `saveMs` 在它的内部），但**不包含**落盘之后的 trace 体积统计。体积统计在
快照 `durationMs` 之后执行，因此 GB 级 bundle 的统计耗时会增加 Take 墙钟，却不会
计入该 pass 的 `durationMs`。跨版本比较 pass 墙钟时需要知道这一边界。

| Take | 场景 | hitches | launch | memory | 合计 |
| --- | --- | ---: | ---: | ---: | ---: |
| `cM66VIEv` | message（C4） | 133.931 | 32.029 | 16.014 | 249.644 |
| `WOdH-nXM` | community T1 | 137.013 | 37.067 | 16.190 | 259.572 |
| `qQ-IeKqF` | community T2 | 127.903 | 35.190 | 16.216 | 249.217 |
| `ORhQklNf` | community T3 | 132.051 | 34.431 | 16.531 | 256.913 |
| `ZLvN9dZ2` | message T1 | 83.326 | 36.648 | 17.000 | 206.129 |
| `dI5uSEcg` | message T2 | 109.038 | 33.681 | 16.740 | 230.536 |
| `gZB8WRmv` | message T3 | 131.003 | 34.395 | 16.825 | 251.919 |

`cM66VIEv` 的 `run.json` 是该 change 之前的格式，`passes[]` 没有
`traceBytes` / `saveMs`；上表的 pass 墙钟直接取自其 `passes[].durationMs`，
Take 合计为 `04:13:24.253Z` → `04:17:33.897Z`。

## 4. 基线：trace 字节数

字节为 bundle 内常规文件字节和，与 `traceBytes` 同口径；MB 按 `10^6` 字节换算。
基线 run 均早于该字段，故整数由文件重新统计得到。

| Take | hitches | launch | memory | 合计（byte） | 合计（MB） |
| --- | ---: | ---: | ---: | ---: | ---: |
| `cM66VIEv` | 441,327,926 | 125,888,560 | 1,623,219 | 568,839,705 | 568.8 |
| `WOdH-nXM` | 510,507,213 | 179,041,712 | 1,691,681 | 691,240,606 | 691.2 |
| `qQ-IeKqF` | 496,275,508 | 156,475,225 | 1,717,944 | 654,468,677 | 654.5 |
| `ORhQklNf` | 495,669,186 | 126,596,198 | 1,693,172 | 623,958,556 | 624.0 |
| `ZLvN9dZ2` | 246,167,343 | 126,789,437 | 1,706,124 | 374,662,904 | 374.7 |
| `dI5uSEcg` | 367,054,654 | 124,530,260 | 1,703,714 | 493,288,628 | 493.3 |
| `gZB8WRmv` | 418,970,350 | 137,092,609 | 1,708,436 | 557,771,395 | 557.8 |

- 六次 M3 Take 的合计为 374.7–691.2MB，hitches 占 65.7–79.4%。
- 六次 M3 Take 的合计 p50 = (557,771,395 + 623,958,556) / 2 =
  **590,864,975.5 byte ≈ 590.9MB**。
- 墙钟 p50 = (249.217 + 251.919) / 2 = **250.568s ≈ 250.6s**。
- memory trace 约 1.6–1.7MB，不是优化对象。

## 5. 基线：trace 时长与实际测量窗口

trace 时长取自 `xcrun xctrace export --toc` 的 `<duration>`；hitches 窗口取自各 run
`notes` 中的 `hitches window <start>–<end>ms of the trace`。launch 与 memory 没有
额外的动作窗口：launch 指标来自 App Launch 表，memory 指标来自 Activity Monitor
采样区间，因此下表的「窗口」列只针对 hitches。

| Take | hitches TOC | launch TOC | memory TOC | hitches 窗口 | 窗口 / TOC |
| --- | ---: | ---: | ---: | --- | ---: |
| `cM66VIEv` | 17.711829s | 12.383177s | 12.721402s | 9869–14939ms（5.070s） | 28.6% |
| `WOdH-nXM` | 17.393347s | 12.375125s | 12.741474s | 6174–14191ms（8.017s） | 46.1% |
| `qQ-IeKqF` | 17.420380s | 12.382121s | 12.753547s | 6088–14112ms（8.024s） | 46.1% |
| `ORhQklNf` | 17.451503s | 12.351076s | 12.746873s | 6132–14183ms（8.051s） | 46.1% |
| `ZLvN9dZ2` | 17.745639s | 12.388681s | 12.755114s | 9584–14739ms（5.155s） | 29.0% |
| `dI5uSEcg` | 17.247584s | 12.361711s | 12.748043s | 9096–14245ms（5.149s） | 29.9% |
| `gZB8WRmv` | 17.262085s | 12.361389s | 12.750270s | 9176–14289ms（5.113s） | 29.6% |

七次 Take 的 hitches trace 中只有约 29–46% 落在实际测量窗口内。窗口外数据占
trace 时长的 54–71%，但**时长占比不等于字节归因**：目前没有按表或按文件拆分
字节，不能据此断定窗口外数据就是体积的主要来源。候选是否真正减少字节，必须在
2.x 中用同设备、同构建的 `traceBytes` 实测判定。

## 6. 复算命令

以下命令在工作区根 `/Users/leigod/雷神/性能分析` 执行。`<runDir>` 是某个
`.performance-test/runs/<runId>` 目录。

### 6.1 统计一个 pass 的字节数

```bash
find "<runDir>/traces/hitches.trace" -type f -exec stat -f%z {} + \
  | awk '{s+=$1} END {print s+0}'
```

对 `launch.trace`、`memory.trace` 重复即可得到表格中的整数。`repetitions > 1`
时把路径换成 `<runDir>/traces/rep-<n>/hitches.trace`。不要用 `du -sm` 替代。

### 6.2 读取 trace 时长

```bash
xcrun xctrace export --toc --input "<runDir>/traces/hitches.trace" \
  | grep -m1 '<duration>'
```

### 6.3 读取 hitches 测量窗口

```bash
python3 - "<runDir>/run.json" <<'PY'
import json, re, sys
notes = json.load(open(sys.argv[1])).get("notes") or ""
print(re.findall(r"hitches window \d+[–-]\d+ms of the trace", notes))
PY
```

对 `cM66VIEv` 应输出
`['hitches window 9869–14939ms of the trace']`；`notes` 是单个字符串，不是数组。

### 6.4 从 M3 索引生成墙钟与合计

```bash
python3 - <<'PY'
import json
data = json.load(open("performance-test-mcp/docs/m3-takes.json"))
for t in data["takes"]:
    ms = t["timings"]
    print(
        t["runId"],
        t["scenarioId"],
        t["runNumber"],
        ms["hitchesMs"] / 1000,
        ms["launchMs"] / 1000,
        ms["memoryMs"] / 1000,
        ms["totalMs"] / 1000,
    )
PY
```

### 6.5 复算 7 个 Take 的字节合计与 p50

```bash
python3 - <<'PY'
import json, os, statistics, subprocess

data = json.load(open("performance-test-mcp/docs/m3-takes.json"))
runs = [
    (
        "cM66VIEv",
        "perfstage-c4-workspace/.performance-test/runs/"
        "2026-11-17T04-13-24.250Z-cM66VIEv",
    )
]
runs += [(t["runId"], t["runDirectory"]) for t in data["takes"]]

def bytes_in(path):
    out = subprocess.check_output(
        ["bash", "-c", f"find {path!r} -type f -exec stat -f%z {{}} +"],
        text=True,
    )
    return sum(int(line) for line in out.splitlines() if line.strip())

totals = []
for label, run_dir in runs:
    per = {
        name: bytes_in(os.path.join(run_dir, "traces", f"{name}.trace"))
        for name in ("hitches", "launch", "memory")
    }
    total = sum(per.values())
    totals.append(total)
    print(label, per, total)

m3 = totals[1:]
print("M3 p50 bytes:", statistics.median(m3))
print("M3 p50 MB:", round(statistics.median(m3) / 1e6, 1))
PY
```

## 7. 旧 run 兼容

- `passes[].traceBytes` 与 `passes[].saveMs` 都是可选字段。旧 run（包括上表全部
  7 次 Take）没有它们时按「未测量」处理，不补 0，也不影响 `gate`。
- 旧 run 的 `traceBytes` 可用 §6.1 从 trace 文件复算；旧 run 的 `saveMs` **无法**
  补算，因为保存阶段的起止时间当时没有记录。
- 缺字段不会让 `passRecordSchema` 解析失败；`traceBytes` 为 0、负值或非整数，
  以及 `saveMs` 为负数或非有限值时会被拒绝。旧 run 若曾手工写入 `0`，会被视为
  非法而不是「空 trace」。

## 8. 已知限制

- 字节数是逻辑文件大小，不等于磁盘占用；不要把 `du` 或 Finder 的「大小」与
  本表混用。
- `.trace` 内若有符号链接，本口径跳过；当前 xctrace bundle 没有依赖符号链接
  承载数据，跳过是为了避免重复计数和越界读取。
- `saveMs` 依赖 xctrace 的 `Saving output file` 文案。文案变化或进程被强杀时
  该字段缺失；此时只能依据 `durationMs` 与录制日志判断，不能用墙钟补造数值。
- 上表来自 `xctrace` 27.2。升级 Xcode 或设备系统后，trace 时长与体积分布可能
  变化，应重新记录基线而不是沿用本表。

## 9. C1 候选测量（2026-11-17）

本节对应 tasks 2.1–2.3。所有样本均在同一设备、同一 App 构建
（`com.nndev.im` 6.8.0 / `600800`，`mobilecli apps list` 核验）上采集。原始
trace、录制日志与一次性驱动脚本保存在
`perfstage-c4-workspace/.performance-test/footprint-spikes/2026-11-17/`。

### 9.1 候选配置与前置探针

| 候选 | 配置 | 结果 |
| --- | --- | --- |
| C1 | `Blank` 模板 + `Hitches` instrument | 可用，TOC 含 `hitches-frame-lifetimes` |
| 仅 `Frame Lifetimes` | `Blank` + `Frame Lifetimes` | **不可用**：8.4s 探针只产生 `coreanimation-lifetime-interval` 等表，没有 `hitches-frame-lifetimes`，现有解析器无法读取指标 |

探针结论：C1 应使用 `Hitches` instrument，而不是只加 `Frame Lifetimes`。C1 的
hitches trace 仅 12 张表；默认 `Animation Hitches` 模板的 hitches trace 有 30 张
`kdebug` 表，另有 `time-profile`、线程快照、`syscall`、`visual-chain` 等。体积
差异主要来自被去掉的采样/事件表。

### 9.2 C1 三次紧凑录制

每次录制由 xctrace 冷启动 App，tap `消息` 后执行与 `message-list-scroll` 相同的
两次 500ms 滑动（`201,699 → 201,175`、`201,175 → 201,699`，各等待 1500ms），
动作结束立即停止。窗口为动作起止的主机差值；`blockMs` / `hitches` 由 PerfStage
解析器读取。

| 样本 | bytes | TOC | saveMs | 退出 | 窗口 | hitches | blockMs | framesOutside |
| --- | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: |
| `rep-1` | 1,907,201 | 10.645118s | 1,516 | code 0 / signal null | 4910–9910ms | 81 | 37.5 | 210 |
| `rep-2` | 1,911,965 | 10.613934s | 577 | code 0 / signal null | 4925–9933ms | 81 | 37.5 | 241 |
| `rep-3` | 1,909,006 | 10.589327s | 606 | code 0 / signal null | 4918–9906ms | 81 | 37.5 | 206 |

三次解析均为 `table = hitches-frame-lifetimes`，无 `windowMiss`、无解析 warning。
三次 `hitches` / `blockMs` 完全一致，说明紧凑表在同一场景下是确定性的。

### 9.3 同构建完整 Take 参考

| 项 | 值 |
| --- | --- |
| runId | `2026-11-17T06-52-28.122Z-A-xekb7A` |
| 指标 | hitches 74 / blockMs 37.5 / launchMs 342.4 / memoryMB 113.55 |
| hitches 窗口 | 9611–14659ms（5.048s） |
| Take 墙钟 | 261,179ms |
| hitches pass | 480,622,470 bytes / 142,237ms / saveMs 24,165 |
| launch pass | 133,586,618 bytes / 33,107ms / saveMs 3,251 |
| memory pass | 1,643,130 bytes / 16,147ms / saveMs 361 |
| Take 合计字节 | 615,852,218（615.9MB） |

该 Take 同时验证了 1.2–1.3 的真机端到端落盘：三个 pass 的 `traceBytes` 与磁盘
重新统计逐字节一致，`saveMs` 均有值。

### 9.4 对比与投影

- hitches trace 字节：480.6MB → 1.91MB，**-99.6%**。
- Take 合计字节（用 C1 hitches + 同构建 launch/memory 实测值投影）：
  615,852,218 → 137,136,949（137.1MB），**-77.7%**。这是投影，不是一次真实
  C1 Take；正式 A/B 在 3.2。
- hitches 指标：C1 三次均为 81，完整 Take 为 74，历史同构建
  `cM66VIEv` 为 78；`blockMs` 均为 37.5。样本量不足以判定系统性偏移，但也没有
  出现完全分离；正式判定按 `design.md` D2 在 3.2 用 3 对 A/B 完成。
- hitches pass 墙钟：默认配置 142.2s；C1 单次会话的 trace + 保存约 11.2–12.2s，
  但不含 PerfStage 的预检与 pass 生命周期，**不能**当作 pass 墙钟收益；3.2 必须
  用真实 pass 测量。

### 9.5 2.2 `--window`：当时未执行，后在 3.5 补做

C1 已单独超过方案门禁目标（总字节 -77.7% 投影、hitches 字节 -99.6%，目标是
≥30% / ≥25%）。按 tasks 优先级规则，2.2 记为「未执行（C1 已达标）」，不叠加
`--window`；若 3.2 的 A/B 显示 C1 不达标，再回到 2.2。

C1 后来确因指标口径未通过 D2（§10），因此 `--window` 在 3.5 补做：3 次真机
`--window 11s` 没有产生独立体积下降，结论与数据见 §11。本节的「未执行」只
描述 2026-11-17 15:00 前后的执行顺序，不代表最终状态。

### 9.6 2.3 launch / memory 边界

- memory：`Blank + Activity Monitor`（`--all-processes`，10s）可产生
  `activity-monitor-process-live`，探针 1,395,594 bytes；但默认 memory trace
  只有 1.64MB，不是体积来源，**no-op**。
- launch：`xcrun xctrace list instruments`（27.2）中没有能产生
  `life-cycle-period` / `dyld-activity-interval` 的受支持 instrument；这两张表
  由 `App Launch` 模板提供。按 tasks 约束不手写自定义 `.tracetemplate`，
  launch **no-op**。

### 9.7 2.4 初步建议

建议进入采用分支（C1 = `Blank` + `Hitches`），理由是 C1 的字节收益远超目标且
解析表、窗口与指标口径未变。该建议在用户通过 2.4 方案门禁前不生效；正式采用
仍需 3.1 的内部开关、3.2 的 2 场景 × 3 对 A/B、3.3 的默认切换与文档标注。
3.2 的 A/B 未通过 D2，最终结论见 §10：默认未切换。

### 9.8 内部 profile 开关（3.1）

用户已于 2026-11-17 通过 2.4 方案门禁选择继续验证并准备采用 C1；C1 随后未通过
3.2 的 D2（§10），最终未采用。3.1 在录制层实现了内部开关，默认仍是变更前的
`Animation Hitches`：

| 配置 | 结果 |
| --- | --- |
| `PERFSTAGE_HITCHES_PROFILE` 未设置 / `full` | 与变更前 argv 逐项一致：`--template "Animation Hitches"`，无 `--instrument` |
| `PERFSTAGE_HITCHES_PROFILE=compact` | hitches pass 使用 `--template Blank --instrument Hitches`；launch / memory 不变 |
| 其他值 | 在准备 run 之前报错，避免拼写错误静默回落到 full、也避免留下无终态的 `prepared` run |

该变量只在录制器内部读取，不进入 plan schema，场景作者看不到；但每个 pass 的
`recording` 会在 `run.json`、`report.json` 和 `report.md` 的「录制配置」中展示。
`run.json` 记录形如：

```json
{
  "profile": "compact",
  "template": "Blank",
  "instruments": ["Hitches"],
  "timeLimit": "40s",
  "duringTimeoutMs": 30000,
  "liveTimeoutMs": 30000,
  "window": "full-session",
  "missingDiagnostics": [
    "Time Profiler（time-profile / time-sample / thread-state / context-switch）",
    "CPU 使用率（ProcessCPUUsage / SystemCPUUsage / ThreadCPUUsage / ThreadActivity）",
    "Metal / GPU（metal-* / device-gpu-info）",
    "图形与显示（display-* / visual-chain / visual-connection / displayed-surfaces-*）",
    "线程快照（thread-snapshot / stackshot-info）",
    "系统调用（syscall / syscall-name-map）",
    "日志与 signpost（os-log / os-signpost）",
    "hang 风险（hang-risks / potential-hangs）",
    "生命周期（life-cycle-period）",
    "虚拟内存与热状态（virtual-memory / device-thermal-state-intervals）",
    "runloop（runloop-events）"
  ]
}
```

`profile` 描述**该 pass**：`compact` 只出现在 hitches pass，launch / memory 始终
记为 `full`。`window` 为 `full-session` 表示未传 `--window`（C2 已验证但未采用，
见 §11）。
`duringTimeoutMs` 只出现在有动作回放的 hitches pass，`liveTimeoutMs` 是等待
session 变为 live 的实际上界；两者与 `timeLimit` 一起固定失败路径的边界。
`missingDiagnostics` 只出现在紧凑 profile，列出**主要**缺失诊断族而非全部表：
真机 TOC 实测完整模板 59 个 schema、紧凑模板 12 个，差额 47 个。它用于提醒读者
该 trace 不能当完整诊断 trace 使用。`run.json` 字段在 schema 中可选，旧 run 没有
该字段时按「早于 profile」读取，即 full 模板；内存中的 `RecordedTrace.recording`
与 `PassRecord.recording` 是必填，录制器必须显式给出配置。

C2 的窗口开关同样在录制层：

| 配置 | 结果 |
| --- | --- |
| `PERFSTAGE_HITCHES_WINDOW` 未设置 / 空 | `--window` 不传，`recording.window = "full-session"` |
| `PERFSTAGE_HITCHES_WINDOW=11s` | hitches pass 追加 `--window 11s`；launch / memory 仍为 full-session |
| 非法值 | 在准备 run 之前报错 |

`--window` 是录制期环形缓冲，窗口太短会丢掉动作开头的帧；该开关只用于 C2 A/B，
不随默认配置启用。窗口覆盖是否足够由 §11 的实测数据与 `framesOutside` /
`windowMiss` 判定，不能仅凭“有数据”视为通过。

## 10. 3.2 真机 A/B（2026-11-17）

2.4 方案门禁通过后，按 design D2 做了 2 个场景 × 3 对 A/B（A = 完整
`Animation Hitches` 模板，B = 紧凑 `Blank + Hitches`），顺序为 A/B、B/A、A/B。
12 次 Take 全部为同一设备（`Ra的iPhone` / iOS 27.0.1）、同一 App 构建
（`com.nndev.im` 6.8.0 / `600800`，`mobilecli apps list` 核验）。原始结果、
驱动与判定脚本在 `footprint-spikes/2026-11-17/ab/`（`results.jsonl`、
`results.json`、`driver.mjs`、`analyze.mjs`、`enrich.mjs`）。设备、App 列表、
PerfStage HEAD 与 A/B 运行时 `dist/recording/xctrace.js` 哈希、工具链版本见同目录
`environment.txt`。批次结束后的改动（报告渲染、`duringTimeoutMs`/`liveTimeoutMs`
记录、`missingDiagnostics` 由 5 项扩为 11 类、C2 窗口开关、文档）都不改变默认
hitches argv。12 份 `report.md` 于 16:47 用当前渲染器从各自**未改动**的
`report.json` 重渲染，只新增「录制配置」段与紧凑 trace 提示；`report.json`、
`run.json`、`index.jsonl` 与 trace 均未改写（脚本与说明见 `ab/render-reports.mjs`、
`ab/README.md`）。

### 10.1 逐次记录

| # | 场景 | 组 | runId | status/gate | hitches | blockMs | launchMs | memoryMB | 总字节 | hitches pass | saveMs | 窗口 | 表 | framesOutside |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|---:|
| 1 | community-home-scroll | A | `dJFHZ_tm` | completed/pass | 421 | 91.7 | 333.45 | 114.41 | 746,755,344 | 179,648ms | 27,175ms | 7068–14884ms | `hitches-frame-lifetimes` | 346 |
| 2 | community-home-scroll | B | `rBUmdpyu` | completed/pass | 468 | 91.7 | 297.47 | 113.53 | 161,223,153 | 26,037ms | 573ms | 6668–14395ms | `hitches-frame-lifetimes` | 336 |
| 3 | community-home-scroll | B | `5ysfDVkN` | completed/pass | 470 | 91.7 | 286.06 | 113.69 | 130,369,651 | 25,469ms | 552ms | 6667–14378ms | `hitches-frame-lifetimes` | 320 |
| 4 | community-home-scroll | A | `6IL4eFAD` | completed/pass | 438 | 91.7 | 292.92 | 114.47 | 742,677,108 | 181,023ms | 26,334ms | 7226–15028ms | `hitches-frame-lifetimes` | 362 |
| 5 | community-home-scroll | A | `nXp378E5` | completed/pass | 405 | 91.7 | 364.81 | 113.61 | 806,622,350 | 183,298ms | 27,295ms | 7227–15134ms | `hitches-frame-lifetimes` | 334 |
| 6 | community-home-scroll | B | `-1bZSeHt` | completed/pass | 487 | 36.2 | 274.63 | 112.88 | 164,054,884 | 27,603ms | 1,338ms | 7051–14788ms | `hitches-frame-lifetimes` | 375 |
| 7 | message-list-scroll | A | `91SFAd3e` | completed/pass | 94 | 58.3 | 319.76 | 111.88 | 650,295,005 | 169,270ms | 23,344ms | 10383–15428ms | `hitches-frame-lifetimes` | 353 |
| 8 | message-list-scroll | B | `5pLj6asv` | completed/pass | 78 | 37.5 | 292.61 | 113.06 | 123,278,118 | 26,309ms | 1,352ms | 9377–14428ms | `hitches-frame-lifetimes` | 270 |
| 9 | message-list-scroll | B | `BN4sJ7i7` | completed/pass | 81 | 41.2 | 303.49 | 112.88 | 141,333,948 | 25,119ms | 515ms | 9302–14320ms | `hitches-frame-lifetimes` | 290 |
| 10 | message-list-scroll | A | `mVs5IuR-` | completed/pass | 75 | 37.5 | 320.41 | 114.28 | 629,965,464 | 133,084ms | 19,295ms | 9597–14625ms | `hitches-frame-lifetimes` | 272 |
| 11 | message-list-scroll | A | `i__HUqJr` | completed/pass | 78 | 37.5 | 300.32 | 114.25 | 465,507,611 | 105,484ms | 12,637ms | 9760–14810ms | `hitches-frame-lifetimes` | 272 |
| 12 | message-list-scroll | B | `_EoWVpqB` | completed/pass | 76 | 37.5 | 272.71 | 112.41 | 125,175,529 | 25,453ms | 534ms | 9132–14148ms | `hitches-frame-lifetimes` | 279 |

runId 前缀统一为 `2026-11-17T07-…Z`；完整值见 `results.jsonl`。全部 12 次
`exit 0`、`status=completed`、`gate=pass`、无 findings、无分析 warning、
无 `windowMiss`；B 组的 hitches trace 均含 `hitches-frame-lifetimes`，
`recording.profile=compact` 已落盘。

### 10.2 D2 判定

| 场景 | 指标 | A（3 次） | B（3 次） | p50 变化 | D2 结果 |
| --- | --- | --- | --- | ---: | --- |
| community | hitches | 421 / 438 / 405 | 468 / 470 / 487 | **+11.6%** | ❌ 完全分离（B 全部高于 A），487 超出基线范围 ±极差 |
| community | blockMs | 91.7 / 91.7 / 91.7 | 91.7 / 91.7 / 36.2 | 0% | ❌ 1 次 B=36.2 超出基线范围（基线极差为 0） |
| community | launchMs | 333.45 / 292.92 / 364.81 | 297.47 / 286.06 / 274.63 | -14.2% | ✅ |
| community | memoryMB | 114.41 / 114.47 / 113.61 | 113.53 / 113.69 / 112.88 | -0.8% | ✅ |
| message-list | hitches | 94 / 75 / 78 | 78 / 81 / 76 | 0% | ✅ |
| message-list | blockMs | 58.3 / 37.5 / 37.5 | 37.5 / 41.2 / 37.5 | 0% | ✅ |
| message-list | launchMs | 319.76 / 320.41 / 300.32 | 292.61 / 303.49 / 272.71 | -8.5% | ❌ 1 次 B=272.71 低于基线范围下界 280.23 |
| message-list | memoryMB | 111.88 / 114.28 / 114.25 | 113.06 / 112.88 / 112.41 | -1.2% | ✅ |

体积与 hitches pass 墙钟（目标：总字节 p50 下降 ≥30%，hitches pass p50 下降
≥25%）：

| 场景 | 总字节 p50 A → B | hitches 字节 p50 A → B | hitches pass p50 A → B |
| --- | --- | --- | --- |
| community-home-scroll | 746,755,344 → 161,223,153（**-78.4%**） | 612,420,994 → 2,034,821（**-99.7%**） | 181,023ms → 26,037ms（**-85.6%**） |
| message-list-scroll | 629,965,464 → 125,175,529（**-80.1%**） | 451,982,875 → 1,920,705（**-99.6%**） | 133,084ms → 25,453ms（**-80.9%**） |

### 10.3 结论：未达标，默认不切换

收益目标大幅超额，但每次 Take 都合规、表与窗口完整的前提下，**指标口径未保持
不变**，因此按 design D2 判定为未达标：

- 决定性证据是 `community-home-scroll` 的 hitches **完全分离**：A 组 405–438，
  B 组 468–487，3 对 3 没有交叠，p50 +11.6%。这属于 design D2 与规格
  「指标出现系统性偏移」条款要求停止采用的测量口径变化，不能解释为优化收益。
- `blockMs` 的 36.2（B）与 `launchMs` 的 272.71（B，针对未改动的 launch pass）
  各自触发一次范围外判定。`launchMs` 更可能来自设备漂移或前序录制开销差异，
  但 D2 是逐条判定，不做选择性豁免。
- 若接受新的指标分布，必须按 design D2 第 5 条另开重标定 change，重新采集基线
  并评估阈值；本 change 不放宽任何阈值、容差或 gate 语义，也不切换默认配置。

因此 3.3 不执行（决策：no-op），3.4 记录 no-op；默认仍是 `Animation Hitches`
完整模板。3.1 的内部开关保留且默认关闭，后续若通过重标定 change，可直接用它
启用 C1。

## 11. 3.5 C2 真机验证（完整模板 + `--window`）

design D3 要求 C1 单独不达标时再验证 C2。2026-11-17 16:10–16:26 CST 用完整
`Animation Hitches` 模板 + `--window 11s` 对 `community-home-scroll` 做了 3 次
真机 spike（`PERFSTAGE_HITCHES_WINDOW=11s`）。设备、App、工具链同 §10；原始输出
在 `footprint-spikes/2026-11-17/c2/`（`spike.log`、`results.json`、`inspect.py`、
`environment.txt`、`argv-proof.mjs` / `argv-proof.txt`、`control-window-flag.txt`、
`control-toc.xml`、`control-thread-state-head.xml`）。

### 11.1 逐次记录

| # | runId | status/gate | trace 时长 | 窗口 | 总字节 | hitches 字节 | hitches pass | saveMs | hitches | blockMs | launchMs | memoryMB | 保留帧起点–终点 |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | `HNZpxn_4` | completed/fail | 18.00s | 7120–14904ms | 738,796,744 | 598,729,925 | 179,189ms | 28,931ms | 412 | 41.7 | 559.46 | 111.06 | 405–17,959ms |
| 2 | `RXmdhHXX` | completed/warn | 18.20s | 7411–15175ms | 781,077,641 | 634,515,126 | 209,202ms | 28,747ms | 448 | 91.7 | 515.07 | 112.33 | 332–18,172ms |
| 3 | `sgMdfAgj` | completed/fail | 18.19s | 7522–15266ms | 736,405,127 | 599,804,732 | 194,201ms | 27,778ms | 371 | 104.2 | 557.15 | 112.61 | 405–17,503ms |

runId 前缀为 `2026-11-17T08-…Z`。三次 `recording.window` 均为 `11s`，
`recording.profile=full`；hitches trace 均含 `hitches-frame-lifetimes`，
无 `windowMiss`、无分析 warning。TOC 的 `start-date` / `end-date` / `duration`
为：

| # | TOC 起始 | TOC 结束 | `recording-mode` | `time-limit` |
|---|---|---|---|---:|
| 1 | 16:10:28.332 | 16:10:46.336 | Deferred | 40s |
| 2 | 16:15:39.188 | 16:15:57.387 | Deferred | 40s |
| 3 | 16:21:21.476 | 16:21:39.665 | Deferred | 40s |

三次都从 Take 开始后约 10s 起录、时长 18.0–18.2s，与 `--time-limit 40s`
和正常停止语义一致。§10 的 A 组同一场景也是 `Deferred`（如 `dJFHZ_tm`：
17.94s），所以下面的对照不是「A 组不是 Deferred」造成的差异。

### 11.2 结果：`--window` 没有裁剪事件

与 §10 的 A 组（同场景、同设备、同构建）比较：

| 指标 | A p50（3 次） | C2 p50（3 次） | 变化 |
| --- | ---: | ---: | ---: |
| 总 trace 字节 | 746,755,344 | 738,796,744 | **-1.1%** |
| hitches 字节 | 612,420,994 | 599,804,732 | **-2.1%** |
| hitches pass 墙钟 | 181,023ms | 194,201ms | **+7.3%** |
| `saveMs` | 27,175ms | 28,747ms | **+5.8%** |

体积目标为总字节 p50 下降 ≥30%，实际为 **-1.1%**；hitches pass 目标为下降
≥25%，实际为 **+7.3%**（更慢）。原因不是窗口设得不够短，而是 `--window` 在
这条录制路径上没有丢弃窗口外事件：

- 三次录制的 trace 时长仍为 18.0–18.2s，首帧仍在 332–405ms，帧表覆盖
  0–18s；若窗口真的保留末尾 11s，首帧应在约 7.0s。
- 总字节与 A 组同量级；`saveMs` 没有下降，反而略升。
- 对照实验（`control-window-flag.txt`、`control-toc.xml`）：`--all-processes
  --time-limit 8s --window 4s` 的 trace 时长仍为 8.68s，`thread-state` /
  `ThreadActivity` 仍保留 0s 处事件（`control-thread-state-head.xml`）。
  这支持「本场景下该 flag 没有裁剪」，但不外推为「所有 Deferred 录制都不裁剪」：
  design §Context 记录的早期 Time Profiler 探针（5946 vs 6295 行）未在本轮对账，
  仍是未解释项。

因此 C2 没有独立体积下降，按 design D3 与规格「收益来自证据丢失/未验证候选
不得计入」直接判为 no-op，不进入 3.6 的完整 A/B。默认仍是完整 `Animation
Hitches`、无 `--window`；内部 `PERFSTAGE_HITCHES_WINDOW` 保留且默认关闭。

### 11.3 窗口推导与覆盖余量

`--window` 长度按 design D4 由动作预算推导：`community-home-scroll` 的 5 个
swipe 各 `durationMs=500` + `waitAfterMs=500`，预算 5000ms；`plan.json` 的
`warmup` 为 `[]`；固定余量取 6s，故窗口 11s（5000 + 6000）。该余量同时覆盖
动作前后的前台探测与录制启动偏差。实际测量窗口由分析器确定：

| # | 测量窗口 | 窗口宽度 | 11s 总余量（每侧约一半） | 窗口起点前仍保留的数据 | 窗口终点后仍保留的数据 |
|---|---|---|---:|---:|---:|
| 1 | 7120–14904ms | 7784ms | 3216ms（每侧约 1.6s） | 6714ms | 3055ms |
| 2 | 7411–15175ms | 7764ms | 3236ms（每侧约 1.6s） | 7079ms | 2997ms |
| 3 | 7522–15266ms | 7744ms | 3256ms（每侧约 1.6s） | 7117ms | 2237ms |

推导上 11s 足以覆盖测量窗口（总余量 ≥3.2s、单侧约 1.6s），所以「窗口设得太短」
不是失败的原因。反过来，两侧仍保留 6.7–7.1s / 2.2–3.1s 的窗口外数据，正是 `--window`
未生效的直接观测：若环形缓冲只保留末尾 11s，起点前应几乎没有数据。

### 11.4 `--window` 确实进入了 xctrace argv

`run.json` 的 `recording` 与 argv 在代码里同源：`recordOnce` 用同一个
`request` 对象调用 `buildRecordArgs(request, profile)` 和
`recordingConfigFor(request, profile)`，`resolveRecording` 对同一个
`window` 字段既做校验又写进 `--window`。因此三次 `recording.window=11s`
已说明 argv 含 `--window 11s`。

为免只靠推理，`argv-proof.mjs` 用假 xctrace 脚本捕获真实 argv（`argv-proof.txt`）：

```text
record
--template
Animation Hitches
--device
00008150-001E49E40128C01C
--time-limit
40s
--no-prompt
--window
11s
--attach
4242
```

同一进程里 launch pass 的 argv 不含 `--window`，与「开关只作用于 hitches」
一致。`spike.log` 中每次 Take 也有录制器自己的
`hitches window: last 11s` 一行。

构建标识：C2 的 dist 由 2026-11-17 16:10 构建，源码最后修改时间为 16:09；
此后只改了注释位置、报告渲染回退、测试与文档，16:48 最终构建使
`dist/recording/xctrace.js` 的 hash 与 C2 时不同（当前
`e978df57…`，A/B 时为 `9fe20c55…`）。精确的 C2 dist 字节未保留，这是本节
证据的已知限制；argv 构造与 profile 解析逻辑在 C2 之后未改。

补充：三次 spike 的 `launchMs` 为 515–559ms，其中 2 次 gate=fail、1 次 warn，
明显偏离 §10 的 293–365ms。launch pass 的 argv 与指标解析未被本 change 触及，
因此没有直接因果证据把该漂移归给 C2 窗口；但它也不能被证伪（连续录制的热状态、
设备侧负载都未排除），故这三次 gate fail 作为设备观察项记录。C2 已在体积主指标
上失败，这三次 Take 不用于指标稳定性判定，也不据此改写任何阈值或基线。
