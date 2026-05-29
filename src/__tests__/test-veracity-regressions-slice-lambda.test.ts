/**
 * Phase 4 slice λ — test-veracity regressions for gateway-owned worktree
 * lifecycle.
 *
 * Mirrors the REGRESSIONS pattern from slices ε / ζ / η / θ / κ. Each
 * test block below is mutation-probe-friendly; the audit spec at
 * `docs/plans/slice-lambda.spec.md` §"Test surfaces" documents the
 * counterexample mutation each LLM reviewer must run before approving
 * this slice.
 *
 * Probe targets:
 *
 *   Lα — sanitizeWorktreeName path-traversal defence.
 *   Lβ — createWorktree rev-parses ref before `git worktree add`.
 *   Lγ — resolveWorktreeForRequest writes worktreePath onto session metadata.
 *   Lδ — resolveWorktreeForRequest reuses an existing per-session worktree.
 *   Lε — FileSessionManager.deleteSession invokes the cleanup hook BEFORE removal.
 *   Lζ — executor.executeCli honors the cwd option (regression mirror).
 *   Lη — No CLI receives -w or --worktree in emitted argv (all 5 CLIs).
 *   Lθ — AsyncJobManager dedup key includes cwd (different worktrees
 *        with identical argv do NOT collide).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  formatWorktreePrefix,
  prepareClaudeRequest,
  prepareCodexRequest,
  prepareGeminiRequest,
  prepareGrokRequest,
  prepareMistralRequest,
  resolveGatewayServerRuntime,
  resolveWorktreeForRequest,
} from "../index.js";
import { createWorktree, sanitizeWorktreeName, WorktreeError } from "../worktree-manager.js";
import { FileSessionManager, type Session } from "../session-manager.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import { executeCli } from "../executor.js";
import { noopLogger } from "../logger.js";

/**
 * Create a fully initialised tmp git repo so `git worktree add` has
 * something to branch from. The repo lives in tmpdir() and is cleaned
 * up in afterEach.
 */
function initRepo(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), "lambda-reg-"));
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

function rmTree(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

const BASE_CLAUDE = {
  prompt: "hello",
  outputFormat: "text" as const,
  dangerouslySkipPermissions: false,
  approvalStrategy: "legacy" as const,
  mcpServers: [] as never[],
  strictMcpConfig: false,
  optimizePrompt: false,
  operation: "claude_request",
};
const BASE_CODEX = {
  prompt: "hello",
  fullAuto: false,
  dangerouslyBypassApprovalsAndSandbox: false,
  approvalStrategy: "legacy" as const,
  mcpServers: [] as never[],
  optimizePrompt: false,
  operation: "codex_request",
};
const BASE_GEMINI = {
  prompt: "hello",
  approvalStrategy: "legacy" as const,
  optimizePrompt: false,
  operation: "gemini_request",
};
const BASE_GROK = {
  prompt: "hello",
  approvalStrategy: "legacy" as const,
  optimizePrompt: false,
  operation: "grok_request",
};
const BASE_MISTRAL = {
  prompt: "hello",
  approvalStrategy: "legacy" as const,
  optimizePrompt: false,
  operation: "mistral_request",
};

// ─── REGRESSIONS Lα — sanitizeWorktreeName path-traversal defence ───────
//
// Falsifiability: drop the slash/`..`/leading-dot guards from
// `sanitizeWorktreeName`. Each rejection below MUST go red. (Full
// coverage lives in `worktree-manager.test.ts`; this REGRESSIONS block
// preserves the falsifiability index so audit reviewers find it here.)

describe("REGRESSIONS Lα — sanitizeWorktreeName rejects path traversal (slice λ)", () => {
  it("Lα-1: rejects '..' / leading dot / leading hyphen / slashes / whitespace", () => {
    expect(() => sanitizeWorktreeName("..")).toThrow(WorktreeError);
    expect(() => sanitizeWorktreeName("../etc")).toThrow(WorktreeError);
    expect(() => sanitizeWorktreeName("foo/bar")).toThrow(WorktreeError);
    expect(() => sanitizeWorktreeName("foo\\bar")).toThrow(WorktreeError);
    expect(() => sanitizeWorktreeName(".hidden")).toThrow(WorktreeError);
    expect(() => sanitizeWorktreeName("-flag")).toThrow(WorktreeError);
    expect(() => sanitizeWorktreeName("name with space")).toThrow(WorktreeError);
    expect(() => sanitizeWorktreeName("")).toThrow(WorktreeError);
  });

  it("Lα-2: accepts the canonical safe shape `[A-Za-z0-9._-]{1,64}`", () => {
    expect(sanitizeWorktreeName("alpha_beta-1.0")).toBe("alpha_beta-1.0");
    expect(sanitizeWorktreeName("a".repeat(64))).toBe("a".repeat(64));
    expect(() => sanitizeWorktreeName("a".repeat(65))).toThrow(WorktreeError);
  });
});

// ─── REGRESSIONS Lβ — createWorktree rev-parses ref ─────────────────────
//
// Falsifiability: in `createWorktree`, change
//   `git("rev-parse", "--verify", refArg + "^{commit}")` to passing
// `refArg` directly to `git worktree add`. Lβ-1 MUST go red.

describe("REGRESSIONS Lβ — createWorktree resolves ref before `git worktree add` (slice λ)", () => {
  let repoRoot: string;
  beforeEach(() => {
    repoRoot = initRepo();
  });
  afterEach(() => {
    rmTree(repoRoot);
  });

  it("Lβ-1: when ref defaults to HEAD, handle.ref is the 40-char rev-parsed SHA, not the literal 'HEAD'", async () => {
    const handle = await createWorktree({ repoRoot, logger: noopLogger });
    expect(handle.ref).toMatch(/^[0-9a-f]{40}$/);
    expect(handle.ref).not.toBe("HEAD");
  });

  it("Lβ-2: an unresolvable ref surfaces a WorktreeError with the original ref name", async () => {
    await expect(
      createWorktree({ repoRoot, name: "bad", ref: "nope-not-a-ref", logger: noopLogger })
    ).rejects.toThrow(/nope-not-a-ref/);
  });
});

// ─── REGRESSIONS Lγ — resolveWorktreeForRequest persists session metadata
//
// Falsifiability: remove the
//   `sessionManager.updateSessionMetadata(sessionId, { worktreePath ... })`
// call in `resolveWorktreeForRequest`. Lγ-1 MUST go red.

describe("REGRESSIONS Lγ — resolveWorktreeForRequest writes worktreePath onto session metadata (slice λ)", () => {
  let repoRoot: string;
  let sessionsPath: string;
  let originalCwd: string;

  beforeEach(() => {
    repoRoot = initRepo();
    sessionsPath = join(mkdtempSync(join(tmpdir(), "lambda-reg-sess-")), "sessions.json");
    originalCwd = process.cwd();
    process.chdir(repoRoot);
  });
  afterEach(() => {
    process.chdir(originalCwd);
    rmTree(repoRoot);
    rmTree(sessionsPath);
  });

  it("Lγ-1: after `resolveWorktreeForRequest(true, sessionId, runtime)` the session's metadata.worktreePath equals the created handle path", async () => {
    const sm = new FileSessionManager(sessionsPath);
    const session = sm.createSession("claude", "test-session");
    const runtime = resolveGatewayServerRuntime({ sessionManager: sm });

    const resolution = await resolveWorktreeForRequest(true, session.id, runtime);

    expect(resolution.cwd).toBeDefined();
    expect(resolution.worktreePath).toBe(resolution.cwd);
    expect(resolution.cwd).toContain(`${repoRoot}/.worktrees/`);

    const after = sm.getSession(session.id)!;
    expect(after.metadata?.worktreePath).toBe(resolution.worktreePath);
    expect(after.metadata?.worktreeName).toBeDefined();
    expect(typeof after.metadata?.worktreeName).toBe("string");
  });

  it("Lγ-2: when no session is supplied the worktree is created but no persistence happens", async () => {
    const sm = new FileSessionManager(sessionsPath);
    const runtime = resolveGatewayServerRuntime({ sessionManager: sm });

    const resolution = await resolveWorktreeForRequest(true, undefined, runtime);
    expect(resolution.worktreePath).toBeDefined();
    expect(existsSync(resolution.worktreePath!)).toBe(true);
    // No session exists → no metadata to inspect; just confirm listSessions stays empty.
    expect(sm.listSessions().length).toBe(0);
  });

  it("Lγ-3: when worktreeOpt is undefined/false the helper returns {} and does NOT touch session metadata", async () => {
    const sm = new FileSessionManager(sessionsPath);
    const session = sm.createSession("claude", "no-worktree-test");
    const runtime = resolveGatewayServerRuntime({ sessionManager: sm });

    const r1 = await resolveWorktreeForRequest(undefined, session.id, runtime);
    const r2 = await resolveWorktreeForRequest(false, session.id, runtime);
    expect(r1).toEqual({});
    expect(r2).toEqual({});

    const after = sm.getSession(session.id)!;
    expect(after.metadata?.worktreePath).toBeUndefined();
  });
});

// ─── REGRESSIONS Lδ — same-session worktree reuse ──────────────────────
//
// Falsifiability: in `resolveWorktreeForRequest`, always call
// `createWorktree` (skip the session-metadata reuse branch). Lδ-1 MUST
// go red — the second call would invoke createWorktree a second time
// (which would either reuse via git's worktree list OR collide), and
// the path would diverge if a fresh UUID was generated.

describe("REGRESSIONS Lδ — resolveWorktreeForRequest reuses an existing per-session worktree (slice λ)", () => {
  let repoRoot: string;
  let sessionsPath: string;
  let originalCwd: string;

  beforeEach(() => {
    repoRoot = initRepo();
    sessionsPath = join(mkdtempSync(join(tmpdir(), "lambda-reg-sess-")), "sessions.json");
    originalCwd = process.cwd();
    process.chdir(repoRoot);
  });
  afterEach(() => {
    process.chdir(originalCwd);
    rmTree(repoRoot);
    rmTree(sessionsPath);
  });

  it("Lδ-1: a second resolve on the same sessionId returns the SAME path without creating a new worktree", async () => {
    const sm = new FileSessionManager(sessionsPath);
    const session = sm.createSession("claude", "reuse-test");
    const runtime = resolveGatewayServerRuntime({ sessionManager: sm });

    const first = await resolveWorktreeForRequest(true, session.id, runtime);
    expect(first.worktreePath).toBeDefined();

    // Spy on createWorktree by counting git worktree list entries before
    // and after the second call. If the second call took the reuse
    // branch (skipped createWorktree), the count stays the same.
    const beforeList = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const second = await resolveWorktreeForRequest(true, session.id, runtime);
    const afterList = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(second.worktreePath).toBe(first.worktreePath);
    expect(second.cwd).toBe(first.cwd);
    expect(afterList).toBe(beforeList);
  });

  it("Lδ-2: a different sessionId triggers a fresh worktree at a NEW path", async () => {
    const sm = new FileSessionManager(sessionsPath);
    const sessionA = sm.createSession("claude", "sess-A");
    const sessionB = sm.createSession("claude", "sess-B");
    const runtime = resolveGatewayServerRuntime({ sessionManager: sm });

    const a = await resolveWorktreeForRequest(true, sessionA.id, runtime);
    const b = await resolveWorktreeForRequest(true, sessionB.id, runtime);
    expect(b.worktreePath).not.toBe(a.worktreePath);
  });
});

// ─── REGRESSIONS Lε — session_delete fires the cleanup hook ─────────────
//
// Falsifiability: in `FileSessionManager.deleteSession`, comment out the
// `this.invokeCleanupHook(session)` call. Lε-1 MUST go red.

describe("REGRESSIONS Lε — FileSessionManager.deleteSession invokes cleanup hook (slice λ)", () => {
  let sessionsPath: string;
  beforeEach(() => {
    sessionsPath = join(mkdtempSync(join(tmpdir(), "lambda-reg-sess-")), "sessions.json");
  });
  afterEach(() => {
    rmTree(sessionsPath);
  });

  it("Lε-1: deleteSession calls cleanupHook with the session BEFORE removing the record", async () => {
    const seen: { id: string; metadata?: Session["metadata"] }[] = [];
    let storageAtHookFireTime: Session[] | null = null;
    const hook = vi.fn(async (session: Session) => {
      seen.push({ id: session.id, metadata: session.metadata });
      // Snapshot list while the hook is mid-flight so we can confirm
      // the session record is still present when the hook is fired.
      storageAtHookFireTime = sm.listSessions();
    });
    const sm = new FileSessionManager(sessionsPath, undefined, {
      cleanupHook: hook,
      logger: noopLogger,
    });
    const session = sm.createSession("claude", "to-be-deleted");
    sm.updateSessionMetadata(session.id, {
      worktreePath: "/tmp/fake/.worktrees/abc",
      worktreeName: "abc",
    });

    const ok = sm.deleteSession(session.id);
    expect(ok).toBe(true);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(seen[0].id).toBe(session.id);
    expect(seen[0].metadata?.worktreePath).toBe("/tmp/fake/.worktrees/abc");
    // The "before" invariant: when the hook fired the session still
    // existed in storage. Mutation probe (move invokeCleanupHook AFTER
    // delete) makes this assertion go red.
    expect(storageAtHookFireTime).not.toBeNull();
    expect(storageAtHookFireTime!.some(s => s.id === session.id)).toBe(true);
    // Now the record is gone.
    expect(sm.getSession(session.id)).toBeNull();
  });

  it("Lε-2: deleteSession returns false (and does NOT fire the hook) for an unknown id", () => {
    const hook = vi.fn();
    const sm = new FileSessionManager(sessionsPath, undefined, { cleanupHook: hook });
    expect(sm.deleteSession("not-a-real-id")).toBe(false);
    expect(hook).not.toHaveBeenCalled();
  });

  it("Lε-3: cleanup hook failure is logged but does NOT block session removal", async () => {
    const hook = vi.fn(async () => {
      throw new Error("cleanup boom");
    });
    const sm = new FileSessionManager(sessionsPath, undefined, {
      cleanupHook: hook,
      logger: noopLogger,
    });
    const session = sm.createSession("claude", "hook-failure");
    expect(sm.deleteSession(session.id)).toBe(true);
    expect(sm.getSession(session.id)).toBeNull();
    // Allow the rejected promise to settle so vitest doesn't flag it.
    await new Promise(resolve => setImmediate(resolve));
  });
});

// ─── REGRESSIONS Lζ — executor.executeCli honors cwd ────────────────────
//
// Falsifiability: drop `cwd` from the spawn options in
// `executor.executeCli`. Lζ-1 MUST go red. (Full coverage lives in
// `executor.test.ts` "working directory" block; this REGRESSIONS block
// is the falsifiability index entry for slice-λ reviewers.)

describe("REGRESSIONS Lζ — executor.executeCli honors cwd (slice λ)", () => {
  it("Lζ-1: spawning `pwd` with cwd=<tmp> returns the tmp path on stdout", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "lambda-reg-cwd-"));
    try {
      const result = await executeCli("pwd", [], { cwd: tmp });
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe(tmp);
    } finally {
      rmTree(tmp);
    }
  });
});

// ─── REGRESSIONS Lη — gateway-owned model emits NO -w/--worktree argv ──
//
// Falsifiability: in any `prepareXRequest` (or any tool handler), add
// `args.push("-w")` or `args.push("--worktree", "...")`. Lη-1..5 MUST
// go red — the assertion below checks all 5 CLIs.

describe("REGRESSIONS Lη — no CLI receives -w / --worktree in emitted argv (slice λ)", () => {
  it("Lη-1: prepareClaudeRequest argv contains neither -w nor --worktree", () => {
    const prep = prepareClaudeRequest(BASE_CLAUDE as never);
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).not.toContain("-w");
    expect(prep.args).not.toContain("--worktree");
  });
  it("Lη-2: prepareCodexRequest argv contains neither -w nor --worktree", () => {
    const prep = prepareCodexRequest(BASE_CODEX as never);
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).not.toContain("-w");
    expect(prep.args).not.toContain("--worktree");
  });
  it("Lη-3: prepareGeminiRequest argv contains neither -w nor --worktree", () => {
    const prep = prepareGeminiRequest(BASE_GEMINI as never);
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).not.toContain("-w");
    expect(prep.args).not.toContain("--worktree");
  });
  it("Lη-4: prepareGrokRequest argv contains neither -w nor --worktree", () => {
    const prep = prepareGrokRequest(BASE_GROK as never);
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).not.toContain("-w");
    expect(prep.args).not.toContain("--worktree");
  });
  it("Lη-5: prepareMistralRequest argv contains neither -w nor --worktree", () => {
    const prep = prepareMistralRequest(BASE_MISTRAL as never);
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).not.toContain("-w");
    expect(prep.args).not.toContain("--worktree");
  });
});

// ─── REGRESSIONS Lθ — async-job-manager dedup key includes cwd ──────────
//
// Falsifiability: in `async-job-manager.buildRequestKey`, omit `cwd`
// from the key string. Lθ-1 MUST go red — the second call would dedup
// onto the first even though it ran in a different worktree.

describe("REGRESSIONS Lθ — AsyncJobManager dedup key includes cwd (slice λ)", () => {
  it("Lθ-1: two jobs with identical argv but different cwd do NOT dedup", () => {
    const mgr = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    const a = mgr.startJobWithDedup("claude", ["sleep", "30"], "corr-a", {
      cwd: "/tmp/wt-A",
    });
    const b = mgr.startJobWithDedup("claude", ["sleep", "30"], "corr-b", {
      cwd: "/tmp/wt-B",
    });
    expect(b.deduped).toBe(false);
    expect(b.snapshot.id).not.toBe(a.snapshot.id);
    mgr.cancelJob(a.snapshot.id);
    mgr.cancelJob(b.snapshot.id);
  });

  it("Lθ-2: two jobs with identical argv AND identical cwd DO dedup (regression — pre-λ behaviour preserved)", () => {
    const mgr = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    const a = mgr.startJobWithDedup("claude", ["sleep", "30"], "corr-a", {
      cwd: "/tmp/wt-same",
    });
    const b = mgr.startJobWithDedup("claude", ["sleep", "30"], "corr-b", {
      cwd: "/tmp/wt-same",
    });
    expect(b.deduped).toBe(true);
    expect(b.snapshot.id).toBe(a.snapshot.id);
    mgr.cancelJob(a.snapshot.id);
  });

  it("Lθ-3: omitting cwd entirely on both calls preserves the pre-λ dedup behaviour (regression)", () => {
    const mgr = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    const a = mgr.startJobWithDedup("claude", ["sleep", "30"], "corr-a", {});
    const b = mgr.startJobWithDedup("claude", ["sleep", "30"], "corr-b", {});
    expect(b.deduped).toBe(true);
    expect(b.snapshot.id).toBe(a.snapshot.id);
    mgr.cancelJob(a.snapshot.id);
  });
});

// ─── Helper: formatWorktreePrefix shape (envelope-decision regression) ──
//
// Falsifiability: change the prefix format (e.g. drop the trailing \n
// or change the `[gateway] worktree=` literal). Any caller that splits
// on the literal would break — Lψ-1 catches it.

describe("REGRESSIONS Lψ — formatWorktreePrefix shape locked (slice λ §1.d)", () => {
  it("Lψ-1: returns `[gateway] worktree=<path>\\n` when a path is supplied", () => {
    expect(formatWorktreePrefix("/tmp/wt-1")).toBe("[gateway] worktree=/tmp/wt-1\n");
  });
  it("Lψ-2: returns the empty string when no path is supplied (so non-λ tool responses are byte-identical)", () => {
    expect(formatWorktreePrefix(undefined)).toBe("");
    expect(formatWorktreePrefix("")).toBe("");
  });
});
