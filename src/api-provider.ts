/**
 * Generic API-endpoint provider abstraction (Slice 0).
 *
 * A single `ApiProvider` interface with three adapters — OpenAI-compatible
 * (`/chat/completions`, covers Ollama/vLLM/LM Studio/OpenAI/Groq/Together/
 * OpenRouter), Anthropic Messages, and xAI Responses. All adapters are
 * single-shot (the full message array is resent each call); the xAI adapter
 * additionally threads `previous_response_id` for server-side continuity.
 *
 * Every adapter routes through `src/api-http.ts` (`node:https`, 50MB cap,
 * https-or-loopback guard), and `runApiRequest` wraps the call in the shared
 * `withRetry` + a per-provider circuit breaker. No `fetch`/axios — the release
 * Socket audit scans shipped `dist` for the `fetch` token.
 */
import type { URL } from "node:url";
import { createCircuitBreaker, withRetry, type CircuitBreaker } from "./retry.js";
import type { Logger } from "./logger.js";
import { logWarn, noopLogger } from "./logger.js";
import {
  ApiHttpError,
  buildEndpointUrl,
  isHttpTransient,
  postJson,
  DEFAULT_API_TIMEOUT_MS,
} from "./api-http.js";

export type ApiProviderKind = "openai-compatible" | "anthropic" | "xai-responses";

export interface ApiChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ApiRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Single-shot: the full prompt is resent each call. */
  messages: ApiChatMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  reasoningEffort?: "none" | "low" | "medium" | "high";
  timeoutMs?: number;
  /** xAI Responses only: server-side continuation handle. */
  previousResponseId?: string;
}

export interface ApiUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  raw?: unknown;
}

export interface ApiResult {
  model: string;
  text: string;
  usage: ApiUsage;
  raw: unknown;
  httpStatus: number;
  /** xAI Responses returns an id used as the next `previous_response_id`. */
  responseId?: string | null;
}

export interface ApiProvider {
  /** Config key, e.g. "ollama", "openai", "xai". */
  readonly name: string;
  readonly kind: ApiProviderKind;
  /** Endpoint URL with the https-or-loopback guard applied. */
  endpointUrl(baseUrl: string): URL;
  buildBody(req: ApiRequest): Record<string, unknown>;
  parseResult(httpStatus: number, body: string): ApiResult;
  authHeaders(apiKey: string): Record<string, string>;
  isTransient(err: unknown): boolean;
}

//──────────────────────────────────────────────────────────────────────────────
// Shared helpers
//──────────────────────────────────────────────────────────────────────────────

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** First defined numeric field among `candidates` (handles vendor key drift). */
function firstNumber(...candidates: unknown[]): number | undefined {
  for (const candidate of candidates) {
    const n = numberOrUndefined(candidate);
    if (n !== undefined) return n;
  }
  return undefined;
}

//──────────────────────────────────────────────────────────────────────────────
// OpenAI-compatible (/chat/completions)
//──────────────────────────────────────────────────────────────────────────────

export class OpenAiCompatibleProvider implements ApiProvider {
  readonly kind = "openai-compatible" as const;
  constructor(readonly name: string) {}

  endpointUrl(baseUrl: string): URL {
    return buildEndpointUrl(baseUrl, "chat/completions");
  }

  buildBody(req: ApiRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map(m => ({ role: m.role, content: m.content })),
    };
    if (req.maxOutputTokens !== undefined) body.max_tokens = req.maxOutputTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.topP !== undefined) body.top_p = req.topP;
    return body;
  }

  parseResult(httpStatus: number, body: string): ApiResult {
    const parsed = JSON.parse(body) as any;
    const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : undefined;
    const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
    // Local servers (Ollama/llama.cpp) often omit `usage` entirely — degrade
    // gracefully to an empty usage record rather than throwing.
    const usage = parsed?.usage ?? {};
    return {
      model: typeof parsed?.model === "string" ? parsed.model : "unknown",
      text,
      usage: {
        inputTokens: firstNumber(usage.prompt_tokens, usage.input_tokens),
        outputTokens: firstNumber(usage.completion_tokens, usage.output_tokens),
        cacheReadTokens: firstNumber(usage?.prompt_tokens_details?.cached_tokens),
        raw: usage,
      },
      raw: parsed,
      httpStatus,
    };
  }

  authHeaders(apiKey: string): Record<string, string> {
    // Keyless local servers run with an empty key — send no Authorization header.
    return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  }

  isTransient(err: unknown): boolean {
    return isHttpTransient(err);
  }
}

//──────────────────────────────────────────────────────────────────────────────
// Anthropic Messages (/messages)
//──────────────────────────────────────────────────────────────────────────────

export const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;

export class AnthropicProvider implements ApiProvider {
  readonly kind = "anthropic" as const;
  constructor(
    readonly name: string,
    private readonly anthropicVersion: string = DEFAULT_ANTHROPIC_VERSION
  ) {}

  endpointUrl(baseUrl: string): URL {
    return buildEndpointUrl(baseUrl, "messages");
  }

  buildBody(req: ApiRequest): Record<string, unknown> {
    // Anthropic carries `system` as a top-level field, not a message role.
    const system = req.messages
      .filter(m => m.role === "system")
      .map(m => m.content)
      .join("\n\n");
    const messages = req.messages
      .filter(m => m.role !== "system")
      .map(m => ({ role: m.role, content: m.content }));
    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      // `max_tokens` is REQUIRED by the Anthropic Messages API.
      max_tokens: req.maxOutputTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
    };
    if (system.length > 0) body.system = system;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.topP !== undefined) body.top_p = req.topP;
    return body;
  }

  parseResult(httpStatus: number, body: string): ApiResult {
    const parsed = JSON.parse(body) as any;
    const blocks = Array.isArray(parsed?.content) ? parsed.content : [];
    const text = blocks
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("");
    const usage = parsed?.usage ?? {};
    return {
      model: typeof parsed?.model === "string" ? parsed.model : "unknown",
      text,
      usage: {
        inputTokens: firstNumber(usage.input_tokens),
        outputTokens: firstNumber(usage.output_tokens),
        cacheReadTokens: firstNumber(usage.cache_read_input_tokens),
        raw: usage,
      },
      raw: parsed,
      httpStatus,
    };
  }

  authHeaders(apiKey: string): Record<string, string> {
    return { "x-api-key": apiKey, "anthropic-version": this.anthropicVersion };
  }

  isTransient(err: unknown): boolean {
    return isHttpTransient(err);
  }
}

//──────────────────────────────────────────────────────────────────────────────
// xAI Responses (/responses) — generic twin of the legacy createXaiResponse.
//──────────────────────────────────────────────────────────────────────────────

function normalizeXaiCostUsd(usage: any): number | undefined {
  const ticks = usage?.cost_in_usd_ticks;
  if (typeof ticks === "number" && Number.isFinite(ticks)) return ticks / 10_000_000_000;
  const nanos = usage?.cost_in_nano_usd;
  if (typeof nanos === "number" && Number.isFinite(nanos)) return nanos / 1_000_000_000;
  return undefined;
}

function extractXaiResponseText(parsed: any): string {
  const output = Array.isArray(parsed?.output) ? parsed.output : [];
  const chunks: string[] = [];
  for (const item of output) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (
        (content?.type === "output_text" || content?.type === "text") &&
        typeof content.text === "string"
      ) {
        chunks.push(content.text);
      }
    }
  }
  if (chunks.length > 0) return chunks.join("");
  if (typeof parsed?.output_text === "string") return parsed.output_text;
  return "";
}

export class XaiResponsesProvider implements ApiProvider {
  readonly kind = "xai-responses" as const;
  constructor(readonly name: string) {}

  endpointUrl(baseUrl: string): URL {
    return buildEndpointUrl(baseUrl, "responses");
  }

  buildBody(req: ApiRequest): Record<string, unknown> {
    // system → `instructions`; remaining messages → `input` array.
    const instructions = req.messages
      .filter(m => m.role === "system")
      .map(m => m.content)
      .join("\n\n");
    const input = req.messages
      .filter(m => m.role !== "system")
      .map(m => ({ role: m.role, content: m.content }));
    const body: Record<string, unknown> = { model: req.model, input, store: true };
    if (instructions.length > 0) body.instructions = instructions;
    if (req.previousResponseId) body.previous_response_id = req.previousResponseId;
    if (req.maxOutputTokens !== undefined) body.max_output_tokens = req.maxOutputTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.topP !== undefined) body.top_p = req.topP;
    if (req.reasoningEffort !== undefined) body.reasoning = { effort: req.reasoningEffort };
    return body;
  }

  parseResult(httpStatus: number, body: string): ApiResult {
    const parsed = JSON.parse(body) as any;
    const usage = parsed?.usage ?? {};
    return {
      responseId: typeof parsed?.id === "string" ? parsed.id : null,
      model: typeof parsed?.model === "string" ? parsed.model : "unknown",
      text: extractXaiResponseText(parsed),
      usage: {
        inputTokens: firstNumber(usage.input_tokens, usage.prompt_tokens),
        outputTokens: firstNumber(usage.output_tokens, usage.completion_tokens),
        cacheReadTokens: firstNumber(
          usage?.input_tokens_details?.cached_tokens,
          usage?.prompt_tokens_details?.cached_tokens
        ),
        costUsd: normalizeXaiCostUsd(usage),
        raw: usage,
      },
      raw: parsed,
      httpStatus,
    };
  }

  authHeaders(apiKey: string): Record<string, string> {
    return { authorization: `Bearer ${apiKey}` };
  }

  isTransient(err: unknown): boolean {
    return isHttpTransient(err);
  }
}

//──────────────────────────────────────────────────────────────────────────────
// Factory + runner
//──────────────────────────────────────────────────────────────────────────────

/** Build the adapter for a provider `kind`, bound to its config `name`. */
export function createApiProvider(name: string, kind: ApiProviderKind): ApiProvider {
  switch (kind) {
    case "openai-compatible":
      return new OpenAiCompatibleProvider(name);
    case "anthropic":
      return new AnthropicProvider(name);
    case "xai-responses":
      return new XaiResponsesProvider(name);
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unknown api provider kind: ${String(exhaustive)}`);
    }
  }
}

const breakers = new Map<string, CircuitBreaker>();

/** One circuit breaker per provider name (xAI's failure threshold of 3). */
function getProviderBreaker(name: string, logger: Logger): CircuitBreaker {
  let breaker = breakers.get(name);
  if (!breaker) {
    breaker = createCircuitBreaker({
      failureThreshold: 3,
      resetTimeout: 60_000,
      onStateChange: state =>
        logWarn(logger, `[api:${name}] circuit breaker state changed to ${state}`),
    });
    breakers.set(name, breaker);
  }
  return breaker;
}

/** Test-only: reset the per-provider circuit breakers. */
export function resetApiProviderBreakers(): void {
  breakers.clear();
}

/** Execute an API request: build → post (retry + breaker) → parse. */
export async function runApiRequest(
  provider: ApiProvider,
  req: ApiRequest,
  logger: Logger = noopLogger,
  opts: { signal?: AbortSignal } = {}
): Promise<ApiResult> {
  const url = provider.endpointUrl(req.baseUrl);
  const body = provider.buildBody(req);
  const headers = provider.authHeaders(req.apiKey);
  const timeoutMs = req.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  const response = await withRetry(
    () => postJson(url, body, headers, timeoutMs, undefined, opts.signal),
    getProviderBreaker(provider.name, logger),
    {
      initialDelay: 1_000,
      maxDelay: 30_000,
      factor: 2,
      isTransient: err => provider.isTransient(err),
      onRetry: (error, attempt, delay) => {
        logWarn(
          logger,
          `[api:${provider.name}] transient failure on attempt ${attempt}; retrying in ${delay}ms: ${
            (error as Error).message
          }`
        );
      },
    },
    logger
  );
  return provider.parseResult(response.status, response.text);
}

export { ApiHttpError };
