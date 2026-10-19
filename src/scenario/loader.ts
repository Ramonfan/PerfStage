import { promises as fs } from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import type { TestPlan } from "../model/test-plan.js";
import { parseScenarioDocument } from "./parser.js";

const SCENARIO_EXTENSIONS = new Set([".yaml", ".yml"]);

function withFilePath(filePath: string, message: string): string {
  return `${filePath}: ${message}`;
}

export async function listScenarioFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => SCENARIO_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .map((name) => path.join(directory, name));
  files.sort();
  return files;
}

export async function loadScenario(filePath: string): Promise<TestPlan> {
  let contents: string;
  try {
    contents = await fs.readFile(filePath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      withFilePath(
        filePath,
        `unable to read scenario file (${reason})`,
      ),
    );
  }

  let document: unknown;
  try {
    document = parseDocument(contents).toJS();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      withFilePath(filePath, `invalid YAML (${reason})`),
    );
  }

  try {
    return parseScenarioDocument(document, filePath);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(
        error.message.startsWith(`${filePath}:`)
          ? error.message
          : withFilePath(filePath, error.message),
      );
    }
    throw error;
  }
}

export async function loadAllScenarios(directory: string): Promise<TestPlan[]> {
  const files = await listScenarioFiles(directory);
  const plans: TestPlan[] = [];
  for (const filePath of files) {
    plans.push(await loadScenario(filePath));
  }
  return plans;
}
