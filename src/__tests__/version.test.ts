import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { main } from "../cli/index.js";
import { SERVER_INFO, getVersion } from "../version.js";

const packageVersion = (
  JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;

describe("release version identity", () => {
  it("reads the version from package.json", () => {
    expect(getVersion()).toBe(packageVersion);
  });

  it("advertises the same version over MCP", () => {
    expect(SERVER_INFO.name).toBe("performance-test-mcp");
    expect(SERVER_INFO.version).toBe(getVersion());
  });

  it("prints the same version from the CLI", async () => {
    const lines: string[] = [];
    const code = await main(["--version"], {
      io: {
        out: (line) => lines.push(line),
        err: (line) => lines.push(line),
      },
    });
    expect(code).toBe(0);
    expect(lines).toEqual([`perfstage ${packageVersion}`]);
  });

  it("fails loudly when package.json has no version", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      readFileSync: () => JSON.stringify({ name: "perfstage-mcp" }),
    }));
    try {
      await expect(import("../version.js")).rejects.toThrow(
        /missing a version field/,
      );
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
});
