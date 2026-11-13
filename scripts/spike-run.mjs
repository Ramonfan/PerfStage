#!/usr/bin/env node
/**
 * M0 spike: run the full loop by hand — start an Animation Hitches recording,
 * drive the app through mobile-mcp while it records, then stop and print the
 * parsed result.
 *
 * This is a prototype of the Runner, used only to validate that the two MCP
 * servers can run concurrently against one real device.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, writeFile } from "node:fs/promises";

const DEVICE = process.env.PERFSTAGE_DEVICE ?? "00008150-001E49E40128C01C";
const BUNDLE = process.env.PERFSTAGE_BUNDLE ?? "com.nndev.im";
const TEMPLATE = process.env.PERFSTAGE_TEMPLATE ?? "Animation Hitches";
const OUT = process.env.PERFSTAGE_OUT ?? "docs/spikes/spike-run-hitches.json";

const instruments = new StdioClientTransport({
  command: "node",
  args: ["/Users/leigod/雷神/性能分析/instruments-mcp-server/dist/index.js"],
  stderr: "pipe",
});
const mobile = new StdioClientTransport({
  command: "npx",
  args: ["-y", "@mobilenext/mobile-mcp@latest"],
  stderr: "pipe",
});

const collector = new Client({ name: "perfstage-spike-collector", version: "0" });
const driver = new Client({ name: "perfstage-spike-driver", version: "0" });

const text = (result) => result?.content?.find((item) => item.type === "text")?.text ?? "";
const json = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const record = { device: DEVICE, bundle: BUNDLE, template: TEMPLATE, start: null, stop: null, actions: [], error: null };

try {
  await Promise.all([collector.connect(instruments), driver.connect(mobile)]);

  const start = await collector.callTool({
    name: "start_profiling",
    arguments: { device: DEVICE, launch_path: BUNDLE, template: TEMPLATE, max_duration: "1m" },
  });
  record.start = { isError: Boolean(start.isError), payload: json(text(start)) };
  if (start.isError) throw new Error(text(start));

  // Let the app finish launching before driving the UI.
  await sleep(4000);

  for (let index = 0; index < 6; index += 1) {
    const swipe = await driver.callTool({
      name: "mobile_swipe_on_screen",
      arguments: { device: DEVICE, direction: "up", distance: 1400 },
    });
    record.actions.push({ index, isError: Boolean(swipe.isError), result: text(swipe).slice(0, 120) });
    await sleep(700);
  }
  for (let index = 0; index < 2; index += 1) {
    const swipe = await driver.callTool({
      name: "mobile_swipe_on_screen",
      arguments: { device: DEVICE, direction: "down", distance: 1400 },
    });
    record.actions.push({ index: 6 + index, isError: Boolean(swipe.isError), result: text(swipe).slice(0, 120) });
    await sleep(700);
  }

  const stop = await collector.callTool({ name: "stop_profiling", arguments: {} });
  record.stop = { isError: Boolean(stop.isError), payload: json(text(stop)) };
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
} finally {
  await Promise.all([collector.close().catch(() => {}), driver.close().catch(() => {})]);
}

await mkdir("docs/spikes", { recursive: true });
await writeFile(OUT, `${JSON.stringify(record, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      ok: !record.error && !record.stop?.isError,
      error: record.error,
      totalHangs: record.stop?.payload?.totalHangs ?? null,
      tracePath: record.stop?.payload?.tracePath ?? null,
      actions: record.actions.length,
      out: OUT,
    },
    null,
    2,
  ),
);
