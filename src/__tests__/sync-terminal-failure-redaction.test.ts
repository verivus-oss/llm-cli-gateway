import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { executeCliMock } = vi.hoisted(() => ({ executeCliMock: vi.fn() }));

vi.mock("../executor.js", async () => {
  const actual = await vi.importActual<typeof import("../executor.js")>("../executor.js");
  return { ...actual, executeCli: executeCliMock };
});

import {
  createGatewayServer,
  handleGrokRequest,
  type GatewayServerRuntime,
  type HandlerDeps,
} from "../index.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { readPersistedRequest } from "../cache-stats.js";
import { defaultLeastCostConfig, type PersistenceConfig } from "../config.js";
import { FlightRecorder } from "../flight-recorder.js";
import { noopLogger } from "../logger.js";
import { PersonalConfigManager } from "../personal-config.js";
import { runWithRequestContext, type GatewayRequestContext } from "../request-context.js";
import { FileSessionManager } from "../session-manager.js";

const PROVIDER_SESSION_ID = "019ec070-26ab-7fa3-b66b-72fc6964f250";
const REMOTE_ALICE: GatewayRequestContext = {
  transport: "http",
  authKind: "oauth",
  authScopes: [],
  authPrincipal: "alice",
};
const LOCAL: GatewayRequestContext = { transport: "stdio", authScopes: [] };
const GROK_FAILURE_STDOUT = JSON.stringify({
  text: "partial output",
  sessionId: PROVIDER_SESSION_ID,
  stopReason: "error",
});
const CLAUDE_FAILURE_STDOUT = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: PROVIDER_SESSION_ID,
    model: "sonnet",
  }),
  JSON.stringify({
    type: "result",
    subtype: "error",
    is_error: true,
    result: "partial output",
    session_id: PROVIDER_SESSION_ID,
    stop_reason: "error",
  }),
].join("\n");
const FAILURE_STDERR = `provider failure while resuming ${PROVIDER_SESSION_ID}`;

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

function workspaceRegistry(root: string): GatewayServerRuntime["workspaces"] {
  return {
    enabled: true,
    defaultAlias: "test-workspace",
    allowUnregisteredWorkingDir: false,
    repos: [
      {
        alias: "test-workspace",
        path: root,
        providers: ["claude", "grok"],
        allowWorktree: false,
        allowAddDir: false,
        kind: "folder",
        operatorEntry: true,
      },
    ],
    allowedRoots: [],
    sources: { configFile: null },
  };
}

interface RegisteredTool {
  inputSchema: { parse(input: unknown): Record<string, unknown> };
  handler: (
    args: Record<string, unknown>,
    extra?: Record<string, unknown>
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  }>;
}

describe("synchronous terminal failure provider-session privacy", () => {
  let tmp: string;
  let flight: FlightRecorder;
  let manager: AsyncJobManager;
  let sessions: FileSessionManager;
  let server: ReturnType<typeof createGatewayServer> | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sync-failure-redaction-"));
    flight = new FlightRecorder(join(tmp, "logs.db"));
    manager = new AsyncJobManager(noopLogger);
    sessions = new FileSessionManager(join(tmp, "sessions.json"));
    executeCliMock.mockReset();
  });

  afterEach(async () => {
    await server?.close();
    await manager.dispose();
    flight.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function runtime(): GatewayServerRuntime {
    return {
      sessionManager: sessions,
      asyncJobManager: manager,
      approvalManager: { decide: () => ({ status: "approved" }) },
      flightRecorder: flight,
      logger: noopLogger,
      performanceMetrics: { recordRequest() {} },
      persistence: persistenceNone(),
      compression: { enabled: false, sources: { configFile: null } },
      workspaces: workspaceRegistry(tmp),
      personalConfig: { settings: { enabled: false } },
      providers: { xai: null, providers: {}, sources: { configFile: null } },
    } as unknown as GatewayServerRuntime;
  }

  function deps(value: GatewayServerRuntime): HandlerDeps {
    return { runtime: value, sessionManager: sessions, logger: noopLogger };
  }

  it("persists the full-stdout native id and redacts remote direct error envelopes", async () => {
    executeCliMock.mockResolvedValue({
      stdout: GROK_FAILURE_STDOUT,
      stderr: FAILURE_STDERR,
      code: 1,
    });
    const currentRuntime = runtime();

    const remote = await runWithRequestContext(REMOTE_ALICE, () =>
      handleGrokRequest(deps(currentRuntime), {
        prompt: "fail remotely",
        outputFormat: "json",
        correlationId: "remote-grok-failure",
        resumeLatest: false,
        createNewSession: false,
        approvalStrategy: "legacy",
        optimizePrompt: false,
      })
    );

    expect(remote.isError).toBe(true);
    expect(JSON.stringify(remote)).not.toContain(PROVIDER_SESSION_ID);
    expect(remote.content[0]?.text).toContain("[redacted-session-id]");
    expect(remote.structuredContent?.response).toContain("[redacted-session-id]");

    const stored = flight.queryRequests<{ provider_session_id: string | null }>(
      "SELECT provider_session_id FROM gateway_metadata WHERE request_id = ?",
      "remote-grok-failure"
    );
    expect(stored[0]?.provider_session_id).toBe(PROVIDER_SESSION_ID);

    const persisted = readPersistedRequest(flight, "remote-grok-failure", {
      includePrompt: true,
      redactProviderSessionId: true,
    });
    expect(JSON.stringify(persisted)).not.toContain(PROVIDER_SESSION_ID);
    expect(persisted?.errorMessage).toBe("provider failure while resuming [redacted-session-id]");

    const local = await runWithRequestContext(LOCAL, () =>
      handleGrokRequest(deps(currentRuntime), {
        prompt: "fail locally",
        outputFormat: "json",
        correlationId: "local-grok-failure",
        resumeLatest: false,
        createNewSession: false,
        approvalStrategy: "legacy",
        optimizePrompt: false,
      })
    );
    expect(local.isError).toBe(true);
    expect(JSON.stringify(local)).toContain(PROVIDER_SESSION_ID);
  });

  it("uses the same terminal failure metadata path for a routed CLI dispatch", async () => {
    executeCliMock.mockResolvedValue({
      stdout: CLAUDE_FAILURE_STDOUT,
      stderr: FAILURE_STDERR,
      code: 1,
    });
    server = createGatewayServer({
      sessionManager: sessions,
      asyncJobManager: manager,
      flightRecorder: flight,
      logger: noopLogger,
      persistence: persistenceNone(),
      compression: { enabled: false, sources: { configFile: null } },
      providers: { xai: null, providers: {}, sources: { configFile: null } },
      workspaces: workspaceRegistry(tmp),
      leastCost: { ...defaultLeastCostConfig(), enabled: true, maxReroutes: 0 },
      personalConfig: new PersonalConfigManager({
        enabled: false,
        baselinePath: join(tmp, "unused-kit"),
        maxStaleHours: 168,
      }),
    });
    const tool = (server as unknown as Record<string, Record<string, RegisteredTool>>)
      ._registeredTools.route_request;
    expect(tool).toBeDefined();

    const result = await runWithRequestContext(REMOTE_ALICE, () =>
      tool.handler(
        tool.inputSchema.parse({
          prompt: "route a failing request",
          correlationId: "remote-routed-failure",
          candidates: [{ provider: "claude", model: "sonnet" }],
        }),
        {}
      )
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(PROVIDER_SESSION_ID);
    expect(result.content[0]?.text).toContain("[redacted-session-id]");

    const stored = flight.queryRequests<{ provider_session_id: string | null }>(
      "SELECT provider_session_id FROM gateway_metadata WHERE request_id = ?",
      "remote-routed-failure"
    );
    expect(stored[0]?.provider_session_id).toBe(PROVIDER_SESSION_ID);

    const persisted = readPersistedRequest(flight, "remote-routed-failure", {
      includePrompt: true,
      redactProviderSessionId: true,
    });
    expect(JSON.stringify(persisted)).not.toContain(PROVIDER_SESSION_ID);
    expect(persisted?.errorMessage).toBe("provider failure while resuming [redacted-session-id]");
  });
});
