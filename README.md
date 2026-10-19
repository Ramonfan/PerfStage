# 性能测试 MCP

本项目是一个本地、单用户使用的 iOS 性能测试编排 MCP。它负责读取 YAML 场景、生成测试计划、保存运行证据并生成报告；设备操作和 Instruments 采集仍由 Claude 编排 `mobile-mcp` 与 `instruments-mcp-server` 完成。

当前已支持交互式测试流程，适合直接告诉 Claude：

- 跑哪个性能场景；
- 在 App 中执行什么交互；
- 采集卡顿、CPU、内存等哪些指标；
- 重点分析哪些问题；
- 测试结束后查看 JSON/Markdown 报告。

无人值守执行暂不自动调度，等场景稳定后再扩展。

## 1. 环境要求

- macOS
- Node.js 20 或更高版本
- 已配置可用的 `mobile-mcp`
- 已配置可用的 `instruments-mcp-server`
- 真机性能采集建议使用真实 iOS 设备；`Animation Hitches` 不支持模拟器

本项目本身不会启动或实现另外两个 MCP，也不会修改被测 App 源码。

## 2. 安装、测试和构建

在项目目录执行：

```bash
cd "/Users/leigod/雷神/性能分析/performance-test-mcp"
npm install
npm test
npm run build
```

构建成功后，MCP 入口文件是：

```text
dist/index.js
```

直接启动 stdio MCP：

```bash
npm start
```

正常情况下，标准输出只用于 MCP 协议通信；不要把调试日志写到 stdout。

## 3. 注册到 Claude Code（用户级一次性安装）

性能测试 MCP 以**用户级**方式注册到 Claude Code，一次安装，所有项目复用同一个入口二进制；但**每一个项目的 `.performance-test/` 数据目录都必须独立初始化**：

```bash
claude mcp add --scope user --transport stdio performance-test -- \
  node "/Users/leigod/雷神/性能分析/performance-test-mcp/dist/index.js"
```

检查是否注册成功：

```bash
claude mcp list
```

`--scope user` 让所有目录下的 Claude Code 会话都能找到这个 MCP；它**不会**让 MCP 共享数据目录或场景文件。每个项目仍然需要单独调用 `initialize_performance_workspace`，否则 MCP 只会读取它启动时所在工作目录的 `.performance-test/config.json`，找不到时返回「请先初始化」的结构化错误。

如果只想在单个项目里临时使用，也可以使用项目级配置（仍然需要逐项目初始化）：

```json
{
  "mcpServers": {
    "performance-test": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/Users/leigod/雷神/性能分析/performance-test-mcp/dist/index.js"
      ]
    }
  }
}
```

首次注册或修改代码后，重新构建：

```bash
npm run build
```

然后重启 Claude Code 会话，让 MCP 重新加载。

## 4. 每个项目独立初始化工作区

由于 MCP 在用户级注册，但每个被测项目需要自己的场景和运行证据目录，**进入新项目时第一步**是初始化当前项目的工作区。

工作流：

```text
进入任意项目
→ 初始化当前项目的性能测试工作区
→ MCP 创建 .performance-test/
→ 在当前项目编辑 .performance-test/scenarios/
→ 报告写入当前项目 .performance-test/runs/
```

初始化调用：

```json
{
  "bundleId": "com.nndev.im",
  "appName": "NN IM",
  "copyDefaultScenarios": false
}
```

- `bundleId` 和 `appName` 可选；不传则写入只含默认目录的配置。
- `copyDefaultScenarios` 默认 `false`，避免覆盖用户已有的场景文件；首次试用可设 `true` 让 MCP 植入 `community-home-scroll` 与 `message-list-scroll` 模板。
- 初始化是**幂等**的：再次调用只会重新校验现有配置，不会覆盖 `config.json` 或场景文件。

调用成功后 MCP 会返回：

```text
性能工作区已就绪。请按下列顺序继续：
1. 工作区根：/path/to/your/project
2. 场景目录（相对于工作区）：.performance-test/scenarios
3. 运行目录（相对于工作区）：.performance-test/runs
4. 调用 list_performance_scenarios …
5. 调用 prepare_performance_test …
6. 完成动作/指标/诊断采集后，调用 finalize_performance_test …
```

之后 `list_performance_scenarios` / `prepare_performance_test` / `finalize_performance_test` 都只读写当前项目的 `.performance-test/`。**未初始化的项目永远不会读取其他项目的场景**；MCP 不会回退到安装目录、全局模板目录或上一次会话所在项目的配置。

如果 MCP 启动时所在目录尚未初始化，会返回：

```text
当前工作区尚未初始化性能测试配置，请先调用 initialize_performance_workspace。
```

如果配置损坏，会提示具体的 `config.json` 路径和校验失败字段，**不会**自动覆盖——避免误删用户数据。

## 5. 三个核心 MCP 工具（运行流程）

### `list_performance_scenarios`

列出当前场景，不需要参数。返回：

- 场景 ID 和名称；
- App Bundle ID；
- 动作数量；
- 指标名称；
- 诊断默认配置。

### `prepare_performance_test`

准备一次测试但不直接操作设备。必须在 `scenarioId` 和 `adHocPlan` 中选择一个，不能同时传入。

已有场景：

```json
{
  "scenarioId": "community-home-scroll",
  "device": {
    "id": "00008150-001E49E40128C01C",
    "name": "Ra iPhone"
  },
  "execution": "interactive",
  "analysisFocus": ["jank", "memory"]
}
```

返回 `runId`、已解析的计划、运行目录和 `nextSteps`。Claude 应按 `nextSteps` 顺序继续执行：

1. 启动 `mobile_get_device_logs`；
2. 调用 `mobile_list_crashes` 保存测试前 Crash 列表；
3. 使用 `mobile-mcp` 执行场景动作；
4. 使用 `instruments-mcp-server` 采集请求的指标；
5. 采集测试后的日志、Crash 列表、Crash report、生命周期和其他证据；
6. 调用 `finalize_performance_test`。

一次性临时计划：

```json
{
  "adHocPlan": {
    "source": "ad_hoc",
    "id": "one-shot-community-scroll",
    "name": "临时社区滚动测试",
    "app": {
      "bundleId": "com.nndev.im"
    },
    "device": {
      "id": "00008150-001E49E40128C01C"
    },
    "actions": [
      {
        "id": "scroll-up",
        "type": "swipe",
        "direction": "up",
        "distance": 700,
        "durationMs": 500,
        "waitAfterMs": 1500
      },
      {
        "id": "scroll-down",
        "type": "swipe",
        "direction": "down",
        "distance": 700,
        "durationMs": 500,
        "waitAfterMs": 1500
      }
    ],
    "metrics": [
      {
        "name": "hitches",
        "instrument": "Animation Hitches"
      },
      {
        "name": "cpu",
        "instrument": "Time Profiler"
      },
      {
        "name": "memory",
        "instrument": "Allocations"
      }
    ],
    "analysisFocus": ["jank", "memory"],
    "execution": "interactive"
  },
  "device": {
    "id": "00008150-001E49E40128C01C"
  }
}
```

临时计划不会自动保存为长期场景。需要长期复用时，应把它整理成 `scenarios/*.yaml`。

### `finalize_performance_test`

提交动作、指标和诊断证据，生成最终报告。典型结构如下：

```json
{
  "runId": "2026-10-17T03-00-00.000Z-example",
  "requestedStatus": "completed",
  "actions": [
    {
      "actionId": "scroll-up",
      "outcome": "executed",
      "startedAt": "2026-10-17T03:00:10.000Z",
      "endedAt": "2026-10-17T03:00:11.500Z",
      "durationMs": 1500
    }
  ],
  "metrics": [
    {
      "name": "hitches",
      "value": 3,
      "unit": "frames",
      "verdict": "warn",
      "tracePath": "/tmp/community-hitches.trace"
    },
    {
      "name": "cpu",
      "value": 28.4,
      "unit": "%",
      "verdict": "pass",
      "tracePath": "/tmp/community-cpu.trace"
    },
    {
      "name": "memory",
      "value": 186,
      "unit": "MB",
      "verdict": "pass",
      "tracePath": "/tmp/community-memory.trace"
    }
  ],
  "diagnostics": {
    "logText": "...device log text...",
    "crashIdsBefore": ["old-crash-id"],
    "crashIdsAfter": ["old-crash-id"],
    "crashReports": [],
    "lifecycle": [
      {
        "kind": "foreground",
        "timestamp": "2026-10-17T03:00:00.000Z"
      }
    ]
  },
  "evidencePaths": [
    {
      "kind": "deviceLog",
      "sourcePath": "/tmp/device.log",
      "relativePath": "device.log"
    },
    {
      "kind": "lifecycleTrace",
      "sourcePath": "/tmp/lifecycle.json",
      "relativePath": "lifecycle.json"
    }
  ],
  "notes": "社区首页上下滚动，重点观察减速尾段。"
}
```

注意：

- `sourcePath` 是 Claude 当前拿到的本地证据路径；MCP 会将允许的证据复制到运行目录；
- 报告中的 `evidencePaths` 使用运行目录内的相对路径，不应泄漏外部绝对路径；
- 如果日志、Crash 列表或生命周期采集失败，应填写对应的 `*QueryError`，不能伪造为空结果；
- 测试中出现新增 Crash、watchdog、jetsam 或设备断连时，结果不会被标记为普通成功；
- `requestedStatus` 使用终态：`completed`、`partial`、`failed`、`invalid` 或 `cancelled`。

## 6. 编写 YAML 场景

场景文件位于**当前被测项目**的 `<当前项目>/.performance-test/scenarios/` 下，模板示例：

```yaml
id: community-home-scroll
name: 社区首页来回滚动
app:
  bundleId: com.nndev.im
device: {}
preconditions:
  foregroundBundleId: com.nndev.im
  accessibilityText: 社区
warmup:
  - id: open-community
    type: tap
    target: 社区
    waitAfterMs: 1500
actions:
  - id: scroll-up-1
    type: swipe
    direction: up
    distance: 700
    durationMs: 500
    waitAfterMs: 1500
  - id: scroll-down-1
    type: swipe
    direction: down
    distance: 700
    durationMs: 500
    waitAfterMs: 1500
metrics:
  - name: hitches
    instrument: Animation Hitches
  - name: cpu
    instrument: Time Profiler
  - name: memory
    instrument: Allocations
```

支持的动作类型：

- `tap`：按 accessibility 文本或元素目标点击；
- `swipe`：指定方向、距离、可选持续时间；
- `wait`：等待指定毫秒数；
- `wait_for`：等待元素出现，直到超时。

首次初始化时如果传 `copyDefaultScenarios: true`，MCP 会植入：

- `<当前项目>/.performance-test/scenarios/community-home-scroll.yaml`
- `<当前项目>/.performance-test/scenarios/message-list-scroll.yaml`

不要把设备 UDID 固定写进长期场景；设备应通过 `prepare_performance_test` 的 `device` 参数传入。

## 7. 测试结果在哪里

每次运行都会写入**当前被测项目**下的运行目录（路径在 `prepare_performance_test` 的返回值 `runPath` 里以工作区相对路径形式给出）：

```text
<当前项目>/.performance-test/runs/<run-id>/
├── run.json                 # 实际运行状态、动作、指标和证据引用
├── plan.json                # 本次真正执行的解析后 TestPlan
├── report.json              # 机器可读报告
├── report.md                # 中文 Markdown 报告
├── device.log               # 设备日志证据（如果已保存）
├── lifecycle.json           # 生命周期证据（如果已保存）
└── crashes/
    └── <crash-id>.txt       # 测试期间新增的 Crash report
```

查看最近一次报告：

```bash
find .performance-test/runs -name report.md -type f -print | sort | tail -1
```

查看某次运行：

```bash
less ".performance-test/runs/<run-id>/report.md"
open ".performance-test/runs/<run-id>/report.md"
```

运行目录是本地证据，不是测试管理数据库。确认不再需要某次证据后，可以手动删除对应运行目录。**绝不**会因为在另一个项目里调用 MCP 而把这次运行的报告写到别的项目里——`runPath` 永远是当前项目工作区相对路径。

## 8. 报告状态和常见问题

### `completed`

性能指标和诊断证据均可用，没有发现会降级结果的稳定性问题。

### `partial`

部分指标、日志或诊断证据缺失，或者发现了 warning。报告仍然生成，但不能视为完整成功。

### `failed`

测试流程中断、设备断连、App 崩溃、watchdog、jetsam 或其他失败级别事件导致测试失败。

### `invalid`

前置条件、场景结构、参数或证据格式不合法，测试没有形成有效运行。

### 常见问题

**找不到场景**

确认当前项目已经调用过 `initialize_performance_workspace`，并且场景文件在 `<当前项目>/.performance-test/scenarios/` 下。再次调用 `list_performance_scenarios` 查看当前实际加载结果；如果返回 `请先调用 initialize_performance_workspace` 的结构化错误，则工作区尚未初始化。

**MCP 工具没有出现**

执行：

```bash
npm run build
claude mcp list
```

然后重启 Claude Code 会话。检查注册命令中的 `dist/index.js` 是否为绝对路径。如果只希望在当前目录中临时使用，确认 `.mcp.json`（或 `claude mcp add` 命令）中的 `command` / `args` 配置正确。

**报告显示 `partial` 而不是 `completed`**

先查看 `report.md` 的“稳定性诊断”和“限制与未知项”章节。常见原因是日志/Crash 查询失败、指标缺少 trace、内存压力或其他诊断证据不完整。

**测试过程中新增 Crash**

查看：

```text
<当前项目>/.performance-test/runs/<run-id>/crashes/
<当前项目>/.performance-test/runs/<run-id>/report.md
<当前项目>/.performance-test/runs/<run-id>/report.json
```

报告会列出新增 Crash ID、异常信息和状态降级原因。

**设备日志为空**

必须在执行第一个动作之前启动 `mobile_get_device_logs`。该工具只采集调用开始之后产生的日志。

**在项目 A 中调用 MCP，报告却写到了项目 B**

不应发生。MCP 始终使用**当前工作目录**作为工作区根；如果出现这种现象，请确认：
1. Claude Code 会话是在项目 A 的目录下启动的；
2. 项目 A 已经调用过 `initialize_performance_workspace`，其 `.performance-test/config.json` 存在；
3. 不要使用 `cd` 在多个项目之间切换后复用同一个 Claude 会话——请在不同项目下分别启动新会话。

## 9. 当前边界

- 第一版是本地单用户工具，不包含测试管理平台、数据库、CI 调度、Web 控制台或团队权限；
- 场景不做版本管理，直接修改 YAML 即使用最新定义；
- MCP 不直接调用设备、不启动 xctrace，也不内置 LLM；
- 真实设备集成验收需要在有 `mobile-mcp`、`instruments-mcp-server` 和 iOS 真机的环境中执行；
- 只有经过验证稳定的场景，未来才考虑固化为无人值守执行；
- **MCP 在用户级注册，但每个项目独立持有 `.performance-test/`**：MCP 不会跨项目读取场景、写入运行报告或回退到安装目录/全局目录；任何“另一个项目的场景出现在列表里”或“运行报告写到别的项目”的行为都是 bug，请提交 issue。

## 10. 相关项目和验证记录

- `../instruments-mcp-server/`：Instruments 采集和解析；
- `mobile-mcp`：设备和 UI 自动化；
- `docs/superpowers/specs/2026-10-17-performance-test-mcp-design.md`：中文设计文档；
- `docs/superpowers/verification/2026-10-17-interactive-run.md`：交互式流程验证记录。
