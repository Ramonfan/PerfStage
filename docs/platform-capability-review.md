# 性能测试 MCP — “通用 MCP 能力 + 项目 Skill” 架构复盘（v3）

- **复盘对象：** `performance-test-mcp`
- **目标架构：** iOS-only；MCP 提供平台通用能力；每个项目基于 MCP 定义场景 Skill；后续重复测试执行 Skill 即可
- **复盘日期：** 2026-11-13
- **版本说明：** v1 按“单项目本地助手”评分，v2 按“跨端平台产品”评分，都偏离了实际目标。v3 按“通用能力层 + 项目 Skill 层”重新校准。

---

## 一、目标架构拆解

这个设定是合理的，而且比“做平台产品”聚焦得多。它本质上是三层：

```text
第 3 层：项目 Skill
  每个项目 / 每个场景一个可重复执行的入口
  负责：App 信息、场景选择、设备选择、阈值、基线、输出约定

第 2 层：共享编排 Recipe
  把“准备 → 执行 → 采集 → 收尾”固定成一套可复用流程
  负责：调用 MCP、mobile-mcp、instruments-mcp-server 的顺序与异常处理

第 1 层：通用 MCP 能力
  iOS 性能测试的通用原语
  负责：场景解析、运行状态、动作模型、证据、诊断、报告、工作区隔离
```

**关键判断：当前实现主要完成了第 1 层，第 2、3 层基本没有。**

---

## 二、按这个架构重新评分

| 层 | 完成度 | 说明 |
| --- | ---: | --- |
| 第 1 层：通用 MCP 能力 | **约 75%** | 领域模型、场景、运行存储、诊断、报告、隔离都已落地；缺“一键执行”和证据硬校验 |
| 第 2 层：共享编排 Recipe | **约 10%** | 只有 `nextSteps` 文本，没有可复用的自动编排实现 |
| 第 3 层：项目 Skill | **约 5%** | 没有 Skill 模板、契约、示例，也没有项目侧约定 |
| 重复测试/回归能力 | **约 25%** | 能重复“跑”，但不能自动对比、基线、门禁 |
| **整体（这个架构下）** | **约 45–55%** | 取决于 Skill 是“Thin”还是“Thick”，见下节 |

### 两种 Skill 形态，完成度不同

| 形态 | 含义 | 当前可支撑度 | 评价 |
| --- | --- | ---: | --- |
| **Thick Skill** | Skill 里写清楚每一步：调 `prepare` → Claude 调 mobile-mcp 执行动作 → 调 instruments 采集 → 调 `finalize` | **约 60%** | 现在就能做，但 Skill 很长、依赖 Claude 现场发挥、每次结果可能漂移 |
| **Thin Skill** | Skill 只调用一个高层 MCP 工具，例如 `run_performance_test`，内部自动完成全流程 | **约 40%** | 更符合“执行 Skill 就完成测试”的目标，但需要补执行层 |

**结论：如果“执行 skill”只是让 Claude 按一份长指令去编排，当前 MCP 已经能支撑 60% 左右；如果目标是“执行 skill 就稳定、可重复、少漂移地跑完”，当前还差一个高层执行入口。**

---

## 三、当前实现与目标架构的匹配点

这些设计其实很适合“MCP 通用能力 + 项目 Skill”：

1. **cwd 作为项目边界是合理的。**
   Skill 在项目目录下执行，MCP 用 `process.cwd()` 定位 `.performance-test/`，天然把项目场景和运行证据隔离。这里不需要多租户数据库或项目注册中心。

2. **场景 YAML 是项目侧资产。**
   每个项目在自己的 `.performance-test/scenarios/` 定义场景，符合“项目定义具体场景”的分层。

3. **4 个工具是稳定的底层原语。**
   `initialize / list / prepare / finalize` 可以作为 Skill 的底层契约；Skill 不直接碰文件系统和内部实现。

4. **报告和证据属于项目。**
   运行结果落在项目内，适合项目自己 review、提交或归档。

5. **领域层可复用。**
   TestPlan/TestRun、诊断归一化、状态降级、证据安全都可以成为平台通用内核，不需要因项目不同而复制。

---

## 四、要让“执行 Skill 就完成测试”成立，当前缺什么

### P0：没有 Skill 层

目前仓库里没有：

- Skill 目录结构与模板；
- Skill 的输入/输出契约；
- 一个可复制到新项目的示例；
- Skill 与场景 YAML 的绑定方式；
- Skill 版本与 MCP 版本的兼容约定。

所以现在只能“口述让 Claude 跑”，还没有“可重复执行的 Skill 资产”。

### P0：没有一键执行闭环

当前流程是：

```text
prepare → Claude 手动执行动作 → Claude 手动采集 → finalize
```

这对 Skill 不友好：

- Skill 需要写很长的编排指令；
- 每一步的异常处理都要在 Skill 里重复；
- Skill 的输出依赖 Claude 的现场判断；
- 无法保证每次执行顺序一致；
- 无法直接被 CI 或脚本复用。

目标应该是：

```text
Skill → run_performance_test(scenarioId, device) → 自动完成全流程 → 返回结构化结果
```

### P0：`prepare` 不返回完整解析计划

`prepare_performance_test` 的返回值只有 `runId`、`planId`、`runPath`、`nextSteps` 等（`src/tools/plan.ts:123`），没有 actions/warmup/preconditions/metrics。

Skill 或执行器如果只依赖 MCP 返回值，拿不到要执行什么，只能去读 `plan.json`。这会让 Skill 依赖文件系统细节，不符合“通用能力层”的抽象。

### P0：`finalize` 证据校验不足，重复测试会产生“假通过”

实测：metrics 只传 `name/value`、不带 `tracePath`、不带任何证据文件，最终仍可得到 `completed`。

对“重复测试”来说这是致命的：Skill 每次都说“通过”，但可能根本没有采到 trace。至少应该做到：

- 指标缺 `tracePath` / 缺值 → `partial` 或 `invalid`；
- 声明采集但证据缺失 → 不允许 `completed`；
- `completed` 必须能追溯到每个指标的 trace 或明确的结果来源。

### P1：重复测试没有“对比”能力

“后续重复测试这个场景”通常不只是再跑一次，而是想知道：

- 这次比上次好还是差？
- 是否超过基线？
- 是否触发回归门禁？

当前没有：

- run 历史索引；
- 基线管理；
- 两次 run 的指标对比；
- 趋势；
- 阈值门禁。

只有单次 report.md，无法回答“重复测试”的核心问题。

### P1：阈值不生效

场景里可以写 `threshold.warn/fail`，但代码只透传，不计算 verdict（全仓库无阈值计算逻辑）。Skill 想让“超过 50ms 就 fail”自动生效，目前做不到。

### P1：报告没有阶段归因

设计要求区分动作区间、惯性/等待区间、动作后区间、unknown，但当前 Markdown 没有阶段章节。对定位卡顿有帮助，但不是 Skill 闭环的阻塞项。

### P1：Skill 需要稳定的输出契约

Skill 执行完应该统一返回：

```json
{
  "runId": "...",
  "status": "completed|partial|failed|invalid",
  "metrics": { "hitches": 3, "cpu": 28.4, "memory": 186 },
  "findings": [],
  "reportPath": ".performance-test/runs/<id>/report.md",
  "gate": "pass|fail|unknown"
}
```

当前 `finalize` 的返回值已经接近，但缺少 gate、基线对比和稳定的 Skill 级输出约定。

### P2：运行上下文不完整

重复测试需要知道“这次跑的是哪个 build / 哪个 App 版本 / 哪台设备”。当前 run 里有 device 和 plan，但没有显式的 build 号、App 版本、commit、环境标签。后续做对比时会缺少维度。

---

## 五、推荐的目标契约

### 5.1 项目目录

```text
<project>/
├── .performance-test/
│   ├── config.json
│   ├── scenarios/
│   │   └── community-home-scroll.yaml
│   └── runs/
└── .claude/
    └── skills/
        └── perf-community-scroll/
            └── SKILL.md
```

### 5.2 Skill 的职责（Thin Skill）

Skill 只做四件事：

1. 确认项目和设备；
2. 调用 `run_performance_test`；
3. 读取结构化结果；
4. 输出结论 / 报告路径 / gate。

Skill 不应该重复描述“先调 mobile_get_device_logs，再调 mobile_list_crashes……”这些编排细节。这些属于第 2 层共享 Recipe。

### 5.3 MCP 的职责

MCP 提供：

- 场景资产读取与校验；
- 运行生命周期；
- 动作执行器接口；
- 指标/诊断采集器接口；
- 证据与报告；
- 运行结果查询；
- 基线对比与门禁（可后置）。

### 5.4 建议新增的高层工具

```text
run_performance_test({
  scenarioId: "community-home-scroll",
  device: { id: "..." },
  execution: "unattended",
  baselineId?: "...",
  metricOverrides?: [...],
  analysisFocus?: ["jank", "memory"]
})
```

返回：

```json
{
  "runId": "...",
  "status": "completed",
  "metrics": [...],
  "findings": [...],
  "evidencePaths": [...],
  "reportPath": ".performance-test/runs/<id>/report.md",
  "gate": "pass",
  "baselineComparison": { ... }
}
```

底层的 4 个工具继续保留，作为调试、手动执行和自定义 Skill 的入口。

---

## 六、两条落地路线

### 路线 A：Thick Skill（最快，先验证价值）

不改 MCP 执行架构，先写一个共享 Skill 模板，把现有 4 个工具 + mobile-mcp + instruments 的调用顺序固化。

- 优点：1–2 天可产出；复用现有代码；无需 MCP Client。
- 缺点：Skill 很长；依赖 Claude 执行；结果漂移；难以 CI。
- 适合：先跑通 2–3 个真实场景，验证场景 DSL 和报告是否有用。

### 路线 B：Thin Skill（推荐目标）

在 MCP 内增加 Runner，把 mobile-mcp / instruments-mcp-server 封装成执行器/采集器适配器；Skill 只调用一个高层工具。

- 优点：重复测试稳定；Skill 很短；可扩展到脚本/CI；输出结构化。
- 缺点：需要实现 MCP Client、执行器、采集器、错误处理；工作量更大。
- 适合：确定要长期重复跑同一批场景。

**建议：先 A 后 B。** 用 Thick Skill 快速跑通真实场景，同时把编排逻辑抽成共享代码；验证稳定后升级为 Thin Skill。

---

## 七、按优先级排的下一步

### 立刻做（1 周内）

1. **定义一个 Skill 模板**：目录、输入参数、调用步骤、输出格式。
2. **补 `prepare` 返回完整计划**：至少返回 actions/warmup/metrics，Skill 不需要读 plan.json。
3. **修 `finalize` 证据校验**：缺 trace/缺值不能 `completed`。
4. **写一个真实场景 Skill**：用 `community-home-scroll` 跑 3 次，确认可重复。

### 紧接着做（2–4 周）

5. **实现 `run_performance_test`**：把 prepare → 执行 → 采集 → finalize 收敛成一个高层工具。
6. **建立运行历史与基线**：至少能列出同一场景的历史 run，并对比关键指标。
7. **让阈值生效**：根据 `threshold` 自动计算 `verdict` 和 gate。
8. **补 Skill 输出契约**：status / metrics / findings / reportPath / gate。

### 之后再做

9. 阶段归因（动作/惯性/动作后/unknown）。
10. 指标适配器（hitches/CPU/内存/启动）。
11. 可选的 CI 集成。
12. 可选的并行执行/设备池（iOS-only 场景下优先级不高）。

---

## 八、需要确认的三个点

1. **Skill 由谁执行？**
   - Claude Code Skill（Claude 读指令执行）？
   - 还是项目里的脚本/CI 任务（确定性执行）？
2. **重复测试的核心诉求是什么？**
   - 只是“再跑一次看报告”？
   - 还是“和上次/基线对比，判断是否回归”？
3. **Skill 的粒度？**
   - 一个场景一个 Skill？
   - 还是一个项目一个 Skill，通过参数选择场景？

---

## 九、最终结论

- 你的分层思路是对的：**MCP 做通用能力，项目 Skill 做具体场景**。
- 当前 MCP 作为“通用能力层”完成度约 **75%**；作为“执行 Skill 即可完成测试”的整体，完成度约 **45–55%**。
- 最缺的不是跨端、平台化、数据库，而是：
  1. **Skill 模板与契约**；
  2. **一键执行闭环**；
  3. **证据硬校验**；
  4. **重复测试的对比与门禁**。

先把这四件事补齐，这个“MCP + Skill”模型就能真正跑起来。
