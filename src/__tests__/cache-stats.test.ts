import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { FlightRecorder } from "../flight-recorder.js";
import {
  computeSessionCacheStats,
  computePrefixCacheStats,
  computeGlobalCacheStats,
  computeTtlRemaining,
  type SessionCacheStats,
} from "../cache-stats.js";

describe("cache-stats", () => {
  let tmpDir: string;
  let rec: FlightRecorder;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "cache-stats-test-"));
    rec = new FlightRecorder(path.join(tmpDir, "logs.db"));
  });

  afterEach(() => {
    rec.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedRequest(opts: {
    id: string;
    cli: "claude" | "codex" | "gemini" | "grok" | "mistral";
    model: string;
    sessionId?: string;
    stableHash?: string;
    cacheRead?: number;
    cacheCreation?: number;
  }): void {
    rec.logStart({
      correlationId: opts.id,
      cli: opts.cli,
      model: opts.model,
      prompt: "p",
      sessionId: opts.sessionId,
      stablePrefixHash: opts.stableHash,
      stablePrefixTokens: opts.stableHash ? 100 : undefined,
    });
    rec.logComplete(opts.id, {
      response: "r",
      durationMs: 1,
      retryCount: 0,
      circuitBreakerState: "closed",
      optimizationApplied: false,
      exitCode: 0,
      status: "completed",
      cacheReadTokens: opts.cacheRead,
      cacheCreationTokens: opts.cacheCreation,
    });
  }

  describe("computeSessionCacheStats", () => {
    it("returns zeros for a session with no rows", () => {
      const s = computeSessionCacheStats(rec, "no-such-session");
      expect(s.requestCount).toBe(0);
      expect(s.hitCount).toBe(0);
      expect(s.hitRate).toBe(0); // never divides by zero
      expect(s.totalCacheReadTokens).toBe(0);
      expect(s.totalCacheCreationTokens).toBe(0);
      expect(s.distinctPrefixCount).toBe(0);
      expect(s.lastRequestAt).toBeNull();
      expect(s.estimatedSavingsUsd).toBe(0);
      expect(s.cli).toBeNull();
    });

    it("aggregates cache reads / creation across a session", () => {
      seedRequest({
        id: "s1-a",
        cli: "claude",
        model: "sonnet",
        sessionId: "sess-1",
        stableHash: "h1",
        cacheRead: 100,
        cacheCreation: 50,
      });
      seedRequest({
        id: "s1-b",
        cli: "claude",
        model: "sonnet",
        sessionId: "sess-1",
        stableHash: "h1",
        cacheRead: 200,
        cacheCreation: 0,
      });
      seedRequest({
        id: "s1-c",
        cli: "claude",
        model: "sonnet",
        sessionId: "sess-1",
        stableHash: "h2",
        cacheRead: 0,
        cacheCreation: 0,
      });

      const s = computeSessionCacheStats(rec, "sess-1");
      expect(s.requestCount).toBe(3);
      expect(s.totalCacheReadTokens).toBe(300);
      expect(s.totalCacheCreationTokens).toBe(50);
      expect(s.hitCount).toBe(2); // a + b have cache reads > 0
      expect(s.hitRate).toBeCloseTo(2 / 3, 5);
      expect(s.distinctPrefixCount).toBe(2);
      expect(s.cli).toBe("claude");
      // sonnet input $3/M, cache read multiplier 0.1 → saved per token = $3 * 0.9 / 1e6
      // 300 tokens × $3 × 0.9 / 1e6 = 0.00081
      expect(s.estimatedSavingsUsd).toBeCloseTo((300 * 3 * 0.9) / 1e6, 8);
    });

    it("tolerates only cache misses (NULL or 0 cache tokens) without dividing by zero", () => {
      seedRequest({ id: "miss-a", cli: "gemini", model: "flash", sessionId: "miss-sess" }); // no cache tokens
      seedRequest({
        id: "miss-b",
        cli: "gemini",
        model: "flash",
        sessionId: "miss-sess",
        cacheRead: 0,
      });
      const s = computeSessionCacheStats(rec, "miss-sess");
      expect(s.requestCount).toBe(2);
      expect(s.hitCount).toBe(0);
      expect(s.hitRate).toBe(0);
      expect(s.totalCacheReadTokens).toBe(0);
      expect(s.estimatedSavingsUsd).toBe(0); // gemini pricing = 0
    });

    it("handles legacy rows (no stable_prefix_hash)", () => {
      seedRequest({ id: "legacy", cli: "claude", model: "sonnet", sessionId: "leg-sess" });
      // No stableHash → stable_prefix_hash stays NULL in DB
      const s = computeSessionCacheStats(rec, "leg-sess");
      expect(s.requestCount).toBe(1);
      expect(s.distinctPrefixCount).toBe(0);
    });
  });

  describe("computePrefixCacheStats", () => {
    it("returns zeros for an unknown hash", () => {
      const p = computePrefixCacheStats(rec, "no-such-hash");
      expect(p.requestCount).toBe(0);
      expect(p.hitRate).toBe(0);
      expect(p.cliBreakdown).toEqual([]);
    });

    it("aggregates across sessions for the same hash, with multi-CLI breakdown", () => {
      seedRequest({
        id: "p-1",
        cli: "claude",
        model: "sonnet",
        sessionId: "x",
        stableHash: "shared",
        cacheRead: 100,
      });
      seedRequest({
        id: "p-2",
        cli: "claude",
        model: "sonnet",
        sessionId: "x",
        stableHash: "shared",
        cacheRead: 200,
      });
      seedRequest({
        id: "p-3",
        cli: "codex",
        model: "gpt-5.4",
        sessionId: "y",
        stableHash: "shared",
        cacheRead: 50,
      });

      const p = computePrefixCacheStats(rec, "shared");
      expect(p.requestCount).toBe(3);
      expect(p.hitCount).toBe(3);
      expect(p.totalCacheReadTokens).toBe(350);
      const breakdown = p.cliBreakdown;
      expect(breakdown).toHaveLength(2);
      expect(breakdown[0].cli).toBe("claude");
      expect(breakdown[0].count).toBe(2);
      const codex = breakdown.find(b => b.cli === "codex");
      expect(codex?.count).toBe(1);
    });
  });

  describe("computeGlobalCacheStats", () => {
    it("returns zeroed when no rows match", () => {
      const g = computeGlobalCacheStats(rec, { lastNHours: 24 });
      expect(g.totalRequests).toBe(0);
      expect(g.totalHits).toBe(0);
      expect(g.hitRate).toBe(0);
      expect(g.perCli).toEqual([]);
      expect(g.estimatedSavingsUsd).toBe(0);
      expect(g.windowHours).toBe(24);
    });

    it("multi-CLI breakdown across all rows when no window", () => {
      seedRequest({ id: "g-1", cli: "claude", model: "sonnet", cacheRead: 100 });
      seedRequest({ id: "g-2", cli: "claude", model: "sonnet", cacheRead: 0 });
      seedRequest({ id: "g-3", cli: "codex", model: "gpt-5.4", cacheRead: 200 });
      seedRequest({ id: "g-4", cli: "gemini", model: "flash" });

      const g = computeGlobalCacheStats(rec);
      expect(g.windowHours).toBeNull();
      expect(g.totalRequests).toBe(4);
      expect(g.totalHits).toBe(2); // g-1 and g-3
      expect(g.hitRate).toBeCloseTo(0.5, 5);
      const claude = g.perCli.find(c => c.cli === "claude");
      const codex = g.perCli.find(c => c.cli === "codex");
      const gemini = g.perCli.find(c => c.cli === "gemini");
      expect(claude?.requestCount).toBe(2);
      expect(claude?.hitCount).toBe(1);
      expect(codex?.totalCacheReadTokens).toBe(200);
      expect(gemini?.requestCount).toBe(1);
      expect(g.estimatedSavingsUsd).toBeGreaterThan(0);
    });
  });

  describe("computeTtlRemaining (slice 3)", () => {
    function makeStats(opts: {
      cli: SessionCacheStats["cli"];
      lastRequestAt: string | null;
    }): SessionCacheStats {
      return {
        sessionId: "s",
        cli: opts.cli,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        requestCount: 0,
        hitCount: 0,
        hitRate: 0,
        distinctPrefixCount: 0,
        lastRequestAt: opts.lastRequestAt,
        estimatedSavingsUsd: 0,
        ttlRemainingMs: null,
      };
    }

    it("claude default 5-min TTL: 4 min after write → ≈60s remaining", () => {
      const now = 1_700_000_000_000;
      const lastWrite = new Date(now - 4 * 60_000).toISOString();
      const stats = makeStats({ cli: "claude", lastRequestAt: lastWrite });
      const ttl = computeTtlRemaining(stats, "claude", {
        anthropicTtlSeconds: 300,
        now: () => now,
      });
      // 5min = 300s = 300000ms; elapsed = 240000ms; remaining = 60000ms.
      expect(ttl).toBe(60_000);
    });

    it("claude 1-hour TTL: 4 min after write → ≈56min remaining", () => {
      const now = 1_700_000_000_000;
      const lastWrite = new Date(now - 4 * 60_000).toISOString();
      const stats = makeStats({ cli: "claude", lastRequestAt: lastWrite });
      const ttl = computeTtlRemaining(stats, "claude", {
        anthropicTtlSeconds: 3600,
        now: () => now,
      });
      // 1h = 3600s = 3600000ms; elapsed = 240000ms; remaining = 3360000ms.
      expect(ttl).toBe(3_360_000);
    });

    it("claude: TTL clamped to 0 when elapsed > policy", () => {
      const now = 1_700_000_000_000;
      const lastWrite = new Date(now - 10 * 60_000).toISOString();
      const stats = makeStats({ cli: "claude", lastRequestAt: lastWrite });
      const ttl = computeTtlRemaining(stats, "claude", {
        anthropicTtlSeconds: 300,
        now: () => now,
      });
      expect(ttl).toBe(0);
    });

    it("non-claude CLI returns null (we have no read on its cache state)", () => {
      const stats = makeStats({
        cli: "gemini",
        lastRequestAt: new Date().toISOString(),
      });
      expect(
        computeTtlRemaining(stats, "gemini", {
          anthropicTtlSeconds: 300,
        })
      ).toBeNull();
      expect(computeTtlRemaining(stats, "codex", { anthropicTtlSeconds: 300 })).toBeNull();
    });

    it("null lastRequestAt → null ttlRemainingMs", () => {
      const stats = makeStats({ cli: "claude", lastRequestAt: null });
      expect(computeTtlRemaining(stats, "claude", { anthropicTtlSeconds: 300 })).toBeNull();
    });
  });
});
