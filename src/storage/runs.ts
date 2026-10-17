import {
  copyFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, parse, posix, sep } from "node:path";
import { TestRun, testRunSchema } from "../model/test-run.js";

const RUN_FILE_NAME = "run.json";
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface RunStore {
  create(run: TestRun): Promise<string>;
  read(runId: string): Promise<TestRun>;
  write(run: TestRun): Promise<void>;
  writeText(
    runId: string,
    relativePath: string,
    content: string,
  ): Promise<string>;
  copyEvidence(
    runId: string,
    sourcePath: string,
    relativePath: string,
  ): Promise<string>;
  runDirectory(runId: string): string;
}

/**
 * Normalize a run directory name, guaranteeing it cannot escape the storage
 * root. The run id is also the directory name, so it must be path-safe on
 * every supported platform.
 */
function assertSafeRunId(runId: string): string {
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("runId must be a non-empty string.");
  }
  if (RUN_ID_PATTERN.test(runId) === false) {
    throw new Error(
      `runId "${runId}" contains characters that are not path-safe.`,
    );
  }
  if (runId === "." || runId === "..") {
    throw new Error(`runId "${runId}" is reserved.`);
  }
  return runId;
}

/**
 * Normalize a relative path with POSIX semantics and verify it stays inside
 * the run directory. Any traversal attempt is rejected.
 */
function safeRelativePath(relativePath: string): string {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new Error("relativePath must be a non-empty string.");
  }
  if (relativePath.includes("\u0000")) {
    throw new Error("relativePath contains a NUL byte.");
  }
  // Use POSIX separators consistently regardless of host OS.
  const unixInput = relativePath.split(sep).join(posix.sep);
  if (isAbsolute(unixInput) || unixInput.startsWith(posix.sep)) {
    throw new Error(
      `relativePath "${relativePath}" must be relative to the run directory.`,
    );
  }
  const normalized = posix.normalize(unixInput);
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized === "." ||
    normalized.startsWith("./")
  ) {
    throw new Error(
      `relativePath "${relativePath}" escapes the run directory.`,
    );
  }
  if (normalized.length === 0) {
    throw new Error(
      `relativePath "${relativePath}" is empty after normalization.`,
    );
  }
  return normalized;
}

function toPosix(path: string): string {
  if (sep === posix.sep) {
    return path;
  }
  return path.split(sep).join(posix.sep);
}

function runDirectoryOf(rootDir: string, runId: string): string {
  return toPosix(join(rootDir, assertSafeRunId(runId)));
}

function runFilePath(rootDir: string, runId: string): string {
  return join(runDirectoryOf(rootDir, runId), RUN_FILE_NAME);
}

/**
 * Write a UTF-8 file atomically by staging the content in a sibling temp
 * file inside the same directory and renaming it over the target. This keeps
 * readers from observing a partial file even on crash.
 */
async function writeAtomic(targetPath: string, data: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const { dir, name } = parse(targetPath);
  const tempName = `.${name}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const tempPath = join(dir, tempName);
  await writeFile(tempPath, data, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, targetPath);
}

export function createRunStore(rootDir: string): RunStore {
  if (typeof rootDir !== "string" || rootDir.length === 0) {
    throw new Error("rootDir must be a non-empty string.");
  }

  async function persist(run: TestRun): Promise<void> {
    const validated = testRunSchema.parse(run);
    const json = JSON.stringify(validated, null, 2);
    await writeAtomic(runFilePath(rootDir, validated.id), json);
  }

  return {
    async create(run: TestRun): Promise<string> {
      const validated = testRunSchema.parse(run);
      const runId = assertSafeRunId(validated.id);
      const dir = runDirectoryOf(rootDir, runId);
      await mkdir(dir, { recursive: true });
      // Detect existing runs so we never silently overwrite them.
      try {
        await readFile(runFilePath(rootDir, runId), "utf8");
        throw new Error(`Run "${runId}" already exists.`);
      } catch (error) {
        if (
          error instanceof Error &&
          /already exists/.test(error.message)
        ) {
          throw error;
        }
        if (
          error instanceof Error &&
          // Node reports missing files via Error with code "ENOENT".
          (error as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          // Expected — fall through and write the new run.
        } else {
          throw error;
        }
      }
      await persist(validated);
      return runId;
    },

    async read(runId: string): Promise<TestRun> {
      const safeId = assertSafeRunId(runId);
      let raw: string;
      try {
        raw = await readFile(runFilePath(rootDir, safeId), "utf8");
      } catch (error) {
        if (
          error instanceof Error &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          throw new Error(`Run "${safeId}" does not exist.`);
        }
        throw error;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new Error(
          `Run "${safeId}" is corrupted: ${(error as Error).message}`,
        );
      }
      const result = testRunSchema.safeParse(parsed);
      if (!result.success) {
        throw new Error(
          `Run "${safeId}" failed schema validation: ${result.error.message}`,
        );
      }
      return result.data;
    },

    async write(run: TestRun): Promise<void> {
      const validated = testRunSchema.parse(run);
      const safeId = assertSafeRunId(validated.id);
      // Confirm the run already exists before overwriting it.
      try {
        await readFile(runFilePath(rootDir, safeId), "utf8");
      } catch (error) {
        if (
          error instanceof Error &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          throw new Error(`Run "${safeId}" does not exist.`);
        }
        throw error;
      }
      await persist(validated);
    },

    async writeText(
      runId: string,
      relativePath: string,
      content: string,
    ): Promise<string> {
      const safeId = assertSafeRunId(runId);
      const safeRelative = safeRelativePath(relativePath);
      const dir = runDirectoryOf(rootDir, safeId);
      await mkdir(dir, { recursive: true });
      const target = join(dir, safeRelative);
      // Defense in depth: ensure target is still inside the run directory.
      const expectedPrefix = dir.endsWith(sep) ? dir : dir + sep;
      if (target !== dir && !target.startsWith(expectedPrefix)) {
        throw new Error(
          `relativePath "${relativePath}" escapes the run directory.`,
        );
      }
      await mkdir(dirname(target), { recursive: true });
      await writeAtomic(target, content);
      return safeRelative;
    },

    async copyEvidence(
      runId: string,
      sourcePath: string,
      relativePath: string,
    ): Promise<string> {
      const safeId = assertSafeRunId(runId);
      const safeRelative = safeRelativePath(relativePath);
      if (typeof sourcePath !== "string" || sourcePath.length === 0) {
        throw new Error("sourcePath must be a non-empty string.");
      }
      const dir = runDirectoryOf(rootDir, safeId);
      await mkdir(dir, { recursive: true });
      const target = join(dir, safeRelative);
      const expectedPrefix = dir.endsWith(sep) ? dir : dir + sep;
      if (target !== dir && !target.startsWith(expectedPrefix)) {
        throw new Error(
          `relativePath "${relativePath}" escapes the run directory.`,
        );
      }
      await mkdir(dirname(target), { recursive: true });
      // copyFile streams bytes verbatim — no content interpretation.
      await copyFile(sourcePath, target);
      return safeRelative;
    },

    runDirectory(runId: string): string {
      return runDirectoryOf(rootDir, runId);
    },
  };
}

/**
 * Generate a deterministic-shaped run id: `<UTC timestamp>-<random suffix>`.
 *
 * Both pieces are restricted to characters that are safe to embed in a path
 * on every supported platform (POSIX and Windows). The random suffix uses
 * `crypto.randomBytes` so collisions are vanishingly unlikely.
 */
export function newRunId(now: Date = new Date()): string {
  const safeDate = now instanceof Date && !Number.isNaN(now.getTime())
    ? now
    : new Date();
  // `2026-10-17T00-00-00.000Z` — colons are not safe in Windows paths.
  const stamp = safeDate.toISOString().replace(/:/g, "-");
  const suffix = randomBytes(6).toString("base64url");
  return `${stamp}-${suffix}`;
}

// Allow this file to be invoked directly for ad-hoc checks during development.
if (import.meta.url === `file://${process.argv[1]}`) {
  const id = newRunId();
  console.log(`sample runId: ${id}`);
  console.log(`runDirectory: ${posix.join("(root)", id)}`);
}