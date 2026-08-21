/**
 * Two turns of one session cannot both own its continuation handle.
 *
 * The store applied continuation writes in the order they ARRIVED, not the
 * order they were decided, and told both turns they had succeeded. Measured
 * against a real PostgreSQL server through this request path: with two
 * concurrent turns on one session, the earlier turn's handle was the one left
 * in the row 3 times in 200 pairs. The invariant asserted here holds on either
 * engine and does not depend on which turn wins: exactly one turn is told its
 * write landed, and the row holds that turn's handle.
 */
import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

describe("continuation handle fence", () => {
  let tempDir: string;
  let storePath: string;
  let sessions: FileSessionManager;
  let closeServer: (() => Promise<void>) | null = null;

  beforeEach(() => {
    resetApiProviderBreakers();
    tempDir = mkdtempSync(join(tmpdir(), "rf-fence-"));
    storePath = join(tempDir, "sessions.json");
    sessions = new FileSessionManager(storePath);
  });

  afterEach(async () => {
    if (closeServer) await closeServer();
    closeServer = null;
    rmSync(tempDir, { recursive: true, force: true });
  });

  const providerRuntime = (baseUrl: string): ApiProviderRuntime => ({
    name: "resp",
    kind: "xai-responses",
    apiKeyEnv: null,
    baseUrl,
    defaultModel: "grok-4",
    apiKey: "",
  });

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

  it("tells exactly one of two concurrent turns that its handle is the session's", async () => {
    // A barrier, not a sleep: neither turn is answered until BOTH have resolved
    // the session, so both derive their handle from the same state. That is the
    // interleaving the fence exists for, and it does not depend on the defect.
    let waiting: Array<{ res: ServerResponse; label: string }> = [];
    const server = createServer(async (req, res) => {
      for await (const chunk of req) void chunk;
      waiting.push({ res, label: waiting.length === 0 ? "handle-A" : "handle-B" });
      if (waiting.length === 2) {
        for (const entry of waiting) {
          entry.res.writeHead(200, { "content-type": "application/json" });
          entry.res.end(
            JSON.stringify({ id: entry.label, model: "grok-4", output_text: entry.label })
          );
        }
        waiting = [];
      }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    closeServer = () => new Promise(r => server.close(() => r()));
    const baseUrl = `http://127.0.0.1:${addr.port}/v1`;

    const runtime = buildRuntime(baseUrl);
    const session = await sessions.createSession("resp" as never, "two turns");

    const [first, second] = await Promise.all([
      handleApiProviderRequest(runtime, providerRuntime(baseUrl), {
        prompt: "a",
        sessionId: session.id,
      }),
      handleApiProviderRequest(runtime, providerRuntime(baseUrl), {
        prompt: "b",
        sessionId: session.id,
      }),
    ]);

    const sc = [first, second].map(r => r.structuredContent as Record<string, any>);
    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();

    const persisted = sc.filter(c => c.sessionContinuityPersisted === true);
    expect(persisted).toHaveLength(1);

    const stored = JSON.parse(readFileSync(storePath, "utf8")).sessions[session.id];
    // The row holds the handle of the turn that was TOLD it landed, and the
    // turn that was told otherwise did not leave its handle behind.
    expect(stored.metadata.apiPreviousResponseId).toBe(persisted[0].responseId);
  });
});
