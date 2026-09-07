import { describe, it, expect, beforeEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { PROVIDER_TYPES, sessionGenerationIdentity } from "../session-manager.js";
import { PostgreSQLSessionManager } from "../session-manager-pg.js";
import {
  createGatewayServer,
  resolveGatewayServerRuntime,
  resolveWorktreeForRequest,
} from "../index.js";
import { runWithRequestContext } from "../request-context.js";
import { cleanTestDatabase, setupTestDatabase, setupTestStorageDriver } from "./setup.js";

function initGitRepository(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), "pg-session-worktree-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot, stdio: "ignore" });
  writeFileSync(join(repoRoot, "README.md"), "seed\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "seed"], { cwd: repoRoot, stdio: "ignore" });
  return repoRoot;
}

describe("PostgreSQLSessionManager", () => {
  let manager: PostgreSQLSessionManager;
  let pool: Awaited<ReturnType<typeof setupTestDatabase>>["pool"];

  beforeEach(async () => {
    await cleanTestDatabase();
    ({ pool } = await setupTestDatabase());
    manager = new PostgreSQLSessionManager(await setupTestStorageDriver());
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

    it("rejects an explicit ID collision without replacing the existing row", async () => {
      const winner = await runWithRequestContext(
        { transport: "http", authScopes: [], authPrincipal: "owner-a" },
        () => manager.createSession("claude", "winner", "shared-id")
      );
      await expect(manager.createSession("claude", "same", "shared-id")).rejects.toThrow();
      await expect(manager.createSession("codex", "different", "shared-id")).rejects.toThrow();
      await expect(
        runWithRequestContext({ transport: "http", authScopes: [], authPrincipal: "owner-b" }, () =>
          manager.createSession("claude", "different owner", "shared-id")
        )
      ).rejects.toThrow();
      expect(await manager.getSession("shared-id")).toMatchObject({
        id: winner.id,
        cli: winner.cli,
        description: winner.description,
        ownerPrincipal: winner.ownerPrincipal,
        generation: winner.generation,
      });
    });

    it("atomically creates an explicit session with its admitted metadata", async () => {
      const winner = await manager.createSessionWithMetadata(
        "claude",
        "scoped winner",
        "scoped-id",
        { workspaceAlias: "repo-a", workspaceRoot: "/workspace/a" }
      );
      await expect(
        manager.createSessionWithMetadata("claude", "loser", "scoped-id", {
          workspaceAlias: "repo-b",
          workspaceRoot: "/workspace/b",
        })
      ).rejects.toThrow();
      expect((await manager.getSession("scoped-id"))?.metadata).toEqual(winner.metadata);
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
      await manager.createSession("claude", "Session 2");
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
        manager.getSession(created.id),
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
    it("stages a tombstone before notifying, and hands the observer that exact row", async () => {
      // The observer used to be the only place a failed removal could have been
      // recorded, and it could not: the row was already gone, so its own
      // retention write returned false. The store retains it now, and the two
      // assertions on the observer's view are kept to show that has NOT been
      // achieved by making a deleted session visible again.
      const observed: Array<{
        session: Awaited<ReturnType<typeof manager.createSession>>;
        rowAfterDelete: Promise<Awaited<ReturnType<typeof manager.getSession>>>;
        retentionAfterDelete: Promise<boolean>;
      }> = [];
      const unsubscribe = manager.addSessionRemovalObserver(session => {
        const rowAfterDelete = manager.getSession(session.id);
        const retentionAfterDelete = rowAfterDelete.then(() =>
          manager.updateSessionMetadata(session.id, { workspaceAlias: "observer" })
        );
        observed.push({ session, rowAfterDelete, retentionAfterDelete });
        return retentionAfterDelete.then(() => undefined);
      });
      const deleted = await manager.createSession("claude", "Observer delete");
      const cleared = await manager.createSession("codex", "Observer clear");
      for (const session of [deleted, cleared]) {
        await manager.updateSessionMetadata(session.id, {
          worktreePath: `/tmp/${session.id}`,
          worktreeName: session.id,
          worktreeOwnerHostname: hostname(),
          worktreeOwnerInstanceId: "pg-test-owner",
        });
      }

      expect(await manager.deleteSession("missing-session")).toBe(false);
      expect(observed).toEqual([]);
      expect(await manager.deleteSession(deleted.id)).toBe(true);
      expect(observed.map(item => item.session.id)).toEqual([deleted.id]);
      // The row handed to the observer already carries the tombstone, which is
      // what tells it to acknowledge the removal rather than assume it.
      expect(observed[0]!.session.metadata?.worktreeCleanupPendingDeletion).toBe(true);
      expect(observed[0]!.session.metadata?.worktreeOwnerHostname).toBe(hostname());
      expect(await observed[0]!.rowAfterDelete).toBeNull();
      expect(await observed[0]!.retentionAfterDelete).toBe(false);
      expect(await manager.getSession(deleted.id)).toBeNull();

      expect(await manager.clearAllSessions("codex")).toBe(1);
      expect(observed.map(item => item.session.id)).toEqual([deleted.id, cleared.id]);
      expect(observed[1]!.session.metadata?.worktreeCleanupPendingDeletion).toBe(true);
      expect(await observed[1]!.rowAfterDelete).toBeNull();
      expect(await observed[1]!.retentionAfterDelete).toBe(false);
      expect(await manager.getSession(cleared.id)).toBeNull();

      // Both survive as owning-host retry records, and finalizing is what ends
      // them: no deletion path may drop the row on its own.
      const pending = await manager.listPendingWorktreeCleanupSessions(hostname());
      expect(pending.map(row => row.id).sort()).toEqual([cleared.id, deleted.id].sort());
      for (const row of pending) {
        expect(await manager.finalizePendingWorktreeCleanup(row)).toBe(true);
      }
      expect(await manager.listPendingWorktreeCleanupSessions(hostname())).toEqual([]);
      unsubscribe();
    });

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

    it("admits one of two concurrent continuation writes from the same basis", async () => {
      const s = await manager.createSession("claude", "two turns");
      const basis = { ...(s.metadata ?? {}) };
      const identity = sessionGenerationIdentity(s);
      const fenced = await Promise.all([
        manager.compareAndSetSession(identity, {
          kind: "replace_metadata",
          expectedMetadata: basis,
          metadata: { ...basis, apiPreviousResponseId: "A" },
        }),
        manager.compareAndSetSession(identity, {
          kind: "replace_metadata",
          expectedMetadata: basis,
          metadata: { ...basis, apiPreviousResponseId: "B" },
        }),
      ]);
      expect(fenced.filter(Boolean)).toHaveLength(1);
      const row = await manager.getSession(s.id);
      expect((row?.metadata as Record<string, unknown>).apiPreviousResponseId).toBe(
        fenced[0] ? "A" : "B"
      );

      // The negative control, in the same test: the unfenced merge these writes
      // used to take admits BOTH, which is how an earlier turn's handle could
      // end up in the row with both callers told true.
      const merged = await Promise.all([
        manager.updateSessionMetadata(s.id, { apiPreviousResponseId: "A" }),
        manager.updateSessionMetadata(s.id, { apiPreviousResponseId: "B" }),
      ]);
      expect(merged).toEqual([true, true]);
    });

    it("selects the active pointer's target by owner in the same statement", async () => {
      const alice = await runWithRequestContext(
        { transport: "http", authScopes: [], authPrincipal: "alice" },
        () => manager.createSession("claude", "alice session")
      );
      const bobOwn = await runWithRequestContext(
        { transport: "http", authScopes: [], authPrincipal: "bob" },
        () => manager.createSession("claude", "bob session")
      );
      await runWithRequestContext({ transport: "http", authScopes: [], authPrincipal: "bob" }, () =>
        manager.setActiveSession("claude", bobOwn.id)
      );

      const pointed = await runWithRequestContext(
        { transport: "http", authScopes: [], authPrincipal: "bob" },
        () => manager.setActiveSession("claude", alice.id)
      );

      expect(pointed).toBe(false);
      expect((await manager.getActiveSession("claude"))?.id).toBe(bobOwn.id);
    });

    it("carries the owner into the DELETE, not only into the caller's decision", async () => {
      const alice = await runWithRequestContext(
        { transport: "http", authScopes: [], authPrincipal: "alice" },
        () => manager.createSession("claude", "alice session")
      );

      const deleted = await runWithRequestContext(
        { transport: "http", authScopes: [], authPrincipal: "bob" },
        () => manager.deleteSession(alice.id)
      );

      // The DATABASE, not the return value: an unfenced DELETE returns false
      // from a re-read and still removes the row.
      expect(deleted).toBe(false);
      expect(await manager.getSession(alice.id)).toMatchObject({ ownerPrincipal: "alice" });
    });

    it("does not delete a row another principal took over mid-request", async () => {
      const alice = await runWithRequestContext(
        { transport: "http", authScopes: [], authPrincipal: "alice" },
        () => manager.createSession("claude", "alice session")
      );

      // A gate the test owns, holding alice's delete between its ownership
      // read and its statement. It resolves whether or not the fence exists.
      let release!: () => void;
      let arrived!: () => void;
      const gate = new Promise<void>(resolve => (release = resolve));
      // A two-way barrier. Without the arrival half the swap could land before
      // the held read completes, the read would return null, and the test would
      // pass against the unfenced DELETE without ever running it.
      const reached = new Promise<void>(resolve => (arrived = resolve));
      const realGetSession = manager.getSession.bind(manager);
      let held = false;
      (manager as unknown as Record<string, unknown>).getSession = async (id: string) => {
        const found = await realGetSession(id);
        if (!held && id === alice.id) {
          held = true;
          arrived();
          await gate;
        }
        return found;
      };

      const deleting = runWithRequestContext(
        { transport: "http", authScopes: [], authPrincipal: "alice" },
        () => manager.deleteSession(alice.id)
      );
      await reached;

      // Alice's row goes away legitimately, and bob claims the freed id.
      await manager.clearAllSessions();
      await runWithRequestContext({ transport: "http", authScopes: [], authPrincipal: "bob" }, () =>
        manager.createSession("claude", "bob session", alice.id)
      );
      expect(await realGetSession(alice.id)).toMatchObject({ ownerPrincipal: "bob" });

      release();
      await deleting;

      (manager as unknown as Record<string, unknown>).getSession = realGetSession;
      expect(await realGetSession(alice.id)).toMatchObject({ ownerPrincipal: "bob" });
    });

    it("should clear active session if deleting active session", async () => {
      const session = await manager.createSession("claude", "Test Session");
      await manager.setActiveSession("claude", session.id);

      await manager.deleteSession(session.id);

      const activeSession = await manager.getActiveSession("claude");
      expect(activeSession).toBeNull();
    });
  });

  describe("compareAndSetSession", () => {
    it("requires exact generation and expected metadata for replace and delete", async () => {
      const session = await manager.createSession("claude", "CAS", "cas-session");
      const identity = sessionGenerationIdentity(session);
      expect(
        await manager.compareAndSetSession(identity, {
          kind: "replace_metadata",
          expectedMetadata: undefined,
          metadata: { workspaceAlias: "repo" },
        })
      ).toBe(true);
      expect(
        await manager.compareAndSetSession(identity, {
          kind: "replace_metadata",
          expectedMetadata: undefined,
          metadata: { workspaceAlias: "stale" },
        })
      ).toBe(false);
      expect(
        await manager.compareAndSetSession(identity, {
          kind: "delete",
          expectedMetadata: undefined,
        })
      ).toBe(false);
      expect(
        await manager.compareAndSetSession(identity, {
          kind: "delete",
          expectedMetadata: { workspaceAlias: "repo" },
        })
      ).toBe(true);
    });

    it("rejects an old generation after an id is deleted and recreated", async () => {
      const original = await manager.createSession("claude", "first", "reused-id");
      const staleIdentity = sessionGenerationIdentity(original);
      expect(await manager.deleteSession(original.id)).toBe(true);
      const replacement = await manager.createSession("claude", "replacement", "reused-id");

      expect(
        await manager.compareAndSetSession(
          { ...staleIdentity, createdAt: replacement.createdAt },
          {
            kind: "replace_metadata",
            expectedMetadata: undefined,
            metadata: { shouldNotAppear: true },
          }
        )
      ).toBe(false);
      expect((await manager.getSession(replacement.id))?.metadata ?? {}).toEqual({});
    });
  });

  // Worktrees used to fail closed for ANY Postgres-backed session. That gate
  // was an engine check standing in for a host-ownership check, and it silently
  // removed the capability from every Postgres host in 3.1.0-rc.5. The property
  // that actually matters is enforced below: a worktree recorded as belonging
  // to a different host is refused, whatever the storage engine.
  it("creates and reuses a same-host worktree with PostgreSQL sessions", async () => {
    const repoRoot = initGitRepository();
    try {
      const session = await manager.createSession("claude", "same-host worktree");
      const runtime = resolveGatewayServerRuntime({ sessionManager: manager });
      const directive = { name: "pg-same-host" };

      const first = await resolveWorktreeForRequest(directive, session.id, runtime, { repoRoot });
      expect(first.worktreePath).toBeDefined();
      expect(existsSync(first.worktreePath!)).toBe(true);
      expect((await manager.getSession(session.id))?.metadata).toMatchObject({
        worktreePath: first.worktreePath,
        worktreeName: "pg-same-host",
        worktreeOwnerHostname: hostname(),
      });
      const beforeReuse = execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: repoRoot,
        encoding: "utf8",
      });

      const second = await resolveWorktreeForRequest(directive, session.id, runtime, { repoRoot });
      const afterReuse = execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      expect(second.worktreePath).toBe(first.worktreePath);
      expect(second.cwd).toBe(first.cwd);
      expect(afterReuse).toBe(beforeReuse);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("removes an owning-host worktree when a PostgreSQL session is deleted", async () => {
    const repoRoot = initGitRepository();
    const server = createGatewayServer({ sessionManager: manager });
    try {
      const session = await manager.createSession("claude", "owning-host deletion");
      const runtime = resolveGatewayServerRuntime({ sessionManager: manager });
      const resolution = await resolveWorktreeForRequest(
        { name: "pg-owning-host-deletion" },
        session.id,
        runtime,
        { repoRoot }
      );
      expect(existsSync(resolution.worktreePath!)).toBe(true);

      expect(await manager.deleteSession(session.id)).toBe(true);
      for (let attempt = 0; attempt < 200 && existsSync(resolution.worktreePath!); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      expect(existsSync(resolution.worktreePath!)).toBe(false);
      expect(await manager.getSession(session.id)).toBeNull();
    } finally {
      await server.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("cleans worktree metadata bound between the deletion read and DELETE", async () => {
    const repoRoot = initGitRepository();
    const server = createGatewayServer({ sessionManager: manager });
    let releaseDelete = (): void => undefined;
    try {
      const session = await manager.createSession("claude", "concurrent worktree binding");
      const runtime = resolveGatewayServerRuntime({ sessionManager: manager });
      const originalGetSession = manager.getSession.bind(manager);
      let signalInitialRead = (): void => undefined;
      const initialRead = new Promise<void>(resolve => {
        signalInitialRead = resolve;
      });
      const continueDelete = new Promise<void>(resolve => {
        releaseDelete = resolve;
      });
      vi.spyOn(manager, "getSession").mockImplementationOnce(async sessionId => {
        const snapshot = await originalGetSession(sessionId);
        signalInitialRead();
        await continueDelete;
        return snapshot;
      });

      const deletion = manager.deleteSession(session.id);
      await initialRead;
      const resolution = await resolveWorktreeForRequest(
        { name: "pg-concurrent-deletion" },
        session.id,
        runtime,
        { repoRoot }
      );
      expect(existsSync(resolution.worktreePath!)).toBe(true);
      releaseDelete();

      expect(await deletion).toBe(true);
      for (let attempt = 0; attempt < 200 && existsSync(resolution.worktreePath!); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      expect(existsSync(resolution.worktreePath!)).toBe(false);
      expect(await manager.getSession(session.id)).toBeNull();
    } finally {
      releaseDelete();
      vi.restoreAllMocks();
      await server.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("retains failed PostgreSQL worktree cleanup for owning-host retry", async () => {
    const repoRoot = initGitRepository();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const server = createGatewayServer({ sessionManager: manager, logger });
    try {
      const session = await manager.createSession("claude", "failed cleanup");
      const runtime = resolveGatewayServerRuntime({ sessionManager: manager });
      const resolution = await resolveWorktreeForRequest(
        { name: "pg-failed-cleanup" },
        session.id,
        runtime,
        { repoRoot }
      );
      const persisted = (await manager.getSession(session.id))!;
      await manager.updateSessionMetadata(session.id, {
        ...persisted.metadata,
        worktreeName: "mismatched-worktree-name",
      });

      expect(await manager.deleteSession(session.id)).toBe(true);
      for (
        let attempt = 0;
        attempt < 200 &&
        !logger.warn.mock.calls.some(([message]) =>
          String(message).includes("Skipping cleanup for a non-managed worktree path")
        );
        attempt += 1
      ) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      // The recorded NAME no longer matches Git's registration for the live
      // path, so removal refuses. Identity by token is resolved from the path
      // and still agrees; it is the name that is wrong, which is why this is
      // the layout refusal rather than the token one. Either way the record
      // must survive a failed removal, and that is what this test asserts.
      expect(logger.warn).toHaveBeenCalledWith(
        "Skipping cleanup for a non-managed worktree path",
        undefined
      );
      expect(existsSync(resolution.worktreePath!)).toBe(true);
      expect(await manager.getSession(session.id)).toBeNull();

      // The removal was refused, so the record MUST survive for the owning host
      // to try again. This is the guarantee #305 adds and #302 recorded the
      // absence of.
      const pending = await manager.listPendingWorktreeCleanupSessions(hostname());
      expect(pending.map(row => row.id)).toEqual([session.id]);
      expect(pending[0]!.metadata?.worktreeOwnerHostname).toBe(hostname());
    } finally {
      await server.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("leaves an owning host's worktree in place when another host deletes the session", async () => {
    const repoRoot = initGitRepository();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const server = createGatewayServer({ sessionManager: manager, logger });
    try {
      const session = await manager.createSession("claude", "foreign-host deletion");
      const runtime = resolveGatewayServerRuntime({ sessionManager: manager });
      const resolution = await resolveWorktreeForRequest(
        { name: "pg-foreign-host-deletion" },
        session.id,
        runtime,
        { repoRoot }
      );
      const persisted = (await manager.getSession(session.id))!;
      await manager.updateSessionMetadata(session.id, {
        ...persisted.metadata,
        worktreeOwnerHostname: "some-other-host.invalid",
      });

      expect(await manager.deleteSession(session.id)).toBe(true);
      for (
        let attempt = 0;
        attempt < 200 &&
        !logger.warn.mock.calls.some(([message]) =>
          String(message).includes("is not owned by this host; skipping cleanup")
        );
        attempt += 1
      ) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("is not owned by this host; skipping cleanup"),
        undefined
      );
      expect(existsSync(resolution.worktreePath!)).toBe(true);
      expect(await manager.getSession(session.id)).toBeNull();

      // Deletion processed HERE must not destroy the owning host's retry
      // record, and must not offer that record to this host either.
      expect(await manager.listPendingWorktreeCleanupSessions(hostname())).toEqual([]);
      const theirs = await manager.listPendingWorktreeCleanupSessions("some-other-host.invalid");
      expect(theirs.map(row => row.id)).toEqual([session.id]);
    } finally {
      await server.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("refuses to reuse a worktree recorded as owned by another host", async () => {
    const session = await manager.createSession("claude", "foreign worktree");
    await manager.updateSessionMetadata(session.id, {
      worktreePath: "/tmp/not-this-host/wt",
      worktreeName: "wt",
      worktreeOwnerHostname: "some-other-host.invalid",
      worktreeOwnerInstanceId: "11111111-2222-3333-4444-555555555555",
    });
    const runtime = resolveGatewayServerRuntime({ sessionManager: manager });

    await expect(
      resolveWorktreeForRequest(true, session.id, runtime, { repoRoot: process.cwd() })
    ).rejects.toThrow(/same-host gateway-owned Git worktree/);
  });

  it("recovers onto a fresh worktree when a live one's creation token is not this session's", async () => {
    // Git identity proves a gateway worktree lives at the path, not that it is
    // THIS session's. When the token cannot be confirmed the session must not
    // reuse the worktree (it may be a different creation's) and must not be
    // stranded either: it recovers onto a fresh worktree instead.
    const repoRoot = initGitRepository();
    try {
      const session = await manager.createSession("claude", "reuse token mismatch");
      const runtime = resolveGatewayServerRuntime({ sessionManager: manager });
      const resolution = await resolveWorktreeForRequest(
        { name: "pg-reuse-token" },
        session.id,
        runtime,
        { repoRoot }
      );
      expect(resolution.worktreePath).toBeTruthy();
      // Reuse works while the token agrees.
      const reused = await resolveWorktreeForRequest(true, session.id, runtime, { repoRoot });
      expect(reused.worktreePath).toBe(resolution.worktreePath);

      // Now the session claims a worktree it did not create. The live one at
      // that path is a perfectly valid gateway worktree, which is the point.
      const persisted = (await manager.getSession(session.id))!;
      expect(persisted.metadata?.worktreeToken).toBeTruthy();
      await manager.updateSessionMetadata(session.id, {
        ...persisted.metadata,
        worktreeToken: "00000000-0000-4000-8000-000000000000",
      });

      // The live worktree at the path is a valid gateway worktree, but its
      // creation token is not this session's, so it cannot be confirmed as its
      // own. Rather than strand the session, reuse recovers onto a FRESH worktree
      // and leaves the mismatched one untouched.
      const recovered = await resolveWorktreeForRequest(true, session.id, runtime, { repoRoot });
      expect(recovered.worktreePath).toBeTruthy();
      expect(recovered.worktreePath).not.toBe(resolution.worktreePath);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("database-side expiry removes no worktree and invokes no observer", async () => {
    const repoRoot = initGitRepository();
    try {
      const session = await manager.createSession("claude", "database expiry");
      const runtime = resolveGatewayServerRuntime({ sessionManager: manager });
      const resolution = await resolveWorktreeForRequest(
        { name: "pg-database-expiry" },
        session.id,
        runtime,
        { repoRoot }
      );
      const observed: string[] = [];
      manager.addSessionRemovalObserver(removed => {
        observed.push(removed.id);
      });
      await manager.setActiveSession("claude", null);
      await pool.query(
        "UPDATE sessions SET last_used_at = NOW() - INTERVAL '40 days' WHERE id = $1",
        [session.id]
      );

      const cleanup = await pool.query<{ deleted: number }>(
        "SELECT cleanup_expired_sessions(30) AS deleted"
      );
      expect(cleanup.rows[0]?.deleted).toBe(1);
      expect(await manager.getSession(session.id)).toBeNull();
      expect(observed).toEqual([]);
      expect(existsSync(resolution.worktreePath!)).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("scopes pending worktree tombstones to this host, in the query", async () => {
    // A shared store holds other instances' rows. A foreign tombstone must
    // never be returned into this process at all, so the filter is asserted
    // through the public surface rather than by reading the SQL.
    const mine = await manager.createSession("claude", "mine");
    const theirs = await manager.createSession("claude", "theirs");
    await manager.updateSessionMetadata(mine.id, {
      worktreeCleanupPendingDeletion: true,
      worktreeOwnerHostname: "host-a.invalid",
    });
    await manager.updateSessionMetadata(theirs.id, {
      worktreeCleanupPendingDeletion: true,
      worktreeOwnerHostname: "host-b.invalid",
    });

    const listed = await manager.listPendingWorktreeCleanupSessions("host-a.invalid");
    expect(listed.map(s => s.id)).toEqual([mine.id]);
    expect(await manager.listPendingWorktreeCleanupSessions(undefined)).toEqual([]);
  });

  it("refuses to finalize a tombstone owned by another host", async () => {
    const session = await manager.createSession("claude", "foreign tombstone");
    await manager.updateSessionMetadata(session.id, {
      worktreeCleanupPendingDeletion: true,
      worktreeOwnerHostname: "host-b.invalid",
    });
    // Read back through the tombstone surface, not `getSession`: a tombstone is
    // a DELETED session and every caller-facing read now reports it absent.
    const owner = "host-b.invalid";
    const current = (await manager.listPendingWorktreeCleanupSessions(owner))[0]!;
    expect(current.id).toBe(session.id);
    expect(await manager.getSession(session.id)).toBeNull();

    // Same row, but presented as if this host owned it: the DELETE is fenced on
    // the stored hostname, so it must not match.
    const spoofed = {
      ...current,
      metadata: { ...current.metadata, worktreeOwnerHostname: "host-a.invalid" },
    };
    expect(await manager.finalizePendingWorktreeCleanup(spoofed)).toBe(false);
    expect(await manager.listPendingWorktreeCleanupSessions(owner)).toHaveLength(1);

    // The true owner can finalize it.
    expect(await manager.finalizePendingWorktreeCleanup(current)).toBe(true);
    expect(await manager.listPendingWorktreeCleanupSessions(owner)).toEqual([]);
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
        manager.setActiveSession("claude", session2.id),
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

    it("never moves last_used_at backwards, even from a writer with an older basis", async () => {
      // DEFECT 4. The statement was `SET last_used_at = $1` with a client
      // `new Date()` captured before the await, unguarded, on a pool of ten.
      // Of two concurrent turns the later-finishing EARLIER one wrote the older
      // value and the column regressed. migrations/009's
      // `cleanup_expired_sessions` DELETEs on this column, so a regressed
      // timestamp is a live session an operator's cron can remove.
      const session = await manager.createSession("claude", "monotonic", "monotonic-session");
      const { pool } = await setupTestDatabase();

      // A writer whose basis is LATER than this process's clock has committed.
      const ahead = await pool.query<{ last_used_at: Date }>(
        `UPDATE sessions SET last_used_at = clock_timestamp() + interval '1 hour'
         WHERE id = $1 RETURNING last_used_at`,
        [session.id]
      );
      const aheadAt = ahead.rows[0].last_used_at;

      expect(await manager.updateSessionUsage(session.id)).toBe(true);

      const after = await pool.query<{ last_used_at: Date }>(
        "SELECT last_used_at FROM sessions WHERE id = $1",
        [session.id]
      );
      // Read off the DATABASE, not off the boolean the call returned.
      expect(after.rows[0].last_used_at.getTime()).toBeGreaterThanOrEqual(aheadAt.getTime());
    });

    it("cannot regress the column while waiting on another writer's row lock", async () => {
      // The same defect under a REAL serialization conflict rather than a
      // pre-set value, which is also what proves the guard survives Postgres
      // re-evaluating the SET expression against the newer row version.
      //
      // The barrier is the row lock itself, not a sleep: the UPDATE below is
      // AWAITED inside an open transaction, so the lock is provably held before
      // updateSessionUsage is issued, and updateSessionUsage cannot proceed
      // until the COMMIT.
      const session = await manager.createSession("claude", "locked", "locked-session");
      const { pool } = await setupTestDatabase();
      const holder = await pool.connect();
      let aheadAt: Date;
      let usage: Promise<boolean>;
      try {
        await holder.query("BEGIN");
        const ahead = await holder.query<{ last_used_at: Date }>(
          `UPDATE sessions SET last_used_at = clock_timestamp() + interval '1 hour'
           WHERE id = $1 RETURNING last_used_at`,
          [session.id]
        );
        aheadAt = ahead.rows[0].last_used_at;
        // Issued while the lock is held; it blocks in the server.
        usage = manager.updateSessionUsage(session.id);
        await holder.query("COMMIT");
      } finally {
        holder.release();
      }
      expect(await usage).toBe(true);

      const after = await pool.query<{ last_used_at: Date }>(
        "SELECT last_used_at FROM sessions WHERE id = $1",
        [session.id]
      );
      expect(after.rows[0].last_used_at.getTime()).toBeGreaterThanOrEqual(aheadAt.getTime());
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
        key2: 42,
      });

      expect(success).toBe(true);

      const updated = await manager.getSession(session.id);
      expect(updated?.metadata).toEqual({
        key1: "value1",
        key2: 42,
      });
    });

    it("should merge metadata with existing values", async () => {
      const session = await manager.createSession("claude", "Test Session");

      await manager.updateSessionMetadata(session.id, { key1: "value1" });
      await manager.updateSessionMetadata(session.id, { key2: "value2" });

      const updated = await manager.getSession(session.id);
      expect(updated?.metadata).toEqual({
        key1: "value1",
        key2: "value2",
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
  // Fresh Read Behavior (3 tests)
  //──────────────────────────────────────────────────────────────────────────

  describe("fresh read behavior", () => {
    it("should retrieve session after creation", async () => {
      const session = await manager.createSession("claude", "Test Session");

      const retrieved = await manager.getSession(session.id);

      expect(retrieved?.id).toBe(session.id);
    });

    it("should return null after session deletion", async () => {
      const session = await manager.createSession("claude", "Test Session");

      await manager.getSession(session.id);
      await manager.deleteSession(session.id);

      const retrieved = await manager.getSession(session.id);
      expect(retrieved).toBeNull();
    });

    it("should return fresh metadata after update", async () => {
      const session = await manager.createSession("claude", "Test Session");

      await manager.getSession(session.id);
      await manager.updateSessionMetadata(session.id, { key: "value" });

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
        manager.createSession("claude", "Session 3"),
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

    it("should handle session creation for all provider types", async () => {
      const claudeSession = await manager.createSession("claude");
      const codexSession = await manager.createSession("codex");
      const geminiSession = await manager.createSession("gemini");
      const grokSession = await manager.createSession("grok");
      const mistralSession = await manager.createSession("mistral");
      const grokApiSession = await manager.createSession("grok-api");

      expect(claudeSession.cli).toBe("claude");
      expect(codexSession.cli).toBe("codex");
      expect(geminiSession.cli).toBe("gemini");
      expect(grokSession.cli).toBe("grok");
      expect(mistralSession.cli).toBe("mistral");
      expect(grokApiSession.cli).toBe("grok-api");

      const sessions = await manager.listSessions();
      expect(sessions.length).toBe(6);
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
      expect(PROVIDER_TYPES).toContain(session.cli);
    });

    it("should support JSONB metadata queries", async () => {
      await manager.createSession("claude", "Session 1");
      const session2 = await manager.createSession("claude", "Session 2");
      await manager.updateSessionMetadata(session2.id, {
        tag: "important",
        priority: 1,
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
        manager.deleteSession(session.id),
      ]);

      // One should succeed, one should fail
      expect(result1 || result2).toBe(true);
      expect(result1 && result2).toBe(false);
    });
  });
});
