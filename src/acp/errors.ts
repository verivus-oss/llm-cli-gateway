/**
 * Typed ACP error taxonomy.
 *
 * Every ACP error carries two surfaces:
 *
 *  - a `userMessage`: redacted, safe to return to an MCP client. It MUST NOT
 *    contain raw JSON-RPC payloads, prompt text, file contents, credential
 *    paths, tokens, or full provider arguments.
 *  - `debug` metadata: structured fields intended for stderr logger sinks only.
 *    Even here, helpers are provided to redact obvious secrets before logging,
 *    but the contract is that `debug` never reaches the MCP client.
 *
 * This satisfies the security invariants
 * `acp_json_rpc_bodies_must_be_redacted_before_flight_recorder`,
 * `resources_redact_local_paths_and_auth_state`, and
 * `no_prompt_payloads_in_default_logs`.
 */

import type { CliType } from "../session-manager.js";

/** Stable discriminant for the ACP error taxonomy. */
export type AcpErrorKind =
  | "acp_disabled"
  | "provider_acp_disabled"
  | "provider_acp_unsupported"
  | "provider_runtime_disabled"
  | "provider_unavailable"
  | "protocol"
  | "timeout"
  | "permission_denied"
  | "process_exit";

/**
 * Redact substrings that look like secrets, local filesystem paths, or
 * JSON-rich payloads from a free-form string.
 *
 * This is deliberately conservative: it strips anything that resembles a JSON
 * object/array body, absolute paths, home-relative paths, bearer/api tokens,
 * and email addresses. It is applied to every user-facing ACP message and is
 * safe to apply to debug strings before they reach a log sink.
 */
export function redactAcpMessage(input: string): string {
  // Collapse any JSON-looking object/array body to a placeholder so raw
  // JSON-RPC bodies and prompt payloads never leak through messages.
  let out = redactJsonLikeBodies(input);

  // Bearer tokens / api keys.
  out = out.replace(/\b(bearer|token|api[_-]?key|secret)\b\s*[:=]?\s*\S+/gi, "$1 <redacted>");
  out = out.replace(/\b(sk|xai|gsk|key)-[A-Za-z0-9_-]{8,}\b/gi, "<redacted-token>");

  // Windows drive-letter paths (C:\Users\...\credentials.json) and UNC paths
  // (\\server\share\...). Redacted before the POSIX rules so the backslash body
  // is consumed as a unit. The leading boundary mirrors the POSIX rules so
  // quoted/parenthesised forms are covered, and is preserved via the capture.
  out = out.replace(/(^|[^A-Za-z0-9._~\\/-])[A-Za-z]:\\[^\s"')\]}>]*/g, "$1<redacted-path>");
  out = out.replace(/(^|[^A-Za-z0-9._~\\/-])\\\\[^\s"')\]}>]+/g, "$1<redacted-path>");

  // Absolute and home-relative filesystem paths. The leading boundary is any
  // character that is not itself part of a path token (start-of-string, space,
  // or punctuation such as quotes, parentheses, '=', ':' and ',') so that
  // quoted, parenthesised, and key:/path forms are redacted too. The boundary
  // character is preserved via a capture group; only the path is replaced.
  out = out.replace(/(^|[^A-Za-z0-9._~/-])~\/[^\s"')\]}>]+/g, "$1<redacted-path>");
  out = out.replace(/(^|[^A-Za-z0-9._~/-])\/[A-Za-z0-9._/-]{2,}/g, "$1<redacted-path>");

  // Email addresses.
  out = out.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<redacted-email>");

  return out;
}

function redactJsonLikeBodies(input: string): string {
  let out = "";
  let cursor = 0;
  let bodyStart = -1;
  let stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input.charAt(index);

    if (bodyStart === -1) {
      const close = char === "{" ? "}" : char === "[" ? "]" : "";
      if (!close) continue;

      bodyStart = index;
      stack = [close];
      inString = false;
      escaped = false;
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = inString;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    const nestedClose = char === "{" ? "}" : char === "[" ? "]" : "";
    if (nestedClose) {
      stack.push(nestedClose);
      continue;
    }

    if (char !== stack[stack.length - 1]) continue;

    stack.pop();
    if (stack.length > 0) continue;

    out += input.slice(cursor, bodyStart);
    out += "<redacted-json>";
    cursor = index + 1;
    bodyStart = -1;
  }

  if (bodyStart !== -1 && isLikelyJsonPayload(input.slice(bodyStart))) {
    out += input.slice(cursor, bodyStart);
    out += "<redacted-json>";
    cursor = input.length;
  }

  return cursor === 0 ? input : out + input.slice(cursor);
}

function isLikelyJsonPayload(span: string): boolean {
  return /"(?:jsonrpc|method|params|prompt|content|body|token|secret|api[_-]?key|credential|auth|cwd|path|[A-Za-z0-9_-]+)"\s*:/i.test(
    span
  );
}

/**
 * Recursively redact secret-bearing string values in a structured debug object.
 *
 * Keys whose names hint at sensitive content are dropped entirely; remaining
 * string values are passed through {@link redactAcpMessage}. This is the
 * helper transport/flight-recorder code should call before persisting any ACP
 * debug metadata.
 */
export function redactAcpDebug(value: unknown): unknown {
  const sensitiveKey =
    /(payload|body|prompt|content|token|secret|api[_-]?key|credential|auth|cwd|path)/i;

  if (typeof value === "string") {
    return redactAcpMessage(value);
  }
  if (Array.isArray(value)) {
    return value.map(item => redactAcpDebug(item));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (sensitiveKey.test(key)) {
        out[key] = "<redacted>";
        continue;
      }
      out[key] = redactAcpDebug(inner);
    }
    return out;
  }
  return value;
}

/**
 * Redact a thrown cause before it is attached to an {@link AcpError}.
 *
 * Node's `console.error(err)` inspects `err.cause` (and its `message`/`stack`),
 * so an unredacted cause carrying prompt text, credential paths, or tokens would
 * reach stderr through the gateway logger. This helper returns a structurally
 * faithful but redacted stand-in:
 *
 *  - `Error` causes become a fresh `Error` whose `name`, `message`, and `stack`
 *    are all run through {@link redactAcpMessage}; the error *type* is preserved
 *    (a class-default name like "Error" survives redaction unchanged) so log
 *    readers still see the type, but a name embedding a token or credential path
 *    is sanitised — `util.inspect`/`console.error(err)` renders `name` verbatim.
 *  - non-Error causes are routed through {@link redactAcpDebug}.
 */
export function redactAcpCause(cause: unknown): unknown {
  if (cause instanceof Error) {
    const redacted = new Error(redactAcpMessage(cause.message));
    redacted.name = redactAcpMessage(cause.name);
    if (typeof cause.stack === "string") {
      redacted.stack = redactAcpMessage(cause.stack);
    }
    return redacted;
  }
  return redactAcpDebug(cause);
}

/** Structured debug metadata attached to every ACP error. Never client-facing. */
export interface AcpErrorDebug {
  readonly [key: string]: unknown;
}

/**
 * Base class for all typed ACP errors.
 *
 * `message` (the user-facing surface) is redacted at construction time. `debug`
 * is retained for logger sinks and is itself redacted of obvious secrets.
 */
export class AcpError extends Error {
  readonly kind: AcpErrorKind;
  readonly provider?: CliType;
  readonly debug: AcpErrorDebug;

  constructor(
    kind: AcpErrorKind,
    userMessage: string,
    options?: { provider?: CliType; debug?: AcpErrorDebug; cause?: unknown }
  ) {
    super(redactAcpMessage(userMessage));
    this.name = "AcpError";
    this.kind = kind;
    this.provider = options?.provider;
    this.debug = (redactAcpDebug(options?.debug ?? {}) as AcpErrorDebug) ?? {};
    if (options?.cause !== undefined) {
      // Preserve a cause for stderr debugging, but redact it first: Node's
      // console.error inspects error.cause (message + stack), so an unredacted
      // cause carrying prompt text, credential paths, or tokens would leak
      // through the logger. redactAcpCause keeps the error type while stripping
      // the raw secret/path/token material.
      (this as { cause?: unknown }).cause = redactAcpCause(options.cause);
    }
  }

  /** The redacted, MCP-client-safe message. */
  get userMessage(): string {
    return this.message;
  }
}

/** Global ACP gate is disabled in config. */
export class AcpDisabledError extends AcpError {
  constructor(debug?: AcpErrorDebug) {
    super(
      "acp_disabled",
      "ACP transport is disabled. Enable [acp] in the gateway config to use transport=acp, or omit transport to use the default CLI path.",
      { debug }
    );
    this.name = "AcpDisabledError";
  }
}

/** Provider is recognised but ACP is disabled for it in config. */
export class ProviderAcpDisabledError extends AcpError {
  constructor(provider: CliType, debug?: AcpErrorDebug) {
    super(
      "provider_acp_disabled",
      `ACP is disabled for provider ${provider}. Enable it under [acp.providers.${provider}] or omit transport to use the default CLI path.`,
      { provider, debug }
    );
    this.name = "ProviderAcpDisabledError";
  }
}

/** Provider has no native ACP support at its target version. */
export class ProviderAcpUnsupportedError extends AcpError {
  constructor(provider: CliType, debug?: AcpErrorDebug) {
    super(
      "provider_acp_unsupported",
      `Provider ${provider} has no native ACP support at its target version. Use the default CLI transport for this provider.`,
      { provider, debug }
    );
    this.name = "ProviderAcpUnsupportedError";
  }
}

/** ACP is supported and enabled but runtime routing is not enabled for the provider. */
export class ProviderRuntimeDisabledError extends AcpError {
  constructor(provider: CliType, debug?: AcpErrorDebug) {
    super(
      "provider_runtime_disabled",
      `ACP runtime routing is not enabled for provider ${provider}. Set runtime_enabled=true under [acp.providers.${provider}] to allow prompt routing.`,
      { provider, debug }
    );
    this.name = "ProviderRuntimeDisabledError";
  }
}

/** Provider ACP process is unavailable (not installed, unhealthy, or crashed). */
export class ProviderUnavailableError extends AcpError {
  constructor(provider: CliType, reason: string, debug?: AcpErrorDebug) {
    super("provider_unavailable", `Provider ${provider} ACP entrypoint is unavailable: ${reason}`, {
      provider,
      debug,
    });
    this.name = "ProviderUnavailableError";
  }
}

/** A JSON-RPC level protocol error returned by, or detected against, the agent. */
export class AcpProtocolError extends AcpError {
  /** JSON-RPC error code when one was provided by the agent. */
  readonly code?: number;

  constructor(
    userMessage: string,
    options?: { provider?: CliType; code?: number; debug?: AcpErrorDebug }
  ) {
    super("protocol", userMessage, { provider: options?.provider, debug: options?.debug });
    this.name = "AcpProtocolError";
    this.code = options?.code;
  }
}

/** A pending ACP request exceeded its timeout. */
export class AcpTimeoutError extends AcpError {
  /** ACP method that timed out (e.g. "initialize", "session/new"). */
  readonly method: string;
  /** Configured timeout in milliseconds. */
  readonly timeoutMs: number;

  constructor(
    method: string,
    timeoutMs: number,
    options?: { provider?: CliType; debug?: AcpErrorDebug }
  ) {
    super("timeout", `ACP request ${method} timed out after ${timeoutMs}ms.`, {
      provider: options?.provider,
      debug: options?.debug,
    });
    this.name = "AcpTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

/** A provider permission callback was denied by the gateway approval surface. */
export class AcpPermissionDeniedError extends AcpError {
  constructor(provider: CliType, reason: string, debug?: AcpErrorDebug) {
    super("permission_denied", `ACP permission request was denied: ${reason}`, { provider, debug });
    this.name = "AcpPermissionDeniedError";
  }
}

/** The provider ACP process exited (cleanly or via crash) while requests were pending. */
export class AcpProcessExitError extends AcpError {
  /** Process exit code, when known. */
  readonly exitCode: number | null;
  /** Terminating signal, when known. */
  readonly signal: string | null;

  constructor(
    provider: CliType,
    options?: { exitCode?: number | null; signal?: string | null; debug?: AcpErrorDebug }
  ) {
    super("process_exit", `Provider ${provider} ACP process exited before the request completed.`, {
      provider,
      debug: options?.debug,
    });
    this.name = "AcpProcessExitError";
    this.exitCode = options?.exitCode ?? null;
    this.signal = options?.signal ?? null;
  }
}

/** Narrowing helper for ACP errors. */
export function isAcpError(value: unknown): value is AcpError {
  return value instanceof AcpError;
}
