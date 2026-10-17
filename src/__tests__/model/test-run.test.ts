import { describe, expect, it } from "vitest";
import { transitionRunStatus } from "../../model/test-run.js";

describe("transitionRunStatus", () => {
  it("allows prepared -> running -> completed", () => {
    expect(transitionRunStatus("prepared", "running")).toBe("running");
    expect(transitionRunStatus("running", "completed")).toBe("completed");
  });

  it("rejects completed -> running", () => {
    expect(() => transitionRunStatus("completed", "running")).toThrow(
      /completed/,
    );
  });
});
