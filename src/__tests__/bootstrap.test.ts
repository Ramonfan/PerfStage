import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../index.js";
import { getVersion } from "../version.js";

describe("MCP bootstrap", () => {
  it("creates a server with the expected name", () => {
    const server = createServer();
    expect(server).toBeDefined();
  });

  it("advertises the package version during the handshake", async () => {
    const server = createServer();
    const client = new Client(
      { name: "bootstrap-check", version: "0.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    try {
      expect(client.getServerVersion()?.version).toBe(getVersion());
    } finally {
      await client.close();
      await server.close();
    }
  });
});
