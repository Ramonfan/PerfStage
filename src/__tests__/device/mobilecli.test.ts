import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findMobilecliBinary,
  logStreamExitError,
  parseInstallUrl,
  parseMobilecliJson,
} from "../../device/mobilecli.js";
import { DeviceError } from "../../device/types.js";

describe("parseMobilecliJson", () => {
  it("unwraps the status/data envelope", () => {
    const data = parseMobilecliJson<{ packageName: string }>(
      JSON.stringify({
        status: "ok",
        data: { packageName: "com.nndev.im" },
      }),
      "apps foreground",
    );
    expect(data.packageName).toBe("com.nndev.im");
  });

  it("treats a non-ok status as a failure even on exit 0", () => {
    expect(() =>
      parseMobilecliJson(
        JSON.stringify({ status: "error", error: { message: "device offline" } }),
        "apps launch",
      ),
    ).toThrow(DeviceError);
  });

  it("rejects empty output instead of returning undefined", () => {
    expect(() => parseMobilecliJson("", "device logs")).toThrow(/no output/);
  });

  it("tolerates a warning line before the JSON body", () => {
    const data = parseMobilecliJson<{ elements: unknown[] }>(
      "warning: agent already running\n" +
        JSON.stringify({ status: "ok", data: { elements: [] } }),
      "dump ui",
    );
    expect(data.elements).toEqual([]);
  });

  it("reports malformed JSON as a device error", () => {
    expect(() => parseMobilecliJson("{not json", "dump ui")).toThrow(DeviceError);
  });
});

describe("findMobilecliBinary", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "perfstage-mobilecli-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("prefers an explicit PERFSTAGE_MOBILECLI path", async () => {
    const binary = join(root, "mobilecli");
    await writeFile(binary, "#!/bin/sh\n", { mode: 0o755 });
    expect(findMobilecliBinary({ PERFSTAGE_MOBILECLI: binary })).toBe(binary);
  });

  it("falls back to PATH before scanning the npx cache", async () => {
    const bin = join(root, "bin");
    await writeFile(join(root, "placeholder"), "", "utf8");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "mobilecli"), "#!/bin/sh\n", { mode: 0o755 });
    expect(
      findMobilecliBinary({ PATH: bin, HOME: join(root, "home") }),
    ).toBe(join(bin, "mobilecli"));
  });

  it("explains how to install mobilecli when nothing is found", () => {
    expect(() =>
      findMobilecliBinary({ PATH: "/nonexistent", HOME: join(root, "home") }),
    ).toThrow(/PERFSTAGE_MOBILECLI/);
  });
});

describe("parseInstallUrl", () => {
  it("returns the container UUID and executable name", () => {
    expect(
      parseInstallUrl(
        "file:///private/var/containers/Bundle/Application/B224D589-5720-4605-A245-60800386CE83/NNIM.app/NNIM",
      ),
    ).toEqual({
      containerUuid: "B224D589-5720-4605-A245-60800386CE83",
      processName: "NNIM",
    });
  });

  it("falls back to the .app basename when the URL has no executable segment", () => {
    expect(
      parseInstallUrl(
        "file:///private/var/containers/Bundle/Application/533869D3-8873-4E32-9F1E-AE8743C14350/NNIM.app",
      ),
    ).toEqual({
      containerUuid: "533869D3-8873-4E32-9F1E-AE8743C14350",
      processName: "NNIM",
    });
  });

  it("rejects a URL that is not an installed app", () => {
    expect(parseInstallUrl("file:///tmp/whatever")).toBeNull();
  });
});

describe("logStreamExitError", () => {
  it("stays quiet when the stream was stopped by the Runner", () => {
    expect(logStreamExitError(null)).toBeUndefined();
  });

  it("reports an early exit code as truncated evidence", () => {
    expect(logStreamExitError({ code: 0, signal: null })).toMatch(
      /ended before the Take finished \(exit 0\).*incomplete/,
    );
  });

  it("reports an early signal without inventing an exit code", () => {
    expect(logStreamExitError({ code: null, signal: "SIGKILL" })).toMatch(
      /signal SIGKILL/,
    );
  });
});

describe("resolvePid container selection", () => {
  let root: string;
  let fakeXcrun: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "perfstage-xcrun-"));
    fakeXcrun = join(root, "xcrun");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function driverFor(listing: string) {
    await writeFile(
      fakeXcrun,
      ["#!/bin/bash", `cat <<'LIST'`, listing.trim(), "LIST", ""].join("\n"),
      { mode: 0o755 },
    );
    const { createMobilecliDriver } = await import("../../device/mobilecli.js");
    return createMobilecliDriver({
      binary: join(root, "mobilecli"),
      xcrun: fakeXcrun,
    });
  }

  const TARGET = "11111111-1111-1111-1111-111111111111";
  const OTHER = "22222222-2222-2222-2222-222222222222";

  it("picks the requested container even when another build runs the same executable", async () => {
    // Two installs of the same app is a normal device state: the hitches pass
    // launches by bundle id (D15) and the memory pass selects the exact pid,
    // so only the container UUID matters.
    const driver = await driverFor(`
  500 /private/var/containers/Bundle/Application/${TARGET}/NNIM.app/NNIM
  501 /private/var/containers/Bundle/Application/${OTHER}/NNIM.app/NNIM
`);
    await expect(driver.resolvePid("device", TARGET)).resolves.toBe(500);
    await expect(driver.resolvePid("device", OTHER)).resolves.toBe(501);
  });

  it("returns the pid when the executable name is unique", async () => {
    const driver = await driverFor(`
  500 /private/var/containers/Bundle/Application/${TARGET}/NNIM.app/NNIM
  123 /System/Library/CoreServices/SpringBoard.app/SpringBoard
`);
    await expect(driver.resolvePid("device", TARGET)).resolves.toBe(500);
  });

  it("returns null when the app is not running", async () => {
    const driver = await driverFor(`
  123 /System/Library/CoreServices/SpringBoard.app/SpringBoard
`);
    await expect(driver.resolvePid("device", TARGET)).resolves.toBeNull();
  });
});

/**
 * A device command that never yields must not hang the Take.
 *
 * M3 hit this for real: `apps foreground` was killed at its 60s timeout but a
 * grandchild kept the inherited stdout pipe open, so Node's `close` event
 * never fired and the recording stayed open for nine minutes
 * (docs/m3-validation.md §4.10).
 */
describe("mobilecli command settling", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "perfstage-mobilecli-settle-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function driverFor(script: string[], timeoutMs = 5_000) {
    const binary = join(root, "mobilecli");
    await writeFile(binary, ["#!/bin/bash", ...script, ""].join("\n"), {
      mode: 0o755,
    });
    const { createMobilecliDriver } = await import("../../device/mobilecli.js");
    return createMobilecliDriver({ binary, timeoutMs });
  }

  it("ignores a grandchild that keeps stdout open", async () => {
    const driver = await driverFor([
      "printf '{\"status\":\"ok\",\"data\":{\"packageName\":\"com.nndev.im\"}}\\n'",
      "sleep 30 &",
      "exit 0",
    ]);

    const started = Date.now();
    await expect(driver.foreground("device")).resolves.toMatchObject({
      bundleId: "com.nndev.im",
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("rejects on timeout instead of waiting for close", async () => {
    const driver = await driverFor(["sleep 30"], 150);

    const started = Date.now();
    await expect(driver.foreground("device")).rejects.toThrow(
      /did not finish within 150ms/,
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
