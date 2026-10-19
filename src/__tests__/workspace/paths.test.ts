import {
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertNoSymlinkEscape,
  assertPathInsideWorkspace,
  assertWorkspaceRelativePath,
  resolveWorkspacePaths,
  workspaceRootFromCwd,
} from "../../workspace/paths.js";
import { defaultWorkspaceConfig } from "../../workspace/model.js";

const roots: string[] = [];

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "workspace-paths-"));
  roots.push(dir);
  await mkdir(join(dir, ".performance-test"), { recursive: true });
  return dir;
}

beforeEach(() => {
  // Reset between tests; mkdtemp accumulates in `roots` for cleanup.
  while (roots.length > 0) {
    roots.pop();
  }
});

afterEach(async () => {
  for (const dir of roots.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("assertWorkspaceRelativePath", () => {
  it("rejects absolute and parent-escaping paths", () => {
    expect(() =>
      assertWorkspaceRelativePath("/tmp/project", "/tmp/other", "runs"),
    ).toThrow();
    expect(() =>
      assertWorkspaceRelativePath(
        "/tmp/project",
        ".performance-test/../other",
        "runs",
      ),
    ).toThrow();
  });

  it("rejects an empty string", () => {
    expect(() =>
      assertWorkspaceRelativePath("/tmp/project", "", "runs"),
    ).toThrow();
  });

  it("rejects a parent escape expressed with POSIX segments", () => {
    expect(() =>
      assertWorkspaceRelativePath(
        "/tmp/project",
        ".performance-test/scenarios/../../escape",
        "scenarios",
      ),
    ).toThrow();
  });

  it("accepts a path nested inside .performance-test", () => {
    const result = assertWorkspaceRelativePath(
      "/tmp/project",
      ".performance-test/scenarios",
      "scenarios",
    );
    expect(result).toBe(`.performance-test${sep}scenarios`);
  });

  it("rejects a path that escapes via .. after resolution", () => {
    expect(() =>
      assertWorkspaceRelativePath("/tmp/project", "scenarios", "scenarios"),
    ).toThrow();
  });
});

describe("assertPathInsideWorkspace", () => {
  it("accepts paths that remain inside the workspace", () => {
    expect(() =>
      assertPathInsideWorkspace(
        join(sep, "tmp", "project", "foo"),
        join(sep, "tmp", "project"),
      ),
    ).not.toThrow();
  });

  it("rejects paths that escape the workspace", () => {
    expect(() =>
      assertPathInsideWorkspace(
        join(sep, "tmp", "other", "foo"),
        join(sep, "tmp", "project"),
      ),
    ).toThrow();
  });

  it("rejects absolute paths that differ only by a parent reference", () => {
    expect(() =>
      assertPathInsideWorkspace(
        join(sep, "tmp", "project", "..", "other"),
        join(sep, "tmp", "project"),
      ),
    ).toThrow();
  });
});

describe("workspaceRootFromCwd", () => {
  it("returns the directory that owns .performance-test when it exists", async () => {
    const workspace = await makeWorkspace();
    const nested = join(workspace, "src", "deep");
    await mkdir(nested, { recursive: true });
    expect(workspaceRootFromCwd(nested)).toBe(workspace);
  });

  it("returns the cwd unchanged when no .performance-test ancestor exists", async () => {
    const orphan = await mkdtemp(join(tmpdir(), "workspace-orphan-"));
    roots.push(orphan);
    await mkdir(join(orphan, "src"), { recursive: true });
    expect(workspaceRootFromCwd(join(orphan, "src"))).toBe(join(orphan, "src"));
  });
});

describe("resolveWorkspacePaths", () => {
  it("returns workspaceRoot, scenarioDirectory, and runsDirectory under .performance-test", async () => {
    const workspace = await makeWorkspace();
    const resolved = resolveWorkspacePaths(workspace, defaultWorkspaceConfig());
    expect(resolved.workspaceRoot).toBe(workspace);
    expect(resolved.scenarioDirectory).toBe(
      join(workspace, ".performance-test", "scenarios"),
    );
    expect(resolved.runsDirectory).toBe(
      join(workspace, ".performance-test", "runs"),
    );
  });

  it("rejects absolute directories in the config", () => {
    expect(() =>
      resolveWorkspacePaths("/tmp/project", {
        ...defaultWorkspaceConfig(),
        runsDirectory: "/var/runs",
      }),
    ).toThrow();
  });
});

describe("assertNoSymlinkEscape", () => {
  it("permits a path whose components are all regular directories", async () => {
    const workspace = await makeWorkspace();
    const target = join(
      workspace,
      ".performance-test",
      "scenarios",
      "nested",
    );
    await mkdir(target, { recursive: true });
    await expect(
      assertNoSymlinkEscape(workspace, target),
    ).resolves.toBeUndefined();
  });

  it("permits a path whose final component does not yet exist", async () => {
    const workspace = await makeWorkspace();
    const target = join(
      workspace,
      ".performance-test",
      "scenarios",
      "new-leaf",
    );
    await expect(
      assertNoSymlinkEscape(workspace, target),
    ).resolves.toBeUndefined();
  });

  it("rejects an existing directory that is itself a symlink pointing elsewhere", async () => {
    const workspace = await makeWorkspace();
    const outside = await mkdtemp(join(tmpdir(), "workspace-outside-"));
    roots.push(outside);
    const link = join(workspace, ".performance-test", "runs");
    await symlink(outside, link);
    await expect(assertNoSymlinkEscape(workspace, link)).rejects.toThrow();
  });

  it("rejects a symlinked directory component that escapes the workspace", async () => {
    const workspace = await makeWorkspace();
    const outside = await mkdtemp(join(tmpdir(), "workspace-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "leak.txt"), "leak", "utf8");
    const escape = join(workspace, ".performance-test", "escape");
    await mkdir(escape);
    await symlink(outside, join(escape, "leak"));
    const target = join(escape, "leak", "deep", "leaf");
    await expect(assertNoSymlinkEscape(workspace, target)).rejects.toThrow();
  });
});
