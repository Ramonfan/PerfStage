import { existsSync } from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { lstat, realpath } from "node:fs/promises";
import type { WorkspaceConfig } from "./model.js";

/**
 * Subdirectory that holds all workspace-scoped state for a given project:
 * scenario files, run evidence, configuration, etc.
 */
const WORKSPACE_DATA_DIR = ".performance-test";

/**
 * Absolute paths derived from a {@link WorkspaceConfig}. All paths are
 * resolved against `workspaceRoot` so callers can use them without further
 * normalization.
 */
export interface WorkspacePaths {
  workspaceRoot: string;
  scenarioDirectory: string;
  runsDirectory: string;
}

/**
 * Coerce a path string into POSIX form so normalization rules are stable
 * regardless of the host OS. Callers still feed the result back through
 * native {@link resolve} / {@link relative} for the platform-correct
 * absolute boundary.
 */
function toPosix(input: string): string {
  if (sep === posix.sep) {
    return input;
  }
  return input.split(sep).join(posix.sep);
}

/**
 * Verify that `candidate` is a workspace-relative path that lands inside
 * `<workspaceRoot>/.performance-test` after normalization. Returns the
 * POSIX-normalized form on success so the caller can compose it directly
 * with `resolve(workspaceRoot, returned)`.
 *
 * Rejects:
 *  - non-string or empty input,
 *  - absolute paths (POSIX `/...` or Windows `C:\...`),
 *  - paths containing `..` segments,
 *  - paths that, after resolution, end up outside `.performance-test`.
 *
 * The function is intentionally synchronous and pure: callers that need to
 * validate a directory that has not been created yet should pass the
 * intended relative path and use {@link assertNoSymlinkEscape} afterwards
 * to verify the parent chain has no symlink that points outside the
 * workspace.
 */
export function assertWorkspaceRelativePath(
  workspaceRoot: string,
  candidate: string,
  label: string,
): string {
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`${label} must be a non-empty path string.`);
  }
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    throw new Error(`${label} requires a non-empty workspaceRoot.`);
  }

  const unixCandidate = toPosix(candidate);
  const normalized = posix.normalize(unixCandidate);
  if (normalized.length === 0) {
    throw new Error(`${label} "${candidate}" resolves to an empty path.`);
  }
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(
      `${label} "${candidate}" must not contain parent traversal segments.`,
    );
  }
  if (isAbsolute(normalized) || normalized.startsWith(posix.sep)) {
    throw new Error(
      `${label} "${candidate}" must be relative to the workspace root.`,
    );
  }

  const resolvedRoot = resolve(workspaceRoot);
  const allowedRoot = resolve(resolvedRoot, WORKSPACE_DATA_DIR);
  const resolved = resolve(resolvedRoot, normalized);
  const rel = relative(allowedRoot, resolved);
  const inside =
    rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  if (!inside) {
    throw new Error(
      `${label} "${candidate}" must live inside the workspace's ${WORKSPACE_DATA_DIR} directory.`,
    );
  }
  return normalized;
}

/**
 * Verify that `path` resolves to a location inside `workspaceRoot`. Used
 * for arbitrary user-supplied paths (e.g. evidence source paths) where the
 * relative-to-data-dir constraint is too strict.
 */
export function assertPathInsideWorkspace(
  path: string,
  workspaceRoot: string,
): void {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("path must be a non-empty string.");
  }
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    throw new Error("workspaceRoot must be a non-empty string.");
  }
  const resolvedRoot = resolve(workspaceRoot);
  const resolvedPath = resolve(path);
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(
      `Path "${path}" is outside workspace root "${workspaceRoot}".`,
    );
  }
}

/**
 * Resolve the workspace root from a starting directory. The first ancestor
 * (including `cwd` itself) that contains a `.performance-test` directory
 * is returned. When no such ancestor exists, the original `cwd` is
 * returned unchanged so callers can still bootstrap a brand-new workspace
 * from a clean checkout.
 */
export function workspaceRootFromCwd(cwd: string): string {
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error("cwd must be a non-empty string.");
  }
  const start = resolve(cwd);
  let current = start;
  // `resolve` already strips trailing separators so `dirname` of the
  // filesystem root returns itself, giving us a natural loop terminator.
  while (true) {
    if (existsSync(join(current, WORKSPACE_DATA_DIR))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return start;
    }
    current = parent;
  }
}

/**
 * Validate the config's directories against the workspace root and return
 * absolute paths suitable for downstream consumers.
 */
export function resolveWorkspacePaths(
  workspaceRoot: string,
  config: WorkspaceConfig,
): WorkspacePaths {
  const scenarioRelative = assertWorkspaceRelativePath(
    workspaceRoot,
    config.scenarioDirectory,
    "scenarioDirectory",
  );
  const runsRelative = assertWorkspaceRelativePath(
    workspaceRoot,
    config.runsDirectory,
    "runsDirectory",
  );
  const resolvedRoot = resolve(workspaceRoot);
  return {
    workspaceRoot: resolvedRoot,
    scenarioDirectory: resolve(resolvedRoot, scenarioRelative),
    runsDirectory: resolve(resolvedRoot, runsRelative),
  };
}

/**
 * Walk each existing path component from `root` to `target` using `lstat`.
 * If any component is a symbolic link, the link is resolved and the
 * resolved location must remain inside `<root>/.performance-test`. Final
 * components that do not yet exist are permitted so initialization can
 * create them; only the *parent* chain is audited.
 */
export async function assertNoSymlinkEscape(
  root: string,
  target: string,
): Promise<void> {
  if (typeof root !== "string" || root.length === 0) {
    throw new Error("root must be a non-empty string.");
  }
  if (typeof target !== "string" || target.length === 0) {
    throw new Error("target must be a non-empty string.");
  }
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const allowedRoot = resolve(resolvedRoot, WORKSPACE_DATA_DIR);
  const rel = relative(resolvedRoot, resolvedTarget);
  const segments = rel
    .split(sep)
    .filter((segment) => segment.length > 0 && segment !== ".");

  let cursor = resolvedRoot;
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
        // Final component does not exist yet; the caller will create it.
        return;
      }
      throw error;
    }
    if (!stats.isSymbolicLink()) {
      continue;
    }
    const resolvedLink = await realpath(cursor);
    const relFromAllowed = relative(allowedRoot, resolvedLink);
    const escapes =
      relFromAllowed === ".." ||
      relFromAllowed.startsWith(`..${sep}`) ||
      isAbsolute(relFromAllowed);
    if (escapes) {
      throw new Error(
        `Symlink at "${cursor}" resolves to "${resolvedLink}", which escapes the workspace's ${WORKSPACE_DATA_DIR} directory.`,
      );
    }
    // Continue walking from the resolved location so deeper symlink chains
    // are also audited against the workspace boundary.
    cursor = resolvedLink;
  }
}
