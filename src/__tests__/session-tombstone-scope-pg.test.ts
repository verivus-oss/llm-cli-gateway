import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { PostgreSQLSessionManager, deleteOrStageSessionsSql } from "../session-manager-pg.js";
import { sessionGenerationIdentity, type Session } from "../session-manager.js";
import type { KitExecutionRef, KitSessionBinding } from "../personal-config-types.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error - the structural gate is a plain script, deliberately untyped
import { guardedMethods } from "../../scripts/check-session-tombstone-scope.mjs";
import { runWithRequestContext } from "../request-context.js";
import { cleanTestDatabase, setupTestDatabase, setupTestStorageDriver } from "./setup.js";

/**
 * A worktree-cleanup tombstone is a DELETED session whose row survives only so
 * the host owning its git worktree can retry the removal. Every caller-facing
 * operation must therefore report it absent.
 *
 * The SET of operations is derived from the module, not listed here:
 * `guardedMethods` reads the same file the structural gate reads and reports
 * every method fenced by either mechanism, the spliced predicate or the shared
 * delete-or-stage builder. The last case asserts the two agree, so a newly
 * fenced method that nothing here drives fails instead of shipping unexercised.
 */
const GUARDED_METHODS: string[] = guardedMethods(readFileSync("src/session-manager-pg.ts", "utf8"));

const execution = (overrides: Partial<KitExecutionRef> = {}): KitExecutionRef => ({
  version: 1,
  releaseId: "release-tombstone",
  configStamp: "stamp-tombstone",
  scopeRoot: "/workspace/tombstone",
  scopeHead: "head-tombstone",
  contextIdentity: "context-tombstone",
  ...overrides,
});

const NATIVE_ID = "55555555-5555-4555-8555-555555555555";
const binding = (overrides: Partial<KitSessionBinding> = {}): KitSessionBinding => ({
  execution: execution(),
  nativeSessionId: NATIVE_ID,
  resumeEligible: true,
  ...overrides,
});

const OWNER_HOST = "tombstone-owner.invalid";

describe("PostgreSQL sessions hide worktree-cleanup tombstones", () => {
  let manager: PostgreSQLSessionManager;
  /** Which manager methods a case actually drove, checked against the module. */
  const covered = new Set<string>();
  const drive = async <T>(method: string, run: () => Promise<T>): Promise<T> => {
    covered.add(method);
    return await run();
  };

  let pool: Awaited<ReturnType<typeof setupTestDatabase>>["pool"];

  beforeEach(async () => {
    await cleanTestDatabase();
    ({ pool } = await setupTestDatabase());
    manager = new PostgreSQLSessionManager(await setupTestStorageDriver());
  });

  /**
   * Seed a tombstone the way the runtime will once deletion stages one: the
   * worktree ownership metadata plus the pending-deletion flag. Written before
   * the row is a tombstone, because afterwards `updateSessionMetadata` refuses
   * it, which is itself one of the properties under test.
   */
  const tombstone = async (session: Session): Promise<Session> => {
    expect(
      await manager.updateSessionMetadata(session.id, {
        worktreePath: "/tmp/worktree-tombstone",
        worktreeName: "wt-tombstone",
        worktreeOwnerHostname: OWNER_HOST,
        worktreeOwnerInstanceId: "instance-tombstone",
        worktreeCleanupPending: true,
        worktreeCleanupPendingDeletion: true,
      })
    ).toBe(true);
    const listed = await manager.listPendingWorktreeCleanupSessions(OWNER_HOST);
    expect(listed.map(row => row.id)).toContain(session.id);
    return listed.find(row => row.id === session.id)!;
  };

  const survives = async (id: string): Promise<void> => {
    const listed = await manager.listPendingWorktreeCleanupSessions(OWNER_HOST);
    expect(listed.map(row => row.id)).toContain(id);
  };

  it("reports a tombstone absent from every plain read", async () => {
    const session = await manager.createSession("claude", "plain");
    await manager.setActiveSession("claude", session.id);
    await tombstone(session);

    expect(await drive("getSession", () => manager.getSession(session.id))).toBeNull();
    expect(await drive("listSessions", () => manager.listSessions())).toEqual([]);
    expect(await manager.listSessions("claude")).toEqual([]);
    // Indirect: the active pointer still names the row, and the guard that
    // hides it lives in the getSession this delegates to.
    expect(await manager.getActiveSession("claude")).toBeNull();
    await survives(session.id);
  });

  it("refuses every plain mutation of a tombstone", async () => {
    const session = await manager.createSession("claude", "mutations");
    const stored = await tombstone(session);

    expect(await drive("updateSessionUsage", () => manager.updateSessionUsage(session.id))).toBe(
      false
    );
    expect(
      await drive("updateSessionMetadata", () =>
        manager.updateSessionMetadata(session.id, { workspaceAlias: "repo" })
      )
    ).toBe(false);
    expect(
      await drive("setActiveSession", () => manager.setActiveSession("claude", session.id))
    ).toBe(false);
    expect(await drive("deleteSession", () => manager.deleteSession(session.id))).toBe(false);
    expect(await drive("clearAllSessions", () => manager.clearAllSessions())).toBe(0);

    const identity = sessionGenerationIdentity(stored);
    expect(
      await drive("compareAndSetSession", () =>
        manager.compareAndSetSession(identity, {
          kind: "replace_metadata",
          expectedMetadata: stored.metadata,
          metadata: { ...stored.metadata, workspaceAlias: "repo" },
        })
      )
    ).toBe(false);
    expect(
      await manager.compareAndSetSession(identity, {
        kind: "delete",
        expectedMetadata: stored.metadata,
      })
    ).toBe(false);

    await survives(session.id);
  });

  it("refuses every Kit operation on a tombstone", async () => {
    const kitBinding = binding();
    const session = await manager.createKitSession("claude", kitBinding);
    const scopeRoot = kitBinding.execution.scopeRoot;
    const stored = await tombstone(session);
    expect(stored.metadata?.kit).toBeDefined();

    expect(
      await drive("claimKitSessionAttempt", () =>
        manager.claimKitSessionAttempt("claude", scopeRoot, kitBinding.execution, session.id, {
          id: "attempt-tombstone",
          kind: "durable",
          acquiredAt: new Date(Date.now() - 1_000).toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          expectedNativeSessionId: NATIVE_ID,
        })
      )
    ).toBe(false);
    expect(
      await drive("renewKitSessionAttempt", () =>
        manager.renewKitSessionAttempt(
          "claude",
          scopeRoot,
          kitBinding.execution,
          session.id,
          "attempt-tombstone",
          new Date(Date.now() + 120_000).toISOString()
        )
      )
    ).toBe(false);
    expect(
      await drive("releaseKitSessionAttempt", () =>
        manager.releaseKitSessionAttempt(
          "claude",
          scopeRoot,
          kitBinding.execution,
          session.id,
          "attempt-tombstone"
        )
      )
    ).toBe(false);
    expect(
      await drive("updateKitSessionBinding", () =>
        manager.updateKitSessionBinding(session.id, { ...kitBinding, resumeEligible: false })
      )
    ).toBe(false);
    expect(
      await drive("setActiveKitSession", () =>
        manager.setActiveKitSession("claude", scopeRoot, session.id, kitBinding.execution)
      )
    ).toBe(false);
    expect(
      await drive("clearActiveKitSessionIfCurrent", () =>
        manager.clearActiveKitSessionIfCurrent(
          "claude",
          scopeRoot,
          kitBinding.execution,
          session.id
        )
      )
    ).toBe(false);
    expect(await manager.getActiveKitSession("claude", scopeRoot, kitBinding.execution)).toBeNull();

    await survives(session.id);
  });

  it("refuses to hand a tombstoned id back as a live Kit session", async () => {
    const kitBinding = binding();
    const session = await manager.createKitSession("claude", kitBinding);
    await tombstone(session);

    // The probe that finds this row is deliberately unfiltered, because the
    // tombstone still holds the primary key. Refused by name, so a caller sees
    // why rather than a key violation from the INSERT below it.
    await expect(
      drive("getOrCreateKitSession", () =>
        manager.getOrCreateKitSession("claude", kitBinding, "reuse", session.id)
      )
    ).rejects.toThrow(/awaiting worktree cleanup/);
    await survives(session.id);
  });

  it("leaves a live session untouched by all of the above", async () => {
    // The negative half. Every refusal above must come from the tombstone and
    // not from the fixture, so the same calls succeed on an ordinary row.
    const session = await manager.createSession("claude", "live");
    expect(await manager.getSession(session.id)).not.toBeNull();
    expect(await manager.listSessions()).toHaveLength(1);
    expect(await manager.updateSessionUsage(session.id)).toBe(true);
    expect(await manager.updateSessionMetadata(session.id, { workspaceAlias: "repo" })).toBe(true);
    expect(await manager.setActiveSession("claude", session.id)).toBe(true);
    expect(await manager.deleteSession(session.id)).toBe(true);
  });

  it("stages a worktree-bearing session on every deletion path, and deletes the rest", async () => {
    const staged: string[] = [];
    for (const [label, remove] of [
      ["deleteSession", (id: string) => manager.deleteSession(id)],
      ["clearAllSessions", () => manager.clearAllSessions("claude").then(count => count === 1)],
      [
        "compareAndSetSession",
        async (id: string) => {
          const row = (await manager.getSession(id))!;
          return await manager.compareAndSetSession(sessionGenerationIdentity(row), {
            kind: "delete",
            expectedMetadata: row.metadata,
          });
        },
      ],
    ] as Array<[string, (id: string) => Promise<boolean>]>) {
      const owned = await manager.createSession("claude", `owned via ${label}`);
      await manager.updateSessionMetadata(owned.id, {
        worktreePath: `/tmp/worktree-${label}`,
        worktreeName: `wt-${label}`,
        worktreeOwnerHostname: OWNER_HOST,
        worktreeOwnerInstanceId: `instance-${label}`,
      });
      expect(await remove(owned.id)).toBe(true);
      expect(await manager.getSession(owned.id)).toBeNull();
      staged.push(owned.id);

      const plain = await manager.createSession("claude", `plain via ${label}`);
      expect(await remove(plain.id)).toBe(true);
      expect(await manager.getSession(plain.id)).toBeNull();
      // Deleted outright, so it is not a retry record and never becomes one.
      expect(
        (await manager.listPendingWorktreeCleanupSessions(OWNER_HOST)).map(row => row.id)
      ).not.toContain(plain.id);
    }
    expect(
      (await manager.listPendingWorktreeCleanupSessions(OWNER_HOST)).map(row => row.id).sort()
    ).toEqual([...staged].sort());
  });

  it("stages only on all four ownership fields, never on a partial record", async () => {
    // The classification is the whole hazard: stage too eagerly and an ordinary
    // deletion silently stops deleting.
    const partial = await manager.createSession("claude", "partial");
    await manager.updateSessionMetadata(partial.id, {
      worktreePath: "/tmp/worktree-partial",
      worktreeName: "wt-partial",
      worktreeOwnerHostname: OWNER_HOST,
      // no worktreeOwnerInstanceId
    });
    expect(await manager.deleteSession(partial.id)).toBe(true);
    expect(await manager.listPendingWorktreeCleanupSessions(OWNER_HOST)).toEqual([]);

    const wrongType = await manager.createSession("claude", "wrong type");
    await manager.updateSessionMetadata(wrongType.id, {
      worktreePath: "/tmp/worktree-typed",
      worktreeName: "wt-typed",
      worktreeOwnerHostname: OWNER_HOST,
      worktreeOwnerInstanceId: 7,
    });
    expect(await manager.deleteSession(wrongType.id)).toBe(true);
    expect(await manager.listPendingWorktreeCleanupSessions(OWNER_HOST)).toEqual([]);
  });

  it("clears the pointer tables it would otherwise leave aimed at a tombstone", async () => {
    // `active_sessions` and `kit_active_sessions` cascade on DELETE. A staged
    // row is not deleted, so without an explicit clear the tombstone stays the
    // active session for its provider and the active Kit pointer for its scope,
    // both naming a row every caller-facing read reports absent.
    const kitBinding = binding();
    const session = await manager.createKitSession("claude", kitBinding);
    await manager.setActiveSession("claude", session.id);
    await manager.updateSessionMetadata(session.id, {
      worktreePath: "/tmp/worktree-pointers",
      worktreeName: "wt-pointers",
      worktreeOwnerHostname: OWNER_HOST,
      worktreeOwnerInstanceId: "instance-pointers",
    });
    const pointing = async (table: string): Promise<number> =>
      Number(
        (
          await pool.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE session_id = $1`, [
            session.id,
          ])
        ).rows[0].n
      );
    expect(await pointing("active_sessions")).toBe(1);
    expect(await pointing("kit_active_sessions")).toBe(1);

    expect(await manager.deleteSession(session.id)).toBe(true);
    await survives(session.id);
    expect(await pointing("active_sessions")).toBe(0);
    expect(await pointing("kit_active_sessions")).toBe(0);
  });

  it("keeps the Kit attempt and principal fences that guard deletion", async () => {
    const kitBinding = binding();
    const held = await manager.createKitSession("claude", kitBinding);
    await manager.updateSessionMetadata(held.id, {
      worktreePath: "/tmp/worktree-held",
      worktreeName: "wt-held",
      worktreeOwnerHostname: OWNER_HOST,
      worktreeOwnerInstanceId: "instance-held",
    });
    expect(
      await manager.claimKitSessionAttempt(
        "claude",
        kitBinding.execution.scopeRoot,
        kitBinding.execution,
        held.id,
        {
          id: "attempt-held",
          kind: "durable",
          acquiredAt: new Date(Date.now() - 1_000).toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          expectedNativeSessionId: NATIVE_ID,
        }
      )
    ).toBe(true);
    // Refused outright: a held attempt is neither deleted nor staged, so the
    // new arm cannot become a way around the fence.
    expect(await manager.deleteSession(held.id)).toBe(false);
    expect(await manager.clearAllSessions("claude")).toBe(0);
    expect(await manager.getSession(held.id)).not.toBeNull();
    expect(await manager.listPendingWorktreeCleanupSessions(OWNER_HOST)).toEqual([]);

    const owned = await runWithRequestContext(
      { transport: "http", authScopes: [], authPrincipal: "owner-a" },
      () => manager.createSession("claude", "principal fence", "principal-fenced")
    );
    await runWithRequestContext(
      { transport: "http", authScopes: [], authPrincipal: "owner-a" },
      () =>
        manager.updateSessionMetadata(owned.id, {
          worktreePath: "/tmp/worktree-principal",
          worktreeName: "wt-principal",
          worktreeOwnerHostname: OWNER_HOST,
          worktreeOwnerInstanceId: "instance-principal",
        })
    );
    expect(
      await runWithRequestContext(
        { transport: "http", authScopes: [], authPrincipal: "owner-b" },
        () => manager.deleteSession(owned.id)
      )
    ).toBe(false);
    expect(await manager.listPendingWorktreeCleanupSessions(OWNER_HOST)).toEqual([]);
  });

  describe("database-side expiry", () => {
    const age = async (id: string, days: number): Promise<void> => {
      await pool.query(
        `UPDATE sessions SET last_used_at = NOW() - INTERVAL '1 day' * $2 WHERE id = $1`,
        [id, days]
      );
    };
    const owned = async (label: string): Promise<Session> => {
      const session = await manager.createSession("claude", label);
      await manager.updateSessionMetadata(session.id, {
        worktreePath: `/tmp/worktree-${label}`,
        worktreeName: `wt-${label}`,
        worktreeOwnerHostname: OWNER_HOST,
        worktreeOwnerInstanceId: `instance-${label}`,
      });
      return session;
    };
    const sweep = async (): Promise<number> => {
      // `createSession` claims the per-provider active pointer for the first
      // session of that provider, and expiry deliberately skips a pinned one.
      // Without this the fixture, not the function, decides what expires.
      await manager.setActiveSession("claude", null);
      return Number((await pool.query("SELECT cleanup_expired_sessions(30) AS n")).rows[0].n);
    };

    it("stages a worktree-bearing expired session and deletes the rest", async () => {
      const withWorktree = await owned("expiry");
      const plain = await manager.createSession("claude", "plain expiry");
      const fresh = await manager.createSession("claude", "fresh");
      await age(withWorktree.id, 60);
      await age(plain.id, 60);

      // Both stopped being live sessions, and the count says so; only one of
      // them stopped existing.
      expect(await sweep()).toBe(2);
      expect(await manager.getSession(withWorktree.id)).toBeNull();
      expect(await manager.getSession(plain.id)).toBeNull();
      expect(await manager.getSession(fresh.id)).not.toBeNull();

      const pending = await manager.listPendingWorktreeCleanupSessions(OWNER_HOST);
      expect(pending.map(row => row.id)).toEqual([withWorktree.id]);
      expect(pending[0]!.metadata?.worktreeOwnerInstanceId).toBe("instance-expiry");
      // The row is GONE, not tombstoned: expiry must not invent a retry record
      // for a session that owns no filesystem.
      expect(
        Number(
          (await pool.query("SELECT COUNT(*)::int AS n FROM sessions WHERE id = $1", [plain.id]))
            .rows[0].n
        )
      ).toBe(0);
    });

    it("does not re-stage or re-count an existing tombstone", async () => {
      const session = await owned("restage");
      await age(session.id, 60);
      expect(await sweep()).toBe(1);
      // Still expired, still a tombstone, and the second sweep must find
      // nothing: re-staging would notify nobody and make the count lie.
      await age(session.id, 60);
      expect(await sweep()).toBe(0);
      expect(
        (await manager.listPendingWorktreeCleanupSessions(OWNER_HOST)).map(row => row.id)
      ).toEqual([session.id]);
    });

    it("deleted the row outright before migration 026", async () => {
      // The control, run against the previous definition rather than inferred
      // from it. Restored from the migration file itself so the two cannot
      // drift apart.
      const legacy = readFileSync("migrations/009_personal_config_kit_session_cleanup.sql", "utf8");
      const current = readFileSync("migrations/026_worktree_cleanup_on_session_expiry.sql", "utf8");
      const session = await owned("legacy");
      await age(session.id, 60);
      try {
        await pool.query(legacy);
        expect(await sweep()).toBe(1);
        expect(await manager.listPendingWorktreeCleanupSessions(OWNER_HOST)).toEqual([]);
        expect(
          Number(
            (
              await pool.query("SELECT COUNT(*)::int AS n FROM sessions WHERE id = $1", [
                session.id,
              ])
            ).rows[0].n
          )
        ).toBe(0);
      } finally {
        await pool.query(current);
      }
    });
  });

  it("reports a rejected removal observer instead of discarding it", async () => {
    // The rejection used to go into an empty catch. A failed worktree removal
    // is exactly the case the tombstone is retained for, so an operator was
    // left with a retry record and nothing saying why the first try failed.
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const logged = new PostgreSQLSessionManager(await setupTestStorageDriver(), logger);
    const failure = new Error("worktree removal failed");
    const seen: Array<Promise<void>> = [];
    logged.addSessionRemovalObserver(() => {
      const rejected = Promise.reject(failure);
      seen.push(rejected.catch(() => undefined));
      return rejected;
    });
    const session = await logged.createSession("claude", "observer rejects");
    expect(await logged.deleteSession(session.id)).toBe(true);
    await Promise.all(seen);
    await new Promise(resolve => setImmediate(resolve));

    expect(logger.error).toHaveBeenCalledWith(
      `session removal observer rejected for ${session.id}`,
      failure
    );
    // The id and the error, and nothing else: metadata carries worktree paths
    // and Kit identities that this line has no business widening.
    expect(logger.error.mock.calls).toHaveLength(1);
  });

  it("refuses a deletion predicate that would re-stage an existing tombstone", () => {
    // Executed on the production path, not only in the structural gate, because
    // this builder is the single place all three deletion paths pass through.
    expect(() => deleteOrStageSessionsSql("id = $1")).toThrow(/must exclude worktree-cleanup/);
    expect(() =>
      deleteOrStageSessionsSql("id = $1 AND metadata->>'worktreeCleanupPendingDeletion' IS NULL")
    ).not.toThrow();
  });

  it("covers every method the module guards", () => {
    // Derived from the tree on both sides. A guarded statement added to a
    // method nothing here drives turns this red, which is the whole point: a
    // predicate no test exercises is a predicate nobody has seen work.
    expect([...covered].sort()).toEqual([...GUARDED_METHODS].sort());
    expect(GUARDED_METHODS).toHaveLength(15);
  });
});
