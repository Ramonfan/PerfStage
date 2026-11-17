import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  attachPageFaults,
  parseAppLaunchTable,
  parseDyldActivityTable,
  parseVirtualMemoryTable,
} from "../../analysis/parsers/app-launch.js";

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
}

const NO_LAUNCH_XML = `<?xml version="1.0"?>
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
      <duration>5000000</duration>
      <process fmt="NN (42)"/>
      <app-period>Foreground - Active</app-period>
    </row>
  </node>
</trace-query-result>`;

describe("parseAppLaunchTable", () => {
  it("derives launch time from the real life-cycle-period fixture", async () => {
    const analysis = parseAppLaunchTable(await fixture("life-cycle-period.xml"));

    expect(analysis.processName).toBe("NN");
    expect(analysis.launchType).toBe("cold");
    expect(analysis.launchMs).toBeCloseTo(274.3, 1);
    expect(analysis.phases).toHaveLength(11);
    expect(analysis.phases[0].name).toBe(
      "Initializing - System Interface Initialization",
    );
    expect(analysis.phases[0].startMs).toBeCloseTo(393.75, 2);
    expect(analysis.phases.at(-1)?.name).toBe("Launching - Initial Frame Rendering");
    expect(analysis.phases.at(-1)?.endMs).toBeCloseTo(668.06, 2);
    expect(analysis.warnings).toEqual([]);
  });

  it("selects a named process case-insensitively", async () => {
    const analysis = parseAppLaunchTable(await fixture("life-cycle-period.xml"), {
      processName: "nn",
    });
    expect(analysis.processName).toBe("NN");
    expect(analysis.launchMs).toBeCloseTo(274.3, 1);
  });

  it("reports a warning and no launch time when the process is absent", async () => {
    const analysis = parseAppLaunchTable(await fixture("life-cycle-period.xml"), {
      processName: "NOPE",
    });
    expect(analysis.launchMs).toBeNull();
    expect(analysis.processName).toBeNull();
    expect(analysis.warnings[0]).toContain("NOPE");
  });

  it("returns null launch time when the trace only has foreground periods", () => {
    const analysis = parseAppLaunchTable(NO_LAUNCH_XML);
    expect(analysis.launchMs).toBeNull();
    expect(analysis.launchType).toBe("unknown");
    expect(analysis.warnings.join(" ")).toContain("launch_path");
  });

  it("excludes foreground periods from the launch span", async () => {
    const analysis = parseAppLaunchTable(await fixture("life-cycle-period.xml"));
    expect(analysis.phases.some((phase) => phase.name === "Foreground - Active")).toBe(
      false,
    );
    // The foreground row lasts ~7.7s; if it leaked in, launchMs would be huge.
    expect(analysis.launchMs).toBeLessThan(1000);
  });
});

describe("parseVirtualMemoryTable", () => {
  const MAIN = "Main Thread (0x1) (NN, pid: 1)";
  const BACKGROUND = "AsyncManager (0x2) (NN, pid: 1)";

  function row(options: {
    startMs: number;
    thread?: string;
    process?: string;
    operation?: string;
    durationNs?: number;
  }): string {
    const thread = options.thread ?? MAIN;
    const process = options.process ?? "NN (1)";
    return `<row>
      <start-time>${Math.round(options.startMs * 1_000_000)}</start-time>
      <thread fmt="${thread}">1</thread>
      <vm-op>${options.operation ?? "File Backed Page In"}</vm-op>
      <duration>${options.durationNs ?? 0}</duration>
      <process fmt="${process}">1</process>
    </row>`;
  }

  function table(rows: string[]): string {
    return `<?xml version="1.0"?>
<trace-query-result>
  <node>
    <schema name="virtual-memory">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>thread</mnemonic></col>
      <col><mnemonic>operation</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>process</mnemonic></col>
    </schema>
    ${rows.join("\n")}
  </node>
</trace-query-result>`;
  }

  it("sums main-thread faults inside the launch window and converts ns to ms", () => {
    const xml = table([
      row({ startMs: 400, durationNs: 2_883_750 }),
      row({
        startMs: 500,
        operation: "Page Cache Hit",
        durationNs: 1_000_000,
      }),
      row({ startMs: 600, operation: "Zero Fill", durationNs: 500_000 }),
      // Start at the window end is excluded, matching the `launchMs` bounds.
      row({ startMs: 700, durationNs: 9_000_000 }),
      // Start at the window's first instant is included.
      row({ startMs: 350, durationNs: 100_000 }),
      // Background threads and other processes never contribute.
      row({ startMs: 450, thread: BACKGROUND, durationNs: 5_000_000 }),
      row({ startMs: 450, process: "NNIM (2)", durationNs: 5_000_000 }),
    ]);

    const summary = parseVirtualMemoryTable(xml, {
      processName: "NN",
      window: { fromMs: 350, toMs: 700 },
    });

    expect(summary).toEqual({
      fileBackedPageIns: 2,
      // (2_883_750 + 100_000) ns = 2.98375 ms, rounded to 1 decimal.
      fileBackedPageInMs: 3,
      totalFaults: 4,
      totalFaultMs: 4.5,
    });
    // A summary can never report more page-ins than faults.
    expect(summary!.fileBackedPageIns).toBeLessThanOrEqual(summary!.totalFaults);
  });

  it("returns null when the only main-thread row starts at the window end", () => {
    // The window end is exclusive, matching the `launchMs` bounds.
    const xml = table([row({ startMs: 700, durationNs: 1_000_000 })]);
    expect(
      parseVirtualMemoryTable(xml, {
        processName: "NN",
        window: { fromMs: 350, toMs: 700 },
      }),
    ).toBeNull();
  });

  it("returns null when only background threads fault", () => {
    const xml = table([
      row({ startMs: 400, thread: BACKGROUND, durationNs: 5_000_000 }),
    ]);
    expect(
      parseVirtualMemoryTable(xml, {
        processName: "NN",
        window: { fromMs: 350, toMs: 700 },
      }),
    ).toBeNull();
  });

  it("returns null when the target process is unknown", () => {
    const xml = table([row({ startMs: 400, durationNs: 1_000_000 })]);
    expect(
      parseVirtualMemoryTable(xml, { window: { fromMs: 350, toMs: 700 } }),
    ).toBeNull();
  });

  it("does not treat nanoseconds as milliseconds", () => {
    const xml = table([row({ startMs: 400, durationNs: 28_875 })]);
    const summary = parseVirtualMemoryTable(xml, {
      processName: "NN",
      window: { fromMs: 350, toMs: 700 },
    });
    // 28,875 ns is 0.029 ms; a unit mix-up would report 28.9ms.
    expect(summary?.fileBackedPageInMs).toBe(0);
    expect(summary?.totalFaultMs).toBe(0);
  });
});

describe("attachPageFaults degradation", () => {
  const COLUMNS = `<schema name="virtual-memory">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>thread</mnemonic></col>
      <col><mnemonic>operation</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>process</mnemonic></col>
    </schema>`;

  async function analysisFromFixture() {
    return parseAppLaunchTable(await fixture("life-cycle-period.xml"));
  }

  it("warns and keeps launchMs when the table is missing", async () => {
    const analysis = await analysisFromFixture();
    const launchMs = analysis.launchMs;
    await attachPageFaults(
      "/tmp/launch.trace",
      analysis,
      async () => `<?xml version="1.0"?><trace-query-result></trace-query-result>`,
    );
    expect(analysis.pageFaults).toBeUndefined();
    expect(analysis.launchMs).toBe(launchMs);
    expect(analysis.warnings.join(" ")).toContain(
      "no matching main-thread faults",
    );
  });

  it("warns and keeps launchMs when the export fails", async () => {
    const analysis = await analysisFromFixture();
    const launchMs = analysis.launchMs;
    await attachPageFaults("/tmp/launch.trace", analysis, async () => {
      throw new Error("export exploded");
    });
    expect(analysis.pageFaults).toBeUndefined();
    expect(analysis.launchMs).toBe(launchMs);
    expect(analysis.warnings.join(" ")).toContain(
      "Could not read page faults: export exploded",
    );
  });

  it("does not fall back to another process's main thread", async () => {
    const analysis = await analysisFromFixture();
    const xml = `<?xml version="1.0"?>
<trace-query-result>
  <node>
    ${COLUMNS}
    <row>
      <start-time>400000000</start-time>
      <thread fmt="Main Thread (0x1) (NNIM, pid: 2)">1</thread>
      <vm-op>File Backed Page In</vm-op>
      <duration>1000000</duration>
      <process fmt="NNIM (2)">2</process>
    </row>
  </node>
</trace-query-result>`;
    await attachPageFaults("/tmp/launch.trace", analysis, async () => xml);
    expect(analysis.pageFaults).toBeUndefined();
    expect(analysis.warnings.join(" ")).toContain(
      "no matching main-thread faults",
    );
  });

  it("warns when only background threads fault", async () => {
    const analysis = await analysisFromFixture();
    const xml = `<?xml version="1.0"?>
<trace-query-result>
  <node>
    ${COLUMNS}
    <row>
      <start-time>400000000</start-time>
      <thread fmt="AsyncManager (0x2) (NN, pid: 1)">2</thread>
      <vm-op>File Backed Page In</vm-op>
      <duration>1000000</duration>
      <process fmt="NN (1)">1</process>
    </row>
  </node>
</trace-query-result>`;
    await attachPageFaults("/tmp/launch.trace", analysis, async () => xml);
    expect(analysis.pageFaults).toBeUndefined();
    expect(analysis.warnings.join(" ")).toContain(
      "no matching main-thread faults",
    );
  });

  it("warns and skips the export when the lifecycle rows have no process", async () => {
    // Real xctrace can emit launch rows without a usable `process` column.
    const analysis = parseAppLaunchTable(`<?xml version="1.0"?>
<trace-query-result>
  <node>
    <schema name="life-cycle-period">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>period</mnemonic></col>
    </schema>
    <row>
      <start-time>1000000</start-time>
      <duration>50000000</duration>
      <app-period>Initializing - Static Runtime Initialization</app-period>
    </row>
  </node>
</trace-query-result>`);
    expect(analysis.processName).toBeNull();
    expect(analysis.launchMs).toBe(50);
    expect(analysis.warnings).toEqual([]);

    let exported = false;
    await attachPageFaults("/tmp/launch.trace", analysis, async () => {
      exported = true;
      return `<trace-query-result></trace-query-result>`;
    });

    expect(exported).toBe(false);
    expect(analysis.pageFaults).toBeUndefined();
    expect(analysis.warnings.join(" ")).toContain(
      "launch lifecycle rows did not identify a process",
    );
  });
});

describe("parseDyldActivityTable", () => {
  it("summarizes the pre-main dyld activity", async () => {
    const dyld = parseDyldActivityTable(await fixture("dyld-activity-interval.xml"));
    expect(dyld).not.toBeNull();
    expect(dyld?.activityCount).toBe(40);
    expect(dyld?.launchExecutableMs).toBeCloseTo(86.03, 2);
    expect(dyld?.firstStartMs).toBeCloseTo(398.05, 2);
    expect(dyld?.spanMs).toBeCloseTo(86.03, 2);
  });

  it("filters by process name", async () => {
    const dyld = parseDyldActivityTable(
      await fixture("dyld-activity-interval.xml"),
      { processName: "NN" },
    );
    expect(dyld?.activityCount).toBe(40);
  });
});
