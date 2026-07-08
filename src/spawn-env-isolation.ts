import type { Logger } from "./logger.js";
import { logWarn } from "./logger.js";

/**
 * Spawn-env isolation.
 *
 * Provider CLIs (claude/codex/gemini/...) are spawned with the gateway's own
 * `process.env` inherited (only PATH is extended). If that environment contains
 * an LLM endpoint override (`*_BASE_URL` / `*_API_URL` / `*_API_BASE` /
 * `*_ENDPOINT`, a unix-socket or Grok leader-socket redirect, ...) or a proxy
 * (any `*_PROXY`: HTTP(S)/ALL/FTP/SOCKS), every spawned CLI silently routes its
 * model traffic through it. A hostile endpoint on the other end can
 * then inject tool calls that the CLI executes locally (read `.env`, run shell),
 * which is the "provider is part of the control plane" exfiltration class.
 *
 * The per-request `env` parameter is already allowlisted (`assertUpstreamCliEnv`),
 * so a *caller* cannot inject these. This module closes the remaining gap: the
 * *inherited host env*. It is applied at the single spawn chokepoint
 * (`spawnCliProcess`, plus the ACP process env builder) so it operates on the
 * FINAL merged environment and cannot be bypassed by an upstream `{ ...process.env }`
 * re-splat at a call site.
 *
 * It is opt-in (`LLM_GATEWAY_ISOLATE_SPAWN_ENV`) because self-hosted operators
 * legitimately point a CLI at a private endpoint via exactly these variables;
 * silently stripping them by default would break those setups.
 *
 * NOTE: this is a best-effort denylist of the known LLM-endpoint / proxy
 * redirection surface, not an exhaustive allowlist. It deliberately does not
 * strip TLS-trust vars (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`): those cannot
 * redirect traffic on their own, and stripping them would break legitimate
 * corporate-CA setups. A stricter allowlist mode is a possible future hardening.
 */

/**
 * Suffix patterns for endpoint-override variables. Matched against the
 * upper-cased key, so both `ANTHROPIC_BASE_URL` and `anthropic_base_url` hit.
 * Covers `*_BASE_URL`, `*_API_URL`, `*_API_BASE`, `*_ENDPOINT`, `*_ENDPOINT_URL`
 * (e.g. `AWS_ENDPOINT_URL`), and `*_SERVER_URL` (e.g. `WINDSURF_API_SERVER_URL`).
 */
const REDIRECTION_SUFFIXES: readonly RegExp[] = [
  /_BASE_URL$/,
  /_API_URL$/,
  /_API_BASE$/,
  /_ENDPOINT$/,
  /_ENDPOINT_URL$/,
  /_SERVER_URL$/,
];

/**
 * Exact keys that redirect provider traffic but do not fit a suffix pattern.
 * Socket-based redirects: `ANTHROPIC_UNIX_SOCKET` (Claude) and `GROK_LEADER_SOCKET`
 * (Grok routes through a leader process at this socket). Proxy variables are
 * handled by the `_PROXY` rule below, which preserves `NO_PROXY`.
 */
const REDIRECTION_EXACT: ReadonlySet<string> = new Set([
  "ANTHROPIC_UNIX_SOCKET",
  "GROK_LEADER_SOCKET",
]);

/**
 * True when `key` can redirect where a spawned CLI sends its LLM/API traffic.
 * Case-insensitive (env vars appear as both `HTTPS_PROXY` and `https_proxy`).
 */
export function isRedirectionEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  // NO_PROXY narrows egress (a de-facto allowlist); always preserve it.
  if (upper === "NO_PROXY") return false;
  // Any proxy variable: HTTP(S)_PROXY, ALL_PROXY, FTP_PROXY, SOCKS_PROXY,
  // SOCKS5_PROXY, ... (all redirect outbound traffic).
  if (upper.endsWith("_PROXY")) return true;
  if (REDIRECTION_EXACT.has(upper)) return true;
  return REDIRECTION_SUFFIXES.some(re => re.test(upper));
}

/**
 * Opt-in gate. Off unless explicitly enabled: hardening that changes egress
 * paths must not silently break intentional self-hosted/proxy configurations.
 */
export function isSpawnEnvIsolationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.LLM_GATEWAY_ISOLATE_SPAWN_ENV ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

export interface SpawnEnvSanitizeResult {
  env: NodeJS.ProcessEnv;
  /** Keys removed from the input, in encounter order. */
  stripped: string[];
}

/**
 * Pure: return a shallow copy of `baseEnv` with every redirection variable
 * removed, alongside the list of removed keys. Does not consult the opt-in flag
 * and does not mutate `baseEnv`.
 */
export function sanitizeSpawnEnv(baseEnv: NodeJS.ProcessEnv): SpawnEnvSanitizeResult {
  const env: NodeJS.ProcessEnv = {};
  const stripped: string[] = [];
  for (const key of Object.keys(baseEnv)) {
    if (isRedirectionEnvKey(key)) {
      stripped.push(key);
      continue;
    }
    env[key] = baseEnv[key];
  }
  return { env, stripped };
}

let warnedOnce = false;

/** Reset the one-time warning latch. Test-only. */
export function resetSpawnEnvIsolationWarning(): void {
  warnedOnce = false;
}

/**
 * Apply spawn-env isolation to a final, already-merged spawn environment, gated
 * on the opt-in flag. Returns the input unchanged (same reference) when disabled.
 * When active and something is stripped, warn once (to stderr, via the logger)
 * so the operator can see which host variables are being withheld.
 *
 * The latch is only armed once a warning is actually emitted, so an early
 * logger-less call cannot swallow the single operator-visible signal.
 */
export function applySpawnEnvIsolation(
  finalEnv: NodeJS.ProcessEnv,
  logger?: Logger,
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  if (!isSpawnEnvIsolationEnabled(env)) return finalEnv;
  const { env: sanitized, stripped } = sanitizeSpawnEnv(finalEnv);
  if (stripped.length > 0 && logger && !warnedOnce) {
    warnedOnce = true;
    logWarn(
      logger,
      `spawn-env isolation: withheld ${stripped.length} endpoint/proxy redirection variable(s) ` +
        `from provider child processes (${stripped.join(", ")}). ` +
        `Unset LLM_GATEWAY_ISOLATE_SPAWN_ENV to disable.`
    );
  }
  return sanitized;
}
