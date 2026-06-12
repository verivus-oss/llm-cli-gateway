/**
 * Issue #1 localisation test — bug(grok): sync grok_request returns empty
 * content to MCP caller (text present in flight recorder).
 *
 * The report: a successful sync `grok_request` (exit 0, text written to the
 * flight recorder) surfaces an MCP response whose `content[0].text` is missing
 * the model's reply, while `structuredContent` (model/cli/correlationId/…) is
 * present. The text IS in the flight recorder, so the loss — if any — is
 * between the successful CLI exit and what the MCP caller sees.
 *
 * This test drives the sync grok handler with a stubbed CLI returning known
 * text and asserts the handler's own return value carries that text in
 * `content[0].text`. It localises the defect:
 *   - If this PASSES, `buildCliResponse` / `handleGrokRequest` are NOT dropping
 *     content; the loss is downstream (MCP transport serialisation, or a client
 *     harness that prefers `structuredContent`) — re-scope the issue there.
 *   - If this FAILS, the bug is in the handler / `buildCliResponse` for grok.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { AsyncJobManager } from "../async-job-manager.js";
import type { ISessionManager, Session } from "../session-manager.js";

const GROK_REPLY = "GROK_SYNC_REPLY: the quick brown fox jumped over 42 lazy dogs.";

// Mock executeCli AND getExtendedPath so the sync handler (SYNC_DEADLINE_MS=0
// routes through executeCli) sees our stubbed grok reply. Mirrors the harness
// in gemini-async-handler.test.ts.
vi.mock("../executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../executor.js")>();
  return {
    ...actual,
    getExtendedPath: vi.fn(() => process.env.PATH || ""),
    executeCli: vi.fn(async (command: string, _args: string[], _options?: any) => {
      if (command === "grok") {
        return { stdout: GROK_REPLY, stderr: "", code: 0 };
      }
      return actual.executeCli(command, _args, _options);
    }),
  };
});

const noopLogger = {
  info: (..._args: any[]) => {},
  warn: (..._args: any[]) => {},
  error: (..._args: any[]) => {},
  debug: (..._args: any[]) => {},
};

function mockSession(id: string, cli: Session["cli"]): Session {
  return {
    id,
    cli,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    description: `${cli} session`,
  };
}

function createMockSessionManager(sessions: Map<string, Session> = new Map()): ISessionManager {
  return {
    createSession: vi.fn(async (cli, description, sessionId) => {
      const session = mockSession(sessionId || `gw-${cli}`, cli);
      session.description = description;
      sessions.set(session.id, session);
      return session;
    }),
    getSession: vi.fn(async id => sessions.get(id) || null),
    listSessions: vi.fn(async cli => [...sessions.values()].filter(s => !cli || s.cli === cli)),
    deleteSession: vi.fn(async id => sessions.delete(id)),
    setActiveSession: vi.fn(async () => true),
    getActiveSession: vi.fn(async () => null),
    updateSessionUsage: vi.fn(async () => {}),
    updateSessionMetadata: vi.fn(async () => true),
    clearAllSessions: vi.fn(async () => 0),
  };
}

describe("Issue #1 — grok sync content[0].text localisation", () => {
  let handleGrokRequest: (typeof import("../index.js"))["handleGrokRequest"];
  let originalDeadline: string | undefined;

  beforeAll(async () => {
    originalDeadline = process.env.SYNC_DEADLINE_MS;
    // Force the synchronous direct-execute path through the mocked executeCli.
    process.env.SYNC_DEADLINE_MS = "0";
    const mod = await import("../index.js");
    handleGrokRequest = mod.handleGrokRequest;
  });

  afterAll(() => {
    if (originalDeadline === undefined) delete process.env.SYNC_DEADLINE_MS;
    else process.env.SYNC_DEADLINE_MS = originalDeadline;
  });

  it("returns the CLI stdout in content[0].text on a successful sync run", async () => {
    const sm = createMockSessionManager();
    const ajm = new AsyncJobManager(noopLogger);

    const result = await handleGrokRequest(
      { sessionManager: sm, asyncJobManager: ajm, logger: noopLogger },
      {
        prompt: "say the line",
        resumeLatest: false,
        createNewSession: false,
        approvalStrategy: "legacy",
        optimizePrompt: false,
      }
    );

    // Not an error response.
    expect(result.isError).toBeUndefined();

    // The reply text MUST be visible to the MCP caller, not only in the
    // flight recorder / structuredContent metadata.
    expect(result.content).toBeDefined();
    expect(result.content[0]).toBeDefined();
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain(GROK_REPLY);
    expect(result.content[0].text.length).toBeGreaterThan(0);

    // structuredContent should still carry the metadata reported in the issue.
    expect(result.structuredContent).toMatchObject({ cli: "grok", exitCode: 0 });
  });
});
