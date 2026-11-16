import { readFileSync } from "node:fs";

interface PackageMetadata {
  version: string;
}

/**
 * Report the version this build actually is.
 *
 * `package.json` is the single source of truth: the CLI's `--version` and the
 * MCP `serverInfo.version` both read through here. `src/version.ts` and
 * `dist/version.js` sit at the same depth relative to the package root, so the
 * `../package.json` lookup resolves identically before and after `tsc`.
 */
export function getVersion(): string {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const parsed = JSON.parse(raw) as Partial<PackageMetadata>;
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("package.json is missing a version field");
  }
  return parsed.version;
}

/**
 * Identity advertised during the MCP handshake. The server name stays
 * `performance-test-mcp` because existing registrations and logs key off it;
 * only the version is derived.
 */
export const SERVER_INFO = {
  name: "performance-test-mcp",
  version: getVersion(),
} as const;
