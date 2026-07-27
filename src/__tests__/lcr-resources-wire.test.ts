// The routing:// resources over the REAL MCP wire.
//
// lcr-resources.test.ts already covers ResourceProvider.listResources() and
// readResource() directly, and it passed for the entire time those two URIs were
// unreachable by any client: index.ts never called registerResource for them, so
// resources/list omitted them and resources/read answered -32602. A test that
// asserts against the provider's own declaration cannot see that gap, because
// the server never calls the method it asserts on.
//
// These tests therefore go through an MCP Client over InMemoryTransport, which
// is the same path a real caller takes. If registration is removed again, the
// enabled case fails on resources/list and on resources/read.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import { createSessionManager } from "../session-manager.js";
import { defaultLeastCostConfig, type LeastCostConfig, type PersistenceConfig } from "../config.js";

const ROUTING_URIS = ["routing://decisions", "routing://priors"] as const;

function mkPersistence(): PersistenceConfig {
  return {
    backend: "memory",
    acknowledgeEphemeral: true,
    logsDbPath: null,
    jobsDbPath: null,
    jobRetentionDays: 7,
    dedupWindowMs: 0,
    ownsOrphanRecovery: false,
    asyncJobsEnabled: true,
    sources: { configFile: null, envOverrides: [] },
  } as unknown as PersistenceConfig;
}

async function connect(leastCost: LeastCostConfig): Promise<Client> {
  const { createGatewayServer } = await import("../index.js");
  const server = createGatewayServer({
    asyncJobManager: new AsyncJobManager(noopLogger, undefined, new MemoryJobStore()),
    persistence: mkPersistence(),
    sessionManager: await createSessionManager(undefined, undefined, noopLogger),
    leastCost,
    isolateState: true,
  } as Parameters<typeof createGatewayServer>[0]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "lcr-wire-test", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("routing:// resources over the MCP wire (least-cost enabled)", () => {
  let client: Client;

  beforeAll(async () => {
    client = await connect({ ...defaultLeastCostConfig(), enabled: true });
  });

  afterAll(async () => {
    await client?.close();
  });

  it("lists both routing resources", async () => {
    const listed = new Set((await client.listResources()).resources.map(r => r.uri));
    for (const uri of ROUTING_URIS) {
      expect(listed.has(uri), `${uri} missing from resources/list`).toBe(true);
    }
  });

  it("serves a non-empty body for each, rather than -32602", async () => {
    for (const uri of ROUTING_URIS) {
      const result = await client.readResource({ uri });
      const text = (result.contents ?? [])
        .map(c => (typeof c.text === "string" ? c.text : ""))
        .join("");
      expect(text.length, `${uri} returned an empty body`).toBeGreaterThan(0);
      // Must be the real payload shape, not an error envelope rendered as text.
      expect(() => JSON.parse(text)).not.toThrow();
    }
  });
});

describe("routing:// resources stay dormant (least-cost disabled)", () => {
  let client: Client;

  beforeAll(async () => {
    client = await connect({ ...defaultLeastCostConfig(), enabled: false });
  });

  afterAll(async () => {
    await client?.close();
  });

  it("does not list them", async () => {
    const listed = new Set((await client.listResources()).resources.map(r => r.uri));
    for (const uri of ROUTING_URIS) {
      expect(listed.has(uri), `${uri} leaked into resources/list while disabled`).toBe(false);
    }
  });

  it("refuses to read them", async () => {
    for (const uri of ROUTING_URIS) {
      await expect(
        client.readResource({ uri }),
        `${uri} was readable while disabled`
      ).rejects.toThrow();
    }
  });
});
