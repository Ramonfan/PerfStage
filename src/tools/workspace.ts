import { posix, sep } from "node:path";
import { z } from "zod";
import type {
  InitializeWorkspaceInput,
  ReadyWorkspace,
  WorkspaceManager,
} from "../workspace/manager.js";

/**
 * Input shape for `initialize_performance_workspace`. Every field is
 * optional; the manager always writes a usable default configuration
 * and creates the standard directories on first use.
 *
 * `bundleId` and `appName` are persisted into `config.json` only when
 * non-empty. `copyDefaultScenarios` defaults to false so initialization
 * never silently clobbers custom scenarios.
 */
export const initializeWorkspaceInputSchema = z
  .object({
    bundleId: z.string().min(1).optional(),
    appName: z.string().min(1).optional(),
    copyDefaultScenarios: z.boolean().optional(),
  })
  .strict();

export interface InitializePerformanceWorkspaceError {
  error: string;
}

export interface InitializePerformanceWorkspaceResult {
  initialized: true;
  configPath: string;
  scenarioDirectory: string;
  runsDirectory: string;
  firstInitialization: boolean;
  nextSteps: string[];
}

export type InitializePerformanceWorkspaceHandlerResult =
  | InitializePerformanceWorkspaceResult
  | InitializePerformanceWorkspaceError;

/**
 * Shared options accepted by the initialization handler. The
 * `WorkspaceManager` is required because initialization is meaningless
 * without a target workspace root.
 */
export interface InitializeOptions {
  workspaceManager: WorkspaceManager;
  now: () => Date;
}

/**
 * Convert an absolute path into the POSIX-form, workspace-relative
 * path. When the absolute path lives outside the workspace root (which
 * would indicate a configuration bug) we return the original absolute
 * string so the caller can see the underlying directory.
 */
export function toWorkspaceRelativePath(
  workspaceRoot: string,
  absolutePath: string,
): string {
  const normalizedRoot = workspaceRoot.split(sep).join(posix.sep);
  const normalizedTarget = absolutePath.split(sep).join(posix.sep);
  const relative = posix.relative(normalizedRoot, normalizedTarget);
  if (relative === "" || relative.startsWith("..")) {
    return absolutePath;
  }
  return relative;
}

/**
 * Build the ordered "next steps" surfaced to Claude after a successful
 * initialization. The list assumes a fresh workspace and walks Claude
 * through the typical discover → prepare → execute → finalize loop.
 */
function buildNextSteps(
  ready: ReadyWorkspace,
  firstInitialization: boolean,
): string[] {
  const scenarioDir = ready.config.scenarioDirectory;
  const runsDir = ready.config.runsDirectory;
  const header = firstInitialization
    ? "性能工作区已就绪。请按下列顺序继续："
    : "性能工作区已存在，已重新校验。请按下列顺序继续：";
  return [
    header,
    `1. 工作区根：${ready.workspaceRoot}`,
    `2. 场景目录（相对于工作区）：${scenarioDir}`,
    `3. 运行目录（相对于工作区）：${runsDir}`,
    "4. 调用 list_performance_scenarios 枚举当前可用场景；如需先植入模板，请重新调用 initialize_performance_workspace 时设置 copyDefaultScenarios=true。",
    "5. 调用 prepare_performance_test（传入 scenarioId 或 adHocPlan 与 device）创建 prepared 状态的 TestRun 并获取执行步骤。",
    "6. 完成动作/指标/诊断采集后，调用 finalize_performance_test 写入 report.json 与 report.md。",
  ];
}

/**
 * Shared handler backing both the production MCP tool and the test
 * harness. The function:
 *
 *   1. validates the input through {@link initializeWorkspaceInputSchema},
 *   2. delegates to {@link WorkspaceManager.initialize} for the actual
 *      config/directory setup,
 *   3. re-resolves the ready workspace so it can return the canonical
 *      workspace-relative paths alongside `firstInitialization`,
 *   4. emits an ordered next-steps list so Claude knows which MCP method
 *      to call next.
 *
 * The handler must remain available regardless of the workspace's
 * current state — initializing a brand-new workspace is the very first
 * step the protocol needs to support.
 */
export async function initializePerformanceWorkspace(
  rawInput: unknown,
  options: InitializeOptions,
): Promise<InitializePerformanceWorkspaceHandlerResult> {
  const parsed = initializeWorkspaceInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      error: `initialize_performance_workspace 输入校验失败：${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    };
  }
  const input = parsed.data;

  const managerInput: InitializeWorkspaceInput = {
    ...(input.bundleId !== undefined ? { bundleId: input.bundleId } : {}),
    ...(input.appName !== undefined ? { appName: input.appName } : {}),
    ...(input.copyDefaultScenarios !== undefined
      ? { copyDefaultScenarios: input.copyDefaultScenarios }
      : {}),
  };

  let initializeResult;
  try {
    initializeResult = await options.workspaceManager.initialize(managerInput);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `无法初始化性能工作区：${message}` };
  }

  let ready: ReadyWorkspace;
  try {
    ready = await options.workspaceManager.requireReady();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `工作区初始化后无法读取：${message}` };
  }

  return {
    initialized: true,
    configPath: initializeResult.configPath,
    scenarioDirectory: ready.config.scenarioDirectory,
    runsDirectory: ready.config.runsDirectory,
    firstInitialization: initializeResult.firstInitialization,
    nextSteps: buildNextSteps(ready, initializeResult.firstInitialization),
  };
}