import { describe, it, expect } from "vitest";
import { createGatewayServer } from "../index.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import type { PersistenceConfig, CacheAwarenessConfig } from "../config.js";
import type { FlightLogStart, FlightLogResult, FlightRecorderLike } from "../flight-recorder.js";
import { createSessionManager, type ISessionManager } from "../session-manager.js";

function mkPersistence(): PersistenceConfig {
  return {
    backend: "memory",
    path: null,
    dsn: null,
    retentionDays: 30,
    dedupWindowMs: 3600000,
    acknowledgeEphemeral: true,
    asyncJobsEnabled: true,
    sources: { configFile: null, envOverrides: [] },
  };
}

function mkCacheAwareness(overrides: Partial<CacheAwarenessConfig> = {}): CacheAwarenessConfig {
  return {
    emitAnthropicCacheControl: false,
    anthropicTtlSeconds: 300,
    warnOnTtlExpiry: true, // ON by default in these tests
    minStableTokensForCacheControl: { sonnet: 1024, opus: 4096, haiku: 4096, default: 4096 },
    sources: { configFile: null },
    ...overrides,
  };
}

class SeededFlightRecorder implements FlightRecorderLike {
  private rows: Array<{
    id: string;
    cli: string;
    model: string;
    session_id: string | null;
    stable_prefix_hash: string | null;
    cache_read_tokens: number | null;
    cache_creation_tokens: number | null;
    datetime_utc: string;
    cache_control_blocks?: number | null;
  }> = [];

  /** Seed a synthetic completed request for a given sessionId at a specific time. */
  seedHit(opts: {
    sessionId: string;
    minutesAgo: number;
    cli?: string;
    model?: string;
    cacheControlBlocks?: number;
  }): void {
    const cli = opts.cli ?? "claude";
    const datetime = new Date(Date.now() - opts.minutesAgo * 60_000).toISOString();
    this.rows.push({
      id: `seed-${this.rows.length}`,
      cli,
      model: opts.model ?? "claude-sonnet-4-5",
      session_id: opts.sessionId,
      stable_prefix_hash: "shared-hash",
      cache_read_tokens: 100,
      cache_creation_tokens: 0,
      datetime_utc: datetime,
      cache_control_blocks: opts.cacheControlBlocks ?? null,
    });
  }

  logStart(_entry: FlightLogStart): void {
    // Ignored in TTL tests — we only care about pre-seeded rows.
  }
  logComplete(_correlationId: string, _result: FlightLogResult): void {}
  queryRequests<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    if (sql.includes("session_id = ?")) {
      const sid = params[0];
      return this.rows
        .filter(r => r.session_id === sid)
        .map(r => ({
          cli: r.cli,
          model: r.model,
          cache_read_tokens: r.cache_read_tokens ?? 0,
          cache_creation_tokens: r.cache_creation_tokens ?? 0,
          stable_prefix_hash: r.stable_prefix_hash,
          datetime_utc: r.datetime_utc,
          cache_control_blocks: r.cache_control_blocks ?? null,
        })) as unknown as T[];
    }
    return [] as T[];
  }
  flush(): void {}
  close(): void {}
}

interface RegisteredTool {
  handler: (
    args: Record<string, unknown>,
    extra?: Record<string, unknown>
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    warnings?: Array<{ code: string; ttlRemainingMs?: number }>;
    structuredContent?: Record<string, unknown>;
  }>;
}

async function setup(opts: {
  warnOnTtlExpiry: boolean;
  anthropicTtlSeconds?: 300 | 3600;
}): Promise<{
  server: ReturnType<typeof createGatewayServer>;
  flight: SeededFlightRecorder;
  sessions: ISessionManager;
}> {
  const flight = new SeededFlightRecorder();
  const sessions = await createSessionManager(undefined, undefined, noopLogger);
  const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
  const server = createGatewayServer({
    sessionManager: sessions,
    asyncJobManager: manager,
    persistence: mkPersistence(),
    cacheAwareness: mkCacheAwareness({
      warnOnTtlExpiry: opts.warnOnTtlExpiry,
      anthropicTtlSeconds: opts.anthropicTtlSeconds ?? 300,
    }),
    flightRecorder: flight,
  });
  return { server, flight, sessions };
}

async function callTool(
  server: ReturnType<typeof createGatewayServer>,
  name: string,
  args: Record<string, unknown>
): Promise<Awaited<ReturnType<RegisteredTool["handler"]>>> {
  const reg = (server as unknown as Record<string, Record<string, RegisteredTool>>)
    ._registeredTools;
  return reg[name].handler(args, {});
}

describe("slice 3: cache_ttl_expiring_soon warning", () => {
  it("SYNC path: claude_request with TTL ≈ 5s emits warning (read from prior session row, not the row about to be inserted)", async () => {
    const { server, flight, sessions } = await setup({ warnOnTtlExpiry: true });
    const sess = await sessions.createSession("claude", "ttl-sync");
    flight.seedHit({ sessionId: sess.id, minutesAgo: 4 + 55 / 60 });

    const result = await callTool(server, "claude_request", {
      prompt: "any prompt",
      approvalStrategy: "legacy",
      sessionId: sess.id,
    });
    // The CLI invocation will most likely fail (no claude installed in
    // test sandbox / no API key), but the warning is computed BEFORE the
    // CLI runs and attached to either the success response or — for
    // structured warnings on failure — surfaces via structuredContent.
    // We check both shapes.
    const raw = result.content[0].text;
    const hasWarningInText = raw.includes("cache_ttl_expiring_soon");
    const warnings = result.warnings ?? [];
    const hasStructuredWarning = warnings.some(w => w.code === "cache_ttl_expiring_soon");
    expect(hasWarningInText || hasStructuredWarning).toBe(true);
  });

  it("ASYNC path: claude_request_async with TTL ≈ 5s (4m55s elapsed of 5min policy) emits warning", async () => {
    const { server, flight, sessions } = await setup({ warnOnTtlExpiry: true });
    const sess = await sessions.createSession("claude", "ttl-async");
    flight.seedHit({ sessionId: sess.id, minutesAgo: 4 + 55 / 60 });

    const result = await callTool(server, "claude_request_async", {
      prompt: "any prompt",
      approvalStrategy: "legacy",
      sessionId: sess.id,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.warnings).toBeDefined();
    expect(parsed.warnings[0].code).toBe("cache_ttl_expiring_soon");
    expect(parsed.warnings[0].ttlRemainingMs).toBeGreaterThan(0);
    expect(parsed.warnings[0].ttlRemainingMs).toBeLessThan(30_000);
  });

  it("ASYNC path: claude_request_async with TTL > 30s does NOT emit the warning", async () => {
    const { server, flight, sessions } = await setup({ warnOnTtlExpiry: true });
    const sess = await sessions.createSession("claude", "ttl-async-fresh");
    flight.seedHit({ sessionId: sess.id, minutesAgo: 1 });

    const result = await callTool(server, "claude_request_async", {
      prompt: "any prompt",
      approvalStrategy: "legacy",
      sessionId: sess.id,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.warnings).toBeUndefined();
  });

  it("flag OFF: warning is omitted entirely even with imminent expiry", async () => {
    const { server, flight, sessions } = await setup({ warnOnTtlExpiry: false });
    const sess = await sessions.createSession("claude", "ttl-async-flag-off");
    flight.seedHit({ sessionId: sess.id, minutesAgo: 4 + 55 / 60 });

    const result = await callTool(server, "claude_request_async", {
      prompt: "any prompt",
      approvalStrategy: "legacy",
      sessionId: sess.id,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.warnings).toBeUndefined();
  });

  it("1-hour TTL policy: 4m elapsed is well within window → no warning", async () => {
    const { server, flight, sessions } = await setup({
      warnOnTtlExpiry: true,
      anthropicTtlSeconds: 3600,
    });
    const sess = await sessions.createSession("claude", "ttl-1h");
    flight.seedHit({ sessionId: sess.id, minutesAgo: 4 });

    const result = await callTool(server, "claude_request_async", {
      prompt: "any prompt",
      approvalStrategy: "legacy",
      sessionId: sess.id,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.warnings).toBeUndefined();
  });

  it("no sessionId → no warning (TTL only meaningful when resuming a session)", async () => {
    const { server } = await setup({ warnOnTtlExpiry: true });
    const result = await callTool(server, "claude_request_async", {
      prompt: "any prompt",
      approvalStrategy: "legacy",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.warnings).toBeUndefined();
  });

  it("uses 1-hour TTL override when cache_control_blocks > 0 is found in latest row", async () => {
    const { server, flight, sessions } = await setup({
      warnOnTtlExpiry: true,
      anthropicTtlSeconds: 300, // 5 min policy in config
    });
    const sess = await sessions.createSession("claude", "ttl-override-test");
    // Seed a hit from 10 minutes ago, with explicit cache control block count of 1
    flight.seedHit({
      sessionId: sess.id,
      minutesAgo: 10,
      cacheControlBlocks: 1,
    });

    const result = await callTool(server, "claude_request_async", {
      prompt: "any prompt",
      approvalStrategy: "legacy",
      sessionId: sess.id,
    });
    const parsed = JSON.parse(result.content[0].text);
    // Should NOT warn since 10 minutes is well within the 1-hour override window
    expect(parsed.warnings).toBeUndefined();
  });
});
