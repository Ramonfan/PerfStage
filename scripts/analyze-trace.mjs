#!/usr/bin/env node
/**
 * Analyze an existing xctrace file with PerfStage's own parsers.
 *
 * Usage:
 *   node scripts/analyze-trace.mjs --template hitches --trace /tmp/hitches.trace
 *   node scripts/analyze-trace.mjs --template launch --trace /tmp/launch.trace --process NN
 *   node scripts/analyze-trace.mjs --template memory --trace /tmp/actmon.trace --pid 6764
 *
 * This is the M0 replacement for delegating metric parsing to instruments-mcp:
 * the recorder only produces a trace, PerfStage reads it.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  analyzeAppLaunchTrace,
} from "../dist/analysis/parsers/app-launch.js";
import {
  analyzeActivityMonitorTrace,
} from "../dist/analysis/parsers/activity-monitor.js";
import {
  analyzeHitchesTrace,
} from "../dist/analysis/parsers/animation-hitches.js";

const DEFAULTS = {
  template: "launch",
  process: "",
  pid: undefined,
  table: "",
  out: "",
};

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--template":
        args.template = value;
        index += 1;
        break;
      case "--trace":
        args.trace = value;
        index += 1;
        break;
      case "--process":
        args.process = value;
        index += 1;
        break;
      case "--pid":
        args.pid = Number(value);
        index += 1;
        break;
      case "--table":
        args.table = value;
        index += 1;
        break;
      case "--out":
        args.out = value;
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }
  if (!args.trace) {
    throw new Error("--trace <path> is required");
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  let result;
  if (args.template === "hitches") {
    result = await analyzeHitchesTrace(args.trace, {
      ...(args.table ? { table: args.table } : {}),
    });
  } else if (args.template === "launch") {
    result = await analyzeAppLaunchTrace(args.trace, {
      ...(args.process ? { processName: args.process } : {}),
    });
  } else if (args.template === "memory") {
    const analysis = await analyzeActivityMonitorTrace(args.trace, {
      ...(args.pid !== undefined ? { pid: args.pid } : {}),
      ...(args.process ? { processName: args.process } : {}),
    });
    // Keep summaries for the selected process and the largest footprints, but
    // drop per-sample arrays for everything else: a raw all-processes trace can
    // contain hundreds of processes and would make the evidence file unusable.
    const selectedPid = analysis.pid;
    const topProcesses = [...analysis.processes]
      .sort((a, b) => b.summary.medianMiB - a.summary.medianMiB)
      .filter((process, index) => index < 12 || process.pid === selectedPid)
      .map(({ samples: _samples, ...rest }) => rest);
    result = {
      ...analysis,
      processes: topProcesses,
      processCount: analysis.processes.length,
    };
  } else {
    throw new Error(`Unsupported --template "${args.template}" (use hitches, launch or memory)`);
  }

  const payload = {
    analyzedAt: new Date().toISOString(),
    trace: resolve(args.trace),
    template: args.template,
    elapsedMs: Date.now() - startedAt,
    result,
  };

  if (args.out) {
    const outPath = resolve(args.out);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  }
  console.log(JSON.stringify(args.out ? { ...payload, result: undefined, out: resolve(args.out) } : payload, null, 2));
}

await main();
