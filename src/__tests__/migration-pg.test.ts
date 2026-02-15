import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { migrateFromFile } from "../migrate-sessions.js";
import { PostgreSQLSessionManager } from "../session-manager-pg.js";
import { FileSessionManager, SessionStorage } from "../session-manager.js";
import { setupTestDatabase, cleanTestDatabase, mockLogger } from "./setup.js";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("Session Migration", () => {
  let pgManager: PostgreSQLSessionManager;
  let testDir: string;
  let testFilePath: string;

  beforeEach(async () => {
    await cleanTestDatabase();
    const { pool, redis } = await setupTestDatabase();
    pgManager = new PostgreSQLSessionManager(pool, redis, {
      session: 3600,
      activeSession: 1800,
      sessionList: 120
    }, mockLogger);

    // Create test directory
    testDir = join(tmpdir(), `migration-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
    mkdirSync(testDir, { recursive: true });
    testFilePath = join(testDir, "sessions.json");
  });

  afterEach(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  //──────────────────────────────────────────────────────────────────────────
  // Migration Tests
  //──────────────────────────────────────────────────────────────────────────

  it("should migrate sessions from file to PostgreSQL", async () => {
    // Create file-based sessions
    const fileManager = new FileSessionManager(testFilePath);
    const session1 = fileManager.createSession("claude", "Claude Session");
    const session2 = fileManager.createSession("codex", "Codex Session");
    const session3 = fileManager.createSession("gemini", "Gemini Session");

    // Run migration
    const result = await migrateFromFile(testFilePath, pgManager);

    expect(result.migrated).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.errors).toEqual([]);

    // Verify sessions in PostgreSQL
    const sessions = await pgManager.listSessions();
    expect(sessions.length).toBe(3);

    const sessionIds = sessions.map(s => s.id);
    expect(sessionIds).toContain(session1.id);
    expect(sessionIds).toContain(session2.id);
    expect(sessionIds).toContain(session3.id);
  });

  it("should preserve session descriptions", async () => {
    const fileManager = new FileSessionManager(testFilePath);
    const session = fileManager.createSession("claude", "Custom Description");

    await migrateFromFile(testFilePath, pgManager);

    const migrated = await pgManager.getSession(session.id);
    expect(migrated?.description).toBe("Custom Description");
  });

  it("should migrate session metadata", async () => {
    const fileManager = new FileSessionManager(testFilePath);
    const session = fileManager.createSession("claude", "Session with Metadata");
    fileManager.updateSessionMetadata(session.id, {
      key1: "value1",
      key2: 42,
      nested: { foo: "bar" }
    });

    await migrateFromFile(testFilePath, pgManager);

    const migrated = await pgManager.getSession(session.id);
    expect(migrated?.metadata).toEqual({
      key1: "value1",
      key2: 42,
      nested: { foo: "bar" }
    });
  });

  it("should restore active sessions", async () => {
    const fileManager = new FileSessionManager(testFilePath);
    const claudeSession = fileManager.createSession("claude", "Active Claude");
    const codexSession = fileManager.createSession("codex", "Active Codex");

    fileManager.setActiveSession("claude", claudeSession.id);
    fileManager.setActiveSession("codex", codexSession.id);

    await migrateFromFile(testFilePath, pgManager);

    const activeClaudeSession = await pgManager.getActiveSession("claude");
    const activeCodexSession = await pgManager.getActiveSession("codex");

    expect(activeClaudeSession?.id).toBe(claudeSession.id);
    expect(activeCodexSession?.id).toBe(codexSession.id);
  });

  it("should handle empty sessions file", async () => {
    const emptyStorage: SessionStorage = {
      sessions: {},
      activeSession: { claude: null, codex: null, gemini: null }
    };
    writeFileSync(testFilePath, JSON.stringify(emptyStorage, null, 2));

    const result = await migrateFromFile(testFilePath, pgManager);

    expect(result.migrated).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("should handle large number of sessions", async () => {
    const fileManager = new FileSessionManager(testFilePath);

    // Create 100 sessions
    const sessionIds: string[] = [];
    for (let i = 0; i < 100; i++) {
      const cli = ["claude", "codex", "gemini"][i % 3] as "claude" | "codex" | "gemini";
      const session = fileManager.createSession(cli, `Session ${i}`);
      sessionIds.push(session.id);
    }

    const result = await migrateFromFile(testFilePath, pgManager);

    expect(result.migrated).toBe(100);
    expect(result.failed).toBe(0);

    const sessions = await pgManager.listSessions();
    expect(sessions.length).toBe(100);
  });

  it("should report failed migrations", async () => {
    // Create sessions with one having an invalid ID that would fail
    const fileManager = new FileSessionManager(testFilePath);
    fileManager.createSession("claude", "Valid Session");

    // Manually corrupt the file by adding a duplicate ID
    const fileData = JSON.parse(require("fs").readFileSync(testFilePath, "utf-8"));
    const firstId = Object.keys(fileData.sessions)[0];
    fileData.sessions[firstId + "-duplicate"] = {
      ...fileData.sessions[firstId],
      id: firstId // Same ID, will cause conflict
    };
    writeFileSync(testFilePath, JSON.stringify(fileData, null, 2));

    const result = await migrateFromFile(testFilePath, pgManager);

    // First session should succeed, duplicate should fail
    expect(result.migrated).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors.length).toBe(1);
  });

  it("should preserve timestamps", async () => {
    const fileManager = new FileSessionManager(testFilePath);
    const session = fileManager.createSession("claude", "Timestamped Session");

    await migrateFromFile(testFilePath, pgManager);

    const migrated = await pgManager.getSession(session.id);
    expect(migrated?.createdAt).toBeDefined();
    expect(migrated?.lastUsedAt).toBeDefined();
  });

  it("should handle sessions for all CLI types", async () => {
    const fileManager = new FileSessionManager(testFilePath);
    const claudeSession = fileManager.createSession("claude", "Claude");
    const codexSession = fileManager.createSession("codex", "Codex");
    const geminiSession = fileManager.createSession("gemini", "Gemini");

    await migrateFromFile(testFilePath, pgManager);

    const claudeSessions = await pgManager.listSessions("claude");
    const codexSessions = await pgManager.listSessions("codex");
    const geminiSessions = await pgManager.listSessions("gemini");

    expect(claudeSessions.length).toBe(1);
    expect(codexSessions.length).toBe(1);
    expect(geminiSessions.length).toBe(1);
  });

  it("should be idempotent when run twice", async () => {
    const fileManager = new FileSessionManager(testFilePath);
    fileManager.createSession("claude", "Session 1");
    fileManager.createSession("codex", "Session 2");

    // First migration
    const result1 = await migrateFromFile(testFilePath, pgManager);
    expect(result1.migrated).toBe(2);

    // Second migration (should fail due to duplicate IDs)
    const result2 = await migrateFromFile(testFilePath, pgManager);
    expect(result2.migrated).toBe(0);
    expect(result2.failed).toBe(2); // Both will fail as duplicates
  });

  //──────────────────────────────────────────────────────────────────────────
  // Error Handling
  //──────────────────────────────────────────────────────────────────────────

  it("should throw error for non-existent file", async () => {
    const nonExistentPath = join(testDir, "non-existent.json");

    await expect(migrateFromFile(nonExistentPath, pgManager)).rejects.toThrow();
  });

  it("should throw error for malformed JSON", async () => {
    writeFileSync(testFilePath, "{ invalid json ");

    await expect(migrateFromFile(testFilePath, pgManager)).rejects.toThrow();
  });

  it("should handle sessions without metadata", async () => {
    const fileManager = new FileSessionManager(testFilePath);
    const session = fileManager.createSession("claude", "No Metadata Session");

    await migrateFromFile(testFilePath, pgManager);

    const migrated = await pgManager.getSession(session.id);
    expect(migrated?.metadata).toBeUndefined();
  });
});
