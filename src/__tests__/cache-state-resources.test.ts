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
});
