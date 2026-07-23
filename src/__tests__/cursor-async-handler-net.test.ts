import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AsyncJobManager } from "../async-job-manager.js";
import type { ISessionManager, Session } from "../session-manager.js";

// RequestPipeline async A1 characterization net: pins handleCursorRequestAsync after
// routing through runAsyncEnqueueEnvelope (the minimal non-Kit async sibling, no worktree
// lifecycle). cursor async is pure Mode C: it startJob()s (fire-and-forget), so the
// envelope drives runInsideTry -> enqueue -> settle(null, a no-op for cursor) -> usage ->
// log -> success JSON, and rolls the admission back only when the enqueue never handed off.

vi.mock("../executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../executor.js")>();
  return {
    ...actual,
    getExtendedPath: vi.fn(() => process.env.PATH || ""),
  };
});

const { assertUpstreamCliArgsMock } = vi.hoisted(() => ({
  assertUpstreamCliArgsMock: vi.fn(),
}));
vi.mock("../upstream-contracts.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../upstream-contracts.js")>();
  assertUpstreamCliArgsMock.mockImplementation(actual.assertUpstreamCliArgs);
  return { ...actual, assertUpstreamCliArgs: assertUpstreamCliArgsMock };
});

let shimDir: string;
let originalPath: string;

beforeAll(() => {
  shimDir = mkdtempSync(join(tmpdir(), "cursor-async-shim-"));
  const shimScript = join(shimDir, "cursor-agent");
  writeFileSync(shimScript, '#!/bin/sh\necho "cursor response: $*"\nexit 0\n');
  chmodSync(shimScript, 0o755);
  originalPath = process.env.PATH || "";
  process.env.PATH = `${shimDir}:${originalPath}`;
});

afterAll(() => {
  process.env.PATH = originalPath;
  rmSync(shimDir, { recursive: true, force: true });
});

const noopLogger = {
  info: (..._args: unknown[]) => {},
  warn: (..._args: unknown[]) => {},
  error: (..._args: unknown[]) => {},
  debug: (..._args: unknown[]) => {},
};

function mockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: overrides.id || "test-session",
    cli: overrides.cli || "cursor",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    description: "Test Session",
    generation: "gen-1",
    ...overrides,
  };
}

function mockSessionManager(sessions: Map<string, Session> = new Map()): ISessionManager {
  return {
    createSession: vi.fn(async (cli, _desc, id) => {
      const session = mockSession({ id: id || `gw-${sessions.size}`, cli });
      sessions.set(session.id, session);
      return session;
    }),
    getSession: vi.fn(async id => sessions.get(id) || null),
    listSessions: vi.fn(async () => [...sessions.values()]),
    deleteSession: vi.fn(async id => sessions.delete(id)),
    setActiveSession: vi.fn(async () => true),
    getActiveSession: vi.fn(async () => null),
    updateSessionUsage: vi.fn(async () => {}),
    updateSessionMetadata: vi.fn(async () => true),
    clearAllSessions: vi.fn(async () => 0),
    compareAndSetSession: vi.fn(async () => true),
  } as unknown as ISessionManager;
}

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    prompt: "characterize a cursor async path",
    resumeLatest: false,
    createNewSession: false,
    approvalStrategy: "legacy" as const,
    optimizePrompt: false,
    ...overrides,
  };
}

describe("handleCursorRequestAsync async-enqueue envelope (A1)", () => {
  let handleCursorRequestAsync: (typeof import("../index.js"))["handleCursorRequestAsync"];

  beforeAll(async () => {
    const mod = await import("../index.js");
    handleCursorRequestAsync = mod.handleCursorRequestAsync;
  });

  it("fresh (no session): enqueues once, mints a tracking-only gw- session, usage NOT updated (D4)", async () => {
    const sm = mockSessionManager();
    const ajm = new AsyncJobManager(noopLogger);
    const startJob = vi.spyOn(ajm, "startJob");

    const result = await handleCursorRequestAsync(
      { sessionManager: sm, asyncJobManager: ajm, logger: noopLogger },
      baseParams({ correlationId: "cu-async-fresh" }) as never
    );

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(true);
    expect(body.job?.id).toBeDefined();
    expect(body.sessionId).toMatch(/^gw-/);
    // cursor mints a tracking-only session on a fresh request.
    expect(body.gatewaySessionId).toMatch(/^gw-/);
    expect(body.resumable).toBe(false);
    expect(startJob).toHaveBeenCalledTimes(1);
    expect(sm.createSession).toHaveBeenCalledTimes(1);
    // D4: a minted (not user-provided) session gets NO durable usage update.
    expect(sm.updateSessionUsage).not.toHaveBeenCalled();

    ajm.cancelJob(body.job.id);
    await ajm.dispose();
  });

  it("user-provided session: resumable, usage IS updated for the provided id (D4)", async () => {
    const sm = mockSessionManager();
    const ajm = new AsyncJobManager(noopLogger);
    const startJob = vi.spyOn(ajm, "startJob");

    const result = await handleCursorRequestAsync(
      { sessionManager: sm, asyncJobManager: ajm, logger: noopLogger },
      baseParams({ sessionId: "user-abc", correlationId: "cu-async-user" }) as never
    );

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.sessionId).toBe("user-abc");
    expect(body.resumable).toBe(true);
    expect(startJob).toHaveBeenCalledTimes(1);
    expect(sm.updateSessionUsage).toHaveBeenCalledWith("user-abc");

    ajm.cancelJob(body.job.id);
    await ajm.dispose();
  });

  it("worktree-resolve ok:false seam: id cursor_request_async, no job started", async () => {
    const sm = mockSessionManager();
    const ajm = new AsyncJobManager(noopLogger);
    const startJob = vi.spyOn(ajm, "startJob");

    // A relative addDir with no working dir throws inside resolveWorkspaceAndWorktreeForRequest,
    // which runInsideTry catches into { ok:false, earlyResponse: createErrorResponse(...) }.
    const result = await handleCursorRequestAsync(
      { sessionManager: sm, asyncJobManager: ajm, logger: noopLogger },
      baseParams({ addDir: ["relative/sub"], correlationId: "cu-async-wt" }) as never
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.cli).toBe("cursor_request_async");
    expect(startJob).not.toHaveBeenCalled();

    await ajm.dispose();
  });

  it("argv/assert throw routes to the envelope catch: id cursor_request_async, no job started", async () => {
    const sm = mockSessionManager();
    const ajm = new AsyncJobManager(noopLogger);
    const startJob = vi.spyOn(ajm, "startJob");
    assertUpstreamCliArgsMock.mockImplementationOnce(() => {
      throw new Error("argv admission rejected");
    });

    const result = await handleCursorRequestAsync(
      { sessionManager: sm, asyncJobManager: ajm, logger: noopLogger },
      baseParams({ correlationId: "cu-async-argv" }) as never
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.cli).toBe("cursor_request_async");
    expect(startJob).not.toHaveBeenCalled();

    await ajm.dispose();
  });

  it("committed admission + enqueue throw before handoff: the driver unwinds the admission", async () => {
    // The only path that reaches rollbackOnException with ledger.sessionAdmission actually
    // SET: a fresh-mint request admits a (tracking-only) session in runInsideTry, then the
    // enqueue's startJob throws before jobHandedOff. This is the byte-changed rollback
    // (inline `if (!jobHandedOff) rollbackSessionAndWorktreeAdmission(...)` -> the ledger's
    // rollbackOnException(null, mgr)); it must actually unwind the minted admission.
    const sm = mockSessionManager();
    const ajm = new AsyncJobManager(noopLogger);
    const startJob = vi.spyOn(ajm, "startJob").mockImplementation(() => {
      throw new Error("enqueue blew up");
    });

    const result = await handleCursorRequestAsync(
      { sessionManager: sm, asyncJobManager: ajm, logger: noopLogger },
      baseParams({ correlationId: "cu-async-rollback" }) as never
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.cli).toBe("cursor_request_async");
    // The admission was committed (mint) and the enqueue was attempted...
    expect(sm.createSession).toHaveBeenCalledTimes(1);
    expect(startJob).toHaveBeenCalledTimes(1);
    // ...so the catch actually unwound it via rollbackSessionAndWorktreeAdmission ->
    // rollbackSessionAdmission -> compareAndSetSession (a no-op short-circuit would NOT
    // have called it, since sessionAdmission was undefined in the other rollback tests).
    expect(sm.compareAndSetSession).toHaveBeenCalledTimes(1);

    await ajm.dispose();
  });

  it("anti-orphan: session-manager failure before handoff => no job started", async () => {
    const throwingSm = mockSessionManager();
    (throwingSm.createSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB down"));
    const ajm = new AsyncJobManager(noopLogger);
    const startJob = vi.spyOn(ajm, "startJob");

    const result = await handleCursorRequestAsync(
      { sessionManager: throwingSm, asyncJobManager: ajm, logger: noopLogger },
      baseParams({ correlationId: "cu-async-orphan" }) as never
    );

    expect(result.isError).toBe(true);
    expect(startJob).not.toHaveBeenCalled();

    await ajm.dispose();
  });
});
