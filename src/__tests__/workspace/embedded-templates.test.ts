import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { parseScenarioDocument } from "../../scenario/parser.js";
import { EMBEDDED_SCENARIO_TEMPLATES } from "../../workspace/embedded-templates.js";

/**
 * 内嵌模板会被 initialize_performance_workspace 直接复制到用户工作区，
 * 因此必须与场景 parser 的 schema 保持一致，否则用户第一次列场景就会失败。
 */
describe("embedded scenario templates", () => {
  for (const template of EMBEDDED_SCENARIO_TEMPLATES) {
    it(`parses ${template.name} with the scenario schema`, () => {
      const document = parseDocument(template.contents).toJS();
      const plan = parseScenarioDocument(document, template.name);

      expect(plan.source).toBe("scenario");
      expect(plan.actions.length).toBeGreaterThan(0);
    });
  }
});
