import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Tier-B T4 boundary net: pins the terminal-envelope driver's per-provider
// topology seam (runInsideTerminalTry). The load-bearing claim (design D2) is
// that a state 4..8 FRONT-HALF failure keeps each provider's existing
// metric/cleanup boundary EXACTLY:
//   - Codex runs states 4..8 OUTSIDE the envelope try in its own dedicated
//     early-return catches, so a front-half failure records NO performance
//     metric (recordRequest count == 0) and never completes the flight.
//   - Claude runs states 4..8 INSIDE the envelope try, so a front-half failure
//     records ONE metric via the envelope finally (recordRequest count == 1).
//     Its worktree-resolve failure is the `ok:false` seam early-return (operation
//     id "claude_request", catch NOT taken, no flight completion); the other
//     three throw into the envelope catch (operation id "claude").
// Each test asserts the observable tuple (recordRequest count, response
// operation id, flight completion). These run alongside the existing
// characterization nets (claude/codex-handler-terminal-net, *-handler,
// *-kit-preadmission), which stay green and unmodified.

const { executeCliMock } = vi.hoisted(() => ({ executeCliMock: vi.fn() }));

vi.mock("../executor.js", async () => {
  const actual = await vi.importActual<typeof import("../executor.js")>("../executor.js");
  return { ...actual, executeCli: executeCliMock };
});

// Keep createWorktree mockable so the worktree-materialize (state 6) failure can
// be injected deterministically; everything else calls through.
vi.mock("../worktree-manager.js", async () => {
  const actual =
    await vi.importActual<typeof import("../worktree-manager.js")>("../worktree-manager.js");
  return { ...actual, createWorktree: vi.fn(actual.createWorktree) };
});

// assertUpstreamCliArgs is only called at the state-4 argv/assert-admission block
// (index.ts claude ~10405 / codex ~10982) and inside awaitJobOrDefer (state 9);
// the prep pipeline never calls it. Mocking it to throw triggers the argv/assert
// catch precisely, before flight.start().
vi.mock("../upstream-contracts.js", async () => {
  const actual = await vi.importActual<typeof import("../upstream-contracts.js")>(
    "../upstream-contracts.js"
  );
  return { ...actual, assertUpstreamCliArgs: vi.fn(actual.assertUpstreamCliArgs) };
});

// extractProviderOutputMetadata is the last step of codex's computeSuccessFacts
// (and claude's success metadata). Kept mockable so the facts-order test can make
// it throw on the success path; a passthrough otherwise.
const { extractProviderOutputMetadataMock } = vi.hoisted(() => ({
  extractProviderOutputMetadataMock: vi.fn(),
}));
vi.mock("../provider-output-metadata.js", async () => {
  const actual = await vi.importActual<typeof import("../provider-output-metadata.js")>(
    "../provider-output-metadata.js"
  );
  extractProviderOutputMetadataMock.mockImplementation(actual.extractProviderOutputMetadata);
  return { ...actual, extractProviderOutputMetadata: extractProviderOutputMetadataMock };
});

import {
  handleClaudeRequest,
  handleCodexRequest,
  type ClaudeRequestParams,
  type CodexRequestParams,
  type GatewayServerRuntime,
  type HandlerDeps,
} from "../index.js";
import { AsyncJobManager } from "../async-job-manager.js";
import type { PersistenceConfig } from "../config.js";
import { FlightRecorder } from "../flight-recorder.js";
import { noopLogger } from "../logger.js";
import { runWithRequestContext, type GatewayRequestContext } from "../request-context.js";
import { FileSessionManager } from "../session-manager.js";
import { createWorktree } from "../worktree-manager.js";
import { assertUpstreamCliArgs } from "../upstream-contracts.js";

const LOCAL: GatewayRequestContext = { transport: "stdio", authScopes: [] };

function persistenceNone(): PersistenceConfig {
  return {
    backend: "none",
    path: null,
    dsn: null,
    retentionDays: 30,
    dedupWindowMs: 3_600_000,
    acknowledgeEphemeral: false,
    ownsOrphanRecovery: false,
    asyncJobsEnabled: false,
    sources: { configFile: null, envOverrides: [] },
  };
}

function workspaceRegistry(
  root: string,
  allowWorktree: boolean
): GatewayServerRuntime["workspaces"] {
  return {
    enabled: true,
    defaultAlias: "test-workspace",
    allowUnregisteredWorkingDir: false,
    repos: [
      {
        alias: "test-workspace",
        path: root,
        providers: ["codex", "claude"],
        allowWorktree,
        allowAddDir: false,
        kind: "folder",
        operatorEntry: true,
      },
    ],
    allowedRoots: [],
    sources: { configFile: null },
  };
}

function structuredCli(result: { structuredContent?: { cli?: string } }): string | undefined {
  return result.structuredContent?.cli;
}

describe("Tier-B T4 terminal-envelope: state 4..8 metric/cleanup boundary", () => {
  let tmp: string;
  let flight: FlightRecorder;
  let manager: AsyncJobManager;
  let sessions: FileSessionManager;
  let recordRequest: ReturnType<typeof vi.fn>;
  let logComplete: ReturnType<typeof vi.spyOn>;
  const createWorktreeMock = vi.mocked(createWorktree);
  const assertUpstreamCliArgsMock = vi.mocked(assertUpstreamCliArgs);

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "t4-boundary-"));
    flight = new FlightRecorder(join(tmp, "logs.db"));
    manager = new AsyncJobManager(noopLogger);
    sessions = new FileSessionManager(join(tmp, "sessions.json"));
    executeCliMock.mockReset();
    executeCliMock.mockResolvedValue({ stdout: "ok", stderr: "", code: 0 });
    recordRequest = vi.fn();
    logComplete = vi.spyOn(flight, "logComplete");
    createWorktreeMock.mockClear();
    assertUpstreamCliArgsMock.mockClear();
  });

  afterEach(async () => {
    await manager.dispose();
    flight.close();
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function runtime(allowWorktree: boolean): GatewayServerRuntime {
    return {
      sessionManager: sessions,
      asyncJobManager: manager,
      approvalManager: { decide: () => ({ status: "approved" }) },
      flightRecorder: flight,
      logger: noopLogger,
      performanceMetrics: { recordRequest },
      persistence: persistenceNone(),
      compression: { enabled: false, sources: { configFile: null } },
      cacheAwareness: {
        emitAnthropicCacheControl: false,
        anthropicTtlSeconds: 300,
        warnOnTtlExpiry: false,
        minStableTokensForCacheControl: { sonnet: 0, opus: 0, haiku: 0, default: 0 },
        sources: { configFile: null },
      },
      workspaces: workspaceRegistry(tmp, allowWorktree),
      personalConfig: { settings: { enabled: false } },
      providers: { xai: null, providers: {}, sources: { configFile: null } },
    } as unknown as GatewayServerRuntime;
  }

  function codexDeps(allowWorktree: boolean): HandlerDeps {
    const rt = runtime(allowWorktree);
    return { runtime: rt, sessionManager: sessions, logger: noopLogger };
  }

  function claudeDeps(allowWorktree: boolean): HandlerDeps {
    const rt = runtime(allowWorktree);
    return { runtime: rt, sessionManager: sessions, logger: noopLogger };
  }

  function codexParams(overrides: Partial<CodexRequestParams> = {}): CodexRequestParams {
    return {
      prompt: "characterize a codex front-half path",
      outputFormat: "text",
      fullAuto: false,
      dangerouslyBypassApprovalsAndSandbox: false,
      approvalStrategy: "legacy",
      createNewSession: false,
      optimizePrompt: false,
      optimizeResponse: false,
      forceRefresh: false,
      ...overrides,
    } as unknown as CodexRequestParams;
  }

  function claudeParams(overrides: Partial<ClaudeRequestParams> = {}): ClaudeRequestParams {
    return {
      prompt: "characterize a claude front-half path",
      outputFormat: "json",
      continueSession: false,
      createNewSession: false,
      dangerouslySkipPermissions: false,
      approvalStrategy: "legacy",
      mcpServers: [],
      strictMcpConfig: false,
      optimizePrompt: false,
      optimizeResponse: false,
      forceRefresh: false,
      ...overrides,
    } as unknown as ClaudeRequestParams;
  }

  // -- Codex: states 4..8 OUTSIDE the try. All record NO metric. --------------

  it("codex #1 worktree-resolve failure: NO metric, id codex_request, no flight complete", async () => {
    const result = await runWithRequestContext(LOCAL, () =>
      handleCodexRequest(
        codexDeps(false),
        codexParams({ workspace: "test-workspace", worktree: true, correlationId: "cx-wt" })
      )
    );
    expect(result.isError).toBe(true);
    expect(structuredCli(result)).toBe("codex_request");
    expect(recordRequest).not.toHaveBeenCalled();
    expect(logComplete).not.toHaveBeenCalled();
  });

  it("codex #2 argv/assert-admission failure: NO metric, id codex_request, no flight complete", async () => {
    assertUpstreamCliArgsMock.mockImplementationOnce(() => {
      throw new Error("argv admission rejected");
    });
    const result = await runWithRequestContext(LOCAL, () =>
      handleCodexRequest(codexDeps(false), codexParams({ correlationId: "cx-argv" }))
    );
    expect(result.isError).toBe(true);
    expect(structuredCli(result)).toBe("codex_request");
    expect(recordRequest).not.toHaveBeenCalled();
    expect(logComplete).not.toHaveBeenCalled();
  });

  it("codex #3 session-admission failure: NO metric, id codex_request, no flight complete", async () => {
    vi.spyOn(sessions, "createSession").mockImplementation(() => {
      throw new Error("session admission boom");
    });
    vi.spyOn(sessions, "createSessionWithMetadata").mockImplementation(() => {
      throw new Error("session admission boom");
    });
    const result = await runWithRequestContext(LOCAL, () =>
      handleCodexRequest(
        codexDeps(false),
        codexParams({ sessionId: "cx-admit-fail", correlationId: "cx-admit" })
      )
    );
    expect(result.isError).toBe(true);
    expect(structuredCli(result)).toBe("codex_request");
    expect(recordRequest).not.toHaveBeenCalled();
    expect(logComplete).not.toHaveBeenCalled();
  });

  it("codex #4 worktree-materialize failure (shared catch): NO metric, id codex_request", async () => {
    createWorktreeMock.mockImplementation(() => {
      throw new Error("worktree materialize boom");
    });
    const result = await runWithRequestContext(LOCAL, () =>
      handleCodexRequest(
        codexDeps(true),
        codexParams({ workspace: "test-workspace", worktree: true, correlationId: "cx-mat" })
      )
    );
    expect(result.isError).toBe(true);
    expect(structuredCli(result)).toBe("codex_request");
    expect(recordRequest).not.toHaveBeenCalled();
    expect(logComplete).not.toHaveBeenCalled();
  });

  // -- Claude: states 4..8 INSIDE the try. All record ONE metric (finally). ---

  it("claude #5 worktree-resolve early return (ok:false seam): metric once, id claude_request, catch NOT taken", async () => {
    const result = await runWithRequestContext(LOCAL, () =>
      handleClaudeRequest(
        claudeDeps(false),
        claudeParams({ workspace: "test-workspace", worktree: true, correlationId: "cl-wt" })
      )
    );
    expect(result.isError).toBe(true);
    // ok:false early-return keeps the front-half operation id and does NOT enter
    // the envelope catch, so the flight (never started) is never completed.
    expect(structuredCli(result)).toBe("claude_request");
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]?.[0]).toBe("claude");
    expect(logComplete).not.toHaveBeenCalled();
  });

  it("claude #6 argv/assert failure (throw to catch): metric once, id claude", async () => {
    assertUpstreamCliArgsMock.mockImplementationOnce(() => {
      throw new Error("argv admission rejected");
    });
    const result = await runWithRequestContext(LOCAL, () =>
      handleClaudeRequest(claudeDeps(false), claudeParams({ correlationId: "cl-argv" }))
    );
    expect(result.isError).toBe(true);
    // A throw before flight.start() enters the envelope catch (operation id
    // "claude") and the finally records exactly one metric.
    expect(structuredCli(result)).toBe("claude");
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]?.[0]).toBe("claude");
  });

  it("claude #7 session-admission failure (throw to catch): metric once, id claude", async () => {
    vi.spyOn(sessions, "createSession").mockImplementation(() => {
      throw new Error("session admission boom");
    });
    vi.spyOn(sessions, "createSessionWithMetadata").mockImplementation(() => {
      throw new Error("session admission boom");
    });
    const result = await runWithRequestContext(LOCAL, () =>
      handleClaudeRequest(
        claudeDeps(false),
        claudeParams({ sessionId: "cl-admit-fail", correlationId: "cl-admit" })
      )
    );
    expect(result.isError).toBe(true);
    expect(structuredCli(result)).toBe("claude");
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]?.[0]).toBe("claude");
  });

  it("claude #8 worktree-materialize failure (throw to catch): metric once, id claude", async () => {
    createWorktreeMock.mockImplementation(() => {
      throw new Error("worktree materialize boom");
    });
    const result = await runWithRequestContext(LOCAL, () =>
      handleClaudeRequest(
        claudeDeps(true),
        claudeParams({ workspace: "test-workspace", worktree: true, correlationId: "cl-mat" })
      )
    );
    expect(result.isError).toBe(true);
    expect(structuredCli(result)).toBe("claude");
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]?.[0]).toBe("claude");
  });
});

// Terminal parity (both providers): every inline terminal that ENTERS the
// envelope records exactly ONE metric via the finally and completes the flight
// exactly once, and the codex facts-order (extract-before-finalize) is pinned by
// making the success-path extraction throw. Persistence is "none", so sync
// requests run to completion inline (no auto-deferral).
describe("Tier-B T4 terminal-envelope: inline terminal parity + codex facts-order", () => {
  let tmp: string;
  let flight: FlightRecorder;
  let manager: AsyncJobManager;
  let sessions: FileSessionManager;
  let recordRequest: ReturnType<typeof vi.fn>;
  let logComplete: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "t4-parity-"));
    flight = new FlightRecorder(join(tmp, "logs.db"));
    manager = new AsyncJobManager(noopLogger);
    sessions = new FileSessionManager(join(tmp, "sessions.json"));
    executeCliMock.mockReset();
    recordRequest = vi.fn();
    logComplete = vi.spyOn(flight, "logComplete");
    extractProviderOutputMetadataMock.mockClear();
  });

  afterEach(async () => {
    await manager.dispose();
    flight.close();
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function runtime(): GatewayServerRuntime {
    return {
      sessionManager: sessions,
      asyncJobManager: manager,
      approvalManager: { decide: () => ({ status: "approved" }) },
      flightRecorder: flight,
      logger: noopLogger,
      performanceMetrics: { recordRequest },
      persistence: persistenceNone(),
      compression: { enabled: false, sources: { configFile: null } },
      cacheAwareness: {
        emitAnthropicCacheControl: false,
        anthropicTtlSeconds: 300,
        warnOnTtlExpiry: false,
        minStableTokensForCacheControl: { sonnet: 0, opus: 0, haiku: 0, default: 0 },
        sources: { configFile: null },
      },
      workspaces: workspaceRegistry(tmp, false),
      personalConfig: { settings: { enabled: false } },
      providers: { xai: null, providers: {}, sources: { configFile: null } },
    } as unknown as GatewayServerRuntime;
  }

  function deps(): HandlerDeps {
    const rt = runtime();
    return { runtime: rt, sessionManager: sessions, logger: noopLogger };
  }

  const codexParams = (o: Partial<CodexRequestParams> = {}): CodexRequestParams =>
    ({
      prompt: "codex terminal parity",
      outputFormat: "text",
      fullAuto: false,
      dangerouslyBypassApprovalsAndSandbox: false,
      approvalStrategy: "legacy",
      createNewSession: false,
      optimizePrompt: false,
      optimizeResponse: false,
      forceRefresh: false,
      ...o,
    }) as unknown as CodexRequestParams;

  const claudeParams = (o: Partial<ClaudeRequestParams> = {}): ClaudeRequestParams =>
    ({
      prompt: "claude terminal parity",
      outputFormat: "json",
      continueSession: false,
      createNewSession: false,
      dangerouslySkipPermissions: false,
      approvalStrategy: "legacy",
      mcpServers: [],
      strictMcpConfig: false,
      optimizePrompt: false,
      optimizeResponse: false,
      forceRefresh: false,
      ...o,
    }) as unknown as ClaudeRequestParams;

  it("codex inline success (10c): one metric (success), one flight completion", async () => {
    executeCliMock.mockResolvedValue({ stdout: "all good", stderr: "", code: 0 });
    const result = await runWithRequestContext(LOCAL, () =>
      handleCodexRequest(deps(), codexParams({ correlationId: "cx-ok" }))
    );
    expect(result.isError).toBeUndefined();
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["codex", expect.any(Number), true]);
    expect(logComplete).toHaveBeenCalledTimes(1);
  });

  it("codex inline failure code!=0 (10b): one metric (not success), one flight completion", async () => {
    executeCliMock.mockResolvedValue({ stdout: "", stderr: "codex failed", code: 1 });
    const result = await runWithRequestContext(LOCAL, () =>
      handleCodexRequest(deps(), codexParams({ correlationId: "cx-fail" }))
    );
    expect(result.isError).toBe(true);
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["codex", expect.any(Number), false]);
    expect(logComplete).toHaveBeenCalledTimes(1);
  });

  it("codex exception (11): one metric (not success), id codex", async () => {
    executeCliMock.mockRejectedValue(new Error("codex spawn blew up"));
    const result = await runWithRequestContext(LOCAL, () =>
      handleCodexRequest(deps(), codexParams({ correlationId: "cx-throw" }))
    );
    expect(result.isError).toBe(true);
    expect(structuredCli(result)).toBe("codex");
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["codex", expect.any(Number), false]);
  });

  it("claude inline success (10c): one metric (success), one flight completion", async () => {
    executeCliMock.mockResolvedValue({ stdout: "all good", stderr: "", code: 0 });
    const result = await runWithRequestContext(LOCAL, () =>
      handleClaudeRequest(deps(), claudeParams({ correlationId: "cl-ok" }))
    );
    expect(result.isError).toBeFalsy();
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["claude", expect.any(Number), true]);
    expect(logComplete).toHaveBeenCalledTimes(1);
  });

  it("claude inline failure code!=0 (10b): one metric (not success), one flight completion", async () => {
    executeCliMock.mockResolvedValue({ stdout: "", stderr: "claude failed", code: 1 });
    const result = await runWithRequestContext(LOCAL, () =>
      handleClaudeRequest(deps(), claudeParams({ correlationId: "cl-fail" }))
    );
    expect(result.isError).toBe(true);
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["claude", expect.any(Number), false]);
    expect(logComplete).toHaveBeenCalledTimes(1);
  });

  it("claude exception (11): one metric (not success), id claude", async () => {
    executeCliMock.mockRejectedValue(new Error("claude spawn blew up"));
    const result = await runWithRequestContext(LOCAL, () =>
      handleClaudeRequest(deps(), claudeParams({ correlationId: "cl-throw" }))
    );
    expect(result.isError).toBe(true);
    expect(structuredCli(result)).toBe("claude");
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["claude", expect.any(Number), false]);
  });

  // Codex extract-before-finalize: computeSuccessFacts runs the codex extraction
  // (ending in extractProviderOutputMetadata) BEFORE finalizeKit on the success
  // path. Making that extraction throw aborts the success branch, so it surfaces
  // via the envelope catch (operation id "codex"); because finalizeKit sits AFTER
  // computeSuccessFacts in the driver, the throw provably never reaches it (the
  // Kit session is left un-finalized exactly as pre-T4 codex). wasSuccessful was
  // already latched true (set before computeSuccessFacts), so the finally metric
  // records success, matching pre-T4 codex where wasSuccessful=true precedes the
  // extraction.
  it("codex facts-order: a success-path extraction throw surfaces via the envelope catch (id codex)", async () => {
    executeCliMock.mockResolvedValue({ stdout: "codex reply", stderr: "", code: 0 });
    extractProviderOutputMetadataMock.mockImplementation((cli: string) => {
      if (cli === "codex") throw new Error("codex metadata extraction blew up");
      return { sessionId: undefined, stopReason: undefined };
    });
    const result = await runWithRequestContext(LOCAL, () =>
      handleCodexRequest(deps(), codexParams({ correlationId: "cx-facts-throw" }))
    );
    expect(result.isError).toBe(true);
    expect(structuredCli(result)).toBe("codex");
    expect(recordRequest).toHaveBeenCalledTimes(1);
    // wasSuccessful is latched before computeSuccessFacts, so the finally metric
    // still records success even though the extraction threw (pre-T4 parity).
    expect(recordRequest.mock.calls[0]).toEqual(["codex", expect.any(Number), true]);
  });
});
