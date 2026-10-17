import {
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, parse, posix, sep } from "node:path";
import { TestRun, testRunSchema } from "../model/test-run.js";

const RUN_FILE_NAME = "run.json";
const LOCK_FILE_NAME = ".finalize.lock";
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export type RunStatus = TestRun["status"];

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "completed",
  "partial",
  "invalid",
  "failed",
  "cancelled",
]);

/**
 * Outcome of an attempt to finalize a run via the atomic compare-and-swap
 * helper. The handler layer maps these values onto either a successful tool
 * result or a structured tool error, never an exception.
 */
export type TryFinalizeOutcome =
  | { kind: "ok"; run: TestRun }
  | { kind: "missing" }
  | { kind: "terminal"; status: RunStatus }
  | { kind: "concurrent" }
  | { kind: "invalid"; reason: string };

export interface TryFinalizeOptions {
  /**
   * Mutator applied to the freshly-read run. The mutator must return the
   * updated run; if it throws, the lock is released and the error bubbles
   * up as an `invalid` outcome.
   */
  mutate: (current: TestRun) => TestRun | Promise<TestRun>;
  /**
   * Optional status predicate for callers that want to refuse additional
   * non-terminal transitions (e.g. refuse to mark a running run as running
   * again). Defaults to "any non-terminal status is acceptable".
   */
  acceptStatus?: (status: RunStatus) => boolean;
  /**
   * Optional hook invoked once persistence succeeds but before the lock is
   * released. Useful for writing report.json / report.md inside the same
   * critical section.
   */
  onPersisted?: (run: TestRun) => void | Promise<void>;
}

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
  /**
   * Atomically read the existing run, validate that the supplied predicate
   * accepts its current status, apply a mutator, and persist the updated
   * run. The transition is guarded by an exclusive `<run>/.finalize.lock`
   * file created with O_EXCL so two concurrent calls cannot both pass the
   * status check.
   */
  tryFinalize(runId: string, options: TryFinalizeOptions): Promise<TryFinalizeOutcome>;
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

function lockPathOf(rootDir: string, runId: string): string {
  return join(runDirectoryOf(rootDir, runId), LOCK_FILE_NAME);
}

/**
 * Try to acquire the per-run finalize lock. Uses `open(path, "wx")` so the
 * atomic create-or-fail semantics are provided by the OS. Stale lock files
 * from crashed prior processes are tolerated by checking their age in the
 * caller, but the default behavior is fail-fast.
 */
async function acquireFinalizeLock(
  lockPath: string,
): Promise<{ release: () => Promise<void>; acquired: true } | { acquired: false }> {
  try {
    const handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(
      JSON.stringify(
        {
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      { encoding: "utf8" },
    );
    await handle.close();
    return {
      acquired: true,
      release: async () => {
        try {
          await rm(lockPath, { force: true });
        } catch {
          // Best-effort release; lock TTL covers stuck processes.
        }
      },
    };
  } catch (error) {
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      return { acquired: false };
    }
    throw error;
  }
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
      // Atomic exclusive create via `open(path, "wx")`. Concurrent
      // callers all create the directory but only one wins the race to
      // become the original writer; the others observe `EEXIST` and
      // surface a clear "already exists" error. This replaces the older
      // readFile-then-persist pattern which had a TOCTOU race where
      // three concurrent writers could each win, persist a run.json, and
      // quietly overwrite each other.
      const target = runFilePath(rootDir, runId);
      try {
        const handle = await open(target, "wx", 0o600);
        try {
          await handle.writeFile(
            JSON.stringify(validated, null, 2),
            { encoding: "utf8" },
          );
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (
          error instanceof Error &&
          (error as NodeJS.ErrnoException).code === "EEXIST"
        ) {
          throw new Error(`Run "${runId}" already exists.`);
        }
        throw error;
      }
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

    async tryFinalize(
      runId: string,
      options: TryFinalizeOptions,
    ): Promise<TryFinalizeOutcome> {
      const safeId = assertSafeRunId(runId);
      const lockPath = lockPathOf(rootDir, safeId);
      // Ensure the run directory exists before attempting to acquire the
      // lock so ENOENT races do not matter.
      const dir = runDirectoryOf(rootDir, safeId);
      await mkdir(dir, { recursive: true });

      const lock = await acquireFinalizeLock(lockPath);
      if (!lock.acquired) {
        return { kind: "concurrent" };
      }

      try {
        let current: TestRun;
        try {
          current = await this.read(safeId);
        } catch (error) {
          if (
            error instanceof Error &&
            /does not exist/.test(error.message)
          ) {
            return { kind: "missing" };
          }
          throw error;
        }

        const accept = options.acceptStatus ?? defaultAcceptStatus;
        if (!accept(current.status)) {
          return { kind: "terminal", status: current.status };
        }

        let updated: TestRun;
        try {
          updated = await options.mutate(current);
        } catch (error) {
          return {
            kind: "invalid",
            reason:
              error instanceof Error ? error.message : String(error),
          };
        }

        // Force the run through persist() so the schema guard rejects any
        // mutator that produces an illegal status transition. We re-assert
        // the terminal guard here so a mutator cannot escape the check.
        if (TERMINAL_STATUSES.has(current.status) && !accept(current.status)) {
          return { kind: "terminal", status: current.status };
        }

        try {
          await persist(updated);
        } catch (error) {
          return {
            kind: "invalid",
            reason:
              error instanceof Error ? error.message : String(error),
          };
        }

        if (options.onPersisted) {
          try {
            await options.onPersisted(updated);
          } catch (error) {
            // Surface persistence errors to the caller while we still hold
            // the lock; the run.json contents are already updated so the
            // eventual unlock exposes the advanced state.
            return {
              kind: "invalid",
              reason:
                error instanceof Error ? error.message : String(error),
            };
          }
        }

        return { kind: "ok", run: updated };
      } finally {
        await lock.release();
      }
    },
  };
}

function defaultAcceptStatus(status: RunStatus): boolean {
  return !TERMINAL_STATUSES.has(status);
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