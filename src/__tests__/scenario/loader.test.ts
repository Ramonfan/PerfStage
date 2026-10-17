import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listScenarioFiles,
  loadAllScenarios,
  loadScenario,
} from "../../scenario/loader.js";

async function makeScenarioDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

const validActionFragment = (id: string) =>
  `id: ${id}\napp: { bundleId: com.nndev.im }\nactions:\n  - id: step\n    type: wait\n    durationMs: 100`;

const communityYaml = `
id: community-home-scroll
name: 社区首页来回滚动
app:
  bundleId: com.nndev.im
device: {}
preconditions:
  foregroundBundleId: com.nndev.im
  accessibilityText: 社区
warmup:
  - id: open-community
    type: tap
    target: 社区
    waitAfterMs: 1500
actions:
  - id: scroll-up-1
    type: swipe
    direction: up
    distance: 700
    durationMs: 500
    waitAfterMs: 1500
  - id: scroll-down-1
    type: swipe
    direction: down
    distance: 700
    durationMs: 500
    waitAfterMs: 1500
metrics:
  - name: hitches
    instrument: Animation Hitches
`;

describe("loader", () => {
  it("loads one scenario file into a TestPlan", async () => {
    const dir = await makeScenarioDir("loader-single");
    const filePath = path.join(dir, "community.yaml");
    await fs.writeFile(filePath, communityYaml, "utf8");

    const plan = await loadScenario(filePath);
    expect(plan.id).toBe("community-home-scroll");
    expect(plan.source).toBe("scenario");
    expect(plan.actions).toHaveLength(2);
    expect(plan.warmup[0]?.type).toBe("tap");
  });

  it("includes the file path in thrown errors", async () => {
    const dir = await makeScenarioDir("loader-error");
    const filePath = path.join(dir, "broken.yaml");
    await fs.writeFile(
      filePath,
      "id: broken\napp: { bundleId: com.nndev.im }\nactions:\n  - id: bad\n    type: unknown\n",
      "utf8",
    );
    await expect(loadScenario(filePath)).rejects.toThrow(/broken\.yaml/);
  });

  it("rejects unreadable files", async () => {
    const dir = await makeScenarioDir("loader-missing");
    const missing = path.join(dir, "absent.yaml");
    await expect(loadScenario(missing)).rejects.toThrow(/absent\.yaml/);
  });

  it("lists scenario files sorted lexicographically", async () => {
    const dir = await makeScenarioDir("loader-list");
    await fs.writeFile(path.join(dir, "zeta.yaml"), `${validActionFragment("zeta")}\n`, "utf8");
    await fs.writeFile(path.join(dir, "alpha.yml"), `${validActionFragment("alpha")}\n`, "utf8");
    await fs.writeFile(path.join(dir, "ignore.txt"), "ignore\n", "utf8");

    const files = await listScenarioFiles(dir);
    expect(files.map((p) => path.basename(p))).toEqual(["alpha.yml", "zeta.yaml"]);
  });

  it("loads every scenario under the directory", async () => {
    const dir = await makeScenarioDir("loader-all");
    await fs.writeFile(path.join(dir, "b.yaml"), `${validActionFragment("b")}\n`, "utf8");
    await fs.writeFile(path.join(dir, "a.yaml"), `${validActionFragment("a")}\n`, "utf8");

    const plans = await loadAllScenarios(dir);
    expect(plans.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("includes the file path when listing throws on a malformed scenario", async () => {
    const dir = await makeScenarioDir("loader-all-broken");
    await fs.writeFile(path.join(dir, "good.yaml"), `${validActionFragment("good")}\n`, "utf8");
    await fs.writeFile(
      path.join(dir, "broken.yaml"),
      "id: broken\napp: { bundleId: x }\nactions:\n  - id: bad\n    type: ??\n",
      "utf8",
    );
    await expect(loadAllScenarios(dir)).rejects.toThrow(/broken\.yaml/);
  });
});
