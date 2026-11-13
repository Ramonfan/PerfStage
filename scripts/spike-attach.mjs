#!/usr/bin/env node
/**
 * M0 spike: verify that instruments-mcp can attach to a real iOS device and
 * return parsed metrics. This is the riskiest assumption in the MVP plan, so
 * it is kept as a runnable script rather than a one-off shell command.
 *
 * Usage:
 *   node scripts/spike-attach.mjs \
 *     --device 00008150-001E49E40128C01C \
 *     --process NNIM \
 *     --template "Time Profiler" \
 *     --duration-ms 8000 \
 *     --out docs/spikes/attach-spike.json
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DEFAULTS = {
  server: "/Users/leigod/雷神/性能分析/instruments-mcp-server/dist/index.js",
  device: "00008150-001E49E40128C01C",
  process: "NNIM",
  launchPath: "",
  allProcesses: false,
  template: "Time Profiler",
  durationMs: 8000,
  out: "docs/spikes/attach-spike.json",
};

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--server":
        args.server = value;
        i += 1;
        break;
      case "--device":
        args.device = value;
        i += 1;
        break;
      case "--process":
        args.process = value;
        i += 1;
        break;
      case "--launch-path":
        args.launchPath = value;
        i += 1;
        break;
      case "--all-processes":
        args.allProcesses = true;
        break;
      case "--template":
        args.template = value;
        i += 1;
        break;
      case "--duration-ms":
        args.durationMs = Number(value);
        i += 1;
        break;
      case "--out":
        args.out = value;
        i += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return args;
}

function firstText(result) {
  const block = result?.content?.find((item) => item.type === "text");
  return block?.text ?? "";
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const transport = new StdioClientTransport({
    command: "node",
    args: [args.server],
    stderr: "pipe",
  });
  const client = new Client({ name: "perfstage-spike", version: "0.0.0" });
  const serverStderr = [];
  transport.stderr?.on("data", (chunk) => serverStderr.push(chunk.toString()));
  transport.onclose = () => serverStderr.push("[transport closed]");
  transport.onerror = (error) => serverStderr.push(`[transport error] ${error}`);
  client.onerror = (error) => serverStderr.push(`[client error] ${error}`);

  const startedAt = new Date().toISOString();
  const record = {
    startedAt,
    server: args.server,
    device: args.device,
    process: args.process,
    launchPath: args.launchPath || null,
    template: args.template,
    durationMs: args.durationMs,
    start: null,
    stop: null,
    error: null,
    serverStderr: [],
  };

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    record.tools = tools.tools.map((tool) => tool.name);

    const startResult = await client.callTool({
      name: "start_profiling",
      arguments: {
        device: args.device,
        ...(args.allProcesses
          ? {}
          : args.launchPath
            ? { launch_path: args.launchPath }
            : { process: args.process }),
        template: args.template,
        max_duration: "1m",
      },
    }, undefined, { timeout: 300000 });
    record.start = {
      isError: Boolean(startResult.isError),
      payload: parseJson(firstText(startResult)),
    };
    if (startResult.isError) {
      throw new Error(`start_profiling failed: ${firstText(startResult)}`);
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, args.durationMs));

    const stopResult = await client.callTool({
      name: "stop_profiling",
      arguments: {},
    }, undefined, { timeout: 300000 });
    record.stop = {
      isError: Boolean(stopResult.isError),
      payload: parseJson(firstText(stopResult)),
    };
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
  } finally {
    await client.close().catch(() => {});
    record.serverStderr = serverStderr.join("");
    record.finishedAt = new Date().toISOString();
    record.ok =
      !record.error &&
      record.start?.payload?.status === "recording" &&
      Boolean(record.stop?.payload?.tracePath);
  }

  const outPath = resolve(args.out);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(record, null, 2)}\n`);

  console.log(
    JSON.stringify(
      {
        ok: record.ok,
        error: record.error,
        tracePath: record.stop?.payload?.tracePath ?? null,
        startStatus: record.start?.payload?.status ?? null,
        out: outPath,
      },
      null,
      2,
    ),
  );

  process.exitCode = record.ok ? 0 : 1;
}

await main();
