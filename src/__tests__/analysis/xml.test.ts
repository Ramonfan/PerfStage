import { describe, expect, it } from "vitest";
import {
  columnFmt,
  columnText,
  parseTraceTable,
  parseXml,
  findFirst,
  collectElements,
} from "../../analysis/trace/xml.js";

const DEMO_XML = `<?xml version="1.0"?>
<trace-query-result>
  <node>
    <schema name="demo">
      <col><mnemonic>start</mnemonic><name>Start</name></col>
      <col><mnemonic>process</mnemonic><name>Process</name></col>
      <col><mnemonic>duration</mnemonic><name>Duration</name></col>
    </schema>
    <row>
      <start-time id="1" fmt="00:00.001.000">1000000</start-time>
      <process id="2" fmt="A &amp; B (42)"><pid id="3">42</pid></process>
      <duration id="4" fmt="5.00 ms">5000000</duration>
    </row>
    <row>
      <start-time ref="1"/>
      <process ref="2"/>
      <duration ref="4"/>
    </row>
    <row>
      <sentinel/>
      <sentinel/>
      <sentinel/>
    </row>
  </node>
</trace-query-result>`;

describe("parseXml", () => {
  it("keeps nested elements separate from their parent text", () => {
    const root = parseXml(DEMO_XML);
    const row = findFirst(root, "row");
    expect(row?.children.map((child) => child.tag)).toEqual([
      "start-time",
      "process",
      "duration",
    ]);
    const process = row?.children[1];
    expect(process?.attributes.fmt).toBe("A & B (42)");
    expect(process?.children[0].tag).toBe("pid");
  });

  it("decodes entities in text and attributes", () => {
    const root = parseXml(DEMO_XML);
    const process = collectElements(root, "process")[0];
    expect(process.text).toBe("");
    expect(process.attributes.fmt).toBe("A & B (42)");
  });
});

describe("parseTraceTable", () => {
  const table = parseTraceTable(DEMO_XML);

  it("reads schema mnemonics in order", () => {
    expect(table.schemaName).toBe("demo");
    expect(table.columns).toEqual(["start", "process", "duration"]);
    expect(table.rows).toHaveLength(3);
  });

  it("resolves id/ref references within and across rows", () => {
    const first = table.rows[0];
    const second = table.rows[1];
    expect(columnText(table, first, "start")).toBe("1000000");
    expect(columnFmt(table, first, "process")).toBe("A & B (42)");
    expect(columnText(table, first, "duration")).toBe("5000000");
    expect(columnText(table, second, "start")).toBe("1000000");
    expect(columnFmt(table, second, "process")).toBe("A & B (42)");
    expect(columnText(table, second, "duration")).toBe("5000000");
  });

  it("treats sentinel values as absent", () => {
    const missing = table.rows[2];
    expect(columnText(table, missing, "start")).toBeUndefined();
    expect(columnFmt(table, missing, "process")).toBeUndefined();
  });
});
