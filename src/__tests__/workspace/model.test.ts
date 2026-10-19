import { describe, expect, it } from "vitest";
import {
  defaultWorkspaceConfig,
  type WorkspaceConfig,
  workspaceConfigSchema,
} from "../../workspace/model.js";

describe("workspaceConfigSchema", () => {
  it("accepts only schemaVersion 1 and workspace-relative directories", () => {
    expect(
      workspaceConfigSchema.parse({
        schemaVersion: 1,
        scenarioDirectory: ".performance-test/scenarios",
        runsDirectory: ".performance-test/runs",
      }).schemaVersion,
    ).toBe(1);
    expect(() =>
      workspaceConfigSchema.parse({
        schemaVersion: 2,
        scenarioDirectory: ".performance-test/scenarios",
        runsDirectory: ".performance-test/runs",
      }),
    ).toThrow();
  });

  it("accepts an optional app block with bundleId and name", () => {
    const parsed = workspaceConfigSchema.parse({
      schemaVersion: 1,
      app: { bundleId: "com.example.app", name: "Example" },
      scenarioDirectory: ".performance-test/scenarios",
      runsDirectory: ".performance-test/runs",
    });
    expect(parsed.app?.bundleId).toBe("com.example.app");
    expect(parsed.app?.name).toBe("Example");
  });

  it("rejects an unknown top-level field", () => {
    expect(() =>
      workspaceConfigSchema.parse({
        schemaVersion: 1,
        scenarioDirectory: ".performance-test/scenarios",
        runsDirectory: ".performance-test/runs",
        extra: "no",
      }),
    ).toThrow();
  });

  it("rejects an empty directory path", () => {
    expect(() =>
      workspaceConfigSchema.parse({
        schemaVersion: 1,
        scenarioDirectory: "",
        runsDirectory: ".performance-test/runs",
      }),
    ).toThrow();
  });
});

describe("defaultWorkspaceConfig", () => {
  it("returns schemaVersion 1 with the standard directories", () => {
    const config: WorkspaceConfig = defaultWorkspaceConfig();
    expect(config).toEqual({
      schemaVersion: 1,
      scenarioDirectory: ".performance-test/scenarios",
      runsDirectory: ".performance-test/runs",
    });
  });

  it("produces a config that passes its own schema", () => {
    const config = defaultWorkspaceConfig();
    expect(() => workspaceConfigSchema.parse(config)).not.toThrow();
  });
});
