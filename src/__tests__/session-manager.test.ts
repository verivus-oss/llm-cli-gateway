import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FileSessionManager } from "../session-manager.js";
import { existsSync, mkdirSync, rmSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("SessionManager", () => {
  let testDir: string;
  let sessionManager: FileSessionManager;

  beforeEach(() => {
    // Create a temporary directory for test storage
    testDir = join(tmpdir(), `session-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
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

    it("should create a session with custom ID", () => {
      const customId = "custom-session-id-123";
      const session = sessionManager.createSession("codex", "Custom ID session", customId);

      expect(session.id).toBe(customId);
      expect(session.cli).toBe("codex");
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

    it("should create sessions for different CLIs independently", () => {
      const claudeSession = sessionManager.createSession("claude");
      const codexSession = sessionManager.createSession("codex");
      const geminiSession = sessionManager.createSession("gemini");
      const grokSession = sessionManager.createSession("grok");

      expect(claudeSession.cli).toBe("claude");
      expect(codexSession.cli).toBe("codex");
      expect(geminiSession.cli).toBe("gemini");
      expect(grokSession.cli).toBe("grok");

      expect(sessionManager.getActiveSession("claude")?.id).toBe(claudeSession.id);
      expect(sessionManager.getActiveSession("codex")?.id).toBe(codexSession.id);
      expect(sessionManager.getActiveSession("gemini")?.id).toBe(geminiSession.id);
      expect(sessionManager.getActiveSession("grok")?.id).toBe(grokSession.id);
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
        count: 42
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

    it("should persist active sessions", () => {
      const session = sessionManager.createSession("claude");
      sessionManager.setActiveSession("claude", session.id);
      const storagePath = join(testDir, "sessions.json");

      const newManager = new FileSessionManager(storagePath);
      const activeSession = newManager.getActiveSession("claude");

      expect(activeSession?.id).toBe(session.id);
    });

    it("should handle corrupted storage file gracefully", () => {
      const storagePath = join(testDir, "sessions.json");

      // Write invalid JSON
      const fs = require("fs");
      fs.writeFileSync(storagePath, "{ invalid json", "utf-8");

      // Should not throw, should start fresh
      expect(() => {
        const newManager = new FileSessionManager(storagePath);
        expect(newManager.listSessions()).toEqual([]);
      }).not.toThrow();
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
        () => sessionManager.updateSessionMetadata(session.id, { test: "value" })
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

    it("should update lastUsedAt but not createdAt", () => {
      const session = sessionManager.createSession("claude");
      const originalCreated = session.createdAt;

      setTimeout(() => {
        sessionManager.updateSessionUsage(session.id);
        const updated = sessionManager.getSession(session.id);

        expect(updated?.createdAt).toBe(originalCreated);
        expect(updated?.lastUsedAt).not.toBe(session.lastUsedAt);
      }, 10);
    });
  });
});
