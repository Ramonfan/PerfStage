import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  EMBEDDED_SCENARIO_TEMPLATES,
  type EmbeddedScenarioTemplate,
} from "./embedded-templates.js";
import type { WorkspaceConfig } from "./model.js";
import { defaultWorkspaceConfig, workspaceConfigSchema } from "./model.js";
import {
  assertNoSymlinkEscape,
  resolveWorkspacePaths,
  type WorkspacePaths,
} from "./paths.js";

/**
 * Subdirectory (relative to the workspace root) that holds every
 * workspace-scoped artifact for a project: configuration, scenario files,
 * and run evidence. Defined here (rather than imported from `paths.ts`)
 * so the file-mode constants below stay co-located with the manager that
 * creates them.
 */
const WORKSPACE_DATA_DIR = ".performance-test";
const CONFIG_FILENAME = "config.json";
const CONFIG_FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

/**
 * Inputs accepted by {@link WorkspaceManager.initialize}. None of the
 * fields are mandatory: the manager always writes a usable default
 * configuration and creates the standard directories on first use.
 */
export interface InitializeWorkspaceInput {
  bundleId?: string;
  appName?: string;
  copyDefaultScenarios?: boolean;
}

/**
 * Result returned by {@link WorkspaceManager.initialize}. `configPath` is
 * always absolute; `firstInitialization` distinguishes a fresh setup from
 * an idempotent re-initialization so callers can decide whether to run
 * first-time side effects.
 */
export interface InitializeWorkspaceResult {
  configPath: string;
  firstInitialization: boolean;
}

/**
 * Fully validated workspace context, suitable for downstream consumers
 * that need both the parsed configuration and its resolved paths.
 */
export interface ReadyWorkspace {
  workspaceRoot: string;
  configPath: string;
  config: WorkspaceConfig;
  paths: WorkspacePaths;
}

/**
 * Discriminated union describing the current workspace state. Callers
 * should switch on `kind` and handle each branch explicitly:
 *
 * - `uninitialized`: `.performance-test` does not yet exist. No config
 *   file is read.
 * - `ready`: A valid config was found; `config` and `paths` are usable.
 * - `invalid`: A config file was found but is unusable. `reason` is a
 *   short, actionable human-readable explanation that points at the
 *   offending field when possible.
 */
export type WorkspaceState =
  | {
      kind: "uninitialized";
      workspaceRoot: string;
      configPath: string;
    }
  | {
      kind: "ready";
      workspaceRoot: string;
      configPath: string;
      config: WorkspaceConfig;
      paths: WorkspacePaths;
    }
  | {
      kind: "invalid";
      workspaceRoot: string;
      configPath: string;
      reason: string;
    };

/**
 * Thrown by {@link WorkspaceManager.requireReady} when no config exists.
 * The message references the `initialize_performance_workspace` tool so
 * MCP callers know exactly which MCP method to invoke next.
 */
export class WorkspaceNotReadyError extends Error {
  override readonly name = "WorkspaceNotReadyError";
}

/**
 * Thrown by {@link WorkspaceManager.requireReady} when the workspace
 * config exists but is unusable. The message contains both the offending
 * config path and a human-readable reason.
 */
export class WorkspaceInvalidError extends Error {
  override readonly name = "WorkspaceInvalidError";
}

/**
 * Snapshot every embedded template scenario. The list is small and
 * defined at build time so iterating the in-memory constant avoids
 * a filesystem round-trip per initialization call.
 */
function listEmbeddedTemplates(): readonly EmbeddedScenarioTemplate[] {
  return EMBEDDED_SCENARIO_TEMPLATES;
}

export interface WorkspaceManager {
  inspect(): Promise<WorkspaceState>;
  initialize(input: InitializeWorkspaceInput): Promise<InitializeWorkspaceResult>;
  requireReady(): Promise<ReadyWorkspace>;
}

/**
 * Internal-only error used to bubble structured "config is invalid"
 * reasons out of synchronous-style helpers without crossing public
 * class boundaries.
 */
class InvalidConfigError extends Error {}

/**
 * Build a {@link WorkspaceManager} bound to a single workspace root.
 *
 * The manager is a thin, stateless object: every method performs its
 * own I/O so concurrent invocations do not interfere. Multiple managers
 * pointing at the same root are equivalent; `initialize` is the only
 * mutating method and is idempotent.
 */
export function createWorkspaceManager(workspaceRoot: string): WorkspaceManager {
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    throw new Error("workspaceRoot must be a non-empty string.");
  }

  const resolvedRoot = resolve(workspaceRoot);
  const dataDir = join(resolvedRoot, WORKSPACE_DATA_DIR);
  const configPath = join(dataDir, CONFIG_FILENAME);

  /**
   * Read the config file (if it exists) and produce a structured result.
   * Missing files are not errors here; parse failures are reported with a
   * clear reason so {@link inspectState} can label them as `invalid`.
   */
  async function readConfigFile(): Promise<
    | { missing: true }
    | { missing: false; json: unknown }
  > {
    if (!existsSync(configPath)) {
      return { missing: true };
    }
    const raw = await readFile(configPath, "utf8");
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new InvalidConfigError(
        `config.json is not valid JSON (${reason}). Re-run initialize_performance_workspace after fixing ${configPath}.`,
      );
    }
    return { missing: false, json };
  }

  /**
   * Read, parse, validate, and path-check the config file. Returns the
   * usable config plus absolute paths, or an `InvalidConfigError` whose
   * message is safe to surface in MCP responses.
   */
  async function loadReadyConfig(): Promise<{
    config: WorkspaceConfig;
    paths: WorkspacePaths;
  }> {
    let file: Awaited<ReturnType<typeof readConfigFile>>;
    try {
      file = await readConfigFile();
    } catch (error) {
      if (error instanceof InvalidConfigError) {
        throw error;
      }
      throw new InvalidConfigError(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (file.missing) {
      throw new InvalidConfigError(
        `Workspace at ${resolvedRoot} has no config file (expected ${configPath}).`,
      );
    }
    const parsed = workspaceConfigSchema.safeParse(file.json);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const path = first?.path.length ? first.path.join(".") : "(root)";
      throw new InvalidConfigError(
        `Unsupported config schema at ${path}: ${first?.message ?? "validation failed"}.`,
      );
    }
    const config = parsed.data;
    let paths: WorkspacePaths;
    try {
      paths = resolveWorkspacePaths(resolvedRoot, config);
    } catch (error) {
      throw new InvalidConfigError(
        error instanceof Error ? error.message : String(error),
      );
    }
    try {
      await assertNoSymlinkEscape(resolvedRoot, paths.scenarioDirectory);
      await assertNoSymlinkEscape(resolvedRoot, paths.runsDirectory);
    } catch (error) {
      throw new InvalidConfigError(
        error instanceof Error ? error.message : String(error),
      );
    }
    return { config, paths };
  }

  /**
   * Build the `inspect()` response. Encapsulated so both `inspect` and
   * `requireReady` share the exact same classification logic.
   */
  async function inspectState(): Promise<WorkspaceState> {
    const base = { workspaceRoot: resolvedRoot, configPath };
    if (!existsSync(dataDir) || !existsSync(configPath)) {
      return { kind: "uninitialized", ...base };
    }
    try {
      const { config, paths } = await loadReadyConfig();
      return { kind: "ready", ...base, config, paths };
    } catch (error) {
      const reason =
        error instanceof InvalidConfigError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      return { kind: "invalid", ...base, reason };
    }
  }

  const manager: WorkspaceManager = {
    async inspect(): Promise<WorkspaceState> {
      return inspectState();
    },

    async initialize(input: InitializeWorkspaceInput): Promise<InitializeWorkspaceResult> {
      const configExists = existsSync(configPath);
      let config: WorkspaceConfig;

      if (configExists) {
        // Idempotent path: load, validate, and re-use the existing
        // config verbatim. We never overwrite an existing config file.
        const { config: existing } = await loadReadyConfig();
        config = existing;
      } else {
        // First-time path: create the data dir with restrictive perms,
        // then atomically write the merged config with 0o600 mode.
        await mkdir(dataDir, { recursive: true, mode: DIRECTORY_MODE });
        await chmod(dataDir, DIRECTORY_MODE);

        const defaults = defaultWorkspaceConfig();
        const next: WorkspaceConfig = { ...defaults };
        const app: { bundleId?: string; name?: string } = {};
        if (input.bundleId !== undefined && input.bundleId.length > 0) {
          app.bundleId = input.bundleId;
        }
        if (input.appName !== undefined && input.appName.length > 0) {
          app.name = input.appName;
        }
        if (app.bundleId !== undefined || app.name !== undefined) {
          next.app = app;
        }
        await writeFile(
          configPath,
          `${JSON.stringify(next, null, 2)}\n`,
          { mode: CONFIG_FILE_MODE },
        );
        await chmod(configPath, CONFIG_FILE_MODE);
        config = next;
      }

      // Ensure the scenario and runs directories exist with restrictive
      // perms. `recursive: true` makes this idempotent; existing dirs
      // are left untouched.
      const paths = resolveWorkspacePaths(resolvedRoot, config);
      await mkdir(paths.scenarioDirectory, {
        recursive: true,
        mode: DIRECTORY_MODE,
      });
      await chmod(paths.scenarioDirectory, DIRECTORY_MODE);
      await mkdir(paths.runsDirectory, {
        recursive: true,
        mode: DIRECTORY_MODE,
      });
      await chmod(paths.runsDirectory, DIRECTORY_MODE);

      // Optional seeding with embedded default scenarios. Honor
      // "do not overwrite" by checking existence per file.
      if (input.copyDefaultScenarios) {
        const templates = listEmbeddedTemplates();
        for (const template of templates) {
          const destination = join(paths.scenarioDirectory, template.name);
          if (existsSync(destination)) {
            continue;
          }
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, template.contents, "utf8");
        }
      }

      return { configPath, firstInitialization: !configExists };
    },

    async requireReady(): Promise<ReadyWorkspace> {
      const state = await inspectState();
      if (state.kind === "uninitialized") {
        throw new WorkspaceNotReadyError(
          `Workspace at ${resolvedRoot} has not been initialized. Call initialize_performance_workspace first (expected config: ${configPath}).`,
        );
      }
      if (state.kind === "invalid") {
        throw new WorkspaceInvalidError(
          `Workspace at ${resolvedRoot} is invalid (${state.reason}). Fix the config at ${configPath} and re-run initialize_performance_workspace.`,
        );
      }
      return {
        workspaceRoot: state.workspaceRoot,
        configPath: state.configPath,
        config: state.config,
        paths: state.paths,
      };
    },
  };

  return manager;
}
