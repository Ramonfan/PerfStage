# Performance Test MCP Design

**Date:** 2026-10-17
**Status:** Approved for implementation planning
**Scope:** Local, single-user iOS performance-test orchestration

## Goal

Provide a local MCP that turns either a named current scenario or a one-off structured test request into a reproducible test plan, coordinates Claude's calls to `mobile-mcp` and `instruments-mcp-server`, and produces a focused JSON/Markdown report for metrics such as animation hitches, CPU, and memory.

The first release is a personal-use orchestration helper, not a test-management platform.

## Explicit non-goals

- No scenario versioning, migration, publishing, or history management.
- No CI scheduler, web dashboard, team permissions, multi-user storage, or database.
- No replacement implementation of `mobile-mcp` device automation.
- No duplicate implementation of `instruments-mcp-server` collection/parsers.
- No LLM call inside the new MCP for natural-language interpretation; Claude supplies a structured plan.
- No business-app source changes as part of this project.

## User-facing model

There are two independent axes:

1. **Source:** an existing current YAML scenario, or a one-off ad-hoc structured plan created by Claude from natural language.
2. **Execution:** interactive (Claude continues calling `mobile-mcp` and `instruments-mcp-server`) or unattended (future runner executes stable actions internally).

Both sources normalize to one `TestPlan`; both execution modes share `TestRun`, action timestamps, metric records, and report generation.

## Architecture

```text
Claude
  ├── mobile-mcp                 (device/UI actions)
  ├── instruments-mcp-server     (xctrace, trace export, parsers)
  └── performance-test-mcp       (plan, run state, evidence, report)
```

The first implementation uses Claude orchestration. The new MCP does not implement an MCP client in v1. A future `UnattendedActionRunner` may be added after a scenario is proven stable, without changing the plan or report contracts.

## Project layout

```text
performance-test-mcp/
├── package.json
├── tsconfig.json
├── README.md
├── scenarios/
│   ├── community-home-scroll.yaml
│   └── message-list-scroll.yaml
├── runs/                         # local evidence; not a database
├── docs/superpowers/specs/
└── src/
    ├── index.ts
    ├── model/{test-plan,test-run}.ts
    ├── scenario/{loader,parser}.ts
    ├── tools/{scenarios,plan,report}.ts
    └── reports/{markdown,json}.ts
```

## Scenario format

Each YAML file is the current definition. Editing it changes the next run; no historical scenario identity is maintained.

A scenario contains:

- `id`, `name`
- app bundle ID and launch/settle settings
- preconditions (foreground bundle and accessibility matches)
- warm-up actions
- action list (`tap`, `swipe`, `wait`, `wait_for`)
- default metrics (`hitches`, `cpu`, `memory`)
- optional evaluation thresholds

The loader validates required fields and normalizes defaults into `TestPlan`. It must reject unknown or malformed action types rather than silently skipping them.

## MCP tools

### `list_performance_scenarios`

Lists current YAML scenarios and their app/metric summary.

### `prepare_performance_test`

Accepts a structured scenario source or ad-hoc plan, device, execution mode, metric override, and analysis focus. Validates the plan, creates a `run_id`, records the device/app context supplied by the caller, and returns the next steps for Claude. It does not perform device actions in v1.

### `finalize_performance_test`

Accepts the run ID, action records, metric trace paths/results, and completion status. Saves a local run artifact, normalizes supplied metric results, and emits focused JSON plus Markdown output. It must preserve invalid/partial/failed status and never convert missing evidence into PASS.

## Data contracts

`TestPlan` includes:

- source: `scenario` or `ad_hoc`
- app: bundle ID and optional launch path
- device selector
- execution mode: `interactive` or `unattended`
- preconditions
- actions with stable IDs, direction/distance/duration/settle fields
- metric requests
- analysis focus strings
- repetition count

`TestRun` includes:

- run ID, timestamps, status (`prepared`, `running`, `completed`, `partial`, `invalid`, `failed`, `cancelled`)
- resolved device context when known
- app/build context when known
- plan summary
- actual action records with start/end/settled timestamps
- recording artifacts and metric summaries
- report paths

The run snapshot records the actual structured plan and actions used for that run. This is evidence, not scenario versioning.

## Metric boundary

`performance-test-mcp` consumes results and trace paths from `instruments-mcp-server`; it does not copy xctrace or parser code. v1 report adapters understand hitches, CPU, and memory result shapes and preserve unknown metric payloads for forward compatibility.

The report must distinguish:

- dragging/action interval
- deceleration/settle interval when action timestamps allow it
- post-action interval
- unavailable phase attribution

If timestamps or metric data are insufficient, report `unknown` rather than infer a cause.

## Error handling

- Precondition failure => `invalid`, with reason and optional screenshot/accessibility artifact.
- Missing/empty trace => metric failure or `invalid`, never a zero-performance PASS.
- Some metrics succeed and others fail => `partial`.
- Device disconnect, App crash, or recording failure => `failed` with preserved evidence paths.
- Destructive operations (uninstall, data deletion, cache clearing) are not part of v1.

## Storage

Each run writes to `runs/<timestamp>-<run-id>/`:

- `run.json`
- `report.md`
- action records
- copied or referenced trace paths when supplied
- optional screenshots/accessibility dumps

Runs are disposable local evidence and can be deleted manually.

## Implementation phases

1. Add project package/tooling and domain models.
2. Add YAML scenario loading/validation and scenario listing.
3. Add plan preparation and run-state persistence.
4. Add finalization and JSON/Markdown reports.
5. Add the first current scenarios.
6. Exercise the interactive Claude-orchestrated path with existing MCPs.
7. Only after a scenario is stable, consider an unattended action runner; do not implement it in the initial slice unless verification proves the boundary is small.

## Verification

- Unit tests for YAML validation/defaults and malformed plans.
- Unit tests for run status transitions and artifact paths.
- Unit tests for report phase bucketing and missing/partial metric data.
- MCP protocol smoke test for the three tools.
- Manual integration run using `community-home-scroll` with the existing `mobile-mcp` and `instruments-mcp-server`, without changing the NN app.
