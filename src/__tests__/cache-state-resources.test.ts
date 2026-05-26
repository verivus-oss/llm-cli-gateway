import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { FlightRecorder } from "../flight-recorder.js";
import { ResourceProvider } from "../resources.js";
import { PerformanceMetrics } from "../metrics.js";
import type { ISessionManager } from "../session-manager.js";

// Minimal session manager stub — cache-state resources do not call into it.
const sessionManagerStub: ISessionManager = {} as ISessionManager;

describe("cache_state resources", () => {
  let tmpDir: string;
  let rec: FlightRecorder;
  let provider: ResourceProvider;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "cache-state-res-"));
    rec = new FlightRecorder(path.join(tmpDir, "logs.db"));
    provider = new ResourceProvider(sessionManagerStub, new PerformanceMetrics(), rec);
    // Seed: two sessions × two CLIs with cache hits.
    rec.logStart({
      correlationId: "r1",
      cli: "claude",
      model: "claude-sonnet-4-5",
      prompt: "SECRET system prompt + SECRET task",
      sessionId: "sess-A",
      stablePrefixHash: "hash-abc",
      stablePrefixTokens: 100,
    });
    rec.logComplete("r1", {
      response: "SECRET response content",
      durationMs: 1,
      retryCount: 0,
      circuitBreakerState: "closed",
      optimizationApplied: false,
      exitCode: 0,
      status: "completed",
      cacheReadTokens: 50,
      cacheCreationTokens: 100,
    });
    rec.logStart({
      correlationId: "r2",
      cli: "claude",
      model: "claude-sonnet-4-5",
      prompt: "SECRET system prompt + SECRET task 2",
      sessionId: "sess-A",
      stablePrefixHash: "hash-abc",
      stablePrefixTokens: 100,
    });
    rec.logComplete("r2", {
      response: "SECRET response 2",
      durationMs: 1,
      retryCount: 0,
      circuitBreakerState: "closed",
      optimizationApplied: false,
      exitCode: 0,
      status: "completed",
      cacheReadTokens: 75,
      cacheCreationTokens: 0,
    });
  });

  afterEach(() => {
    rec.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("readCacheStateGlobal returns aggregates without any raw prompt/response field", () => {
    const stats = provider.readCacheStateGlobal();
    const json = JSON.stringify(stats);
    expect(json).not.toContain("SECRET");
    expect(stats.totalRequests).toBe(2);
    expect(stats.totalHits).toBe(2);
    expect(stats.hitRate).toBeCloseTo(1.0, 5);
    expect(stats.totalCacheReadTokens).toBe(125);
    expect(stats.perCli[0].cli).toBe("claude");
    // No raw text fields by construction:
    expect((stats as unknown as Record<string, unknown>).prompt).toBeUndefined();
    expect((stats as unknown as Record<string, unknown>).response).toBeUndefined();
    expect((stats as unknown as Record<string, unknown>).system).toBeUndefined();
    expect((stats as unknown as Record<string, unknown>).task).toBeUndefined();
  });

  it("readCacheStateSession populates ttlRemainingMs from the configured TTL policy", () => {
    const claudeConfig = {
      emitAnthropicCacheControl: false,
      anthropicTtlSeconds: 300 as const,
      warnOnTtlExpiry: false,
      minStableTokensForCacheControl: {
        sonnet: 1024,
        opus: 4096,
        haiku: 4096,
        default: 4096,
      },
      sources: { configFile: null },
    };
    const providerWithConfig = new ResourceProvider(
      sessionManagerStub,
      new PerformanceMetrics(),
      rec,
      claudeConfig
    );
    const stats = providerWithConfig.readCacheStateSession("sess-A");
    // claude session → ttlRemainingMs is a number (or 0 if elapsed > policy).
    expect(typeof stats.ttlRemainingMs).toBe("number");
  });

  it("readCacheStateSession returns aggregates without prompt text", () => {
    const stats = provider.readCacheStateSession("sess-A");
    const json = JSON.stringify(stats);
    expect(json).not.toContain("SECRET");
    expect(stats.requestCount).toBe(2);
    expect(stats.hitCount).toBe(2);
    expect(stats.totalCacheReadTokens).toBe(125);
    expect(stats.distinctPrefixCount).toBe(1);
    expect(stats.cli).toBe("claude");
    expect((stats as unknown as Record<string, unknown>).prompt).toBeUndefined();
    expect((stats as unknown as Record<string, unknown>).response).toBeUndefined();
  });

  it("readCacheStateForPrefix returns aggregates without prompt text", () => {
    const stats = provider.readCacheStateForPrefix("hash-abc");
    const json = JSON.stringify(stats);
    expect(json).not.toContain("SECRET");
    expect(stats.requestCount).toBe(2);
    expect(stats.totalCacheReadTokens).toBe(125);
    expect(stats.cliBreakdown[0].cli).toBe("claude");
    expect(stats.cliBreakdown[0].count).toBe(2);
    expect((stats as unknown as Record<string, unknown>).prompt).toBeUndefined();
    expect((stats as unknown as Record<string, unknown>).response).toBeUndefined();
  });

  it("readCacheStateSession returns empty defaults for unknown session (no error)", () => {
    const stats = provider.readCacheStateSession("no-such-session");
    expect(stats.requestCount).toBe(0);
    expect(stats.hitRate).toBe(0);
    expect(stats.lastRequestAt).toBeNull();
  });

  it("readCacheStateForPrefix returns empty defaults for unknown hash", () => {
    const stats = provider.readCacheStateForPrefix("no-such-hash");
    expect(stats.requestCount).toBe(0);
    expect(stats.cliBreakdown).toEqual([]);
  });

  // Slice 1.5: cache_state://* must aggregate async-job rows now that
  // AsyncJobManager writes its own logStart/logComplete with asyncJobId set.
  // Seed an async-flavoured row alongside the sync rows in beforeEach and
  // verify that the global + per-prefix aggregates include it.
  it("readCacheStateGlobal aggregates async-job rows (slice 1.5)", () => {
    rec.logStart({
      correlationId: "r-async-1",
      cli: "codex",
      model: "codex-mini",
      prompt: "SECRET async-job assembled prompt",
      sessionId: "sess-B",
      asyncJobId: "job-uuid-1",
      stablePrefixHash: "hash-async",
      stablePrefixTokens: 200,
    });
    rec.logComplete("r-async-1", {
      response: "SECRET async response",
      durationMs: 1,
      retryCount: 0,
      circuitBreakerState: "closed",
      optimizationApplied: false,
      exitCode: 0,
      status: "completed",
      cacheReadTokens: 60,
      cacheCreationTokens: 0,
    });

    const stats = provider.readCacheStateGlobal();
    // 2 sync claude rows from beforeEach + 1 async codex row.
    expect(stats.totalRequests).toBe(3);
    expect(stats.totalHits).toBe(3);
    expect(stats.totalCacheReadTokens).toBe(125 + 60);
    const codexBreakdown = stats.perCli.find(c => c.cli === "codex");
    expect(codexBreakdown).toBeDefined();
    expect(codexBreakdown!.requestCount).toBe(1);
    expect(codexBreakdown!.totalCacheReadTokens).toBe(60);
  });

  it("readCacheStateForPrefix aggregates async-job rows (slice 1.5)", () => {
    rec.logStart({
      correlationId: "r-async-2",
      cli: "claude",
      model: "claude-sonnet-4-5",
      prompt: "SECRET",
      sessionId: "sess-C",
      asyncJobId: "job-uuid-2",
      stablePrefixHash: "hash-shared",
      stablePrefixTokens: 100,
    });
    rec.logComplete("r-async-2", {
      response: "SECRET",
      durationMs: 1,
      retryCount: 0,
      circuitBreakerState: "closed",
      optimizationApplied: false,
      exitCode: 0,
      status: "completed",
      cacheReadTokens: 80,
    });
    // Same prefix from a sync row too.
    rec.logStart({
      correlationId: "r-sync-2",
      cli: "claude",
      model: "claude-sonnet-4-5",
      prompt: "SECRET",
      sessionId: "sess-C",
      stablePrefixHash: "hash-shared",
      stablePrefixTokens: 100,
    });
    rec.logComplete("r-sync-2", {
      response: "SECRET",
      durationMs: 1,
      retryCount: 0,
      circuitBreakerState: "closed",
      optimizationApplied: false,
      exitCode: 0,
      status: "completed",
      cacheReadTokens: 20,
    });

    const stats = provider.readCacheStateForPrefix("hash-shared");
    expect(stats.requestCount).toBe(2); // one async + one sync share the hash
    expect(stats.totalCacheReadTokens).toBe(100);
  });
});
