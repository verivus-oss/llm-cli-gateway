/**
 * ACP read-only smoke-harness tests (plan step add-read-only-smoke-harness).
 *
 * Drives the harness with a fake provider ACP process (no real binary): the
 * fake auto-replies to `initialize` and `session/new`. Asserts the redacted
 * result shape, that the process is always torn down, that failures are
 * captured (never thrown), and that the result leaks no session id / temp path.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import type { AcpChildProcess, AcpSpawnFn, ResolvedAcpSpawn } from "../acp/process-manager.js";
import { eligibleSmokeProviders, runAcpSmoke, runAcpSmokes } from "../acp/smoke-harness.js";
import type { AcpConfig, AcpProviderConfig } from "../config.js";

interface JsonRpcFrame {
  id?: number | string;
  method?: string;
  params?: unknown;
}

/** Fake provider ACP process; replies to initialize + session/new on demand. */
class FakeAgent extends EventEmitter implements AcpChildProcess {
  readonly pid = 7777;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killed: Array<string | number | undefined> = [];

  private buffer = "";
  private readonly handlers = new Map<string, (f: JsonRpcFrame) => void>();

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let nl = this.buffer.indexOf("\n");
      while (nl !== -1) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (line.trim().length > 0) {
          const frame = JSON.parse(line) as JsonRpcFrame;
          if (frame.method) this.handlers.get(frame.method)?.(frame);
        }
        nl = this.buffer.indexOf("\n");
      }
    });
  }

  on(event: string, listener: (...args: never[]) => void): this {
    return super.on(event, listener);
  }

  onMethod(method: string, handler: (f: JsonRpcFrame) => void): this {
    this.handlers.set(method, handler);
    return this;
  }

  private reply(id: number | string | undefined, result: unknown): void {
    this.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  private replyError(id: number | string | undefined, code: number, message: string): void {
    this.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
  }

  autoInitialize(name = "vibe-acp", version = "2.14.1"): this {
    return this.onMethod("initialize", f =>
      this.reply(f.id, { protocolVersion: 1, agentInfo: { name, version } })
    );
  }

  autoSessionNew(sessionId: string): this {
    return this.onMethod("session/new", f =>
      this.reply(f.id, { sessionId, modes: { currentModeId: "accept-edits" } })
    );
  }

  failSessionNew(message = "session refused"): this {
    return this.onMethod("session/new", f => this.replyError(f.id, -32000, message));
  }

  kill(signal?: string | number): boolean {
    this.killed.push(signal);
    return true;
  }
}

function spawnReturning(child: AcpChildProcess): {
  spawn: AcpSpawnFn;
  resolved: ResolvedAcpSpawn[];
} {
  const resolved: ResolvedAcpSpawn[] = [];
  return { spawn: r => (resolved.push(r), child), resolved };
}

function makeConfig(overrides: Partial<AcpConfig> = {}): AcpConfig {
  const provider = (command: string): AcpProviderConfig => ({
    enabled: true,
    command,
    args: [],
    runtimeEnabled: false,
    isolatedLeaderSocket: false,
  });
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
    providers: { mistral: provider("vibe-acp"), grok: provider("grok") },
    ...overrides,
  };
}

describe("ACP smoke harness — runAcpSmoke", () => {
  it("returns a passing redacted result for a healthy provider (initialize + session/new)", async () => {
    const agent = new FakeAgent().autoInitialize("vibe-acp", "2.14.1").autoSessionNew("sess-1");
    const { spawn } = spawnReturning(agent);

    const result = await runAcpSmoke("mistral", { config: makeConfig(), spawn });

    expect(result.ok).toBe(true);
    expect(result.provider).toBe("mistral");
    expect(result.protocolVersion).toBe(1);
    expect(result.agentName).toBe("vibe-acp");
    expect(result.agentVersion).toBe("2.14.1");
    expect(result.sessionCreated).toBe(true);
    expect(result.error).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("terminates the provider process after a successful smoke", async () => {
    const agent = new FakeAgent().autoInitialize().autoSessionNew("sess-1");
    const { spawn } = spawnReturning(agent);
    await runAcpSmoke("mistral", { config: makeConfig(), spawn });
    expect(agent.killed.length).toBeGreaterThan(0);
  });

  it("never records the provider ACP session id or the cwd/temp path (redaction)", async () => {
    const agent = new FakeAgent().autoInitialize().autoSessionNew("SECRET-SESSION-9f");
    const { spawn } = spawnReturning(agent);
    const result = await runAcpSmoke("mistral", {
      config: makeConfig(),
      spawn,
      cwd: "/tmp/SECRET-CWD-path",
    });
    const serialized = JSON.stringify(result);
    expect(result.ok).toBe(true);
    expect(serialized).not.toContain("SECRET-SESSION-9f");
    expect(serialized).not.toContain("SECRET-CWD-path");
  });

  it("captures session/new failure as ok:false with a redacted error (never throws)", async () => {
    const agent = new FakeAgent().autoInitialize().failSessionNew("denied");
    const { spawn } = spawnReturning(agent);
    const result = await runAcpSmoke("mistral", { config: makeConfig(), spawn });
    expect(result.ok).toBe(false);
    expect(result.error).not.toBeNull();
    expect(result.error?.kind).toBeTruthy();
    expect(agent.killed.length).toBeGreaterThan(0); // still torn down
  });

  it("fails closed for a provider with no native ACP entrypoint, without spawning", async () => {
    let spawned = false;
    const spawn: AcpSpawnFn = r => {
      spawned = true;
      return new FakeAgent();
    };
    const result = await runAcpSmoke("codex", { config: makeConfig(), spawn });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("provider_unavailable");
    expect(spawned).toBe(false);
  });

  it("refuses to smoke a non-native provider even when it IS configured with a command (guard, not just missing entrypoint)", async () => {
    let spawned = false;
    const spawn: AcpSpawnFn = () => {
      spawned = true;
      return new FakeAgent().autoInitialize().autoSessionNew("s");
    };
    // codex is configured with a runnable command, but is not a native-ACP
    // provider; the harness guard must reject it BEFORE resolving the spawn.
    const config = makeConfig();
    config.providers.codex = {
      enabled: true,
      command: "codex",
      args: ["acp"],
      runtimeEnabled: false,
      isolatedLeaderSocket: false,
    };
    const result = await runAcpSmoke("codex", { config, spawn });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("provider_unavailable");
    expect(spawned).toBe(false);
  });

  it("captures a spawn failure as ok:false (never throws)", async () => {
    const spawn: AcpSpawnFn = () => {
      throw new Error("spawn boom");
    };
    const result = await runAcpSmoke("mistral", { config: makeConfig(), spawn });
    expect(result.ok).toBe(false);
    expect(result.error).not.toBeNull();
  });

  it("uses an injected clock for deterministic durations", async () => {
    const agent = new FakeAgent().autoInitialize().autoSessionNew("sess-1");
    const { spawn } = spawnReturning(agent);
    let t = 1000;
    const now = (): number => {
      const v = t;
      t += 250;
      return v;
    };
    const result = await runAcpSmoke("mistral", { config: makeConfig(), spawn, now });
    expect(result.durationMs).toBeGreaterThan(0);
  });
});

describe("ACP smoke harness — runAcpSmokes", () => {
  it("runs each provider in order and returns one result per provider", async () => {
    const agent = new FakeAgent().autoInitialize().autoSessionNew("sess-x");
    const { spawn } = spawnReturning(agent);
    const results = await runAcpSmokes(["mistral", "codex"], { config: makeConfig(), spawn });
    expect(results.map(r => r.provider)).toEqual(["mistral", "codex"]);
    expect(results[0].ok).toBe(true); // mistral native + healthy
    expect(results[1].ok).toBe(false); // codex has no native entrypoint
  });
});

describe("ACP smoke harness — eligibleSmokeProviders", () => {
  it("is empty when ACP is globally disabled", () => {
    expect(eligibleSmokeProviders(makeConfig({ enabled: false }))).toEqual([]);
  });

  it("includes only native-ACP providers that are per-provider enabled", () => {
    const config = makeConfig();
    const eligible = eligibleSmokeProviders(config);
    expect(eligible).toContain("mistral");
    expect(eligible).toContain("grok");
  });

  it("excludes a provider that is present but per-provider disabled", () => {
    const config = makeConfig();
    config.providers.mistral = { ...config.providers.mistral, enabled: false };
    expect(eligibleSmokeProviders(config)).not.toContain("mistral");
  });

  it("excludes a non-native provider even if configured + enabled", () => {
    const config = makeConfig();
    config.providers.codex = {
      enabled: true,
      command: "codex",
      args: ["acp"],
      runtimeEnabled: false,
      isolatedLeaderSocket: false,
    };
    expect(eligibleSmokeProviders(config)).not.toContain("codex");
  });
});
