# 性能测试 MCP 设计文档

**日期：** 2026-10-17  
**状态：** 已确认，准备进入实现计划  
**范围：** 本地、单用户 iOS 性能测试编排

## 目标

提供一个本地 MCP：它可以接收一个当前场景，或者接收 Claude 根据自然语言整理出的临时结构化测试请求，生成统一的测试计划；由 Claude 编排 `mobile-mcp` 和 `instruments-mcp-server` 完成设备操作与性能采集；最后生成聚焦的 JSON/Markdown 报告，支持卡顿、CPU、内存等指标。

第一版定位为个人使用的性能测试助手，不建设测试管理平台。

## 明确不做的事情

- 不做场景版本管理、迁移、发布或历史管理。
- 不做 CI 调度、Web 控制台、团队权限、多用户存储或数据库。
- 不替代 `mobile-mcp` 的设备自动化实现。
- 不复制 `instruments-mcp-server` 的采集和解析器代码。
- 新 MCP 内部不调用 LLM 做自然语言解析；由 Claude 提供结构化测试计划。
- 不因为本项目修改业务 App 源码。

## 用户使用模型

有两个相互独立的维度：

1. **测试来源：** 当前 YAML 场景，或者 Claude 根据自然语言生成的一次性临时结构化测试计划。
2. **执行方式：** 交互式执行，或者未来对稳定场景采用无人值守执行。

两种来源都统一转换为 `TestPlan`；两种执行方式都共享 `TestRun`、动作时间记录、指标记录和报告生成逻辑。

## 整体架构

```text
Claude
  ├── mobile-mcp                 （设备和 UI 操作）
  ├── instruments-mcp-server     （xctrace、trace 导出、指标解析）
  └── performance-test-mcp       （测试计划、运行状态、证据、报告）
```

第一版采用 Claude 编排方式。新 MCP 在第一版不实现 MCP Client，也不直接启动另外两个 MCP。等某个场景验证稳定后，再考虑增加无人值守动作执行器；增加执行器时，不改变测试计划和报告契约。

## 项目目录

```text
performance-test-mcp/
├── package.json
├── tsconfig.json
├── README.md
├── scenarios/
│   ├── community-home-scroll.yaml
│   └── message-list-scroll.yaml
├── runs/                         # 本地测试证据，不是数据库
├── docs/superpowers/specs/
└── src/
    ├── index.ts
    ├── model/{test-plan,test-run}.ts
    ├── scenario/{loader,parser}.ts
    ├── tools/{scenarios,plan,report}.ts
    └── reports/{markdown,json}.ts
```

## 场景格式

每个 YAML 文件代表当前场景。直接修改文件即可影响下一次运行，不维护历史场景身份，也不做场景版本迁移。

场景包含：

- `id`、`name`
- App Bundle ID，以及启动和等待稳定的设置
- 前置条件：前台 App、accessibility 元素匹配等
- 预热动作
- 动作列表：`tap`、`swipe`、`wait`、`wait_for`
- 默认指标：`hitches`、`cpu`、`memory`
- 可选的评估阈值

加载器负责校验必填字段，并把默认值展开为统一的 `TestPlan`。对于未知或格式错误的动作类型必须直接报错，不能静默跳过。

## MCP 工具

### `list_performance_scenarios`

列出当前 YAML 场景及其 App、指标摘要。

### `prepare_performance_test`

接收结构化场景来源或临时测试计划、设备、执行方式、指标覆盖项和分析重点。它负责校验测试计划、创建 `run_id`、记录调用方提供的设备/App 上下文，并返回 Claude 下一步需要执行的动作。第一版不执行设备操作。

### `finalize_performance_test`

接收 `run_id`、动作记录、指标 trace 路径或结果，以及测试完成状态。它负责保存本地运行证据、归一化指标结果，并输出聚焦的 JSON 和 Markdown 报告。必须保留 `invalid`、`partial`、`failed` 等状态，不能把缺少证据的测试转换成 PASS。

## 数据契约

`TestPlan` 包含：

- 来源：`scenario` 或 `ad_hoc`
- App：Bundle ID 和可选的启动路径
- 设备选择器
- 执行方式：`interactive` 或 `unattended`
- 前置条件
- 带稳定 ID 的动作，以及方向、距离、持续时间、等待稳定时间等字段
- 指标请求
- 分析重点字符串
- 重复次数
- 诊断设置：是否采集设备日志、日志过滤器、是否做 Crash 差集，以及可选的生命周期采样设置

`TestRun` 包含：

- `run_id`、开始/结束时间、状态：`prepared`、`running`、`completed`、`partial`、`invalid`、`failed`、`cancelled`
- 已解析的设备上下文（如果已知）
- App/build 上下文（如果已知）
- 测试计划摘要
- 实际动作记录，包括开始、结束和稳定时间
- 录制证据和指标摘要
- 设备日志、Crash 和 App 生命周期诊断证据
- 报告路径

每次运行会保存当次实际使用的结构化测试计划和动作。这是运行证据，不是场景版本管理。

## 指标边界

`performance-test-mcp` 消费 `instruments-mcp-server` 提供的结果和 trace 路径，不复制 xctrace 或解析器代码。第一版报告适配器理解卡顿、CPU 和内存结果结构，同时保留未知指标的数据，以便以后扩展。

报告需要区分：

- 拖拽/动作区间
- 惯性减速/等待稳定区间（如果动作时间戳足够）
- 动作结束后的区间
- 无法归属阶段的区间

如果时间戳或指标数据不足，报告必须写 `unknown`，不能推断具体原因。

## 运行诊断与稳定性证据

性能指标不能替代稳定性诊断。每次测试默认同时采集设备日志和 Crash 差异，用来判断一次异常到底是卡顿、App 崩溃、系统终止、内存压力还是设备/测试流程失败。

### 设备日志

通过 `mobile-mcp` 的 `mobile_get_device_logs` 在测试开始前启动日志采集，覆盖 App 启动、前置条件、动作执行和测试结束阶段。支持按进程、级别、标签和消息过滤，保存原始日志文件，并在报告中提取：

- Error/Fault
- watchdog
- memory warning
- jetsam/memory pressure
- UIKit/Core Animation
- React Native/JavaScriptCore
- 网络或图片加载错误

日志采集必须在测试动作开始前启动，因为该接口只捕获调用开始之后产生的日志。

### Crash 检测

测试开始前调用 `mobile_list_crashes` 记录已有 Crash ID；测试结束后再次调用并计算新增 ID。对新增 Crash 调用 `mobile_get_crash`，保存完整报告并提取进程、时间、异常类型、终止原因、崩溃线程和关键调用栈。

新增 Crash 的时间必须和动作时间轴、trace 时间轴关联。测试期间发生 Crash 时，运行结果不能标记为普通 PASS；应标记为 `failed` 或 `partial`，并明确说明性能数据可能被崩溃截断。

### App 生命周期与系统终止

运行期间记录前台 App 状态变化，识别 App 是否退出、回到 SpringBoard、出现系统弹窗或设备断连。日志中发现 jetsam/memory pressure 但没有传统 Crash report 时，应报告为系统终止/内存压力，而不是“无 Crash”。

### 诊断结果结构

```json
{
  "diagnostics": {
    "device_logs": {
      "status": "completed",
      "path": "device.log",
      "entries": 428,
      "filters": ["process=NN", "level=Error"]
    },
    "crashes": {
      "status": "completed",
      "before": [],
      "after": ["crash-001"],
      "new": ["crash-001"],
      "reports": [{
        "id": "crash-001",
        "path": "crashes/crash-001.txt",
        "process": "NN",
        "timestamp": "2026-10-17T17:20:12+08:00",
        "exception_type": "EXC_BAD_ACCESS"
      }]
    },
    "app_lifecycle": []
  }
}
```

诊断可以由测试请求关闭或调整过滤范围，但默认开启。

## 错误处理

- 前置条件失败 → 状态为 `invalid`，记录原因和可选的截图/accessibility 证据。
- trace 缺失或为空 → 对应指标失败或测试 `invalid`，不能当作“零卡顿”通过。
- 部分指标成功、部分指标失败 → 状态为 `partial`。
- 设备断连、App 崩溃或录制失败 → 状态为 `failed`，并保留已经产生的证据路径。
- 新增 Crash、watchdog 终止或确认的 jetsam/system termination → 至少状态为 `partial`；如果测试主流程因此中断，则状态为 `failed`。
- 设备日志采集失败、Crash 列表无法读取或生命周期证据不完整 → 保留性能结果，但将诊断状态标为 `unavailable`，不能声称“未发生崩溃”。
- 诊断证据与性能证据互相矛盾时，分别报告事实，不自动推断根因。
- 第一版不包含卸载、删除数据、清空缓存等破坏性操作。

## 存储

- `run.json`
- `report.md`
- 动作记录
- 在调用方提供时保存或引用 trace 路径
- `device.log`（如果开启设备日志采集）
- `crashes/<crash-id>.txt`（每个测试后新增的 Crash report）
- `lifecycle.json`（App 前后台、退出、SpringBoard、弹窗和设备断连事件）
- 可选的截图/accessibility dump

运行目录只是可删除的本地测试证据，不是数据库。

## 实施阶段

1. 添加项目 package/tooling 和领域模型。
2. 添加 YAML 场景读取、校验和场景列表工具。
3. 添加测试计划准备和运行状态持久化。
4. 添加测试完成处理以及 JSON/Markdown 报告。
5. 添加第一批当前场景。
6. 使用现有 MCP 手动跑通 Claude 编排的交互式流程。
7. 只有在某个场景稳定后，才考虑增加无人值守动作执行器；第一版不预先实现平台化能力。

## 验证方式

- 为 YAML 校验、默认值展开和错误测试计划编写单元测试。
- 为运行状态转换和证据目录编写单元测试。
- 为报告阶段划分、缺失指标和部分指标失败编写单元测试。
- 为设备日志过滤、日志文件保存和诊断不可用状态编写单元测试。
- 为测试前后 Crash 列表差集、新增 Crash report 保存和 Crash 时间关联编写单元测试。
- 为 jetsam/memory warning/watchdog 等无传统 Crash report 的稳定性事件编写单元测试。
- 为 App 崩溃、系统终止和诊断不完整时的 `failed`、`partial`、`unavailable` 状态编写单元测试。
- 编写 MCP 协议 smoke test，覆盖三个工具。
- 使用 `community-home-scroll` 进行一次手动集成测试，联动现有 `mobile-mcp` 和 `instruments-mcp-server`，不修改 NN 业务代码。
