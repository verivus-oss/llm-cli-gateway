import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PostgreSQLSessionManager } from "../session-manager-pg.js";
import { sessionGenerationIdentity, type Session } from "../session-manager.js";
import type { KitExecutionRef, KitSessionBinding } from "../personal-config-types.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error - the structural gate is a plain script, deliberately untyped
import { sessionStatements } from "../../scripts/check-session-tombstone-scope.mjs";
import { cleanTestDatabase, setupTestDatabase, setupTestStorageDriver } from "./setup.js";

/**
 * A worktree-cleanup tombstone is a DELETED session whose row survives only so
 * the host owning its git worktree can retry the removal. Every caller-facing
 * operation must therefore report it absent.
 *
 * The SET of operations is derived from the module, not listed here: whichever
 * methods `sessionNotTombstonedSql()` appears in are the methods this file must
 * cover, and the last case asserts the two agree. A new guarded statement in an
 * uncovered method fails that assertion instead of shipping unexercised.
 */
const GUARDED_METHODS: string[] = [
  ...new Set(
    sessionStatements(readFileSync("src/session-manager-pg.ts", "utf8"))
      .filter((statement: { insertOnly: boolean; scoped: boolean }) => statement.scoped)
      .map((statement: { method: string }) => statement.method)
  ),
];

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

  beforeEach(async () => {
    await cleanTestDatabase();
    await setupTestDatabase();
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

  it("covers every method the module guards", () => {
    // Derived from the tree on both sides. A guarded statement added to a
    // method nothing here drives turns this red, which is the whole point: a
    // predicate no test exercises is a predicate nobody has seen work.
    expect([...covered].sort()).toEqual([...GUARDED_METHODS].sort());
    expect(GUARDED_METHODS).toHaveLength(15);
  });
});
