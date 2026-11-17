import { describe, expect, it } from "vitest";
import type { AppInstallation, CrashEntry } from "../../device/types.js";
import {
  classifyFreshCrashes,
  isAppScopedCrash,
} from "../../runner/execute.js";

/**
 * Crash attribution is the only thing standing between a noisy device and a
 * fabricated `new-crash` failure. These tests pin each branch directly: the
 * runner-level tests only prove that *some* App crash fails the Take, which
 * also passes if the identity comparison is removed entirely.
 */
const installation: AppInstallation = {
  bundleId: "com.example.app",
  name: "Example",
  processName: "Example",
  version: "1.0.0",
  containerUuid: "00000000-0000-0000-0000-000000000000",
};

function entry(id: string, process?: string): CrashEntry {
  return process === undefined ? { id } : { id, process };
}

describe("isAppScopedCrash", () => {
  it("treats the installed process name as app scope", () => {
    expect(isAppScopedCrash(entry("a.ips", "Example"), installation)).toBe(true);
  });

  it("treats the bundle id as app scope", () => {
    expect(isAppScopedCrash(entry("a.ips", "com.example.app"), installation)).toBe(
      true,
    );
  });

  it("treats a bundle-id extension process as app scope", () => {
    expect(
      isAppScopedCrash(entry("a.ips", "com.example.app.widget"), installation),
    ).toBe(true);
  });

  it("keeps a report without a process in app scope", () => {
    expect(isAppScopedCrash(entry("a.ips"), installation)).toBe(true);
    expect(isAppScopedCrash(entry("a.ips", "   "), installation)).toBe(true);
  });

  it.each([
    "SFA-ckks.json",
    "DTServiceHub.diskwrites_resource",
    "WiFiLQMMetrics",
    "locationd.diskwrites_resource",
    "proactive_event_tracker-com_apple_Trial-com_apple_triald",
    "xp_amp_app_usage_dnu",
  ])("treats %s as a system report", (process) => {
    expect(isAppScopedCrash(entry("system.ips", process), installation)).toBe(
      false,
    );
  });

  it("keeps an unknown process in app scope", () => {
    // Conservative by design: only the explicit allow-list is ignored.
    expect(isAppScopedCrash(entry("a.ips", "SpringBoard"), installation)).toBe(
      true,
    );
  });

  it("keeps JetsamEvent in app scope", () => {
    // Jetsam can describe our app being memory-killed.
    expect(isAppScopedCrash(entry("a.ips", "JetsamEvent"), installation)).toBe(
      true,
    );
  });
});

describe("classifyFreshCrashes", () => {
  it("splits new reports and never re-reports the baseline", () => {
    const known = new Set(["old.ips"]);
    const result = classifyFreshCrashes(
      [
        entry("old.ips", "SFA-ckks.json"),
        entry("new-app.ips", "Example"),
        entry("new-system.ips", "SFA-pcs.json"),
      ],
      known,
      installation,
    );
    expect(result.appScoped.map((item) => item.id)).toEqual(["new-app.ips"]);
    expect(result.system.map((item) => item.id)).toEqual(["new-system.ips"]);
  });

  it("keeps a new report without a process on the failing side", () => {
    const result = classifyFreshCrashes([entry("unknown.ips")], new Set(), installation);
    expect(result.appScoped.map((item) => item.id)).toEqual(["unknown.ips"]);
    expect(result.system).toEqual([]);
  });
});
