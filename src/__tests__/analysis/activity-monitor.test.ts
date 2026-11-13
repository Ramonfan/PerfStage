import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  ActivityMonitorSelectionError,
  analyzeActivityMonitorTable,
  memoryMetricValue,
  parseActivityMonitorTable,
} from "../../analysis/parsers/activity-monitor.js";

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
}

const MIB = 1024 * 1024;

function minimalTable(rows: string): string {
  return `<?xml version="1.0"?>
<trace-query-result>
  <node>
    <schema name="activity-monitor-process-live">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>process</mnemonic></col>
      <col><mnemonic>pid</mnemonic></col>
      <col><mnemonic>memory-physical-footprint</mnemonic></col>
    </schema>
    ${rows}
  </node>
</trace-query-result>`;
}

describe("parseActivityMonitorTable", () => {
  it("groups samples by pid from the real fixture", async () => {
    const processes = parseActivityMonitorTable(
      await fixture("activity-monitor-process-live.xml"),
    );
    expect(processes.map((process) => process.name).sort()).toEqual([
      "NNIM",
      "SpringBoard",
      "kernel",
    ]);
    const nnim = processes.find((process) => process.name === "NNIM");
    expect(nnim?.pid).toBe(6764);
    expect(nnim?.samples).toHaveLength(9);
  });

  it("sorts samples by start time", async () => {
    const processes = parseActivityMonitorTable(
      await fixture("activity-monitor-process-live.xml"),
    );
    const nnim = processes.find((process) => process.name === "NNIM")!;
    const starts = nnim.samples.map((sample) => sample.startMs);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(nnim.samples[0].startMs).toBe(0);
  });
});

describe("analyzeActivityMonitorTable", () => {
  it("reports the median physical footprint for an explicit pid", async () => {
    const analysis = analyzeActivityMonitorTable(
      await fixture("activity-monitor-process-live.xml"),
      { pid: 6764 },
    );

    expect(analysis.selection).toBe("pid");
    expect(analysis.processName).toBe("NNIM");
    expect(analysis.summary.sampleCount).toBe(9);
    expect(analysis.summary.firstMiB).toBeCloseTo(114.85, 2);
    expect(analysis.summary.lastMiB).toBeCloseTo(113.5, 2);
    expect(analysis.summary.medianMiB).toBeCloseTo(113.5, 2);
    expect(analysis.summary.maxMiB).toBeCloseTo(114.85, 2);
    expect(analysis.summary.netGrowthMiB).toBeCloseTo(-1.35, 1);
    expect(analysis.summary.slopeMiBPerMin).toBeLessThan(0);
    expect(analysis.seriesMiB).toHaveLength(9);
    expect(memoryMetricValue(analysis)).toBeCloseTo(113.5, 2);
    expect(analysis.warnings).toEqual([]);
  });

  it("selects a process by base name, case-insensitively", async () => {
    const analysis = analyzeActivityMonitorTable(
      await fixture("activity-monitor-process-live.xml"),
      { processName: "nnim" },
    );
    expect(analysis.selection).toBe("name");
    expect(analysis.pid).toBe(6764);
  });

  it("throws when the requested process is absent", async () => {
    const xml = await fixture("activity-monitor-process-live.xml");
    expect(() =>
      analyzeActivityMonitorTable(xml, { processName: "NOPE" }),
    ).toThrowError(ActivityMonitorSelectionError);
  });

  it("falls back to the largest median footprint with a warning", async () => {
    const analysis = analyzeActivityMonitorTable(
      await fixture("activity-monitor-process-live.xml"),
    );
    expect(analysis.selection).toBe("largest-median");
    expect(analysis.processName).toBe("kernel");
    expect(analysis.warnings.join(" ")).toContain("largest median footprint");
  });

  it("prefers the pid with the most samples when names collide", () => {
    const xml = minimalTable(`
      <row><start-time>0</start-time><process fmt="NNIM (1)"/><pid>1</pid><size-in-bytes>${100 * MIB}</size-in-bytes></row>
      <row><start-time>1000000000</start-time><process ref="x"/><pid>1</pid><size-in-bytes>${101 * MIB}</size-in-bytes></row>
      <row><start-time>2000000000</start-time><process ref="x"/><pid>1</pid><size-in-bytes>${102 * MIB}</size-in-bytes></row>
      <row><start-time>3000000000</start-time><process fmt="NNIM (2)"/><pid>2</pid><size-in-bytes>${200 * MIB}</size-in-bytes></row>
    `);
    const analysis = analyzeActivityMonitorTable(xml, { processName: "NNIM" });
    expect(analysis.pid).toBe(1);
    expect(analysis.warnings.join(" ")).toContain("Multiple processes named");
  });

  it("computes the slope from real sample timestamps", () => {
    const xml = minimalTable(`
      <row><start-time>0</start-time><process fmt="App (7)"/><pid>7</pid><size-in-bytes>${100 * MIB}</size-in-bytes></row>
      <row><start-time>30000000000</start-time><process ref="a"/><pid>7</pid><size-in-bytes>${102 * MIB}</size-in-bytes></row>
      <row><start-time>60000000000</start-time><process ref="a"/><pid>7</pid><size-in-bytes>${104 * MIB}</size-in-bytes></row>
    `);
    const analysis = analyzeActivityMonitorTable(xml, { pid: 7 });
    // 2 MiB per 30s => 4 MiB per minute.
    expect(analysis.summary.slopeMiBPerMin).toBeCloseTo(4, 3);
    expect(analysis.summary.netGrowthMiB).toBeCloseTo(4, 2);
    expect(analysis.summary.medianMiB).toBeCloseTo(102, 2);
  });
});
