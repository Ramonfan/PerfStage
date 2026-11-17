import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  alignHitchWindow,
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

function frameTableXml(
  frames: Array<{ startMs: number; durationMs: number; color: string }>,
): string {
  const rowXml = frames
    .map(
      (frame, index) =>
        `<row><start-time id="s${index}">${Math.round(
          frame.startMs * 1e6,
        )}</start-time><duration id="d${index}">${Math.round(
          frame.durationMs * 1e6,
        )}</duration><event-concept id="c${index}">${frame.color}</event-concept></row>`,
    )
    .join("");
  return `<trace-query-result><node><schema name="hitches-frame-lifetimes"><col><mnemonic>start</mnemonic></col><col><mnemonic>duration</mnemonic></col><col><mnemonic>frame-color</mnemonic></col></schema>${rowXml}</node></trace-query-result>`;
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

  it("keeps only frames inside the action window and says how many it dropped", () => {
    // A `--launch` recording: the cold-launch burst (0.5s) and the tail before
    // the session stops fall outside the scene window, so they must not be
    // scored as scene hitches.
    const xml = frameTableXml([
      { startMs: 500, durationMs: 300, color: "Purple" },
      { startMs: 5_000, durationMs: 50, color: "Purple" },
      { startMs: 10_000, durationMs: 16, color: "Green" },
      { startMs: 12_000, durationMs: 16, color: "Green" },
      // Starts exactly at the exclusive end: it belongs to the next window.
      { startMs: 14_000, durationMs: 50, color: "Purple" },
    ]);

    const analysis = analyzeHitchesXml(xml, {
      window: { fromMs: 10_000, toMs: 14_000 },
    });

    expect(analysis.frameCount).toBe(2);
    expect(analysis.hitches).toBe(0);
    expect(analysis.blockMs).toBe(0);
    expect(analysis.window).toEqual({
      fromMs: 10_000,
      toMs: 14_000,
      framesOutside: 3,
    });
    expect(analysis.warnings).toEqual([]);
  });

  it("rejects a window that cannot contain a measurement", () => {
    const xml = frameTableXml([
      { startMs: 1_000, durationMs: 16, color: "Green" },
    ]);
    expect(() =>
      analyzeHitchesXml(xml, { window: { fromMs: 1_000, toMs: 1_000 } }),
    ).toThrow(/window is empty/);
    expect(() =>
      analyzeHitchesXml(xml, { window: { fromMs: 2_000, toMs: 1_000 } }),
    ).toThrow(/window is empty/);
  });

  it("warns instead of reporting a clean score when the window misses every frame", () => {
    const xml = frameTableXml([
      { startMs: 1_000, durationMs: 16, color: "Green" },
      { startMs: 2_000, durationMs: 16, color: "Green" },
    ]);
    const analysis = analyzeHitchesXml(xml, {
      window: { fromMs: 30_000, toMs: 31_000 },
    });

    expect(analysis.frameCount).toBe(0);
    expect(analysis.hitches).toBe(0);
    expect(analysis.window?.framesOutside).toBe(2);
    // A zero here without a warning would look like a perfect score.
    expect(analysis.warnings.join(" ")).toContain("No frames between");
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

  it("applies the window to the legacy hitches table too", () => {
    const xml = hangTableXml([
      { startNs: 1_000_000_000, durationNs: 300_000_000 },
      { startNs: 10_000_000_000, durationNs: 40_000_000 },
    ]);
    const analysis = analyzeHitchesXml(xml, {
      window: { fromMs: 5_000, toMs: 11_000 },
    });
    expect(analysis.hitches).toBe(1);
    expect(analysis.blockMs).toBe(40);
    expect(analysis.window?.framesOutside).toBe(1);
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

describe("alignHitchWindow", () => {
  it("exposes the frame timeline when the declared window misses", () => {
    const xml = frameTableXml([
      { startMs: 2_000, durationMs: 16, color: "Green" },
      { startMs: 2_100, durationMs: 16, color: "Green" },
      { startMs: 9_000, durationMs: 16, color: "Green" },
    ]);
    const analysis = analyzeHitchesXml(xml, {
      window: { fromMs: 20_000, toMs: 21_000 },
    });
    expect(analysis.windowMiss).toEqual({
      window: { fromMs: 20_000, toMs: 21_000 },
      frameStartsMs: [2_000, 2_100, 9_000],
      totalFrames: 3,
    });
  });

  it("shifts to the frame cluster the declared window missed", () => {
    const miss = {
      window: { fromMs: 10_000, toMs: 11_000 },
      frameStartsMs: [9_000, 9_050, 9_120, 9_200],
      totalFrames: 4,
    };
    const result = alignHitchWindow(miss);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alignment.shiftMs).toBe(-1_000);
    expect(result.alignment.window).toEqual({ fromMs: 9_000, toMs: 10_000 });
    expect(result.alignment.frameCount).toBe(4);
  });

  it("is deterministic across repeated calls", () => {
    const miss = {
      window: { fromMs: 10_000, toMs: 11_000 },
      frameStartsMs: [9_200, 9_000, 9_120, 9_050],
      totalFrames: 4,
    };
    const first = alignHitchWindow(miss);
    const second = alignHitchWindow(miss);
    expect(second).toEqual(first);
    expect(first.ok && first.alignment.window).toEqual({
      fromMs: 9_000,
      toMs: 10_000,
    });
  });

  it("refuses a shift larger than one window width", () => {
    const miss = {
      window: { fromMs: 20_000, toMs: 21_000 },
      frameStartsMs: [2_000, 2_050],
      totalFrames: 2,
    };
    const result = alignHitchWindow(miss);
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining("within 1000ms"),
    });
  });

  it("never aligns to the cold-launch burst", () => {
    const miss = {
      window: { fromMs: 2_000, toMs: 3_000 },
      frameStartsMs: [100, 150, 200],
      totalFrames: 3,
    };
    const result = alignHitchWindow(miss);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("first 1000ms");
  });

  it("requires at least two frames in the candidate window", () => {
    const miss = {
      window: { fromMs: 10_000, toMs: 11_000 },
      frameStartsMs: [9_000],
      totalFrames: 1,
    };
    expect(alignHitchWindow(miss).ok).toBe(false);
  });

  it("reports a missing timeline instead of inventing a shift", () => {
    const result = alignHitchWindow({
      window: { fromMs: 10_000, toMs: 11_000 },
      frameStartsMs: [],
      totalFrames: 0,
    });
    expect(result).toEqual({
      ok: false,
      reason: "the trace contains no usable frame timestamps",
    });
  });

  it("keeps the startup-phase boundary as a hard floor", () => {
    // 1000ms is the first offset that is not cold launch.
    const atBoundary = alignHitchWindow({
      window: { fromMs: 2_000, toMs: 3_000 },
      frameStartsMs: [1_000, 1_050],
      totalFrames: 2,
    });
    expect(atBoundary.ok).toBe(true);
    if (!atBoundary.ok) return;
    expect(atBoundary.alignment.window).toEqual({
      fromMs: 1_000,
      toMs: 2_000,
    });
  });

  it("never starts a candidate before the startup-phase boundary", () => {
    const justBefore = alignHitchWindow({
      window: { fromMs: 2_000, toMs: 3_000 },
      frameStartsMs: [999, 1_010],
      totalFrames: 2,
    });
    // Only the 999ms candidate would fit the width; it is startup, so no
    // candidate remains (1_010ms alone is below the two-frame minimum).
    expect(justBefore.ok).toBe(false);
  });
});

describe("legacy hitches table", () => {
  it("does not treat an empty hang table as a window miss", () => {
    const analysis = analyzeHitchesXml(hangTableXml([]), {
      window: { fromMs: 1_000, toMs: 2_000 },
    });
    // Zero hang rows in the window is a valid smooth result; it must not feed
    // the frame-timeline alignment path.
    expect(analysis.hitches).toBe(0);
    expect(analysis.windowMiss).toBeUndefined();
    expect(analysis.warnings.join(" ")).not.toContain("No frames between");
  });

  it("warns when every hang row falls outside the declared window", () => {
    const analysis = analyzeHitchesXml(
      hangTableXml([
        { startNs: 500_000_000, durationNs: 40_000_000 },
        { startNs: 600_000_000, durationNs: 30_000_000 },
      ]),
      { window: { fromMs: 2_000, toMs: 3_000 } },
    );
    // The trace did hang, just not where the window was declared. A bare
    // `hitches = 0` would read as healthy, so the mismatch must be surfaced.
    expect(analysis.hitches).toBe(0);
    expect(analysis.windowMiss).toBeUndefined();
    expect(analysis.window?.framesOutside).toBe(2);
    expect(analysis.warnings.join(" ")).toContain(
      "fall outside the declared window",
    );
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
