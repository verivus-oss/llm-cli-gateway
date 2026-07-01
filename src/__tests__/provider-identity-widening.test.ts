/**
 * Slice 0.5 — provider-identity widening (locked decision B: arbitrary names).
 *
 * These tests pin the identity-layer behaviour that ships dormant: an arbitrary
 * `[providers.<name>]` (kind:"api") id is a valid ProviderType that flows
 * through sessions and metrics without crashing, while the capability surface
 * rejects ids that have no static metadata. The Postgres CHECK round-trip lives
 * in provider-open-names-pg.test.ts (PG_TESTS only).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  FileSessionManager,
  providerKind,
  isCliType,
  defaultSessionDescription,
  CLI_TYPES,
} from "../session-manager.js";
import { PerformanceMetrics } from "../metrics.js";
import { getOneProviderToolCapabilities } from "../provider-tool-capabilities.js";

describe("Slice 0.5 provider-identity widening", () => {
  describe("providerKind / isCliType tagging", () => {
    it("tags the spawnable CLIs as kind:cli", () => {
      for (const cli of CLI_TYPES) {
        expect(providerKind(cli)).toBe("cli");
        expect(isCliType(cli)).toBe(true);
      }
    });

    it("tags grok-api and arbitrary [providers.<name>] ids as kind:api", () => {
      expect(providerKind("grok-api")).toBe("api");
      expect(providerKind("ollama")).toBe("api");
      expect(providerKind("openai")).toBe("api");
      expect(providerKind("some-self-hosted-vllm")).toBe("api");
      expect(isCliType("ollama")).toBe(false);
      expect(isCliType("grok-api")).toBe(false);
    });
  });

  describe("defaultSessionDescription", () => {
    it("uses the known label for registered providers", () => {
      expect(defaultSessionDescription("claude")).toBe("Claude Session");
      expect(defaultSessionDescription("grok-api")).toBe("Grok API Session");
    });

    it("derives a non-empty label for arbitrary API providers (never undefined)", () => {
      expect(defaultSessionDescription("ollama")).toBe("ollama Session");
    });
  });

  describe("FileSessionManager with an arbitrary API provider", () => {
    let testDir: string;
    let sessionManager: FileSessionManager;

    beforeEach(() => {
      testDir = join(tmpdir(), `slice05-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(testDir, { recursive: true });
      sessionManager = new FileSessionManager(join(testDir, "sessions.json"));
    });

    afterEach(() => {
      if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    });

    it("round-trips create/get/active for an arbitrary api provider id", () => {
      const session = sessionManager.createSession("ollama", undefined);
      expect(session.cli).toBe("ollama");
      expect(session.description).toBe("ollama Session");

      const fetched = sessionManager.getSession(session.id);
      expect(fetched?.cli).toBe("ollama");

      // Active-session pointer is keyed by the open provider id.
      const active = sessionManager.getActiveSession("ollama");
      expect(active?.id).toBe(session.id);

      // listSessions filter accepts the arbitrary id.
      expect(sessionManager.listSessions("ollama").map(s => s.id)).toEqual([session.id]);
    });

    it("keeps a CLI and an API provider with the same active-session slot independent", () => {
      const claude = sessionManager.createSession("claude");
      const ollama = sessionManager.createSession("ollama");
      expect(sessionManager.getActiveSession("claude")?.id).toBe(claude.id);
      expect(sessionManager.getActiveSession("ollama")?.id).toBe(ollama.id);
    });
  });

  describe("PerformanceMetrics with an arbitrary API provider", () => {
    it("lazily buckets an unregistered provider and surfaces it in the snapshot", () => {
      const metrics = new PerformanceMetrics();
      metrics.recordRequest("ollama", 120, true);
      metrics.recordRequest("ollama", 80, false);

      const snapshot = metrics.snapshot();
      expect(snapshot.totalRequests).toBe(2);
      expect(snapshot.byTool.ollama.requestCount).toBe(2);
      expect(snapshot.byTool.ollama.successCount).toBe(1);
      expect(snapshot.byTool.ollama.failureCount).toBe(1);
      expect(snapshot.byTool.ollama.averageResponseTimeMs).toBe(100);
      // The registered providers are still present (pre-populated) and untouched.
      expect(snapshot.byTool.claude.requestCount).toBe(0);
    });
  });

  describe("provider-tool capabilities reject ids without static metadata", () => {
    it("throws a clear error for an arbitrary api provider id", () => {
      expect(() => getOneProviderToolCapabilities("ollama")).toThrowError(
        /No tool-capability metadata for provider "ollama"/
      );
    });

    it("still serves a known provider id", () => {
      const claude = getOneProviderToolCapabilities("claude");
      expect(claude.cli).toBe("claude");
      expect(claude.providerKind).toBe("cli");
    });
  });
});
