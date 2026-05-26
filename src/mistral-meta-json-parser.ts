/**
 * Phase 4 slice β — Mistral Vibe `meta.json` parser.
 *
 * Vibe writes per-session telemetry to
 *
 *   ~/.vibe/logs/session/session_<YYYYMMDD>_<HHMMSS>_<first8hex>/meta.json
 *
 * where `<first8hex>` is the first 8 lowercase hex characters of the full
 * session UUID. Inside the file:
 *
 *   {
 *     "session_id": "<full-uuid>",
 *     "stats": {
 *       "session_prompt_tokens":      <number>  → inputTokens
 *       "session_completion_tokens":  <number>  → outputTokens
 *       "session_cost":               <number>  → costUsd
 *     }
 *   }
 *
 * The gateway's mistral session-id surface accepts the full UUID (so does
 * `vibe --resume <uuid>`). To find the right directory we glob for
 * `session_*_<first8>` and disambiguate by reading each candidate's
 * `session_id` field. If callers happen to pass the directory basename
 * itself we still honour that — useful for tests and for forward-compat if
 * Vibe ever changes its dir naming scheme.
 *
 * Cache-token surfaces are not exposed by Vibe today, so `cacheReadTokens`
 * and `cacheCreationTokens` are intentionally absent.
 *
 * Best-effort by design: any failure (missing file, bad JSON, missing
 * fields, gateway-generated `gw-*` sessionId, unresolvable UUID, path
 * outside the session log root) returns `{}` so the flight-recorder row
 * simply lacks usage data.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, resolve, sep } from "path";

import { GATEWAY_SESSION_PREFIX } from "./request-helpers.js";

export interface VibeMetaJsonUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

interface RawMetaJson {
  session_id?: unknown;
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

// UUID v4-ish (Vibe's own session UUIDs are not strictly v4, so we
// validate against the broader 8-4-4-4-12 lowercase-hex shape) OR
// Vibe's session_<digits>_<digits>_<first8> directory basename.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIRNAME_RE = /^session_\d{8}_\d{6}_[0-9a-f]{8}$/;

/**
 * Resolve the session-log directory basename for a given gateway sessionId.
 * Returns undefined when no candidate can be found or the input is
 * unsuitable. Pure with respect to side-effects on the caller — only reads
 * the filesystem.
 */
function resolveVibeSessionDirname(baseDir: string, sessionId: string): string | undefined {
  // 1. Caller already supplied the directory name verbatim.
  if (DIRNAME_RE.test(sessionId) && existsSync(join(baseDir, sessionId, "meta.json"))) {
    return sessionId;
  }
  // 2. Treat the input as a full session UUID.
  if (!UUID_RE.test(sessionId)) return undefined;
  const short = sessionId.slice(0, 8).toLowerCase();

  let entries: string[];
  try {
    entries = readdirSync(baseDir);
  } catch {
    return undefined;
  }

  // Filter to candidates matching `session_*_<short>`. Sort newest-first
  // by mtime as a tiebreaker; on disambiguation we still read each
  // candidate's `session_id` field below.
  const candidates = entries
    .filter(name => DIRNAME_RE.test(name) && name.endsWith(`_${short}`))
    .map(name => {
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(join(baseDir, name)).mtimeMs;
      } catch {
        /* ignore */
      }
      return { name, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0].name;

  for (const { name } of candidates) {
    try {
      const text = readFileSync(join(baseDir, name, "meta.json"), "utf-8");
      const parsed = JSON.parse(text) as RawMetaJson;
      if (typeof parsed.session_id === "string" && parsed.session_id === sessionId) {
        return name;
      }
    } catch {
      /* ignore and continue */
    }
  }
  return undefined;
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

  const baseDir = resolve(join(home, ".vibe", "logs", "session"));
  const dirname = resolveVibeSessionDirname(baseDir, sessionId);
  if (!dirname) return {};

  // Defensive: ensure the joined path resolves under baseDir even after
  // following any symlinks below. `resolveVibeSessionDirname` already
  // restricts to a strict charset, but treat this as the security boundary.
  const candidate = resolve(join(baseDir, dirname, "meta.json"));
  const baseWithSep = baseDir.endsWith(sep) ? baseDir : baseDir + sep;
  if (!candidate.startsWith(baseWithSep)) return {};
  if (!existsSync(candidate)) return {};

  let raw: RawMetaJson;
  try {
    const text = readFileSync(candidate, "utf-8");
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
