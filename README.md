# Performance Test MCP

Local orchestration helper for iOS performance experiments. It reads the current scenario YAML files, prepares structured test plans, and finalizes evidence and reports after Claude coordinates `mobile-mcp` and `instruments-mcp-server`.

This is intentionally a personal-use tool, not a test-management platform.

## Local setup

```bash
npm install
npm test
npm run build
npm start
```

Device operations remain Claude-orchestrated.

## Claude orchestration workflow

The MCP exposes three tools. The first version implements **interactive** mode end-to-end; unattended execution is intentionally out of scope until at least one scenario has stabilized.

The conceptual sequence Claude follows is:

```text
list_performance_scenarios
prepare_performance_test({ scenarioId: "community-home-scroll", device: { id: "..." } })
# Claude calls mobile_get_device_logs and mobile_list_crashes before actions.
# Claude performs the returned mobile-mcp actions and requested Instruments calls.
# Claude collects final logs/crashes/lifecycle and supplies their paths/results.
finalize_performance_test({ runId: "...", ... })
```

Step by step:

1. **List scenarios.** Call `list_performance_scenarios` (no arguments) to enumerate the YAML files in the configured scenario directory. The tool returns id, name, bundleId, action count, metric names, and the diagnostic defaults for each scenario.
2. **Prepare the run.** Call `prepare_performance_test` with either a `scenarioId` from the list above or an inline `adHocPlan`, plus a `device` selector. The tool validates the plan, persists a prepared `run.json` and resolved `plan.json` under `runs/<run-id>/`, and returns `nextSteps` describing what Claude should do next.
3. **Drive the device.** Follow the `nextSteps` list:
   - Start `mobile_get_device_logs` before the first action so the log stream covers the whole run.
   - Take a `mobile_list_crashes` snapshot so the tool can diff before/after IDs.
   - Drive the declared `actions` (taps, swipes, waits) using the corresponding `mobile-mcp` calls, respecting each action's `waitAfterMs`.
   - Collect hitches, CPU and memory (or whichever `metricNames` the scenario names) through `instruments-mcp-server` and record each trace path on the matching metric.
   - Re-call `mobile_get_device_logs` and `mobile_list_crashes` to capture new logs and any new Crash IDs, then fetch each new Crash's full report through `mobile_get_crash`.
   - Gather lifecycle events (foreground / background / springboard / system_alert / device_disconnect) and any screenshots or network captures the user wants archived.
4. **Finalize the run.** Call `finalize_performance_test` with the `runId`, the `requestedStatus` (`completed`, `failed`, `partial`, `invalid`, `cancelled`), the action records, the metric results, the diagnostics bundle (`logPath`, `logText`, `crashIdsBefore`/`crashIdsAfter`, `crashReports`, `lifecycle`, plus any `*QueryError` strings), and optional `evidencePaths` for files that should be copied into `runs/<run-id>/`. The tool writes `report.json` and `report.md` next to `run.json` and returns the recorded evidence paths and findings.

### Scenario editing

Scenarios live in `scenarios/` as YAML files. Edit a file (or drop a new one) and the next `list_performance_scenarios` call will pick it up — the directory is re-read on every invocation, no restart needed. Each scenario declares an `id`, `name`, App `bundleId`, optional preconditions, an optional `warmup` action list, the `actions` to drive, and one or more `metrics` (with the matching `instruments-mcp-server` instrument name).

### Run directory layout

After `finalize_performance_test` completes, the run directory looks like:

```text
runs/<run-id>/
├── run.json                 # persisted TestRun; terminal status, locked from re-finalize
├── plan.json                # resolved TestPlan as Claude actually executed it
├── report.json              # machine-readable report
├── report.md                # Chinese-language Markdown report
├── device.log               # (when diagnostics.logPath is supplied)
├── lifecycle.json           # (when supplied via evidencePaths)
└── crashes/<crash-id>.txt   # (one file per new Crash, when supplied via evidencePaths)
```

The run directory is intentionally deletable local evidence, not a database.

## Tools

| Tool | Inputs | Purpose |
| --- | --- | --- |
| `list_performance_scenarios` | none | Enumerate available scenarios. |
| `prepare_performance_test` | `scenarioId` xor `adHocPlan`, `device`, optional `execution`, `metricOverrides`, `analysisFocus`, `diagnosticOverrides`, `notes` | Validate, persist a prepared run, return next steps. |
| `finalize_performance_test` | `runId`, `requestedStatus`, `actions`, `metrics`, `diagnostics`, optional `evidencePaths`, `notes` | Record action/metric evidence, copy supplied evidence, write `report.json` and `report.md`. |

Diagnostics are never re-collected by this MCP — Claude is the single source of truth that runs `mobile-mcp` and `instruments-mcp-server`, then supplies the results.

## Environment variables

- `PERFORMANCE_TEST_SCENARIO_DIR` — overrides the scenarios directory (default `scenarios`).
- `PERFORMANCE_TEST_RUNS_DIR` — overrides the runs root (default `runs`).

Both are useful for tests and for pointing the server at a fixture directory without code edits.

## Current status

Design approved. Implementation plan complete. Interactive mode is implemented end-to-end; unattended execution is intentionally deferred until at least one scenario has stabilized.

## Related components

- `../instruments-mcp-server/` — Instruments collection and parsers
- `mobile-mcp` — device/UI automation supplied by the environment

## Verification

See `docs/superpowers/verification/2026-10-17-interactive-run.md` for the latest interactive-run verification note.