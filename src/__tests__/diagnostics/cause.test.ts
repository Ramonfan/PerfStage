import { describe, expect, it } from "vitest";
import { extractDeviceFailureCause } from "../../diagnostics/cause.js";

describe("extractDeviceFailureCause", () => {
  it("prefers the app's fatal error over the kernel noise that caused it", () => {
    const log = [
      '{"process":"kernel","message":"fs_tx_enter_internal: disk2s2 logd: ENOSPC"}',
      '{"process":"NNIM","message":"os_unix.c:50058: (28) ftruncate(app_v1.sqlite-shm) - No space left on device"}',
      '{"process":"NNIM","message":"NNIM/DBBootstrap.swift:20: Fatal error: Database bootstrap failed: SQLite error 10: disk I/O error"}',
    ].join("\n");

    const cause = extractDeviceFailureCause(log);
    expect(cause).toContain("app fatal error");
    expect(cause).toContain("Database bootstrap failed");
  });

  it("falls back to a storage error when the app logged no fatal error", () => {
    const cause = extractDeviceFailureCause(
      '{"message":"ftruncate(.../app_v1.sqlite-shm) - No space left on device"}',
    );
    expect(cause).toContain("no space left on device");
  });

  it("recognizes a wedged instruments session", () => {
    expect(
      extractDeviceFailureCause(
        "* [Error] Failed to start the recording: Failed starting ktrace session.",
      ),
    ).toContain("instruments session");
  });

  it("returns null for a log with nothing actionable", () => {
    expect(
      extractDeviceFailureCause('{"message":"action scroll-up-1 executed"}'),
    ).toBeNull();
    expect(extractDeviceFailureCause("")).toBeNull();
    expect(extractDeviceFailureCause(undefined)).toBeNull();
  });

  it("caps the excerpt so a giant log line cannot bloat the report", () => {
    const cause = extractDeviceFailureCause(
      `Fatal error: ${"x".repeat(2000)}`,
      80,
    );
    expect(cause).not.toBeNull();
    expect(cause?.length).toBeLessThanOrEqual(80);
    expect(cause?.endsWith("…")).toBe(true);
  });
});
