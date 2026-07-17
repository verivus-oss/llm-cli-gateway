import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  FileSessionManager,
  FileSessionStorageFaultError,
  remoteSafeSession,
  callerIsRemote,
  publicSafeSession,
  sessionGenerationIdentity,
  type Session,
} from "../session-manager.js";
import { runWithRequestContext } from "../request-context.js";
import type { KitExecutionRef, KitSessionBinding } from "../personal-config-types.js";
import { existsSync, mkdirSync, rmSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("SessionManager", () => {
  let testDir: string;
  let sessionManager: FileSessionManager;

  beforeEach(() => {
    // Create a temporary directory for test storage
    testDir = join(
      tmpdir(),
      `session-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    );
    mkdirSync(testDir, { recursive: true });
    const storagePath = join(testDir, "sessions.json");
    sessionManager = new FileSessionManager(storagePath);
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("session creation", () => {
    it("should create a new session with auto-generated ID", () => {
      const session = sessionManager.createSession("claude", "Test session");

      expect(session.id).toBeDefined();
      expect(session.cli).toBe("claude");
      expect(session.description).toBe("Test session");
      expect(session.createdAt).toBeDefined();
      expect(session.lastUsedAt).toBeDefined();
    });

    it("stamps ownerPrincipal 'local' when created with no request context (F3)", () => {
      const session = sessionManager.createSession("claude", "Local session");
      expect(session.ownerPrincipal).toBe("local");
    });

    it("stamps the ambient request-context principal as the owner (F3)", () => {
      const session = runWithRequestContext(
        { transport: "http", authScopes: [], authPrincipal: "user-alice@example.com" },
        () => sessionManager.createSession("codex", "Owned session")
      );
      expect(session.ownerPrincipal).toBe("user-alice@example.com");
    });

    it("should create a session with custom ID", () => {
      const customId = "custom-session-id-123";
      const session = sessionManager.createSession("codex", "Custom ID session", customId);

      expect(session.id).toBe(customId);
      expect(session.cli).toBe("codex");
    });

    it("atomically rejects explicit ID collisions without replacing the winner", () => {
      const winner = runWithRequestContext(
        { transport: "http", authScopes: [], authPrincipal: "owner-a" },
        () => sessionManager.createSession("claude", "winner", "shared-id")
      );

      expect(() => sessionManager.createSession("claude", "same provider", "shared-id")).toThrow(
        /already exists/
      );
      expect(() =>
        sessionManager.createSession("codex", "different provider", "shared-id")
      ).toThrow(/already exists/);
      expect(() =>
        runWithRequestContext({ transport: "http", authScopes: [], authPrincipal: "owner-b" }, () =>
          sessionManager.createSession("claude", "different owner", "shared-id")
        )
      ).toThrow(/already exists/);

      expect(sessionManager.getSession("shared-id")).toEqual(winner);
    });

    it("atomically creates an explicit session with its admitted metadata", () => {
      const winner = sessionManager.createSessionWithMetadata(
        "claude",
        "scoped winner",
        "scoped-id",
        { workspaceAlias: "repo-a", workspaceRoot: "/workspace/a" }
      );
      expect(winner.metadata).toEqual({
        workspaceAlias: "repo-a",
        workspaceRoot: "/workspace/a",
      });
      expect(() =>
        sessionManager.createSessionWithMetadata("claude", "loser", "scoped-id", {
          workspaceAlias: "repo-b",
          workspaceRoot: "/workspace/b",
        })
      ).toThrow(/already exists/);
      expect(sessionManager.getSession("scoped-id")?.metadata).toEqual(winner.metadata);
    });

    it("should set newly created session as active if none exists", () => {
      const session = sessionManager.createSession("gemini");
      const activeSession = sessionManager.getActiveSession("gemini");

      expect(activeSession).toBeDefined();
      expect(activeSession?.id).toBe(session.id);
    });

    it("should not override existing active session", () => {
      const firstSession = sessionManager.createSession("claude", "First");
      const secondSession = sessionManager.createSession("claude", "Second");

      const activeSession = sessionManager.getActiveSession("claude");
      expect(activeSession?.id).toBe(firstSession.id);
      expect(activeSession?.id).not.toBe(secondSession.id);
    });

    it("should create sessions for different providers independently", () => {
      const claudeSession = sessionManager.createSession("claude");
      const codexSession = sessionManager.createSession("codex");
      const geminiSession = sessionManager.createSession("gemini");
      const grokSession = sessionManager.createSession("grok");
      const grokApiSession = sessionManager.createSession("grok-api");

      expect(claudeSession.cli).toBe("claude");
      expect(codexSession.cli).toBe("codex");
      expect(geminiSession.cli).toBe("gemini");
      expect(grokSession.cli).toBe("grok");
      expect(grokApiSession.cli).toBe("grok-api");

      expect(sessionManager.getActiveSession("claude")?.id).toBe(claudeSession.id);
      expect(sessionManager.getActiveSession("codex")?.id).toBe(codexSession.id);
      expect(sessionManager.getActiveSession("gemini")?.id).toBe(geminiSession.id);
      expect(sessionManager.getActiveSession("grok")?.id).toBe(grokSession.id);
      expect(sessionManager.getActiveSession("grok-api")?.id).toBe(grokApiSession.id);
    });
  });

  describe("session retrieval", () => {
    it("should retrieve a session by ID", () => {
      const created = sessionManager.createSession("claude", "Test");
      const retrieved = sessionManager.getSession(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.description).toBe("Test");
    });

    it("should return null for non-existent session ID", () => {
      const session = sessionManager.getSession("non-existent-id");
      expect(session).toBeNull();
    });

    it("should list all sessions", () => {
      sessionManager.createSession("claude", "Session 1");
      sessionManager.createSession("codex", "Session 2");
      sessionManager.createSession("gemini", "Session 3");

      const sessions = sessionManager.listSessions();
      expect(sessions).toHaveLength(3);
    });

    it("should filter sessions by CLI", () => {
      sessionManager.createSession("claude", "Claude 1");
      sessionManager.createSession("claude", "Claude 2");
      sessionManager.createSession("codex", "Codex 1");

      const claudeSessions = sessionManager.listSessions("claude");
      expect(claudeSessions).toHaveLength(2);
      expect(claudeSessions.every(s => s.cli === "claude")).toBe(true);

      const codexSessions = sessionManager.listSessions("codex");
      expect(codexSessions).toHaveLength(1);
      expect(codexSessions[0].cli).toBe("codex");
    });

    it("should return empty array when no sessions exist", () => {
      const sessions = sessionManager.listSessions();
      expect(sessions).toEqual([]);
    });
  });

  describe("session deletion", () => {
    it("notifies cleanup observers for successful delete, clear, and TTL eviction", async () => {
      const observed: string[] = [];
      sessionManager.addSessionRemovalObserver(session => observed.push(session.id));
      const deleted = sessionManager.createSession("claude");
      const retained = sessionManager.createSession("codex");

      expect(sessionManager.deleteSession("missing-session")).toBe(false);
      expect(observed).toEqual([]);
      expect(sessionManager.deleteSession(deleted.id)).toBe(true);
      expect(observed).toEqual([deleted.id]);

      expect(sessionManager.clearAllSessions("codex")).toBe(1);
      expect(observed).toEqual([deleted.id, retained.id]);

      const ttlManager = new FileSessionManager(join(testDir, "ttl-sessions.json"), 1);
      ttlManager.addSessionRemovalObserver(session => observed.push(session.id));
      const expired = ttlManager.createSession("gemini");
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(ttlManager.getSession(expired.id)).toBeNull();
      expect(observed).toContain(expired.id);
    });

    it("runs cleanup and removal hooks when an active session expires during lookup", () => {
      const cleaned: string[] = [];
      const removed: string[] = [];
      const manager = new FileSessionManager(join(testDir, "active-ttl-sessions.json"), -1, {
        cleanupHook: session => cleaned.push(session.id),
      });
      manager.addSessionRemovalObserver(session => removed.push(session.id));
      const expired = manager.createSession("claude");

      expect(manager.getActiveSession("claude")).toBeNull();
      expect(cleaned).toEqual([expired.id]);
      expect(removed).toEqual([expired.id]);
      expect(manager.getSession(expired.id)).toBeNull();
    });

    it("runs cleanup and removal hooks on the expired active Kit lookup branch", () => {
      const cleaned: string[] = [];
      const removed: string[] = [];
      const manager = new FileSessionManager(
        join(testDir, "active-kit-ttl-sessions.json"),
        60_000,
        {
          cleanupHook: session => cleaned.push(session.id),
        }
      );
      manager.addSessionRemovalObserver(session => removed.push(session.id));
      const execution: KitExecutionRef = {
        version: 1,
        releaseId: "release-active-ttl",
        configStamp: "stamp-active-ttl",
        scopeRoot: "/workspace/active-ttl",
        scopeHead: "head-active-ttl",
        contextIdentity: "context-active-ttl",
      };
      const binding: KitSessionBinding = {
        execution,
        nativeSessionId: "11111111-1111-4111-8111-111111111111",
        resumeEligible: true,
      };
      const expired = manager.createKitSession("codex", binding);
      const internals = manager as unknown as {
        isExpired(session: Session): boolean;
      };
      internals.isExpired = () => true;

      expect(manager.getActiveKitSession("codex", execution.scopeRoot, execution)).toBeNull();
      expect(cleaned).toEqual([expired.id]);
      expect(removed).toEqual([expired.id]);
      expect(manager.getSession(expired.id)).toBeNull();
    });

    it("should delete a session by ID", () => {
      const session = sessionManager.createSession("claude");
      const deleted = sessionManager.deleteSession(session.id);

      expect(deleted).toBe(true);
      expect(sessionManager.getSession(session.id)).toBeNull();
    });

    it("should return false when deleting non-existent session", () => {
      const deleted = sessionManager.deleteSession("non-existent");
      expect(deleted).toBe(false);
    });

    it("should clear active session when deleting active session", () => {
      const session = sessionManager.createSession("claude");
      expect(sessionManager.getActiveSession("claude")).toBeDefined();

      sessionManager.deleteSession(session.id);
      expect(sessionManager.getActiveSession("claude")).toBeNull();
    });

    it("should not affect active session when deleting non-active session", () => {
      const firstSession = sessionManager.createSession("claude");
      const secondSession = sessionManager.createSession("claude");

      sessionManager.deleteSession(secondSession.id);
      expect(sessionManager.getActiveSession("claude")?.id).toBe(firstSession.id);
    });

    it("should clear all sessions", () => {
      sessionManager.createSession("claude");
      sessionManager.createSession("codex");
      sessionManager.createSession("gemini");

      const count = sessionManager.clearAllSessions();
      expect(count).toBe(3);
      expect(sessionManager.listSessions()).toHaveLength(0);
    });

    it("should clear sessions for specific CLI only", () => {
      sessionManager.createSession("claude");
      sessionManager.createSession("claude");
      sessionManager.createSession("codex");

      const count = sessionManager.clearAllSessions("claude");
      expect(count).toBe(2);
      expect(sessionManager.listSessions("claude")).toHaveLength(0);
      expect(sessionManager.listSessions("codex")).toHaveLength(1);
    });
  });

  describe("active session management", () => {
    it("should set active session", () => {
      const session = sessionManager.createSession("claude");
      sessionManager.setActiveSession("claude", null); // Clear first
      sessionManager.setActiveSession("claude", session.id);

      const active = sessionManager.getActiveSession("claude");
      expect(active?.id).toBe(session.id);
    });

    it("should clear active session by setting to null", () => {
      sessionManager.createSession("claude");
      sessionManager.setActiveSession("claude", null);

      expect(sessionManager.getActiveSession("claude")).toBeNull();
    });

    it("should return false when setting non-existent session as active", () => {
      const result = sessionManager.setActiveSession("claude", "non-existent");
      expect(result).toBe(false);
    });

    it("should return false when setting session from wrong CLI", () => {
      const claudeSession = sessionManager.createSession("claude");
      const result = sessionManager.setActiveSession("codex", claudeSession.id);

      expect(result).toBe(false);
    });

    it("should allow setting active session to null", () => {
      const result = sessionManager.setActiveSession("claude", null);
      expect(result).toBe(true);
    });

    it("should maintain separate active sessions per CLI", () => {
      const claudeSession = sessionManager.createSession("claude");
      const codexSession = sessionManager.createSession("codex");

      expect(sessionManager.getActiveSession("claude")?.id).toBe(claudeSession.id);
      expect(sessionManager.getActiveSession("codex")?.id).toBe(codexSession.id);
    });
  });

  describe("session updates", () => {
    it("should update session usage timestamp", () => {
      const session = sessionManager.createSession("claude");
      const originalLastUsed = session.lastUsedAt;

      // Wait a bit to ensure timestamp difference
      setTimeout(() => {
        sessionManager.updateSessionUsage(session.id);
        const updated = sessionManager.getSession(session.id);

        expect(updated?.lastUsedAt).not.toBe(originalLastUsed);
      }, 10);
    });

    it("should not throw when updating non-existent session", () => {
      expect(() => {
        sessionManager.updateSessionUsage("non-existent");
      }).not.toThrow();
    });

    it("should update session metadata", () => {
      const session = sessionManager.createSession("claude");
      const success = sessionManager.updateSessionMetadata(session.id, {
        custom: "value",
        count: 42,
      });

      expect(success).toBe(true);
      const updated = sessionManager.getSession(session.id);
      expect(updated?.metadata).toEqual({ custom: "value", count: 42 });
    });

    it("should merge metadata on updates", () => {
      const session = sessionManager.createSession("claude");
      sessionManager.updateSessionMetadata(session.id, { key1: "value1" });
      sessionManager.updateSessionMetadata(session.id, { key2: "value2" });

      const updated = sessionManager.getSession(session.id);
      expect(updated?.metadata).toEqual({ key1: "value1", key2: "value2" });
    });

    it("should return false when updating metadata for non-existent session", () => {
      const result = sessionManager.updateSessionMetadata("non-existent", { key: "value" });
      expect(result).toBe(false);
    });

    it("compare-and-set binds metadata only for the exact generation and expected state", () => {
      const session = sessionManager.createSession("claude", "CAS", "cas-session");
      const identity = sessionGenerationIdentity(session);
      expect(
        sessionManager.compareAndSetSession(identity, {
          kind: "replace_metadata",
          expectedMetadata: undefined,
          metadata: { workspaceAlias: "repo" },
        })
      ).toBe(true);
      expect(sessionManager.getSession(session.id)?.metadata).toEqual({ workspaceAlias: "repo" });

      expect(
        sessionManager.compareAndSetSession(identity, {
          kind: "replace_metadata",
          expectedMetadata: undefined,
          metadata: { workspaceAlias: "stale-overwrite" },
        })
      ).toBe(false);
      expect(
        sessionManager.compareAndSetSession(identity, {
          kind: "delete",
          expectedMetadata: undefined,
        })
      ).toBe(false);
    });

    it("rejects an old generation even when id, provider, owner, and timestamp match", () => {
      const original = sessionManager.createSession("claude", "first", "reused-id");
      const staleIdentity = sessionGenerationIdentity(original);
      expect(sessionManager.deleteSession(original.id)).toBe(true);
      const replacement = sessionManager.createSession("claude", "replacement", "reused-id");
      const forgedOldIdentity = {
        ...staleIdentity,
        createdAt: replacement.createdAt,
      };

      expect(
        sessionManager.compareAndSetSession(forgedOldIdentity, {
          kind: "replace_metadata",
          expectedMetadata: undefined,
          metadata: { shouldNotAppear: true },
        })
      ).toBe(false);
      expect(sessionManager.getSession(replacement.id)?.metadata).toBeUndefined();
    });

    it("strips the opaque generation from public session projections", () => {
      const session = sessionManager.createSession("claude", "public projection");
      expect(session.generation).toBeTypeOf("string");
      expect(publicSafeSession(session)).not.toHaveProperty("generation");
      expect(remoteSafeSession(session)).not.toHaveProperty("generation");
    });
  });

  describe("persistence", () => {
    it("should persist sessions to disk", () => {
      const session = sessionManager.createSession("claude", "Persisted session");
      const storagePath = join(testDir, "sessions.json");

      expect(existsSync(storagePath)).toBe(true);
      const mode = statSync(storagePath).mode & 0o777;
      expect(mode).toBe(0o600);

      const content = readFileSync(storagePath, "utf-8");
      const data = JSON.parse(content);

      expect(data.sessions[session.id]).toBeDefined();
      expect(data.sessions[session.id].description).toBe("Persisted session");
    });

    it("should load sessions from disk on initialization", () => {
      const session = sessionManager.createSession("claude", "Original");
      const sessionId = session.id;
      const storagePath = join(testDir, "sessions.json");

      // Create a new instance that should load from disk
      const newManager = new FileSessionManager(storagePath);
      const loaded = newManager.getSession(sessionId);

      expect(loaded).toBeDefined();
      expect(loaded?.description).toBe("Original");
    });

    it("backfills and persists a random generation for legacy file sessions", () => {
      const storagePath = join(testDir, "legacy-sessions.json");
      writeFileSync(
        storagePath,
        JSON.stringify({
          sessions: {
            legacy: {
              id: "legacy",
              cli: "claude",
              description: "legacy",
              createdAt: new Date().toISOString(),
              lastUsedAt: new Date().toISOString(),
              ownerPrincipal: "local",
            },
          },
          activeSession: { claude: "legacy" },
        })
      );

      const migrated = new FileSessionManager(storagePath);
      const generation = migrated.getSession("legacy")?.generation;
      expect(generation).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
      expect(JSON.parse(readFileSync(storagePath, "utf8")).sessions.legacy.generation).toBe(
        generation
      );
    });

    it("should persist active sessions", () => {
      const session = sessionManager.createSession("claude");
      sessionManager.setActiveSession("claude", session.id);
      const storagePath = join(testDir, "sessions.json");

      const newManager = new FileSessionManager(storagePath);
      const activeSession = newManager.getActiveSession("claude");

      expect(activeSession?.id).toBe(session.id);
    });

    it("does not overwrite a corrupted storage file", () => {
      const storagePath = join(testDir, "sessions.json");
      const corrupt = "{ invalid json";
      require("fs").writeFileSync(storagePath, corrupt, "utf-8");

      const newManager = new FileSessionManager(storagePath);
      // Safe legacy reads do not invent state, while every mutation remains
      // blocked until an operator replaces the invalid file.
      expect(newManager.listSessions()).toEqual([]);
      expect(() => newManager.createSession("claude")).toThrow(FileSessionStorageFaultError);
      expect(readFileSync(storagePath, "utf-8")).toBe(corrupt);
    });

    it("faults valid JSON with missing session state without overwriting it", () => {
      const storagePath = join(testDir, "sessions.json");
      const invalidState = JSON.stringify({ activeSession: {} });
      require("fs").writeFileSync(storagePath, invalidState, "utf-8");

      const newManager = new FileSessionManager(storagePath);
      expect(() => newManager.getPinnedKitReleaseIds()).toThrow(FileSessionStorageFaultError);
      expect(readFileSync(storagePath, "utf-8")).toBe(invalidState);
    });

    it("should persist metadata", () => {
      const session = sessionManager.createSession("claude");
      sessionManager.updateSessionMetadata(session.id, { test: "data" });
      const storagePath = join(testDir, "sessions.json");

      const newManager = new FileSessionManager(storagePath);
      const loaded = newManager.getSession(session.id);

      expect(loaded?.metadata).toEqual({ test: "data" });
    });
  });

  describe("edge cases", () => {
    it("should handle session IDs with special characters", () => {
      const specialId = "session-with-dashes_underscores.dots";
      const session = sessionManager.createSession("claude", "Special ID", specialId);

      expect(session.id).toBe(specialId);
      expect(sessionManager.getSession(specialId)).toBeDefined();
    });

    it("should handle empty description", () => {
      const session = sessionManager.createSession("claude", "");
      expect(session.description).toBe("");
    });

    it("should handle undefined description", () => {
      const session = sessionManager.createSession("claude");
      expect(session.description).toBe("Claude Session");
    });

    it("should handle very long descriptions", () => {
      const longDescription = "a".repeat(10000);
      const session = sessionManager.createSession("claude", longDescription);

      expect(session.description).toBe(longDescription);
    });

    it("should handle rapid session creation", () => {
      const sessions = [];
      for (let i = 0; i < 100; i++) {
        sessions.push(sessionManager.createSession("claude", `Session ${i}`));
      }

      expect(sessionManager.listSessions("claude")).toHaveLength(100);
      expect(new Set(sessions.map(s => s.id)).size).toBe(100); // All unique IDs
    });

    it("should maintain data integrity after multiple operations", () => {
      // Create sessions
      const session1 = sessionManager.createSession("claude", "Session 1");
      const session2 = sessionManager.createSession("codex", "Session 2");
      const session3 = sessionManager.createSession("gemini", "Session 3");

      // Set active sessions
      sessionManager.setActiveSession("claude", session1.id);
      sessionManager.setActiveSession("codex", session2.id);

      // Update metadata
      sessionManager.updateSessionMetadata(session1.id, { count: 1 });

      // Delete one
      sessionManager.deleteSession(session3.id);

      // Verify integrity
      expect(sessionManager.listSessions()).toHaveLength(2);
      expect(sessionManager.getActiveSession("claude")?.id).toBe(session1.id);
      expect(sessionManager.getActiveSession("codex")?.id).toBe(session2.id);
      expect(sessionManager.getActiveSession("gemini")).toBeNull();
      expect(sessionManager.getSession(session1.id)?.metadata?.count).toBe(1);
    });
  });

  describe("concurrent access", () => {
    it("should handle concurrent session creation", async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        Promise.resolve(sessionManager.createSession("claude", `Session ${i}`))
      );

      const sessions = await Promise.all(promises);
      expect(sessions).toHaveLength(10);
      expect(new Set(sessions.map(s => s.id)).size).toBe(10); // All unique
    });

    it("should handle concurrent reads and writes", async () => {
      const session = sessionManager.createSession("claude");

      const operations = [
        () => sessionManager.getSession(session.id),
        () => sessionManager.updateSessionUsage(session.id),
        () => sessionManager.listSessions("claude"),
        () => sessionManager.updateSessionMetadata(session.id, { test: "value" }),
      ];

      await Promise.all(operations.map(op => Promise.resolve(op())));

      // Should not throw and data should be consistent
      const retrieved = sessionManager.getSession(session.id);
      expect(retrieved).toBeDefined();
    });
  });

  describe("timestamps", () => {
    it("should set createdAt and lastUsedAt on creation", () => {
      const before = new Date().toISOString();
      const session = sessionManager.createSession("claude");
      const after = new Date().toISOString();

      expect(session.createdAt).toBeDefined();
      expect(session.lastUsedAt).toBeDefined();
      expect(session.createdAt >= before).toBe(true);
      expect(session.createdAt <= after).toBe(true);
    });

    it("should update lastUsedAt but not createdAt", async () => {
      // Pre-fix bug: this test used `setTimeout(...)` without awaiting it, so
      // the assertions never ran AND the timer fired after `afterEach` had
      // removed the tmpdir — `updateSessionUsage` → `saveStorage` then threw
      // an unhandled ENOENT, which CI vitest correctly treats as a failed
      // run. Also: `session` is the same object reference held inside the
      // SessionManager's storage map, so `session.lastUsedAt` would mutate
      // when `updateSessionUsage` ran — snapshot the original string here.
      const session = sessionManager.createSession("claude");
      const originalCreated = session.createdAt;
      const originalLastUsed = session.lastUsedAt;

      // Wait long enough for `lastUsedAt` to differ from the creation
      // timestamp (millisecond resolution).
      await new Promise(resolve => setTimeout(resolve, 10));
      sessionManager.updateSessionUsage(session.id);
      const updated = sessionManager.getSession(session.id);

      expect(updated?.createdAt).toBe(originalCreated);
      expect(updated?.lastUsedAt).not.toBe(originalLastUsed);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// U21 / Layer 9: Phase-0 parity fixes
// ──────────────────────────────────────────────────────────────────────────────
//
// These tests pin the two pre-existing bugs the capability-gap audit found:
// (1) session_create/session_list/session_clear_all Zod enums omitted "grok"
//     even though the storage layer supports it.
// (2) prepareGeminiRequest passed the prompt as a positional argument; the
//     CLI's TTY/mode-detection heuristics make this fragile.
import { SESSION_PROVIDER_VALUES, SESSION_PROVIDER_ENUM, prepareGeminiRequest } from "../index.js";

describe("U22 session-provider enum (Layer 10)", () => {
  it("includes all providers, with grok-api distinct from the Grok CLI", () => {
    expect(SESSION_PROVIDER_VALUES).toEqual([
      "claude",
      "codex",
      "gemini",
      "grok",
      "mistral",
      "devin",
      "cursor",
      "grok-api",
    ]);
  });

  it("accepts grok as a valid cli value", () => {
    const parsed = SESSION_PROVIDER_ENUM.safeParse("grok");
    expect(parsed.success).toBe(true);
  });

  it("accepts mistral as a valid cli value", () => {
    const parsed = SESSION_PROVIDER_ENUM.safeParse("mistral");
    expect(parsed.success).toBe(true);
  });

  it("accepts known providers and rejects unknown providers", () => {
    for (const provider of SESSION_PROVIDER_VALUES) {
      expect(SESSION_PROVIDER_ENUM.safeParse(provider).success).toBe(true);
    }
    expect(SESSION_PROVIDER_ENUM.safeParse("openai").success).toBe(false);
    expect(SESSION_PROVIDER_ENUM.safeParse("").success).toBe(false);
  });
});

describe("U21 prepareGeminiRequest agy args ordering (Layer 9)", () => {
  function baseParams() {
    return {
      prompt: "hello world",
      approvalStrategy: "legacy" as const,
      optimizePrompt: false,
      operation: "gemini_request",
    };
  }

  it("emits --print as the first arg, with the prompt immediately after", () => {
    const prep = prepareGeminiRequest(baseParams());
    // prep is either CliRequestPrep with .args, or an ExtendedToolResponse on
    // approval denial. The legacy path with no MCP-managed approval cannot
    // produce a denial response, so .args must be present.
    expect("args" in prep).toBe(true);
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args[0]).toBe("--print");
    expect(prep.args[1]).toBe("hello world");
  });

  it("places --print prompt before other supported agy flags", () => {
    const prep = prepareGeminiRequest({
      ...baseParams(),
      model: "flash",
      approvalMode: "yolo",
      includeDirs: ["/tmp"],
      sandbox: true,
    });
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args[0]).toBe("--print");
    expect(prep.args[1]).toBe("hello world");
    // The remainder must include the flags, but none of them must precede --print.
    const remainder = prep.args.slice(2);
    expect(remainder).toContain("--model");
    expect(remainder).toContain("--add-dir");
    expect(remainder).toContain("--sandbox");
    expect(remainder).toContain("--dangerously-skip-permissions");
    // Prompt itself must not appear positionally anywhere later.
    expect(remainder).not.toContain("hello world");
  });

  it("never emits the prompt as a positional first argument", () => {
    const prep = prepareGeminiRequest(baseParams());
    if (!("args" in prep)) throw new Error("expected args");
    // The first arg must be the --print flag, NOT the prompt itself.
    expect(prep.args[0]).not.toBe("hello world");
    expect(prep.args[0]).toBe("--print");
  });
});

describe("remoteSafeSession + callerIsRemote", () => {
  const baseSession: Session = {
    id: "gw-1",
    cli: "claude",
    createdAt: "2026-07-01T00:00:00.000Z",
    lastUsedAt: "2026-07-01T00:00:00.000Z",
    metadata: {
      model: "opus",
      workspaceAlias: "gateway",
      workspaceRoot: "/home/operator/src/prod",
      worktreePath: "/home/operator/src/prod/.worktrees/abc123",
      worktreeOwnerHostname: "developer-workstation",
      worktreeOwnerInstanceId: "gateway-instance-uuid",
      worktreeCleanupPending: true,
      worktreeCleanupPendingDeletion: true,
    },
  };

  it("strips internal worktree ownership, strips workspaceRoot, and reduces worktreePath", () => {
    const safe = remoteSafeSession(baseSession);
    expect(safe.metadata?.workspaceRoot).toBeUndefined();
    expect(safe.metadata?.worktreePath).toBe(join(".worktrees", "abc123"));
    expect(safe.metadata?.worktreeOwnerHostname).toBeUndefined();
    expect(safe.metadata?.worktreeOwnerInstanceId).toBeUndefined();
    expect(safe.metadata?.worktreeCleanupPending).toBeUndefined();
    expect(safe.metadata?.worktreeCleanupPendingDeletion).toBeUndefined();
    expect(safe.metadata?.workspaceAlias).toBe("gateway");
    expect(safe.metadata?.model).toBe("opus");
    // No absolute operator path anywhere in the projection.
    const blob = JSON.stringify(safe);
    expect(blob).not.toContain("/home/operator");
    // The original session object is not mutated.
    expect(baseSession.metadata?.workspaceRoot).toBe("/home/operator/src/prod");
    expect(baseSession.metadata?.worktreeOwnerHostname).toBe("developer-workstation");
    expect(baseSession.metadata?.worktreeOwnerInstanceId).toBe("gateway-instance-uuid");
  });

  it("strips internal worktree ownership from the local public projection", () => {
    const safe = publicSafeSession(baseSession);
    expect(safe.metadata?.worktreeOwnerHostname).toBeUndefined();
    expect(safe.metadata?.worktreeOwnerInstanceId).toBeUndefined();
    expect(safe.metadata?.worktreeCleanupPending).toBeUndefined();
    expect(safe.metadata?.worktreeCleanupPendingDeletion).toBeUndefined();
    expect(safe.metadata?.workspaceRoot).toBe("/home/operator/src/prod");
    expect(safe.metadata?.worktreePath).toBe("/home/operator/src/prod/.worktrees/abc123");
  });

  // BLOCKER 1 (security): the nested `metadata.acp` block leaks the operator's
  // absolute local cwd and the provider-owned ACP session id to remote callers
  // via `session_get` / `sessions://*`. remoteSafeSession must sanitize them in
  // the caller-facing projection while STORAGE keeps the full values (resume
  // needs them). Mutation that flips this red: removing the nested-acp
  // sanitization block from remoteSafeSession (the leak returns).
  it("sanitizes nested metadata.acp (cwd/worktreePath reduced, provider sessionId removed)", () => {
    const acpSession: Session = {
      id: "gw-acp-1",
      cli: "grok",
      createdAt: "2026-07-01T00:00:00.000Z",
      lastUsedAt: "2026-07-01T00:00:00.000Z",
      metadata: {
        workspaceRoot: "/home/operator/src/prod",
        acp: {
          provider: "grok",
          transport: "acp",
          sessionId: "prov-sess-9f3c-owned-by-provider",
          cwd: "/home/operator/src/prod/checkout",
          worktreePath: "/home/operator/src/prod/.worktrees/abc123",
          createdAt: "2026-07-01T00:00:00.000Z",
          lastSeenAt: "2026-07-01T00:00:00.000Z",
        },
      },
    };

    const safe = remoteSafeSession(acpSession);
    const acp = safe.metadata?.acp as Record<string, unknown>;
    // Provider-owned ACP session id is gone from the projection.
    expect(acp.sessionId).toBeUndefined();
    // Absolute local paths are reduced to workspace-relative labels.
    expect(acp.cwd).toBe("checkout");
    expect(acp.worktreePath).toBe(join(".worktrees", "abc123"));
    // No absolute operator path or provider session id anywhere in the blob.
    const blob = JSON.stringify(safe);
    expect(blob).not.toContain("/home/operator");
    expect(blob).not.toContain("prov-sess-9f3c-owned-by-provider");

    // STORAGE (the input session) is untouched, so resume still works.
    const storedAcp = acpSession.metadata?.acp as Record<string, unknown>;
    expect(storedAcp.sessionId).toBe("prov-sess-9f3c-owned-by-provider");
    expect(storedAcp.cwd).toBe("/home/operator/src/prod/checkout");
    expect(storedAcp.worktreePath).toBe("/home/operator/src/prod/.worktrees/abc123");
  });

  it("returns the session unchanged when there is no metadata", () => {
    const s: Session = { id: "x", cli: "codex", createdAt: "t", lastUsedAt: "t" };
    expect(remoteSafeSession(s)).toBe(s);
  });

  it("callerIsRemote reflects the ambient request transport", () => {
    expect(callerIsRemote()).toBe(false);
    const remote = runWithRequestContext({ authKind: "oauth", authScopes: [] }, () =>
      callerIsRemote()
    );
    expect(remote).toBe(true);
    const httpRemote = runWithRequestContext({ transport: "http", authScopes: [] }, () =>
      callerIsRemote()
    );
    expect(httpRemote).toBe(true);
  });
});
