import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleGrokApiRequest,
  resolveGatewayServerRuntime,
  type GatewayServerRuntime,
} from "../index.js";
import { FileSessionManager } from "../session-manager.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import { ApprovalManager } from "../approval-manager.js";
import { PerformanceMetrics } from "../metrics.js";
import { ResourceProvider } from "../resources.js";
import { NoopFlightRecorder } from "../flight-recorder.js";
import { noopLogger } from "../logger.js";
import type { PersistenceConfig, ProvidersConfig } from "../config.js";

interface CapturedRequest {
  path: string;
  authorization: string | undefined;
  body: any;
}

function mkPersistence(): PersistenceConfig {
  return {
    backend: "memory",
    path: null,
    dsn: null,
    retentionDays: 30,
    dedupWindowMs: 3_600_000,
    acknowledgeEphemeral: true,
    asyncJobsEnabled: true,
    sources: { configFile: null, envOverrides: [] },
  };
}

function mkProviders(baseUrl: string): ProvidersConfig {
  return {
    xai: {
      apiKeyEnv: "XAI_API_KEY",
      baseUrl,
      defaultModel: "grok-build-0.1",
    },
    sources: { configFile: null },
  };
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: any) => void | Promise<void>
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    const body = await readJson(req);
    await handler(req, res, body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind to a port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function xaiSuccess(id: string, text: string): Record<string, unknown> {
  return {
    id,
    object: "response",
    model: "grok-build-0.1",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text }],
      },
    ],
    usage: {
      input_tokens: 12,
      output_tokens: 5,
      input_tokens_details: { cached_tokens: 3 },
      cost_in_usd_ticks: 25_000_000,
    },
  };
}

describe("grok_api_request", () => {
  let tempDir: string;
  let sessionManager: FileSessionManager;
  let runtime: GatewayServerRuntime;
  let closeServer: (() => Promise<void>) | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grok-api-provider-test-"));
    sessionManager = new FileSessionManager(join(tempDir, "sessions.json"));
    vi.stubEnv("XAI_API_KEY", "secret-key");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (closeServer) {
      await closeServer();
      closeServer = null;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  function buildRuntime(baseUrl: string): GatewayServerRuntime {
    const metrics = new PerformanceMetrics();
    const recorder = new NoopFlightRecorder();
    const asyncJobManager = new AsyncJobManager(
      noopLogger,
      undefined,
      new MemoryJobStore(),
      recorder
    );
    return resolveGatewayServerRuntime(
      {
        sessionManager,
        asyncJobManager,
        approvalManager: new ApprovalManager(undefined, noopLogger),
        performanceMetrics: metrics,
        resourceProvider: new ResourceProvider(sessionManager, metrics, recorder),
        flightRecorder: recorder,
        logger: noopLogger,
        persistence: mkPersistence(),
        providers: mkProviders(baseUrl),
      },
      { isolateState: true }
    );
  }

  it("posts to xAI Responses API, maps usage, and stores previous_response_id", async () => {
    const captured: CapturedRequest[] = [];
    const server = await startServer((req, res, body) => {
      captured.push({
        path: req.url ?? "",
        authorization: req.headers.authorization,
        body,
      });
      writeJson(res, 200, xaiSuccess("resp-1", "API hello"));
    });
    closeServer = server.close;
    runtime = buildRuntime(server.baseUrl);

    const result = await handleGrokApiRequest(
      { sessionManager, logger: noopLogger, runtime },
      {
        promptParts: {
          system: "You are concise.",
          context: "Repo context",
          task: "Say hello",
        },
        optimizePrompt: false,
        correlationId: "corr-grok-api-1",
        maxOutputTokens: 100,
        temperature: 0.2,
      }
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("API hello");
    expect(result.structuredContent).toMatchObject({
      provider: "grok-api",
      cli: "grok-api",
      model: "grok-build-0.1",
      correlationId: "corr-grok-api-1",
      responseId: "resp-1",
      inputTokens: 12,
      outputTokens: 5,
      cacheReadTokens: 3,
      costUsd: 0.0025,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].path).toBe("/v1/responses");
    expect(captured[0].authorization).toBe("Bearer secret-key");
    expect(captured[0].body).toMatchObject({
      model: "grok-build-0.1",
      instructions: "You are concise.",
      max_output_tokens: 100,
      temperature: 0.2,
    });
    expect(captured[0].body.input).toEqual([
      { role: "user", content: "<context>\nRepo context\n</context>\n\nSay hello" },
    ]);

    const session = sessionManager.getSession(result.sessionId!);
    expect(session?.cli).toBe("grok-api");
    expect(session?.metadata?.xaiPreviousResponseId).toBe("resp-1");
  });

  it("keeps promptParts system text in instructions when optimizing user input", async () => {
    const captured: CapturedRequest[] = [];
    const server = await startServer((req, res, body) => {
      captured.push({
        path: req.url ?? "",
        authorization: req.headers.authorization,
        body,
      });
      writeJson(res, 200, xaiSuccess("resp-optimized", "Optimized"));
    });
    closeServer = server.close;
    runtime = buildRuntime(server.baseUrl);

    const result = await handleGrokApiRequest(
      { sessionManager, logger: noopLogger, runtime },
      {
        promptParts: {
          system: "Please keep this as system.",
          context: "Please use repo context.",
          task: "Please answer briefly.",
        },
        optimizePrompt: true,
        correlationId: "corr-grok-api-optimized-parts",
      }
    );

    expect(result.isError).toBeUndefined();
    expect(captured).toHaveLength(1);
    expect(captured[0].body.instructions).toBe("Please keep this as system.");
    expect(captured[0].body.input).toHaveLength(1);
    expect(captured[0].body.input[0].role).toBe("user");
    expect(captured[0].body.input[0].content).not.toContain("Please keep this as system.");
    expect(captured[0].body.input[0].content).toContain("<context>\nuse repo context.\n</context>");
    expect(captured[0].body.input[0].content).toContain("answer briefly.");
  });

  it("clears a stale previous_response_id on 404 and retries fresh", async () => {
    const session = sessionManager.createSession("grok-api", "Grok API", "api-session");
    sessionManager.updateSessionMetadata(session.id, { xaiPreviousResponseId: "expired" });
    const captured: CapturedRequest[] = [];
    const server = await startServer((_req, res, body) => {
      captured.push({ path: "/v1/responses", authorization: undefined, body });
      if (body.previous_response_id === "expired") {
        writeJson(res, 404, { error: { message: "response not found" } });
        return;
      }
      writeJson(res, 200, xaiSuccess("resp-2", "Fresh chain"));
    });
    closeServer = server.close;
    runtime = buildRuntime(server.baseUrl);

    const result = await handleGrokApiRequest(
      { sessionManager, logger: noopLogger, runtime },
      {
        prompt: "continue",
        sessionId: "api-session",
        optimizePrompt: false,
        correlationId: "corr-grok-api-404",
      }
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("Fresh chain");
    expect(result.structuredContent).toMatchObject({
      stalePreviousResponseCleared: true,
      previousResponseId: null,
      responseId: "resp-2",
    });
    expect(captured).toHaveLength(2);
    expect(captured[0].body.previous_response_id).toBe("expired");
    expect(captured[1].body.previous_response_id).toBeUndefined();
    expect(sessionManager.getSession("api-session")?.metadata?.xaiPreviousResponseId).toBe(
      "resp-2"
    );
  });

  it("uses the active grok-api session when sessionId is omitted", async () => {
    const session = sessionManager.createSession("grok-api", "Grok API", "active-api-session");
    sessionManager.updateSessionMetadata(session.id, { xaiPreviousResponseId: "resp-active" });
    sessionManager.setActiveSession("grok-api", session.id);
    const captured: CapturedRequest[] = [];
    const server = await startServer((req, res, body) => {
      captured.push({
        path: req.url ?? "",
        authorization: req.headers.authorization,
        body,
      });
      writeJson(res, 200, xaiSuccess("resp-next", "Continued"));
    });
    closeServer = server.close;
    runtime = buildRuntime(server.baseUrl);

    const result = await handleGrokApiRequest(
      { sessionManager, logger: noopLogger, runtime },
      {
        prompt: "continue active",
        optimizePrompt: false,
        correlationId: "corr-grok-api-active",
      }
    );

    expect(result.isError).toBeUndefined();
    expect(result.sessionId).toBe("active-api-session");
    expect(result.structuredContent).toMatchObject({
      previousResponseId: "resp-active",
      responseId: "resp-next",
    });
    expect(captured[0].body.previous_response_id).toBe("resp-active");
    expect(sessionManager.getSession("active-api-session")?.metadata?.xaiPreviousResponseId).toBe(
      "resp-next"
    );
  });

  it("rejects a Grok CLI session id instead of crossing provider namespaces", async () => {
    sessionManager.createSession("grok", "Grok CLI", "cli-session");
    const server = await startServer((_req, res) => writeJson(res, 500, {}));
    closeServer = server.close;
    runtime = buildRuntime(server.baseUrl);

    const result = await handleGrokApiRequest(
      { sessionManager, logger: noopLogger, runtime },
      {
        prompt: "hello",
        sessionId: "cli-session",
        optimizePrompt: false,
        correlationId: "corr-grok-api-wrong-session",
      }
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not 'grok-api'");
  });

  it("rejects reasoningEffort on models without xAI support before calling HTTP", async () => {
    let called = false;
    const server = await startServer((_req, res) => {
      called = true;
      writeJson(res, 200, xaiSuccess("resp-unused", "unused"));
    });
    closeServer = server.close;
    runtime = buildRuntime(server.baseUrl);

    const result = await handleGrokApiRequest(
      { sessionManager, logger: noopLogger, runtime },
      {
        prompt: "think harder",
        optimizePrompt: false,
        reasoningEffort: "high",
        correlationId: "corr-grok-api-effort",
      }
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("reasoningEffort");
    expect(called).toBe(false);
  });
});
