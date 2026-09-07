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
import { describe, it, expect, afterEach, vi } from "vitest";
import { execFileSync } from "child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { hostname, tmpdir } from "os";
import { join } from "path";
import { resolveGatewayServerRuntime, resolveWorktreeForRequest } from "../index.js";
import {
  adoptLegacyWorktreeIdentity,
  createWorktree,
  discardAdoptedWorktreeMarker,
  readWorktreeOwnerToken,
  settleFailedAdoptionMarker,
  withWorktreeAdoptionLock,
} from "../worktree-manager.js";
import * as worktreeManager from "../worktree-manager.js";
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

  /**
   * A session that already owns a real, recorded gateway worktree, with the
   * on-disk marker forced to a given shape. Models the durable end-state a
   * concurrent race leaves: the store holds the winning token, the disk may hold
   * something else.
   */
  const recordedFixture = async (
    label: string,
    diskMarker: (sessionId: string, recordedToken: string) => unknown
  ) => {
    const repoRoot = initRepository(label);
    cleanups.push(repoRoot);
    const storage = mkdtempSync(join(tmpdir(), `adopt-store-${label}-`));
    cleanups.push(storage);
    const manager = new FileSessionManager(join(storage, "sessions.json"));
    const handle = await createWorktree({ repoRoot, name: label, logger: noopLogger });
    const recordedToken = "winner-token-the-store-recorded";
    const session = manager.createSession("claude", label);
    manager.updateSessionMetadata(session.id, {
      worktreePath: handle.path,
      worktreeName: handle.name,
      worktreeOwnerHostname: hostname(),
      worktreeOwnerInstanceId: "instance-recorded",
      worktreeToken: recordedToken,
      worktreeAdminDirectory: handle.adminDirectory,
    });
    writeFileSync(
      join(handle.adminDirectory, "gateway-owner.json"),
      JSON.stringify(diskMarker(session.id, recordedToken))
    );
    return { repoRoot, manager, handle, sessionId: session.id, recordedToken };
  };

  it("reconciles a marker this session adopted but a race left on an abandoned token", async () => {
    // The round-13 blocker. Three overlapping first-adoptions of one session
    // settle so the store holds the winning token and the disk holds an
    // intermediate one a losing reclaim wrote. The record is the arbiter: reuse
    // repairs the marker to the recorded token rather than throwing.
    const { repoRoot, manager, handle, sessionId, recordedToken } = await recordedFixture(
      "reconcile",
      sid => ({ token: "abandoned-intermediate-token", adoptedBy: sid })
    );
    const runtime = resolveGatewayServerRuntime({ sessionManager: manager });

    const resolved = await resolveWorktreeForRequest({ name: "reconcile" }, sessionId, runtime, {
      repoRoot,
    });

    // Reuse succeeded and the marker now names the recorded (winning) token.
    expect((resolved as { worktreePath?: string }).worktreePath).toBe(handle.path);
    expect(await readWorktreeOwnerToken(handle.path, noopLogger)).toBe(recordedToken);
  });

  it("does NOT reconcile an ABSENT marker, which could be a replacement mid-creation", async () => {
    // The round-15 blocker (codex). Round 15 materialised the recorded token
    // onto an absent marker, on the theory that createWorktree always leaves a
    // marker so an absent one is a lost one. False: createWorktree registers the
    // worktree with `git worktree add` BEFORE it writes the marker, so a
    // validated registration with no marker can be a REPLACEMENT creation caught
    // in that window, indistinguishable from a lost marker because everything
    // else is name-derived. Materialising the record there stamps this session's
    // identity onto someone else's worktree, the ABA the token exists to catch.
    // So an absent marker is refused; the concurrent fresh loser that would have
    // stranded its own marker is prevented at the source (exclusive-create).
    const { repoRoot, manager, handle, sessionId } = await recordedFixture(
      "reconcile-absent",
      () => ({
        token: "irrelevant",
      })
    );
    rmSync(join(handle.adminDirectory, "gateway-owner.json"), { force: true });
    const runtime = resolveGatewayServerRuntime({ sessionManager: manager });

    await expect(
      resolveWorktreeForRequest({ name: "reconcile-absent" }, sessionId, runtime, { repoRoot })
    ).rejects.toThrow(/Durable session worktree metadata no longer matches/);
    // Not stamped: the absent marker stays absent.
    expect(await readWorktreeOwnerToken(handle.path, noopLogger)).toBeNull();
  });

  it("does NOT stamp an old session's token onto a REPLACEMENT worktree with no marker yet", async () => {
    // The round-15 ABA, end to end. The original worktree is removed and a
    // replacement is created at the same name; caught before its marker write
    // (or its marker not yet visible), the replacement is a validated gateway
    // registration with an absent marker. The ORIGINAL session, which still
    // records the old token, must not reconcile the replacement to that token,
    // or its later cleanup would delete the replacement.
    const { repoRoot, manager, handle, sessionId, recordedToken } = await recordedFixture(
      "aba-replacement",
      () => ({ token: "irrelevant" })
    );
    // Remove the original and create a replacement at the same name.
    git(repoRoot, "worktree", "remove", "--force", handle.path);
    git(repoRoot, "branch", "-D", "gateway/aba-replacement");
    const replacement = await createWorktree({
      repoRoot,
      name: "aba-replacement",
      logger: noopLogger,
    });
    const replacementToken = await readWorktreeOwnerToken(replacement.path, noopLogger);
    rmSync(join(replacement.adminDirectory, "gateway-owner.json"), { force: true });
    const runtime = resolveGatewayServerRuntime({ sessionManager: manager });

    await resolveWorktreeForRequest({ name: "aba-replacement" }, sessionId, runtime, {
      repoRoot,
    }).catch(() => undefined);

    // The replacement was NOT stamped with the original session's token.
    expect(await readWorktreeOwnerToken(replacement.path, noopLogger)).not.toBe(recordedToken);
    expect(replacementToken).not.toBe(recordedToken);
  });

  it("does NOT reconcile an UNREADABLE marker on the reuse path", async () => {
    // An unreadable marker (present but corrupt) is not an absent one: it could
    // be a live different creation whose marker is momentarily unreadable, so
    // reuse must refuse, not materialise over it.
    const { repoRoot, manager, handle, sessionId } = await recordedFixture(
      "reconcile-unreadable",
      () => ({ token: "irrelevant" })
    );
    const markerPath = join(handle.adminDirectory, "gateway-owner.json");
    writeFileSync(markerPath, "{ not json");
    const runtime = resolveGatewayServerRuntime({ sessionManager: manager });

    await expect(
      resolveWorktreeForRequest({ name: "reconcile-unreadable" }, sessionId, runtime, { repoRoot })
    ).rejects.toThrow(/Durable session worktree metadata no longer matches/);
    expect(readFileSync(markerPath, "utf8")).toBe("{ not json");
  });

  it("does NOT reconcile a marker with no adopter provenance (a different creation)", async () => {
    // A creation marker (no adoptedBy) that disagrees with the record is the ABA
    // case: a worktree the name was reused for after this session's was removed.
    // Reconcile must refuse, and reuse must throw, not stamp over it.
    const { repoRoot, manager, sessionId, handle } = await recordedFixture(
      "reconcile-foreign",
      () => ({
        token: "a-different-creations-token",
      })
    );
    const runtime = resolveGatewayServerRuntime({ sessionManager: manager });

    await expect(
      resolveWorktreeForRequest({ name: "reconcile-foreign" }, sessionId, runtime, { repoRoot })
    ).rejects.toThrow(/Durable session worktree metadata no longer matches/);
    // Left as found, not stamped to the recorded token.
    expect(await readWorktreeOwnerToken(handle.path, noopLogger)).toBe(
      "a-different-creations-token"
    );
  });

  it("does NOT reconcile a marker another session adopted", async () => {
    // Provenance is per session: a marker carrying a DIFFERENT session's
    // adoptedBy is not this session's to repair.
    const { repoRoot, manager, sessionId } = await recordedFixture("reconcile-other", () => ({
      token: "another-sessions-token",
      adoptedBy: "some-other-session-id",
    }));
    const runtime = resolveGatewayServerRuntime({ sessionManager: manager });

    await expect(
      resolveWorktreeForRequest({ name: "reconcile-other" }, sessionId, runtime, { repoRoot })
    ).rejects.toThrow(/Durable session worktree metadata no longer matches/);
  });

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

  it("RESTORES the overwritten marker when a reclaim's record loses a concurrent race", async () => {
    // The round-12 blocker (codex). recordsToken is read before an async admin-
    // directory lookup, so a concurrent same-session adoption can record the
    // token in that window; the stale snapshot then treats the live marker as a
    // strand and the reclaim overwrites it. The CAS is the arbiter: when it
    // loses, the marker it overwrote must be RESTORED, not deleted, or the live
    // worktree the winning CAS owns is bricked. Modelled deterministically: a
    // marker this session adopted and a store that does not (yet) record it, so
    // the reclaim fires, with the record CAS failing as the concurrent loser.
    const { repoRoot, manager, handle, sessionId } = await legacyFixture("concurrent");
    const liveToken = "token-a-concurrent-adoption-recorded";
    writeFileSync(
      join(handle.adminDirectory, "gateway-owner.json"),
      JSON.stringify({ token: liveToken, adoptedBy: sessionId })
    );
    // The record CAS loses to the concurrent adoption that landed first.
    manager.compareAndSetSession = () => false;
    const runtime = resolveGatewayServerRuntime({ sessionManager: manager });

    await resolveWorktreeForRequest({ name: "concurrent" }, sessionId, runtime, { repoRoot }).catch(
      () => undefined
    );

    // The overwritten live marker is put back, not deleted.
    expect(await readWorktreeOwnerToken(handle.path, noopLogger)).toBe(liveToken);
    expect(manager.getSession(sessionId)?.metadata?.worktreeToken).toBeUndefined();
  });

  it("wx lets only ONE of two fresh concurrent adoptions create a marker, so a both-read-absent race cannot strand", async () => {
    // The round-16 blocker, and the one case here that does NOT go through
    // resolveWorktreeForRequest. Two same-host instances reusing one pre-token
    // session both read the marker ABSENT and each writes a fresh one. The
    // marker read and the write are synchronous within a process, so this
    // interleaving cannot be produced by two concurrent production calls in a
    // single test; the `afterMarkerReadForTest` seam runs the second adoption to
    // completion inside the first's read-to-write window, which is the only place
    // `wx` acts. It makes the second exclusive create fail with EEXIST so exactly
    // one marker is ever written. The dropped-`wx` mutant (flag "w") lets the
    // loser clobber the winner's marker and then delete it on its lost record
    // CAS, leaving the store's token with no marker on disk: a permanent strand.
    type Adopted = Awaited<ReturnType<typeof adoptLegacyWorktreeIdentity>>;
    const { manager, handle, sessionId } = await legacyFixture("both-absent");
    const session = manager.getSession(sessionId)!;
    const recorded = new Set<string>();
    const recordsToken = (t: string): boolean => recorded.has(t);

    let second: Adopted = null;
    let interleaved = false;
    const first = await adoptLegacyWorktreeIdentity(session, {
      claimantsForPath: 1,
      recordsToken,
      logger: noopLogger,
      afterMarkerReadForTest: async () => {
        if (interleaved) return;
        interleaved = true;
        second = await adoptLegacyWorktreeIdentity(session, {
          claimantsForPath: 1,
          recordsToken,
          logger: noopLogger,
        });
      },
    });

    // The seam fired and the second, fully concurrent, fresh adoption ran; `wx`
    // then rejected the first call's own exclusive write (EEXIST), so it adopts
    // nothing. Under the mutant the first call instead clobbers and returns a
    // second live token, failing here.
    expect(interleaved).toBe(true);
    expect(second).not.toBeNull();
    expect(first).toBeNull();

    // Model the record CAS the production caller runs: the invocation that
    // returned first (the interleaved second call) records its token and wins; a
    // later one loses and withdraws its marker, exactly as
    // adoptWorktreeIdentityForSession does in its finally.
    const record = (r: Adopted): void => {
      if (!r) return;
      if (recorded.size === 0) recorded.add(r.token);
      else settleFailedAdoptionMarker(r.adminDirectory, r.token, r.priorMarker, noopLogger);
    };
    record(second);
    record(first);

    // Exactly one token recorded and the marker on disk names it: no strand.
    expect(recorded.size).toBe(1);
    const disk = await readWorktreeOwnerToken(handle.path, noopLogger);
    expect(disk).not.toBeNull();
    expect(disk).toBe([...recorded][0]);
  });

  it("withWorktreeAdoptionLock serializes concurrent holders on one worktree", async () => {
    // The round-16 blocker (codex): a three-party fresh + reclaim + reclaim race
    // still stranded because wx guards only the fresh-fresh write; a reclaim
    // overwrite and its restore/delete run unlocked. The fix serializes the whole
    // read-decide-write-record cycle, so mutual exclusion is the property that
    // closes the class. Here the second holder must not enter until the first
    // leaves; a lock that does not exclude (or a non-blocking acquire) fails.
    const { handle } = await legacyFixture("lock-mutex");
    const lockPath = join(handle.adminDirectory, "gateway-adopt.lock");
    let holderInside = false;
    let secondSawHolderInside: boolean | null = null;
    let releaseFirst: () => void = () => undefined;
    const firstReleased = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const first = withWorktreeAdoptionLock(handle.path, noopLogger, async () => {
      holderInside = true;
      await firstReleased;
      holderInside = false;
      return "first";
    });
    const start = Date.now();
    while (!holderInside) {
      if (Date.now() - start > 2000) throw new Error("first holder never entered the lock");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    // The lock file is present on disk while a holder is inside.
    expect(existsSync(lockPath)).toBe(true);
    const second = withWorktreeAdoptionLock(handle.path, noopLogger, async () => {
      secondSawHolderInside = holderInside;
      return "second";
    });
    // Give the second acquirer a generous window to (wrongly) run while the first
    // still holds the lock. It must still be blocked.
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(secondSawHolderInside).toBeNull();
    releaseFirst();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual({ locked: true, value: "first" });
    expect(b).toEqual({ locked: true, value: "second" });
    // When the second finally ran, the first had already exited: true serialization.
    expect(secondSawHolderInside).toBe(false);
    // The lock is released after the last holder.
    expect(existsSync(lockPath)).toBe(false);
  });

  it("runs adoption INSIDE the worktree lock at its production call site", async () => {
    // The lock closes the class only if the real adoption cycle actually runs
    // under it. Drop the lock wrapper from adoptWorktreeIdentityForSession and
    // adoptLegacyWorktreeIdentity runs with no lock file present, which this
    // catches. Spying the module the production caller imports also proves the
    // caller reaches the helper at all.
    const { repoRoot, manager, handle, sessionId } = await legacyFixture("lock-held");
    const runtime = resolveGatewayServerRuntime({ sessionManager: manager });
    const lockPath = join(handle.adminDirectory, "gateway-adopt.lock");
    const original = worktreeManager.adoptLegacyWorktreeIdentity;
    let sawLockHeld: boolean | null = null;
    const spy = vi
      .spyOn(worktreeManager, "adoptLegacyWorktreeIdentity")
      .mockImplementation((s, o) => {
        sawLockHeld = existsSync(lockPath);
        return original(s, o);
      });
    try {
      await resolveWorktreeForRequest({ name: handle.name }, sessionId, runtime, { repoRoot });
    } finally {
      spy.mockRestore();
    }
    expect(sawLockHeld).toBe(true);
    // Adoption still completed: record and marker agree.
    const token = manager.getSession(sessionId)?.metadata?.worktreeToken;
    expect(typeof token).toBe("string");
    expect(await readWorktreeOwnerToken(handle.path, noopLogger)).toBe(token);
  });

  it("converges when three adoptions of one session run concurrently, without a strand", async () => {
    // The lock makes the first adopter both write the marker AND win the record
    // CAS before any other runs, so a later reclaim's restore always restores the
    // winner's own token rather than a stale one, and no fresh loser deletes a
    // winner's marker. The end state is always the recorded token on disk.
    const { repoRoot, manager, handle, sessionId } = await legacyFixture("lock-converge");
    const runtime = resolveGatewayServerRuntime({ sessionManager: manager });
    const invoke = (): Promise<unknown> =>
      resolveWorktreeForRequest({ name: handle.name }, sessionId, runtime, { repoRoot }).then(
        value => value,
        error => error
      );

    await Promise.all([invoke(), invoke(), invoke()]);

    const token = manager.getSession(sessionId)?.metadata?.worktreeToken;
    expect(typeof token).toBe("string");
    const disk = await readWorktreeOwnerToken(handle.path, noopLogger);
    expect(disk).not.toBeNull();
    expect(disk).toBe(token);
    expect(git(repoRoot, "worktree", "list", "--porcelain")).toContain(handle.path);
  });

  it("reclaims a dead same-host holder's lock, but never a live holder regardless of age", async () => {
    // The round-17 blocker (codex): the lock's stale-window reclaim evicted a
    // live-but-slow holder (a long pause, a stalled CAS), so a successor ran
    // concurrently and reopened the three-party strand. Reclaim now keys ONLY on
    // a provably-dead same-host PID, never on age, so a running holder is never
    // displaced. A stuck lock defers adoption at the acquire timeout instead.
    const { handle } = await legacyFixture("lock-reclaim");
    const lockPath = join(handle.adminDirectory, "gateway-adopt.lock");

    // A live holder (this very process) with an ancient acquiredAt must NOT be
    // reclaimed: acquisition times out and adoption defers.
    writeFileSync(
      lockPath,
      JSON.stringify({ token: "live", pid: process.pid, hostname: hostname(), acquiredAt: 0 })
    );
    const blocked = await withWorktreeAdoptionLock(handle.path, noopLogger, async () => "ran", {
      timeoutMs: 300,
      retryMs: 20,
    });
    expect(blocked).toEqual({ locked: false });
    expect(existsSync(lockPath)).toBe(true);
    expect((JSON.parse(readFileSync(lockPath, "utf8")) as { token: string }).token).toBe("live");

    // A dead same-host PID IS reclaimed, so the guard is not simply inert.
    let deadPid = 2 ** 22;
    while (deadPid > 1) {
      try {
        process.kill(deadPid, 0);
        deadPid -= 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
        deadPid -= 1;
      }
    }
    writeFileSync(
      lockPath,
      JSON.stringify({ token: "dead", pid: deadPid, hostname: hostname(), acquiredAt: Date.now() })
    );
    const acquired = await withWorktreeAdoptionLock(handle.path, noopLogger, async () => "ran", {
      timeoutMs: 2000,
      retryMs: 20,
    });
    expect(acquired).toEqual({ locked: true, value: "ran" });
  });

  it("self-heals an orphan recovery lock, but never steals a live reclaimer's", async () => {
    // The round-18 blocker (codex): a reclaimer that crashes after creating the
    // companion recovery lock but before its finally removes it leaves an orphan
    // that blocked EVERY future reclaim of the dead primary forever, a permanent
    // strand from one crash. An orphan recovery lock (a same-host dead PID, or no
    // provenance at all) is now cleared; a live reclaimer's is still respected.
    const { handle } = await legacyFixture("recovery-orphan");
    const lockPath = join(handle.adminDirectory, "gateway-adopt.lock");
    const recoveryPath = `${lockPath}.recovery`;
    let deadPid = 2 ** 22;
    while (deadPid > 1) {
      try {
        process.kill(deadPid, 0);
        deadPid -= 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
        deadPid -= 1;
      }
    }

    // A crashed holder (dead-PID primary) plus an orphan, empty recovery lock a
    // reclaimer left when it crashed right after creating it.
    writeFileSync(lockPath, JSON.stringify({ token: "dead", pid: deadPid, hostname: hostname() }));
    writeFileSync(recoveryPath, "");
    const healed = await withWorktreeAdoptionLock(handle.path, noopLogger, async () => "ran", {
      timeoutMs: 2000,
      retryMs: 20,
    });
    expect(healed).toEqual({ locked: true, value: "ran" });
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(recoveryPath)).toBe(false);

    // A recovery lock held by a LIVE reclaimer (this process) must NOT be stolen.
    writeFileSync(lockPath, JSON.stringify({ token: "dead2", pid: deadPid, hostname: hostname() }));
    writeFileSync(recoveryPath, JSON.stringify({ pid: process.pid, hostname: hostname() }));
    const blocked = await withWorktreeAdoptionLock(handle.path, noopLogger, async () => "ran", {
      timeoutMs: 300,
      retryMs: 20,
    });
    expect(blocked).toEqual({ locked: false });
    expect(existsSync(recoveryPath)).toBe(true);
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
