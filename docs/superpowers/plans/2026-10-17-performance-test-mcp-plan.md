# 性能测试 MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现一个本地单用户 iOS 性能测试 MCP，读取当前 YAML 场景或接收一次性结构化计划，准备 Claude 编排所需的测试动作，并保存性能、设备日志、Crash、生命周期证据及 JSON/Markdown 报告。

**Architecture:** MCP 服务器只负责计划校验、运行状态、证据落盘、诊断归一化和报告生成，不直接实现设备驱动、xctrace 或 LLM。`prepare_performance_test` 创建运行目录和 Claude 下一步要执行的动作；Claude 继续调用 `mobile-mcp` 与 `instruments-mcp-server`；`finalize_performance_test` 接收动作、性能结果和诊断证据，统一计算最终状态并生成报告。领域模型、场景解析、诊断和报告均保持纯函数或显式文件系统边界，便于单元测试和以后加入无人值守执行器。

**Tech Stack:** Node.js >= 20、TypeScript、ESM、`@modelcontextprotocol/sdk`、`zod`、`yaml`、Vitest。

**Spec:** `docs/superpowers/specs/2026-10-17-performance-test-mcp-design.md`

## Global Constraints

- 第一版只支持本地、单用户使用；`runs/` 是可删除的运行证据，不是数据库。
- 不实现 MCP Client，不直接启动 `mobile-mcp` 或 `instruments-mcp-server`，不复制它们的设备驱动、xctrace 或解析器。
- 不在本项目修改 NN 业务代码；不实现卸载 App、删除数据或清空缓存等破坏性操作。
- 场景不做版本管理、发布、迁移或历史维护；直接修改 YAML 即影响下一次运行。
- 测试来源必须统一为 `scenario` 或 `ad_hoc` 的 `TestPlan`；执行方式必须为 `interactive` 或 `unattended`。
- 缺少 trace、指标或诊断证据时不得静默转换为 PASS，也不得把“无法读取 Crash”表述成“未发生 Crash”。
- 新增 Crash、watchdog 或确认的 jetsam/system termination 至少得到 `partial`；若主流程因此中断则为 `failed`。
- 所有外部输入使用 Zod 或等价的运行时校验；未知动作类型和未知状态直接报错。
- 每个任务完成后运行该任务列出的测试，并单独提交一个小而完整的 commit。

---

## 文件结构与职责

实现完成后的主要文件边界如下：

- `package.json`、`tsconfig.json`、`vitest.config.ts`：Node/TypeScript/测试工具配置。
- `src/model/test-plan.ts`：动作、指标、诊断配置和 `TestPlan` 的 Zod schema、TypeScript 类型及默认值。
- `src/model/test-run.ts`：运行状态、动作记录、指标结果、诊断证据和 `TestRun` 的 schema/type，以及状态转换规则。
- `src/scenario/parser.ts`：将已解析 YAML 值校验并展开为 `TestPlan`；不负责读文件。
- `src/scenario/loader.ts`：发现场景 YAML、读取 YAML、调用 parser；不负责运行持久化。
- `src/storage/runs.ts`：创建运行目录、写入和读取 `run.json`、动作/诊断证据文件；只负责文件系统。
- `src/diagnostics/normalize.ts`：归一化日志、Crash 列表/报告和生命周期输入，并计算稳定性影响。
- `src/reports/json.ts`：生成可序列化的完整 JSON 报告对象。
- `src/reports/markdown.ts`：将报告对象渲染为中文 Markdown。
- `src/tools/scenarios.ts`：`list_performance_scenarios` 工具。
- `src/tools/plan.ts`：`prepare_performance_test` 工具。
- `src/tools/report.ts`：`finalize_performance_test` 工具。
- `src/index.ts`：MCP server 创建、工具注册和 stdio 启动。
- `scenarios/community-home-scroll.yaml`、`scenarios/message-list-scroll.yaml`：第一批当前场景。
- `src/__tests__/...`：按领域边界组织单元测试；`src/__tests__/mcp-smoke.test.ts` 覆盖工具注册和调用。

---

### Task 1: 初始化 TypeScript MCP 工程

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/index.ts`
- Create: `src/__tests__/bootstrap.test.ts`
- Modify: `README.md`

**Interfaces:**
- Produces an executable `npm run build` output under `dist/` and a test command `npm test`.
- Produces `createServer()` in `src/index.ts`, returning an MCP `Server` with no tools initially, so later tasks can register tools without changing process startup.

- [ ] **Step 1: Write the failing bootstrap test**

```ts
import { describe, expect, it } from "vitest";
import { createServer } from "../index.js";

describe("MCP bootstrap", () => {
  it("creates a server with the expected name", () => {
    const server = createServer();
    expect(server).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test to verify the project is not configured yet**

Run: `npm test -- --run src/__tests__/bootstrap.test.ts`
Expected: FAIL because the package and source entry point do not exist.

- [ ] **Step 3: Add package metadata and dependencies**

Use scripts with explicit ESM behavior:

```json
{
  "name": "performance-test-mcp",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "latest",
    "yaml": "latest",
    "zod": "latest"
  },
  "devDependencies": {
    "@types/node": "latest",
    "typescript": "latest",
    "vitest": "latest"
  }
}
```

Pin resolved versions in the generated lockfile; do not add a database, CLI argument framework, or HTTP server dependency.

- [ ] **Step 4: Add TypeScript and Vitest configuration**

`tsconfig.json` must use `target: "ES2022"`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `rootDir: "src"`, `outDir: "dist"`, `strict: true`, `noEmitOnError: true`, and `esModuleInterop: true`. Configure Vitest to run `src/**/*.test.ts` without requiring a DOM environment.

- [ ] **Step 5: Add the minimal server factory and stdio entry point**

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export function createServer(): Server {
  return new Server(
    { name: "performance-test-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
```

- [ ] **Step 6: Run the bootstrap test and build**

Run: `npm test -- --run src/__tests__/bootstrap.test.ts && npm run build`
Expected: PASS and a clean TypeScript build.

- [ ] **Step 7: Update README and commit**

Document local setup (`npm install`, `npm test`, `npm run build`) and state that device operations remain Claude-orchestrated. Commit:

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src/index.ts src/__tests__/bootstrap.test.ts README.md
git commit -m "chore: initialize performance test MCP" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: 建立 TestPlan 和 TestRun 领域契约

**Files:**
- Create: `src/model/test-plan.ts`
- Create: `src/model/test-run.ts`
- Create: `src/__tests__/model/test-plan.test.ts`
- Create: `src/__tests__/model/test-run.test.ts`

**Interfaces:**
- `TestPlan`, `TestAction`, `MetricRequest`, `DiagnosticSettings` are exported inferred TypeScript types.
- `testPlanSchema.parse(input)` returns a fully defaulted `TestPlan`.
- `testRunSchema.parse(input)` returns a `TestRun`.
- `transitionRunStatus(current, next): RunStatus` rejects illegal transitions.

- [ ] **Step 1: Write failing schema and transition tests**

```ts
import { describe, expect, it } from "vitest";
import { testPlanSchema } from "../../model/test-plan.js";

it("expands default metrics and diagnostics", () => {
  const plan = testPlanSchema.parse({
    source: "ad_hoc",
    app: { bundleId: "com.example.app" },
    device: { id: "device-1" },
    actions: [{ id: "scroll-1", type: "swipe", direction: "up", distance: 500 }],
  });
  expect(plan.metrics.map((metric) => metric.name)).toEqual(["hitches", "cpu", "memory"]);
  expect(plan.diagnostics.collectDeviceLogs).toBe(true);
  expect(plan.diagnostics.collectCrashes).toBe(true);
});

it("rejects an unknown action type", () => {
  expect(() => testPlanSchema.parse({
    source: "ad_hoc",
    app: { bundleId: "com.example.app" },
    device: { id: "device-1" },
    actions: [{ id: "bad", type: "pinch" }],
  })).toThrow();
});
```

```ts
import { describe, expect, it } from "vitest";
import { transitionRunStatus } from "../../model/test-run.js";

it("allows prepared -> running -> completed", () => {
  expect(transitionRunStatus("prepared", "running")).toBe("running");
  expect(transitionRunStatus("running", "completed")).toBe("completed");
});

it("rejects completed -> running", () => {
  expect(() => transitionRunStatus("completed", "running")).toThrow(/completed/);
});
```

- [ ] **Step 2: Run the focused tests to verify failure**

Run: `npm test -- --run src/__tests__/model`
Expected: FAIL because the model modules are absent.

- [ ] **Step 3: Implement `test-plan.ts`**

Define these exact discriminated unions:

```ts
export const actionSchema = z.discriminatedUnion("type", [
  z.object({ id: z.string().min(1), type: z.literal("tap"), target: z.string().min(1), waitAfterMs: z.number().int().nonnegative().default(500) }),
  z.object({ id: z.string().min(1), type: z.literal("swipe"), direction: z.enum(["up", "down", "left", "right"]), distance: z.number().positive(), durationMs: z.number().int().positive().optional(), waitAfterMs: z.number().int().nonnegative().default(1000) }),
  z.object({ id: z.string().min(1), type: z.literal("wait"), durationMs: z.number().int().nonnegative() }),
  z.object({ id: z.string().min(1), type: z.literal("wait_for"), target: z.string().min(1), timeoutMs: z.number().int().positive().default(10000) }),
]);
```

Add `source`, optional `id/name`, `app.bundleId`, optional `app.launchUrl`, `device.id/name`, `execution`, `preconditions`, `warmup`, `metrics`, `analysisFocus`, `repetitions`, and `diagnostics`. Defaults must be: `execution: "interactive"`, metrics `hitches/cpu/memory`, `repetitions: 1`, `diagnostics.collectDeviceLogs: true`, `diagnostics.collectCrashes: true`, `diagnostics.lifecycleSampling: true`, and empty filters.

A metric request contains `name: string`, optional `instrument: string`, optional `tracePath`, optional `result: unknown`, and optional threshold object. Preserve unknown metric names for forward compatibility.

- [ ] **Step 4: Implement `test-run.ts` and legal transitions**

Define statuses exactly as specified: `prepared`, `running`, `completed`, `partial`, `invalid`, `failed`, `cancelled`. Define `ActionRecord`, `MetricResult`, `DiagnosticEvidence`, `AppLifecycleEvent`, and `TestRun` with nullable end times and optional evidence paths. Legal transitions are `prepared -> running|invalid|cancelled`, `running -> completed|partial|failed|cancelled`, and terminal states have no outgoing transitions.

- [ ] **Step 5: Run focused tests and full typecheck**

Run: `npm test -- --run src/__tests__/model && npm run build`
Expected: PASS with strict TypeScript enabled.

- [ ] **Step 6: Commit the domain contract**

```bash
git add src/model src/__tests__/model
git commit -m "feat: define performance test domain contracts" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: 实现场景 YAML 读取、校验和两个当前场景

**Files:**
- Create: `src/scenario/parser.ts`
- Create: `src/scenario/loader.ts`
- Create: `scenarios/community-home-scroll.yaml`
- Create: `scenarios/message-list-scroll.yaml`
- Create: `src/__tests__/scenario/parser.test.ts`
- Create: `src/__tests__/scenario/loader.test.ts`

**Interfaces:**
- `parseScenarioDocument(document: unknown): TestPlan` validates and expands one YAML document.
- `loadScenario(filePath: string): Promise<TestPlan>` reads one YAML file.
- `listScenarioFiles(directory: string): Promise<string[]>` returns sorted `.yaml`/`.yml` files.
- `loadAllScenarios(directory: string): Promise<TestPlan[]>` loads all files and reports filename context on errors.

- [ ] **Step 1: Write parser tests for defaults, invalid values, and action preservation**

```ts
import { expect, it } from "vitest";
import { parseScenarioDocument } from "../../scenario/parser.js";

it("converts a scenario document into a current TestPlan", () => {
  const plan = parseScenarioDocument({
    id: "community-home-scroll",
    name: "社区首页滚动",
    app: { bundleId: "com.nndev.im" },
    device: { name: "Ra iPhone" },
    preconditions: { foregroundBundleId: "com.nndev.im", accessibilityText: "社区" },
    warmup: [{ id: "open-community", type: "tap", target: "社区" }],
    actions: [{ id: "scroll-up", type: "swipe", direction: "up", distance: 700, durationMs: 500 }],
  });
  expect(plan.id).toBe("community-home-scroll");
  expect(plan.warmup[0]?.type).toBe("tap");
  expect(plan.actions[0]?.type).toBe("swipe");
});

it("fails with the source field when the YAML action is invalid", () => {
  expect(() => parseScenarioDocument({
    id: "bad",
    app: { bundleId: "com.nndev.im" },
    actions: [{ id: "x", type: "unknown" }],
  })).toThrow();
});
```

- [ ] **Step 2: Run the parser tests and verify failure**

Run: `npm test -- --run src/__tests__/scenario/parser.test.ts`
Expected: FAIL because scenario modules do not exist.

- [ ] **Step 3: Implement parser and loader**

Use `parseDocument` from `yaml` in `loadScenario`, pass the resulting plain value to `parseScenarioDocument`, and add the file path to any thrown `ZodError` message. The loader must ignore no files silently: unreadable files and malformed YAML reject the operation. Sort paths lexicographically for deterministic scenario listing.

- [ ] **Step 4: Add concrete scenario YAML**

`community-home-scroll.yaml` must contain:

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

Create `message-list-scroll.yaml` with the same schema, `id: message-list-scroll`, a message-tab precondition, and equivalent up/down actions. Do not encode device-specific UDIDs in either scenario.

- [ ] **Step 5: Run scenario tests and build**

Run: `npm test -- --run src/__tests__/scenario && npm run build`
Expected: PASS; both example files load and all malformed inputs fail with actionable errors.

- [ ] **Step 6: Commit scenario support**

```bash
git add src/scenario scenarios src/__tests__/scenario
git commit -m "feat: add YAML performance scenarios" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: 实现运行目录、状态持久化和证据保存

**Files:**
- Create: `src/storage/runs.ts`
- Create: `src/__tests__/storage/runs.test.ts`

**Interfaces:**
- `createRunStore(rootDir: string): RunStore` returns:
  - `create(run: TestRun): Promise<string>`
  - `read(runId: string): Promise<TestRun>`
  - `write(run: TestRun): Promise<void>`
  - `writeText(runId: string, relativePath: string, content: string): Promise<string>`
  - `copyEvidence(runId: string, sourcePath: string, relativePath: string): Promise<string>`
  - `runDirectory(runId: string): string`
- All relative paths are normalized and rejected if they escape the run directory.

- [ ] **Step 1: Write failing storage tests**

```ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createRunStore } from "../../storage/runs.js";

it("creates a run directory and round-trips run.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "performance-mcp-"));
  const store = createRunStore(root);
  const run = { runId: "run-1", status: "prepared", startedAt: "2026-10-17T00:00:00.000Z" } as const;
  await store.create(run);
  expect((await store.read("run-1")).runId).toBe("run-1");
  expect(await readFile(join(root, "run-1", "run.json"), "utf8")).toContain("prepared");
});

it("rejects evidence paths outside the run directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "performance-mcp-"));
  const store = createRunStore(root);
  await expect(store.writeText("run-1", "../escape.txt", "x")).rejects.toThrow();
});
```

- [ ] **Step 2: Run storage tests to verify failure**

Run: `npm test -- --run src/__tests__/storage/runs.test.ts`
Expected: FAIL because the storage module does not exist.

- [ ] **Step 3: Implement safe run storage**

Use `mkdir(..., { recursive: true })`, UTF-8 JSON with two-space indentation, and atomic replacement for `run.json` via a temporary file in the same directory followed by `rename`. `copyEvidence` must copy bytes without interpreting the input. Store all paths returned to callers as POSIX-style paths relative to the run directory.

- [ ] **Step 4: Add deterministic run IDs and initial run creation helper**

Add `newRunId(now = new Date()): string` returning `<UTC timestamp>-<random suffix>` and ensure path-safe characters only. The tool layer will pass the generated ID into `TestRun`; storage itself must not silently overwrite an existing run.

- [ ] **Step 5: Run storage tests and build**

Run: `npm test -- --run src/__tests__/storage && npm run build`
Expected: PASS, including traversal rejection and JSON round-trip.

- [ ] **Step 6: Commit storage**

```bash
git add src/storage src/__tests__/storage
git commit -m "feat: persist performance test run evidence" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: 实现日志、Crash、生命周期诊断归一化

**Files:**
- Create: `src/diagnostics/normalize.ts`
- Create: `src/__tests__/diagnostics/normalize.test.ts`

**Interfaces:**
- `normalizeDiagnostics(input: DiagnosticInput, startedAt: string, endedAt: string): DiagnosticEvidence`.
- `diffCrashIds(before: string[], after: string[]): string[]` returns sorted IDs present only after the run.
- `classifyDiagnosticImpact(evidence: DiagnosticEvidence): { severity: "none" | "warning" | "failure"; reasons: string[] }`.
- `DiagnosticInput` accepts optional raw log text, log path, log filters, before/after Crash IDs, Crash reports, lifecycle events, and explicit collection errors.

- [ ] **Step 1: Write failing diagnostic tests**

```ts
import { describe, expect, it } from "vitest";
import { classifyDiagnosticImpact, diffCrashIds, normalizeDiagnostics } from "../../diagnostics/normalize.js";

it("finds only crashes created during the run", () => {
  expect(diffCrashIds(["old", "same"], ["same", "new"])).toEqual(["new"]);
});

it("detects jetsam and watchdog without requiring a Crash report", () => {
  const evidence = normalizeDiagnostics({
    logText: "memorystatus: jetsam killing process NN\nwatchdog timeout",
    crashIdsBefore: [],
    crashIdsAfter: [],
    lifecycle: [],
  }, "2026-10-17T00:00:00.000Z", "2026-10-17T00:01:00.000Z");
  const impact = classifyDiagnosticImpact(evidence);
  expect(impact.severity).toBe("failure");
  expect(impact.reasons).toEqual(expect.arrayContaining(["jetsam", "watchdog"]));
});

it("makes an incomplete Crash query unavailable rather than clean", () => {
  const evidence = normalizeDiagnostics({ crashQueryError: "device disconnected" }, "2026-10-17T00:00:00.000Z", "2026-10-17T00:01:00.000Z");
  expect(evidence.crashes.status).toBe("unavailable");
  expect(classifyDiagnosticImpact(evidence).reasons).toContain("crash-detection-unavailable");
});
```

- [ ] **Step 2: Run diagnostic tests to verify failure**

Run: `npm test -- --run src/__tests__/diagnostics/normalize.test.ts`
Expected: FAIL because diagnostic modules do not exist.

- [ ] **Step 3: Implement log extraction and Crash diffing**

Preserve the raw log path/text and count lines. Extract case-insensitive evidence categories using bounded regular expressions: `Error|Fault`, `watchdog`, `memory warning|memory pressure`, `jetsam`, `UIKit|Core Animation`, `React Native|JavaScriptCore`, and `image|network|URL loading`. Do not claim a category absent if logs were unavailable. Normalize Crash reports to `{ id, path?, process?, timestamp?, exceptionType?, terminationReason?, crashedThread?, keyStack? }` and record `before`, `after`, and `new` IDs.

- [ ] **Step 4: Implement lifecycle and impact classification**

Keep lifecycle events as timestamped facts with `kind` limited to `foreground`, `background`, `app_exit`, `springboard`, `system_alert`, and `device_disconnect`. Mark diagnostics `unavailable` when a requested collection failed. Return `failure` for new Crash, watchdog, jetsam, or device disconnect; `warning` for memory warning or unavailable evidence; otherwise `none`.

- [ ] **Step 5: Run tests and build**

Run: `npm test -- --run src/__tests__/diagnostics && npm run build`
Expected: PASS and no diagnostic parser claims a missing log source is clean.

- [ ] **Step 6: Commit diagnostic normalization**

```bash
git add src/diagnostics src/__tests__/diagnostics
git commit -m "feat: normalize stability diagnostics" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: 生成 JSON/Markdown 报告并统一最终状态

**Files:**
- Create: `src/reports/json.ts`
- Create: `src/reports/markdown.ts`
- Create: `src/reports/status.ts`
- Create: `src/__tests__/reports/status.test.ts`
- Create: `src/__tests__/reports/markdown.test.ts`

**Interfaces:**
- `buildJsonReport(run: TestRun, diagnostics: DiagnosticEvidence): JsonReport`.
- `renderMarkdownReport(report: JsonReport): string`.
- `deriveFinalStatus(input: { requestedStatus: RunStatus; diagnosticsImpact: DiagnosticImpact; missingEvidence: string[]; metricFailures: string[] }): RunStatus`.

- [ ] **Step 1: Write failing status and report tests**

```ts
import { expect, it } from "vitest";
import { deriveFinalStatus } from "../../reports/status.js";

it("does not return completed when a new Crash exists", () => {
  expect(deriveFinalStatus({
    requestedStatus: "completed",
    diagnosticsImpact: { severity: "failure", reasons: ["new-crash"] },
    missingEvidence: [],
    metricFailures: [],
  })).toBe("failed");
});

it("returns partial when metrics are present but diagnostics are unavailable", () => {
  expect(deriveFinalStatus({
    requestedStatus: "completed",
    diagnosticsImpact: { severity: "warning", reasons: ["crash-detection-unavailable"] },
    missingEvidence: [],
    metricFailures: [],
  })).toBe("partial");
});
```

- [ ] **Step 2: Run report tests to verify failure**

Run: `npm test -- --run src/__tests__/reports`
Expected: FAIL because report modules do not exist.

- [ ] **Step 3: Implement final status precedence**

Use this precedence: explicit `invalid`/`cancelled` remains unchanged; `failure` impact or requested `failed` becomes `failed`; missing required trace/metric evidence or metric failures becomes `partial` unless the main flow was interrupted, then `failed`; warning/unavailable diagnostics becomes `partial`; only a completed run with no missing evidence, metric failures, or diagnostic impact becomes `completed`.

- [ ] **Step 4: Implement JSON report shape**

Include `run`, `plan`, `actions`, `metrics`, `diagnostics`, `findings`, `status`, `evidencePaths`, and `generatedAt`. Preserve unknown metric result payloads under `metrics[].raw`. Represent missing phase timestamps as `"unknown"` in rendered output, not as guessed durations.

- [ ] **Step 5: Implement Chinese Markdown report**

Render sections in this order: 总结、测试计划、动作时间线、性能指标、稳定性诊断、证据文件、限制与未知项. The stability section must separately list logs, Crash diff, lifecycle events, extracted categories, and whether the result was downgraded from completed. Use explicit phrases such as `未能读取 Crash 列表，不能据此证明没有崩溃` when evidence is unavailable.

- [ ] **Step 6: Run report tests and build**

Run: `npm test -- --run src/__tests__/reports && npm run build`
Expected: PASS; reports distinguish drag, deceleration/wait, post-action, and unknown phases when timestamps exist, and use `unknown` otherwise.

- [ ] **Step 7: Commit reporting**

```bash
git add src/reports src/__tests__/reports
git commit -m "feat: generate performance test reports" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: 实现三个 MCP 工具并接入 server

**Files:**
- Create: `src/tools/scenarios.ts`
- Create: `src/tools/plan.ts`
- Create: `src/tools/report.ts`
- Modify: `src/index.ts`
- Create: `src/__tests__/tools/scenarios.test.ts`
- Create: `src/__tests__/tools/plan.test.ts`
- Create: `src/__tests__/tools/report.test.ts`
- Create: `src/__tests__/mcp-smoke.test.ts`

**Interfaces:**
- Tool names are exactly `list_performance_scenarios`, `prepare_performance_test`, and `finalize_performance_test`.
- `registerTools(server, options)` registers all three tools; `options` contains `scenarioDir`, `runStore`, `now`, and optional `runsRoot`.
- `prepare_performance_test` accepts either `{ scenarioId, device, execution?, metricOverrides?, analysisFocus?, diagnosticOverrides? }` or `{ adHocPlan, device, execution?, ... }`, never both sources.
- `finalize_performance_test` accepts `{ runId, requestedStatus, actions, metrics, diagnostics, evidencePaths?, notes? }` and returns final status, JSON report path, Markdown report path, and concise report summary.

- [ ] **Step 1: Write failing tool behavior tests**

```ts
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createTestToolHarness } from "../support/tool-harness.js";

it("prepare creates a run and returns Claude-executable next steps", async () => {
  const root = await mkdtemp(join(tmpdir(), "performance-mcp-"));
  const harness = await createTestToolHarness(root);
  const result = await harness.call("prepare_performance_test", {
    scenarioId: "community-home-scroll",
    device: { id: "device-1", name: "Ra iPhone" },
  });
  expect(result.runId).toEqual(expect.any(String));
  expect(result.nextSteps).toEqual(expect.arrayContaining([
    expect.stringContaining("mobile_get_device_logs"),
    expect.stringContaining("mobile_list_crashes"),
  ]));
});
```

Add tests that reject both/neither source, reject unknown scenario IDs, preserve metric overrides, and make `finalize` downgrade a requested completed result when diagnostics contain a new Crash.

- [ ] **Step 2: Run tool tests to verify failure**

Run: `npm test -- --run src/__tests__/tools src/__tests__/mcp-smoke.test.ts`
Expected: FAIL because tool registration and harness do not exist.

- [ ] **Step 3: Add a test-only MCP tool harness**

Create `src/__tests__/support/tool-harness.ts` that uses the same registered handler functions as production, with a temporary scenario directory and run store. Keep it in test code; do not introduce a second production protocol implementation.

- [ ] **Step 4: Implement `list_performance_scenarios`**

Load all current YAML files on every call, return sorted entries containing `id`, `name`, `bundleId`, action count, metric names, and diagnostic defaults. A malformed scenario returns an MCP tool error with its path; it must not be silently omitted.

- [ ] **Step 5: Implement `prepare_performance_test`**

Validate exactly one source. Load a scenario or parse the supplied ad-hoc plan, apply device/execution/metric/analysis/diagnostic overrides through the model schema, create `prepared` `TestRun`, persist the resolved plan and context, and return action instructions in order. The instructions must explicitly tell Claude to start `mobile_get_device_logs` before actions, snapshot `mobile_list_crashes` before actions, execute `mobile-mcp` actions, run requested Instruments tools, and collect final diagnostics before calling finalize. No device operation occurs inside this tool.

- [ ] **Step 6: Implement `finalize_performance_test`**

Read and validate the prepared run, persist action records, copy or reference supplied evidence, call `normalizeDiagnostics`, call `deriveFinalStatus`, write `run.json`, `report.json`, and `report.md`, and return paths relative to the run directory plus summary findings. If the run ID is missing or terminal, return a structured tool error without overwriting evidence.

- [ ] **Step 7: Register tools and expose stdio server**

Update `createServer()` to call `registerTools`. Use the SDK's current tool registration API consistently for all three tools; schemas must be derived from the same Zod contracts used by the handlers. Ensure stdout contains only MCP protocol traffic; diagnostics go to stderr or files.

- [ ] **Step 8: Run tool tests, smoke tests, and build**

Run: `npm test && npm run build`
Expected: all unit tests pass, smoke test discovers exactly the three named tools, and the built server starts without importing device-specific code.

- [ ] **Step 9: Commit MCP tools**

```bash
git add src/tools src/index.ts src/__tests__/tools src/__tests__/support src/__tests__/mcp-smoke.test.ts
git commit -m "feat: expose performance test MCP tools" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 8: 完成 README、手动交互流程和全量验收

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-10-17-performance-test-mcp-design.md` only if implementation contract wording needs correction
- Create: `docs/superpowers/verification/2026-10-17-interactive-run.md`
- Create: `src/__tests__/e2e/interactive-contract.test.ts`

**Interfaces:**
- The documented workflow must match the actual tool input/output names and run directory layout.
- The verification note records commands, selected device, scenario, evidence paths, and any limitation without changing NN source.

- [ ] **Step 1: Write the offline interactive-contract test**

Use a fixture run to assert the full sequence: list scenarios → prepare community scenario → supply action/metric/diagnostic evidence → finalize → read `report.md` and `report.json`. Assert that `device.log`, `lifecycle.json`, and each new Crash file are referenced when supplied.

- [ ] **Step 2: Run the contract test to verify any missing integration**

Run: `npm test -- --run src/__tests__/e2e/interactive-contract.test.ts`
Expected: FAIL if any earlier tool/storage/report contract is inconsistent; fix the smallest responsible module before proceeding.

- [ ] **Step 3: Document real Claude orchestration commands**

README must show this exact sequence conceptually:

```text
list_performance_scenarios
prepare_performance_test({ scenarioId: "community-home-scroll", device: { id: "..." } })
# Claude calls mobile_get_device_logs and mobile_list_crashes before actions.
# Claude performs the returned mobile-mcp actions and requested Instruments calls.
# Claude collects final logs/crashes/lifecycle and supplies their paths/results.
finalize_performance_test({ runId: "...", ... })
```

Document `npm install`, `npm test`, `npm run build`, scenario editing, `runs/<run-id>/`, and the fact that interactive mode is implemented before unattended execution.

- [ ] **Step 4: Run all verification commands**

Run:

```bash
npm test
npm run build
git diff --check
git status --short
```

Expected: all tests pass, build succeeds, diff check is clean, and only intentional documentation or implementation changes remain.

- [ ] **Step 5: Perform the manual integration test**

With `mobile-mcp` and `instruments-mcp-server` already available, use `community-home-scroll` on an available local device. Before actions, call `mobile_get_device_logs`, `mobile_list_crashes`, and record the foreground App. Execute only the declared taps/swipes/waits; run hitches, CPU, and memory collection through `instruments-mcp-server`; after actions, collect logs, Crash list, new Crash reports, lifecycle state, and any screenshots/accessibility evidence. Do not alter NN source or install experimental probes.

- [ ] **Step 6: Write the verification note and commit**

Record the actual result, report paths, whether diagnostics were complete, and known limits (for example, device-specific xctrace limitations). Commit:

```bash
git add README.md docs/superpowers/verification src/__tests__/e2e
 git commit -m "docs: verify interactive performance test workflow" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Self-Review Checklist

- [x] Every requirement in the design is assigned to at least one task: YAML loading (Task 3), plan/run contracts (Task 2), three MCP tools (Task 7), local evidence (Task 4), hitches/CPU/memory pass-through (Tasks 2 and 6), logs/Crash/lifecycle diagnostics (Task 5), status/error handling (Tasks 5–7), JSON/Markdown reports (Task 6), smoke and integration validation (Tasks 7–8), future unattended compatibility (Tasks 2 and 7).
- [x] No task asks the implementer to call mobile-mcp or Instruments from inside this MCP; only the manual acceptance step uses the existing external MCPs.
- [x] No placeholders such as `TBD`, `TODO`, or “implement later” remain in the plan.
- [x] All cross-task names are explicit: `TestPlan`, `TestRun`, `normalizeDiagnostics`, `deriveFinalStatus`, `createRunStore`, `registerTools`, and report functions.
- [x] Diagnostic failures cannot be mistaken for a clean run, and terminal run state is protected from overwrite.
