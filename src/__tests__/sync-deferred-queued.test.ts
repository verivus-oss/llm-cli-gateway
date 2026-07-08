import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncJobManager } from "../async-job-manager.js";
import type { JobLimitsConfig, PersistenceConfig, ProvidersConfig } from "../config.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import { FileSessionManager } from "../session-manager.js";

function mkPersistence(): PersistenceConfig {
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

function mkProviders(baseUrl: string): ProvidersConfig {
  return {
    xai: null,
    providers: {
      ollama: {
        name: "ollama",
        kind: "openai-compatible",
        baseUrl,
        apiKeyEnv: null,
        defaultModel: "qwen2.5",
      },
    },
    sources: { configFile: null },
  };
}

function limits(): JobLimitsConfig {
  return {
    maxRunningJobs: 1,
    maxRunningJobsPerProvider: 1,
    maxQueuedJobs: 5,
    queueTimeoutMs: 10_000,
    completedJobMemoryTtlMs: 60 * 60 * 1000,
    maxJobOutputBytes: 50 * 1024 * 1024,
  };
}

describe("sync/deferred queued jobs", () => {
  let originalDeadline: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    originalDeadline = process.env.SYNC_DEADLINE_MS;
    process.env.SYNC_DEADLINE_MS = "25";
    tempDir = mkdtempSync(join(tmpdir(), "sync-deferred-queued-"));
    vi.resetModules();
  });

  afterEach(() => {
    if (originalDeadline === undefined) delete process.env.SYNC_DEADLINE_MS;
    else process.env.SYNC_DEADLINE_MS = originalDeadline;
    rmSync(tempDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("process sync polling treats queued jobs as in-progress and returns a deferred job", async () => {
    const { handleGrokRequest, resolveGatewayServerRuntime }: typeof import("../index.js") =
      await import("../index.js");
    const manager = new AsyncJobManager(
      noopLogger,
      undefined,
      new MemoryJobStore(),
      undefined,
      limits()
    );
    const slot = await manager.acquireProcessSlot("grok");
    const sessionManager = new FileSessionManager(join(tempDir, "sessions.json"));
    const runtime = resolveGatewayServerRuntime(
      {
        asyncJobManager: manager,
        sessionManager,
        logger: noopLogger,
        persistence: mkPersistence(),
      },
      { isolateState: true }
    );

    try {
      const response = await handleGrokRequest(
        { sessionManager, logger: noopLogger, runtime },
        { prompt: "queued process", approvalStrategy: "legacy" }
      );
      const body = JSON.parse(response.content[0].text);

      expect(body.status).toBe("deferred");
      expect(body.cli).toBe("grok");
      expect(manager.getJobSnapshot(body.jobId)?.status).toBe("queued");
      manager.cancelJob(body.jobId);
    } finally {
      slot.release();
    }
  });

  it("API sync polling treats queued jobs as in-progress and returns a deferred job", async () => {
    const { handleApiProviderRequest, resolveGatewayServerRuntime }: typeof import("../index.js") =
      await import("../index.js");
    const manager = new AsyncJobManager(
      noopLogger,
      undefined,
      new MemoryJobStore(),
      undefined,
      limits()
    );
    const slot = await manager.acquireProcessSlot("ollama");
    const sessionManager = new FileSessionManager(join(tempDir, "sessions.json"));
    const baseUrl = "http://127.0.0.1:1/v1";
    const runtime = resolveGatewayServerRuntime(
      {
        asyncJobManager: manager,
        sessionManager,
        logger: noopLogger,
        persistence: mkPersistence(),
        providers: mkProviders(baseUrl),
      },
      { isolateState: true }
    );

    try {
      const response = await handleApiProviderRequest(
        runtime,
        {
          name: "ollama",
          kind: "openai-compatible",
          apiKeyEnv: null,
          baseUrl,
          defaultModel: "qwen2.5",
          apiKey: "",
        },
        { prompt: "queued api" }
      );
      const body = JSON.parse(response.content[0].text);

      expect(body.status).toBe("deferred");
      expect(body.cli).toBe("ollama");
      expect(manager.getJobSnapshot(body.jobId)?.status).toBe("queued");
      manager.cancelJob(body.jobId);
    } finally {
      slot.release();
    }
  });
});
