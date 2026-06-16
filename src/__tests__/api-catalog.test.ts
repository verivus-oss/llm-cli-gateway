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
import type { ApiProviderRuntime } from "../config.js";

const runtime = (over: Partial<ApiProviderRuntime> = {}): ApiProviderRuntime => ({
  name: "ollama",
  kind: "openai-compatible",
  baseUrl: "http://127.0.0.1:11434/v1",
  defaultModel: "qwen2.5",
  apiKey: "",
  ...over,
});

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
});
