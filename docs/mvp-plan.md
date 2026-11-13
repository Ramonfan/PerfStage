# PerfStage MVP 规划与实施计划

| 项 | 内容 |
| --- | --- |
| 文档版本 | v1.0 |
| 日期 | 2026-11-13 |
| 仓库 | [Ramonfan/PerfStage](https://github.com/Ramonfan/PerfStage) |
| 当前状态 | 控制面可用；执行器未实现 |
| 计划周期 | MVP 6 周（约 26 人日，含 CLI），v1.0 再 +2 周 |
| 估算假设 | 1 名开发者、1 台 iOS 真机、可随时用模拟器补位 |

---

## 0. 一页摘要

**MVP 命题：在一个真实 iOS 项目里把场景定义一次，之后每次只需一次调用就能完成测试，并拿到一份可信、可追溯的报告。**

MVP 要证明三个假设：

| 假设 | 说明 | 不成立会怎样 |
| --- | --- | --- |
| H1 场景可表达 | YAML + Skill 能表达真实业务场景，不需要为每个场景改代码 | 产品退化为一次性脚本 |
| H2 执行可独立 | 平台能自己完成动作、采集、收尾，Claude 退出执行链 | 无法稳定复跑，也无法 CI |
| H3 报告可信 | 报告能回答「这次测试是否有效、指标是否达标」 | 重复测试没有决策价值 |

**范围一句话：单设备、单场景、一键执行、可信报告、可脚本化的 CLI。不做基线、不做 CI 模板、不做多设备。**

**时间：6 周，每周一个可演示节点。**

```text
Week 1  M0 仓库与工程基线 + M1 可信单次
Week 2  M1 收尾 + M2 Skill 化与真实场景
Week 3  M3 Runner 前半
Week 4  M3 Runner 后半 + 真机冒烟
Week 5  M3.5 CLI 薄封装 + 修复缓冲
Week 6  验收、文档与 v0.1
（之后）M4 基线与回归门禁 → v1.0
```

---

## 1. 现状与起点

### 1.1 可以保留的资产

| 资产 | 位置 | 对 MVP 的价值 |
| --- | --- | --- |
| 领域模型 | `src/model/test-plan.ts`、`src/model/test-run.ts` | 场景、动作、指标、运行状态的契约 |
| 场景解析 | `src/scenario/parser.ts`、`loader.ts` | YAML → TestPlan，未知动作直接报错 |
| 运行存储 | `src/storage/runs.ts` | 独立 run 目录、证据边界、原子写、finalize 锁 |
| 诊断归一化 | `src/diagnostics/normalize.ts` | 日志三态、Crash 差集、生命周期 |
| 报告 | `src/reports/*.ts` | JSON + 中文 Markdown |
| 工作区隔离 | `src/workspace/*` | 项目即边界，不跨项目读写 |
| 回归基线 | `src/__tests__` | 21 文件 / 163 用例，可作为重构保护网 |

### 1.2 必须补的缺口

| 缺口 | 现状 | MVP 要做的改动 |
| --- | --- | --- |
| 无执行器 | `prepare` 只返回 `nextSteps`，由 Claude 现场编排 | 新增 Runner，自动完成动作与采集 |
| `prepare` 计划不完整 | 返回 `runPath` / `planPath`，不返回 actions | 返回值内联 `plan`，Skill 不读文件 |
| 证据校验不足 | 指标只按 `name` 判断存在，缺 `tracePath` 仍可能 `completed` | 增加 value / trace / evidence 三类校验 |
| 阈值不生效 | `threshold` 仅透传，无 verdict 计算 | 新增阈值判定与 `gate` |
| 生命周期未落地 | `running` 状态与 `repetitions` 定义了但未使用 | Runner 真正写入 `running`，支持复跑 |
| 无结果对比 | 只有单次报告 | 不在 MVP，M4 处理 |

**结论：底座够用。MVP 的本质是「接上执行器 + 收紧证据 + 固化 Skill」，不是重写。**

---

## 2. MVP 定义

### 2.1 目标用户

- 1–3 人的 iOS 团队里，负责性能与稳定性的工程师。
- 每次版本迭代后，需要重复跑 3–5 个固定场景。
- 能接受用 YAML 描述场景，但不愿意每次向 AI 重新解释测试步骤。

### 2.2 用户旅程

| 阶段 | 现在 | MVP 之后 |
| --- | --- | --- |
| 接入 | 初始化 + 写 YAML + 每次口述流程 | 初始化 + 写 YAML + 从一个模板复制 Skill |
| 执行 | Claude 按 `nextSteps` 手工编排 8 步 | 调用一次 `run_performance_test` |
| 采集 | Claude 逐个调 Instruments，自己搬结果 | Runner 自动采集并落盘 |
| 判定 | 人工看报告，状态可能虚高 | 自动降级 + 阈值 verdict + gate |
| 复跑 | 重新口述一遍 | 再执行一次同一个 Skill |

### 2.3 MVP 范围（P0，必须做）

| 编号 | 能力 | 说明 |
| --- | --- | --- |
| S1 | 一键执行 | `run_performance_test({ scenarioId, device })` 完成整条链路 |
| S2 | 自动动作 | warmup、actions、等待、单步重试、超时 |
| S3 | 自动采集 | 指标 trace + 设备日志 + Crash 差集 + 生命周期 |
| S4 | 证据门禁 | 缺值 / 缺 trace / 查询失败 → 不允许 `completed` |
| S5 | 阈值与 gate | 根据场景 `threshold` 计算 verdict 与 `gate` |
| S6 | Skill 层 | 模板 + 一个真实项目的 2 个场景 |
| S7 | 可用报告 | 指标、证据、限制、结论四部分齐全 |
| S8 | CLI 薄封装 | `perfstage init/list/run/report`，退出码可被脚本消费 |

### 2.4 明确不做（Non-goals）

| 不做 | 原因 | 何时做 |
| --- | --- | --- |
| 基线、趋势、历史索引 | 单次报告已能验证 H1–H3 | M4 / v1.0 |
| CI 流水线模板 | CLI 已提供退出码，MVP 不提供 CI 配置模板 | M4 / v1.0 |
| 多设备池、并发、调度 | 当前瓶颈是「跑不稳」，不是「跑得少」 | 有团队需求后 |
| Android / Web / 桌面 | 产品明确 iOS-only | 不做 |
| 多租户、权限、Web 控制台 | 单机单项目足够验证价值 | 不做 |
| 自定义组合 Instruments 模板 | 依赖 xctrace 模板管理，收益低于成本 | 观察 |
| 场景版本管理 | 直接改 YAML 即可 | 多人协作时 |
| 云真机 | 本地真机足够 | 规模化时 |

### 2.5 验收标准（Definition of Done）

MVP 只有全部满足才算完成：

| 编号 | 验收项 | 判定方式 |
| --- | --- | --- |
| A1 | 新项目 30 分钟内接入 | 计时：init → 场景 → Skill → 首次运行 |
| A2 | 一次调用完成，无中间人工步骤 | Skill 中只有 1 次 `run_performance_test` 调用 |
| A3 | 至少 3 个指标带 trace 落盘 | `hitches`、`blockMs`、`memoryMB` 均可追溯 |
| A4 | 缺 trace 时状态为 `partial` | 构造缺 trace 的用例验证 |
| A5 | 新增 Crash 时状态为 `failed` | 构造 Crash 差集用例验证 |
| A6 | 同一场景连续 3 次结果有效 | 3 次均 `completed`，无采集/设备错误；波动如实呈现 |
| A7 | 报告含 verdict / gate / 证据 / 限制 | 人工评审 `report.md` |
| A8 | 单次运行 ≤ 8 分钟（15s 场景 + 3 指标） | 计时 |
| A9 | 现有 163 用例保持通过，新增 ≥ 30 | `npm test` |
| A10 | 2 个真实场景在真机跑通 | 真机验收记录 |
| A11 | CLI 退出码正确 | 4 类场景逐一验证（pass / gate fail / 无效 / 环境错误） |
| A12 | CLI `--json` 与 MCP 返回同构 | 同一次 run 对比两个输出 |

> A6 不设指标波动硬阈值。性能测试的绝对值受设备和系统影响，MVP 只要求「结果有效且可解释」，不承诺「数值稳定」。

---

## 3. 关键决策

| 编号 | 决策 | 理由 | 代价 |
| --- | --- | --- | --- |
| D1 | MVP 直接做 **Thin Skill + Runner** | 产品承诺是「执行 Skill 即完成」，Thick Skill 依赖现场发挥，无法验证 H2 | 比 Thick Skill 多 2 周 |
| D2 | Runner 内嵌在 MCP 进程，不做守护进程 | 单机单用户，进程内即可；避免 IPC、队列、部署复杂度 | 不能跨进程复用 |
| D3 | 通过 MCP stdio 调 `mobile-mcp` / `instruments-mcp` | 复用现有能力；未来换实现只改适配器 | 多两个子进程，启动有开销 |
| D4 | 采集使用 `start_profiling` / `stop_profiling`，**一次只录一个模板** | Instruments 一次只能录一个模板；这是硬约束 | 多指标需要顺序多 pass |
| D5 | 证据门禁优先于「跑通」 | 假 `completed` 会摧毁产品可信度 | 初期 `partial` 比例会偏高 |
| D6 | `status` 与 `gate` 分离 | `status` 表示测试是否有效，`gate` 表示指标是否达标 | 需要调整现有 `deriveFinalStatus` 语义 |
| D7 | 继续用文件系统，不引入数据库 | 单项目数据量小；M4 再考虑索引 | 跨 run 查询靠目录扫描 |
| D8 | 配置向后兼容，新增可选 `adapters` | 不影响已初始化项目 | 需要 schema 版本处理 |
| D9 | **CLI 纳入 MVP**（已确认） | 退出码让脚本可直接消费，且 CLI 只是 Runner 薄封装 | +2 人日，MVP 约 26 人日 |
| D10 | **真机优先**，模拟器仅补位（已确认） | 卡顿/Hitches 在模拟器上不可信 | 需要一台稳定真机 |

### D4 的具体后果

`instruments-mcp-server` 的 `start_profiling` 是模块级单例，只能同时录一个模板。因此一次 Take 的采集流程是：

```text
对每个唯一模板：
  重置 App → warmup → start_profiling(模板) → actions → stop_profiling → 解析
```

这意味着 **3 个指标 = 3 次动作回放**。MVP 接受这个代价，并在报告中标注 `pass`，同时把「合并模板」列入观察项。

---

## 4. 技术方案

### 4.1 目标链路

```text
Scene Skill
   │  1 次调用
   ▼
run_performance_test  (PerfStage MCP)
   ▼
Runner
   ├─ DeviceDriver   → mobile-mcp        （动作 / 日志 / Crash / 截图）
   ├─ MetricCollector→ instruments-mcp   （start/stop profiling）
   └─ RunStore       → .performance-test/runs/<id>/
   ▼
证据门禁 + 阈值判定 → report.json / report.md
```

架构图见 [`docs/diagrams/perfstage-architecture.html`](diagrams/perfstage-architecture.html)，流程见 [`docs/diagrams/perfstage-workflow.html`](diagrams/perfstage-workflow.html)。

### 4.2 新增与改动模块

```text
src/
├── runner/
│   ├── types.ts              # Runner 输入输出、适配器契约
│   ├── runner.ts             # 编排：prepare → execute → collect → finalize
│   ├── mcp-client.ts         # stdio MCP client 工厂（超时、日志、关闭）
│   ├── adapters/
│   │   ├── device.ts         # mobile-mcp 适配器
│   │   ├── collector.ts      # instruments-mcp 适配器
│   │   └── evidence.ts       # 日志 / Crash / 生命周期收尾
│   └── errors.ts             # 可重试 / 不可重试 / 设备断开
├── analysis/
│   ├── thresholds.ts         # warn/fail → verdict，汇总 gate
│   └── metrics.ts            # 指标标准化（名称、单位、来源）
├── tools/
│   └── run.ts                # run_performance_test
├── model/
│   └── run-result.ts         # Skill 级输出契约
├── cli/
│   ├── index.ts              # perfstage 入口与参数解析
│   └── exit-codes.ts         # status / gate → 退出码
└── （改动）
    ├── tools/index.ts        # 注册新工具
    ├── tools/plan.ts         # 返回值内联完整 plan
    ├── tools/report.ts       # 复用 Runner 的 finalize 逻辑
    ├── reports/findings.ts   # 证据校验增强
    ├── reports/status.ts     # status / gate 分离
    ├── workspace/model.ts    # config v2：可选 adapters
    └── index.ts              # 启动时构造 Runner
```

| 模块 | 职责 | 不做什么 |
| --- | --- | --- |
| `runner.ts` | 生命周期、顺序、重试、超时、最终状态 | 不实现具体设备调用 |
| `device.ts` | 动作意图 → mobile-mcp 工具调用 | 不做业务判断 |
| `collector.ts` | 指标请求 → 模板录制 → 标准化结果 | 不生成报告 |
| `evidence.ts` | 日志/Crash/生命周期采集与路径处理 | 不决定状态 |
| `thresholds.ts` | 阈值计算与 gate | 不做诊断 |
| `run.ts` | 参数校验、工作区守卫、调用 Runner | 不写文件细节 |
| `cli/` | 参数解析、输出、退出码 | 不重复实现 Runner 逻辑 |

### 4.3 一次 Take 的时序

```text
1. 校验 workspace / scenario / device
2. 创建 run（prepared），写入 plan.json
3. transition → running
4. 记录 Crash 快照；在独立 client 上异步启动日志采集
5. 解析 App 进程名、屏幕尺寸
6. for 每个唯一模板:
     6.1 terminate + launch App（重置状态）
     6.2 执行 preconditions / warmup
     6.3 start_profiling(template, device, process)
     6.4 顺序执行 actions（每步成功后 waitAfterMs）
     6.5 stop_profiling → 解析指标 + tracePath
     6.6 单步失败：重试 1 次；仍失败则记录 partial/failed
7. 采集后置证据：停止日志、Crash 差集、生命周期
8. 指标标准化 + 阈值 verdict + gate
9. 证据门禁 → 最终 status
10. 写 run.json / report.json / report.md
11. 返回 Skill 级结果
```

失败分支：

| 情况 | 行为 |
| --- | --- |
| 单个 action 失败 | 重试 1 次；仍失败则终止剩余动作，`failed` |
| 指标采集失败 | 该指标标记缺失，继续下一个模板，最终 `partial` |
| 日志 / Crash 查询失败 | 记录 `*QueryError`，最终 `partial` |
| 新增 Crash / jetsam / watchdog / 断连 | 立即终止剩余模板，`failed` |
| 任何异常 | `finally` 中确保 `stop_profiling` 与日志停止 |

### 4.4 适配器契约

```ts
export interface DeviceDriver {
  listDevices(): Promise<DeviceInfo[]>;
  screenSize(): Promise<{ width: number; height: number }>;
  launchApp(bundleId: string): Promise<void>;
  tap(target: string): Promise<void>;
  swipe(direction: "up" | "down" | "left" | "right", distance: number, durationMs?: number): Promise<void>;
  typeText(text: string): Promise<void>;
  waitFor(target: string, timeoutMs: number): Promise<void>;
  // startLogs 不阻塞：内部用独立 client 发起一次同步采集，保存 promise
  startLogs(options: LogOptions): Promise<void>;
  stopLogs(): Promise<{ text: string; path?: string }>;
  listCrashes(): Promise<CrashRef[]>;
  getCrash(id: string): Promise<string>;
  screenshot(path: string): Promise<void>;
}

export interface MetricCollector {
  collect(input: {
    template: string;
    deviceId: string;
    processName: string;
    durationMs: number;
    actions: () => Promise<void>;
  }): Promise<CollectedMetric[]>;
}

export interface CollectedMetric {
  name: string;
  value: number;
  unit: string;
  tracePath: string;
  raw: unknown;
}
```

设计要点：

- **动作回调交给 Collector**：录制起止由采集器控制，动作由 Runner 回调执行，避免时序错位。
- **适配器可替换**：测试注入 fake，真机注入 MCP 实现。
- **契约里不出现 Claude**：Runner 是纯程序执行。

### 4.5 MCP 工具映射

**动作层（mobile-mcp）**

| 场景意图 | mobile-mcp 调用 | 备注 |
| --- | --- | --- |
| 启动 App | `mobile_launch_app` | 每 pass 前重置 |
| 解析进程名 | `mobile_list_apps` | 用 bundleId 匹配返回的 `appName (packageName)` |
| 确认前台 | `mobile_get_foreground_app` | 前置条件校验 |
| 点击文本 | `mobile_list_elements_on_screen(format=json)` → `mobile_click_on_screen_at_coordinates(ref)` | 优先用 ref；屏幕变化后重新列举 |
| 滑动 | `mobile_swipe_on_screen(direction, distance)` | distance 单位像素，无需自己换算 |
| 输入 | `mobile_type_keys` | 需要焦点 |
| 等待元素 | 轮询 `mobile_list_elements_on_screen` | 超时即失败 |
| 日志 | `mobile_get_device_logs` | 动作前启动，动作后停止 |
| Crash | `mobile_list_crashes` + `mobile_get_crash` | 前后差集 |
| 截图 | `mobile_save_screenshot` | 失败时留存 |

**采集层（instruments-mcp）**

| 指标名 | Instruments 模板 | 取值字段 | 单位 | 说明 |
| --- | --- | --- | --- | --- |
| `hitches` | Animation Hitches | `totalHangs` | 次 | 卡顿总数 |
| `blockMs` | Time Profiler | `max(mainThreadBlockers[].durationMs)` | ms | 主线程最长阻塞 |
| `memoryMB` | Allocations | `totalMB` | MB | 分配总量，非 resident footprint |
| `launchMs` | App Launch | `totalLaunchMs` | ms | 冷启动/热启动由 `launchType` 标注 |

约束：

- `start_profiling` / `stop_profiling` 返回 JSON，可直接消费；不要解析人类可读文本。
- 录制上限 5 分钟，Runner 的场景预算必须小于该值。
- 真实设备必须传 UDID；模拟器用 `booted`。
- `mobile_get_device_logs` 是**同步阻塞**调用（最多 30 秒静默或到达 limit），必须用独立 MCP client 异步启动，动作结束后再 await；否则会阻塞动作执行。

### 4.6 证据门禁与状态

判定顺序（自上而下，先命中先返回）：

| 顺序 | 条件 | status | gate |
| --- | --- | --- | --- |
| 1 | 请求 `invalid` / `cancelled` | 原样 | `unknown` |
| 2 | 新增 Crash、jetsam、watchdog、设备断连 | `failed` | `fail` |
| 3 | 流程中断或动作最终失败 | `failed` | `unknown` |
| 4 | 任一指标缺值或缺 `tracePath` | `partial` | `unknown` |
| 5 | 日志 / Crash / 生命周期查询失败 | `partial` | `unknown` |
| 6 | 指标 verdict 有 `fail` | `completed` | `fail` |
| 7 | 指标 verdict 有 `warn` | `completed` | `warn` |
| 8 | 全部通过 | `completed` | `pass` |

**关键变化（D6）**：阈值不达标不再把 `status` 降为 `partial`。测试跑完整了就是 `completed`，性能退化由 `gate=fail` 表达。这样「测试是否可信」和「性能是否达标」不再混为一谈。

阈值规则：

```text
value >= threshold.fail  → verdict = fail
value >= threshold.warn  → verdict = warn
否则                      → verdict = pass
无阈值                     → verdict = unknown
gate = fail 若任一 fail；否则 warn 若任一 warn；否则 pass
```

### 4.7 Skill 级输出契约

```json
{
  "runId": "2026-11-20T06-20-00.000Z-a1b2",
  "sceneId": "community-home-scroll",
  "status": "completed",
  "gate": "warn",
  "metrics": [
    {
      "name": "hitches",
      "value": 3,
      "unit": "次",
      "verdict": "warn",
      "tracePath": ".performance-test/runs/<runId>/traces/hitches.trace"
    }
  ],
  "findings": [],
  "evidencePaths": { "deviceLog": "device.log", "crashes": [] },
  "reportPath": ".performance-test/runs/<runId>/report.md",
  "durationMs": 312000,
  "passes": 3
}
```

### 4.8 配置扩展

`.performance-test/config.json` 新增可选 `adapters`，并升级为 schemaVersion 2：

```json
{
  "schemaVersion": 2,
  "app": { "bundleId": "com.example.app", "name": "Example App" },
  "scenarioDirectory": ".performance-test/scenarios",
  "runsDirectory": ".performance-test/runs",
  "adapters": {
    "device": {
      "type": "mobile-mcp",
      "command": "npx",
      "args": ["-y", "@mobilenext/mobile-mcp@latest"]
    },
    "collector": {
      "type": "instruments-mcp",
      "command": "node",
      "args": ["/absolute/path/instruments-mcp-server/dist/index.js"]
    }
  }
}
```

兼容策略：

- 读取时同时接受 v1 / v2；v1 使用内置默认命令。
- 初始化只写 v2；旧项目不强制迁移。
- 命令缺失时返回可操作的错误，而不是静默失败。

### 4.9 错误、重试与超时

| 场景 | 策略 |
| --- | --- |
| 单步动作失败 | 重试 1 次（可配置），仍失败则终止 |
| 元素找不到 | 明确报错并附当前可见元素摘要，不做猜测式点击 |
| 录制超时 | 模板预算 + 60s 硬超时，强制 `stop_profiling` |
| MCP 子进程崩溃 | 重启 1 次；仍失败则 `failed`，记录 stderr 摘要 |
| 设备断连 | 立即 `failed`，保留已有证据 |
| 工作区未初始化 | 直接结构化错误，不创建任何文件 |

### 4.10 测试策略

| 层级 | 内容 | 工具 |
| --- | --- | --- |
| 单元 | 阈值、状态判定、指标标准化、证据规则 | vitest |
| 契约 | mobile-mcp / instruments-mcp 响应 fixture → 适配器输出 | vitest + fixtures |
| 集成 | fake DeviceDriver / Collector 驱动完整 Runner | vitest |
| 真机冒烟 | 1 个场景 × 3 次，手动触发 | 脚本 + 验收记录 |
| 回归 | 现有 163 用例必须全绿 | `npm test` |

要求：

- 所有设备与采集调用都必须经过接口，测试中不启动真实 MCP 子进程。
- 至少保存 1 份真实 `stop_profiling` JSON 与 1 份 `mobile_list_elements_on_screen` 响应作为 fixture。
- 真机冒烟不进入默认 CI，避免设备依赖。

### 4.11 CLI 薄封装

CLI 是 Runner 的薄封装，不引入新逻辑：解析参数 → 调用与 MCP 工具相同的 Runner 函数 → 打印结果 → 设置退出码。`package.json` 增加 `bin.perfstage`。

```bash
perfstage init --app com.example.app
perfstage list
perfstage run community-home-scroll --device <UDID> [--json] [--strict]
perfstage report <runId>
```

| 子命令 | 作用 | 关键参数 |
| --- | --- | --- |
| `init` | 初始化工作区 | `--app <bundleId>`、`--force` |
| `list` | 列出场景与最近运行 | `--json` |
| `run` | 执行一次 Take | `--device <udid>`、`--json`、`--strict` |
| `report` | 打印已有报告 | `<runId>`、`--json` |

退出码是 CLI 的核心价值：

| 退出码 | 条件 |
| --- | --- |
| `0` | `status=completed` 且 `gate` 为 `pass` / `warn` / `unknown` |
| `1` | `status=completed` 且 `gate=fail`（`--strict` 时 `warn` 也返回 1） |
| `2` | `status` 为 `partial` / `failed` / `invalid` / `cancelled`（测试无效） |
| `3` | 环境或配置错误（未初始化、设备离线、依赖缺失） |

约束：

- `run` 必须在 `finalize` 完成后返回，退出码反映最终 `status` 与 `gate`。
- `--json` 输出与 MCP 工具返回值同构，脚本不需要两套解析。
- CLI 不包含基线对比，`compare` 在 M4。

### 4.12 兼容性

| 项 | 策略 |
| --- | --- |
| 现有 4 个工具 | 签名不变，`prepare` 只做加法（内联 `plan`） |
| 现有报告结构 | 保留字段，新增 `gate` / `passes` |
| 数据目录 | 继续 `.performance-test/`，不迁移 |
| MCP server 名 | 继续 `performance-test`，避免重新注册 |
| 旧 config | 可读，不强制升级 |

---

## 5. 里程碑

### M0 — 仓库与工程基线（2.5 人日）

**目标：** 有一个可协作、可回归的仓库。

- [x] 配置 `origin`，本地提交当前工作区（推送待确认）
- [x] GitHub Actions：Node 20，`npm ci && npm run build && npm test`
- [ ] 补齐 `.gitignore`、README 链接、MVP 文档
- [ ] 录制第一份真实设备 fixture（`mobile_list_elements_on_screen`）
- [ ] 0.5 天技术验证：`start_profiling` 能否在真机上 attach

**交付物：** 绿色 CI；真机 attach 结论。

**验收：** 新克隆仓库可一键构建与测试。

### M1 — 可信单次（5 人日）

**目标：** 即使仍然由 Claude 编排，也不会再出现「假通过」。

- [ ] `prepare_performance_test` 返回完整 `plan`
- [ ] 证据门禁：缺值 / 缺 trace / 查询失败
- [ ] 阈值 verdict 与 `gate`
- [ ] `status` 与 `gate` 分离
- [ ] 指标标准化模块
- [ ] 抽出共享 `finalizeRun()`（工具与 Runner 共用）
- [ ] 补充测试（≥ 15 个）

**交付物：** 可信的 `finalize` 与报告。

**验收：** A4、A5、A7 通过。

### M2 — Skill 化与真实场景（3.5 人日）

**目标：** 用一个真实场景连续跑 3 次，验证 H1。

- [ ] `templates/SKILL.md`：可复制的 Skill 模板
- [ ] 示例项目 Skill（1 个场景）
- [ ] 运行 3 次，记录状态与指标波动
- [ ] 修正场景 DSL 中不合理的部分
- [ ] 文档：Skill 契约与编写规则

**交付物：** 可重复执行的 Thick Skill + 3 次运行记录。

**验收：** A1、A6 初步通过。

### M3 — Runner 与一键执行（10.5 人日）

**目标：** Claude 退出执行链，验证 H2 + H3。

- [ ] 配置 v2：adapters（device / collector）
- [ ] MCP client 封装（超时、重启、关闭）
- [ ] DeviceDriver + mobile-mcp 适配器
- [ ] MetricCollector + instruments-mcp 适配器
- [ ] 证据适配器（日志 / Crash / 生命周期）
- [ ] Runner 编排与状态机（`running`、`repetitions`）
- [ ] `run_performance_test` 工具
- [ ] fake 适配器 + 集成测试（≥ 15 个）
- [ ] 真机冒烟：2 个场景 × 3 次
- [ ] 文档与 Quick Start 更新

**交付物：** `run_performance_test` 可用；示例 Skill 缩短为 1 次调用。

**验收：** A2、A3、A8、A9、A10 通过。

### M3.5 — CLI 薄封装（2 人日）

**目标：** 脚本与后续 CI 能直接消费结果。

- [ ] `perfstage init` / `list` / `run` / `report`
- [ ] 退出码 0 / 1 / 2 / 3，支持 `--strict`
- [ ] `--json` 输出与 MCP 工具同构
- [ ] 退出码测试（4 类用例）

**交付物：** `perfstage run <sceneId> --device <udid>` 可用。

**验收：** A11、A12 通过。

### M4 — 回归闭环（4 人日，v1.0，不属于 MVP）

- [ ] run 历史索引（`runs/index.jsonl` 或 SQLite）
- [ ] 基线与两次 Take 对比
- [ ] 回归门禁与趋势
- [ ] `perfstage compare`（基线对比）
- [ ] CI 示例

---

## 6. 任务清单

优先级：P0 = MVP 必须；P1 = MVP 内可延后；P2 = v1.0。

| ID | 任务 | P | 估时 | 依赖 | 验收 |
| --- | --- | --- | --- | --- | --- |
| E0-1 | 配置远程并提交当前工作区 | P0 | 0.5d | — | `git push` 成功 |
| E0-2 | GitHub Actions 构建与测试 | P0 | 0.5d | E0-1 | CI 绿 |
| E0-3 | 真机 `start_profiling` attach 验证 | P0 | 0.5d | — | 产出 trace 与 JSON |
| E0-4 | 录制 mobile/instruments fixtures | P0 | 0.5d | E0-3 | fixture 入库 |
| E0-5 | 验证并发日志采集（独立 client） | P0 | 0.5d | E0-4 | 动作期间日志可落盘 |
| E1-1 | `prepare` 返回完整 plan | P0 | 1d | — | 返回值含 actions/metrics |
| E1-2 | 指标证据校验（值 / trace） | P0 | 1d | — | 缺 trace → partial |
| E1-3 | 阈值 verdict 与 gate | P0 | 1d | — | 三档判定正确 |
| E1-4 | status / gate 语义分离 | P0 | 0.5d | E1-3 | 更新现有测试 |
| E1-5 | 指标标准化模块 | P0 | 0.5d | — | 名称/单位统一 |
| E1-6 | 单测补充 | P0 | 0.5d | E1-1..5 | ≥ 15 个新用例 |
| E1-7 | 抽出共享 `finalizeRun()` | P0 | 0.5d | E1-2 | 工具与 Runner 共用 |
| E2-1 | Skill 模板 | P0 | 0.5d | — | 可直接复制 |
| E2-2 | 示例场景 Skill | P0 | 0.5d | E2-1 | 可执行 |
| E2-3 | 3 次复跑与记录 | P0 | 1d | E2-2 | 报告齐备 |
| E2-4 | DSL 修正 | P0 | 1d | E2-3 | 场景可稳定执行 |
| E2-5 | Skill 文档 | P0 | 0.5d | E2-2 | README 链接 |
| E3-0 | 配置 v2：adapters | P0 | 1d | E0-1 | v1 兼容读取 |
| E3-1 | MCP client 封装 | P0 | 1d | — | 超时/重启/关闭 |
| E3-2 | DeviceDriver 接口 | P0 | 0.5d | — | 类型冻结 |
| E3-3 | mobile-mcp 适配器 | P0 | 1.5d | E3-2 | 动作全部可执行 |
| E3-4 | MetricCollector 接口 | P0 | 0.5d | — | 类型冻结 |
| E3-5 | instruments 适配器 | P0 | 1.5d | E3-4 | 4 指标可采集 |
| E3-6 | 证据适配器 | P0 | 1d | E3-3 | 日志/Crash/生命周期 |
| E3-7 | Runner 编排 | P0 | 1d | E3-3..6 | 全链路可跑 |
| E3-8 | `run_performance_test` | P0 | 1d | E3-7 | 返回契约完整 |
| E3-9 | fake 适配器 + 集成测试 | P0 | 1d | E3-7 | ≥ 15 个新用例 |
| E3-10 | 真机冒烟 | P0 | 1d | E3-8 | 2 场景 × 3 次 |
| E4-1 | 示例项目 2 个场景 | P0 | 1d | E3-10 | 均通过 |
| E4-2 | Quick Start 更新 | P0 | 0.5d | E3-8 | 30 分钟可接入 |
| E4-3 | v0.1 发布 | P0 | 0.5d | 全部 | tag + release notes |
| E4-4 | `perfstage init/list/run/report` | P0 | 1.5d | E3-8 | 4 个子命令可用 |
| E4-5 | 退出码测试与 CLI 文档 | P0 | 0.5d | E4-4 | 4 类退出码用例 |
| E5-1 | 运行历史索引 | P2 | 2d | v0.1 | 可列出历史 |
| E5-2 | 基线对比 | P2 | 2d | E5-1 | 可对比两次 |

合计 P0：约 26 人日（6 周，含缓冲）；P2 另行 4 人日。

---

## 7. 时间线

| 周 | 主要工作 | 演示节点 |
| --- | --- | --- |
| W1 | M0 + M1 前半 | CI 绿；真机 attach 与日志并发结论；缺 trace 时 `partial` |
| W2 | M1 收尾 + M2 | 同一 Skill 连续 3 次；阈值 gate 生效 |
| W3 | M3 前半（client / 适配器） | Runner 跑通一个动作 + 一个指标 |
| W4 | M3 后半（编排 / 工具 / 测试） | 一键执行 2 个场景 |
| W5 | M3.5 CLI + 修复缓冲 | `perfstage run` 退出码正确 |
| W6 | 验收、文档、v0.1 | 一次调用完成；A1–A12 全过 |
| W7 | M4（可选） | 基线对比（`perfstage compare`） |

缓冲：每周预留 0.5 天处理设备与环境问题。

---

## 8. 风险登记

| 风险 | 影响 | 概率 | 缓解 | 触发后 |
| --- | --- | --- | --- | --- |
| 真机 xctrace attach 不稳定 | 高 | 中 | M0 先做 0.5 天验证；准备模拟器路径 | MVP 降级为模拟器 + 真机手动验收 |
| 一次只能录一个模板 | 中 | 高 | 顺序多 pass；报告标注 pass；限制 MVP 为 2–3 指标 | 只保留 hitches + blockMs |
| 文本点击定位不稳 | 高 | 中 | 用元素 ref；失败时报可见元素；不猜坐标 | 场景改用坐标点击（DSL 扩展） |
| instruments JSON 随版本变化 | 中 | 中 | fixture 契约测试；版本检查 | 锁定 xctrace 版本 |
| 日志采集阻塞动作 | 高 | 中 | 独立 mobile-mcp client 异步采集；limit + filter 控制 | 改为动作后采集并标注日志窗口 |
| 日志量过大 | 中 | 中 | 子系统过滤、大小上限、只保留摘要 | 默认关闭全量日志 |
| 范围蔓延（基线/CI） | 高 | 高 | Non-goals 写死；新需求进 M4 | 回到验收标准 |
| 真机测试不稳定 | 中 | 中 | 真机用例不进默认 CI；失败重试 1 次 | 记录为已知限制 |
| 隐私与日志泄漏 | 高 | 低 | 证据只落项目内；报告不输出绝对路径 | 审计报告字段 |

---

## 9. 成功指标

| 指标 | 目标 | 测量方式 |
| --- | --- | --- |
| 接入时间 | ≤ 30 分钟 | 新项目计时 |
| 一键执行成功率 | ≥ 90% | 排除设备离线后的成功/总数 |
| 连续 3 次有效 | 3/3 | 验收记录 |
| 假通过 | 0 | 缺证据用例必须非 `completed` |
| 单次耗时 | ≤ 8 分钟 | p50，15s 场景 + 3 指标 |
| 新增测试 | ≥ 30 | `npm test` 统计 |
| 报告完备度 | 100% | 指标/证据/限制/结论四段齐全 |
| CLI 退出码正确率 | 100% | 4 类退出码用例 |

---

## 10. 已确认的决策与待补信息

### 10.1 已确认

| # | 决策 | 结论 | 对计划的影响 |
| --- | --- | --- | --- |
| 1 | 基线对比 | **不包含**，放 M4 | MVP 保持单次报告 |
| 2 | 多指标顺序多 pass | **接受**，报告标注 pass | 3 指标 = 3 次回放 |
| 3 | 首个验证项目 | 用手头最稳定的真实项目 | 待补具体路径、bundleId、进程名 |
| 4 | 设备优先级 | **真机优先**，模拟器补位 | 卡顿指标以真机为准 |
| 5 | CLI | **纳入 MVP** | +2 人日，MVP 约 26 人日 / 6 周 |

### 10.2 仍待补充

| # | 需要的信息 | 用途 | 何时需要 |
| --- | --- | --- | --- |
| 1 | 验证项目的本地路径 | 在其下初始化 `.performance-test/` | M2 开始前 |
| 2 | App 名称与 bundleId | 配置 `app`、解析进程名 | M2 开始前 |
| 3 | 设备 UDID | 指定真机 | M0 验证时 |
| 4 | 2 个目标场景 | 写 YAML 与 Skill | M2 开始前 |
| 5 | 可接受的阈值 | 配置 `threshold.warn` / `fail` | M1 验收前 |

---

## 11. 本周执行清单

按顺序做，完成一项勾一项：

1. **今天**：补全第 10.2 节的 5 项信息（路径、bundleId、UDID、场景、阈值）。
2. **Day 1**：配置远程、提交当前代码、开 GitHub Actions。
3. **Day 1–2**：真机 `start_profiling` 技术验证，产出第一份 trace 与 JSON。
4. **Day 2–3**：验证独立 client 并发日志采集。
5. **Day 3–5**：完成 E1-2 / E1-3（证据门禁 + 阈值 gate）。
6. **Day 5**：用示例场景跑一次，确认缺 trace 会降级、阈值会出 gate。

做完这 6 项，MVP 的最大不确定性（真机采集 + 证据可信）就被消掉了，后面的 Runner 与 CLI 只是工程实现。

---

## 附录 A：术语

| 术语 | 含义 |
| --- | --- |
| Scene | 一个场景：YAML + Skill |
| Take | 一次完整运行 |
| Encore | 同一 Scene 的再次运行 |
| pass | 一个 Instruments 模板的录制轮次 |
| gate | 阈值门禁结果：`pass` / `warn` / `fail` / `unknown` |
| Runner | 平台内负责执行编排的模块 |
| CLI | 命令行入口 `perfstage`，退出码反映 status 与 gate |

## 附录 B：参考

- [PerfStage 架构图](diagrams/perfstage-architecture.html)
- [PerfStage 流程图](diagrams/perfstage-workflow.html)
- [平台能力复盘](platform-capability-review.md)
- [mobile-mcp 工具列表](https://github.com/mobile-next/mobile-mcp)
- [`../instruments-mcp-server/`](../../instruments-mcp-server/)（本地仓库）
