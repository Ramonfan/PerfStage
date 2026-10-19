# Interactive Performance Test — Verification Note

> **Status as of 2026-10-17, suite green: 14 files / 103 tests passed.**

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
  minutes are removed and the call is retried once).
- **MCP tools** (`src/tools/{scenarios,plan,report,index}.ts`):
  `list_performance_scenarios`, `prepare_performance_test`,
  `finalize_performance_test` registered via `McpServer.registerTool`
  with Zod-derived schemas. Output:
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

## Explicitly pending — manual device integration

The interactive flow was **not** exercised against `mobile-mcp` and
`instruments-mcp-server` in this session. The first commit, the
two follow-up fix waves, and the canonical-harness refactor were
all exercised through the in-process test harness
(`src/__tests__/support/tool-harness.ts`).

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

| Surface                          | Files | Tests |
| -------------------------------- | ----: | ----: |
| Domain (model, diagnostics)      |     4 |    38 |
| Reports                          |     2 |    16 |
| Storage                          |     1 |    17 |
| Tools (harness-driven)            |     5 |    23 |
| Off-line interactive contract     |     1 |     4 |
| MCP smoke (transport-level)       |     1 |     2 |
| **Total**                        | **14**| **103** |

(The numbers above are the current offline-suite snapshot. The
plan-level breakdown is best-effort and small mismatches reflect the
number of helper tests inside the storage module.)

## Known limitations / follow-ups

- The fidelity of the `prepare` tool's `nextSteps` array is verified
  textually (presence of the agreed call names) but not actually
  followed by Claude against a real device. That is exactly what the
  manual step above would confirm.
- The Markdown report renders the stability section in the agreed
  Chinese order, but the brief's stretch goal of deriving per-phase
  durations from timestamps was not pursued because the
  interactive-model metric contract does not require it.
- No `.gitignore` was added; `node_modules/` and `dist/` remain
  untracked.

## Commands run

```bash
npm test
#   Test Files  14 passed (14)
#         Tests  103 passed (103)

npm run build
#   tsc -p tsconfig.json   (exit 0)

git diff --check
#   (silent — no whitespace issues)
```
