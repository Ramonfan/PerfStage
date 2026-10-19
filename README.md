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

## 3. 注册到 Claude Code

推荐使用 Claude Code 的命令注册本地 stdio MCP：

```bash
claude mcp add --transport stdio performance-test -- \
  node "/Users/leigod/雷神/性能分析/performance-test-mcp/dist/index.js"
```

检查是否注册成功：

```bash
claude mcp list
```

如果使用项目级配置，也可以在项目的 `.mcp.json` 中配置：

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

## 4. 配置场景和运行目录

默认目录：

```text
scenarios/   # YAML 场景
runs/        # 每次测试的本地证据和报告
```

可以通过环境变量修改：

```bash
export PERFORMANCE_TEST_SCENARIO_DIR="/path/to/scenarios"
export PERFORMANCE_TEST_RUNS_DIR="/path/to/runs"
```

在 Claude Code 注册时传入环境变量：

```bash
claude mcp add --transport stdio performance-test --env \
  PERFORMANCE_TEST_SCENARIO_DIR="/path/to/scenarios" \
  --env PERFORMANCE_TEST_RUNS_DIR="/path/to/runs" -- \
  node "/Users/leigod/雷神/性能分析/performance-test-mcp/dist/index.js"
```

场景目录会在每次调用 `list_performance_scenarios` 时重新读取。修改或新增 YAML 后不需要修改 MCP 代码；重新构建不是必须的，但如果修改了 TypeScript 源码则必须重新执行 `npm run build`。

## 5. 三个 MCP 工具

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

场景文件位于 `scenarios/`，例如：

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

当前项目已有：

- `scenarios/community-home-scroll.yaml`
- `scenarios/message-list-scroll.yaml`

不要把设备 UDID 固定写进长期场景；设备应通过 `prepare_performance_test` 的 `device` 参数传入。

## 7. 测试结果在哪里

每次运行会写入：

```text
runs/<run-id>/
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
find runs -name report.md -type f -print | sort | tail -1
```

查看某次运行：

```bash
less "runs/<run-id>/report.md"
open "runs/<run-id>/report.md"
```

运行目录是本地证据，不是测试管理数据库。确认不再需要某次证据后，可以手动删除对应运行目录。

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

确认场景文件在 `PERFORMANCE_TEST_SCENARIO_DIR` 指定的目录中，并调用 `list_performance_scenarios` 查看当前实际加载结果。

**MCP 工具没有出现**

执行：

```bash
npm run build
claude mcp list
```

然后重启 Claude Code 会话。检查注册命令中的 `dist/index.js` 是否为绝对路径。

**报告显示 `partial` 而不是 `completed`**

先查看 `report.md` 的“稳定性诊断”和“限制与未知项”章节。常见原因是日志/Crash 查询失败、指标缺少 trace、内存压力或其他诊断证据不完整。

**测试过程中新增 Crash**

查看：

```text
runs/<run-id>/crashes/
runs/<run-id>/report.md
runs/<run-id>/report.json
```

报告会列出新增 Crash ID、异常信息和状态降级原因。

**设备日志为空**

必须在执行第一个动作之前启动 `mobile_get_device_logs`。该工具只采集调用开始之后产生的日志。

## 9. 当前边界

- 第一版是本地单用户工具，不包含测试管理平台、数据库、CI 调度、Web 控制台或团队权限；
- 场景不做版本管理，直接修改 YAML 即使用最新定义；
- MCP 不直接调用设备、不启动 xctrace，也不内置 LLM；
- 真实设备集成验收需要在有 `mobile-mcp`、`instruments-mcp-server` 和 iOS 真机的环境中执行；
- 只有经过验证稳定的场景，未来才考虑固化为无人值守执行。

## 10. 相关项目和验证记录

- `../instruments-mcp-server/`：Instruments 采集和解析；
- `mobile-mcp`：设备和 UI 自动化；
- `docs/superpowers/specs/2026-10-17-performance-test-mcp-design.md`：中文设计文档；
- `docs/superpowers/verification/2026-10-17-interactive-run.md`：交互式流程验证记录。
