/**
 * Phase 4 slice β — Mistral Vibe `meta.json` parser.
 *
 * Vibe persists per-session telemetry to `~/.vibe/logs/session/<id>/meta.json`
 * (NOT `metadata.json` as an earlier TODO comment claimed). Fields of
 * interest live under `stats`:
 *
 *   stats.session_prompt_tokens      → inputTokens
 *   stats.session_completion_tokens  → outputTokens
 *   stats.session_cost               → costUsd
 *
 * Cache-token surfaces are not exposed by Vibe today, so `cacheReadTokens`
 * and `cacheCreationTokens` are intentionally absent.
 *
 * Best-effort by design: any failure (missing file, bad JSON, missing
 * fields, gateway-generated `gw-*` sessionId we can't resolve to a Vibe
 * directory) returns `{}` so the flight-recorder row simply lacks usage
 * data — exactly as it did before this slice.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { GATEWAY_SESSION_PREFIX } from "./request-helpers.js";

export interface VibeMetaJsonUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

interface RawMetaJson {
  stats?: {
    session_prompt_tokens?: unknown;
    session_completion_tokens?: unknown;
    session_cost?: unknown;
  };
}

function asPositiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

export function parseVibeMetaJson(
  home: string,
  sessionId: string | undefined
): VibeMetaJsonUsage {
  if (!sessionId) return {};
  if (sessionId.startsWith(GATEWAY_SESSION_PREFIX)) {
    // gw-* IDs are gateway internal — Vibe never wrote a meta.json under that name.
    return {};
  }
  const path = join(home, ".vibe", "logs", "session", sessionId, "meta.json");
  if (!existsSync(path)) return {};

  let raw: RawMetaJson;
  try {
    const text = readFileSync(path, "utf-8");
    raw = JSON.parse(text) as RawMetaJson;
  } catch {
    return {};
  }

  const stats = raw?.stats;
  if (!stats || typeof stats !== "object") return {};

  return {
    inputTokens: asPositiveNumber(stats.session_prompt_tokens),
    outputTokens: asPositiveNumber(stats.session_completion_tokens),
    costUsd: asPositiveNumber(stats.session_cost),
  };
}
