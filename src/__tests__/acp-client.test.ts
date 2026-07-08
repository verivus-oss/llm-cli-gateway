import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AcpClient, type AcpClientCallbacks, type HostServices } from "../acp/client.js";
import {
  AcpError,
  AcpMethodUnsupportedError,
  AcpMutatingDisabledError,
  AcpPermissionDeniedError,
  AcpProtocolError,
  AcpTimeoutError,
} from "../acp/errors.js";
import { JsonRpcStdioTransport, type ProviderStdioStreams } from "../acp/json-rpc-stdio.js";
import type { RequestPermissionResponse, SessionUpdateNotification } from "../acp/types.js";
import type { Logger } from "../logger.js";

// Step: implement-acp-client-core.
// Validation: mock-agent integration tests prove initialize/session-new/
// session-prompt flows work through the client and that protocol errors become
// structured gateway errors with redacted messages.
//
// test_matrix.integration.mock_acp_agent rows exercised here:
//  - initialize plus session/new smoke
//  - successful prompt with session/update notifications
//  - prompt cancellation
//  - permission request denied by default

function makeLogger(): Logger {
  return { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() };
}

interface JsonRpcFrame {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * A scriptable mock ACP agent that speaks newline-delimited JSON-RPC. It reads
 * the client's outbound frames from `clientToAgent` (the transport's stdin) and
 * pushes its own frames into `agentToClient` (the transport's stdout). This
 * drives the *real* transport and the *real* client end to end.
 */
class MockAgent {
  /** Agent reads client requests from here (transport stdin). */
  readonly clientToAgent = new PassThrough();
  /** Agent writes its frames here (transport stdout). */
  readonly agentToClient = new PassThrough();
  /** Provider stderr. */
  readonly agentStderr = new PassThrough();

  private buffer = "";
  /** Per-method handlers returning a result, an error, or void (no reply). */
  private handlers = new Map<string, (frame: JsonRpcFrame) => void>();
  /** Captured method names the client sent, in order. */
  readonly received: JsonRpcFrame[] = [];

  constructor() {
    this.clientToAgent.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let nl = this.buffer.indexOf("\n");
      while (nl !== -1) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (line.trim().length > 0) {
          const frame = JSON.parse(line) as JsonRpcFrame;
          this.received.push(frame);
          if (frame.method) {
            const handler = this.handlers.get(frame.method);
            handler?.(frame);
          }
        }
        nl = this.buffer.indexOf("\n");
      }
    });
  }

  get streams(): ProviderStdioStreams {
    return {
      stdin: this.clientToAgent,
      stdout: this.agentToClient,
      stderr: this.agentStderr,
    };
  }

  /** Register a handler for a client-initiated method. */
  on(method: string, handler: (frame: JsonRpcFrame) => void): this {
    this.handlers.set(method, handler);
    return this;
  }

  /** Reply to a client request with a success result. */
  replyResult(id: number | string | undefined, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  /** Reply to a client request with a JSON-RPC error. */
  replyError(id: number | string | undefined, code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  /** Push a server-initiated notification (no id). */
  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** Push a server-initiated request (host callback). */
  request(id: number | string, method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", id, method, params });
  }

  private write(frame: JsonRpcFrame): void {
    this.agentToClient.write(JSON.stringify(frame) + "\n");
  }
}

function createClient(
  agent: MockAgent,
  options: {
    hostServices?: HostServices;
    callbacks?: AcpClientCallbacks;
    logger?: Logger;
    timeoutMs?: number;
    allowMutatingSessionOps?: boolean;
  } = {}
): { client: AcpClient; transport: JsonRpcStdioTransport; logger: Logger } {
  const logger = options.logger ?? makeLogger();
  // The process manager wires the transport's onNotification/onRequest into the
  // client; replicate that wiring here so we exercise the real dispatch path.
  let client!: AcpClient;
  const transport = new JsonRpcStdioTransport({
    streams: agent.streams,
    logger,
    provider: "mistral",
    defaultTimeoutMs: options.timeoutMs ?? 2000,
    onNotification: n => client.handleNotification(n.method, n.params),
    onRequest: r => client.handleRequest(r.id, r.method, r.params),
  });
  client = new AcpClient({
    transport,
    provider: "mistral",
    hostServices: options.hostServices ?? {},
    callbacks: options.callbacks,
    logger,
    allowMutatingSessionOps: options.allowMutatingSessionOps,
  });
  return { client, transport, logger };
}

describe("AcpClient", () => {
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  let stdoutWrites: string[];

  beforeEach(() => {
    // Security invariant: the client must never write to gateway stdout.
    stdoutWrites = [];
    stdoutWriteSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown): boolean => {
        stdoutWrites.push(String(chunk));
        return true;
      });
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
    vi.useRealTimers();
  });

  it("performs the initialize plus session/new smoke through the client", async () => {
    const agent = new MockAgent();
    agent
      .on("initialize", f =>
        agent.replyResult(f.id, {
          protocolVersion: 1,
          agentInfo: { name: "vibe-acp", version: "2.14.1" },
        })
      )
      .on("session/new", f => agent.replyResult(f.id, { sessionId: "prov-sess-1" }));

    const { client } = createClient(agent);

    const init = await client.initialize();
    expect(init.protocolVersion).toBe(1);
    expect(init.agentInfo?.name).toBe("vibe-acp");
    expect(client.isInitialized).toBe(true);

    const session = await client.newSession({ cwd: "/tmp/work" });
    expect(session.sessionId).toBe("prov-sess-1");

    // Client advertised all-false capabilities by default (read-only posture).
    const initReq = agent.received.find(f => f.method === "initialize");
    expect(initReq?.params).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    // No gateway stdout writes occurred.
    expect(stdoutWrites).toHaveLength(0);
  });

  it("initialize is idempotent and does not re-issue the handshake", async () => {
    const agent = new MockAgent();
    let initCount = 0;
    agent.on("initialize", f => {
      initCount += 1;
      agent.replyResult(f.id, { protocolVersion: 1 });
    });
    const { client } = createClient(agent);

    const a = await client.initialize();
    const b = await client.initialize();
    expect(a).toBe(b);
    expect(initCount).toBe(1);
  });

  it("rejects session/new before initialize with a structured error", async () => {
    const agent = new MockAgent();
    const { client } = createClient(agent);
    await expect(client.newSession({ cwd: "/tmp/work" })).rejects.toBeInstanceOf(AcpProtocolError);
  });

  it("runs a prompt and surfaces session/update notifications through callbacks", async () => {
    const agent = new MockAgent();
    const updates: SessionUpdateNotification[] = [];
    agent
      .on("initialize", f => agent.replyResult(f.id, { protocolVersion: 1 }))
      .on("session/new", f => agent.replyResult(f.id, { sessionId: "s1" }))
      .on("session/prompt", f => {
        // Stream two updates, then resolve the turn.
        agent.notify("session/update", {
          sessionId: "s1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
        });
        agent.notify("session/update", {
          sessionId: "s1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: " there" },
          },
        });
        agent.replyResult(f.id, { stopReason: "end_turn" });
      });

    const { client } = createClient(agent, {
      callbacks: { onSessionUpdate: u => updates.push(u) },
    });

    await client.initialize();
    const session = await client.newSession({ cwd: "/tmp/work" });
    const result = await client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });

    expect(result.stopReason).toBe("end_turn");
    expect(updates).toHaveLength(2);
    expect(updates[0].update.sessionUpdate).toBe("agent_message_chunk");
  });

  it("sends a session/cancel notification for an in-flight turn", async () => {
    const agent = new MockAgent();
    agent
      .on("initialize", f => agent.replyResult(f.id, { protocolVersion: 1 }))
      .on("session/new", f => agent.replyResult(f.id, { sessionId: "s1" }))
      .on("session/prompt", f => {
        // Resolve the turn as cancelled after we receive the cancel.
        agent.on("session/cancel", () => {
          agent.replyResult(f.id, { stopReason: "cancelled" });
        });
      });

    const { client } = createClient(agent);
    await client.initialize();
    await client.newSession({ cwd: "/tmp/work" });

    const promptPromise = client.prompt({
      sessionId: "s1",
      prompt: [{ type: "text", text: "long task" }],
    });
    // Allow the prompt frame to flush before cancelling.
    await new Promise(r => setImmediate(r));
    client.cancel("s1");

    const result = await promptPromise;
    expect(result.stopReason).toBe("cancelled");
    const cancelFrame = agent.received.find(f => f.method === "session/cancel");
    expect(cancelFrame?.params).toMatchObject({ sessionId: "s1" });
  });

  it("turns a JSON-RPC error response into a structured, redacted gateway error", async () => {
    const agent = new MockAgent();
    agent
      .on("initialize", f => agent.replyResult(f.id, { protocolVersion: 1 }))
      .on("session/new", f =>
        // Provider error message embeds a credential path AND free-form prose.
        agent.replyError(f.id, -32000, "boom reading /home/werner/.config/secret.json")
      );

    const { client } = createClient(agent);
    await client.initialize();

    const err = await client.newSession({ cwd: "/tmp/work" }).catch(e => e);
    expect(err).toBeInstanceOf(AcpProtocolError);
    expect(err).toBeInstanceOf(AcpError);
    // Round-3 codex finding 2: the provider's untrusted error message is NOT
    // interpolated into the client-facing message at all (the pattern redactor
    // cannot scrub arbitrary prose). Only the method + code remain.
    expect(err.userMessage).not.toContain("/home/werner");
    expect(err.userMessage).not.toContain("secret.json");
    expect(err.userMessage).not.toContain("boom reading");
    expect(err.userMessage).toContain("session/new");
    expect(err.userMessage).toContain("-32000");
    expect((err as AcpProtocolError).code).toBe(-32000);
  });

  it("rejects a prompt with a timeout error when the agent never replies", async () => {
    vi.useFakeTimers();
    const agent = new MockAgent();
    agent
      .on("initialize", f => agent.replyResult(f.id, { protocolVersion: 1 }))
      .on("session/new", f => agent.replyResult(f.id, { sessionId: "s1" }))
      .on("session/prompt", () => {
        /* never reply */
      });

    const { client } = createClient(agent, { timeoutMs: 50 });
    // initialize/newSession resolve synchronously enough under fake timers
    // because the agent replies on the same microtask queue.
    const initP = client.initialize();
    await vi.advanceTimersByTimeAsync(0);
    await initP;
    const sessP = client.newSession({ cwd: "/tmp/work" });
    await vi.advanceTimersByTimeAsync(0);
    await sessP;

    const promptP = client
      .prompt({ sessionId: "s1", prompt: [{ type: "text", text: "x" }] })
      .catch(e => e);
    await vi.advanceTimersByTimeAsync(60);
    const err = await promptP;
    expect(err).toBeInstanceOf(AcpTimeoutError);
    expect((err as AcpTimeoutError).method).toBe("session/prompt");
  });
});

describe("AcpClient host callback dispatch", () => {
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation((): boolean => true);
  });
  afterEach(() => {
    stdoutWriteSpy.mockRestore();
  });

  it("dispatches fs/read_text_file into HostServices and returns its result", async () => {
    const agent = new MockAgent();
    const readTextFile = vi.fn(async () => ({ content: "file body" }));
    agent.on("initialize", f => agent.replyResult(f.id, { protocolVersion: 1 }));

    createClient(agent, { hostServices: { readTextFile } });

    // Agent issues a host callback before/after init; dispatch is independent.
    const replies: JsonRpcFrame[] = [];
    agent.agentToClient.on("data", () => {
      /* no-op: agent writes its own frames; we read client replies below */
    });
    // Capture the client's reply by listening on the agent's inbound stream.
    agent.clientToAgent.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim()) replies.push(JSON.parse(line) as JsonRpcFrame);
      }
    });

    agent.request(99, "fs/read_text_file", {
      sessionId: "s1",
      path: "/tmp/work/file.txt",
    });

    await vi.waitFor(() => {
      expect(replies.some(r => r.id === 99 && r.result)).toBe(true);
    });
    expect(readTextFile).toHaveBeenCalledOnce();
    const reply = replies.find(r => r.id === 99);
    expect(reply?.result).toMatchObject({ content: "file body" });
  });

  it("answers method-not-found when the host does not implement a surface (write disabled by default)", async () => {
    const agent = new MockAgent();
    // hostServices has no writeTextFile -> deny-by-default.
    createClient(agent, { hostServices: {} });

    const replies: JsonRpcFrame[] = [];
    agent.clientToAgent.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim()) replies.push(JSON.parse(line) as JsonRpcFrame);
      }
    });

    agent.request(7, "fs/write_text_file", {
      sessionId: "s1",
      path: "/tmp/work/out.txt",
      content: "data",
    });

    await vi.waitFor(() => {
      expect(replies.some(r => r.id === 7 && r.error)).toBe(true);
    });
    const reply = replies.find(r => r.id === 7);
    expect(reply?.error?.code).toBe(-32000);
    // Redacted, host-safe message.
    expect(reply?.error?.message).toContain("does not support");
  });

  it("routes permission denial from HostServices back as a JSON-RPC error without raw leakage", async () => {
    const agent = new MockAgent();
    const requestPermission = vi.fn(async (): Promise<RequestPermissionResponse> => {
      // The host (ApprovalManager-backed in production) denied the request.
      throw new AcpPermissionDeniedError("mistral", "policy denied write to /etc/passwd");
    });
    createClient(agent, { hostServices: { requestPermission } });

    const replies: JsonRpcFrame[] = [];
    agent.clientToAgent.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim()) replies.push(JSON.parse(line) as JsonRpcFrame);
      }
    });

    agent.request(11, "session/request_permission", {
      sessionId: "s1",
      options: [{ optionId: "allow", name: "Allow" }],
      toolCall: { kind: "write" },
    });

    await vi.waitFor(() => {
      expect(replies.some(r => r.id === 11 && r.error)).toBe(true);
    });
    const reply = replies.find(r => r.id === 11);
    expect(reply?.error?.message).not.toContain("/etc/passwd");
    expect(reply?.error?.message).toContain("<redacted-path>");
  });

  it("grants permission when HostServices approves (selected option)", async () => {
    const agent = new MockAgent();
    const requestPermission = vi.fn(async (): Promise<RequestPermissionResponse> => ({
      outcome: { outcome: "selected", optionId: "allow" },
    }));
    createClient(agent, { hostServices: { requestPermission } });

    const replies: JsonRpcFrame[] = [];
    agent.clientToAgent.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim()) replies.push(JSON.parse(line) as JsonRpcFrame);
      }
    });

    agent.request(12, "session/request_permission", {
      sessionId: "s1",
      options: [{ optionId: "allow", name: "Allow" }],
      toolCall: { kind: "read" },
    });

    await vi.waitFor(() => {
      expect(replies.some(r => r.id === 12 && r.result)).toBe(true);
    });
    const reply = replies.find(r => r.id === 12);
    expect(reply?.result).toMatchObject({
      outcome: { outcome: "selected", optionId: "allow" },
    });
  });
});

// Phase-5 Deliverable A + C: capability-gated session lifecycle methods. Method
// availability is DERIVED from the injected initialize capability set, so the
// SAME source flips between usable and a precise capability error purely by
// changing the fake initialize response (acceptance #6b). State-mutating admin
// ops additionally require the operator config gate (deny-by-default).
describe("AcpClient capability-gated methods", () => {
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation((): boolean => true);
  });
  afterEach(() => stdoutWriteSpy.mockRestore());

  function initWith(caps: Record<string, unknown>): MockAgent {
    const agent = new MockAgent();
    agent.on("initialize", f =>
      agent.replyResult(f.id, { protocolVersion: 1, agentCapabilities: caps })
    );
    return agent;
  }

  it("allows session/list when advertised and returns the parsed result", async () => {
    const agent = initWith({ sessionCapabilities: { list: {} } }).on("session/list", f =>
      agent.replyResult(f.id, {
        // SessionInfo entries carry the spec-required sessionId + cwd.
        sessions: [
          { sessionId: "a", cwd: "/tmp/a" },
          { sessionId: "b", cwd: "/tmp/b" },
        ],
      })
    );
    const { client } = createClient(agent);
    await client.initialize();
    expect(client.supportsMethod("session/list")).toBe(true);
    const result = await client.listSessions();
    expect(result.sessions).toHaveLength(2);
  });

  // Mutation that flips this red: making assertMethodAvailable a no-op (so an
  // unadvertised method is sent to the agent instead of failing closed).
  it("fails a non-advertised method with a precise capability error (not a process failure)", async () => {
    const agent = initWith({}); // no session capabilities advertised
    const { client } = createClient(agent);
    await client.initialize();
    expect(client.supportsMethod("session/list")).toBe(false);
    const err = await client.listSessions().catch(e => e);
    expect(err).toBeInstanceOf(AcpMethodUnsupportedError);
    expect((err as AcpMethodUnsupportedError).kind).toBe("method_unsupported");
    expect((err as AcpMethodUnsupportedError).method).toBe("session/list");
    // The agent never received the unadvertised call.
    expect(agent.received.some(f => f.method === "session/list")).toBe(false);
  });

  it("resume is gated on the resume capability (distinct from load)", async () => {
    const agent = initWith({ loadSession: true }).on("session/resume", f =>
      agent.replyResult(f.id, {})
    );
    const { client } = createClient(agent);
    await client.initialize();
    // loadSession advertised, but resume is NOT.
    expect(client.supportsMethod("session/load")).toBe(true);
    const err = await client.resumeSession({ sessionId: "s1", cwd: "/tmp/w" }).catch(e => e);
    expect(err).toBeInstanceOf(AcpMethodUnsupportedError);
    expect((err as AcpMethodUnsupportedError).method).toBe("session/resume");
  });

  it("gates session/delete behind the mutating config gate even when advertised", async () => {
    const agent = initWith({ sessionCapabilities: { delete: {} } }).on("session/delete", f =>
      agent.replyResult(f.id, {})
    );
    // Config gate OFF (default): advertised, yet refused.
    const { client } = createClient(agent);
    await client.initialize();
    expect(client.supportsMethod("session/delete")).toBe(true);
    const err = await client.deleteSession("s1").catch(e => e);
    expect(err).toBeInstanceOf(AcpMutatingDisabledError);
    expect((err as AcpMutatingDisabledError).method).toBe("session/delete");
    expect(agent.received.some(f => f.method === "session/delete")).toBe(false);
  });

  it("permits session/delete when advertised AND the mutating gate is on", async () => {
    const agent = initWith({ sessionCapabilities: { delete: {} } }).on("session/delete", f =>
      agent.replyResult(f.id, {})
    );
    const { client } = createClient(agent, { allowMutatingSessionOps: true });
    await client.initialize();
    await expect(client.deleteSession("s1")).resolves.toBeTruthy();
    expect(agent.received.some(f => f.method === "session/delete")).toBe(true);
  });

  // Nit: session/set_mode is a MUTATING_METHOD and must fail closed (gate off)
  // exactly like session/delete, sending NO frame. Mutation that flips this red:
  // removing "session/set_mode" from AcpClient.MUTATING_METHODS (the call would
  // then be sent to the agent with the gate off).
  it("gates session/set_mode behind the mutating config gate even when advertised", async () => {
    const agent = initWith({})
      .on("session/new", f =>
        agent.replyResult(f.id, { sessionId: "s1", modes: { currentModeId: "code" } })
      )
      .on("session/set_mode", f => agent.replyResult(f.id, {}));
    // Config gate OFF (default): advertised via session modes, yet refused.
    const { client } = createClient(agent);
    await client.initialize();
    await client.newSession({ cwd: "/tmp/w" });
    expect(client.supportsMethod("session/set_mode")).toBe(true);
    const err = await client.setSessionMode({ sessionId: "s1", modeId: "plan" }).catch(e => e);
    expect(err).toBeInstanceOf(AcpMutatingDisabledError);
    expect((err as AcpMutatingDisabledError).method).toBe("session/set_mode");
    expect(agent.received.some(f => f.method === "session/set_mode")).toBe(false);
  });

  // Nit: session/set_config_option is a MUTATING_METHOD and must fail closed
  // (gate off), sending NO frame. Mutation that flips this red: removing
  // "session/set_config_option" from AcpClient.MUTATING_METHODS.
  it("gates session/set_config_option behind the mutating config gate even when advertised", async () => {
    const agent = initWith({})
      .on("session/new", f =>
        agent.replyResult(f.id, {
          sessionId: "s1",
          configOptions: [{ id: "theme", name: "Theme" }],
        })
      )
      .on("session/set_config_option", f => agent.replyResult(f.id, { configOptions: [] }));
    // Config gate OFF (default): advertised via session configOptions, yet refused.
    const { client } = createClient(agent);
    await client.initialize();
    await client.newSession({ cwd: "/tmp/w" });
    expect(client.supportsMethod("session/set_config_option")).toBe(true);
    const err = await client
      .setSessionConfigOption({ sessionId: "s1", configId: "theme", value: "dark" })
      .catch(e => e);
    expect(err).toBeInstanceOf(AcpMutatingDisabledError);
    expect((err as AcpMutatingDisabledError).method).toBe("session/set_config_option");
    expect(agent.received.some(f => f.method === "session/set_config_option")).toBe(false);
  });

  it("adds set_mode availability from the session/new modes state, gated by config", async () => {
    const agent = initWith({})
      .on("session/new", f =>
        agent.replyResult(f.id, { sessionId: "s1", modes: { currentModeId: "code" } })
      )
      .on("session/set_mode", f => agent.replyResult(f.id, {}));
    const { client } = createClient(agent, { allowMutatingSessionOps: true });
    await client.initialize();
    // Before a session exists, set_mode is not yet advertised.
    expect(client.supportsMethod("session/set_mode")).toBe(false);
    await client.newSession({ cwd: "/tmp/w" });
    expect(client.supportsMethod("session/set_mode")).toBe(true);
    await expect(client.setSessionMode({ sessionId: "s1", modeId: "plan" })).resolves.toBeTruthy();
  });
});
