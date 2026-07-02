/**
 * Phase 7 (B2): grok `outputFormat:"streaming-json"` must yield the NORMALIZED
 * final reply to the caller, not the raw NDJSON event stream.
 *
 * Before the fix, buildCliResponse only special-cased Codex, so a sync
 * grok_request with streaming-json returned the raw NDJSON in content[0].text.
 * grokDisplayText() is now wired into buildCliResponse for cli === "grok".
 *
 * Mutation that flips this red: removing the `if (cli === "grok")
 * grokDisplayText(...)` branch in buildCliResponse. content[0].text would then
 * carry the raw NDJSON (and this test's `toBe("hello world")` fails).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { AsyncJobManager } from "../async-job-manager.js";
import type { ISessionManager, Session } from "../session-manager.js";

// Real grok `--output-format streaming-json` capture shape: `data`-field deltas
// plus a terminal `end` event. (Mirrors the epsilon veracity fixture.)
const GROK_NDJSON =
  JSON.stringify({ type: "thought", data: "let me think" }) +
  "\n" +
  JSON.stringify({ type: "text", data: "hello" }) +
  "\n" +
  JSON.stringify({ type: "text", data: " world" }) +
  "\n" +
  JSON.stringify({
    type: "end",
    stopReason: "EndTurn",
    sessionId: "019ec070-26ab-7fa3-b66b-72fc6964f250",
    requestId: "64625ea0-6292-4dd1-9f43-263084223516",
  }) +
  "\n";

vi.mock("../executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../executor.js")>();
  return {
    ...actual,
    getExtendedPath: vi.fn(() => process.env.PATH || ""),
    executeCli: vi.fn(async (command: string, _args: string[], _options?: any) => {
      if (command === "grok") {
        return { stdout: GROK_NDJSON, stderr: "", code: 0 };
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

describe("Phase 7 B2: grok streaming-json normalization in caller response", () => {
  let handleGrokRequest: (typeof import("../index.js"))["handleGrokRequest"];
  let originalDeadline: string | undefined;

  beforeAll(async () => {
    originalDeadline = process.env.SYNC_DEADLINE_MS;
    process.env.SYNC_DEADLINE_MS = "0";
    const mod = await import("../index.js");
    handleGrokRequest = mod.handleGrokRequest;
  });

  afterAll(() => {
    if (originalDeadline === undefined) delete process.env.SYNC_DEADLINE_MS;
    else process.env.SYNC_DEADLINE_MS = originalDeadline;
  });

  it("returns normalized final text (not raw NDJSON) for streaming-json output", async () => {
    const sm = createMockSessionManager();
    const ajm = new AsyncJobManager(noopLogger);

    const result = await handleGrokRequest(
      { sessionManager: sm, asyncJobManager: ajm, logger: noopLogger },
      {
        prompt: "say the line",
        outputFormat: "streaming-json",
        resumeLatest: false,
        createNewSession: false,
        approvalStrategy: "legacy",
        optimizePrompt: false,
      }
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].type).toBe("text");
    // Normalized reply, NOT the raw NDJSON stream.
    expect(result.content[0].text).toBe("hello world");
    expect(result.content[0].text).not.toContain('"type"');
    expect(result.content[0].text).not.toContain("let me think");
    expect(result.structuredContent).toMatchObject({ cli: "grok", exitCode: 0 });
  });
});
