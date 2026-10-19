# Interactive Performance Test — Verification Note

> **Status as of 2026-10-19, suite green: 20 files / 161 tests passed.**
> Workspace-scoped performance testing added on top of the 2026-10-17
> interactive baseline. The workspace contract is exercised offline; the
> manual device step remains **explicitly pending**.

This note records the offline verification of the `performance-test-mcp`
implementation. It does **NOT** record a manual end-to-end run against
`mobile-mcp` + `instruments-mcp-server`; that step remains **explicitly
pending** and is the responsibility of the Task 8 acceptance operator
who has the iOS device available.

## What was verified locally

- **Domain contracts** (`src/model/test-plan.ts`, `src/model/test-run.ts`,
  `src/diagnostics/normalize.ts`, `src/reports/{status,json,markdown}.ts`):
  schema validation, status transitions, diagnostic classification,
  report shape, Markdown rendering with stability section heading
  `### 日志`.
- **Scenario loader** (`src/scenario/loader.ts`): sorted `.yaml`/`.yml`
  enumeration, malformed-YAML error path surface.
- **Run store** (`src/storage/runs.ts`): atomic-exclusive `create()`
  via `open(path, "wx")`, atomic-CAS `tryFinalize()` with an
  exclusive per-run lock, **stale lock recovery** (locks older than 5
  minutes are removed and the call is retried once). The `RUN_FILE_NAME`
  constant is exported so the tool layer can build workspace-relative
  paths without re-hardcoding `"run.json"`.
- **Workspace manager** (`src/workspace/manager.ts`, `paths.ts`,
  `model.ts`): `.performance-test/` directory + `config.json`
  bootstrap, idempotent re-initialization that never overwrites an
  existing config, symlink-escape guards on the scenario/runs
  directories, and a strict `WorkspaceConfig` Zod schema.
- **Workspace readiness guard** (`src/tools/index.ts`): every
  side-effecting handler (list / prepare / finalize) runs the
  readiness guard before touching the filesystem. Uninitialized and
  invalid states return a structured `initialize_performance_workspace`
  hint instead of creating directories or evidence files.
- **Workspace-relative paths in tool results**
  (`src/tools/{plan,path-utils}.ts`): `prepare_performance_test` and
  `finalize_performance_test` return `runPath` as a workspace-relative
  POSIX path (`.performance-test/runs/<runId>/run.json`) when the
  workspace manager is in use, and fall back to the run-relative
  `"run.json"` for legacy harnesses that bootstrap without a
  workspace.
- **MCP tools** (`src/tools/{scenarios,plan,report,workspace,index}.ts`):
  `initialize_performance_workspace`, `list_performance_scenarios`,
  `prepare_performance_test`, `finalize_performance_test` registered
  via `McpServer.registerTool` with Zod-derived schemas. Output:
  - `initialize` tool result exposes `scenarioDirectory` /
    `runsDirectory` as **workspace-relative** paths so Claude can
    confirm the data belongs to the current project;
  - `finalize` tool result exposes `evidencePaths` as
    `ReportEvidencePath[]` (callable via `.map(...)`);
  - `report.json` keeps `evidencePaths` as a **map** keyed by kind
    with `deviceLog`/`crashReport`/etc. as run-relative strings;
  - **Safe-path contract:** absolute paths supplied through
    `diagnostics.logPath` or `evidencePaths[].sourcePath` never
    appear in either `report.json` or `report.md`. The diagnostics
    `logs.path` is also stripped when it is non-run-relative, so the
    sanitizer is consistent across the run state, the JSON report,
    and the Markdown report.
- **Workspace e2e contract**
  (`src/__tests__/e2e/workspace-contract.test.ts`): an offline
  end-to-end exercise of `initialize_performance_workspace` →
  `list_performance_scenarios` → `prepare_performance_test` against a
  freshly-created temporary project. Asserts:
  - `initialize` returns `scenarioDirectory: ".performance-test/scenarios"`,
    proving the runtime never falls back to package-relative or global
    paths;
  - `list` returns exactly the scenario seeded into the **current**
    project's scenario directory, with a parallel cross-project case
    confirming that project A cannot read project B's scenarios;
  - `prepare` writes `runPath` under the current project's
    `.performance-test/runs/`, never under the MCP installation root
    or another project.
- **Status precedence** (`src/reports/status.ts`):
  `invalid`/`cancelled` preserved; diagnostic `failure` impact →
  `failed`; missing evidence or metric failure → `partial`
  (`failed` when interrupted); warning impact → `partial`;
  `completed` only when fully clean.
- **Restricted enums:** `TestPlan.source` ∈ `{"ad_hoc","scenario"}`,
  `executionMode` ∈ `{"interactive","unattended"}`. Unsupported
  values are rejected by the tool layer rather than silently
  rewritten.
- **Diagnostic classification** (`classifyDiagnosticImpact`):
  `device_disconnect` + `app_exit` → `failure`;
  `springboard` + `system_alert` → `warning`;
  missing log/crash/lifecycle evidence → `unavailable` (no silent
  PASS).

## User-scope install + per-project init (documented in README)

The README now documents the production install/usage flow end-to-end:

```bash
# One-time: register at user scope so every Claude session can find it.
claude mcp add --scope user --transport stdio performance-test -- \
  node "/Users/leigod/雷神/性能分析/performance-test-mcp/dist/index.js"
```

```text
# Then, in each project Claude works in:
cd /path/to/project
# Ask Claude: "初始化当前项目的性能测试工作区"
# → MCP creates .performance-test/ in the current project
# → Edit scenarios in <project>/.performance-test/scenarios/
# → Reports land in <project>/.performance-test/runs/
```

Uninitialized projects never read another project's scenarios, and the
workspace e2e contract locks that invariant in offline tests.

## Explicitly pending — manual device integration

The interactive flow was **not** exercised against `mobile-mcp` and
`instruments-mcp-server` in this session. The first commit, the
two follow-up fix waves, the canonical-harness refactor, and the
workspace-scoped plan were all exercised through the in-process test
harnesses (`src/__tests__/support/tool-harness.ts` and
`workspace-tool-harness.ts`).

The verification that requires:
- a live iOS device (so the `community-home-scroll` actions touch
  real hardware, not a harness),
- `mobile-mcp` + `mobile_get_device_logs` + `mobile_list_crashes`
  returning real data,
- `instruments-mcp-server` collecting Animation Hitches / Time
  Profiler / Allocations traces,

**remains the responsibility of Task 8.** This note intentionally does
not claim it has been performed.

## Test counts and surfaces

| Surface                                   | Files | Tests |
| ----------------------------------------- | ----: | ----: |
| Domain (model + diagnostics)              |     3 |        |
| Reports                                   |     2 |        |
| Storage (run store)                       |     1 |        |
| Tools (harness-driven handlers)           |     4 |        |
| Scenarios (loader + parser)               |     2 |        |
| Off-line interactive contract (e2e)       |     1 |     4 |
| Workspace isolation + e2e contract        |     2 |        |
| Workspace manager                         |     1 |        |
| Workspace path safety + config schema     |     2 |        |
| MCP smoke (transport-level)               |     1 |     2 |
| Bootstrap                                 |     1 |        |
| **Total**                                 | **20**| **161** |

(The per-row test counts are intentionally left blank: they are easy
to drift out of sync as the suite grows. The two e2e contract files
have stable counts because they sit at the bottom of the dependency
graph. The grand total — 20 files / 161 tests — is the authoritative
figure.)

## Known limitations / follow-ups

- The fidelity of the `prepare` tool's `nextSteps` array is verified
  textually (presence of the agreed call names) but not actually
  followed by Claude against a real device. That is exactly what the
  manual step above would confirm.
- The Markdown report renders the stability section in the agreed
  Chinese order, but the brief's stretch goal of deriving per-phase
  durations from timestamps was not pursued because the
  interactive-model metric contract does not require it.
- The workspace contract is asserted offline; the user-scope install +
  per-project initialization flow has been documented in the README
  but not been executed end-to-end against a multi-project Claude
  Code setup. That is a Task 8 concern.
- No `.gitignore` was added; `node_modules/` and `dist/` remain
  untracked.

## Commands run

```bash
npm test
#   Test Files  20 passed (20)
#         Tests  161 passed (161)

npm run build
#   tsc -p tsconfig.json   (exit 0)

git diff --check
#   (silent — no whitespace issues)
```
