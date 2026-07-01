/**
 * Slice 5 — discovery/catalog for API providers.
 *
 * The shared catalog projection (apiProviderCatalogEntry) and the circuit-breaker
 * state surfaced by llm_process_health.
 */
import { describe, expect, it } from "vitest";
import { apiProviderCatalogEntry } from "../api-request.js";
import { apiProviderBreakerState, resetApiProviderBreakers } from "../api-provider.js";
import { registerValidationTools } from "../validation-tools.js";
import { createGatewayServer } from "../index.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { getAvailableCliInfo } from "../model-registry.js";
import { noopLogger } from "../logger.js";
import type { ApiProviderRuntime, PersistenceConfig, ProvidersConfig } from "../config.js";

const runtime = (over: Partial<ApiProviderRuntime> = {}): ApiProviderRuntime => ({
  name: "ollama",
  kind: "openai-compatible",
  apiKeyEnv: null,
  baseUrl: "http://127.0.0.1:11434/v1",
  defaultModel: "qwen2.5",
  apiKey: "",
  ...over,
});

const NONE_PERSISTENCE: PersistenceConfig = {
  backend: "none",
  path: null,
  dsn: null,
  retentionDays: 30,
  dedupWindowMs: 0,
  acknowledgeEphemeral: true,
  asyncJobsEnabled: false,
  sources: { configFile: null, envOverrides: [] },
};

// A keyless-local loopback openai-compatible provider is enabled without any env
// stubbing (isApiProviderEnabled returns true for loopback openai-compatible).
const mkProviders = (withOllama: boolean): ProvidersConfig => ({
  xai: null,
  providers: withOllama
    ? {
        ollama: {
          name: "ollama",
          kind: "openai-compatible",
          apiKeyEnv: null,
          baseUrl: "http://127.0.0.1:11434/v1",
          defaultModel: "qwen2.5",
          models: ["qwen2.5", "llama3.3"],
        },
      }
    : {},
  sources: { configFile: null },
});

function makeServer(providers: ProvidersConfig): ReturnType<typeof createGatewayServer> {
  const manager = new AsyncJobManager(noopLogger, undefined, null);
  return createGatewayServer({
    asyncJobManager: manager,
    persistence: NONE_PERSISTENCE,
    providers,
  });
}

function listModelsTool(server: ReturnType<typeof createGatewayServer>): {
  handler?: (a: unknown, b: unknown) => Promise<{ content: Array<{ text: string }> }>;
  callback?: (a: unknown, b: unknown) => Promise<{ content: Array<{ text: string }> }>;
  inputSchema?: { parse: (a: unknown) => unknown };
} {
  const reg = (server as unknown as Record<string, Record<string, unknown>>)._registeredTools;
  return reg["list_models"] as never;
}

async function listModels(
  server: ReturnType<typeof createGatewayServer>,
  args: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const tool = listModelsTool(server);
  const fn = tool.handler ?? tool.callback;
  if (!fn) throw new Error("list_models not registered");
  const result = await fn(args, {});
  return JSON.parse(result.content[0].text);
}

async function providerToolCapabilities(
  server: ReturnType<typeof createGatewayServer>,
  args: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const reg = (server as unknown as Record<string, Record<string, unknown>>)._registeredTools;
  const tool = reg["provider_tool_capabilities"] as {
    handler?: (a: unknown, b: unknown) => Promise<{ content: Array<{ text: string }> }>;
    callback?: (a: unknown, b: unknown) => Promise<{ content: Array<{ text: string }> }>;
  };
  const fn = tool.handler ?? tool.callback;
  if (!fn) throw new Error("provider_tool_capabilities not registered");
  const result = await fn(args, {});
  return JSON.parse(result.content[0].text);
}

describe("Slice 5 — API provider catalog", () => {
  it("projects an enabled provider as a providerKind:'api' catalog entry", () => {
    expect(apiProviderCatalogEntry(runtime({ models: ["qwen2.5", "llama3.3"] }))).toEqual({
      name: "ollama",
      providerKind: "api",
      kind: "openai-compatible",
      defaultModel: "qwen2.5",
      models: ["qwen2.5", "llama3.3"],
    });
  });

  it("never exposes the apiKey in the catalog entry", () => {
    const entry = apiProviderCatalogEntry(runtime({ apiKey: "sk-secret" }));
    expect(JSON.stringify(entry)).not.toContain("sk-secret");
    expect("apiKey" in entry).toBe(false);
  });

  it("reports CLOSED breaker state for a provider with no prior request", () => {
    resetApiProviderBreakers();
    expect(apiProviderBreakerState("never-used-provider")).toBe("CLOSED");
  });

  it("list_available_models omits apiProviders when dormant, includes them when enabled", async () => {
    const handlers: Record<string, (...a: any[]) => any> = {};
    const fakeServer = {
      tool: (name: string, _d: any, _s: any, _a: any, handler: any) => {
        handlers[name] = handler;
      },
    } as any;

    // Dormant: no apiProviders configured → the field is absent entirely.
    registerValidationTools(fakeServer, { asyncJobManager: {} as any });
    const dormant = await handlers["list_available_models"]({});
    expect("apiProviders" in dormant.structuredContent).toBe(false);

    // Enabled: the field appears, tagged providerKind:"api".
    registerValidationTools(fakeServer, { asyncJobManager: {} as any, apiProviders: [runtime()] });
    const enabled = await handlers["list_available_models"]({});
    expect(enabled.structuredContent.apiProviders).toEqual([apiProviderCatalogEntry(runtime())]);
  });

  // Slice 5: list_models surfaces enabled API providers under `apiProviders`,
  // mirroring list_available_models, while staying byte-identical when dormant.
  it("list_models is byte-identical to getAvailableCliInfo() when no API providers are enabled", async () => {
    const server = makeServer(mkProviders(false));
    const result = await listModels(server, {});
    expect("apiProviders" in result).toBe(false);
    expect(result).toEqual(getAvailableCliInfo());
  });

  it("list_models (unfiltered) appends an apiProviders array when a provider is enabled, keeping CLI entries", async () => {
    const server = makeServer(mkProviders(true));
    const result = await listModels(server, {});
    expect(result.apiProviders).toEqual([
      apiProviderCatalogEntry(runtime({ models: ["qwen2.5", "llama3.3"] })),
    ]);
    // CLI providers are still present alongside the API providers.
    expect(result.claude).toBeDefined();
    expect(result.codex).toBeDefined();
  });

  it("list_models filtered by an API provider name returns it under apiProviders", async () => {
    const server = makeServer(mkProviders(true));
    const result = await listModels(server, { cli: "ollama" });
    expect(result).toEqual({
      apiProviders: [apiProviderCatalogEntry(runtime({ models: ["qwen2.5", "llama3.3"] }))],
    });
  });

  it("list_models filtered by a CLI type returns only that CLI, no apiProviders", async () => {
    const server = makeServer(mkProviders(true));
    const result = await listModels(server, { cli: "claude" });
    expect(Object.keys(result)).toEqual(["claude"]);
    expect("apiProviders" in result).toBe(false);
  });

  it("list_models filter enum accepts enabled API provider names and rejects unknown ones", () => {
    const withProvider = listModelsTool(makeServer(mkProviders(true))).inputSchema!;
    expect(() => withProvider.parse({ cli: "ollama" })).not.toThrow();
    expect(() => withProvider.parse({ cli: "claude" })).not.toThrow();

    const dormant = listModelsTool(makeServer(mkProviders(false))).inputSchema!;
    expect(() => dormant.parse({ cli: "ollama" })).toThrow(); // not enabled => not in the enum
    expect(() => dormant.parse({ cli: "claude" })).not.toThrow();
  });

  it("provider_tool_capabilities resolves enabled API provider names from the server runtime", async () => {
    const server = makeServer(mkProviders(true));
    const result = await providerToolCapabilities(server, { cli: "ollama" });
    expect(result.ollama).toMatchObject({
      cli: "ollama",
      providerKind: "api",
      gatewayRequestTools: ["api_ollama_request"],
    });
  });
});

// Slice 6 follow-up: llm_process_health is a diagnostic surface that emits each
// provider's base_url. base_url is config-supplied and may carry URL userinfo,
// so it must be redacted here too (the Slice 6 redaction pass covered doctor /
// login-guidance but not this Slice 5 surface).
async function processHealthText(server: ReturnType<typeof createGatewayServer>): Promise<string> {
  const reg = (server as unknown as Record<string, Record<string, unknown>>)._registeredTools;
  const tool = reg["llm_process_health"] as {
    handler?: (a: unknown, b: unknown) => Promise<{ content: Array<{ text: string }> }>;
    callback?: (a: unknown, b: unknown) => Promise<{ content: Array<{ text: string }> }>;
  };
  const fn = tool.handler ?? tool.callback;
  if (!fn) throw new Error("llm_process_health not registered");
  const result = await fn({}, {});
  return result.content[0].text;
}

describe("Slice 6 follow-up: llm_process_health base_url redaction", () => {
  const XAI_KEY = "PH_XAI_KEY";
  const GEN_KEY = "PH_GEN_KEY";

  it("redacts base_url userinfo for both the xai block and generic apiProviders", async () => {
    process.env[XAI_KEY] = "xai-secret";
    process.env[GEN_KEY] = "gen-secret";
    try {
      const providers: ProvidersConfig = {
        xai: {
          apiKeyEnv: XAI_KEY,
          baseUrl: "https://xaiuser:xaipw@xai.example/v1",
          defaultModel: "grok-4",
        },
        providers: {
          xai: {
            name: "xai",
            kind: "xai-responses",
            apiKeyEnv: XAI_KEY,
            baseUrl: "https://xaiuser:xaipw@xai.example/v1",
            defaultModel: "grok-4",
          },
          gen: {
            name: "gen",
            kind: "openai-compatible",
            apiKeyEnv: GEN_KEY,
            baseUrl: "https://genuser:genpw@gen.example/v1",
            defaultModel: "m1",
          },
        },
        sources: { configFile: null },
      };
      const text = await processHealthText(makeServer(providers));
      // Neither the xai dedicated block nor the generic apiProviders array may
      // echo userinfo; the host/scheme/path stay intact.
      expect(text).not.toContain("xaipw");
      expect(text).not.toContain("xaiuser");
      expect(text).not.toContain("genpw");
      expect(text).not.toContain("genuser");
      expect(text).toContain("xai.example");
      expect(text).toContain("gen.example");
    } finally {
      delete process.env[XAI_KEY];
      delete process.env[GEN_KEY];
    }
  });
});
