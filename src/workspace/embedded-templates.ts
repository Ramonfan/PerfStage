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
  # Must be checkable: a description alone would be reported as verified
  # without anything being compared. Keep it in sync with app.bundleId.
  foregroundBundleId: com.example.app
warmup: []
actions:
  # The Runner launches the app itself for the App Launch pass; this action is
  # only a required placeholder and is skipped for launch-only plans.
  - id: settle
    type: wait
    durationMs: 1000
metrics:
  - name: launchMs
    instrument: App Launch
  - name: memoryMB
    instrument: Activity Monitor
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
  # Must be checkable: a description alone would be reported as verified
  # without anything being compared. Keep it in sync with app.bundleId.
  foregroundBundleId: com.example.app
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
    # Example tolerance only; C4 replaces it with a distribution-derived value.
    # worse is required: the gate must not guess whether higher is bad.
    regression:
      worse: higher
      maxWorseningPercent: 20
  - name: blockMs
    instrument: Animation Hitches
    regression:
      worse: higher
      maxWorseningPercent: 20
`,
  },
];
