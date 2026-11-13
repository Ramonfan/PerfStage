/**
 * Embedded default scenarios that ship with the package.
 *
 * Listing them as plain string constants (instead of as YAML files on
 * disk) keeps the TypeScript build pipeline free of postbuild copy
 * steps: every template is compiled straight into the manager bundle.
 *
 * To add or update a template, edit the entry below in place.
 */
export interface EmbeddedScenarioTemplate {
  readonly name: string;
  readonly contents: string;
}

export const EMBEDDED_SCENARIO_TEMPLATES: readonly EmbeddedScenarioTemplate[] = [
  {
    name: "start-cold.yaml",
    contents: `id: start-cold
name: 冷启动基线
app:
  bundleId: com.example.app
device: {}
preconditions:
  description: Target app is installed and running on the connected device
warmup: []
actions:
  - id: relaunch
    type: tap
    target: relaunch
    waitAfterMs: 1500
metrics:
  - name: startup
    instrument: Time Profiler
  - name: memory
    instrument: Allocations
`,
  },
  {
    name: "scroll-baseline.yaml",
    contents: `id: scroll-baseline
name: 列表滚动基线
app:
  bundleId: com.example.app
device: {}
preconditions:
  description: Target app is installed and running on the connected device
warmup: []
actions:
  - id: scroll-up
    type: swipe
    direction: up
    distance: 500
    durationMs: 400
    waitAfterMs: 1500
  - id: scroll-down
    type: swipe
    direction: down
    distance: 500
    durationMs: 400
    waitAfterMs: 1500
metrics:
  - name: hitches
    instrument: Animation Hitches
  - name: cpu
    instrument: Time Profiler
`,
  },
];
