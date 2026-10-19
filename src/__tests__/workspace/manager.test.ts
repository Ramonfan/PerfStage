import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceManager } from "../../workspace/manager.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "workspace-mgr-"));
  roots.push(dir);
  return dir;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function listDir(path: string): Promise<string[]> {
  return readdir(path);
}

beforeEach(() => {
  while (roots.length > 0) {
    roots.pop();
  }
});

afterEach(async () => {
  for (const dir of roots.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("createWorkspaceManager.inspect", () => {
  it("reports an uninitialized workspace without creating files", async () => {
    const root = await makeRoot();
    const manager = createWorkspaceManager(root);
    const state = await manager.inspect();
    expect(state.kind).toBe("uninitialized");
    if (state.kind === "uninitialized") {
      expect(state.workspaceRoot).toBe(root);
      expect(state.configPath).toBe(join(root, ".performance-test", "config.json"));
    }
    await expect(access(join(root, ".performance-test"))).rejects.toThrow();
  });

  it("returns a ready state for a valid workspace with default directories", async () => {
    const root = await makeRoot();
    const manager = createWorkspaceManager(root);
    const initialized = await manager.initialize({});
    const state = await manager.inspect();
    expect(state.kind).toBe("ready");
    if (state.kind === "ready") {
      expect(state.workspaceRoot).toBe(root);
      expect(state.configPath).toBe(join(root, ".performance-test", "config.json"));
      expect(state.config.schemaVersion).toBe(1);
      expect(state.paths.scenarioDirectory).toBe(
        join(root, ".performance-test", "scenarios"),
      );
      expect(state.paths.runsDirectory).toBe(
        join(root, ".performance-test", "runs"),
      );
    }
    expect(initialized.firstInitialization).toBe(true);
  });

  it("returns invalid for malformed JSON in the config", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".performance-test"), { recursive: true });
    await writeFile(
      join(root, ".performance-test", "config.json"),
      "{ this is not json",
      "utf8",
    );
    const manager = createWorkspaceManager(root);
    const state = await manager.inspect();
    expect(state.kind).toBe("invalid");
    if (state.kind === "invalid") {
      expect(state.reason).toMatch(/JSON|parse|malformed/i);
    }
  });

  it("returns invalid for an unsupported schema version", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".performance-test"), { recursive: true });
    await writeFile(
      join(root, ".performance-test", "config.json"),
      JSON.stringify({
        schemaVersion: 99,
        scenarioDirectory: ".performance-test/scenarios",
        runsDirectory: ".performance-test/runs",
      }),
      "utf8",
    );
    const manager = createWorkspaceManager(root);
    const state = await manager.inspect();
    expect(state.kind).toBe("invalid");
    if (state.kind === "invalid") {
      expect(state.reason).toMatch(/schema|version/i);
    }
  });

  it("returns invalid when a configured directory escapes the workspace", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".performance-test"), { recursive: true });
    await writeFile(
      join(root, ".performance-test", "config.json"),
      JSON.stringify({
        schemaVersion: 1,
        scenarioDirectory: "../escape",
        runsDirectory: ".performance-test/runs",
      }),
      "utf8",
    );
    const manager = createWorkspaceManager(root);
    const state = await manager.inspect();
    expect(state.kind).toBe("invalid");
    if (state.kind === "invalid") {
      expect(state.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("createWorkspaceManager.initialize", () => {
  it("initializes idempotently without replacing existing config or scenario", async () => {
    const root = await makeRoot();
    const manager = createWorkspaceManager(root);
    const first = await manager.initialize({
      bundleId: "com.example.app",
      appName: "Example",
    });
    await writeFile(
      join(root, ".performance-test", "scenarios", "custom.yaml"),
      "id: custom\n",
      "utf8",
    );
    const before = await readFile(first.configPath, "utf8");
    const second = await manager.initialize({ bundleId: "com.other.app" });
    const after = await readFile(first.configPath, "utf8");
    expect(after).toBe(before);
    expect(
      await exists(join(root, ".performance-test", "scenarios", "custom.yaml")),
    ).toBe(true);
    expect(second.firstInitialization).toBe(false);
  });

  it("writes the default config with mode 0o600 on first initialization", async () => {
    const root = await makeRoot();
    const manager = createWorkspaceManager(root);
    await manager.initialize({});
    const configPath = join(root, ".performance-test", "config.json");
    const contents = await readFile(configPath, "utf8");
    expect(JSON.parse(contents)).toEqual({
      schemaVersion: 1,
      scenarioDirectory: ".performance-test/scenarios",
      runsDirectory: ".performance-test/runs",
    });
  });

  it("merges bundleId and appName into the persisted config", async () => {
    const root = await makeRoot();
    const manager = createWorkspaceManager(root);
    await manager.initialize({
      bundleId: "com.example.app",
      appName: "Example",
    });
    const configPath = join(root, ".performance-test", "config.json");
    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    expect(parsed.app).toEqual({ bundleId: "com.example.app", name: "Example" });
  });

  it("creates scenario and runs directories with the data dir on first init", async () => {
    const root = await makeRoot();
    const manager = createWorkspaceManager(root);
    await manager.initialize({});
    expect(await exists(join(root, ".performance-test"))).toBe(true);
    expect(await exists(join(root, ".performance-test", "scenarios"))).toBe(true);
    expect(await exists(join(root, ".performance-test", "runs"))).toBe(true);
  });

  it("creates missing directories on re-init without touching existing ones", async () => {
    const root = await makeRoot();
    const manager = createWorkspaceManager(root);
    await manager.initialize({});
    // Remove only the runs directory; scenarios must be preserved untouched.
    await rm(join(root, ".performance-test", "runs"), { recursive: true, force: true });
    const markerPath = join(root, ".performance-test", "scenarios", "marker.txt");
    await writeFile(markerPath, "keep me", "utf8");
    const second = await manager.initialize({});
    expect(second.firstInitialization).toBe(false);
    expect(await exists(join(root, ".performance-test", "runs"))).toBe(true);
    expect(await readFile(markerPath, "utf8")).toBe("keep me");
  });

  it("does not copy default scenarios when copyDefaultScenarios is omitted", async () => {
    const root = await makeRoot();
    const manager = createWorkspaceManager(root);
    await manager.initialize({});
    const entries = await listDir(join(root, ".performance-test", "scenarios"));
    expect(entries).toEqual([]);
  });

  it("copies embedded default scenarios only when the destination file is missing", async () => {
    const root = await makeRoot();
    const manager = createWorkspaceManager(root);
    await manager.initialize({ copyDefaultScenarios: true });
    const scenarioDir = join(root, ".performance-test", "scenarios");
    const initialEntries = await listDir(scenarioDir);
    expect(initialEntries.length).toBeGreaterThan(0);

    // Add a custom scenario that should not be overwritten.
    const customPath = join(scenarioDir, "custom.yaml");
    await writeFile(customPath, "id: custom\n", "utf8");

    await manager.initialize({ copyDefaultScenarios: true });
    const finalEntries = await listDir(scenarioDir);
    expect(finalEntries).toContain("custom.yaml");
    expect(await readFile(customPath, "utf8")).toBe("id: custom\n");
  });

  it("rejects an unparsable existing config", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".performance-test"), { recursive: true });
    await writeFile(
      join(root, ".performance-test", "config.json"),
      "{ broken json",
      "utf8",
    );
    const manager = createWorkspaceManager(root);
    await expect(
      manager.initialize({ bundleId: "com.example.app" }),
    ).rejects.toThrow(/invalid|json|parse/i);
  });

  it("returns the absolute config path on every call", async () => {
    const root = await makeRoot();
    const manager = createWorkspaceManager(root);
    const first = await manager.initialize({});
    const second = await manager.initialize({});
    expect(first.configPath).toBe(join(root, ".performance-test", "config.json"));
    expect(second.configPath).toBe(first.configPath);
    expect(dirname(first.configPath)).toBe(join(root, ".performance-test"));
  });
});

describe("createWorkspaceManager.requireReady", () => {
  it("returns the ready context for an initialized workspace", async () => {
    const root = await makeRoot();
    const manager = createWorkspaceManager(root);
    await manager.initialize({});
    const ready = await manager.requireReady();
    expect(ready.workspaceRoot).toBe(root);
    expect(ready.configPath).toBe(join(root, ".performance-test", "config.json"));
    expect(ready.config.schemaVersion).toBe(1);
    expect(ready.paths.scenarioDirectory).toBe(
      join(root, ".performance-test", "scenarios"),
    );
  });

  it("throws a typed error with initialize_performance_workspace when uninitialized", async () => {
    const root = await makeRoot();
    const manager = createWorkspaceManager(root);
    let caught: unknown;
    try {
      await manager.requireReady();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("WorkspaceNotReadyError");
    expect((caught as Error).message).toContain("initialize_performance_workspace");
  });

  it("throws with the config path and reason for an invalid workspace", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".performance-test"), { recursive: true });
    await writeFile(
      join(root, ".performance-test", "config.json"),
      "{ broken json",
      "utf8",
    );
    const manager = createWorkspaceManager(root);
    let caught: unknown;
    try {
      await manager.requireReady();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("WorkspaceInvalidError");
    expect((caught as Error).message).toContain(
      join(root, ".performance-test", "config.json"),
    );
    expect((caught as Error).message.length).toBeGreaterThan(0);
  });
});

