import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgreSQLSessionManager } from "../session-manager-pg.js";
import type {
  KitExecutionRef,
  KitSessionAttempt,
  KitSessionBinding,
} from "../personal-config-types.js";
import { runWithRequestContext } from "../request-context.js";
import { kitActiveSessionKey } from "../session-manager.js";
import { cleanTestDatabase, setupTestDatabase } from "./setup.js";

function execution(overrides: Partial<KitExecutionRef> = {}): KitExecutionRef {
  return {
    version: 1,
    releaseId: "release-pg-a",
    configStamp: "stamp-pg-a",
    scopeRoot: "/workspace/pg-a",
    scopeHead: "head-pg-a",
    contextIdentity: "context-pg-a",
    ...overrides,
  };
}

function binding(overrides: Partial<KitSessionBinding> = {}): KitSessionBinding {
  return {
    execution: execution(),
    nativeSessionId: "44444444-4444-4444-8444-444444444444",
    resumeEligible: true,
    ...overrides,
  };
}

function attempt(overrides: Partial<KitSessionAttempt> = {}): KitSessionAttempt {
  const now = Date.now();
  return {
    id: "attempt-pg-a",
    kind: "durable",
    acquiredAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    expectedNativeSessionId: "44444444-4444-4444-8444-444444444444",
    ...overrides,
  };
}

function requestContext(principal: string) {
  return {
    transport: "http" as const,
    authKind: "oauth" as const,
    authScopes: [],
    authPrincipal: principal,
  };
}

function schemaScopedDsn(schema: string): string {
  const dsn = new URL(
    process.env.TEST_DATABASE_URL || "postgresql://test:test@localhost:5433/llm_gateway_test"
  );
  dsn.searchParams.set("options", `-c search_path=${schema},public`);
  return dsn.toString();
}

function temporarySchemaName(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

describe("PostgreSQL Personal Agent Config Kit session persistence", () => {
  let manager: PostgreSQLSessionManager;
  let pool: Pool;

  beforeEach(async () => {
    await cleanTestDatabase();
    ({ pool } = await setupTestDatabase());
    manager = new PostgreSQLSessionManager(pool);
  });

  it("preflights the exact Kit relation resolved through search_path", async () => {
    const schema = temporarySchemaName("kit_preflight_path");
    await pool.query(`CREATE SCHEMA ${schema}`);
    const scopedPool = new Pool({ connectionString: schemaScopedDsn(schema) });
    const scopedManager = new PostgreSQLSessionManager(scopedPool);
    try {
      // The first search-path schema deliberately has no Kit table. The
      // unqualified runtime relation resolves to public.kit_active_sessions.
      // The preflight must inspect that same relation rather than querying
      // information_schema for current_schema().
      await expect(
        scopedManager.getActiveKitSession("claude", "/workspace/pg-a", execution())
      ).resolves.toBeNull();
    } finally {
      await scopedPool.end();
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    }
  });

  it("fails before a Kit mutation when the pointer migration is incomplete", async () => {
    const schema = temporarySchemaName("kit_preflight_incomplete");
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(
      `CREATE TABLE ${schema}.kit_active_sessions (
        cli VARCHAR(32) NOT NULL,
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL
      )`
    );
    const scopedPool = new Pool({ connectionString: schemaScopedDsn(schema) });
    const scopedManager = new PostgreSQLSessionManager(scopedPool);
    try {
      await expect(
        scopedManager.importKitSession("claude", binding(), undefined, "incomplete-kit-session")
      ).rejects.toThrow(/PostgreSQL schema is incomplete/);
      const row = await scopedPool.query("SELECT id FROM sessions WHERE id = $1", [
        "incomplete-kit-session",
      ]);
      expect(row.rows).toEqual([]);
    } finally {
      await scopedPool.end();
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    }
  });

  it("persists scoped active pointers and preserves valid old pointers on stamp mismatch", async () => {
    const firstBinding = binding();
    const secondBinding = binding({
      execution: execution({
        releaseId: "release-pg-b",
        configStamp: "stamp-pg-b",
        scopeRoot: "/workspace/pg-b",
        scopeHead: "head-pg-b",
        contextIdentity: "context-pg-b",
      }),
      nativeSessionId: "55555555-5555-4555-8555-555555555555",
    });
    const first = await manager.createKitSession("codex", firstBinding);
    const second = await manager.createKitSession("codex", secondBinding);

    expect(
      (await manager.getActiveKitSession("codex", "/workspace/pg-a", firstBinding.execution))?.id
    ).toBe(first.id);
    expect(
      (await manager.getActiveKitSession("codex", "/workspace/pg-b", secondBinding.execution))?.id
    ).toBe(second.id);
    expect(
      await manager.getActiveKitSession("codex", "/workspace/pg-a", secondBinding.execution)
    ).toBeNull();
    expect(
      (await manager.getActiveKitSession("codex", "/workspace/pg-a", firstBinding.execution))?.id
    ).toBe(first.id);
    expect(await manager.getPinnedKitReleaseIds()).toEqual([]);
  });

  it("does not allow an existing Kit session to be rebound to a different stamp", async () => {
    const initial = binding();
    const session = await manager.createKitSession("claude", initial);
    const moved = binding({
      execution: execution({ configStamp: "stamp-pg-moved", contextIdentity: "context-pg-moved" }),
    });

    expect(await manager.updateKitSessionBinding(session.id, moved)).toBe(false);
    expect((await manager.getSession(session.id))?.metadata?.kit?.execution.configStamp).toBe(
      "stamp-pg-a"
    );
  });

  it("atomically get-or-creates exact execution and principal pointers", async () => {
    const firstBinding = binding();
    const concurrent = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        manager.getOrCreateKitSession("codex", firstBinding, undefined, `candidate-pg-${index}`)
      )
    );
    expect(new Set(concurrent.map(session => session.id))).toHaveLength(1);

    const sameScopeDifferentExecution = binding({
      execution: execution({ scopeHead: "head-pg-b", contextIdentity: "context-pg-b" }),
      nativeSessionId: "55555555-5555-4555-8555-555555555555",
    });
    const second = await manager.getOrCreateKitSession("codex", sameScopeDifferentExecution);
    expect(second.id).not.toBe(concurrent[0].id);
    expect(
      (await manager.getActiveKitSession("codex", "/workspace/pg-a", firstBinding.execution))?.id
    ).toBe(concurrent[0].id);
    expect(
      (
        await manager.getActiveKitSession(
          "codex",
          "/workspace/pg-a",
          sameScopeDifferentExecution.execution
        )
      )?.id
    ).toBe(second.id);

    const alice = await runWithRequestContext(requestContext("alice"), () =>
      manager.getOrCreateKitSession("codex", firstBinding)
    );
    const bob = await runWithRequestContext(requestContext("bob"), () =>
      manager.getOrCreateKitSession("codex", firstBinding)
    );
    expect(alice.id).not.toBe(bob.id);
  });

  it("serializes get-or-create with a concurrent forced Kit creation", async () => {
    const sharedBinding = binding({
      execution: execution({ contextIdentity: "context-pg-mixed-writer" }),
      nativeSessionId: null,
      resumeEligible: false,
    });
    const [resolved, forced] = await Promise.all([
      manager.getOrCreateKitSession("codex", sharedBinding, undefined, "get-or-create-candidate"),
      manager.createKitSession("codex", sharedBinding, undefined, "forced-new-candidate"),
    ]);

    const active = await manager.getActiveKitSession(
      "codex",
      sharedBinding.execution.scopeRoot,
      sharedBinding.execution
    );
    // If force-new won the lock, get-or-create joins it. If get-or-create won,
    // force-new remains deliberately unpointed. In either case it cannot
    // overwrite the resolver's returned active session or raise a PK race.
    expect(active?.id).toBe(resolved.id);
    expect([resolved.id, forced.id]).toContain(active?.id);
  });

  it("conditionally clears only the current exact Kit pointer", async () => {
    const targetBinding = binding();
    const target = await manager.createKitSession("claude", targetBinding);
    const unpointed = await manager.createKitSession("claude", targetBinding);
    const differentExecution = execution({ contextIdentity: "context-pg-different" });

    expect(
      await manager.clearActiveKitSessionIfCurrent(
        "claude",
        "/workspace/pg-a",
        targetBinding.execution,
        unpointed.id
      )
    ).toBe(false);
    expect(
      await manager.clearActiveKitSessionIfCurrent(
        "claude",
        "/workspace/pg-a",
        differentExecution,
        target.id
      )
    ).toBe(false);
    expect(
      (await manager.getActiveKitSession("claude", "/workspace/pg-a", targetBinding.execution))?.id
    ).toBe(target.id);
    expect(
      await manager.clearActiveKitSessionIfCurrent(
        "claude",
        "/workspace/pg-a",
        targetBinding.execution,
        target.id
      )
    ).toBe(true);
    expect(
      await manager.getActiveKitSession("claude", "/workspace/pg-a", targetBinding.execution)
    ).toBeNull();

    const alice = await runWithRequestContext(requestContext("alice"), () =>
      manager.createKitSession("claude", targetBinding)
    );
    expect(
      await runWithRequestContext(requestContext("bob"), () =>
        manager.clearActiveKitSessionIfCurrent(
          "claude",
          "/workspace/pg-a",
          targetBinding.execution,
          alice.id
        )
      )
    ).toBe(false);
    expect(
      (
        await runWithRequestContext(requestContext("alice"), () =>
          manager.getActiveKitSession("claude", "/workspace/pg-a", targetBinding.execution)
        )
      )?.id
    ).toBe(alice.id);
  });

  it("keeps legacy-unowned Kit pointers local-only", async () => {
    const legacyBinding = binding();
    const legacy = await manager.createKitSession("claude", legacyBinding);
    await pool.query("UPDATE sessions SET owner_principal = NULL WHERE id = $1", [legacy.id]);
    await pool.query(
      `INSERT INTO kit_active_sessions (cli, scope_key, session_id, updated_at)
       VALUES ($1, $2, $3, $4)`,
      [
        "claude",
        kitActiveSessionKey(
          legacyBinding.execution.scopeRoot,
          legacyBinding.execution,
          "remote-user"
        ),
        legacy.id,
        new Date().toISOString(),
      ]
    );

    expect(
      await runWithRequestContext(requestContext("remote-user"), () =>
        manager.getActiveKitSession(
          "claude",
          legacyBinding.execution.scopeRoot,
          legacyBinding.execution
        )
      )
    ).toBeNull();
    expect(
      await runWithRequestContext(requestContext("remote-user"), () =>
        manager.setActiveKitSession(
          "claude",
          legacyBinding.execution.scopeRoot,
          legacy.id,
          legacyBinding.execution
        )
      )
    ).toBe(false);
    expect(
      (
        await manager.getActiveKitSession(
          "claude",
          legacyBinding.execution.scopeRoot,
          legacyBinding.execution
        )
      )?.id
    ).toBe(legacy.id);
  });

  it("continues a held legacy-unowned local Kit attempt without allocating a second session", async () => {
    const legacyBinding = binding({ resumeEligible: false });
    const legacy = await manager.createKitSession("claude", legacyBinding);
    const heldAttempt = attempt({ id: "legacy-local-pg-held-attempt" });
    expect(
      await manager.claimKitSessionAttempt(
        "claude",
        legacyBinding.execution.scopeRoot,
        legacyBinding.execution,
        legacy.id,
        heldAttempt
      )
    ).toBe(true);
    await pool.query("UPDATE sessions SET owner_principal = NULL WHERE id = $1", [legacy.id]);

    const resolved = await manager.getOrCreateKitSession("claude", legacyBinding);
    expect(resolved.id).toBe(legacy.id);
    expect(resolved.metadata?.kit?.attempt?.id).toBe(heldAttempt.id);
    const sessions = await pool.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM sessions WHERE metadata ? 'kit'"
    );
    expect(sessions.rows[0]?.count).toBe(1);

    expect(
      await runWithRequestContext(requestContext("remote-user"), () =>
        manager.renewKitSessionAttempt(
          "claude",
          legacyBinding.execution.scopeRoot,
          legacyBinding.execution,
          legacy.id,
          heldAttempt.id,
          new Date(Date.now() + 120_000).toISOString()
        )
      )
    ).toBe(false);
    expect(
      await manager.renewKitSessionAttempt(
        "claude",
        legacyBinding.execution.scopeRoot,
        legacyBinding.execution,
        legacy.id,
        heldAttempt.id,
        new Date(Date.now() + 120_000).toISOString()
      )
    ).toBe(true);
    expect(
      await manager.releaseKitSessionAttempt(
        "claude",
        legacyBinding.execution.scopeRoot,
        legacyBinding.execution,
        legacy.id,
        heldAttempt.id
      )
    ).toBe(true);

    const terminalAttempt = attempt({ id: "legacy-local-pg-terminal-attempt" });
    expect(
      await manager.claimKitSessionAttempt(
        "claude",
        legacyBinding.execution.scopeRoot,
        legacyBinding.execution,
        legacy.id,
        terminalAttempt
      )
    ).toBe(true);
    const terminalBinding = binding({
      execution: legacyBinding.execution,
      nativeSessionId: "66666666-6666-4666-8666-666666666666",
      resumeEligible: false,
    });
    expect(
      await manager.updateKitSessionBinding(legacy.id, terminalBinding, terminalAttempt.id)
    ).toBe(true);
    expect(
      await manager.clearActiveKitSessionIfCurrent(
        "claude",
        legacyBinding.execution.scopeRoot,
        legacyBinding.execution,
        legacy.id
      )
    ).toBe(true);
    const owner = await pool.query<{ ownerPrincipal: string | null }>(
      'SELECT owner_principal AS "ownerPrincipal" FROM sessions WHERE id = $1',
      [legacy.id]
    );
    expect(owner.rows[0]?.ownerPrincipal).toBeNull();
  });

  it("atomically leases exact bindings and requires the matching terminal holder", async () => {
    const leaseBinding = binding({ resumeEligible: false });
    const session = await manager.createKitSession("claude", leaseBinding);
    const firstAttempt = attempt({ id: "attempt-pg-first" });
    const secondAttempt = attempt({ id: "attempt-pg-second" });
    const claims = await Promise.all([
      manager.claimKitSessionAttempt(
        "claude",
        leaseBinding.execution.scopeRoot,
        leaseBinding.execution,
        session.id,
        firstAttempt
      ),
      manager.claimKitSessionAttempt(
        "claude",
        leaseBinding.execution.scopeRoot,
        leaseBinding.execution,
        session.id,
        secondAttempt
      ),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const heldAttempt = claims[0] ? firstAttempt : secondAttempt;

    expect(await manager.getPinnedKitReleaseIds()).toEqual(["release-pg-a"]);
    expect(
      await runWithRequestContext(requestContext("other-principal"), () =>
        manager.releaseKitSessionAttempt(
          "claude",
          leaseBinding.execution.scopeRoot,
          leaseBinding.execution,
          session.id,
          heldAttempt.id
        )
      )
    ).toBe(false);
    const terminalBinding = binding({
      execution: leaseBinding.execution,
      nativeSessionId: "66666666-6666-4666-8666-666666666666",
      resumeEligible: false,
    });
    expect(await manager.updateSessionMetadata(session.id, { kit: terminalBinding })).toBe(false);
    expect(await manager.updateKitSessionBinding(session.id, terminalBinding)).toBe(false);
    expect(
      await manager.updateKitSessionBinding(session.id, terminalBinding, "stale-attempt")
    ).toBe(false);
    expect((await manager.getSession(session.id))?.metadata?.kit?.attempt?.id).toBe(heldAttempt.id);
    expect(
      await manager.renewKitSessionAttempt(
        "claude",
        leaseBinding.execution.scopeRoot,
        leaseBinding.execution,
        session.id,
        heldAttempt.id,
        new Date(Date.now() + 120_000).toISOString()
      )
    ).toBe(true);
    expect(await manager.updateKitSessionBinding(session.id, terminalBinding, heldAttempt.id)).toBe(
      true
    );
    expect((await manager.getSession(session.id))?.metadata?.kit?.attempt).toBeUndefined();
    expect(await manager.getPinnedKitReleaseIds()).toEqual([]);
  });

  it("retires native handles from retained terminal bindings", async () => {
    const leaseBinding = binding({ resumeEligible: false });
    const session = await manager.createKitSession("claude", leaseBinding);
    const heldAttempt = attempt({ id: "retained-pg-terminal-attempt" });
    expect(
      await manager.claimKitSessionAttempt(
        "claude",
        leaseBinding.execution.scopeRoot,
        leaseBinding.execution,
        session.id,
        heldAttempt
      )
    ).toBe(true);

    const terminalNativeId = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
    const retainedTerminalBinding = binding({
      execution: leaseBinding.execution,
      nativeSessionId: terminalNativeId,
      resumeEligible: true,
      attempt: { ...heldAttempt, expectedNativeSessionId: terminalNativeId },
    });
    expect(
      await manager.updateKitSessionBinding(session.id, retainedTerminalBinding, heldAttempt.id)
    ).toBe(true);
    expect(
      await manager.updateKitSessionBinding(session.id, retainedTerminalBinding, heldAttempt.id)
    ).toBe(true);
    const persisted = await pool.query<{ metadata: { kit?: KitSessionBinding } }>(
      "SELECT metadata FROM sessions WHERE id = $1",
      [session.id]
    );
    expect(persisted.rows[0]?.metadata.kit?.nativeSessionId).toBeNull();
    expect(persisted.rows[0]?.metadata.kit?.resumeEligible).toBe(false);
    expect(persisted.rows[0]?.metadata.kit?.attempt?.expectedNativeSessionId).toBeNull();
    expect(JSON.stringify(persisted.rows)).not.toContain(terminalNativeId);
    expect(
      await manager.releaseKitSessionAttempt(
        "claude",
        leaseBinding.execution.scopeRoot,
        leaseBinding.execution,
        session.id,
        heldAttempt.id
      )
    ).toBe(true);
  });

  it("does not replace an expired durable attempt without an explicit release", async () => {
    const expiredBinding = binding({
      execution: execution({ contextIdentity: "expired-pg-attempt-context" }),
      nativeSessionId: null,
      resumeEligible: false,
      attempt: attempt({
        id: "expired-pg-attempt",
        acquiredAt: new Date(Date.now() - 120_000).toISOString(),
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        expectedNativeSessionId: null,
      }),
    });
    const session = await manager.createKitSession("claude", expiredBinding);
    const replacement = attempt({ id: "replacement-pg-attempt", expectedNativeSessionId: null });

    expect(
      await manager.claimKitSessionAttempt(
        "claude",
        expiredBinding.execution.scopeRoot,
        expiredBinding.execution,
        session.id,
        replacement
      )
    ).toBe(false);
    expect(await manager.getPinnedKitReleaseIds()).toEqual(["release-pg-a"]);
    expect(
      await manager.releaseKitSessionAttempt(
        "claude",
        expiredBinding.execution.scopeRoot,
        expiredBinding.execution,
        session.id,
        "expired-pg-attempt"
      )
    ).toBe(true);
    expect(
      await manager.claimKitSessionAttempt(
        "claude",
        expiredBinding.execution.scopeRoot,
        expiredBinding.execution,
        session.id,
        replacement
      )
    ).toBe(true);
  });
});
