import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AsyncJobManager } from "../async-job-manager.js";
import type { ISessionManager, Session } from "../session-manager.js";

// RequestPipeline async A3 characterization net: pins handleGeminiRequestAsync after routing
// through runAsyncEnqueueEnvelope. gemini is the non-Kit async OUTLIER: it NEVER mints a
// session (effectiveSessionId = sessionPlan.resumed ? params.sessionId : undefined), its
// existing-session lookup is UNCONDITIONAL, and its usage id is passed DIRECT (no D4 split).
// Like grok it installs a worktree lifecycle, so ledger.installWorktree(...) makes
// ledger.settle(null) reproduce the inline transfer/finishHandler and the catch's
// rollbackOnException(null, mgr) the `if (!jobHandedOff)` unwind. Pure Mode C: startJob()
// fire-and-forget, no in-handler flight completion / recordRequest / finally.

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
  shimDir = mkdtempSync(join(tmpdir(), "gemini-async-shim-"));
  const shimScript = join(shimDir, "agy");
  writeFileSync(shimScript, '#!/bin/sh\necho "agy response: $*"\nexit 0\n');
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
    cli: overrides.cli || "gemini",
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
    prompt: "characterize a gemini async path",
    resumeLatest: false,
    createNewSession: false,
    approvalStrategy: "legacy" as const,
    optimizePrompt: false,
    ...overrides,
  };
}

describe("handleGeminiRequestAsync async-enqueue envelope (A3)", () => {
  let handleGeminiRequestAsync: (typeof import("../index.js"))["handleGeminiRequestAsync"];

  beforeAll(async () => {
    const mod = await import("../index.js");
    handleGeminiRequestAsync = mod.handleGeminiRequestAsync;
  });

  it("fresh (no session): NEVER mints, sessionId null + resumable false, no createSession, no usage, approval+mcpServers present", async () => {
    const sm = mockSessionManager();
    const ajm = new AsyncJobManager(noopLogger);
    const startJob = vi.spyOn(ajm, "startJob");

    const result = await handleGeminiRequestAsync(
      { sessionManager: sm, asyncJobManager: ajm, logger: noopLogger },
      baseParams({ correlationId: "ge-async-fresh" }) as never
    );

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(true);
    expect(body.job?.id).toBeDefined();
    // gemini is the outlier: NO mint on a fresh request => sessionId null, not a gw- id.
    expect(body.sessionId).toBeNull();
    expect(body.resumable).toBe(false);
    expect(body.approval).toBeDefined();
    expect(body.mcpServers).toEqual({ requested: [] });
    expect(startJob).toHaveBeenCalledTimes(1);
    // No mint => no session created and no usage update.
    expect(sm.createSession).not.toHaveBeenCalled();
    expect(sm.updateSessionUsage).not.toHaveBeenCalled();

    ajm.cancelJob(body.job.id);
    await ajm.dispose();
  });

  it("resumed (user session): resumable true, unconditional lookup + admission, usage updated DIRECT with the id", async () => {
    const sm = mockSessionManager();
    const ajm = new AsyncJobManager(noopLogger);
    const startJob = vi.spyOn(ajm, "startJob");

    const result = await handleGeminiRequestAsync(
      { sessionManager: sm, asyncJobManager: ajm, logger: noopLogger },
      baseParams({ sessionId: "user-gemini-abc", correlationId: "ge-async-user" }) as never
    );

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.sessionId).toBe("user-gemini-abc");
    expect(body.resumable).toBe(true);
    expect(startJob).toHaveBeenCalledTimes(1);
    // Unconditional lookup miss => the resumed session is admitted, then usage is updated
    // DIRECT with effectiveSessionId (no userProvided ? id : undefined split).
    expect(sm.createSession).toHaveBeenCalledTimes(1);
    expect(sm.updateSessionUsage).toHaveBeenCalledWith("user-gemini-abc");

    ajm.cancelJob(body.job.id);
    await ajm.dispose();
  });

  it("argv/assert throw routes to the envelope catch: id gemini_request_async, no job started", async () => {
    const sm = mockSessionManager();
    const ajm = new AsyncJobManager(noopLogger);
    const startJob = vi.spyOn(ajm, "startJob");
    assertUpstreamCliArgsMock.mockImplementationOnce(() => {
      throw new Error("argv admission rejected");
    });

    const result = await handleGeminiRequestAsync(
      { sessionManager: sm, asyncJobManager: ajm, logger: noopLogger },
      baseParams({ correlationId: "ge-async-argv" }) as never
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.cli).toBe("gemini_request_async");
    expect(startJob).not.toHaveBeenCalled();

    await ajm.dispose();
  });

  it("committed admission + enqueue throw before handoff: the driver unwinds the admission", async () => {
    // A resumed (user) session is admitted in runInsideTry (createSessionWithResolvedScope),
    // then the enqueue's startJob throws before jobHandedOff. The byte-changed rollback
    // (ledger.rollbackOnException(null, mgr)) must actually unwind the admission.
    const sm = mockSessionManager();
    const ajm = new AsyncJobManager(noopLogger);
    const startJob = vi.spyOn(ajm, "startJob").mockImplementation(() => {
      throw new Error("enqueue blew up");
    });

    const result = await handleGeminiRequestAsync(
      { sessionManager: sm, asyncJobManager: ajm, logger: noopLogger },
      baseParams({ sessionId: "user-gemini-rb", correlationId: "ge-async-rollback" }) as never
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.cli).toBe("gemini_request_async");
    expect(sm.createSession).toHaveBeenCalledTimes(1);
    expect(startJob).toHaveBeenCalledTimes(1);
    // The catch unwound the committed admission via rollbackSessionAndWorktreeAdmission.
    expect(sm.compareAndSetSession).toHaveBeenCalledTimes(1);

    await ajm.dispose();
  });

  it("anti-orphan: session-manager failure before handoff => no job started", async () => {
    const throwingSm = mockSessionManager();
    (throwingSm.createSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB down"));
    const ajm = new AsyncJobManager(noopLogger);
    const startJob = vi.spyOn(ajm, "startJob");

    const result = await handleGeminiRequestAsync(
      { sessionManager: throwingSm, asyncJobManager: ajm, logger: noopLogger },
      baseParams({ sessionId: "user-gemini-orphan", correlationId: "ge-async-orphan" }) as never
    );

    expect(result.isError).toBe(true);
    expect(startJob).not.toHaveBeenCalled();

    await ajm.dispose();
  });
});
