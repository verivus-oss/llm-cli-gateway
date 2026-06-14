import type { IncomingMessage } from "node:http";

/**
 * Thrown when an inbound HTTP request body exceeds the configured size cap.
 * The HTTP transport's top-level catch maps `statusCode === 413` to a
 * `413 Payload Too Large` response instead of a generic 500.
 */
export class PayloadTooLargeError extends Error {
  readonly statusCode = 413;
  constructor(maxBytes: number) {
    super(`Request body exceeds maximum size (${maxBytes} bytes)`);
    this.name = "PayloadTooLargeError";
  }
}

// MCP JSON-RPC bodies carry prompts (schema-capped at 100k chars) plus
// structured fields, so the default is generous; the point is to reject
// multi-GB / slow-loris bodies, not to constrain legitimate requests.
const DEFAULT_MAX_HTTP_BODY_BYTES = 8 * 1024 * 1024;
// OAuth register/authorize/token bodies are tiny form/JSON payloads.
const DEFAULT_MAX_OAUTH_BODY_BYTES = 64 * 1024;

function positiveIntFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function maxHttpBodyBytes(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntFromEnv(env.LLM_GATEWAY_MAX_HTTP_BODY_BYTES, DEFAULT_MAX_HTTP_BODY_BYTES);
}

export function maxOAuthBodyBytes(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntFromEnv(env.LLM_GATEWAY_MAX_OAUTH_BODY_BYTES, DEFAULT_MAX_OAUTH_BODY_BYTES);
}

/**
 * Read a request body into a string, rejecting with {@link PayloadTooLargeError}
 * and destroying the socket as soon as the accumulated byte count exceeds
 * `maxBytes`. Replaces unbounded `Buffer.concat` accumulators that allowed an
 * unauthenticated client to exhaust gateway memory.
 */
export function readCappedRawBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer | string) => {
      if (aborted) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        aborted = true;
        // Drop accumulated chunks and discard the rest of the stream so memory
        // stays bounded, but keep the socket open so the caller can still write
        // a 413 response. `resume()` flushes remaining inbound data to /dev/null.
        chunks.length = 0;
        reject(new PayloadTooLargeError(maxBytes));
        req.resume();
        return;
      }
      chunks.push(buf);
    });
    req.on("error", err => {
      if (!aborted) reject(err);
    });
    req.on("end", () => {
      if (aborted) return;
      resolve(chunks.length === 0 ? "" : Buffer.concat(chunks).toString("utf8"));
    });
  });
}
