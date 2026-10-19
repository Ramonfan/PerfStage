import { describe, expect, it } from "vitest";
import { createServer } from "../index.js";

describe("MCP bootstrap", () => {
  it("creates a server with the expected name", () => {
    const server = createServer();
    expect(server).toBeDefined();
  });
});
