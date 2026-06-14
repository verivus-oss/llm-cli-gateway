/**
 * Conservative, high-confidence secret redaction for content written to the
 * flight-recorder audit log (prompts, system prompts, responses).
 *
 * Scope & intent (F4, MCP-surface red-team 2026-06-14):
 * - The flight recorder stores prompt/system/response verbatim in
 *   `~/.llm-cli-gateway/logs.db` and surfaces them via `llm_request_result`
 *   (includePrompt), cache-stats, and MCP resources. Any credential a caller
 *   pastes into a prompt would otherwise persist in cleartext indefinitely.
 * - We redact only *recognisable* secret shapes (provider keys, cloud keys,
 *   tokens, PEM private keys, JWTs, and explicit `key = value` secret
 *   assignments). The goal is to neutralise obvious credential leakage without
 *   mangling ordinary prose, code, or legitimate LLM output.
 *
 * Deliberately NOT applied to the async job store (`jobs.db`): that stdout/
 * stderr is the durable *result-delivery* channel a caller reads back via
 * `llm_job_result`; redacting it would corrupt legitimate results. Job content
 * at rest is mitigated by retention/expiry + 0600 file perms instead.
 */

const REDACTED = "[REDACTED]";

interface RedactionRule {
  readonly label: string;
  readonly pattern: RegExp;
  /** Replacement; when omitted the whole match becomes `[REDACTED]`. */
  readonly replace?: (match: string, ...groups: string[]) => string;
}

// Each pattern is anchored on a distinctive prefix/shape to keep false
// positives low. `g` flag is required (we use String.replace with global).
const RULES: readonly RedactionRule[] = [
  // PEM private key blocks (any flavour). Must come first — multiline.
  {
    label: "private-key",
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
  },
  // Anthropic keys (sk-ant-...) — before the generic sk- rule.
  { label: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  // OpenAI keys (sk-..., sk-proj-...).
  { label: "openai-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g },
  // xAI keys.
  { label: "xai-key", pattern: /\bxai-[A-Za-z0-9]{16,}/g },
  // Google API keys.
  { label: "google-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // AWS access key IDs.
  { label: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_).
  { label: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  // Slack tokens.
  { label: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  // JSON Web Tokens (header.payload.signature, all base64url).
  {
    label: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  // `Authorization: Bearer <token>` / bare `Bearer <token>`.
  {
    label: "bearer",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g,
    replace: () => `Bearer ${REDACTED}`,
  },
  // URL userinfo password: scheme://user:pass@host -> scheme://user:[REDACTED]@host
  {
    label: "url-credential",
    pattern: /([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+):[^\s/@]+@/gi,
    replace: (_m, prefix: string) => `${prefix}:${REDACTED}@`,
  },
  // Explicit secret assignments: password=..., api_key: "...", client_secret = '...'.
  // Keeps the key, redacts the value (quoted or unquoted, >=6 chars). Only
  // high-confidence compound/sensitive keys — bare `token` / `secret` /
  // `authorization` are intentionally excluded to avoid redacting ordinary code
  // (`const token = parseToken(x)`) and the already-handled `Authorization:
  // Bearer` header.
  {
    label: "secret-assignment",
    pattern:
      /\b(password|passwd|pwd|secret[_-]?key|client[_-]?secret|api[_-]?key|access[_-]?key|auth[_-]?token)\b(\s*[:=]\s*)(?:"[^"\n]{6,}"|'[^'\n]{6,}'|[^\s"'\n,;]{6,})/gi,
    replace: (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`,
  },
];

/** Returns true unless redaction is explicitly disabled. */
export function isRedactionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.LLM_GATEWAY_REDACT_LOGGED_SECRETS ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

/**
 * Replace recognisable secrets in `text` with `[REDACTED]`. Pure and
 * idempotent; returns the input unchanged when no pattern matches. Non-string
 * / empty inputs are returned as-is.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const rule of RULES) {
    out = rule.replace
      ? out.replace(rule.pattern, rule.replace as (substring: string, ...args: any[]) => string)
      : out.replace(rule.pattern, REDACTED);
  }
  return out;
}

/** Convenience: redact only when enabled and the value is a non-empty string. */
export function redactIfEnabled(value: string | null | undefined, enabled: boolean): typeof value {
  if (!enabled || !value) return value;
  return redactSecrets(value);
}
