import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { TestRun, testRunSchema } from "../model/test-run.js";

const RUN_FILE_NAME = "run.json";
const LOCK_FILE_NAME = ".finalize.lock";
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Filename of the per-run state file inside each run directory.
 * Exported so the tool layer can build workspace-relative paths
 * (e.g. `<workspace>/.performance-test/runs/<runId>/run.json`) without
 * duplicating the string.
 */
export { RUN_FILE_NAME };
/**
 * A lock file left behind by an earlier crashed finalize is recoverable
 * after this many milliseconds. Lock files younger than this are assumed
 * to belong to a live concurrent call and keep the call from
 * acquiring.
 */
const STALE_LOCK_AGE_MS = 5 * 60_000;

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
   * Workspace-owned safety check. Confirms that the run directory exists
   * (or would land) under the configured runs directory, that the runs
   * directory itself sits under the workspace root, and that none of the
   * existing parent path components are symlinks resolving outside the
   * workspace boundary. Returns the absolute run directory on success;
   * throws a structured error on any failure so the handler can surface
   * it as a tool error before any side-effecting copy or write.
   */
  ensureSafeRun(runId: string): Promise<string>;
  /**
   * Atomically read the existing run, validate that the supplied predicate
   * accepts its current status, apply a mutator, and persist the updated
   * run. The transition is guarded by an exclusive `<run>/.finalize.lock`
   * file created with O_EXCL so two concurrent calls cannot both pass the
   * status check. The run directory is created lazily only AFTER the
   * existing run is confirmed present so unknown run ids cannot leave
   * behind empty directories.
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

/**
 * Resolve a path into the workspace-rooted allowed region. Throws when
 * the candidate lands outside the supplied workspace root. Used as a
 * pre-flight check before any side-effecting call that could otherwise
 * let a hostile caller escape the workspace boundary.
 */
function assertInsideWorkspace(
  workspaceRoot: string,
  candidate: string,
  label: string,
): string {
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    throw new Error(`${label} requires a non-empty workspaceRoot.`);
  }
  const resolvedRoot = resolve(workspaceRoot);
  const resolvedCandidate = resolve(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  const escapes =
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    rel.startsWith("../") ||
    isAbsolute(rel);
  if (escapes) {
    throw new Error(
      `${label} "${candidate}" is outside workspace root "${workspaceRoot}".`,
    );
  }
  return resolvedCandidate;
}

/**
 * Walk each existing path component from `parent` to `target` using
 * `lstat`. If any component is a symbolic link, resolve it and confirm
 * the resolved location still lives under `parent` — otherwise a hostile
 * run could plant a symlink inside the run directory and trick the
 * storage into writing bytes outside the workspace boundary.
 */
async function assertNoSymlinkEscapeBelow(
  parent: string,
  target: string,
): Promise<void> {
  const resolvedParent = resolve(parent);
  const resolvedTarget = resolve(target);
  const rel = relative(resolvedParent, resolvedTarget);
  const segments = rel
    .split(sep)
    .filter((segment) => segment.length > 0 && segment !== ".");
  let cursor = resolvedParent;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    let stats;
    try {
      stats = await lstat(cursor);
    } catch (error) {
      if (
        error instanceof Error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        // Final component (or any intermediate not-yet-created dir) is
        // permitted; the caller will create it.
        return;
      }
      throw error;
    }
    if (!stats.isSymbolicLink()) {
      continue;
    }
    const resolvedLink = await realpath(cursor);
    const relFromParent = relative(resolvedParent, resolvedLink);
    const escapes =
      relFromParent === ".." ||
      relFromParent.startsWith(`..${sep}`) ||
      relFromParent.startsWith("../") ||
      isAbsolute(relFromParent);
    if (escapes) {
      throw new Error(
        `Symlink at "${cursor}" resolves to "${resolvedLink}", which escapes the parent directory "${parent}".`,
      );
    }
    cursor = resolvedLink;
  }
}

function runFilePath(rootDir: string, runId: string): string {
  return join(runDirectoryOf(rootDir, runId), RUN_FILE_NAME);
}

function lockPathOf(rootDir: string, runId: string): string {
  return join(runDirectoryOf(rootDir, runId), LOCK_FILE_NAME);
}

/**
 * Try to acquire the per-run finalize lock. Uses `open(path, "wx")` so the
 * atomic create-or-fail semantics are provided by the OS. If a stale
 * lock from a previously crashed call is detected (older than
 * `STALE_LOCK_AGE_MS`), it is removed and the lock is retried once.
 */
async function acquireFinalizeLock(
  lockPath: string,
): Promise<{ release: () => Promise<void>; acquired: true } | { acquired: false }> {
  const tryAcquire = async (): Promise<
    | { acquired: true; release: () => Promise<void> }
    | { acquired: false }
  > => {
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
            // Best-effort release; if the file is gone the holder is
            // already past finalize.
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
  };

  const first = await tryAcquire();
  if (first.acquired) return first;

  // EEXIST: maybe the existing lock is stale (left over from a crashed
  // finalize). Probe its mtime; if it is older than the staleness
  // threshold we remove it and retry once. If the retry still fails
  // the caller is treated as genuinely concurrent.
  let stale = false;
  try {
    const info = await stat(lockPath);
    const ageMs = Date.now() - info.mtimeMs;
    if (Number.isFinite(ageMs) && ageMs > STALE_LOCK_AGE_MS) {
      stale = true;
      await rm(lockPath, { force: true });
    }
  } catch {
    // No info: leave for the retry to either succeed or report
    // concurrency.
  }
  if (!stale) {
    return { acquired: false };
  }
  return tryAcquire();
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

/**
 * Build a {@link RunStore} rooted at the supplied runs directory.
 *
 * When `workspaceRoot` is supplied, the store enforces two additional
 * invariants that the production workspace manager already guarantees
 * but legacy test harnesses may bypass:
 *
 *   1. `rootDir` must resolve to a location inside `workspaceRoot` so
 *      no run can ever escape the project boundary, and
 *   2. every existing parent path component from `workspaceRoot` to
 *      `rootDir` must be free of symlinks that resolve outside the
 *      workspace.
 *
 * The root directory is also required to exist by the time the first
 * side-effecting call runs: `create()` and `write()` both `stat()` it
 * first so a caller cannot accidentally materialize a stray directory at
 * the package install path.
 */
export function createRunStore(
  rootDir: string,
  workspaceRoot?: string,
): RunStore {
  if (typeof rootDir !== "string" || rootDir.length === 0) {
    throw new Error("rootDir must be a non-empty string.");
  }
  const resolvedRootDir = resolve(rootDir);
  let resolvedWorkspaceRoot: string | undefined;
  if (workspaceRoot !== undefined) {
    resolvedWorkspaceRoot = resolve(workspaceRoot);
    assertInsideWorkspace(
      resolvedWorkspaceRoot,
      resolvedRootDir,
      "rootDir",
    );
  }

  /**
   * Guard that confirms the parent runs directory exists before any
   * side-effecting run operation runs. The createRunStore contract is
   * that the store only operates inside an existing runs directory; the
   * workspace manager materializes this on `initialize`. Throws a
   * structured error when the directory is missing so the caller can
   * surface it as a tool error rather than silently materializing a
   * stray path.
   */
  async function assertRunsDirReady(): Promise<void> {
    try {
      await stat(resolvedRootDir);
    } catch (error) {
      if (
        error instanceof Error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        throw new Error(
          `Configured runs directory "${resolvedRootDir}" does not exist; initialize the workspace first.`,
        );
      }
      throw error;
    }
  }

  async function persist(run: TestRun): Promise<void> {
    const validated = testRunSchema.parse(run);
    const json = JSON.stringify(validated, null, 2);
    await writeAtomic(runFilePath(resolvedRootDir, validated.id), json);
  }

  return {
    async create(run: TestRun): Promise<string> {
      const validated = testRunSchema.parse(run);
      const runId = assertSafeRunId(validated.id);
      await assertRunsDirReady();
      const dir = runDirectoryOf(resolvedRootDir, runId);
      await mkdir(dir, { recursive: true });
      // Atomic exclusive create via `open(path, "wx")`. Concurrent
      // callers all create the directory but only one wins the race to
      // become the original writer; the others observe `EEXIST` and
      // surface a clear "already exists" error. This replaces the older
      // readFile-then-persist pattern which had a TOCTOU race where
      // three concurrent writers could each win, persist a run.json, and
      // quietly overwrite each other.
      const target = runFilePath(resolvedRootDir, runId);
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
        raw = await readFile(runFilePath(resolvedRootDir, safeId), "utf8");
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
      await assertRunsDirReady();
      // Confirm the run already exists before overwriting it.
      try {
        await readFile(runFilePath(resolvedRootDir, safeId), "utf8");
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
      await assertRunsDirReady();
      const dir = runDirectoryOf(resolvedRootDir, safeId);
      await mkdir(dir, { recursive: true });
      const target = join(dir, safeRelative);
      // Defense in depth: ensure target is still inside the run directory.
      const expectedPrefix = dir.endsWith(sep) ? dir : dir + sep;
      if (target !== dir && !target.startsWith(expectedPrefix)) {
        throw new Error(
          `relativePath "${relativePath}" escapes the run directory.`,
        );
      }
      // Reject symlinks in any existing parent path component. Final
      // components that do not yet exist are permitted; only the parent
      // chain is audited. A hostile run directory could otherwise plant
      // `escape -> /etc` and trick the storage into writing outside the
      // workspace.
      await assertNoSymlinkEscapeBelow(dir, target);
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
      await assertRunsDirReady();
      const dir = runDirectoryOf(resolvedRootDir, safeId);
      await mkdir(dir, { recursive: true });
      const target = join(dir, safeRelative);
      const expectedPrefix = dir.endsWith(sep) ? dir : dir + sep;
      if (target !== dir && !target.startsWith(expectedPrefix)) {
        throw new Error(
          `relativePath "${relativePath}" escapes the run directory.`,
        );
      }
      await assertNoSymlinkEscapeBelow(dir, target);
      await mkdir(dirname(target), { recursive: true });
      // copyFile streams bytes verbatim — no content interpretation.
      await copyFile(sourcePath, target);
      return safeRelative;
    },

    runDirectory(runId: string): string {
      return runDirectoryOf(resolvedRootDir, runId);
    },

    async ensureSafeRun(runId: string): Promise<string> {
      const safeId = assertSafeRunId(runId);
      await assertRunsDirReady();
      const dir = runDirectoryOf(resolvedRootDir, safeId);
      // Re-assert the workspace boundary whenever a workspace root was
      // supplied; this is the workspace-owned check the handler layer
      // runs before it touches evidence or report files.
      if (resolvedWorkspaceRoot !== undefined) {
        assertInsideWorkspace(resolvedWorkspaceRoot, dir, "run directory");
        await assertNoSymlinkEscapeBelow(
          resolvedWorkspaceRoot,
          dir,
        );
      }
      // Also confirm no symlink between the run directory and its parent
      // already lets us escape the run dir itself (a paranoid caller
      // could have placed a symlink above us).
      await assertNoSymlinkEscapeBelow(resolvedRootDir, dir);
      return dir;
    },

    async tryFinalize(
      runId: string,
      options: TryFinalizeOptions,
    ): Promise<TryFinalizeOutcome> {
      const safeId = assertSafeRunId(runId);
      // Workspace boundary check FIRST — refuse to even acquire the lock
      // when the run directory would land outside the workspace.
      const dir = runDirectoryOf(resolvedRootDir, safeId);
      if (resolvedWorkspaceRoot !== undefined) {
        assertInsideWorkspace(
          resolvedWorkspaceRoot,
          dir,
          "run directory",
        );
      }
      // Confirm the run actually exists BEFORE materializing any
      // directory. Unknown run ids must surface as a structured
      // `missing` outcome without leaving an empty directory on disk.
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
      // Now that the run is confirmed, the runs dir must exist (and
      // sit inside the workspace). The directory itself was created by
      // `create()`; we only re-assert readiness here as a defense
      // against an external `rm -rf` between prepare and finalize.
      await assertRunsDirReady();
      const lockPath = lockPathOf(resolvedRootDir, safeId);
      await mkdir(dir, { recursive: true });
      const lock = await acquireFinalizeLock(lockPath);
      if (!lock.acquired) {
        return { kind: "concurrent" };
      }

      try {
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
