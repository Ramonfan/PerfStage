# 工作区级性能测试 MCP 设计文档

**日期：** 2026-10-19  
**状态：** 已确认设计，待文档 review
**范围：** 全局安装、本地工作区隔离的 iOS 性能测试 MCP

## 背景

`performance-test-mcp` 以用户级 MCP 的方式安装后，应该可以在任意项目中使用。但性能测试场景、App 配置、运行证据和报告必须属于当前项目，不能因为 MCP 的安装位置而共享或回退读取另一个项目的测试数据。

本设计将 MCP 的“可用范围”和“数据范围”明确分离：

- MCP 程序全局安装，一次安装、所有项目可调用；
- 每个项目单独初始化性能测试工作区；
- 初始化后的场景、配置、日志、Crash 和报告只保存在当前项目的 `.performance-test/` 目录；
- 未初始化的项目不能读取外部场景，也不能执行测试或写入运行证据。

## 目标

1. 保持用户级全局 MCP 注册方式不变。
2. 增加当前项目的显式初始化流程。
3. 保证不同项目之间的场景、配置和运行证据互不读取、互不污染。
4. 为未初始化工作区提供明确、可操作的提示。
5. 保持现有交互式测试流程和三个性能测试工具的行为契约。
6. 为未来无人值守执行保留稳定的工作区配置接口。

## 非目标

- 不建设全局测试管理平台或跨项目场景仓库。
- 不自动把性能测试 MCP 项目自身的 `scenarios/` 目录复制为所有项目的运行时场景源。
- 不做场景版本管理、发布、迁移或跨项目同步。
- 不让一个项目的 MCP 调用读取另一个项目的 `.performance-test/`。
- 不在初始化时覆盖已有配置、场景或运行证据。
- 不改变 `mobile-mcp` 或 `instruments-mcp-server` 的设备操作和采集实现。

## 工作区目录

每个项目的性能测试数据位于当前工作区根目录：

```text
<workspace-root>/
└── .performance-test/
    ├── config.json
    ├── scenarios/
    │   ├── community-home-scroll.yaml
    │   └── ...
    └── runs/
        └── <run-id>/
            ├── run.json
            ├── plan.json
            ├── report.json
            ├── report.md
            ├── device.log
            ├── lifecycle.json
            └── crashes/
```

`.performance-test/` 是项目级本地测试证据目录。是否将它加入项目 Git 由项目自己决定；MCP 不自动执行 Git 操作。

## 工作区根目录识别

第一版使用 MCP 进程启动时的 `process.cwd()` 作为工作区根目录：

```text
workspaceRoot = process.cwd()
configPath = <workspaceRoot>/.performance-test/config.json
scenarioDirectory = <workspaceRoot>/.performance-test/scenarios
runsDirectory = <workspaceRoot>/.performance-test/runs
```

启动入口必须把所有相对目录解析为绝对路径，并将其限制在当前工作区的 `.performance-test/` 下。MCP 不读取安装项目的相对路径，也不使用安装项目作为隐式数据根目录。

如果进程没有有效的工作目录，工具必须返回初始化/工作区错误，而不是回退到 MCP 安装目录或用户主目录。

## 工作区配置

`config.json` 的第一版结构：

```json
{
  "schemaVersion": 1,
  "app": {
    "bundleId": "com.nndev.im",
    "name": "NN"
  },
  "scenarioDirectory": ".performance-test/scenarios",
  "runsDirectory": ".performance-test/runs"
}
```

字段规则：

- `schemaVersion` 必须为 `1`；
- `app.bundleId` 为可选的工作区默认 Bundle ID；
- `app.name` 为可选的人类可读名称；
- `scenarioDirectory` 和 `runsDirectory` 必须是 `.performance-test/` 内的安全相对路径；
- 配置解析失败、版本不支持或路径逃逸时，工具返回结构化错误；
- 不接受绝对路径、`..` 路径或指向工作区外部的符号链接目录。

场景和运行目录由配置提供，但第一版初始化时写入默认相对路径。所有最终路径都必须经过工作区边界校验。

## 初始化工具

新增 MCP 工具：

```text
initialize_performance_workspace
```

输入：

```json
{
  "bundleId": "com.nndev.im",
  "appName": "NN",
  "copyDefaultScenarios": false
}
```

所有字段可选。工具行为：

1. 以 `process.cwd()` 确定工作区根目录。
2. 创建 `.performance-test/`、场景目录和运行目录；目录使用安全权限和递归创建。
3. 如果 `config.json` 不存在，创建 schemaVersion 为 `1` 的配置。
4. 如果配置已存在，先校验配置；不覆盖已有配置。
5. 如果已有配置合法但目录缺失，只补建缺失目录，不修改配置和已有文件。
6. 默认不复制场景模板；只有 `copyDefaultScenarios: true` 时才将内置模板复制到当前工作区，并且只创建不存在的目标文件。
7. 返回工作区根目录、配置路径、场景目录、运行目录、是否首次初始化以及下一步提示。

初始化必须幂等：重复调用不会清空、覆盖或删除已有配置、场景和运行证据。

返回示例：

```json
{
  "initialized": true,
  "firstInitialization": false,
  "workspaceRoot": "/Users/example/project",
  "configPath": ".performance-test/config.json",
  "scenarioDirectory": ".performance-test/scenarios",
  "runsDirectory": ".performance-test/runs",
  "nextSteps": [
    "在 .performance-test/scenarios/ 中添加或编辑 YAML 场景",
    "调用 list_performance_scenarios 查看当前项目场景"
  ]
}
```

## 未初始化工作区行为

除初始化工具外，所有工具在缺少合法 `config.json` 时都不能继续执行：

- `list_performance_scenarios`：返回“当前工作区尚未初始化”的结构化错误和初始化提示；
- `prepare_performance_test`：返回相同提示，不创建 run；
- `finalize_performance_test`：返回相同提示，不创建目录、不复制证据、不修改已有文件。

统一提示：

```text
当前工作区尚未初始化性能测试配置，请先调用 initialize_performance_workspace。
```

如果配置存在但损坏，提示应明确区分“未初始化”和“配置无效”，并给出重新修复或人工检查 `.performance-test/config.json` 的建议。第一版不自动覆盖损坏配置。

## 现有工具的工作区适配

### `list_performance_scenarios`

- 只读取当前工作区配置指定的场景目录；
- 每次调用重新读取目录；
- 场景文件错误必须包含当前项目内的相对路径；
- 不读取安装目录、其他项目或全局模板目录；
- 返回结果增加当前工作区相对目录信息，方便 Claude 确认数据归属。

### `prepare_performance_test`

- 只允许从当前工作区场景目录读取 `scenarioId`；
- `adHocPlan` 仍然支持一次性计划，但保存的 `plan.json` 和运行证据必须进入当前工作区的 runs 目录；
- 运行 ID 不能改变工作区根目录；
- 返回的 `runPath`、`planPath` 只使用当前工作区内的安全相对路径或明确的工作区绝对路径；
- 未初始化时不创建运行目录。

### `finalize_performance_test`

- 只能读取当前工作区准备阶段创建的 run；
- 证据复制目标必须位于当前工作区的 runs 目录；
- 外部 sourcePath 可以作为一次性输入，但不得被写入报告中的可见路径；
- 未初始化、run 不存在、run 已终态或配置无效时，不复制证据、不创建孤立目录、不覆盖已有报告；
- 报告和诊断证据都归属于当前工作区。

## 隔离与安全边界

必须覆盖以下边界：

1. 当前项目 A 不能列出项目 B 的场景。
2. 当前项目 A 不能读取安装项目的场景。
3. 当前项目 A 的报告不能写到项目 B 或 MCP 安装目录。
4. `scenarioDirectory`、`runsDirectory`、run ID、证据相对路径不能通过 `..`、绝对路径或符号链接逃逸。
5. 初始化不能覆盖已有配置和场景。
6. 未初始化的 finalize 不能产生目录或证据文件。
7. 终态 run 不能因为重复 finalize 而改变或追加证据。
8. 配置 JSON 必须经过运行时 schema 校验。

## MCP 注册方式

MCP 以用户级全局方式注册，一次安装、所有项目可用：

```bash
claude mcp add --scope user --transport stdio performance-test -- \
  node "/Users/leigod/雷神/性能分析/performance-test-mcp/dist/index.js"
```

全局注册只决定程序如何被找到，不决定数据目录。数据目录永远由 MCP 当前启动工作区和该工作区的 `.performance-test/config.json` 决定。

## 用户使用流程

在新项目中：

```text
用户：初始化当前项目的性能测试工作区，App Bundle ID 是 com.example.app
Claude：调用 initialize_performance_workspace
Claude：确认当前场景和运行目录属于这个项目
```

初始化后：

```text
用户：列出当前项目的性能测试场景
Claude：调用 list_performance_scenarios

用户：运行 community-home-scroll，测试卡顿和内存
Claude：调用 prepare_performance_test
Claude：继续调用 mobile-mcp 和 instruments-mcp-server
Claude：调用 finalize_performance_test
```

报告位置：

```text
<当前项目>/.performance-test/runs/<run-id>/report.md
```

## 数据迁移与旧目录

旧版本可能使用项目根目录下的 `scenarios/` 和 `runs/`。工作区隔离版本不自动读取或迁移这些目录，避免意外跨项目共享数据。

如果用户需要迁移，应由 Claude 明确提示并在用户确认后，将选定的场景复制到当前项目的 `.performance-test/scenarios/`；第一版初始化工具不自动执行迁移。

## 测试与验收

必须新增以下测试：

- 初始化首次创建配置和目录；
- 初始化重复调用不覆盖已有配置和场景；
- 合法已有配置只补建缺失目录；
- 缺少配置时三个现有工具都返回初始化提示；
- 两个临时工作区加载不同场景，互不串读；
- 场景和 runs 路径始终位于当前工作区；
- 配置绝对路径、`..` 路径和符号链接逃逸被拒绝；
- 未初始化 finalize 不创建目录或复制证据；
- 外部绝对 sourcePath 不出现在 report.json/report.md；
- 已初始化项目的完整 list → prepare → finalize 流程仍然通过；
- MCP smoke test 包含 `initialize_performance_workspace`，并确认总工具数量和名称契约。

真实设备手动验收仍使用现有 `mobile-mcp` 和 `instruments-mcp-server`，但场景和报告必须来自当前测试项目的 `.performance-test/` 目录。

## README 更新要求

README 必须说明：

1. MCP 是用户级全局安装；
2. 每个项目首次使用必须先初始化；
3. `.performance-test/` 的目录结构；
4. 未初始化时不会读取其他项目场景；
5. 初始化命令或自然语言用法；
6. 当前项目报告路径；
7. 场景复制/编辑属于当前项目，不会修改全局模板；
8. `PERFORMANCE_TEST_SCENARIO_DIR` 和 `PERFORMANCE_TEST_RUNS_DIR` 若保留，只能作为显式高级覆盖，并且必须经过工作区边界校验，不能成为默认跨项目回退。

## 版本兼容

工作区配置的 `schemaVersion` 只用于配置格式兼容，不是场景版本管理。第一版只接受 `1`；未知版本返回明确错误，不自动迁移或覆盖。
