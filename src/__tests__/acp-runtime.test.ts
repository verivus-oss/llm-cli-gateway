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
import {
  runAcpRequest,
  extractAcpPromptUsage,
  type AcpFlightSink,
  type AcpRuntimeDeps,
} from "../acp/runtime.js";
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
  /** Optional `_meta` block echoed on the session/prompt response (B4 usage). */
  promptMeta: Record<string, unknown> | undefined = undefined;

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
      this.reply(f.id, {
        stopReason: "end_turn",
        ...(this.promptMeta ? { _meta: this.promptMeta } : {}),
      });
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

  // BLOCKER 4 (safety): a provider with enabled=false must NEVER spawn, even when
  // runtime_enabled=true. The runtime requires BOTH gates. Mutation that flips
  // this red: dropping the `providerConfig.enabled` check in runtime.ts (the
  // disabled provider would then spawn and this test's no-spawn assertion fails).
  it("throws ProviderAcpDisabledError and never spawns when enabled=false (runtime_enabled=true)", async () => {
    let spawned = false;
    const spawn: AcpSpawnFn = () => {
      spawned = true;
      return new FakeAgent();
    };
    const d = deps(new FakeAgent(), {
      spawn,
      config: makeConfig({
        providers: {
          mistral: {
            enabled: false,
            command: "vibe-acp",
            args: [],
            runtimeEnabled: true,
            isolatedLeaderSocket: false,
          },
        },
      }),
    });
    await expect(
      runAcpRequest(d, { provider: "mistral", prompt: "hi", correlationId: "c" })
    ).rejects.toMatchObject({ kind: "provider_acp_disabled" });
    expect(spawned).toBe(false);
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
    // Phase 7: the session/prompt stopReason + provider session id are threaded
    // into the flight-recorder result. Mutation that flips this red: not calling
    // normalizer.completeWith(promptResult.stopReason) or not passing
    // providerSessionId/stopReason to buildAcpFlightResult.
    const complete = completes[0] as { stopReason?: string; providerSessionId?: string };
    expect(complete.stopReason).toBe("end_turn");
    expect(typeof complete.providerSessionId).toBe("string");
    expect(complete.providerSessionId!.length).toBeGreaterThan(0);
  });

  // B4 (acceptance #1): per-request token usage from the ACP session/prompt
  // response `_meta` is threaded into the flight-recorder result. Field names are
  // grok's live-verified `agent stdio` shape (inputTokens / outputTokens /
  // cachedReadTokens; see docs/personal-mcp/PROVIDER_CACHE_SURFACES.md). Mutation
  // that flips this red: not calling extractAcpPromptUsage(promptResult._meta) or
  // not passing inputTokens/outputTokens/cacheReadTokens to buildAcpFlightResult.
  it("threads per-request token usage from prompt `_meta` into the flight result", async () => {
    const agent = new FakeAgent();
    agent.promptMeta = {
      sessionId: "prov-sess-1",
      inputTokens: 11954,
      outputTokens: 36,
      cachedReadTokens: 7639,
      reasoningTokens: 0,
      totalTokens: 11990,
    };
    const completes: unknown[] = [];
    const flightRecorder: AcpFlightSink = {
      logStart: () => {},
      logComplete: (_id, r) => completes.push(r),
    };
    await runAcpRequest(deps(agent, { flightRecorder }), {
      provider: "mistral",
      prompt: "hi",
      correlationId: "c-usage",
    });
    const complete = completes[0] as {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
    };
    expect(complete.inputTokens).toBe(11954);
    expect(complete.outputTokens).toBe(36);
    expect(complete.cacheReadTokens).toBe(7639);
    // totalTokens is the per-turn input+output SUM (never a per-request input
    // count), so it must NOT be surfaced as usage. Assert it did not leak in as
    // inputTokens.
    expect(complete.inputTokens).not.toBe(11990);
  });

  // Capability fact: a provider whose ACP `_meta` omits usage yields NO
  // fabricated counts; the flight columns stay undefined (NULL).
  it("leaves usage undefined when prompt `_meta` carries no token fields", async () => {
    const agent = new FakeAgent(); // no promptMeta, reply has no _meta
    const completes: unknown[] = [];
    const flightRecorder: AcpFlightSink = {
      logStart: () => {},
      logComplete: (_id, r) => completes.push(r),
    };
    await runAcpRequest(deps(agent, { flightRecorder }), {
      provider: "mistral",
      prompt: "hi",
      correlationId: "c-no-usage",
    });
    const complete = completes[0] as {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
    };
    expect(complete.inputTokens).toBeUndefined();
    expect(complete.outputTokens).toBeUndefined();
    expect(complete.cacheReadTokens).toBeUndefined();
  });
});

describe("extractAcpPromptUsage (B4)", () => {
  it("lifts inputTokens/outputTokens/cachedReadTokens from the grok `_meta` shape", () => {
    const usage = extractAcpPromptUsage({
      inputTokens: 11954,
      outputTokens: 36,
      cachedReadTokens: 7639,
      totalTokens: 11990,
    });
    expect(usage).toEqual({ inputTokens: 11954, outputTokens: 36, cacheReadTokens: 7639 });
  });

  it("returns {} for absent, non-object, or non-numeric fields (no fabrication)", () => {
    expect(extractAcpPromptUsage(undefined)).toEqual({});
    expect(extractAcpPromptUsage(null)).toEqual({});
    expect(extractAcpPromptUsage("nope")).toEqual({});
    expect(extractAcpPromptUsage({ inputTokens: "12" })).toEqual({});
    expect(extractAcpPromptUsage({ totalTokens: 11990 })).toEqual({});
  });

  // LCR phase_2b: reasoningTokens is a first-class defensively-lifted field, so a
  // grok `_meta` that reports thinking tokens carries them through to cost
  // derivation. Mutation that flips this red: not lifting record.reasoningTokens.
  it("lifts reasoningTokens from a `_meta` that reports it", () => {
    const usage = extractAcpPromptUsage({
      inputTokens: 1000,
      outputTokens: 200,
      cachedReadTokens: 50,
      reasoningTokens: 400,
    });
    expect(usage).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 50,
      reasoningTokens: 400,
    });
  });

  it("omits reasoningTokens when non-finite or absent (no fabrication)", () => {
    expect(extractAcpPromptUsage({ inputTokens: 10, reasoningTokens: "400" })).toEqual({
      inputTokens: 10,
    });
    expect(extractAcpPromptUsage({ inputTokens: 10 }).reasoningTokens).toBeUndefined();
  });
});

describe("ACP runtime: LCR phase_2b derived cost", () => {
  // The ACP path derives a per-request cost from the reported token counts (only
  // the ACP transport reports usage; the grok `-p` sync path stays estimate-only).
  // reasoningTokens is folded into costUsd at the OUTPUT rate by composeCost, so a
  // turn that reports thinking tokens costs strictly more than the same counts
  // with reasoningTokens=0. Mutation that flips this red: not computing costUsd,
  // or dropping usage.reasoningTokens from the composeCost counts.
  function grokConfig(): AcpConfig {
    return makeConfig({ providers: { grok: provider("grok-acp", true) } });
  }

  async function costFor(reasoningTokens: number): Promise<{
    costUsd?: number;
    costBasis?: string;
  }> {
    const agent = new FakeAgent();
    agent.promptMeta = {
      sessionId: "prov-sess-1",
      inputTokens: 1000,
      outputTokens: 200,
      cachedReadTokens: 0,
      reasoningTokens,
    };
    const completes: unknown[] = [];
    const flightRecorder: AcpFlightSink = {
      logStart: () => {},
      logComplete: (_id, r) => completes.push(r),
    };
    await runAcpRequest(deps(agent, { flightRecorder, config: grokConfig() }), {
      provider: "grok",
      model: "grok-4",
      prompt: "hi",
      correlationId: `c-cost-${reasoningTokens}`,
    });
    return completes[0] as { costUsd?: number; costBasis?: string };
  }

  it("derives costUsd from ACP token counts (derived-from-tokens basis)", async () => {
    const c = await costFor(0);
    expect(typeof c.costUsd).toBe("number");
    expect(c.costUsd!).toBeGreaterThan(0);
    expect(c.costBasis).toBe("derived-from-tokens");
  });

  it("folds reasoningTokens into costUsd at the output rate (strictly higher)", async () => {
    const withReasoning = await costFor(400);
    const withoutReasoning = await costFor(0);
    expect(withReasoning.costUsd!).toBeGreaterThan(withoutReasoning.costUsd!);
  });

  it("does NOT flip the ACP default transport (config stays cli)", () => {
    expect(makeConfig().defaultTransport).toBe("cli");
    expect(grokConfig().defaultTransport).toBe("cli");
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

// Phase-5 Deliverable D: Devin --agent-type is threaded into the ACP spawn argv
// as fixed argv (no shell interpolation). Golden/lifecycle: the request runs and
// the resolved spawn carries the validated agent type; an unknown value is
// dropped (never injected).
describe("ACP runtime: devin --agent-type", () => {
  function devinDeps(recorded: import("../acp/process-manager.js").ResolvedAcpSpawn[]) {
    const agent = new FakeAgent();
    const spawn: AcpSpawnFn = r => {
      recorded.push(r);
      return agent;
    };
    const config = makeConfig({
      providers: {
        devin: {
          enabled: true,
          command: "devin",
          args: ["acp"],
          runtimeEnabled: true,
          isolatedLeaderSocket: false,
        },
      },
    });
    return { agent, spawn, config };
  }

  it("appends --agent-type <type> to the devin acp spawn argv", async () => {
    const recorded: import("../acp/process-manager.js").ResolvedAcpSpawn[] = [];
    const { spawn, config } = devinDeps(recorded);
    const res = await runAcpRequest(deps(new FakeAgent(), { spawn, config }), {
      provider: "devin",
      prompt: "review this",
      agentType: "review",
      correlationId: "dv1",
    });
    expect(res.text).toBe("Hello world");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].command).toBe("devin");
    expect(recorded[0].args).toEqual(["acp", "--agent-type", "review"]);
  });

  it("drops an unknown agent-type value (never injects arbitrary argv)", async () => {
    const recorded: import("../acp/process-manager.js").ResolvedAcpSpawn[] = [];
    const { spawn, config } = devinDeps(recorded);
    await runAcpRequest(deps(new FakeAgent(), { spawn, config }), {
      provider: "devin",
      prompt: "x",
      agentType: "rm -rf",
      correlationId: "dv2",
    });
    expect(recorded[0].args).toEqual(["acp"]);
  });
});
