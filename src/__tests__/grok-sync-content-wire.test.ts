/**
 * Issue #1 — wire-level regression: sync grok_request reply must survive the
 * MCP protocol round-trip AND be recoverable from structuredContent.
 *
 * The localisation test (grok-sync-content.test.ts) asserts the handler's own
 * return value. That stops short of the transport: it never runs the
 * client-side `CallToolResultSchema` parse, and never proves the reply is
 * reachable by a client that prefers `structuredContent`.
 *
 * This test drives a REAL MCP `Client` against a real gateway `McpServer` over
 * an in-memory linked transport pair, so `client.callTool()` deserialises the
 * result through `CallToolResultSchema` exactly as a production client does.
 *
 * It pins the Issue #1 fix on two facts that must hold together:
 *   1. `grok_request` declares NO `outputSchema` (tools/list), yet the result
 *      carries `structuredContent` — the contract inversion that lets a
 *      conformant client treat structuredContent as authoritative.
 *   2. Because the reply is mirrored into `structuredContent.response`, such a
 *      client still recovers the model output even if it ignores content[0].
 *
 * Reverting the `response: finalStdout` mirror in `buildCliResponse` turns the
 * structuredContent.response assertion red.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import { createSessionManager } from "../session-manager.js";
import type { PersistenceConfig } from "../config.js";

const GROK_REPLY = "GROK_WIRE_REPLY: the quick brown fox jumped over 42 lazy dogs.";

// Mock executeCli + getExtendedPath so the sync handler (SYNC_DEADLINE_MS=0
// routes through executeCli, bypassing the spawn-based job manager) sees a
// stubbed grok reply. Mirrors grok-sync-content.test.ts.
vi.mock("../executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../executor.js")>();
  return {
    ...actual,
    getExtendedPath: vi.fn(() => process.env.PATH || ""),
    executeCli: vi.fn(async (command: string, _args: string[], _options?: any) => {
      if (command === "grok") {
        return { stdout: GROK_REPLY, stderr: "", code: 0 };
      }
      return actual.executeCli(command, _args, _options);
    }),
  };
});

function mkPersistence(): PersistenceConfig {
  return {
    backend: "memory",
    path: null,
    dsn: null,
    retentionDays: 30,
    dedupWindowMs: 3600000,
    acknowledgeEphemeral: true,
    ownsOrphanRecovery: false,
    asyncJobsEnabled: true,
    sources: { configFile: null, envOverrides: [] },
  };
}

describe("Issue #1 — grok sync reply over the MCP wire", () => {
  let createGatewayServer: (typeof import("../index.js"))["createGatewayServer"];
  let client: Client;
  let originalDeadline: string | undefined;

  beforeAll(async () => {
    originalDeadline = process.env.SYNC_DEADLINE_MS;
    // Force the synchronous direct-execute path through the mocked executeCli.
    // Read once at index.js module-eval time, so set it BEFORE importing.
    process.env.SYNC_DEADLINE_MS = "0";
    ({ createGatewayServer } = await import("../index.js"));

    const server = createGatewayServer({
      asyncJobManager: new AsyncJobManager(noopLogger, undefined, new MemoryJobStore()),
      persistence: mkPersistence(),
      sessionManager: await createSessionManager(undefined, undefined, noopLogger),
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "issue-1-wire-test", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client?.close();
    if (originalDeadline === undefined) delete process.env.SYNC_DEADLINE_MS;
    else process.env.SYNC_DEADLINE_MS = originalDeadline;
  });

  it("grok_request declares no outputSchema yet returns structuredContent", async () => {
    const { tools } = await client.listTools();
    const grok = tools.find(t => t.name === "grok_request");
    expect(grok, "grok_request not registered").toBeDefined();
    // The contract inversion that motivates the fix: structuredContent is sent
    // without a declared outputSchema, so a conformant client may treat it as
    // authoritative and never render content[0].text.
    expect(grok!.outputSchema).toBeUndefined();
  });

  it("surfaces the reply in BOTH content[0].text and structuredContent.response after a real round-trip", async () => {
    const result = (await client.callTool({
      name: "grok_request",
      arguments: { prompt: "say the line", approvalStrategy: "legacy" },
    })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
      structuredContent?: Record<string, unknown>;
    };

    expect(result.isError).toBeFalsy();

    // Unstructured content survives the client-side CallToolResultSchema parse.
    expect(result.content[0]).toBeDefined();
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain(GROK_REPLY);

    // Issue #1 fix: a structuredContent-preferring client recovers the reply
    // from structuredContent alone — without reading content[0].
    expect(result.structuredContent).toBeDefined();
    expect(result.structuredContent).toMatchObject({ cli: "grok", exitCode: 0 });
    expect(result.structuredContent!.response, "structuredContent.response missing").toBeTypeOf(
      "string"
    );
    expect(result.structuredContent!.response).toContain(GROK_REPLY);
  });
});
