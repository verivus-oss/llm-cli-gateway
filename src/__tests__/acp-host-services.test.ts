/**
 * ACP deny-by-default HostServices tests (plan step define-host-services-boundary).
 *
 * Two layers:
 *   1. Unit: call GatewayHostServices directly and assert every side-effect
 *      request is denied (read/write throw permission_denied; permission returns
 *      a cancelled outcome) and that no request field (path/content/options)
 *      leaks into the denial.
 *   2. End to end: drive the REAL AcpClient + transport with a mock agent that
 *      issues fs/write_text_file and session/request_permission callbacks, and
 *      assert the client answers with a valid JSON-RPC error / cancelled outcome
 *      — a denial, never a process crash.
 */
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { AcpClient, type HostCallbackContext } from "../acp/client.js";
import { GatewayHostServices } from "../acp/host-services.js";
import { JsonRpcStdioTransport } from "../acp/json-rpc-stdio.js";
import type {
  ReadTextFileRequest,
  RequestPermissionRequest,
  WriteTextFileRequest,
} from "../acp/types.js";

const CTX = (method: string): HostCallbackContext => ({ provider: "mistral", method });

describe("GatewayHostServices — deny-by-default (unit)", () => {
  it("denies fs/read_text_file with a permission_denied error", async () => {
    const host = new GatewayHostServices();
    const request: ReadTextFileRequest = { sessionId: "s1", path: "/etc/passwd" };
    await expect(host.readTextFile(request, CTX("fs/read_text_file"))).rejects.toMatchObject({
      kind: "permission_denied",
    });
  });

  it("denies fs/write_text_file with a permission_denied error", async () => {
    const host = new GatewayHostServices();
    const request: WriteTextFileRequest = { sessionId: "s1", path: "/tmp/x", content: "hi" };
    await expect(host.writeTextFile(request, CTX("fs/write_text_file"))).rejects.toMatchObject({
      kind: "permission_denied",
    });
  });

  it("denies session/request_permission by returning a cancelled outcome (does not throw)", async () => {
    const host = new GatewayHostServices();
    const request: RequestPermissionRequest = {
      sessionId: "s1",
      options: [{ optionId: "allow", name: "Allow" }],
      toolCall: { title: "write file" },
    };
    const response = await host.requestPermission(request, CTX("session/request_permission"));
    expect(response.outcome).toEqual({ outcome: "cancelled" });
  });

  it("never leaks the requested path into the read denial message", async () => {
    const host = new GatewayHostServices();
    const secretPath = "/home/secret/SENSITIVE-FILE.txt";
    const request: ReadTextFileRequest = { sessionId: "s1", path: secretPath };
    let caught: unknown;
    try {
      await host.readTextFile(request, CTX("fs/read_text_file"));
    } catch (err) {
      caught = err;
    }
    const message = (caught as { userMessage?: string; message?: string }).userMessage ?? "";
    expect(message).not.toContain("SENSITIVE-FILE");
    expect(message).not.toContain(secretPath);
  });

  it("never leaks the write content/path into the write denial message", async () => {
    const host = new GatewayHostServices();
    const request: WriteTextFileRequest = {
      sessionId: "s1",
      path: "/home/secret/OUT.txt",
      content: "TOP-SECRET-CONTENT",
    };
    let caught: unknown;
    try {
      await host.writeTextFile(request, CTX("fs/write_text_file"));
    } catch (err) {
      caught = err;
    }
    const message = (caught as { userMessage?: string }).userMessage ?? "";
    expect(message).not.toContain("TOP-SECRET-CONTENT");
    expect(message).not.toContain("OUT.txt");
  });
});

// ---------------------------------------------------------------------------
// End-to-end through the real client + transport with a mock agent.
// ---------------------------------------------------------------------------

interface Frame {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

class MockAgent {
  readonly clientToAgent = new PassThrough();
  readonly agentToClient = new PassThrough();
  readonly agentStderr = new PassThrough();
  readonly received: Frame[] = [];
  private buffer = "";

  constructor() {
    this.clientToAgent.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let nl = this.buffer.indexOf("\n");
      while (nl !== -1) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (line.trim().length > 0) this.received.push(JSON.parse(line) as Frame);
        nl = this.buffer.indexOf("\n");
      }
    });
  }

  /** Push an agent-initiated host callback request. */
  request(id: number | string, method: string, params: unknown): void {
    this.agentToClient.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  }

  /** Wait until a response frame for `id` is captured. */
  async waitForResponse(id: number | string): Promise<Frame> {
    for (let i = 0; i < 200; i++) {
      const frame = this.received.find(f => f.id === id && (f.result !== undefined || f.error));
      if (frame) return frame;
      await new Promise(r => setTimeout(r, 5));
    }
    throw new Error(`no response for id ${id}`);
  }
}

function wireClient(agent: MockAgent): AcpClient {
  let client!: AcpClient;
  const transport = new JsonRpcStdioTransport({
    streams: { stdin: agent.clientToAgent, stdout: agent.agentToClient, stderr: agent.agentStderr },
    provider: "mistral",
    onNotification: n => client.handleNotification(n.method, n.params),
    onRequest: r => client.handleRequest(r.id, r.method, r.params),
  });
  client = new AcpClient({
    transport,
    provider: "mistral",
    hostServices: new GatewayHostServices(),
  });
  return client;
}

describe("GatewayHostServices — end to end through the client", () => {
  it("answers an agent fs/write_text_file with a JSON-RPC error (denied, not a crash)", async () => {
    const agent = new MockAgent();
    wireClient(agent);
    agent.request(11, "fs/write_text_file", { sessionId: "s1", path: "/tmp/x", content: "hi" });
    const response = await agent.waitForResponse(11);
    expect(response.error).toBeDefined();
    expect(response.result).toBeUndefined();
    // The denial message must not echo the path/content.
    expect(JSON.stringify(response)).not.toContain("/tmp/x");
  });

  it("answers an agent session/request_permission with a cancelled outcome", async () => {
    const agent = new MockAgent();
    wireClient(agent);
    agent.request(12, "session/request_permission", {
      sessionId: "s1",
      options: [{ optionId: "allow", name: "Allow" }],
      toolCall: {},
    });
    const response = await agent.waitForResponse(12);
    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({ outcome: { outcome: "cancelled" } });
  });
});
