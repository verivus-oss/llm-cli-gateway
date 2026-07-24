import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AsyncJobManager } from "../async-job-manager.js";
import type { ISessionManager, Session } from "../session-manager.js";

// RequestPipeline async A4 characterization net: pins handleDevinRequestAsync after routing
// through runAsyncEnqueueEnvelope. devin is the remote-tracked non-Kit async sibling: it has a
// full worktree lifecycle (like grok) but NO inner worktree-resolve catch (its first resolve is
// a plain await, so a throw propagates to the driver catch), NO applyEffectiveWorkingDirectory,
// passes outputFormat undefined, and its startJob cwd falls back to params.workingDir. Pure
// Mode C: startJob() fire-and-forget, no in-handler flight completion / recordRequest / finally.

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
  shimDir = mkdtempSync(join(tmpdir(), "devin-async-shim-"));
  const shimScript = join(shimDir, "devin");
  writeFileSync(shimScript, '#!/bin/sh\necho "devin response: $*"\nexit 0\n');
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
    cli: overrides.cli || "devin",
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
    prompt: "characterize a devin async path",
    resumeLatest: false,
    createNewSession: false,
    approvalStrategy: "legacy" as const,
    optimizePrompt: false,
    ...overrides,
  };
}

describe("handleDevinRequestAsync async-enqueue envelope (A4)", () => {
  let handleDevinRequestAsync: (typeof import("../index.js"))["handleDevinRequestAsync"];

  beforeAll(async () => {
    const mod = await import("../index.js");
    handleDevinRequestAsync = mod.handleDevinRequestAsync;
  });

  it("fresh (no session): enqueues once, mints a tracking-only gw- session, usage NOT updated (D4), approval+mcpServers present", async () => {
    const sm = mockSessionManager();
    const ajm = new AsyncJobManager(noopLogger);
    const startJob = vi.spyOn(ajm, "startJob");

    const result = await handleDevinRequestAsync(
      { sessionManager: sm, asyncJobManager: ajm, logger: noopLogger },
      baseParams({ correlationId: "dv-async-fresh" }) as never
    );

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(true);
    expect(body.job?.id).toBeDefined();
    expect(body.sessionId).toMatch(/^gw-/);
    expect(body.gatewaySessionId).toMatch(/^gw-/);
    expect(body.resumable).toBe(false);
    expect(body.approval).toBeDefined();
    expect(body.mcpServers).toEqual({ requested: [] });
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

    const result = await handleDevinRequestAsync(
      { sessionManager: sm, asyncJobManager: ajm, logger: noopLogger },
      baseParams({ sessionId: "user-devin-abc", correlationId: "dv-async-user" }) as never
    );

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.sessionId).toBe("user-devin-abc");
    expect(body.resumable).toBe(true);
    expect(startJob).toHaveBeenCalledTimes(1);
    expect(sm.updateSessionUsage).toHaveBeenCalledWith("user-devin-abc");

    ajm.cancelJob(body.job.id);
    await ajm.dispose();
  });

  it("argv/assert throw routes to the envelope catch: id devin_request_async, no job started", async () => {
    const sm = mockSessionManager();
    const ajm = new AsyncJobManager(noopLogger);
    const startJob = vi.spyOn(ajm, "startJob");
    assertUpstreamCliArgsMock.mockImplementationOnce(() => {
      throw new Error("argv admission rejected");
    });

    const result = await handleDevinRequestAsync(
      { sessionManager: sm, asyncJobManager: ajm, logger: noopLogger },
      baseParams({ correlationId: "dv-async-argv" }) as never
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.cli).toBe("devin_request_async");
    expect(startJob).not.toHaveBeenCalled();

    await ajm.dispose();
  });

  it("committed admission + enqueue throw before handoff: the driver unwinds the minted admission", async () => {
    // A fresh-mint request admits a (tracking-only) session in runInsideTry, then the enqueue's
    // startJob throws before jobHandedOff. The byte-changed rollback (ledger.rollbackOnException
    // (null, mgr)) must actually unwind the minted admission.
    const sm = mockSessionManager();
    const ajm = new AsyncJobManager(noopLogger);
    const startJob = vi.spyOn(ajm, "startJob").mockImplementation(() => {
      throw new Error("enqueue blew up");
    });

    const result = await handleDevinRequestAsync(
      { sessionManager: sm, asyncJobManager: ajm, logger: noopLogger },
      baseParams({ correlationId: "dv-async-rollback" }) as never
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.cli).toBe("devin_request_async");
    expect(sm.createSession).toHaveBeenCalledTimes(1);
    expect(startJob).toHaveBeenCalledTimes(1);
    expect(sm.compareAndSetSession).toHaveBeenCalledTimes(1);

    await ajm.dispose();
  });

  it("anti-orphan: session-manager failure before handoff => no job started", async () => {
    const throwingSm = mockSessionManager();
    (throwingSm.createSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB down"));
    const ajm = new AsyncJobManager(noopLogger);
    const startJob = vi.spyOn(ajm, "startJob");

    const result = await handleDevinRequestAsync(
      { sessionManager: throwingSm, asyncJobManager: ajm, logger: noopLogger },
      baseParams({ correlationId: "dv-async-orphan" }) as never
    );

    expect(result.isError).toBe(true);
    expect(startJob).not.toHaveBeenCalled();

    await ajm.dispose();
  });
});
