import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The launch tool path normally shells out to `xctrace`. Mocking the exporter
 * keeps this a unit test while still exercising the real parser, the tool
 * branch and the `includePageFaults` option.
 */
const state = vi.hoisted(() => ({
  tables: new Map<string, string | Error>(),
  calls: [] as string[],
}));

vi.mock("../../analysis/trace/export.js", () => ({
  exportTraceTable: vi.fn(async (_tracePath: string, schema: string) => {
    state.calls.push(schema);
    const value = state.tables.get(schema);
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error(`no fixture for ${schema}`);
    return value;
  }),
}));

import { analyzeAppLaunchTrace } from "../../analysis/parsers/app-launch.js";
import { analyzePerformanceTrace } from "../../tools/analyze.js";

const LIFECYCLE_XML = `<?xml version="1.0"?>
<trace-query-result>
  <node>
    <schema name="life-cycle-period">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>process</mnemonic></col>
      <col><mnemonic>period</mnemonic></col>
    </schema>
    <row>
      <start-time>1000000</start-time>
      <duration>50000000</duration>
      <process fmt="NN (42)">42</process>
      <app-period>Initializing - Static Runtime Initialization</app-period>
    </row>
    <row>
      <start-time>51000000</start-time>
      <duration>40000000</duration>
      <process fmt="NN (42)">42</process>
      <app-period>Launching - Initial Frame Rendering</app-period>
    </row>
  </node>
</trace-query-result>`;

const VIRTUAL_MEMORY_XML = `<?xml version="1.0"?>
<trace-query-result>
  <node>
    <schema name="virtual-memory">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>thread</mnemonic></col>
      <col><mnemonic>operation</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>process</mnemonic></col>
    </schema>
    <row>
      <start-time>2000000</start-time>
      <thread fmt="Main Thread (0x1) (NN, pid: 42)">1</thread>
      <vm-op>File Backed Page In</vm-op>
      <duration>3000000</duration>
      <process fmt="NN (42)">42</process>
    </row>
    <row>
      <start-time>4000000</start-time>
      <thread fmt="Main Thread (0x1) (NN, pid: 42)">1</thread>
      <vm-op>Page Cache Hit</vm-op>
      <duration>1000000</duration>
      <process fmt="NN (42)">42</process>
    </row>
  </node>
</trace-query-result>`;

const DYLD_XML = `<?xml version="1.0"?>
<trace-query-result>
  <node>
    <schema name="dyld-activity-interval">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>type</mnemonic></col>
      <col><mnemonic>process</mnemonic></col>
    </schema>
    <row>
      <start-time>1000000</start-time>
      <duration>2000000</duration>
      <activity-type>Launch Executable</activity-type>
      <process fmt="NN (42)">42</process>
    </row>
  </node>
</trace-query-result>`;

const TRACE = "/tmp/take-launch.trace";

describe("launch tool page-fault plumbing", () => {
  beforeEach(() => {
    state.calls = [];
    state.tables = new Map([
      ["life-cycle-period", LIFECYCLE_XML],
      ["virtual-memory", VIRTUAL_MEMORY_XML],
      ["dyld-activity-interval", DYLD_XML],
    ]);
  });

  it("returns analysis.pageFaults from analyze_performance_trace", async () => {
    const result = await analyzePerformanceTrace({
      template: "launch",
      tracePath: TRACE,
      processName: "NN",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.metrics[0]).toMatchObject({ name: "launchMs", value: 90 });
    expect(result.analysis.pageFaults).toEqual({
      fileBackedPageIns: 1,
      fileBackedPageInMs: 3,
      totalFaults: 2,
      totalFaultMs: 4,
    });
    expect(result.warnings).toEqual([]);
  });

  it("surfaces export failures as warnings instead of failing launchMs", async () => {
    state.tables.set("virtual-memory", new Error("export exploded"));
    const result = await analyzePerformanceTrace({
      template: "launch",
      tracePath: TRACE,
      processName: "NN",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.metrics[0]).toMatchObject({ name: "launchMs", value: 90 });
    expect(result.analysis.pageFaults).toBeUndefined();
    expect(result.warnings.join(" ")).toContain(
      "Could not read page faults: export exploded",
    );
  });

  it("skips the virtual-memory export when includePageFaults is false", async () => {
    const analysis = await analyzeAppLaunchTrace(TRACE, {
      processName: "NN",
      includeDyld: false,
      includePageFaults: false,
    });

    expect(analysis.pageFaults).toBeUndefined();
    expect(state.calls).toEqual(["life-cycle-period"]);
  });
});
