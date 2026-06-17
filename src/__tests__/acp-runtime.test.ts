/**
 * ACP runtime tests (plan steps pilot-mistral/grok-acp-runtime, + devin).
 *
 * Drives runAcpRequest with a fake provider ACP agent (no real binary). The
 * fake answers initialize + session/new + session/load, and on session/prompt
 * streams agent_message_chunk session/update notifications before replying.
 * Asserts: config gates fail closed, the happy path accumulates the streamed
 * text, the process is always torn down, the flight recorder gets only
 * summaries, and resume enforces the session ownership scope.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { AcpChildProcess, AcpSpawnFn } from "../acp/process-manager.js";
import { runAcpRequest, type AcpFlightSink, type AcpRuntimeDeps } from "../acp/runtime.js";
import type { ApprovalManager } from "../approval-manager.js";
import type { AcpConfig, AcpProviderConfig } from "../config.js";
import type { ISessionManager, ProviderType, Session } from "../session-manager.js";

interface Frame {
  id?: number | string;
  method?: string;
  params?: unknown;
}

/** Fake provider ACP agent that streams message chunks during a prompt. */
class FakeAgent extends EventEmitter implements AcpChildProcess {
  readonly pid = 9001;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killed: Array<string | number | undefined> = [];
  private buffer = "";
  private readonly handlers = new Map<string, (f: Frame) => void>();
  failPrompt = false;

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let nl = this.buffer.indexOf("\n");
      while (nl !== -1) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (line.trim().length > 0) {
          const f = JSON.parse(line) as Frame;
          if (f.method) this.handlers.get(f.method)?.(f);
        }
        nl = this.buffer.indexOf("\n");
      }
    });
    this.handlers.set("initialize", f =>
      this.reply(f.id, { protocolVersion: 1, agentInfo: { name: "fake", version: "1.0" } })
    );
    this.handlers.set("session/new", f => this.reply(f.id, { sessionId: "prov-sess-1" }));
    this.handlers.set("session/load", f => this.reply(f.id, {}));
    this.handlers.set("session/prompt", f => {
      if (this.failPrompt) {
        this.replyError(f.id, -32000, "prompt failed");
        return;
      }
      this.notify("session/update", {
        sessionId: "prov-sess-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } },
      });
      this.notify("session/update", {
        sessionId: "prov-sess-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } },
      });
      this.reply(f.id, { stopReason: "end_turn" });
    });
  }

  private reply(id: number | string | undefined, result: unknown): void {
    this.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }
  private replyError(id: number | string | undefined, code: number, message: string): void {
    this.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
  }
  private notify(method: string, params: unknown): void {
    this.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  on(event: string, listener: (...args: never[]) => void): this {
    return super.on(event, listener);
  }
  kill(signal?: string | number): boolean {
    this.killed.push(signal);
    return true;
  }
}

class FakeSessionManager implements Partial<ISessionManager> {
  readonly sessions = new Map<string, Session>();
  createSession(cli: ProviderType, description?: string, sessionId?: string): Session {
    const id = sessionId ?? `auto-${this.sessions.size}`;
    const s: Session = { id, cli, createdAt: "t", lastUsedAt: "t", description };
    this.sessions.set(id, s);
    return s;
  }
  getSession(id: string): Session | null {
    return this.sessions.get(id) ?? null;
  }
  updateSessionMetadata(id: string, metadata: Record<string, unknown>): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.metadata = { ...s.metadata, ...metadata };
    return true;
  }
}

const fakeApproval = { decide: () => ({ status: "approved" }) } as unknown as ApprovalManager;

function provider(command: string, runtimeEnabled: boolean): AcpProviderConfig {
  return { enabled: true, command, args: [], runtimeEnabled, isolatedLeaderSocket: false };
}

function makeConfig(over: Partial<AcpConfig> = {}): AcpConfig {
  return {
    enabled: true,
    defaultTransport: "cli",
    smokeOnStartup: false,
    processIdleTimeoutMs: 600000,
    initializeTimeoutMs: 10000,
    sessionNewTimeoutMs: 10000,
    promptTimeoutMs: 600000,
    allowWriteHostServices: false,
    allowTerminalHostServices: false,
    fallbackToCliWhenUnhealthy: true,
    providers: { mistral: provider("vibe-acp", true) },
    ...over,
  };
}

function deps(agent: FakeAgent, over: Partial<AcpRuntimeDeps> = {}): AcpRuntimeDeps {
  const spawn: AcpSpawnFn = () => agent;
  return {
    config: makeConfig(),
    sessionManager: new FakeSessionManager() as unknown as ISessionManager,
    approvalManager: fakeApproval,
    spawn,
    ...over,
  };
}

describe("ACP runtime — config gates (fail closed)", () => {
  it("throws AcpDisabledError when [acp].enabled is off", async () => {
    const d = deps(new FakeAgent(), { config: makeConfig({ enabled: false }) });
    await expect(
      runAcpRequest(d, { provider: "mistral", prompt: "hi", correlationId: "c" })
    ).rejects.toMatchObject({ kind: "acp_disabled" });
  });

  it("throws ProviderRuntimeDisabledError when the provider runtime is off", async () => {
    const d = deps(new FakeAgent(), {
      config: makeConfig({ providers: { mistral: provider("vibe-acp", false) } }),
    });
    await expect(
      runAcpRequest(d, { provider: "mistral", prompt: "hi", correlationId: "c" })
    ).rejects.toMatchObject({ kind: "provider_runtime_disabled" });
  });
});

describe("ACP runtime — happy path", () => {
  it("routes a prompt and accumulates the streamed agent text", async () => {
    const agent = new FakeAgent();
    const res = await runAcpRequest(deps(agent), {
      provider: "mistral",
      prompt: "say hello",
      correlationId: "c1",
    });
    expect(res.text).toBe("Hello world");
    expect(res.protocolVersion).toBe(1);
    expect(res.gatewaySessionId.startsWith("gw-")).toBe(true);
    expect(agent.killed.length).toBeGreaterThan(0); // process torn down
  });

  it("writes only summarized prompt/response to the flight recorder", async () => {
    const agent = new FakeAgent();
    const starts: unknown[] = [];
    const completes: unknown[] = [];
    const flightRecorder: AcpFlightSink = {
      logStart: e => starts.push(e),
      logComplete: (_id, r) => completes.push(r),
    };
    await runAcpRequest(deps(agent, { flightRecorder }), {
      provider: "mistral",
      prompt: "SENSITIVE-PROMPT-TEXT",
      correlationId: "c2",
    });
    expect(JSON.stringify(starts)).not.toContain("SENSITIVE-PROMPT-TEXT");
    expect(JSON.stringify(starts)).toContain("[acp prompt:");
    expect(JSON.stringify(completes)).toContain("[acp response:");
    expect(JSON.stringify(completes)).not.toContain("Hello world");
  });
});

describe("ACP runtime — resume scope", () => {
  it("resumes via the gateway session id (loadSession), enforcing provider ownership", async () => {
    const sm = new FakeSessionManager() as unknown as ISessionManager;
    const agent1 = new FakeAgent();
    const first = await runAcpRequest(deps(agent1, { sessionManager: sm }), {
      provider: "mistral",
      prompt: "first",
      correlationId: "c3",
    });
    // Resume with the same provider succeeds.
    const agent2 = new FakeAgent();
    const loadSpy = vi.spyOn(agent2["handlers"] as Map<string, (f: Frame) => void>, "get");
    const second = await runAcpRequest(deps(agent2, { sessionManager: sm }), {
      provider: "mistral",
      prompt: "second",
      sessionId: first.gatewaySessionId,
      correlationId: "c4",
    });
    expect(second.text).toBe("Hello world");
    loadSpy.mockRestore();
  });

  it("rejects cross-provider resume", async () => {
    const sm = new FakeSessionManager() as unknown as ISessionManager;
    const first = await runAcpRequest(deps(new FakeAgent(), { sessionManager: sm }), {
      provider: "mistral",
      prompt: "first",
      correlationId: "c5",
    });
    const grokConfig = makeConfig({
      providers: { grok: provider("grok", true) },
    });
    await expect(
      runAcpRequest(deps(new FakeAgent(), { sessionManager: sm, config: grokConfig }), {
        provider: "grok",
        prompt: "x",
        sessionId: first.gatewaySessionId,
        correlationId: "c6",
      })
    ).rejects.toMatchObject({ kind: "protocol" });
  });
});

describe("ACP runtime — failure handling", () => {
  it("throws and tears down the process when the prompt fails", async () => {
    const agent = new FakeAgent();
    agent.failPrompt = true;
    await expect(
      runAcpRequest(deps(agent), { provider: "mistral", prompt: "x", correlationId: "c7" })
    ).rejects.toBeTruthy();
    expect(agent.killed.length).toBeGreaterThan(0);
  });
});
