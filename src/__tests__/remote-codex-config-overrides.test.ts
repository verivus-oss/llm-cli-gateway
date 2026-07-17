/**
 * Remote callers must not alter the gateway host's Codex configuration with
 * `-c` overrides or their --enable/--disable equivalents. These tests drive
 * the registered sync and async tools so a future refactor cannot move the
 * check below CLI dispatch or durable job admission.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncJobManager } from "../async-job-manager.js";
import type { PersistenceConfig } from "../config.js";
import { NoopFlightRecorder } from "../flight-recorder.js";
import { createGatewayServer, prepareCodexRequest } from "../index.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import { PersonalConfigManager } from "../personal-config.js";
import { runWithRequestContext, type GatewayRequestContext } from "../request-context.js";
import { FileSessionManager } from "../session-manager.js";

interface RegisteredTool {
  inputSchema: { parse(input: unknown): Record<string, unknown> };
  handler: (
    args: Record<string, unknown>,
    extra?: Record<string, unknown>
  ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

const REMOTE: GatewayRequestContext = {
  transport: "http",
  authScopes: [],
  authPrincipal: "remote-codex-config-test",
};

const LOCAL_CODEX_PARAMS = {
  prompt: "review this change",
  fullAuto: false,
  dangerouslyBypassApprovalsAndSandbox: false,
  approvalStrategy: "legacy" as const,
  mcpServers: [] as never[],
  optimizePrompt: false,
  operation: "codex_request",
};

function memoryPersistence(): PersistenceConfig {
  return {
    backend: "memory",
    path: null,
    dsn: null,
    retentionDays: 30,
    dedupWindowMs: 3_600_000,
    acknowledgeEphemeral: true,
    ownsOrphanRecovery: false,
    asyncJobsEnabled: true,
    sources: { configFile: null, envOverrides: [] },
  };
}

function isErrorResponse(result: unknown): result is { content: Array<{ text: string }> } {
  return typeof result === "object" && result !== null && !("args" in result);
}

describe("remote Codex configuration override boundary", () => {
  let root: string;
  let jobs: AsyncJobManager;
  let server: ReturnType<typeof createGatewayServer>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "remote-codex-config-"));
    const sessions = new FileSessionManager(join(root, "sessions.json"));
    jobs = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    server = createGatewayServer({
      sessionManager: sessions,
      asyncJobManager: jobs,
      persistence: memoryPersistence(),
      flightRecorder: new NoopFlightRecorder(),
      logger: noopLogger,
      personalConfig: new PersonalConfigManager({
        enabled: false,
        baselinePath: join(root, "baseline"),
        maxStaleHours: 168,
      }),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await jobs.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  function tool(name: "codex_request" | "codex_request_async"): RegisteredTool {
    const tools = (server as unknown as Record<string, Record<string, RegisteredTool>>)
      ._registeredTools;
    const registered = tools[name];
    if (!registered) throw new Error(`expected ${name} to be registered`);
    return registered;
  }

  async function callRemote(
    name: "codex_request" | "codex_request_async",
    args: Record<string, unknown>
  ): Promise<{ content: Array<{ text: string }>; isError?: boolean }> {
    const registered = tool(name);
    const parsed = registered.inputSchema.parse(args);
    return runWithRequestContext(REMOTE, () => registered.handler(parsed, {}));
  }

  it("rejects configOverrides before synchronous enqueue or inline process admission", async () => {
    const enqueue = vi.spyOn(jobs, "startJobWithDedup");
    const acquireProcessSlot = vi.spyOn(jobs, "acquireProcessSlot");

    const result = await callRemote("codex_request", {
      prompt: "review this change",
      configOverrides: { "model.foo": "untrusted" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("configOverrides");
    expect(enqueue).not.toHaveBeenCalled();
    expect(acquireProcessSlot).not.toHaveBeenCalled();
    expect(jobs.getRunningJobs()).toEqual([]);
  });

  it("rejects async feature override shorthands before durable job admission", async () => {
    const startJob = vi.spyOn(jobs, "startJob");
    const enqueue = vi.spyOn(jobs, "startJobWithDedup");

    const result = await callRemote("codex_request_async", {
      prompt: "review this change",
      enable: ["dangerous_remote_feature"],
      disable: ["safe_guardrail"],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("enable, disable");
    expect(startJob).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(jobs.getRunningJobs()).toEqual([]);
  });

  it("rejects configOverrides on a remote native-resume preparation path", () => {
    const result = runWithRequestContext(REMOTE, () =>
      prepareCodexRequest({
        ...LOCAL_CODEX_PARAMS,
        sessionId: "01940000-0000-7000-8000-000000000abc",
        configOverrides: { "model.foo": "untrusted" },
      })
    );

    expect(isErrorResponse(result)).toBe(true);
    if (isErrorResponse(result)) expect(result.content[0]?.text).toContain("configOverrides");
  });

  it("keeps local config overrides and feature controls available", () => {
    const result = prepareCodexRequest({
      ...LOCAL_CODEX_PARAMS,
      configOverrides: { "model.foo": "trusted-local" },
      enable: ["local_feature"],
      disable: ["legacy_feature"],
    });

    expect(isErrorResponse(result)).toBe(false);
    if (isErrorResponse(result)) return;
    expect(result.args).toEqual(
      expect.arrayContaining([
        "-c",
        "model.foo=trusted-local",
        "--enable",
        "local_feature",
        "--disable",
        "legacy_feature",
      ])
    );
  });
});
