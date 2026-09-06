/**
 * Adoption WIRING, at its production call site.
 *
 * Round 8 found the three guards in `adoptWorktreeIdentityForSession` had no
 * test at all: the helper `adoptLegacyWorktreeIdentity` and the withdrawal
 * helper were each covered directly, and the code that calls them was not, so
 * dropping the withdrawal, inverting its condition, or dropping the tombstone
 * term from the claimant count all left the suite green. Every case here drives
 * `resolveWorktreeForRequest`, which is the only production caller.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { hostname, tmpdir } from "os";
import { join } from "path";
import { resolveGatewayServerRuntime, resolveWorktreeForRequest } from "../index.js";
import {
  createWorktree,
  discardAdoptedWorktreeMarker,
  readWorktreeOwnerToken,
} from "../worktree-manager.js";
import { FileSessionManager } from "../session-manager.js";
import { noopLogger } from "../logger.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function initRepository(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `adopt-wiring-${label}-`));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.test");
  git(root, "config", "user.name", "Test");
  writeFileSync(join(root, "tracked"), "seed");
  git(root, "add", "tracked");
  git(root, "commit", "-qm", "seed");
  return root;
}

describe("worktree identity adoption, through its production caller", () => {
  const cleanups: string[] = [];
  afterEach(() => {
    while (cleanups.length > 0) {
      rmSync(cleanups.pop()!, { recursive: true, force: true });
    }
  });

  /** A pre-token session pointing at a live, unmarked worktree. */
  const legacyFixture = async (label: string, ownerHostname: string = hostname()) => {
    const repoRoot = initRepository(label);
    cleanups.push(repoRoot);
    const storage = mkdtempSync(join(tmpdir(), `adopt-store-${label}-`));
    cleanups.push(storage);
    const manager = new FileSessionManager(join(storage, "sessions.json"));
    const handle = await createWorktree({ repoRoot, name: label, logger: noopLogger });
    // Strip the marker to produce the shape every pre-release session has.
    rmSync(join(handle.adminDirectory, "gateway-owner.json"), { force: true });
    const session = manager.createSession("claude", label);
    manager.updateSessionMetadata(session.id, {
      worktreePath: handle.path,
      worktreeName: handle.name,
      worktreeOwnerHostname: ownerHostname,
      worktreeOwnerInstanceId: "instance-adopt-wiring",
    });
    return { repoRoot, manager, handle, sessionId: session.id };
  };

  it("stamps identity and records it when the session is reused", async () => {
    const { repoRoot, manager, handle, sessionId } = await legacyFixture("happy");
    const runtime = resolveGatewayServerRuntime({ sessionManager: manager });

    await resolveWorktreeForRequest({ name: "happy" }, sessionId, runtime, { repoRoot });

    const token = await readWorktreeOwnerToken(handle.path, noopLogger);
    expect(token).not.toBeNull();
    // The record and the marker agree, which is the whole point of adoption.
    expect(manager.getSession(sessionId)?.metadata?.worktreeToken).toBe(token);
    expect(manager.getSession(sessionId)?.metadata?.worktreeAdminDirectory).toBe(
      handle.adminDirectory
    );
  });

  it("withdraws the marker when the record cannot be persisted", async () => {
    // Survivors M6 and M9 in round 7: dropping the withdrawal, or inverting its
    // condition, left every shipped test green.
    const { repoRoot, manager, handle, sessionId } = await legacyFixture("refused");
    const runtime = resolveGatewayServerRuntime({ sessionManager: manager });
    manager.compareAndSetSession = () => false;

    await resolveWorktreeForRequest({ name: "refused" }, sessionId, runtime, { repoRoot }).catch(
      () => undefined
    );

    expect(await readWorktreeOwnerToken(handle.path, noopLogger)).toBeNull();
    expect(manager.getSession(sessionId)?.metadata?.worktreeToken).toBeUndefined();
  });

  it("withdraws the marker when persisting the record THROWS", async () => {
    // The round-8 blocker. `compareAndSetSession` runs a query, so a database
    // error rejects rather than returning false, and the previous
    // `if (!persisted)` was skipped entirely. The marker stayed on disk with no
    // session naming it, and adoption refuses such a worktree forever as
    // "already marked", so the state was permanent.
    const { repoRoot, manager, handle, sessionId } = await legacyFixture("thrown");
    const runtime = resolveGatewayServerRuntime({ sessionManager: manager });
    manager.compareAndSetSession = () => {
      throw new Error("simulated database failure while recording adoption");
    };

    await resolveWorktreeForRequest({ name: "thrown" }, sessionId, runtime, { repoRoot }).catch(
      () => undefined
    );

    expect(await readWorktreeOwnerToken(handle.path, noopLogger)).toBeNull();
    expect(manager.getSession(sessionId)?.metadata?.worktreeToken).toBeUndefined();
  });

  it("withdraws only ITS OWN marker, never a replacement creation's", async () => {
    // Round 8, second seat. The withdrawal repair took a directory and deleted
    // whatever marker stood there. A worktree can be removed and a fresh one
    // created into the administrative directory Git reuses while the adoption's
    // persist is still in flight, so an unscoped withdrawal strips the
    // REPLACEMENT's identity: the same name-reuse ambiguity the per-creation
    // token exists to close, recreated inside the fix for it.
    const { repoRoot, handle } = await legacyFixture("replacement");
    const replacementToken = "token-of-a-later-creation";
    writeFileSync(
      join(handle.adminDirectory, "gateway-owner.json"),
      JSON.stringify({ token: replacementToken })
    );

    discardAdoptedWorktreeMarker(handle.adminDirectory, "token-of-the-adoption", noopLogger);

    // Untouched: the withdrawal did not own this identity.
    expect(await readWorktreeOwnerToken(handle.path, noopLogger)).toBe(replacementToken);
    expect(existsSync(join(handle.adminDirectory, "gateway-owner.json"))).toBe(true);
    expect(repoRoot.length).toBeGreaterThan(0);

    // ...and it does remove the one it DOES own, so the guard is not simply inert.
    discardAdoptedWorktreeMarker(handle.adminDirectory, replacementToken, noopLogger);
    expect(await readWorktreeOwnerToken(handle.path, noopLogger)).toBeNull();
  });

  it("does not count a session pointing at a DIFFERENT worktree as a claimant", async () => {
    // The claimant count exists to detect two records naming ONE worktree. A
    // predicate that ignores the path counts every session in the store, so an
    // unrelated worktree elsewhere in the repository would block adoption for
    // good; the count must be about this path or it is not a contest.
    const { repoRoot, manager, handle, sessionId } = await legacyFixture("unrelated");
    const elsewhere = manager.createSession("claude", "elsewhere");
    manager.updateSessionMetadata(elsewhere.id, {
      worktreePath: join(repoRoot, ".worktrees", "some-other-worktree"),
      worktreeName: "some-other-worktree",
      worktreeOwnerHostname: hostname(),
      worktreeOwnerInstanceId: "instance-elsewhere",
    });
    const runtime = resolveGatewayServerRuntime({ sessionManager: manager });

    await resolveWorktreeForRequest({ name: "unrelated" }, sessionId, runtime, { repoRoot });

    expect(await readWorktreeOwnerToken(handle.path, noopLogger)).not.toBeNull();
  });

  it("refuses to adopt a worktree recorded as owned by another host", async () => {
    // Adoption stamps identity onto a live checkout. Doing that for a record
    // this host does not own would mint an identity for someone else's
    // worktree, which is the ownership boundary every later cleanup decision
    // rests on.
    const { repoRoot, manager, handle, sessionId } = await legacyFixture(
      "foreign",
      "some-other-host.invalid"
    );
    const runtime = resolveGatewayServerRuntime({ sessionManager: manager });

    await resolveWorktreeForRequest({ name: "foreign" }, sessionId, runtime, { repoRoot }).catch(
      () => undefined
    );

    expect(await readWorktreeOwnerToken(handle.path, noopLogger)).toBeNull();
    expect(manager.getSession(sessionId)?.metadata?.worktreeToken).toBeUndefined();
  });

  it("counts a hidden cleanup tombstone as a claimant and refuses to adopt", async () => {
    // Survivor M7 in round 7. `listSessions` hides tombstones on both stores,
    // so a tombstone sharing the path with a live pre-token session reported
    // one claimant and adopted. That is the contested-path case adoption exists
    // to refuse: two records naming one worktree cannot be told apart.
    const { repoRoot, manager, handle, sessionId } = await legacyFixture("contested");
    const runtime = resolveGatewayServerRuntime({ sessionManager: manager });

    // A second session on the same path, deleted so it becomes a tombstone.
    const rival = manager.createSession("claude", "rival");
    manager.updateSessionMetadata(rival.id, {
      worktreePath: handle.path,
      worktreeName: handle.name,
      worktreeOwnerHostname: hostname(),
      worktreeOwnerInstanceId: "instance-rival",
    });
    expect(manager.deleteSession(rival.id)).toBe(true);
    // It is hidden from ordinary reads, which is exactly why it was missed.
    expect(manager.listSessions().some(s => s.id === rival.id)).toBe(false);
    expect(
      manager.listPendingWorktreeCleanupSessions(hostname()).some(s => s.id === rival.id)
    ).toBe(true);

    await resolveWorktreeForRequest({ name: "contested" }, sessionId, runtime, { repoRoot }).catch(
      () => undefined
    );

    expect(await readWorktreeOwnerToken(handle.path, noopLogger)).toBeNull();
    expect(manager.getSession(sessionId)?.metadata?.worktreeToken).toBeUndefined();
  });
});
