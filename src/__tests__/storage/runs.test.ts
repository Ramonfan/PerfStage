import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createRunStore,
  newRunId,
} from "../../storage/runs.js";
import type { TestRun } from "../../model/test-run.js";

let roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "performance-mcp-"));
  roots.push(root);
  return root;
}

beforeEach(() => {
  roots = [];
});

afterEach(async () => {
  // Best-effort cleanup; mkdtemp creates real directories.
  for (const root of roots) {
    try {
      const { rm } = await import("node:fs/promises");
      await rm(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function buildRun(overrides: Partial<TestRun> = {}): TestRun {
  return {
    id: "run-1",
    planId: "plan-1",
    status: "prepared",
    startedAt: "2026-10-17T00:00:00.000Z",
    endedAt: null,
    repetitions: 1,
    currentRepetition: 0,
    actions: [],
    metrics: [],
    evidence: {
      screenshotPaths: [],
      traceArchivePaths: [],
    },
    lifecycle: [],
    ...overrides,
  };
}

describe("createRunStore", () => {
  it("creates a run directory and round-trips run.json", async () => {
    const root = await makeRoot();
    const store = createRunStore(root);
    const run = buildRun();
    const returnedId = await store.create(run);
    expect(returnedId).toBe("run-1");
    const reread = await store.read("run-1");
    expect(reread.id).toBe("run-1");
    expect(reread.status).toBe("prepared");
    const onDisk = await readFile(join(root, "run-1", "run.json"), "utf8");
    expect(onDisk).toContain("prepared");
    expect(onDisk).toContain("run-1");
  });

  it("serializes run.json with two-space indentation", async () => {
    const root = await makeRoot();
    const store = createRunStore(root);
    await store.create(buildRun());
    const onDisk = await readFile(join(root, "run-1", "run.json"), "utf8");
    expect(onDisk).toBe(JSON.stringify(await store.read("run-1"), null, 2));
  });

  it("refuses to overwrite an existing run on create", async () => {
    const root = await makeRoot();
    const store = createRunStore(root);
    await store.create(buildRun());
    await expect(store.create(buildRun())).rejects.toThrow(/exists|already/i);
  });

  it("create is atomically exclusive: only one of N concurrent calls wins", async () => {
    const root = await makeRoot();
    const store = createRunStore(root);
    // Three concurrent create calls target the SAME run id; only one must
    // succeed and the other two must reject with a clear already-exists
    // signal.
    const outcomes = await Promise.allSettled(
      [0, 1, 2].map(() => store.create(buildRun())),
    );
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter(
      (o): o is PromiseRejectedResult =>
        o.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const r of rejected) {
      expect(String(r.reason)).toMatch(/exists|already/i);
    }
  });

  it("read rejects unknown run ids", async () => {
    const root = await makeRoot();
    const store = createRunStore(root);
    await expect(store.read("missing")).rejects.toThrow();
  });

  it("write replaces run.json atomically", async () => {
    const root = await makeRoot();
    const store = createRunStore(root);
    await store.create(buildRun());
    const updated = buildRun({ status: "running" });
    await store.write(updated);
    const reread = await store.read("run-1");
    expect(reread.status).toBe("running");
  });

  it("write rejects unknown run ids", async () => {
    const root = await makeRoot();
    const store = createRunStore(root);
    await expect(store.write(buildRun({ id: "ghost" }))).rejects.toThrow();
  });

  it("writeText writes content and returns a POSIX relative path", async () => {
    const root = await makeRoot();
    const store = createRunStore(root);
    await store.create(buildRun());
    const rel = await store.writeText("run-1", "logs/server.log", "hello world");
    expect(rel).toBe(posix.join("logs", "server.log"));
    // POSIX-style paths use forward slashes regardless of host OS.
    expect(rel).not.toContain("\\");
    const onDisk = await readFile(join(root, "run-1", "logs", "server.log"), "utf8");
    expect(onDisk).toBe("hello world");
  });

  it("writeText normalizes redundant separators and dot segments", async () => {
    const root = await makeRoot();
    const store = createRunStore(root);
    await store.create(buildRun());
    const rel = await store.writeText("run-1", "logs//./inner/../notes.txt", "abc");
    expect(rel).toBe(posix.join("logs", "notes.txt"));
    const onDisk = await readFile(join(root, "run-1", "logs", "notes.txt"), "utf8");
    expect(onDisk).toBe("abc");
  });

  it("writeText rejects paths that escape the run directory", async () => {
    const root = await makeRoot();
    const store = createRunStore(root);
    await store.create(buildRun());
    await expect(
      store.writeText("run-1", "../escape.txt", "x"),
    ).rejects.toThrow();
    await expect(
      store.writeText("run-1", "sub/../../escape.txt", "x"),
    ).rejects.toThrow();
    await expect(
      store.writeText("run-1", "/abs/escape.txt", "x"),
    ).rejects.toThrow();
  });

  it("writeText rejects absolute paths via storage.runDirectory host override", async () => {
    const root = await makeRoot();
    const store = createRunStore(root);
    await store.create(buildRun());
    // Bypass normalization through crafted POSIX traversal that survives `..`
    await expect(
      store.writeText("run-1", "a/../../../etc/passwd", "x"),
    ).rejects.toThrow();
  });

  it("copyEvidence copies bytes verbatim and returns POSIX relative path", async () => {
    const root = await makeRoot();
    const store = createRunStore(root);
    const sourceDir = await makeRoot();
    const sourcePath = join(sourceDir, "raw.bin");
    const bytes = Buffer.from([0, 1, 2, 3, 0xff, 0xfe]);
    await writeFile(sourcePath, bytes);
    await store.create(buildRun());
    const rel = await store.copyEvidence(
      "run-1",
      sourcePath,
      "evidence/raw.bin",
    );
    expect(rel).toBe(posix.join("evidence", "raw.bin"));
    const onDisk = await readFile(join(root, "run-1", "evidence", "raw.bin"));
    expect(onDisk.equals(bytes)).toBe(true);
  });

  it("copyEvidence rejects paths that escape the run directory", async () => {
    const root = await makeRoot();
    const sourceDir = await makeRoot();
    const sourcePath = join(sourceDir, "raw.bin");
    await writeFile(sourcePath, "data");
    const store = createRunStore(root);
    await store.create(buildRun());
    await expect(
      store.copyEvidence("run-1", sourcePath, "../escape.bin"),
    ).rejects.toThrow();
    await expect(
      store.copyEvidence("run-1", sourcePath, "evidence/../../escape.bin"),
    ).rejects.toThrow();
  });

  it("copyEvidence rejects missing source paths", async () => {
    const root = await makeRoot();
    const sourceDir = await makeRoot();
    const store = createRunStore(root);
    await store.create(buildRun());
    await expect(
      store.copyEvidence("run-1", join(sourceDir, "ghost.bin"), "in.bin"),
    ).rejects.toThrow();
  });

  it("runDirectory returns a POSIX path under the root", () => {
    const store = createRunStore("/tmp/anywhere");
    expect(store.runDirectory("run-1")).toBe(posix.join("/tmp", "anywhere", "run-1"));
    expect(store.runDirectory("run-1")).not.toContain("\\");
  });

  it("created evidence files survive the run directory", async () => {
    const root = await makeRoot();
    const store = createRunStore(root);
    await store.create(buildRun());
    await store.writeText("run-1", "logs/a.log", "x");
    const s = await stat(join(root, "run-1", "logs", "a.log"));
    expect(s.isFile()).toBe(true);
  });
});

describe("newRunId", () => {
  it("returns a non-empty, path-safe identifier", () => {
    const id = newRunId(new Date("2026-10-17T00:00:00.000Z"));
    expect(id.length).toBeGreaterThan(0);
    expect(/[\\/]/.test(id)).toBe(false);
    expect(/[\x00-\x1f]/.test(id)).toBe(false);
    expect(id.endsWith(".")).toBe(false);
  });

  it("embeds the UTC timestamp and a random suffix", () => {
    const fixed = new Date("2026-10-17T12:34:56.789Z");
    const id = newRunId(fixed);
    // The timestamp component appears somewhere before the random suffix.
    expect(id).toMatch(/2026-?10-?17/);
    // Two consecutive calls should differ because the suffix is random.
    const other = newRunId(fixed);
    expect(other).not.toBe(id);
  });

  it("two consecutive ids use distinct random suffixes", () => {
    const a = newRunId();
    const b = newRunId();
    expect(a).not.toBe(b);
  });
});