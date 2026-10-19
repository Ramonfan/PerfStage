import { z } from "zod";

/**
 * Workspace-scoped configuration for the performance-test MCP.
 *
 * The schema is intentionally narrow: only the fields the rest of the
 * system needs are accepted. Forward compatibility is preserved by
 * re-parsing unknown objects elsewhere (e.g. scenario YAML) — here we want
 * every persisted config to be self-describing.
 */
export const workspaceConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    app: z
      .object({
        bundleId: z.string().min(1).optional(),
        name: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    scenarioDirectory: z.string().min(1),
    runsDirectory: z.string().min(1),
  })
  .strict();

export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;

/**
 * Default workspace configuration: no app binding, scenario and run
 * directories nested under the standard `.performance-test` folder.
 *
 * The returned object is plain JSON so it can be safely written to disk and
 * round-tripped through {@link workspaceConfigSchema}.
 */
export function defaultWorkspaceConfig(): WorkspaceConfig {
  return {
    schemaVersion: 1,
    scenarioDirectory: ".performance-test/scenarios",
    runsDirectory: ".performance-test/runs",
  };
}
