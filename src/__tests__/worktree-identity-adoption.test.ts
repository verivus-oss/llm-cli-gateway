/**
 * Adoption WIRING, at its production call site.
 *
 * Round 8 found the three guards in `adoptWorktreeIdentityForSession` had no
 * test at all: the helper `adoptLegacyWorktreeIdentity` and the withdrawal
 * helper were each covered directly, and the code that calls them was not, so
 * dropping the withdrawal, inverting its condition, or dropping the tombstone
 * term from the claimant count all left the suite green. Most cases here drive
 * `resolveWorktreeForRequest`, the only production caller; the two that name
 * `discardAdoptedWorktreeMarker` exercise the withdrawal helper directly,
 * because the fault they probe (a torn or unreadable marker) cannot be driven
 * through the production writer.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
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
    const storePath = join(storage, "sessions.json");
    const manager = new FileSessionManager(storePath);
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
    return { repoRoot, manager, handle, sessionId: session.id, storePath };
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

  it("reclaims THIS session's own stranded adoption marker, so a strand is not permanent", async () => {
    // The round-9 blocker. Round 8's withdrawal reads the marker before
    // removing it, so it takes back only its own token. When that read fails,
    // the withdrawal declines and the marker stays, with no record. Recovery
    // reclaims it, but ONLY a strand: a marker THIS session's own adoption
    // wrote, which carries `adoptedBy = session.id`. Here that state is set up
    // directly; the end-to-end test below produces it through the real caller.
    const { repoRoot, manager, handle, sessionId } = await legacyFixture("orphan");
    const strandedToken = "stranded-token-this-session-wrote";
    writeFileSync(
      join(handle.adminDirectory, "gateway-owner.json"),
      JSON.stringify({ token: strandedToken, adoptedBy: sessionId })
    );
    const runtime = resolveGatewayServerRuntime({ sessionManager: manager });

    await resolveWorktreeForRequest({ name: "orphan" }, sessionId, runtime, { repoRoot });

    const token = await readWorktreeOwnerToken(handle.path, noopLogger);
    expect(token).not.toBeNull();
    // A fresh identity, not the strand's, and the record agrees with it.
    expect(token).not.toBe(strandedToken);
    expect(manager.getSession(sessionId)?.metadata?.worktreeToken).toBe(token);
  });

  it("strands on a failed withdrawal read, then RECOVERS on a healthy retry", async () => {
    // codex's round-9 reproduction end to end. The first reuse persists into a
    // rejecting store AND the withdrawal's read of the marker fails, so the
    // marker the adoption just wrote is left with no record: exactly the state
    // that used to be permanent. The second reuse, filesystem healthy, adopts.
    const { repoRoot, manager, handle, sessionId, storePath } =
      await legacyFixture("strand-recover");
    const markerPath = join(handle.adminDirectory, "gateway-owner.json");

    // Persist rejects, and while it does the marker is made unreadable, so the
    // withdrawal in the `finally` declines and the fresh marker survives.
    manager.compareAndSetSession = () => {
      chmodSync(markerPath, 0o000);
      throw new Error("db down while recording adoption");
    };
    const rt1 = resolveGatewayServerRuntime({ sessionManager: manager });
    await resolveWorktreeForRequest({ name: "strand-recover" }, sessionId, rt1, { repoRoot }).catch(
      () => undefined
    );

    // The strand: a marker on disk, no token recorded on the session.
    chmodSync(markerPath, 0o600);
    expect(existsSync(markerPath)).toBe(true);
    expect(manager.getSession(sessionId)?.metadata?.worktreeToken).toBeUndefined();

    // Healthy retry against a fresh manager over the same store file. Before
    // recovery this refused forever as "already marked"; now it reclaims.
    const recovered = new FileSessionManager(storePath);
    const rt2 = resolveGatewayServerRuntime({ sessionManager: recovered });
    await resolveWorktreeForRequest({ name: "strand-recover" }, sessionId, rt2, { repoRoot });

    const token = await readWorktreeOwnerToken(handle.path, noopLogger);
    expect(token).not.toBeNull();
    expect(recovered.getSession(sessionId)?.metadata?.worktreeToken).toBe(token);
  });

  it("does NOT destroy a recorded adoption reached through a STALE session snapshot", async () => {
    // The round-11 blocker. Provenance alone reclaims too much: a snapshot of
    // THIS session taken before a successful adoption has no token, so the early
    // guard passes and `adoptedBy === session.id` matches the marker the
    // adoption wrote. Without the store check, the reclaim mints a new token,
    // the CAS fails against the recorded one, the marker is withdrawn, and reuse
    // throws forever. `recordsToken`, read fresh from the store, refuses it: the
    // token is already recorded, so it is a live identity, not a strand.
    const { repoRoot, manager, handle, sessionId } = await legacyFixture("stale-snap");
    // A snapshot from BEFORE the first adoption: no token, exactly what an
    // admission taken before a concurrent request's adoption committed holds.
    const staleSnapshot = structuredClone(manager.getSession(sessionId)!);
    const runtime = resolveGatewayServerRuntime({ sessionManager: manager });

    // First reuse adopts and records successfully.
    await resolveWorktreeForRequest({ name: "stale-snap" }, sessionId, runtime, { repoRoot });
    const recordedToken = manager.getSession(sessionId)?.metadata?.worktreeToken;
    expect(typeof recordedToken).toBe("string");
    expect(staleSnapshot.metadata?.worktreeToken).toBeUndefined();

    // Second reuse arrives with the stale snapshot. The recorded identity must
    // survive; before the store check it was overwritten and then withdrawn.
    await resolveWorktreeForRequest({ name: "stale-snap" }, sessionId, runtime, {
      repoRoot,
      expectedSession: staleSnapshot,
    }).catch(() => undefined);

    expect(await readWorktreeOwnerToken(handle.path, noopLogger)).toBe(recordedToken);
    expect(manager.getSession(sessionId)?.metadata?.worktreeToken).toBe(recordedToken);
  });

  it("does NOT reclaim a LIVE request-scoped worktree, whose token no session records", async () => {
    // The round-10 blocker. A request-scoped worktree (no sessionId) is created
    // live, and the branch that would persist its token is skipped, so NO
    // session ever records it. Round 10 reclaimed on "no session records this
    // token" and so stamped a fresh identity over this live worktree. The
    // marker it wrote carries no `adoptedBy`, so provenance leaves it alone.
    const { repoRoot, manager } = await legacyFixture("reqscoped");
    const runtime = resolveGatewayServerRuntime({ sessionManager: manager });

    // A live request-scoped named worktree. Its marker has a token no session
    // records.
    const live = await resolveWorktreeForRequest({ name: "reqscoped-wt" }, undefined, runtime, {
      repoRoot,
    });
    const livePath = (live as { requestOwnedWorktree?: { path: string; token: string } })
      .requestOwnedWorktree!;
    expect(livePath.token).toEqual(expect.any(String));
    expect(manager.listSessions().some(s => s.metadata?.worktreeToken === livePath.token)).toBe(
      false
    );

    // A legacy pre-token session pointed at that exact live path.
    const stale = manager.createSession("claude", "stale");
    manager.updateSessionMetadata(stale.id, {
      worktreePath: livePath.path,
      worktreeName: "reqscoped-wt",
      worktreeOwnerHostname: hostname(),
      worktreeOwnerInstanceId: "instance-stale",
    });

    await resolveWorktreeForRequest({ name: "reqscoped-wt" }, stale.id, runtime, {
      repoRoot,
    }).catch(() => undefined);

    // The live worktree's identity survives, and the legacy session took none.
    expect(await readWorktreeOwnerToken(livePath.path, noopLogger)).toBe(livePath.token);
    expect(manager.getSession(stale.id)?.metadata?.worktreeToken).toBeUndefined();
  });

  it("does NOT reclaim a marker written by a DIFFERENT session's adoption", async () => {
    // A strand belongs to the session that wrote it. A marker whose `adoptedBy`
    // names another session must not be reclaimed here, or one session could
    // steal another's in-flight adoption.
    const { repoRoot, manager, handle, sessionId } = await legacyFixture("other-adopter");
    const foreignToken = "token-another-session-adopted";
    writeFileSync(
      join(handle.adminDirectory, "gateway-owner.json"),
      JSON.stringify({ token: foreignToken, adoptedBy: "a-different-session-id" })
    );
    const runtime = resolveGatewayServerRuntime({ sessionManager: manager });

    await resolveWorktreeForRequest({ name: "other-adopter" }, sessionId, runtime, {
      repoRoot,
    }).catch(() => undefined);

    expect(await readWorktreeOwnerToken(handle.path, noopLogger)).toBe(foreignToken);
    expect(manager.getSession(sessionId)?.metadata?.worktreeToken).toBeUndefined();
  });

  it("does NOT reclaim an UNREADABLE marker, which could be a live identity", async () => {
    // Recovery reclaims only a marker it can read AND find unrecorded. An
    // unreadable marker is neither: it could be a live creation's identity that
    // is momentarily unreadable, or corrupt. Stamping a fresh token over it
    // would be the ABA hazard again, decided on a failed read. A malformed
    // marker is the deterministic way to reach `readAdminMarker` -> unreadable.
    const { repoRoot, manager, handle, sessionId } = await legacyFixture("unreadable");
    const markerPath = join(handle.adminDirectory, "gateway-owner.json");
    writeFileSync(markerPath, "{ this is not json");
    const runtime = resolveGatewayServerRuntime({ sessionManager: manager });

    await resolveWorktreeForRequest({ name: "unreadable" }, sessionId, runtime, { repoRoot }).catch(
      () => undefined
    );

    // Left exactly as found, and the session took no identity from it.
    expect(readFileSync(markerPath, "utf8")).toBe("{ this is not json");
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
