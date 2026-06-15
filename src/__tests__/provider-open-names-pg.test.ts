/**
 * Slice 0.5 — Postgres CHECK-constraint migration round-trip (migration 005).
 *
 * Proves the relaxed session-provider CHECK admits arbitrary `[providers.<name>]`
 * (kind:"api") ids while still rejecting malformed identifiers. Runs only under
 * PG_TESTS=1 (see vitest.config.ts / scripts/test-pg.sh).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { PostgreSQLSessionManager } from "../session-manager-pg.js";
import { setupTestDatabase, cleanTestDatabase } from "./setup.js";

describe("Slice 0.5 open API provider names (Postgres)", () => {
  let pgManager: PostgreSQLSessionManager;

  beforeEach(async () => {
    await cleanTestDatabase();
    const { pool } = await setupTestDatabase();
    pgManager = new PostgreSQLSessionManager(pool);
  });

  it("round-trips a session whose provider is an arbitrary api name", async () => {
    const session = await pgManager.createSession("ollama", "Ollama Session");
    expect(session.cli).toBe("ollama");

    const fetched = await pgManager.getSession(session.id);
    expect(fetched?.cli).toBe("ollama");

    const active = await pgManager.getActiveSession("ollama");
    expect(active?.id).toBe(session.id);

    const listed = await pgManager.listSessions("ollama");
    expect(listed.map(s => s.id)).toEqual([session.id]);
  });

  it("still accepts the registered CLI and grok-api providers", async () => {
    const claude = await pgManager.createSession("claude");
    const grokApi = await pgManager.createSession("grok-api");
    expect((await pgManager.getSession(claude.id))?.cli).toBe("claude");
    expect((await pgManager.getSession(grokApi.id))?.cli).toBe("grok-api");
  });

  it("admits other well-formed api provider ids", async () => {
    for (const name of ["openai", "vllm", "llama3.3", "self_hosted-1"]) {
      const session = await pgManager.createSession(name);
      expect((await pgManager.getSession(session.id))?.cli).toBe(name);
    }
  });

  it("still rejects malformed provider ids at the database layer", async () => {
    // Leading digit, embedded space, and empty string all violate the format
    // guard the migration installs in place of the old fixed enum.
    await expect(pgManager.createSession("9bad")).rejects.toThrow();
    await expect(pgManager.createSession("bad name")).rejects.toThrow();
    await expect(pgManager.createSession("")).rejects.toThrow();
  });
});
