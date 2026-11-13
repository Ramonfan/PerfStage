import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  analyzeHitchesXml,
  classifyHitch,
} from "../../analysis/parsers/animation-hitches.js";

const fixturePath = fileURLToPath(
  new URL("../fixtures/hitches-frame-lifetimes.xml", import.meta.url),
);

function hangTableXml(
  rows: Array<{ startNs: number; durationNs: number }>,
): string {
  const rowXml = rows
    .map(
      (row, index) =>
        `<row><start-time id="s${index}">${row.startNs}</start-time><duration id="d${index}">${row.durationNs}</duration></row>`,
    )
    .join("");
  return `<trace-query-result><node><schema name="hitches"><col><mnemonic>start</mnemonic></col><col><mnemonic>duration</mnemonic></col></schema>${rowXml}</node></trace-query-result>`;
}

describe("analyzeHitchesXml", () => {
  it("derives hitches and blockMs from a real frame-lifetime fixture", async () => {
    const xml = await readFile(fixturePath, "utf8");
    const analysis = analyzeHitchesXml(xml);

    expect(analysis.table).toBe("hitches-frame-lifetimes");
    expect(analysis.frameCount).toBe(48);
    expect(analysis.targetFrameMs).toBe(17.13);
    expect(analysis.hitchThresholdMs).toBe(22.27);
    expect(analysis.hitches).toBe(32);
    expect(analysis.blockMs).toBe(37.5);
    expect(analysis.estimatedHitchTimeMs).toBe(149.1);
    expect(analysis.colorCounts).toEqual({
      green: 23,
      purple: 22,
      brown: 3,
      yellow: 0,
      other: 0,
      none: 0,
    });
    expect(analysis.severityCounts).toEqual({
      micro: 32,
      minor: 0,
      warning: 0,
      critical: 0,
    });
    expect(analysis.warnings).toEqual([]);
  });

  it("sorts top hitches by duration descending", async () => {
    const xml = await readFile(fixturePath, "utf8");
    const analysis = analyzeHitchesXml(xml, { topLimit: 3 });
    expect(analysis.topHitches.map((hitch) => hitch.durationMs)).toEqual([
      37.5, 33.3, 33.3,
    ]);
  });

  it("counts a non-green frame as a hitch even below the duration threshold", () => {
    const xml = `<trace-query-result><node><schema name="hitches-frame-lifetimes">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>frame-color</mnemonic></col>
    </schema>
    <row><start-time>0</start-time><duration>10000000</duration><event-concept>Green</event-concept></row>
    <row><start-time>10000000</start-time><duration>10000000</duration><event-concept>Purple</event-concept></row>
    <row><start-time>20000000</start-time><duration>10000000</duration><event-concept>Green</event-concept></row>
    </schema></node></trace-query-result>`;
    const analysis = analyzeHitchesXml(xml);
    expect(analysis.hitches).toBe(1);
    expect(analysis.colorCounts.purple).toBe(1);
    expect(analysis.blockMs).toBe(10);
  });

  it("counts a long green frame above 1.3x the median as a hitch", () => {
    const xml = `<trace-query-result><node><schema name="hitches-frame-lifetimes">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>frame-color</mnemonic></col>
    </schema>
    <row><start-time>0</start-time><duration>16000000</duration><event-concept>Green</event-concept></row>
    <row><start-time>16000000</start-time><duration>16000000</duration><event-concept>Green</event-concept></row>
    <row><start-time>32000000</start-time><duration>40000000</duration><event-concept>Green</event-concept></row>
  </schema></node></trace-query-result>`;
    const analysis = analyzeHitchesXml(xml);
    expect(analysis.hitches).toBe(1);
    expect(analysis.blockMs).toBe(40);
    expect(analysis.severityCounts.micro).toBe(1);
  });

  it("parses the legacy hitches table", () => {
    const xml = hangTableXml([
      { startNs: 1_000_000_000, durationNs: 12_500_000 },
      { startNs: 2_000_000_000, durationNs: 300_000_000 },
    ]);
    const analysis = analyzeHitchesXml(xml);
    expect(analysis.table).toBe("hitches");
    expect(analysis.hitches).toBe(2);
    expect(analysis.blockMs).toBe(300);
    expect(analysis.severityCounts).toEqual({
      micro: 1,
      minor: 0,
      warning: 1,
      critical: 0,
    });
    expect(analysis.topHitches[0].startMs).toBe(2000);
  });

  it("returns zero metrics for an empty table", () => {
    const xml = `<trace-query-result><node><schema name="hitches-frame-lifetimes"><col><mnemonic>start</mnemonic></col><col><mnemonic>duration</mnemonic></col></schema></node></trace-query-result>`;
    const analysis = analyzeHitchesXml(xml);
    expect(analysis.hitches).toBe(0);
    expect(analysis.blockMs).toBeNull();
    expect(analysis.warnings).toContain("No frame rows in the trace.");
  });

  it("rejects an unsupported table", () => {
    expect(() =>
      analyzeHitchesXml(
        `<trace-query-result><node><schema name="something-else"></schema></node></trace-query-result>`,
      ),
    ).toThrow(/Unsupported Animation Hitches table/);
  });
});

describe("classifyHitch", () => {
  it("uses the shared severity bands", () => {
    expect(classifyHitch(50)).toBe("micro");
    expect(classifyHitch(150)).toBe("minor");
    expect(classifyHitch(500)).toBe("warning");
    expect(classifyHitch(1500)).toBe("critical");
  });
});
