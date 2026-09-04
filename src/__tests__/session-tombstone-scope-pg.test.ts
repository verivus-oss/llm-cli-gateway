import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { PostgreSQLSessionManager, deleteOrStageSessionsSql } from "../session-manager-pg.js";
import {
  sessionGenerationIdentity,
  sessionNotTombstonedSql,
  type Session,
} from "../session-manager.js";
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
    // Every field individually, not just the last one. The first version of
    // this omitted `worktreeOwnerInstanceId` only, so three of the four
    // conjuncts could be deleted from the classification with the whole suite
    // still green: it pinned one field and read as if it pinned four.
    const fields = [
      "worktreePath",
      "worktreeName",
      "worktreeOwnerHostname",
      "worktreeOwnerInstanceId",
    ] as const;
    const complete = (label: string): Record<string, unknown> => ({
      worktreePath: `/tmp/worktree-${label}`,
      worktreeName: `wt-${label}`,
      worktreeOwnerHostname: OWNER_HOST,
      worktreeOwnerInstanceId: `instance-${label}`,
    });

    // Assert the ROW is gone, not that the tombstone list omits it. The list
    // filters on `worktreeOwnerHostname`, so a record missing that field is
    // invisible to it whether or not it was staged, and the first version of
    // this control passed against a mutant that staged it.
    const rowExists = async (id: string): Promise<boolean> =>
      Number(
        (
          await pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM sessions WHERE id = $1", [
            id,
          ])
        ).rows[0]!.n
      ) > 0;

    for (const missing of fields) {
      const session = await manager.createSession("claude", `missing ${missing}`);
      const metadata = complete(missing);
      delete metadata[missing];
      await manager.updateSessionMetadata(session.id, metadata);
      expect(await manager.deleteSession(session.id)).toBe(true);
      expect(
        await rowExists(session.id),
        `a record missing ${missing} owns no worktree and must be deleted outright`
      ).toBe(false);
    }

    // A JSON number is not a JSON string, and the classification says so
    // rather than accepting anything non-null.
    for (const wrongTyped of fields) {
      const session = await manager.createSession("claude", `typed ${wrongTyped}`);
      await manager.updateSessionMetadata(session.id, {
        ...complete(wrongTyped),
        [wrongTyped]: 7,
      });
      expect(await manager.deleteSession(session.id)).toBe(true);
      expect(
        await rowExists(session.id),
        `a non-string ${wrongTyped} must not be read as ownership`
      ).toBe(false);
    }

    // And the complete record still stages, so the refusals above come from the
    // missing field rather than from staging having stopped working.
    const owned = await manager.createSession("claude", "complete");
    await manager.updateSessionMetadata(owned.id, complete("complete"));
    expect(await manager.deleteSession(owned.id)).toBe(true);
    expect(
      (await manager.listPendingWorktreeCleanupSessions(OWNER_HOST)).map(row => row.id)
    ).toEqual([owned.id]);
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
    // Apply the SHIPPED migration file before every case. Without this the
    // cases exercise whatever definition the fixture already holds, so editing
    // `migrations/026_*.sql` and running the suite proved nothing: the file was
    // not the thing under test.
    beforeEach(async () => {
      await pool.query(
        readFileSync("migrations/026_worktree_cleanup_on_session_expiry.sql", "utf8")
      );
    });

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

    it("preserves every exclusion migration 009 already had", async () => {
      // Each fixture is pinned by exactly ONE exclusion, so a deleted arm
      // cannot be covered by another. All of these were individually removable
      // from 026 with the whole suite green, because nothing built a row they
      // protected.
      const pinnedActive = await manager.createSession("codex", "pinned by active pointer");
      await manager.setActiveSession("codex", pinnedActive.id);

      const pointerExecution = execution({ contextIdentity: "kit-pointer" });
      const kitPinned = await manager.createKitSession(
        "claude",
        binding({ execution: pointerExecution, resumeEligible: false })
      );

      const heldExecution = execution({ contextIdentity: "held" });
      const held = await manager.createKitSession(
        "claude",
        binding({ execution: heldExecution, resumeEligible: false })
      );
      expect(
        await manager.claimKitSessionAttempt(
          "claude",
          heldExecution.scopeRoot,
          heldExecution,
          held.id,
          {
            id: "attempt-expiry",
            kind: "durable",
            acquiredAt: new Date(Date.now() - 1_000).toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            expectedNativeSessionId: NATIVE_ID,
          }
        )
      ).toBe(true);
      await manager.setActiveKitSession("claude", heldExecution.scopeRoot, null, heldExecution);

      const ordinary = await manager.createSession("claude", "ordinary");
      for (const id of [pinnedActive.id, kitPinned.id, held.id, ordinary.id]) {
        await age(id, 60);
      }

      expect(await sweep()).toBe(1);
      expect(await manager.getSession(ordinary.id)).toBeNull();
      for (const [label, id] of [
        ["active pointer", pinnedActive.id],
        ["kit active pointer", kitPinned.id],
        ["held attempt", held.id],
      ] as Array<[string, string]>) {
        expect(await manager.getSession(id), `${label} must pin the session`).not.toBeNull();
      }
      expect(await manager.listPendingWorktreeCleanupSessions(OWNER_HOST)).toEqual([]);
    });

    it("still honours resumeEligible, which no gateway write path can set", async () => {
      // NOT reachable through the API, and this test says so rather than
      // implying coverage it does not have. `cloneKitSessionBinding` pins
      // `resumeEligible` to false on every durable write, and
      // `ensureKitPointerSchema`'s privacy repair rewrites any row where it is
      // not false. The arm is therefore inert against gateway-written rows; it
      // can only ever protect one an import or an operator produced. The row is
      // seeded directly because that is the only state in which the predicate
      // means anything.
      const session = await manager.createSession("claude", "seeded resumable");
      await pool.query(
        `UPDATE sessions
            SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{kit}', $2::jsonb, true)
          WHERE id = $1`,
        [
          session.id,
          JSON.stringify({
            execution: execution({ contextIdentity: "seeded" }),
            nativeSessionId: null,
            resumeEligible: true,
          }),
        ]
      );
      await age(session.id, 60);
      expect(await sweep()).toBe(0);
      expect(await manager.getSession(session.id)).not.toBeNull();
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

  it("keeps tombstones out of the operator-facing session_summary view", async () => {
    // Nothing in the gateway reads this view, so it is not a runtime leak. It
    // is what an operator sees when they inspect the database directly, and it
    // listed deleted sessions as live with `is_active` computed for them.
    await pool.query(
      readFileSync("migrations/027_session_summary_excludes_tombstones.sql", "utf8")
    );
    const live = await manager.createSession("claude", "live for the view");
    const doomed = await manager.createSession("claude", "tombstoned for the view");
    await manager.updateSessionMetadata(doomed.id, {
      worktreePath: "/tmp/worktree-view",
      worktreeName: "wt-view",
      worktreeOwnerHostname: OWNER_HOST,
      worktreeOwnerInstanceId: "instance-view",
    });
    expect(await manager.deleteSession(doomed.id)).toBe(true);
    await survives(doomed.id);

    const rows = await pool.query<{ id: string }>("SELECT id FROM session_summary");
    expect(rows.rows.map(row => row.id)).toContain(live.id);
    expect(rows.rows.map(row => row.id)).not.toContain(doomed.id);
    // The row is still there for cleanup retry; only the view hides it.
    expect(
      Number(
        (
          await pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM sessions WHERE id = $1", [
            doomed.id,
          ])
        ).rows[0]!.n
      )
    ).toBe(1);
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

  it("splices the tombstone exclusion whatever the caller passes", () => {
    // The builder used to REQUIRE the caller's predicate to mention the
    // tombstone key, which proved a substring rather than a row exclusion. Each
    // predicate below satisfied that check and excluded nothing; one of them
    // re-staged the very tombstones it claimed to skip. The exclusion is now
    // the builder's, so none of them can express a deletion that sees one.
    const bypasses = [
      "id = $1",
      "id = $1 AND 'worktreeCleanupPendingDeletion' <> 'unused'",
      "id = $1 OR metadata->>'worktreeCleanupPendingDeletion' IS NOT NULL",
    ];
    for (const predicate of bypasses) {
      const sql = deleteOrStageSessionsSql(predicate);
      expect(sql).toContain(`WHERE (${predicate})`);
      // Three times: once in the classification, and once in each arm, where
      // the caller's text cannot reach it.
      expect(sql.split(sessionNotTombstonedSql()).length - 1).toBe(3);
    }
  });

  it("refuses a predicate that could terminate the expression it is spliced into", () => {
    // `id = $1) OR true --` closes the wrapper, ORs, and comments out both the
    // closing parenthesis and the conjunct after it. A reviewer got a tombstone
    // back that way on a real server.
    expect(() => deleteOrStageSessionsSql("id = $1) OR true --")).toThrow(
      /unbalanced parentheses|SQL comment/
    );
    expect(() => deleteOrStageSessionsSql("id = $1 -- comment")).toThrow(/SQL comment/);
    expect(() => deleteOrStageSessionsSql("id = $1 /* comment */")).toThrow(/SQL comment/);
    expect(() => deleteOrStageSessionsSql("id = $1)")).toThrow(/unbalanced parentheses/);
    expect(() => deleteOrStageSessionsSql("(id = $1 OR cli = $2)")).not.toThrow();
  });

  it("never lets a caller predicate reach a tombstone, against the real server", async () => {
    // The behavioural half of the case above: the bypass that used to re-stage
    // a tombstone now returns nothing, on a real PostgreSQL.
    const session = await manager.createSession("claude", "or-bypass");
    const stored = await tombstone(session);
    const rows = await pool.query(
      deleteOrStageSessionsSql(
        `id = $1 OR metadata->>'worktreeCleanupPendingDeletion' IS NOT NULL`
      ).replace(/\?/g, "$1"),
      [stored.id]
    );
    expect(rows.rows).toEqual([]);
    await survives(session.id);
  });

  it("keeps the exclusion in the arms when the classification is defeated", async () => {
    // The classification CTE is built from caller text and can in principle be
    // subverted; the arms are entirely the builder's. Simulating the worst case
    // by removing the classification's own exclusion, the arms must still
    // refuse to touch a tombstone.
    const session = await manager.createSession("claude", "arms hold");
    const stored = await tombstone(session);
    const defeated = deleteOrStageSessionsSql("id = $1").replace(
      `WHERE (id = $1)
               AND ${sessionNotTombstonedSql()}`,
      "WHERE (id = $1)"
    );
    expect(defeated).not.toContain(`WHERE (id = $1)
               AND ${sessionNotTombstonedSql()}`);
    expect(defeated.split(sessionNotTombstonedSql()).length - 1).toBe(2);
    const rows = await pool.query(defeated, [stored.id]);
    expect(rows.rows).toEqual([]);
    await survives(session.id);
  });

  it("serialises two concurrent deletions of the same session", async () => {
    // `FOR UPDATE` on the classification CTE is what makes the second deletion
    // re-read the row after the first commits. Without it both statements
    // classify the same pre-deletion snapshot and both stage, which is a second
    // observer notification for a removal that already happened.
    const session = await manager.createSession("claude", "concurrent delete");
    await manager.updateSessionMetadata(session.id, {
      worktreePath: "/tmp/worktree-concurrent",
      worktreeName: "wt-concurrent",
      worktreeOwnerHostname: OWNER_HOST,
      worktreeOwnerInstanceId: "instance-concurrent",
    });
    const statement = deleteOrStageSessionsSql("id = $1");

    const first = await pool.connect();
    const second = await pool.connect();
    const observer = await pool.connect();
    try {
      await first.query("BEGIN");
      const firstRows = await first.query(statement, [session.id]);
      expect(firstRows.rows).toHaveLength(1);

      await second.query("BEGIN");
      const secondPid = Number(
        (await second.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid
      );
      const blocked = second.query(statement, [session.id]);

      // A BARRIER, not a dispatch order. The first version of this control
      // committed as soon as the second query had been handed to the driver,
      // which usually happened before PostgreSQL had even taken the second
      // statement's snapshot, so it passed with FOR UPDATE removed. Wait for
      // the server itself to report the second backend blocked on a lock.
      let waiting = false;
      for (let attempt = 0; attempt < 400 && !waiting; attempt += 1) {
        const blockers = await observer.query<{ blocked: boolean }>(
          "SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked",
          [secondPid]
        );
        waiting = blockers.rows[0]?.blocked === true;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(true);

      await first.query("COMMIT");
      const secondRows = await blocked;
      await second.query("COMMIT");

      // Re-read after the commit, so the row it classifies is the tombstone the
      // first deletion produced and the exclusion applies to it.
      expect(secondRows.rows).toEqual([]);
    } finally {
      first.release();
      second.release();
      observer.release();
    }

    const pending = await manager.listPendingWorktreeCleanupSessions(OWNER_HOST);
    expect(pending.map(row => row.id)).toEqual([session.id]);
  });

  describe("finalization fences", () => {
    const seeded = async (label: string): Promise<Session> => {
      const session = await manager.createSession("claude", label);
      await manager.updateSessionMetadata(session.id, {
        worktreePath: `/tmp/worktree-${label}`,
        worktreeName: `wt-${label}`,
        worktreeOwnerHostname: OWNER_HOST,
        worktreeOwnerInstanceId: `instance-${label}`,
      });
      expect(await manager.deleteSession(session.id)).toBe(true);
      return (await manager.listPendingWorktreeCleanupSessions(OWNER_HOST)).find(
        row => row.id === session.id
      )!;
    };

    // Every clause of the DELETE that acknowledges a verified removal. Each is
    // what stops a late acknowledgement from removing a row that is no longer
    // the one it verified, and each was individually replaceable by a tautology
    // with the whole suite still green.
    it("refuses an acknowledgement carrying a different session id", async () => {
      const mine = await seeded("fence-id-a");
      const theirs = await seeded("fence-id-b");
      expect(await manager.finalizePendingWorktreeCleanup({ ...mine, id: theirs.id })).toBe(false);
      expect(
        (await manager.listPendingWorktreeCleanupSessions(OWNER_HOST)).map(row => row.id).sort()
      ).toEqual([mine.id, theirs.id].sort());
    });

    it("refuses an acknowledgement carrying a stale generation", async () => {
      const tomb = await seeded("fence-generation");
      expect(
        await manager.finalizePendingWorktreeCleanup({
          ...tomb,
          generation: "11111111-1111-4111-8111-111111111111",
        })
      ).toBe(false);
      await survives(tomb.id);
      expect(await manager.finalizePendingWorktreeCleanup(tomb)).toBe(true);
    });

    it("refuses to finalize a row that is not a tombstone", async () => {
      const live = await manager.createSession("claude", "still live");
      await manager.updateSessionMetadata(live.id, {
        worktreeOwnerHostname: OWNER_HOST,
      });
      const stored = (await manager.getSession(live.id))!;
      expect(await manager.finalizePendingWorktreeCleanup(stored)).toBe(false);
      expect(await manager.getSession(live.id)).not.toBeNull();
    });
  });

  it("covers every method the module guards", () => {
    // Derived from the tree on both sides. A guarded statement added to a
    // method nothing here drives turns this red, which is the whole point: a
    // predicate no test exercises is a predicate nobody has seen work.
    expect([...covered].sort()).toEqual([...GUARDED_METHODS].sort());
    expect(GUARDED_METHODS).toHaveLength(15);
  });
});
