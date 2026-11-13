import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
// Activity Monitor exports grow with recording length; 512 MiB keeps a
// multi-minute all-processes trace readable without truncation.
const DEFAULT_MAX_BUFFER = 512 * 1024 * 1024;

export class TraceExportError extends Error {
  constructor(message: string, readonly tracePath: string, readonly schema?: string) {
    super(message);
    this.name = "TraceExportError";
  }
}

function describeExecError(error: unknown): string {
  if (error instanceof Error) {
    const stderr = (error as Error & { stderr?: string }).stderr;
    const detail = typeof stderr === "string" ? stderr.trim() : "";
    return detail.length > 0 ? `${error.message}: ${detail}` : error.message;
  }
  return String(error);
}

/**
 * Export one trace table to XML via `xcrun xctrace export --xpath`.
 *
 * PerfStage deliberately owns metric parsing instead of delegating it to
 * `instruments-mcp`: the recorder is responsible for producing a trace, and
 * the analysis layer is the single place that knows how to read it.
 */
export async function exportTraceTable(
  tracePath: string,
  schema: string,
  options: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<string> {
  const xpath = `/trace-toc/run[@number="1"]/data/table[@schema="${schema}"]`;
  try {
    const { stdout } = await execFileAsync(
      "xcrun",
      ["xctrace", "export", "--input", tracePath, "--xpath", xpath],
      {
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        encoding: "utf8",
      },
    );
    if (!stdout.includes("<trace-query-result") && !stdout.includes("<trace-toc")) {
      throw new Error(`xctrace returned no table for schema "${schema}"`);
    }
    return stdout;
  } catch (error) {
    throw new TraceExportError(
      `Failed to export "${schema}" from ${tracePath}: ${describeExecError(error)}`,
      tracePath,
      schema,
    );
  }
}

/** List the table schemas present in a trace (from the TOC export). */
export async function listTraceTables(
  tracePath: string,
  options: { timeoutMs?: number } = {},
): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "xcrun",
      ["xctrace", "export", "--input", tracePath, "--toc"],
      {
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: DEFAULT_MAX_BUFFER,
        encoding: "utf8",
      },
    );
    const schemas = new Set<string>();
    for (const match of stdout.matchAll(/<table\b[^>]*\bschema="([^"]+)"/g)) {
      schemas.add(match[1]);
    }
    return [...schemas];
  } catch (error) {
    throw new TraceExportError(
      `Failed to read the trace TOC for ${tracePath}: ${describeExecError(error)}`,
      tracePath,
    );
  }
}
