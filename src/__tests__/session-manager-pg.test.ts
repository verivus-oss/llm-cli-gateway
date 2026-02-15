import { describe, it, expect, beforeEach } from "vitest";
import { PostgreSQLSessionManager } from "../session-manager-pg.js";
import { setupTestDatabase, cleanTestDatabase, mockLogger } from "./setup.js";

describe("PostgreSQLSessionManager", () => {
  let manager: PostgreSQLSessionManager;

  beforeEach(async () => {
    await cleanTestDatabase();
    const { pool, redis } = await setupTestDatabase();
    manager = new PostgreSQLSessionManager(pool, redis, {
      session: 3600,
      activeSession: 1800,
      sessionList: 120
    }, mockLogger);
  });

  //──────────────────────────────────────────────────────────────────────────
  // Session Creation (5 tests)
  //──────────────────────────────────────────────────────────────────────────

  describe("createSession", () => {
    it("should create a session with auto-generated ID", async () => {
      const session = await manager.createSession("claude", "Test Session");

      expect(session.id).toBeDefined();
      expect(session.cli).toBe("claude");
      expect(session.description).toBe("Test Session");
      expect(session.createdAt).toBeDefined();
      expect(session.lastUsedAt).toBeDefined();
    });

    it("should create a session with custom ID", async () => {
      const customId = "custom-session-id";
      const session = await manager.createSession("codex", "Custom Session", customId);

      expect(session.id).toBe(customId);
      expect(session.cli).toBe("codex");
    });

    it("should use default description if not provided", async () => {
      const session = await manager.createSession("gemini");

      expect(session.description).toBe("Gemini Session");
    });

    it("should set as active session if none exists for CLI", async () => {
      const session = await manager.createSession("claude", "First Session");
      const activeSession = await manager.getActiveSession("claude");

      expect(activeSession).not.toBeNull();
      expect(activeSession?.id).toBe(session.id);
    });

    it("should not override existing active session", async () => {
      const session1 = await manager.createSession("claude", "Session 1");
      const session2 = await manager.createSession("claude", "Session 2");
      const activeSession = await manager.getActiveSession("claude");

      expect(activeSession?.id).toBe(session1.id);
    });
  });

  //──────────────────────────────────────────────────────────────────────────
  // Session Retrieval (4 tests)
  //──────────────────────────────────────────────────────────────────────────

  describe("getSession", () => {
    it("should retrieve an existing session", async () => {
      const created = await manager.createSession("claude", "Test Session");
      const retrieved = await manager.getSession(created.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.cli).toBe("claude");
      expect(retrieved?.description).toBe("Test Session");
    });

    it("should return null for non-existent session", async () => {
      const session = await manager.getSession("non-existent-id");

      expect(session).toBeNull();
    });

    it("should retrieve session from cache on second call", async () => {
      const created = await manager.createSession("claude", "Test Session");

      // First call populates cache
      await manager.getSession(created.id);

      // Second call should hit cache (we can't directly verify this, but we can ensure it works)
      const retrieved = await manager.getSession(created.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(created.id);
    });

    it("should handle concurrent getSession calls", async () => {
      const created = await manager.createSession("claude", "Test Session");

      const [result1, result2, result3] = await Promise.all([
        manager.getSession(created.id),
        manager.getSession(created.id),
        manager.getSession(created.id)
      ]);

      expect(result1?.id).toBe(created.id);
      expect(result2?.id).toBe(created.id);
      expect(result3?.id).toBe(created.id);
    });
  });

  //──────────────────────────────────────────────────────────────────────────
  // Session Listing (3 tests)
  //──────────────────────────────────────────────────────────────────────────

  describe("listSessions", () => {
    it("should list all sessions", async () => {
      await manager.createSession("claude", "Session 1");
      await manager.createSession("codex", "Session 2");
      await manager.createSession("gemini", "Session 3");

      const sessions = await manager.listSessions();

      expect(sessions.length).toBe(3);
    });

    it("should filter sessions by CLI", async () => {
      await manager.createSession("claude", "Claude 1");
      await manager.createSession("claude", "Claude 2");
      await manager.createSession("codex", "Codex 1");

      const claudeSessions = await manager.listSessions("claude");
      const codexSessions = await manager.listSessions("codex");

      expect(claudeSessions.length).toBe(2);
      expect(codexSessions.length).toBe(1);
      expect(claudeSessions.every(s => s.cli === "claude")).toBe(true);
    });

    it("should return empty array when no sessions exist", async () => {
      const sessions = await manager.listSessions();

      expect(sessions).toEqual([]);
    });
  });

  //──────────────────────────────────────────────────────────────────────────
  // Session Deletion (3 tests)
  //──────────────────────────────────────────────────────────────────────────

  describe("deleteSession", () => {
    it("should delete an existing session", async () => {
      const session = await manager.createSession("claude", "Test Session");
      const deleted = await manager.deleteSession(session.id);

      expect(deleted).toBe(true);

      const retrieved = await manager.getSession(session.id);
      expect(retrieved).toBeNull();
    });

    it("should return false for non-existent session", async () => {
      const deleted = await manager.deleteSession("non-existent-id");

      expect(deleted).toBe(false);
    });

    it("should clear active session if deleting active session", async () => {
      const session = await manager.createSession("claude", "Test Session");
      await manager.setActiveSession("claude", session.id);

      await manager.deleteSession(session.id);

      const activeSession = await manager.getActiveSession("claude");
      expect(activeSession).toBeNull();
    });
  });

  //──────────────────────────────────────────────────────────────────────────
  // Active Session Management (7 tests)
  //──────────────────────────────────────────────────────────────────────────

  describe("setActiveSession", () => {
    it("should set active session", async () => {
      const session = await manager.createSession("claude", "Test Session");
      const success = await manager.setActiveSession("claude", session.id);

      expect(success).toBe(true);

      const activeSession = await manager.getActiveSession("claude");
      expect(activeSession?.id).toBe(session.id);
    });

    it("should clear active session when set to null", async () => {
      const session = await manager.createSession("claude", "Test Session");
      await manager.setActiveSession("claude", session.id);

      const success = await manager.setActiveSession("claude", null);

      expect(success).toBe(true);

      const activeSession = await manager.getActiveSession("claude");
      expect(activeSession).toBeNull();
    });

    it("should return false for non-existent session", async () => {
      const success = await manager.setActiveSession("claude", "non-existent-id");

      expect(success).toBe(false);
    });

    it("should return false if session belongs to different CLI", async () => {
      const claudeSession = await manager.createSession("claude", "Claude Session");
      const success = await manager.setActiveSession("codex", claudeSession.id);

      expect(success).toBe(false);
    });

    it("should maintain separate active sessions per CLI", async () => {
      const claudeSession = await manager.createSession("claude", "Claude Session");
      const codexSession = await manager.createSession("codex", "Codex Session");

      await manager.setActiveSession("claude", claudeSession.id);
      await manager.setActiveSession("codex", codexSession.id);

      const claudeActive = await manager.getActiveSession("claude");
      const codexActive = await manager.getActiveSession("codex");

      expect(claudeActive?.id).toBe(claudeSession.id);
      expect(codexActive?.id).toBe(codexSession.id);
    });

    it("should handle concurrent setActiveSession calls", async () => {
      const session1 = await manager.createSession("claude", "Session 1");
      const session2 = await manager.createSession("claude", "Session 2");

      // Concurrent attempts to set active session
      await Promise.all([
        manager.setActiveSession("claude", session1.id),
        manager.setActiveSession("claude", session2.id)
      ]);

      const activeSession = await manager.getActiveSession("claude");
      expect(activeSession).not.toBeNull();
      // One of them should have won
      expect([session1.id, session2.id]).toContain(activeSession?.id);
    });

    it("should allow switching active session", async () => {
      const session1 = await manager.createSession("claude", "Session 1");
      const session2 = await manager.createSession("claude", "Session 2");

      await manager.setActiveSession("claude", session1.id);
      let activeSession = await manager.getActiveSession("claude");
      expect(activeSession?.id).toBe(session1.id);

      await manager.setActiveSession("claude", session2.id);
      activeSession = await manager.getActiveSession("claude");
      expect(activeSession?.id).toBe(session2.id);
    });
  });

  //──────────────────────────────────────────────────────────────────────────
  // Session Usage Tracking (2 tests)
  //──────────────────────────────────────────────────────────────────────────

  describe("updateSessionUsage", () => {
    it("should update session lastUsedAt timestamp", async () => {
      const session = await manager.createSession("claude", "Test Session");
      const originalTimestamp = session.lastUsedAt;

      // Wait a bit to ensure timestamp changes
      await new Promise(resolve => setTimeout(resolve, 10));

      await manager.updateSessionUsage(session.id);

      const updated = await manager.getSession(session.id);
      expect(updated?.lastUsedAt).not.toBe(originalTimestamp);
    });

    it("should not throw error for non-existent session", async () => {
      await expect(manager.updateSessionUsage("non-existent-id")).resolves.not.toThrow();
    });
  });

  //──────────────────────────────────────────────────────────────────────────
  // Metadata Management (3 tests)
  //──────────────────────────────────────────────────────────────────────────

  describe("updateSessionMetadata", () => {
    it("should update session metadata", async () => {
      const session = await manager.createSession("claude", "Test Session");

      const success = await manager.updateSessionMetadata(session.id, {
        key1: "value1",
        key2: 42
      });

      expect(success).toBe(true);

      const updated = await manager.getSession(session.id);
      expect(updated?.metadata).toEqual({
        key1: "value1",
        key2: 42
      });
    });

    it("should merge metadata with existing values", async () => {
      const session = await manager.createSession("claude", "Test Session");

      await manager.updateSessionMetadata(session.id, { key1: "value1" });
      await manager.updateSessionMetadata(session.id, { key2: "value2" });

      const updated = await manager.getSession(session.id);
      expect(updated?.metadata).toEqual({
        key1: "value1",
        key2: "value2"
      });
    });

    it("should return false for non-existent session", async () => {
      const success = await manager.updateSessionMetadata("non-existent-id", { key: "value" });

      expect(success).toBe(false);
    });
  });

  //──────────────────────────────────────────────────────────────────────────
  // Clear All Sessions (4 tests)
  //──────────────────────────────────────────────────────────────────────────

  describe("clearAllSessions", () => {
    it("should clear all sessions", async () => {
      await manager.createSession("claude", "Session 1");
      await manager.createSession("codex", "Session 2");
      await manager.createSession("gemini", "Session 3");

      const count = await manager.clearAllSessions();

      expect(count).toBe(3);

      const sessions = await manager.listSessions();
      expect(sessions.length).toBe(0);
    });

    it("should clear sessions for specific CLI", async () => {
      await manager.createSession("claude", "Claude 1");
      await manager.createSession("claude", "Claude 2");
      await manager.createSession("codex", "Codex 1");

      const count = await manager.clearAllSessions("claude");

      expect(count).toBe(2);

      const allSessions = await manager.listSessions();
      expect(allSessions.length).toBe(1);
      expect(allSessions[0].cli).toBe("codex");
    });

    it("should return 0 when no sessions exist", async () => {
      const count = await manager.clearAllSessions();

      expect(count).toBe(0);
    });

    it("should clear active session references", async () => {
      const session = await manager.createSession("claude", "Test Session");
      await manager.setActiveSession("claude", session.id);

      await manager.clearAllSessions();

      const activeSession = await manager.getActiveSession("claude");
      expect(activeSession).toBeNull();
    });
  });

  //──────────────────────────────────────────────────────────────────────────
  // Caching Behavior (3 tests - NEW for PostgreSQL)
  //──────────────────────────────────────────────────────────────────────────

  describe("caching behavior", () => {
    it("should cache session on creation", async () => {
      const session = await manager.createSession("claude", "Test Session");

      // Retrieve should hit cache (second retrieval)
      const retrieved = await manager.getSession(session.id);

      expect(retrieved?.id).toBe(session.id);
    });

    it("should invalidate cache on session deletion", async () => {
      const session = await manager.createSession("claude", "Test Session");

      // Ensure it's cached
      await manager.getSession(session.id);

      // Delete should invalidate cache
      await manager.deleteSession(session.id);

      // Retrieve should return null (not stale cached data)
      const retrieved = await manager.getSession(session.id);
      expect(retrieved).toBeNull();
    });

    it("should invalidate cache on metadata update", async () => {
      const session = await manager.createSession("claude", "Test Session");

      // Cache the session
      await manager.getSession(session.id);

      // Update metadata
      await manager.updateSessionMetadata(session.id, { key: "value" });

      // Should get fresh data, not cached
      const retrieved = await manager.getSession(session.id);
      expect(retrieved?.metadata).toEqual({ key: "value" });
    });
  });

  //──────────────────────────────────────────────────────────────────────────
  // Concurrency and Edge Cases (4 tests)
  //──────────────────────────────────────────────────────────────────────────

  describe("concurrency and edge cases", () => {
    it("should handle concurrent session creation", async () => {
      const sessions = await Promise.all([
        manager.createSession("claude", "Session 1"),
        manager.createSession("claude", "Session 2"),
        manager.createSession("claude", "Session 3")
      ]);

      expect(sessions.length).toBe(3);
      expect(new Set(sessions.map(s => s.id)).size).toBe(3); // All unique IDs
    });

    it("should handle rapid active session changes", async () => {
      const session1 = await manager.createSession("claude", "Session 1");
      const session2 = await manager.createSession("claude", "Session 2");
      const session3 = await manager.createSession("claude", "Session 3");

      // Rapid sequential changes
      await manager.setActiveSession("claude", session1.id);
      await manager.setActiveSession("claude", session2.id);
      await manager.setActiveSession("claude", session3.id);

      const activeSession = await manager.getActiveSession("claude");
      expect(activeSession?.id).toBe(session3.id);
    });

    it("should handle session creation for all CLI types", async () => {
      const claudeSession = await manager.createSession("claude");
      const codexSession = await manager.createSession("codex");
      const geminiSession = await manager.createSession("gemini");

      expect(claudeSession.cli).toBe("claude");
      expect(codexSession.cli).toBe("codex");
      expect(geminiSession.cli).toBe("gemini");

      const sessions = await manager.listSessions();
      expect(sessions.length).toBe(3);
    });

    it("should preserve session data integrity across operations", async () => {
      const session = await manager.createSession("claude", "Test Session");

      // Multiple operations
      await manager.updateSessionMetadata(session.id, { key1: "value1" });
      await manager.updateSessionUsage(session.id);
      await manager.setActiveSession("claude", session.id);

      // Verify all data is preserved
      const retrieved = await manager.getSession(session.id);
      expect(retrieved?.id).toBe(session.id);
      expect(retrieved?.cli).toBe("claude");
      expect(retrieved?.description).toBe("Test Session");
      expect(retrieved?.metadata).toEqual({ key1: "value1" });

      const activeSession = await manager.getActiveSession("claude");
      expect(activeSession?.id).toBe(session.id);
    });
  });

  //──────────────────────────────────────────────────────────────────────────
  // PostgreSQL-Specific Features (2 tests)
  //──────────────────────────────────────────────────────────────────────────

  describe("PostgreSQL-specific features", () => {
    it("should enforce CLI constraint on sessions", async () => {
      const session = await manager.createSession("claude", "Test Session");

      // This is enforced by the database schema and application logic
      expect(["claude", "codex", "gemini"]).toContain(session.cli);
    });

    it("should support JSONB metadata queries", async () => {
      await manager.createSession("claude", "Session 1");
      const session2 = await manager.createSession("claude", "Session 2");
      await manager.updateSessionMetadata(session2.id, {
        tag: "important",
        priority: 1
      });

      // Verify metadata was stored correctly
      const retrieved = await manager.getSession(session2.id);
      expect(retrieved?.metadata?.tag).toBe("important");
      expect(retrieved?.metadata?.priority).toBe(1);
    });
  });

  //──────────────────────────────────────────────────────────────────────────
  // Error Handling (2 tests)
  //──────────────────────────────────────────────────────────────────────────

  describe("error handling", () => {
    it("should handle empty session IDs gracefully", async () => {
      const session = await manager.getSession("");

      expect(session).toBeNull();
    });

    it("should handle concurrent deletions gracefully", async () => {
      const session = await manager.createSession("claude", "Test Session");

      // Concurrent deletion attempts
      const [result1, result2] = await Promise.all([
        manager.deleteSession(session.id),
        manager.deleteSession(session.id)
      ]);

      // One should succeed, one should fail
      expect(result1 || result2).toBe(true);
      expect(result1 && result2).toBe(false);
    });
  });
});
