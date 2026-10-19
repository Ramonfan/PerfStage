import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceManager, type WorkspaceManager } from "../../workspace/manager.js";
import { createRunStore, type RunStore } from "../../storage/runs.js";
import {
  initializePerformanceWorkspace,
  type InitializePerformanceWorkspaceResult,
} from "../../tools/workspace.js";
import { listPerformanceScenarios } from "../../tools/scenarios.js";
import { preparePerformanceTest } from "../../tools/plan.js";
import { finalizePerformanceTest } from "../../tools/report.js";
import {
  resolveReadyWorkspace,
  type RegisterOptions,
} from "../../tools/index.js";

/**
 * Workspace-aware test harness. Mirrors the production
 * `registerTools()` flow: the readiness guard runs INSIDE each handler,
 * so the harness never throws on an uninitialized workspace — it
 * returns the same `{ error }` envelope Claude would see.
 *
 * The harness owns its own temporary directory and removes it during
 * `cleanup()`. The workspace is NOT pre-initialized: callers that need a
 * ready workspace must invoke `initialize_performance_workspace` first
 * (this matches the production flow where the very first tool call from
 * Claude seeds the workspace).
 */
export interface WorkspaceToolHarness {
  readonly root: string;
  readonly workspaceManager: WorkspaceManager;
  /**
   * Direct, untyped dispatcher matching the public tool contract. Each
   * branch invokes the same handler the production server uses.
   */
  call<T = unknown>(toolName: string, args?: unknown): Promise<T>;
  /**
   * Read scenario file names inside the workspace scenario directory.
   * Returns an empty array when the workspace has not been initialized.
   */
  listScenarioFiles(): Promise<string[]>;
  cleanup(): Promise<void>;
}

export async function createWorkspaceToolHarness(
  rootOverride?: string,
): Promise<WorkspaceToolHarness> {
  const root =
    rootOverride ??
    (await mkdtemp(join(tmpdir(), "performance-mcp-workspace-")));
  await mkdir(root, { recursive: true });
  const workspaceManager = createWorkspaceManager(root);

  /**
   * Build the {@link RegisterOptions} for a single tool call. The
   * harness passes `workspaceManager` plus a clock; the handler's own
   * readiness guard picks `scenarioDir` / `runStore` from the ready
   * workspace (or returns a structured error when not initialized).
   * `scenarioDir` and `runStore` are seeded with placeholder values so
   * the type stays honest; the readiness guard overwrites them before
   * any handler runs.
   */
  const buildOptions = (): RegisterOptions => ({
    workspaceManager,
    scenarioDir: join(root, ".performance-test", "scenarios"),
    runStore: createRunStore(join(root, ".performance-test", "runs")),
    now: () => new Date(),
  });

  const harness: WorkspaceToolHarness = {
    root,
    workspaceManager,
    async call<T = unknown>(toolName: string, args?: unknown): Promise<T> {
      if (toolName === "initialize_performance_workspace") {
        return (await initializePerformanceWorkspace(args ?? {}, {
          workspaceManager,
          now: () => new Date(),
        })) as T;
      }
      const options = buildOptions();
      const resolved = await resolveReadyWorkspace(options);
      if (resolved.kind === "error") {
        return { error: resolved.error } as T;
      }
      const resolvedOptions: RegisterOptions = {
        ...options,
        scenarioDir: resolved.scenarioDir,
        runStore: resolved.runStore,
      };
      if (toolName === "list_performance_scenarios") {
        return (await listPerformanceScenarios(resolvedOptions)) as T;
      }
      if (toolName === "prepare_performance_test") {
        return (await preparePerformanceTest(args ?? {}, resolvedOptions)) as T;
      }
      if (toolName === "finalize_performance_test") {
        return (await finalizePerformanceTest(args ?? {}, resolvedOptions)) as T;
      }
      throw new Error(`unknown tool "${toolName}"`);
    },
    async listScenarioFiles(): Promise<string[]> {
      try {
        const ready = await workspaceManager.requireReady();
        return readdir(ready.paths.scenarioDirectory);
      } catch {
        return [];
      }
    },
    async cleanup(): Promise<void> {
      await rm(root, { recursive: true, force: true });
    },
  };

  return harness;
}

/**
 * Convenience wrappers / types re-exported so existing tests can
 * opt-in to the new harness without rewriting boilerplate.
 */
export interface ToolError {
  error: string;
}

export function isToolError(value: unknown): value is ToolError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { error?: unknown }).error === "string"
  );
}

export type { InitializePerformanceWorkspaceResult, RunStore };