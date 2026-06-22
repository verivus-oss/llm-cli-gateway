/**
 * Slice 2: shared assembly point for API-provider request tools.
 *
 * `prepareApiRequest` turns the tool-facing params (prompt/system/model/sampling)
 * plus an enabled provider's runtime config into the canonical `ApiRequest` the
 * HttpJobRunner executes. It is the single place that resolves the model against
 * the provider's optional allowlist and assembles the single-shot message array,
 * so the direct `api_<name>_request` tools (Slice 2) and the reviewer path
 * (Slice 3) build identical requests.
 */
import type { ApiProviderRuntime } from "./config.js";
import type { ApiChatMessage, ApiRequest } from "./api-provider.js";

export interface PrepareApiRequestParams {
  /** Plain prompt text (assembled into a single user message). */
  prompt: string;
  /** Optional system instruction (assembled into a leading system message). */
  system?: string;
  /** Requested model; defaults to the provider's default_model. */
  model?: string;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  reasoningEffort?: "none" | "low" | "medium" | "high";
  timeoutMs?: number;
  /** xAI Responses continuation handle (ignored by other adapters). */
  previousResponseId?: string;
}

export interface ApiProviderCatalogEntry {
  name: string;
  providerKind: "api";
  kind: ApiProviderRuntime["kind"];
  defaultModel: string;
  models: string[] | null;
}

/**
 * Slice 5: the discovery/catalog projection of an enabled API provider, tagged
 * `providerKind:"api"`. Shared by `list_available_models` and the
 * `llm_process_health` outbound-providers block so both expose the same shape.
 */
export function apiProviderCatalogEntry(runtime: ApiProviderRuntime): ApiProviderCatalogEntry {
  return {
    name: runtime.name,
    providerKind: "api",
    kind: runtime.kind,
    defaultModel: runtime.defaultModel,
    models: runtime.models ?? null,
  };
}

export class ApiModelNotAllowedError extends Error {
  constructor(
    readonly provider: string,
    readonly model: string,
    readonly allowed: readonly string[]
  ) {
    super(
      `Model "${model}" is not in the allowlist for provider "${provider}". Allowed: ${allowed.join(", ")}.`
    );
    this.name = "ApiModelNotAllowedError";
  }
}

/**
 * Resolve the model for a provider request: the caller's `model` if it passes
 * the optional allowlist, else the provider default. Throws
 * `ApiModelNotAllowedError` when an explicit model is outside a configured
 * allowlist (the default model is always permitted even if not listed).
 */
export function resolveApiModel(runtime: ApiProviderRuntime, requested?: string): string {
  if (!requested) return runtime.defaultModel;
  if (runtime.models && runtime.models.length > 0 && !runtime.models.includes(requested)) {
    throw new ApiModelNotAllowedError(runtime.name, requested, runtime.models);
  }
  return requested;
}

/** Assemble the single-shot message array (system first, then the user prompt). */
export function assembleApiMessages(prompt: string, system?: string): ApiChatMessage[] {
  const messages: ApiChatMessage[] = [];
  if (system && system.trim().length > 0) {
    messages.push({ role: "system", content: system });
  }
  messages.push({ role: "user", content: prompt });
  return messages;
}

/**
 * Build the canonical `ApiRequest` for an enabled provider. The api key is read
 * from the resolved runtime (never from caller params) and is carried only in
 * memory — the HttpJobRunner excludes it from anything persisted.
 */
export function prepareApiRequest(
  runtime: ApiProviderRuntime,
  params: PrepareApiRequestParams
): ApiRequest {
  return {
    baseUrl: runtime.baseUrl,
    apiKey: runtime.apiKey,
    model: resolveApiModel(runtime, params.model),
    messages: assembleApiMessages(params.prompt, params.system),
    maxOutputTokens: params.maxOutputTokens,
    temperature: params.temperature,
    topP: params.topP,
    reasoningEffort: params.reasoningEffort,
    timeoutMs: params.timeoutMs,
    previousResponseId: params.previousResponseId,
    // Slice 1: provider-level capability (never a caller param) → opt the
    // openai-compatible adapter into usage:{include:true} when configured.
    usageInclude: runtime.usageInclude,
  };
}
