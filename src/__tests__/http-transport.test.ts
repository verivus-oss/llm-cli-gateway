import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpGateway, type HttpGatewayHandle } from "../http-transport.js";

// Layer 6 / U20: HTTP MCP transport coverage with mocked gateway server.
//
// We construct a minimal McpServer that exposes a single deterministic tool
// (echo) so we can exercise the real Streamable HTTP transport, real bearer
// auth, real session lifecycle, and real shutdown without spawning provider
// CLIs.

const TEST_TOKEN = "test-bearer-XYZ-987";
const ORIGINAL_ENV = { ...process.env };

function makeEchoServer(): McpServer {
  const server = new McpServer({ name: "echo-test-server", version: "0.0.1" });
  server.tool("echo", { value: z.string().describe("Value to echo back.") }, async ({ value }) => ({
    content: [{ type: "text" as const, text: `echo:${value}` }],
    structuredContent: { value },
  }));
  return server;
}

function withAuth(token: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  };
}

async function startGateway(): Promise<HttpGatewayHandle> {
  return startHttpGateway({
    host: "127.0.0.1",
    port: 0, // ephemeral
    path: "/mcp",
    createGatewayServer: () => makeEchoServer(),
  });
}

function parseSseOrJson(body: string): any {
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  // Streamable HTTP returns server-sent events: "event:" / "data: <json>".
  const dataLine = trimmed.split(/\r?\n/).find(line => line.startsWith("data:"));
  if (!dataLine) {
    throw new Error(`No JSON payload in response body: ${body}`);
  }
  return JSON.parse(dataLine.slice("data:".length).trim());
}

describe("Layer 6 HTTP MCP transport (U20)", () => {
  let gateway: HttpGatewayHandle | null = null;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, LLM_GATEWAY_AUTH_TOKEN: TEST_TOKEN };
    delete process.env.LLM_GATEWAY_AUTH_DISABLED;
    delete process.env.LLM_GATEWAY_NO_AUTH_PATHS;
  });

  afterEach(async () => {
    if (gateway) {
      await gateway.close();
      gateway = null;
    }
    process.env = { ...ORIGINAL_ENV };
  });

  it("rejects requests with no Authorization header without leaking auth details", async () => {
    gateway = await startGateway();
    const response = await fetch(gateway.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer/);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBeDefined();
    expect(body.error).not.toContain(TEST_TOKEN);
  });

  it("rejects requests with an incorrect bearer token", async () => {
    gateway = await startGateway();
    const response = await fetch(gateway.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("Unauthorized");
  });

  it("serves configured no-auth connector paths while keeping /mcp protected", async () => {
    process.env.LLM_GATEWAY_NO_AUTH_PATHS = "/chatgpt/unit-test/mcp";
    gateway = await startGateway();

    const protectedResponse = await fetch(gateway.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(protectedResponse.status).toBe(401);

    const chatGPTUrl = new URL("/chatgpt/unit-test/mcp", gateway.url).toString();
    const connectorResponse = await fetch(chatGPTUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "chatgpt-test", version: "0.0.1" },
        },
      }),
    });
    expect(connectorResponse.status).toBe(200);
  });

  it("returns 503 when HTTP transport is started without LLM_GATEWAY_AUTH_TOKEN", async () => {
    delete process.env.LLM_GATEWAY_AUTH_TOKEN;
    gateway = await startGateway();
    const response = await fetch(gateway.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer anything" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).toBe(503);
  });

  it("serves /healthz without auth and reports the live session count", async () => {
    gateway = await startGateway();
    const healthUrl = new URL("/healthz", gateway.url).toString();
    const response = await fetch(healthUrl);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; sessions: number };
    expect(body.ok).toBe(true);
    expect(body.sessions).toBe(0);
  });

  it("returns 404 for unknown paths on the gateway host", async () => {
    gateway = await startGateway();
    const otherUrl = new URL("/not-an-endpoint", gateway.url).toString();
    const response = await fetch(otherUrl, withAuth(TEST_TOKEN));
    expect(response.status).toBe(404);
  });

  it("rejects a non-initialize POST without a session id", async () => {
    gateway = await startGateway();
    const response = await fetch(
      gateway.url,
      withAuth(TEST_TOKEN, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toMatch(/initialize/i);
  });

  it("completes initialize → tools/list → tools/call via the real MCP client over HTTP", async () => {
    gateway = await startGateway();
    const transport = new StreamableHTTPClientTransport(new URL(gateway.url), {
      requestInit: { headers: { authorization: `Bearer ${TEST_TOKEN}` } },
    });
    const client = new Client({ name: "u20-test-client", version: "0.0.1" }, {});

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map(t => t.name)).toContain("echo");
      expect(gateway.sessionCount()).toBe(1);

      const callResult = await client.callTool({
        name: "echo",
        arguments: { value: "hello-mcp" },
      });
      const contentArray = (callResult.content ?? []) as Array<{ type: string; text?: string }>;
      const firstContent = contentArray[0];
      expect(firstContent?.type).toBe("text");
      expect(firstContent?.text).toBe("echo:hello-mcp");
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it("closes active transports and clears sessions on shutdown", async () => {
    gateway = await startGateway();
    const transport = new StreamableHTTPClientTransport(new URL(gateway.url), {
      requestInit: { headers: { authorization: `Bearer ${TEST_TOKEN}` } },
    });
    const client = new Client({ name: "u20-shutdown-client", version: "0.0.1" }, {});
    await client.connect(transport);
    expect(gateway.sessionCount()).toBe(1);

    await gateway.close();
    expect(gateway.sessionCount()).toBe(0);
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    // Prevent afterEach from double-closing.
    gateway = null;
  });

  it("rejects DELETE requests that do not include the mcp-session-id header", async () => {
    gateway = await startGateway();
    const response = await fetch(gateway.url, withAuth(TEST_TOKEN, { method: "DELETE" }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toMatch(/mcp-session-id/);
  });

  it("rejects PUT (an unsupported method) with allow headers", async () => {
    gateway = await startGateway();
    const response = await fetch(gateway.url, withAuth(TEST_TOKEN, { method: "PUT", body: "{}" }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toContain("POST");
    // Allow header negotiation makes it safe for clients to discover supported verbs.
  });

  it("returns 404 for a POST that references an unknown mcp-session-id", async () => {
    gateway = await startGateway();
    const response = await fetch(
      gateway.url,
      withAuth(TEST_TOKEN, {
        method: "POST",
        headers: { "mcp-session-id": "deadbeef-not-a-real-session" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
    );
    expect(response.status).toBe(404);
  });

  it("parses a successful initialize response into a JSON-RPC payload", async () => {
    gateway = await startGateway();
    const response = await fetch(
      gateway.url,
      withAuth(TEST_TOKEN, {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "fetch-test", version: "0.0.1" },
          },
        }),
      })
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    const message = parseSseOrJson(text);
    expect(message.jsonrpc).toBe("2.0");
    expect(message.result).toBeDefined();
    expect(message.result.serverInfo).toBeDefined();
  });
});
