import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AsyncJobManager, type LlmCli } from "../async-job-manager.js";
import type { ISessionManager } from "../session-manager.js";
import type { Session } from "../session-manager.js";
import { GATEWAY_SESSION_PREFIX } from "../request-helpers.js";

// Mock executeCli AND getExtendedPath for sync handler tests —
// getExtendedPath() caches PATH before our shim is added, so both sync
// handlers (which call executeCli) and async jobs (which call spawn with
// getExtendedPath()) need the mock to find the gemini shim.
vi.mock("../executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../executor.js")>();
  return {
    ...actual,
    getExtendedPath: vi.fn(() => process.env.PATH || ""),
    executeCli: vi.fn(async (command: string, _args: string[], _options?: any) => {
      if (command === "gemini") {
        return { stdout: "mocked gemini response", stderr: "", code: 0 };
      }
      // Fall through to real implementation for other CLIs
      return actual.executeCli(command, _args, _options);
    }),
  };
});

// PATH shim: create temp dir with a fake `gemini` script
let shimDir: string;
let originalPath: string;

beforeAll(() => {
  shimDir = mkdtempSync(join(tmpdir(), "gemini-shim-"));
  const shimScript = join(shimDir, "gemini");
  writeFileSync(shimScript, '#!/bin/sh\necho "gemini response: $*"\nexit 0\n');
  chmodSync(shimScript, 0o755);
  originalPath = process.env.PATH || "";
  process.env.PATH = `${shimDir}:${originalPath}`;
});

afterAll(() => {
  process.env.PATH = originalPath;
  rmSync(shimDir, { recursive: true, force: true });
});

const noopLogger = {
  info: (..._args: any[]) => {},
  error: (..._args: any[]) => {},
  debug: (..._args: any[]) => {},
};

function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: overrides.id || "test-session",
    cli: overrides.cli || "gemini",
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    description: "Test Session",
    ...overrides,
  };
}

function createMockSessionManager(sessions: Map<string, Session> = new Map()): ISessionManager {
  return {
    createSession: vi.fn(async (cli, desc, id) => {
      const session = createMockSession({ id: id || `gw-${Date.now()}`, cli });
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
  };
}

/** Poll until predicate, or reject. */
function waitFor(fn: () => boolean, timeoutMs: number, intervalMs = 100): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (fn()) return resolve();
      if (Date.now() > deadline) return reject(new Error("waitFor timed out"));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

describe("handleGeminiRequestAsync", () => {
  // Dynamic import to avoid auto-start (guarded by import.meta.url check)
  let handleGeminiRequestAsync: (typeof import("../index.js"))["handleGeminiRequestAsync"];
  let handleGeminiRequest: (typeof import("../index.js"))["handleGeminiRequest"];

  beforeAll(async () => {
    const mod = await import("../index.js");
    handleGeminiRequestAsync = mod.handleGeminiRequestAsync;
    handleGeminiRequest = mod.handleGeminiRequest;
  });

  it("should start an async job and return correct response shape", async () => {
    const sm = createMockSessionManager();
    const ajm = new AsyncJobManager(noopLogger);
    const result = await handleGeminiRequestAsync(
      { sessionManager: sm, asyncJobManager: ajm, logger: noopLogger },
      {
        prompt: "test prompt",
        resumeLatest: false,
        createNewSession: false,
        approvalStrategy: "legacy",
        optimizePrompt: false,
      }
    );

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(true);
    expect(body.job).toBeDefined();
    expect(body.job.id).toBeDefined();
    expect(body.job.status).toBe("running");
    expect(body.sessionId).toBeTruthy();
    expect(body.resumable).toBe(false);

    // Cleanup
    ajm.cancelJob(body.job.id);
  });

  it("should include resumable=true when user provides sessionId", async () => {
    const sm = createMockSessionManager();
    const ajm = new AsyncJobManager(noopLogger);
    const result = await handleGeminiRequestAsync(
      { sessionManager: sm, asyncJobManager: ajm, logger: noopLogger },
      {
        prompt: "test",
        sessionId: "user-abc",
        resumeLatest: false,
        createNewSession: false,
        approvalStrategy: "legacy",
        optimizePrompt: false,
      }
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.resumable).toBe(true);
    expect(body.sessionId).toBe("user-abc");

    ajm.cancelJob(body.job.id);
  });

  it("should return error when sessionId has reserved gw- prefix", async () => {
    const sm = createMockSessionManager();
    const ajm = new AsyncJobManager(noopLogger);
    const result = await handleGeminiRequestAsync(
      { sessionManager: sm, asyncJobManager: ajm, logger: noopLogger },
      {
        prompt: "test",
        sessionId: "gw-abc123",
        resumeLatest: false,
        createNewSession: false,
        approvalStrategy: "legacy",
        optimizePrompt: false,
      }
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("reserved prefix");
    // Verify no job was started
    expect(ajm.getRunningJobs()).toHaveLength(0);
  });

  it("should not start job when session manager throws (anti-orphan)", async () => {
    const throwingSm = createMockSessionManager();
    (throwingSm.createSession as any).mockRejectedValue(new Error("DB down"));
    (throwingSm.getSession as any).mockRejectedValue(new Error("DB down"));

    const ajm = new AsyncJobManager(noopLogger);
    const startJobSpy = vi.spyOn(ajm, "startJob");

    const result = await handleGeminiRequestAsync(
      { sessionManager: throwingSm, asyncJobManager: ajm, logger: noopLogger },
      {
        prompt: "test",
        sessionId: "user-session",
        resumeLatest: false,
        createNewSession: false,
        approvalStrategy: "legacy",
        optimizePrompt: false,
      }
    );

    expect(result.isError).toBe(true);
    expect(startJobSpy).not.toHaveBeenCalled();
  });

  it("should create gateway session with gw- prefix when no session context", async () => {
    const sm = createMockSessionManager();
    const ajm = new AsyncJobManager(noopLogger);
    const result = await handleGeminiRequestAsync(
      { sessionManager: sm, asyncJobManager: ajm, logger: noopLogger },
      {
        prompt: "test",
        resumeLatest: false,
        createNewSession: false,
        approvalStrategy: "legacy",
        optimizePrompt: false,
      }
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.sessionId).toMatch(/^gw-/);
    expect(body.resumable).toBe(false);
    expect(sm.createSession).toHaveBeenCalledWith(
      "gemini",
      "Gemini Session",
      expect.stringMatching(/^gw-/)
    );

    ajm.cancelJob(body.job.id);
  });

  it("should pass --resume args for user-provided sessionId", async () => {
    const sm = createMockSessionManager();
    const ajm = new AsyncJobManager(noopLogger);
    const startJobSpy = vi.spyOn(ajm, "startJob");

    await handleGeminiRequestAsync(
      { sessionManager: sm, asyncJobManager: ajm, logger: noopLogger },
      {
        prompt: "test prompt",
        sessionId: "user-sess-42",
        resumeLatest: false,
        createNewSession: false,
        approvalStrategy: "legacy",
        optimizePrompt: false,
      }
    );

    expect(startJobSpy).toHaveBeenCalled();
    const args = startJobSpy.mock.calls[0][1];
    expect(args).toContain("--resume");
    expect(args).toContain("user-sess-42");

    const jobId = startJobSpy.mock.results[0].value.id;
    ajm.cancelJob(jobId);
  });

  it("should not pass --resume args when createNewSession=true", async () => {
    const sm = createMockSessionManager();
    const ajm = new AsyncJobManager(noopLogger);
    const startJobSpy = vi.spyOn(ajm, "startJob");

    await handleGeminiRequestAsync(
      { sessionManager: sm, asyncJobManager: ajm, logger: noopLogger },
      {
        prompt: "test",
        sessionId: "user-abc",
        resumeLatest: true,
        createNewSession: true,
        approvalStrategy: "legacy",
        optimizePrompt: false,
      }
    );

    expect(startJobSpy).toHaveBeenCalled();
    const args = startJobSpy.mock.calls[0][1];
    expect(args).not.toContain("--resume");

    const jobId = startJobSpy.mock.results[0].value.id;
    ajm.cancelJob(jobId);
  });

  it("should pass --resume latest when resumeLatest=true and no sessionId", async () => {
    const sm = createMockSessionManager();
    const ajm = new AsyncJobManager(noopLogger);
    const startJobSpy = vi.spyOn(ajm, "startJob");

    await handleGeminiRequestAsync(
      { sessionManager: sm, asyncJobManager: ajm, logger: noopLogger },
      {
        prompt: "test",
        resumeLatest: true,
        createNewSession: false,
        approvalStrategy: "legacy",
        optimizePrompt: false,
      }
    );

    const args = startJobSpy.mock.calls[0][1];
    expect(args).toContain("--resume");
    expect(args).toContain("latest");

    const jobId = startJobSpy.mock.results[0].value.id;
    ajm.cancelJob(jobId);
  });
});

describe("handleGeminiRequest (sync)", () => {
  let handleGeminiRequest: (typeof import("../index.js"))["handleGeminiRequest"];

  beforeAll(async () => {
    const mod = await import("../index.js");
    handleGeminiRequest = mod.handleGeminiRequest;
  });

  it("should return error for gw- prefixed sessionId (sync replay protection)", async () => {
    const sm = createMockSessionManager();
    const result = await handleGeminiRequest(
      { sessionManager: sm, logger: noopLogger },
      {
        prompt: "test",
        sessionId: "gw-abc123",
        resumeLatest: false,
        createNewSession: false,
        approvalStrategy: "legacy",
        optimizePrompt: false,
      }
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("reserved prefix");
  });

  it("should return resumable=true for user-provided sessionId", async () => {
    const sm = createMockSessionManager();
    const result = await handleGeminiRequest(
      { sessionManager: sm, logger: noopLogger },
      {
        prompt: "hello",
        sessionId: "user-abc",
        resumeLatest: false,
        createNewSession: false,
        approvalStrategy: "legacy",
        optimizePrompt: false,
      }
    );

    expect(result.isError).toBeUndefined();
    expect(result.resumable).toBe(true);
    expect(result.sessionId).toBe("user-abc");
  });

  it("should return resumable=false for gateway-generated session", async () => {
    const sm = createMockSessionManager();
    const result = await handleGeminiRequest(
      { sessionManager: sm, logger: noopLogger },
      {
        prompt: "hello",
        resumeLatest: false,
        createNewSession: false,
        approvalStrategy: "legacy",
        optimizePrompt: false,
      }
    );

    expect(result.isError).toBeUndefined();
    expect(result.resumable).toBe(false);
    expect(result.sessionId).toMatch(/^gw-/);
  });
});

describe("handleCodexRequestAsync", () => {
  let handleCodexRequestAsync: (typeof import("../index.js"))["handleCodexRequestAsync"];

  beforeAll(async () => {
    const mod = await import("../index.js");
    handleCodexRequestAsync = mod.handleCodexRequestAsync;
  });

  it("should not start job when session manager throws (anti-orphan)", async () => {
    const throwingSm = createMockSessionManager();
    (throwingSm.getActiveSession as any).mockRejectedValue(new Error("DB down"));

    const ajm = new AsyncJobManager(noopLogger);
    const startJobSpy = vi.spyOn(ajm, "startJob");

    const result = await handleCodexRequestAsync(
      { sessionManager: throwingSm, asyncJobManager: ajm, logger: noopLogger },
      {
        prompt: "test",
        fullAuto: false,
        dangerouslyBypassApprovalsAndSandbox: false,
        approvalStrategy: "legacy",
        createNewSession: false,
        optimizePrompt: false,
      }
    );

    expect(result.isError).toBe(true);
    expect(startJobSpy).not.toHaveBeenCalled();
  });

  it("should start job after successful session I/O", async () => {
    const sm = createMockSessionManager();
    const ajm = new AsyncJobManager(noopLogger);
    const startJobSpy = vi.spyOn(ajm, "startJob");

    const result = await handleCodexRequestAsync(
      { sessionManager: sm, asyncJobManager: ajm, logger: noopLogger },
      {
        prompt: "test",
        fullAuto: false,
        dangerouslyBypassApprovalsAndSandbox: false,
        approvalStrategy: "legacy",
        createNewSession: false,
        optimizePrompt: false,
      }
    );

    expect(result.isError).toBeUndefined();
    expect(startJobSpy).toHaveBeenCalled();
    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(true);

    ajm.cancelJob(body.job.id);
  });
});
