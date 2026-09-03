/**
 * The launch context is one line at each call site, and a review board measured
 * that dropping either line passed every existing test. These pins make the
 * wiring itself observable: an async job's real child must see the ids, and the
 * sync path must hand them to executeCli.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { executeCliMock } = vi.hoisted(() => ({ executeCliMock: vi.fn() }));
vi.mock("../executor.js", async () => {
  const actual = await vi.importActual<typeof import("../executor.js")>("../executor.js");
  return { ...actual, executeCli: executeCliMock };
});

import { AsyncJobManager, type LlmCli } from "../async-job-manager.js";
import { handleGrokRequest, type GatewayServerRuntime } from "../index.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import { runWithRequestContext, type GatewayRequestContext } from "../request-context.js";
import type { ISessionManager, ProviderType, Session } from "../session-manager.js";

const LOCAL: GatewayRequestContext = { transport: "stdio", authScopes: [] };

const disabledWorkspaces = {
  enabled: false,
  defaultAlias: null,
  allowUnregisteredWorkingDir: false,
  repos: [],
  allowedRoots: [],
  sources: { configFile: null },
};

const managers: AsyncJobManager[] = [];
afterEach(async () => {
  executeCliMock.mockReset();
  await Promise.all(managers.splice(0).map(manager => manager.dispose()));
});

describe("launch context wiring", () => {
  it("launchProcessJob exports correlation id, job id and provider to the real child", async () => {
    const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    managers.push(manager);
    const outcome = await runWithRequestContext(LOCAL, () =>
      manager.startJobWithDedup(
        "sh" as LlmCli,
        ["-c", "echo $LLM_GATEWAY_CORRELATION_ID:$LLM_GATEWAY_JOB_ID:$LLM_GATEWAY_PROVIDER"],
        "corr-async-wiring",
        {}
      )
    );
    const id = outcome.snapshot.id;
    const deadline = Date.now() + 10_000;
    let result = await manager.getJobResult(id);
    while (result && !result.exited && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      result = await manager.getJobResult(id);
    }
    expect(result?.exited).toBe(true);
    expect(result?.stdout.trim()).toBe(`corr-async-wiring:${id}:sh`);
  });

  it("awaitJobOrDefer hands correlation id and provider to executeCli", async () => {
    executeCliMock.mockResolvedValue({ stdout: "done", stderr: "", code: 0 });
    const records = new Map<string, Session>();
    const sessionManager = {
      createSession: vi.fn(
        async (cli: ProviderType, description?: string, requestedId?: string) => {
          const id = requestedId ?? `gw-${records.size + 1}`;
          const created = {
            id,
            cli,
            description,
            createdAt: new Date().toISOString(),
            lastUsedAt: new Date().toISOString(),
            metadata: {},
          } as unknown as Session;
          records.set(id, created);
          return created;
        }
      ),
      getSession: vi.fn(async (id: string) => records.get(id) ?? null),
      listSessions: vi.fn(async () => [...records.values()]),
      deleteSession: vi.fn(async (id: string) => records.delete(id)),
      setActiveSession: vi.fn(async () => true),
      getActiveSession: vi.fn(async () => null),
      updateSessionUsage: vi.fn(async () => {}),
      updateSessionMetadata: vi.fn(async () => true),
      clearAllSessions: vi.fn(async () => 0),
    } as unknown as ISessionManager;
    const asyncJobManager = new AsyncJobManager(noopLogger);
    managers.push(asyncJobManager);
    const runtime = {
      sessionManager,
      asyncJobManager,
      approvalManager: { decide: () => ({ status: "approved" }) },
      flightRecorder: { logStart() {}, logComplete() {}, recordCompressionTelemetry() {} },
      logger: noopLogger,
      performanceMetrics: { recordRequest() {} },
      persistence: { backend: "none", asyncJobsEnabled: false },
      compression: { enabled: false, sources: { configFile: null } },
      workspaces: disabledWorkspaces,
      personalConfig: { settings: { enabled: false } },
      providers: { xai: null, providers: {}, sources: { configFile: null } },
    } as unknown as GatewayServerRuntime;
    const deps = { sessionManager, logger: noopLogger, runtime };

    const response = await runWithRequestContext(LOCAL, () =>
      handleGrokRequest(deps, {
        prompt: "wiring probe",
        correlationId: "corr-sync-wiring",
        resumeLatest: false,
        createNewSession: false,
        approvalStrategy: "legacy",
        optimizePrompt: false,
      })
    );

    expect(executeCliMock, response.content[0]?.text).toHaveBeenCalledTimes(1);
    const options = executeCliMock.mock.calls[0]?.[2] as { launchContext?: unknown };
    expect(options.launchContext).toEqual({ correlationId: "corr-sync-wiring", provider: "grok" });
  });
});
