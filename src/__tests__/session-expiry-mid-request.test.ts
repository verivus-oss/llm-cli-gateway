/**
 * A session that is live when its request resolves and crosses its TTL while
 * the provider runs must not be deleted by its own continuation write, and a
 * write that really is lost must not be reported as success.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  handleApiProviderRequest,
  resolveGatewayServerRuntime,
  type GatewayServerRuntime,
} from "../index.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { resetApiProviderBreakers } from "../api-provider.js";
import { MemoryJobStore } from "../job-store.js";
import { NoopFlightRecorder } from "../flight-recorder.js";
import { FileSessionManager } from "../session-manager.js";
import { PerformanceMetrics } from "../metrics.js";
import { ResourceProvider } from "../resources.js";
import { ApprovalManager } from "../approval-manager.js";
import { noopLogger } from "../logger.js";
import type {
  ApiProviderConfig,
  ApiProviderRuntime,
  PersistenceConfig,
  ProvidersConfig,
} from "../config.js";

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
  const provider: ApiProviderConfig = {
    name: "resp",
    kind: "xai-responses",
    baseUrl,
    apiKeyEnv: null,
    defaultModel: "grok-4",
  };
  return { xai: null, providers: { resp: provider }, sources: { configFile: null } };
}

describe("session expiry during a provider request", () => {
  let tempDir: string;
  let storePath: string;
  let sessions: FileSessionManager;
  let closeServer: (() => Promise<void>) | null = null;
  let pendingId = "";

  beforeEach(() => {
    resetApiProviderBreakers();
    tempDir = mkdtempSync(join(tmpdir(), "rf-expiry-"));
    storePath = join(tempDir, "sessions.json");
    sessions = new FileSessionManager(storePath);
  });

  afterEach(async () => {
    if (closeServer) await closeServer();
    closeServer = null;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function storedRow(id: string): Record<string, any> | undefined {
    return JSON.parse(readFileSync(storePath, "utf8")).sessions[id];
  }

  function buildRuntime(baseUrl: string): GatewayServerRuntime {
    const metrics = new PerformanceMetrics();
    const recorder = new NoopFlightRecorder();
    return resolveGatewayServerRuntime(
      {
        sessionManager: sessions,
        asyncJobManager: new AsyncJobManager(noopLogger, undefined, new MemoryJobStore(), recorder),
        approvalManager: new ApprovalManager(undefined, noopLogger),
        performanceMetrics: metrics,
        resourceProvider: new ResourceProvider(sessions, metrics, recorder),
        flightRecorder: recorder,
        logger: noopLogger,
        persistence: mkPersistence(),
        providers: mkProviders(baseUrl),
      },
      { isolateState: true }
    );
  }

  async function startServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void
  ): Promise<string> {
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) void _chunk;
      handler(req, res);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    closeServer = () => new Promise(r => server.close(() => r()));
    return `http://127.0.0.1:${addr.port}/v1`;
  }

  const providerRuntime = (baseUrl: string): ApiProviderRuntime => ({
    name: "resp",
    kind: "xai-responses",
    apiKeyEnv: null,
    baseUrl,
    defaultModel: "grok-4",
    apiKey: "",
  });

  it("keeps the session its own continuation write would have reaped", async () => {
    // The provider takes long enough to cross the TTL. Expressed as a TTL
    // change at the moment the provider replies, not as a sleep: the session is
    // unambiguously live at resolution and unambiguously expired at the write.
    const baseUrl = await startServer((_req, res) => {
      (sessions as unknown as { sessionTtlMs: number }).sessionTtlMs = -1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "resp-2", model: "grok-4", output_text: "hello" }));
    });
    const runtime = buildRuntime(baseUrl);
    const created = await sessions.createSession("resp" as never, "live at resolution");

    const result = await handleApiProviderRequest(runtime, providerRuntime(baseUrl), {
      prompt: "ping",
      sessionId: created.id,
    });

    const sc = result.structuredContent as Record<string, any>;
    expect(result.isError).toBeFalsy();
    expect(sc.sessionId).toBe(created.id);
    // THE ASSERTION: the id the response hands back still exists in the store,
    // with the continuation handle the response implies.
    expect(storedRow(created.id)).toBeDefined();
    expect(storedRow(created.id)?.metadata?.apiPreviousResponseId).toBe("resp-2");
    expect(sc.sessionContinuityPersisted).toBe(true);
  });

  it("reports a continuation write that really was lost", async () => {
    const baseUrl = await startServer((_req, res) => {
      // The owner deleted the session while the provider was running. There is
      // nothing to honour here, so the caller must be told.
      void sessions.deleteSession(pendingId);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "resp-3", model: "grok-4", output_text: "hello" }));
    });
    const runtime = buildRuntime(baseUrl);
    const created = await sessions.createSession("resp" as never, "deleted mid-request");
    pendingId = created.id;

    const result = await handleApiProviderRequest(runtime, providerRuntime(baseUrl), {
      prompt: "ping",
      sessionId: created.id,
    });

    const sc = result.structuredContent as Record<string, any>;
    expect(result.isError).toBeFalsy();
    expect(storedRow(created.id)).toBeUndefined();
    expect(sc.sessionContinuityPersisted).toBe(false);
  });

  describe("FileSessionManager write contracts", () => {
    function expiredStore(): { manager: FileSessionManager; id: string; path: string } {
      const path = join(tempDir, "expired.json");
      const manager = new FileSessionManager(path, 60_000);
      const session = manager.createSession("claude", "live at resolution");
      const raw = JSON.parse(readFileSync(path, "utf8"));
      // Age the row past its TTL without a timer.
      raw.sessions[session.id].lastUsedAt = new Date(Date.now() - 3_600_000).toISOString();
      writeFileSync(path, JSON.stringify(raw), { mode: 0o600 });
      return { manager: new FileSessionManager(path, 60_000), id: session.id, path };
    }

    it("updateSessionMetadata honours the write instead of deleting the row", () => {
      const { manager, id, path } = expiredStore();

      expect(manager.updateSessionMetadata(id, { apiPreviousResponseId: "resp-9" })).toBe(true);

      const row = JSON.parse(readFileSync(path, "utf8")).sessions[id];
      expect(row).toBeDefined();
      expect(row.metadata.apiPreviousResponseId).toBe("resp-9");
      // Honouring means the session is usable on the next turn, not merely
      // present for one write.
      expect(manager.getSession(id)).not.toBeNull();
    });

    it("updateSessionUsage reports whether the row was written", () => {
      const { manager, id } = expiredStore();

      expect(manager.updateSessionUsage(id)).toBe(true);
      expect(manager.getSession(id)).not.toBeNull();
      expect(manager.updateSessionUsage("no-such-session")).toBe(false);
    });
  });
});
