import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  parseAppLaunchTable,
  parseDyldActivityTable,
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
