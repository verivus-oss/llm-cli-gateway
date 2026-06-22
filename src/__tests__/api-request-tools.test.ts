/**
 * Slice 2 — generic api_<name>_request tools.
 *
 * Covers the pure assembly layer (prepareApiRequest / resolveApiModel /
 * assembleApiMessages), the sync + async handlers end-to-end against a loopback
 * server, the model-allowlist rejection, and the registration gating (registers
 * nothing unless a provider is enabled — ships dormant).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  handleApiProviderRequest,
  handleApiProviderRequestAsync,
  registerApiProviderTools,
  resolveGatewayServerRuntime,
  type GatewayServerRuntime,
} from "../index.js";
import {
  prepareApiRequest,
  resolveApiModel,
  assembleApiMessages,
  ApiModelNotAllowedError,
} from "../api-request.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { resetApiProviderBreakers } from "../api-provider.js";
import { MemoryJobStore } from "../job-store.js";
import {
  NoopFlightRecorder,
  type FlightLogStart,
  type FlightLogResult,
} from "../flight-recorder.js";
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

const ollamaRuntime = (over: Partial<ApiProviderRuntime> = {}): ApiProviderRuntime => ({
  name: "ollama",
  kind: "openai-compatible",
  baseUrl: "http://127.0.0.1:1/v1",
  defaultModel: "qwen2.5",
  apiKey: "",
  ...over,
});

describe("Slice 2 — prepareApiRequest assembly", () => {
  it("resolves the default model when none requested", () => {
    expect(resolveApiModel(ollamaRuntime(), undefined)).toBe("qwen2.5");
  });

  it("accepts an allowlisted model and rejects one outside the allowlist", () => {
    const rt = ollamaRuntime({ models: ["qwen2.5", "llama3.3"] });
    expect(resolveApiModel(rt, "llama3.3")).toBe("llama3.3");
    expect(() => resolveApiModel(rt, "gpt-4o")).toThrow(ApiModelNotAllowedError);
    // The default is always allowed even if not explicitly listed.
    expect(resolveApiModel(ollamaRuntime({ models: ["x"] }), undefined)).toBe("qwen2.5");
  });

  it("assembles system + user messages (system omitted when blank)", () => {
    expect(assembleApiMessages("hi", "be terse")).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ]);
    expect(assembleApiMessages("hi", "   ")).toEqual([{ role: "user", content: "hi" }]);
  });

  it("carries the apiKey from the runtime, never from params", () => {
    const req = prepareApiRequest(ollamaRuntime({ apiKey: "sk-from-runtime" }), { prompt: "yo" });
    expect(req.apiKey).toBe("sk-from-runtime");
    expect(req.model).toBe("qwen2.5");
    expect(req.messages).toEqual([{ role: "user", content: "yo" }]);
  });
});

function mkPersistence(asyncJobsEnabled = true): PersistenceConfig {
  return {
    backend: asyncJobsEnabled ? "memory" : "none",
    path: null,
    dsn: null,
    retentionDays: 30,
    dedupWindowMs: 3_600_000,
    acknowledgeEphemeral: true,
    asyncJobsEnabled,
    sources: { configFile: null, envOverrides: [] },
  };
}

function mkProviders(baseUrl: string, over: Partial<ApiProviderConfig> = {}): ProvidersConfig {
  const provider: ApiProviderConfig = {
    name: "ollama",
    kind: "openai-compatible",
    baseUrl,
    apiKeyEnv: null, // keyless-local
    defaultModel: "qwen2.5",
    ...over,
  };
  return { xai: null, providers: { ollama: provider }, sources: { configFile: null } };
}

describe("Slice 2 — api provider request handlers (loopback)", () => {
  let tempDir: string;
  let sessionManager: FileSessionManager;
  let runtime: GatewayServerRuntime;
  let closeServer: (() => Promise<void>) | null = null;
  let lastBody: any;

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

  async function startServer(
    handler: (req: IncomingMessage, res: ServerResponse, body: any) => void
  ): Promise<string> {
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      lastBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      handler(req, res, lastBody);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    closeServer = () => new Promise(r => server.close(() => r()));
    return `http://127.0.0.1:${addr.port}/v1`;
  }

  beforeEach(() => {
    resetApiProviderBreakers();
    tempDir = mkdtempSync(join(tmpdir(), "api-req-tools-"));
    sessionManager = new FileSessionManager(join(tempDir, "sessions.json"));
  });

  afterEach(async () => {
    if (closeServer) await closeServer();
    closeServer = null;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("runs a sync api request against the provider and returns the text", async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ model: "qwen2.5", choices: [{ message: { content: "hello-api" } }] })
      );
    });
    runtime = buildRuntime(baseUrl);
    const providerRuntime: ApiProviderRuntime = {
      name: "ollama",
      kind: "openai-compatible",
      baseUrl,
      defaultModel: "qwen2.5",
      apiKey: "",
    };
    const res = await handleApiProviderRequest(runtime, providerRuntime, { prompt: "ping" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toBe("hello-api");
    expect(lastBody.messages).toEqual([{ role: "user", content: "ping" }]);
  });

  it("rejects a model outside the allowlist before any HTTP call", async () => {
    runtime = buildRuntime("http://127.0.0.1:1/v1");
    const providerRuntime: ApiProviderRuntime = {
      name: "ollama",
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:1/v1",
      defaultModel: "qwen2.5",
      apiKey: "",
      models: ["qwen2.5"],
    };
    const res = await handleApiProviderRequest(runtime, providerRuntime, {
      prompt: "x",
      model: "gpt-4o",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not in the allowlist/);
  });

  it("async handler starts a job and returns a deferred jobId", async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "x" } }] }));
    });
    runtime = buildRuntime(baseUrl);
    const providerRuntime: ApiProviderRuntime = {
      name: "ollama",
      kind: "openai-compatible",
      baseUrl,
      defaultModel: "qwen2.5",
      apiKey: "",
    };
    const res = handleApiProviderRequestAsync(runtime, providerRuntime, { prompt: "go" });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.status).toBe("deferred");
    expect(parsed.jobId).toBeTruthy();
    expect(parsed.cli).toBe("ollama");
  });
});

describe("Slice 2 — registration gating", () => {
  function fakeServer(): { names: string[]; tool: (...args: any[]) => void } {
    const names: string[] = [];
    return { names, tool: (name: string) => names.push(name) };
  }

  const runtimeStub = {} as GatewayServerRuntime;

  it("registers nothing when no API provider is configured (dormant)", () => {
    const srv = fakeServer();
    const out = registerApiProviderTools(
      srv as any,
      runtimeStub,
      { xai: null, providers: {}, sources: { configFile: null } },
      true
    );
    expect(out).toEqual([]);
    expect(srv.names).toEqual([]);
  });

  it("registers sync + async tools for an enabled provider", () => {
    const srv = fakeServer();
    const providers: ProvidersConfig = {
      xai: null,
      providers: {
        ollama: {
          name: "ollama",
          kind: "openai-compatible",
          baseUrl: "http://127.0.0.1:11434/v1",
          apiKeyEnv: null,
          defaultModel: "qwen2.5",
        },
      },
      sources: { configFile: null },
    };
    const out = registerApiProviderTools(srv as any, runtimeStub, providers, true);
    expect(out).toEqual(["api_ollama_request", "api_ollama_request_async"]);
  });

  it("omits the async tool when async jobs are disabled", () => {
    const srv = fakeServer();
    const providers: ProvidersConfig = {
      xai: null,
      providers: {
        ollama: {
          name: "ollama",
          kind: "openai-compatible",
          baseUrl: "http://127.0.0.1:11434/v1",
          apiKeyEnv: null,
          defaultModel: "qwen2.5",
        },
      },
      sources: { configFile: null },
    };
    const out = registerApiProviderTools(srv as any, runtimeStub, providers, false);
    expect(out).toEqual(["api_ollama_request"]);
  });
});

// Slice 1 — telemetry parity: the generic api_<name>_request path must now write
// a flight-recorder logStart + logComplete (with usage + httpStatus), surface that
// telemetry in structuredContent, honour the usage_include capability, and
// propagate the HTTP status + vendor error body on failure.
class CapturingFlightRecorder extends NoopFlightRecorder {
  starts: FlightLogStart[] = [];
  completes: Array<{ correlationId: string; result: FlightLogResult }> = [];
  logStart(entry: FlightLogStart): void {
    this.starts.push(entry);
  }
  logComplete(correlationId: string, result: FlightLogResult): void {
    this.completes.push({ correlationId, result });
  }
}

describe("Slice 1 — api provider telemetry parity", () => {
  let tempDir: string;
  let sessionManager: FileSessionManager;
  let recorder: CapturingFlightRecorder;
  let runtime: GatewayServerRuntime;
  let closeServer: (() => Promise<void>) | null = null;
  let lastBody: any;

  function buildRuntime(baseUrl: string): GatewayServerRuntime {
    const metrics = new PerformanceMetrics();
    recorder = new CapturingFlightRecorder();
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

  async function startServer(
    handler: (req: IncomingMessage, res: ServerResponse, body: any) => void
  ): Promise<string> {
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      lastBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      handler(req, res, lastBody);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    closeServer = () => new Promise(r => server.close(() => r()));
    return `http://127.0.0.1:${addr.port}/v1`;
  }

  const rt = (baseUrl: string, over: Partial<ApiProviderRuntime> = {}): ApiProviderRuntime => ({
    name: "ollama",
    kind: "openai-compatible",
    baseUrl,
    defaultModel: "qwen2.5",
    apiKey: "",
    ...over,
  });

  beforeEach(() => {
    resetApiProviderBreakers();
    tempDir = mkdtempSync(join(tmpdir(), "api-telemetry-"));
    sessionManager = new FileSessionManager(join(tempDir, "sessions.json"));
  });

  afterEach(async () => {
    if (closeServer) await closeServer();
    closeServer = null;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("records usage + httpStatus in the flight recorder and the tool response", async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: "qwen2.5",
          choices: [{ message: { content: "hi" } }],
          usage: { prompt_tokens: 11, completion_tokens: 7, cost: 0.0009 },
        })
      );
    });
    runtime = buildRuntime(baseUrl);
    const res = await handleApiProviderRequest(runtime, rt(baseUrl), { prompt: "ping" });

    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as any;
    expect(sc.model).toBe("qwen2.5");
    expect(sc.httpStatus).toBe(200);
    expect(sc.inputTokens).toBe(11);
    expect(sc.outputTokens).toBe(7);
    expect(sc.costUsd).toBe(0.0009);

    // Exactly one start + one complete (no double-write between handler and manager).
    expect(recorder.starts).toHaveLength(1);
    expect(recorder.starts[0].cli).toBe("ollama");
    expect(recorder.completes).toHaveLength(1);
    const c = recorder.completes[0].result;
    expect(c.status).toBe("completed");
    expect(c.httpStatus).toBe(200);
    expect(c.inputTokens).toBe(11);
    expect(c.outputTokens).toBe(7);
    expect(c.costUsd).toBe(0.0009);
  });

  it("emits usage:{include:true} only when the provider opts in", async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "x" } }] }));
    });
    runtime = buildRuntime(baseUrl);

    await handleApiProviderRequest(runtime, rt(baseUrl, { usageInclude: true }), { prompt: "on" });
    expect(lastBody.usage).toEqual({ include: true });

    await handleApiProviderRequest(runtime, rt(baseUrl), { prompt: "off" });
    expect(lastBody.usage).toBeUndefined();
  });

  it("propagates httpStatus + vendor error body on an HTTP failure", async () => {
    const baseUrl = await startServer((_req, res) => {
      // 400 is non-transient → no retry/circuit churn → deterministic, fast.
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad-request-detail" } }));
    });
    runtime = buildRuntime(baseUrl);
    const res = await handleApiProviderRequest(runtime, rt(baseUrl), { prompt: "p" });

    expect(res.isError).toBe(true);
    const sc = res.structuredContent as any;
    expect(sc.httpStatus).toBe(400);
    expect(sc.responseBody).toContain("bad-request-detail");

    const c = recorder.completes.at(-1)!.result;
    expect(c.status).toBe("failed");
    expect(c.httpStatus).toBe(400);
  });
});
