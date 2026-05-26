import { describe, it, expect } from "vitest";
import { createGatewayServer } from "../index.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import type { PersistenceConfig } from "../config.js";
import type {
  FlightLogStart,
  FlightLogResult,
  FlightRecorderLike,
} from "../flight-recorder.js";
import { createSessionManager, type ISessionManager } from "../session-manager.js";

const CLI_TYPES = ["claude", "codex", "gemini", "grok", "mistral"] as const;

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

/**
 * In-memory FlightRecorder with a tiny SQL-like surface so cache-stats
 * aggregates work without a real SQLite file. Stores rows in a JS array
 * and returns them for SELECT-on-session_id and SELECT-on-stable_prefix_hash.
 */
class InMemoryFlightRecorder implements FlightRecorderLike {
  private rows: Array<{
    id: string;
    cli: string;
    model: string;
    prompt: string;
    session_id: string | null;
    stable_prefix_hash: string | null;
    stable_prefix_tokens: number | null;
    cache_read_tokens: number | null;
    cache_creation_tokens: number | null;
    datetime_utc: string;
  }> = [];

  logStart(entry: FlightLogStart): void {
    this.rows.push({
      id: entry.correlationId,
      cli: entry.cli,
      model: entry.model,
      prompt: entry.prompt,
      session_id: entry.sessionId ?? null,
      stable_prefix_hash: entry.stablePrefixHash ?? null,
      stable_prefix_tokens: entry.stablePrefixTokens ?? null,
      cache_read_tokens: null,
      cache_creation_tokens: null,
      datetime_utc: new Date().toISOString(),
    });
  }
  logComplete(correlationId: string, result: FlightLogResult): void {
    const row = this.rows.find(r => r.id === correlationId);
    if (row) {
      row.cache_read_tokens = result.cacheReadTokens ?? null;
      row.cache_creation_tokens = result.cacheCreationTokens ?? null;
    }
  }
  queryRequests<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    // Only the cache-stats SELECT patterns are exercised here. We naïvely
    // match WHERE session_id = ? and WHERE stable_prefix_hash = ?; broader
    // SELECT * (no WHERE) returns all rows.
    if (sql.includes("session_id = ?")) {
      const sid = params[0];
      return this.rows.filter(r => r.session_id === sid).map(r => ({
        cli: r.cli,
        model: r.model,
        cache_read_tokens: r.cache_read_tokens ?? 0,
        cache_creation_tokens: r.cache_creation_tokens ?? 0,
        stable_prefix_hash: r.stable_prefix_hash,
        datetime_utc: r.datetime_utc,
      })) as unknown as T[];
    }
    if (sql.includes("stable_prefix_hash = ?")) {
      const h = params[0];
      return this.rows.filter(r => r.stable_prefix_hash === h).map(r => ({
        cli: r.cli,
        model: r.model,
        cache_read_tokens: r.cache_read_tokens ?? 0,
        cache_creation_tokens: r.cache_creation_tokens ?? 0,
        stable_prefix_hash: r.stable_prefix_hash,
        datetime_utc: r.datetime_utc,
      })) as unknown as T[];
    }
    return this.rows.map(r => ({
      cli: r.cli,
      model: r.model,
      cache_read_tokens: r.cache_read_tokens ?? 0,
      cache_creation_tokens: r.cache_creation_tokens ?? 0,
      stable_prefix_hash: r.stable_prefix_hash,
      datetime_utc: r.datetime_utc,
    })) as unknown as T[];
  }
  flush(): void {}
  close(): void {}
}

interface RegisteredTool {
  handler: (args: Record<string, unknown>, extra?: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

async function callSessionGet(
  server: ReturnType<typeof createGatewayServer>,
  sessionId: string
): Promise<Record<string, unknown>> {
  const reg = (server as unknown as Record<string, Record<string, RegisteredTool>>)
    ._registeredTools;
  const tool = reg["session_get"];
  const result = await tool.handler({ sessionId }, {});
  return JSON.parse(result.content[0].text);
}

describe("session_get cacheState (slice 2)", () => {
  async function setup(): Promise<{
    server: ReturnType<typeof createGatewayServer>;
    flight: InMemoryFlightRecorder;
    sessions: ISessionManager;
  }> {
    const flight = new InMemoryFlightRecorder();
    const sessions = await createSessionManager(undefined, undefined, noopLogger);
    const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    const server = createGatewayServer({
      sessionManager: sessions,
      asyncJobManager: manager,
      persistence: mkPersistence(),
      flightRecorder: flight,
    });
    return { server, flight, sessions };
  }

  it.each(CLI_TYPES)(
    "%s: session with prior requests returns cacheState with non-null hitRate",
    async cli => {
      const { server, flight, sessions } = await setup();
      const session = await sessions.createSession(cli, "test");
      // Seed two flight rows: one hit, one miss.
      flight.logStart({
        correlationId: "row-a",
        cli,
        model: cli === "claude" ? "claude-sonnet-4-5" : "default",
        prompt: "p",
        sessionId: session.id,
        stablePrefixHash: "h1",
        stablePrefixTokens: 10,
      });
      flight.logComplete("row-a", {
        response: "ok",
        durationMs: 1,
        retryCount: 0,
        circuitBreakerState: "closed",
        optimizationApplied: false,
        exitCode: 0,
        status: "completed",
        cacheReadTokens: 100,
        cacheCreationTokens: 50,
      });
      flight.logStart({
        correlationId: "row-b",
        cli,
        model: cli === "claude" ? "claude-sonnet-4-5" : "default",
        prompt: "p",
        sessionId: session.id,
      });
      flight.logComplete("row-b", {
        response: "ok",
        durationMs: 1,
        retryCount: 0,
        circuitBreakerState: "closed",
        optimizationApplied: false,
        exitCode: 0,
        status: "completed",
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      });

      const resp = (await callSessionGet(server, session.id)) as {
        success: boolean;
        session: {
          cacheState?: {
            hitRate: number;
            requestCount: number;
            ttlRemainingMs: number | null;
          };
        };
      };
      expect(resp.success).toBe(true);
      expect(resp.session.cacheState).toBeDefined();
      expect(resp.session.cacheState!.requestCount).toBe(2);
      expect(resp.session.cacheState!.hitRate).toBeCloseTo(0.5, 5);
      // Slice 3: ttlRemainingMs surfaces — claude is the only CLI for
      // which it is non-null; the rest must be null.
      if (cli === "claude") {
        expect(typeof resp.session.cacheState!.ttlRemainingMs).toBe("number");
      } else {
        expect(resp.session.cacheState!.ttlRemainingMs).toBeNull();
      }
    }
  );

  it("session with NO prior requests omits cacheState entirely (not null, not empty)", async () => {
    const { server, sessions } = await setup();
    const session = await sessions.createSession("claude", "fresh");
    const resp = (await callSessionGet(server, session.id)) as {
      success: boolean;
      session: Record<string, unknown>;
    };
    expect(resp.success).toBe(true);
    expect("cacheState" in resp.session).toBe(false);
  });
});
