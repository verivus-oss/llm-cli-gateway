import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";
import { createCircuitBreaker, withRetry, type CircuitBreaker } from "./retry.js";
import type { Logger } from "./logger.js";
import { logWarn, noopLogger } from "./logger.js";

const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 600_000;

export type XaiResponsesRole = "system" | "user" | "assistant";
export type XaiReasoningEffort = "none" | "low" | "medium" | "high";

export interface XaiResponsesInputMessage {
  role: XaiResponsesRole;
  content: string;
}

export interface XaiResponsesRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  input: string | XaiResponsesInputMessage[];
  instructions?: string;
  previousResponseId?: string;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  reasoningEffort?: XaiReasoningEffort;
  timeoutMs?: number;
}

export interface XaiResponsesUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  raw?: unknown;
}

export interface XaiResponsesResult {
  responseId: string | null;
  model: string;
  status: string | null;
  text: string;
  usage: XaiResponsesUsage;
  raw: unknown;
  httpStatus: number;
}

export class XaiApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly responseText = "",
    readonly code?: string
  ) {
    super(message);
    this.name = "XaiApiError";
  }
}

let xaiCircuitBreaker: CircuitBreaker | null = null;

function getXaiCircuitBreaker(logger: Logger): CircuitBreaker {
  xaiCircuitBreaker ??= createCircuitBreaker({
    failureThreshold: 3,
    resetTimeout: 60_000,
    onStateChange: state => logWarn(logger, `[xai-api] circuit breaker state changed to ${state}`),
  });
  return xaiCircuitBreaker;
}

function isHttpTransient(error: any): boolean {
  const status = typeof error?.status === "number" ? error.status : null;
  if (status === 429 || (status !== null && status >= 500)) return true;
  return ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE"].includes(String(error?.code ?? ""));
}

function responsesUrl(baseUrl: string): URL {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const url = new URL(`${trimmed}/responses`);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname))
  ) {
    throw new XaiApiError("xAI API baseUrl must use https unless it targets localhost/loopback");
  }
  return url;
}

function extractErrorMessage(status: number, body: string): string {
  if (!body) return `xAI API request failed with HTTP ${status}`;
  try {
    const parsed = JSON.parse(body) as any;
    const message = parsed?.error?.message ?? parsed?.message ?? parsed?.error;
    if (typeof message === "string" && message.length > 0) {
      return `xAI API request failed with HTTP ${status}: ${message}`;
    }
  } catch {
    // Fall through to a bounded body excerpt.
  }
  return `xAI API request failed with HTTP ${status}: ${body.slice(0, 1000)}`;
}

function normalizeCostUsd(usage: any): number | undefined {
  const ticks = usage?.cost_in_usd_ticks;
  if (typeof ticks === "number" && Number.isFinite(ticks)) return ticks / 10_000_000_000;
  const nanos = usage?.cost_in_nano_usd;
  if (typeof nanos === "number" && Number.isFinite(nanos)) return nanos / 1_000_000_000;
  return undefined;
}

function extractResponseText(parsed: any): string {
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

function parseResponsesResult(status: number, body: string): XaiResponsesResult {
  const parsed = JSON.parse(body) as any;
  const usage = parsed?.usage ?? {};
  return {
    responseId: typeof parsed?.id === "string" ? parsed.id : null,
    model: typeof parsed?.model === "string" ? parsed.model : "unknown",
    status: typeof parsed?.status === "string" ? parsed.status : null,
    text: extractResponseText(parsed),
    usage: {
      inputTokens:
        typeof usage.input_tokens === "number"
          ? usage.input_tokens
          : typeof usage.prompt_tokens === "number"
            ? usage.prompt_tokens
            : undefined,
      outputTokens:
        typeof usage.output_tokens === "number"
          ? usage.output_tokens
          : typeof usage.completion_tokens === "number"
            ? usage.completion_tokens
            : undefined,
      cacheReadTokens:
        typeof usage?.input_tokens_details?.cached_tokens === "number"
          ? usage.input_tokens_details.cached_tokens
          : typeof usage?.prompt_tokens_details?.cached_tokens === "number"
            ? usage.prompt_tokens_details.cached_tokens
            : undefined,
      costUsd: normalizeCostUsd(usage),
      raw: usage,
    },
    raw: parsed,
    httpStatus: status,
  };
}

function postJson(url: URL, body: unknown, apiKey: string, timeoutMs: number): Promise<string> {
  const payload = JSON.stringify(body);
  const requester = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = requester(
      url,
      {
        method: "POST",
        timeout: timeoutMs,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      res => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", chunk => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buf.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            req.destroy(new XaiApiError("xAI API response exceeded the 50MB limit", null));
            return;
          }
          chunks.push(buf);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            const err = new XaiApiError(extractErrorMessage(status, text), status, text);
            reject(err);
            return;
          }
          resolve(text);
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new XaiApiError("xAI API request timed out", null, "", "ETIMEDOUT"));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

export async function createXaiResponse(
  params: XaiResponsesRequest,
  logger: Logger = noopLogger
): Promise<XaiResponsesResult> {
  const requestBody: Record<string, unknown> = {
    model: params.model,
    input: params.input,
    store: true,
  };
  if (params.instructions) requestBody.instructions = params.instructions;
  if (params.previousResponseId) requestBody.previous_response_id = params.previousResponseId;
  if (params.maxOutputTokens !== undefined) requestBody.max_output_tokens = params.maxOutputTokens;
  if (params.temperature !== undefined) requestBody.temperature = params.temperature;
  if (params.topP !== undefined) requestBody.top_p = params.topP;
  if (params.reasoningEffort !== undefined) {
    requestBody.reasoning = { effort: params.reasoningEffort };
  }

  const url = responsesUrl(params.baseUrl);
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const body = await withRetry(
    () => postJson(url, requestBody, params.apiKey, timeoutMs),
    getXaiCircuitBreaker(logger),
    {
      initialDelay: 1_000,
      maxDelay: 30_000,
      factor: 2,
      isTransient: isHttpTransient,
      onRetry: (error, attempt, delay) => {
        logWarn(
          logger,
          `[xai-api] transient request failure on attempt ${attempt}; retrying in ${delay}ms: ${error.message}`
        );
      },
    },
    logger
  );
  return parseResponsesResult(200, body);
}
