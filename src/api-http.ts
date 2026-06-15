/**
 * Shared HTTP primitives for API-endpoint providers (Slice 0).
 *
 * Extracted from `xai-api-provider.ts` so every adapter (OpenAI-compatible,
 * Anthropic, xAI Responses) shares one `node:http`/`node:https` client with the
 * same 50MB response cap, timeout handling, and https-or-loopback guard. Staying
 * on `node:https` (never `fetch`/axios) is what keeps the Socket/`fetch`-token
 * release audit green — see the release-security-audit `dist` scan.
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";

/** Hard cap on a single API response body — mirrors the executor's DoS guard. */
export const MAX_API_RESPONSE_BYTES = 50 * 1024 * 1024;
export const DEFAULT_API_TIMEOUT_MS = 600_000;

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"];

/** Error carrying the HTTP status + raw body so callers/retry can classify it. */
export class ApiHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly responseText = "",
    readonly code?: string
  ) {
    super(message);
    this.name = "ApiHttpError";
  }
}

/**
 * True when `value` is an https URL, or an http URL pointing at localhost/
 * loopback (the local-model exception — Ollama/vLLM/LM Studio run on
 * `http://127.0.0.1`). Plain `http://` to any other host is rejected so secrets
 * never cross the wire in cleartext.
 */
export function isHttpsOrLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    return LOOPBACK_HOSTS.includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * True only for an http(s) URL whose host is localhost/loopback. Drives the
 * keyless-local provider exception (an empty API key is allowed only when the
 * endpoint is on this machine).
 */
export function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      LOOPBACK_HOSTS.includes(url.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Build `<baseUrl>/<path>` and enforce the https-or-loopback rule, throwing an
 * `ApiHttpError` when an adapter is pointed at a cleartext remote endpoint.
 */
export function buildEndpointUrl(baseUrl: string, path: string): URL {
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const trimmedPath = path.replace(/^\/+/, "");
  const url = new URL(`${trimmedBase}/${trimmedPath}`);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname))
  ) {
    throw new ApiHttpError(
      `API base_url must use https unless it targets localhost/loopback (got ${url.protocol}//${url.hostname})`
    );
  }
  return url;
}

/** Retryable-transport classifier shared by every adapter's `isTransient`. */
export function isHttpTransient(error: unknown): boolean {
  const status = typeof (error as any)?.status === "number" ? (error as any).status : null;
  if (status === 429 || (status !== null && status >= 500)) return true;
  return ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE"].includes(
    String((error as any)?.code ?? "")
  );
}

export interface ApiHttpResponse {
  status: number;
  text: string;
}

/**
 * POST a JSON body and return the raw `{ status, text }`. Throws `ApiHttpError`
 * on a non-2xx status (so `withRetry`'s `isTransient` sees the status code), on
 * timeout, on the 50MB overflow, and on socket errors. `headers` carries the
 * adapter-specific auth (Bearer, `x-api-key`, …); `content-type`/`accept`/
 * `content-length` are always set here.
 */
export function postJson(
  url: URL,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
  extractErrorMessage: (status: number, responseBody: string) => string = defaultErrorMessage
): Promise<ApiHttpResponse> {
  const payload = JSON.stringify(body);
  const requester = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = requester(
      url,
      {
        method: "POST",
        timeout: timeoutMs,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...headers,
          "content-length": Buffer.byteLength(payload),
        },
      },
      res => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", chunk => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buf.length;
          if (bytes > MAX_API_RESPONSE_BYTES) {
            req.destroy(new ApiHttpError("API response exceeded the 50MB limit", null));
            return;
          }
          chunks.push(buf);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new ApiHttpError(extractErrorMessage(status, text), status, text));
            return;
          }
          resolve({ status, text });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new ApiHttpError("API request timed out", null, "", "ETIMEDOUT"));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

function defaultErrorMessage(status: number, body: string): string {
  if (!body) return `API request failed with HTTP ${status}`;
  try {
    const parsed = JSON.parse(body) as any;
    const message = parsed?.error?.message ?? parsed?.message ?? parsed?.error;
    if (typeof message === "string" && message.length > 0) {
      return `API request failed with HTTP ${status}: ${message}`;
    }
  } catch {
    // Fall through to a bounded excerpt.
  }
  return `API request failed with HTTP ${status}: ${body.slice(0, 1000)}`;
}
