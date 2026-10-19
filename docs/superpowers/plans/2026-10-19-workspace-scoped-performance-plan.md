# 工作区级性能测试 MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户级全局性能测试 MCP 在任意项目中使用时，只读取和写入当前工作区的 `.performance-test/` 数据，并通过初始化工具建立项目级性能测试环境。

**Architecture:** 在 MCP 启动时以 `process.cwd()` 为工作区根目录，由 workspace 模块负责发现、校验和初始化 `.performance-test/config.json`。现有场景列表、测试准备、测试完成工具全部通过已解析的工作区上下文访问场景和 runs 目录；未初始化或配置无效时拒绝执行，不回退到 MCP 安装目录、其他项目或用户级全局目录。所有工作区内路径经过边界和符号链接校验。

**Tech Stack:** Node.js >=20、TypeScript、ESM、Zod、Vitest、Node `fs/promises`、MCP SDK。

**Spec:** `docs/superpowers/specs/2026-10-19-workspace-scoped-performance-test-design.md`

## Global Constraints

- MCP 仍然通过 `--scope user` 全局注册，但运行数据永远属于当前 `process.cwd()` 工作区。
- 默认数据根必须是 `<workspace>/.performance-test/`；不得回退读取 MCP 安装目录、其他项目或用户主目录。
- 未初始化、配置损坏、配置版本不支持时，现有测试工具不得创建运行目录、复制证据或写入文件。
- `scenarioDirectory`、`runsDirectory`、run ID 和证据相对路径必须限制在工作区 `.performance-test/` 边界内，并拒绝绝对路径、`..` 和符号链接逃逸。
- 初始化必须幂等，不能覆盖已有配置、场景或运行证据。
- 配置 JSON 必须运行时校验，第一版只接受 `schemaVersion: 1`。
- 不实现跨项目场景仓库、场景版本管理、自动迁移或测试管理平台。
- 现有设备和 Instruments 编排边界不变；本 MCP 不直接执行 mobile-mcp 或 instruments-mcp-server。
- 每个任务独立测试并提交，提交信息包含 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。

---

## 文件结构与职责

- `src/workspace/model.ts`：工作区配置 schema、类型和状态类型。
- `src/workspace/paths.ts`：工作区路径解析、边界检查、符号链接检查。
- `src/workspace/manager.ts`：发现、读取、校验、初始化工作区。
- `src/tools/workspace.ts`：`initialize_performance_workspace` 工具和未初始化错误响应。
- `src/tools/index.ts`：注册初始化工具，并把工作区上下文注入其他工具。
- `src/index.ts`：从 `process.cwd()` 构建工作区上下文，不再使用 MCP 安装目录相对路径。
- `src/tools/scenarios.ts`、`src/tools/plan.ts`、`src/tools/report.ts`：改用 workspace context 的场景和 runs 路径。
- `src/storage/runs.ts`：补充工作区边界和 symlink-safe 目标校验，拒绝未知 run 的目录副作用。
- `src/__tests__/workspace/...`：workspace model/path/manager 测试。
- `src/__tests__/tools/workspace.test.ts`：初始化工具测试。
- `src/__tests__/workspace-isolation.test.ts`：两个临时工作区隔离测试。
- `src/__tests__/mcp-smoke.test.ts`：更新工具列表和初始化工具 smoke test。
- `README.md`：改为全局安装 + 每个项目先初始化的中文使用说明。
- `docs/superpowers/verification/2026-10-17-interactive-run.md`：记录工作区初始化和当前项目证据路径。

---

### Task 1: 建立 Workspace 配置和安全路径模块

**Files:**
- Create: `src/workspace/model.ts`
- Create: `src/workspace/paths.ts`
- Create: `src/__tests__/workspace/model.test.ts`
- Create: `src/__tests__/workspace/paths.test.ts`

**Interfaces:**
- `workspaceConfigSchema: z.ZodType<WorkspaceConfig>`。
- `type WorkspaceConfig = { schemaVersion: 1; app?: { bundleId?: string; name?: string }; scenarioDirectory: string; runsDirectory: string }`。
- `workspaceRootFromCwd(cwd: string): string`。
- `defaultWorkspaceConfig(): WorkspaceConfig`。
- `resolveWorkspacePaths(workspaceRoot: string, config: WorkspaceConfig): WorkspacePaths`。
- `assertWorkspaceRelativePath(workspaceRoot: string, candidate: string, label: string): string`。
- `assertPathInsideWorkspace(path: string, workspaceRoot: string): void`。
- `assertNoSymlinkEscape(root: string, target: string): Promise<void>`。

- [ ] **Step 1: Write failing schema and path tests**

```ts
it("accepts only schemaVersion 1 and workspace-relative directories", () => {
  expect(workspaceConfigSchema.parse({
    schemaVersion: 1,
    scenarioDirectory: ".performance-test/scenarios",
    runsDirectory: ".performance-test/runs",
  }).schemaVersion).toBe(1);
  expect(() => workspaceConfigSchema.parse({
    schemaVersion: 2,
    scenarioDirectory: ".performance-test/scenarios",
    runsDirectory: ".performance-test/runs",
  })).toThrow();
});

it("rejects absolute and parent-escaping paths", () => {
  expect(() => assertWorkspaceRelativePath("/tmp/project", "/tmp/other", "runs")).toThrow();
  expect(() => assertWorkspaceRelativePath("/tmp/project", ".performance-test/../other", "runs")).toThrow();
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- --run src/__tests__/workspace/model.test.ts src/__tests__/workspace/paths.test.ts`
Expected: FAIL because workspace modules do not exist.

- [ ] **Step 3: Implement config schema and safe path resolution**

Use strict Zod objects for config and app fields. `defaultWorkspaceConfig()` returns exactly `schemaVersion: 1`, `.performance-test/scenarios`, and `.performance-test/runs`. Normalize candidate paths with `resolve`, require the normalized result to be inside `<workspaceRoot>/.performance-test`, and reject absolute input, `..` segments, empty paths, and paths outside the allowed root. Do not use `realpath` on nonexistent paths; symlink validation is handled asynchronously in `assertNoSymlinkEscape`.

- [ ] **Step 4: Implement symlink escape checks**

Walk each existing path component from workspace root to target using `lstat`. If any component is a symbolic link, resolve it and require the resolved target to remain inside the workspace’s `.performance-test` root. Permit normal nonexistent final components so initialization can create them, but reject an existing symlink directory pointing elsewhere.

- [ ] **Step 5: Run tests/build and commit**

Run: `npm test -- --run src/__tests__/workspace && npm run build`
Expected: PASS with strict TypeScript.

```bash
git add src/workspace src/__tests__/workspace
git commit -m "feat: add workspace path and config contracts" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: 实现工作区发现、配置读取和幂等初始化

**Files:**
- Create: `src/workspace/manager.ts`
- Create: `src/__tests__/workspace/manager.test.ts`

**Interfaces:**
- `type WorkspaceState = { kind: "uninitialized"; workspaceRoot: string; configPath: string } | { kind: "ready"; workspaceRoot: string; configPath: string; config: WorkspaceConfig; paths: WorkspacePaths } | { kind: "invalid"; workspaceRoot: string; configPath: string; reason: string }`。
- `createWorkspaceManager(workspaceRoot: string): WorkspaceManager`。
- `WorkspaceManager.inspect(): Promise<WorkspaceState>`。
- `WorkspaceManager.initialize(input: InitializeWorkspaceInput): Promise<InitializeWorkspaceResult>`。
- `WorkspaceManager.requireReady(): Promise<ReadyWorkspace>`。
- `InitializeWorkspaceInput = { bundleId?: string; appName?: string; copyDefaultScenarios?: boolean }`。

- [ ] **Step 1: Write failing manager tests**

```ts
it("reports an uninitialized workspace without creating files", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-"));
  const manager = createWorkspaceManager(root);
  expect((await manager.inspect()).kind).toBe("uninitialized");
  await expect(access(join(root, ".performance-test"))).rejects.toThrow();
});

it("initializes idempotently without replacing existing config or scenario", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-"));
  const manager = createWorkspaceManager(root);
  const first = await manager.initialize({ bundleId: "com.example.app", appName: "Example" });
  await writeFile(join(root, ".performance-test/scenarios/custom.yaml"), "id: custom\n");
  const before = await readFile(first.configPath, "utf8");
  const second = await manager.initialize({ bundleId: "com.other.app" });
  expect(await readFile(first.configPath, "utf8")).toBe(before);
  expect(await access(join(root, ".performance-test/scenarios/custom.yaml"))).toBeUndefined();
  expect(second.firstInitialization).toBe(false);
});
```

- [ ] **Step 2: Run manager tests to verify failure**

Run: `npm test -- --run src/__tests__/workspace/manager.test.ts`
Expected: FAIL because manager does not exist.

- [ ] **Step 3: Implement inspect/read/validation**

`inspect()` checks only the current workspace config path. Missing file returns `uninitialized`. Parse JSON, validate with `workspaceConfigSchema`, resolve paths, verify directories and symlink safety; malformed JSON, unsupported schema, invalid paths, or escaping symlinks return `invalid` with an actionable reason. Never look at the package installation directory.

- [ ] **Step 4: Implement idempotent initialization**

Create `.performance-test`, configured scenario directory, and runs directory with `recursive: true` and restrictive directory mode. If config exists, validate it and only create missing directories; never overwrite config or scenario files. If absent, merge optional app values into the default config and atomically write `config.json` with mode `0o600`. When `copyDefaultScenarios` is true, copy embedded template contents only when the destination file does not exist; do not overwrite custom files.

- [ ] **Step 5: Implement `requireReady()` and run tests/build**

`requireReady()` returns the ready context or throws a typed error containing `initialize_performance_workspace` for uninitialized state and the config path/reason for invalid state.

Run: `npm test -- --run src/__tests__/workspace && npm run build`
Expected: PASS.

```bash
git add src/workspace/manager.ts src/__tests__/workspace/manager.test.ts
git commit -m "feat: initialize project performance workspaces" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: 增加初始化 MCP 工具并改造 server context

**Files:**
- Create: `src/tools/workspace.ts`
- Modify: `src/tools/index.ts`
- Modify: `src/index.ts`
- Create: `src/__tests__/tools/workspace.test.ts`
- Modify: `src/__tests__/mcp-smoke.test.ts`

**Interfaces:**
- Tool name exactly `initialize_performance_workspace`.
- `registerTools(server, options)` receives `workspaceManager` and registers initialization plus existing tools.
- Initialization input is the `InitializeWorkspaceInput` schema.
- Existing tools receive a `WorkspaceManager`/ready workspace provider rather than raw global scenario/run paths.

- [ ] **Step 1: Write failing initialization tool and smoke tests**

```ts
it("initializes the current workspace and returns relative paths", async () => {
  const harness = await createWorkspaceToolHarness();
  const result = await harness.call("initialize_performance_workspace", {
    bundleId: "com.example.app",
    appName: "Example",
  });
  expect(result.initialized).toBe(true);
  expect(result.scenarioDirectory).toBe(".performance-test/scenarios");
  expect(result.runsDirectory).toBe(".performance-test/runs");
});

it("lists no scenarios before initialization and tells Claude how to initialize", async () => {
  const harness = await createWorkspaceToolHarness();
  const result = await harness.call("list_performance_scenarios", {});
  expect(result.error).toContain("initialize_performance_workspace");
});
```

Update smoke expectation to include exactly four tools, including `initialize_performance_workspace`.

- [ ] **Step 2: Run tool tests to verify failure**

Run: `npm test -- --run src/__tests__/tools/workspace.test.ts src/__tests__/mcp-smoke.test.ts`
Expected: FAIL because initialization registration and workspace injection do not exist.

- [ ] **Step 3: Implement workspace tool and server startup**

`src/index.ts` constructs `workspaceManager = createWorkspaceManager(process.cwd())`; `createServer()` passes it to tool registration. The direct stdio path uses the same manager and never uses installation-directory-relative paths. The initialization handler returns workspace-relative paths, `firstInitialization`, and next steps. It must not copy templates unless explicitly requested.

- [ ] **Step 4: Implement shared readiness guard**

Add a helper used by existing handlers that converts uninitialized/invalid workspace states to structured tool errors. The helper must run before scenario loading, run creation, evidence copying, or report writing. Keep initialization itself available in either state.

- [ ] **Step 5: Run tests/build and commit**

Run: `npm test -- --run src/__tests__/tools/workspace.test.ts src/__tests__/mcp-smoke.test.ts && npm run build`
Expected: PASS and exactly four registered tools.

```bash
git add src/index.ts src/tools/index.ts src/tools/workspace.ts src/__tests__/tools/workspace.test.ts src/__tests__/mcp-smoke.test.ts
git commit -m "feat: add workspace initialization MCP tool" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: 让场景、prepare、finalize 使用当前工作区

**Files:**
- Modify: `src/tools/scenarios.ts`
- Modify: `src/tools/plan.ts`
- Modify: `src/tools/report.ts`
- Modify: `src/storage/runs.ts`
- Modify: `src/__tests__/tools/scenarios.test.ts`
- Modify: `src/__tests__/tools/plan.test.ts`
- Modify: `src/__tests__/tools/report.test.ts`
- Create: `src/__tests__/workspace-isolation.test.ts`

**Interfaces:**
- Tool registration receives a ready workspace provider; no handler reads package-relative `scenarios` or `runs` defaults.
- `list_performance_scenarios` loads only `workspace.paths.scenarioDirectory`.
- `prepare_performance_test` creates runs only under `workspace.paths.runsDirectory`.
- `finalize_performance_test` validates current workspace readiness and current run ownership before copying evidence or writing reports.

- [ ] **Step 1: Add failing isolation tests**

```ts
it("does not read scenarios from another workspace", async () => {
  const projectA = await createInitializedWorkspace({ scenarioId: "a-only" });
  const projectB = await createInitializedWorkspace({ scenarioId: "b-only" });
  const aResult = await projectA.harness.call("list_performance_scenarios", {});
  const bResult = await projectB.harness.call("list_performance_scenarios", {});
  expect(aResult.scenarios.map((s: { id: string }) => s.id)).toEqual(["a-only"]);
  expect(bResult.scenarios.map((s: { id: string }) => s.id)).toEqual(["b-only"]);
});

it("does not create runs when workspace is uninitialized", async () => {
  const harness = await createWorkspaceToolHarness();
  const result = await harness.call("prepare_performance_test", {
    scenarioId: "anything",
    device: { id: "device-1" },
  });
  expect(result.error).toContain("initialize_performance_workspace");
  await expect(access(join(harness.root, ".performance-test/runs"))).rejects.toThrow();
});
```

- [ ] **Step 2: Run isolation tests to verify failure**

Run: `npm test -- --run src/__tests__/workspace-isolation.test.ts src/__tests__/tools`
Expected: FAIL until all handlers use workspace paths.

- [ ] **Step 3: Replace raw path options with workspace context**

Remove default `scenarioDir: "scenarios"`/`runsRoot: "runs"` behavior from production registration. Keep explicit test-only dependency injection possible, but require it to be rooted under the temporary workspace. `list` calls `loadAllScenarios(workspace.paths.scenarioDirectory)`. `prepare` stores `run.json` and `plan.json` below `workspace.paths.runsDirectory`. `finalize` reads the run from that same store.

- [ ] **Step 4: Guard finalize before any side effect**

Call `workspaceManager.requireReady()` and validate run existence/terminal status before `copyEvidence`, report generation, or directory creation. Add a workspace-owned run-store method that checks the run path is under the configured runs directory and rejects symlinked components.

- [ ] **Step 5: Harden run storage against symlink escape and unknown-run mkdir**

Before creating or writing a run, require the parent configured runs directory to exist and be inside the workspace. `tryFinalize` must check for `run.json` before `mkdir`; unknown run IDs must not create an empty directory. Evidence writes must validate every existing path component with `lstat` and reject symlinks that resolve outside the run directory.

- [ ] **Step 6: Preserve metric and diagnostic evidence**

When finalizing, retain metric `tracePath`, `instrument`, and unknown passthrough fields. Persist only safe run-relative evidence paths in reports. Missing diagnostics must remain unavailable/partial rather than clean. Add regression tests for cross-workspace paths, absolute path omission, unknown metrics, and missing diagnostics.

- [ ] **Step 7: Run full tests/build and commit**

Run: `npm test && npm run build && git diff --check`
Expected: all tests pass and no path can escape the current workspace.

```bash
git add src/tools src/storage src/__tests__/tools src/__tests__/workspace-isolation.test.ts
git commit -m "feat: isolate performance runs per workspace" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: 更新 README、验证记录和全量验收

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/verification/2026-10-17-interactive-run.md`
- Create: `src/__tests__/e2e/workspace-contract.test.ts`

**Interfaces:**
- README documents user-scope installation followed by per-project initialization.
- Offline contract covers initialize → list → prepare → finalize in a temporary project.
- Manual device integration remains explicitly pending unless a suitable device is available.

- [ ] **Step 1: Write failing workspace contract test**

```ts
it("initializes and runs entirely inside the current project", async () => {
  const project = await createInitializedWorkspace({ scenarioId: "community-home-scroll" });
  const initialized = await project.harness.call("initialize_performance_workspace", {});
  const listed = await project.harness.call("list_performance_scenarios", {});
  const prepared = await project.harness.call("prepare_performance_test", {
    scenarioId: "community-home-scroll",
    device: { id: "device-1" },
  });
  expect(initialized.scenarioDirectory).toBe(".performance-test/scenarios");
  expect(listed.scenarios).toHaveLength(1);
  expect(prepared.runPath).toContain(".performance-test/runs/");
});
```

- [ ] **Step 2: Implement README and verification note**

Document:

```bash
claude mcp add --scope user --transport stdio performance-test -- \
  node "/Users/leigod/雷神/性能分析/performance-test-mcp/dist/index.js"
```

Then document:

```text
进入任意项目
→ 初始化当前项目的性能测试工作区
→ MCP 创建 .performance-test/
→ 在当前项目编辑 .performance-test/scenarios/
→ 报告写入当前项目 .performance-test/runs/
```

Explicitly state that uninitialized projects never read another project’s scenarios.

- [ ] **Step 3: Run complete verification**

Run:

```bash
npm test
npm run build
git diff --check
```

Expected: all tests pass, build succeeds, and the workspace contract is green.

- [ ] **Step 4: Commit documentation and final contract**

```bash
git add README.md docs/superpowers/verification/2026-10-17-interactive-run.md src/__tests__/e2e/workspace-contract.test.ts
git commit -m "docs: document workspace-scoped performance testing" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Self-Review Checklist

- [x] Design requirements map to tasks: config/path safety (Task 1), initialization (Tasks 2–3), existing tool isolation (Task 4), docs and contract (Task 5).
- [x] The plan explicitly prevents fallback to the MCP installation project or global scenarios.
- [x] Initialization is idempotent and refuses to overwrite existing user data.
- [x] Uninitialized tools are guarded before all side effects.
- [x] Symlink traversal and unknown-run directory side effects have explicit tests/tasks.
- [x] Existing metric, diagnostic, status, and evidence contracts are preserved or strengthened.
- [x] No device MCP client or LLM is added.
- [x] No placeholders or unresolved design decisions remain.
