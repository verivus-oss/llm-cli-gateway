/**
 * Cache observability aggregates.
 *
 * Pure read-only aggregation over the FlightRecorder's `requests` table.
 * No new storage — every value is computed at query time from existing
 * columns (`cache_read_tokens`, `cache_creation_tokens`, `stable_prefix_*`,
 * `datetime_utc`, etc.).
 *
 * COALESCE / NULL handling: rows from before the v3 migration have NULL
 * for stable_prefix_*. Rows from CLIs whose parser does not surface cache
 * tokens (gemini, grok, mistral, and codex until its parser is fixed)
 * have NULL for cache_read_tokens / cache_creation_tokens. All aggregates
 * tolerate NULL via COALESCE(col, 0) — never divides by zero.
 */

import type { FlightRecorderQuery } from "./flight-recorder.js";
import { estimateCacheSavingsUsd } from "./pricing.js";

export type CacheStatsCli = "claude" | "codex" | "gemini" | "grok" | "mistral";

export interface SessionCacheStats {
  sessionId: string;
  cli: CacheStatsCli | null;
  /** Total cache_read_tokens across all rows in this session. */
  totalCacheReadTokens: number;
  /** Total cache_creation_tokens across all rows in this session. */
  totalCacheCreationTokens: number;
  /** Number of rows in this session. */
  requestCount: number;
  /** Number of rows where cache_read_tokens > 0. */
  hitCount: number;
  /** hitCount / requestCount (0 when requestCount = 0). */
  hitRate: number;
  /** Distinct stable_prefix_hash values seen in this session. */
  distinctPrefixCount: number;
  /** Last time any row in this session was written (datetime_utc max). ISO string or null. */
  lastRequestAt: string | null;
  /** Estimated USD saved by cache reads in this session (best-effort). */
  estimatedSavingsUsd: number;
  /**
   * Slice 3: best-effort remaining TTL on the Anthropic cache breakpoint
   * established at lastRequestAt. Null for non-claude CLIs (we have no
   * read on their cache state) and null when lastRequestAt is null.
   * Computed by computeTtlRemaining(); see ttlPolicy parameter.
   */
  ttlRemainingMs: number | null;
  /**
   * Slice κ: number of explicit or auto-emitted cache control blocks on
   * the latest request in this session.
   */
  latestCacheControlBlocks?: number | null;
  /**
   * Slice κ v5: TTL seconds recorded for the latest request's emitted
   * cache_control blocks. Null for rows without gateway-emitted markers
   * and for legacy rows predating the v5 recorder column.
   */
  latestCacheControlTtlSeconds?: number | null;
}

export interface PrefixCacheStats {
  stablePrefixHash: string;
  requestCount: number;
  hitCount: number;
  hitRate: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  /** Distinct CLI x model combos that hashed to this prefix. */
  cliBreakdown: Array<{ cli: CacheStatsCli; model: string; count: number }>;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  estimatedSavingsUsd: number;
}

export interface GlobalCacheStats {
  /** Optional window: rows since (now - lastNHours * 3600s). */
  windowHours: number | null;
  totalRequests: number;
  totalHits: number;
  hitRate: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  perCli: Array<{
    cli: CacheStatsCli;
    requestCount: number;
    hitCount: number;
    hitRate: number;
    totalCacheReadTokens: number;
    totalCacheCreationTokens: number;
    estimatedSavingsUsd: number;
  }>;
  estimatedSavingsUsd: number;
  /**
   * Rec #3 (slice κ): derived metrics that distinguish gateway-driven
   * κ-explicit `cache_control` breakpoints from Claude Code's
   * own baseline cache reads.
   *
   * - explicitCacheControlRows: rows where the gateway emitted at
   *   least one `cache_control` marker (`cache_control_blocks > 0`).
   * - explicitCacheControlHits: those rows whose `cache_read_tokens
   *   > 0` — closest signal we have to "the caller's marked block
   *   actually hit Anthropic's cache" (still includes Claude Code's
   *   baseline cache reads on top, which is unavoidable without
   *   per-block token accounting from Anthropic).
   * - explicitCacheControlHitRate: ratio explicit hits / explicit rows.
   * - stablePrefixReuseCount: distinct `stable_prefix_hash` values
   *   that appear in >1 row in-window (i.e. real reuse opportunities).
   * - avgCacheCreationAfterFirstCall: averaged across stable-prefix
   *   reuse groups, the cache_creation_tokens on rows AFTER the
   *   first-by-datetime in each group. Drops sharply when caller
   *   blocks are reused; stays high when Claude Code's session-wrap
   *   floor dominates.
   */
  explicitCacheControlRows: number;
  explicitCacheControlHits: number;
  explicitCacheControlHitRate: number;
  stablePrefixReuseCount: number;
  avgCacheCreationAfterFirstCall: number | null;
}

interface RawRow {
  cli: string;
  model: string;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  stable_prefix_hash: string | null;
  datetime_utc: string;
  /**
   * Rec #3 (slice κ): number of caller-supplied content blocks the
   * gateway emitted with an explicit `cache_control` marker. NULL on
   * pre-v4 rows and on non-Claude / non-κ Claude rows.
   */
  cache_control_blocks?: number | null;
  cache_control_ttl_seconds?: number | null;
}

function safeNum(n: number | null | undefined): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

function isCacheStatsCli(s: string): s is CacheStatsCli {
  return s === "claude" || s === "codex" || s === "gemini" || s === "grok" || s === "mistral";
}

/**
 * Normalise a logged `cli` value into a CacheStatsCli bucket, or null if it
 * does not roll up to one of the five base CLIs.
 *
 * The grok HTTP path logs rows with `cli: "grok-api"` and is the only grok
 * code path that actually parses cache tokens
 * (`input_tokens_details.cached_tokens`). Those rows must aggregate under the
 * `grok` bucket — otherwise the one grok path with cache telemetry is
 * silently dropped from per-CLI and global cache stats.
 *
 * Slice 0.5: an arbitrary `[providers.<name>]` (kind:"api") id has no CLI bucket
 * and intentionally rolls up to `null` here (excluded from the five-CLI cache
 * aggregates). A first-class per-API-provider cache catalog is deferred to
 * Slice 5; until then this is exclusion-by-design, not a dropped-telemetry bug.
 */
function normalizeCacheStatsCli(s: string): CacheStatsCli | null {
  if (s === "grok-api") return "grok";
  return isCacheStatsCli(s) ? s : null;
}

export function computeSessionCacheStats(
  db: FlightRecorderQuery,
  sessionId: string
): SessionCacheStats {
  const rows = db.queryRequests<RawRow>(
    `SELECT cli, model,
            COALESCE(cache_read_tokens, 0) AS cache_read_tokens,
            COALESCE(cache_creation_tokens, 0) AS cache_creation_tokens,
            stable_prefix_hash,
            datetime_utc,
            cache_control_blocks,
            cache_control_ttl_seconds
     FROM requests
     WHERE session_id = ?
     ORDER BY datetime_utc DESC`,
    sessionId
  );

  let totalRead = 0;
  let totalCreation = 0;
  let hitCount = 0;
  const prefixSet = new Set<string>();
  let lastAt: string | null = null;
  let cli: CacheStatsCli | null = null;
  let estimatedSavingsUsd = 0;

  for (const row of rows) {
    const reads = safeNum(row.cache_read_tokens);
    const creation = safeNum(row.cache_creation_tokens);
    totalRead += reads;
    totalCreation += creation;
    if (reads > 0) hitCount += 1;
    if (row.stable_prefix_hash) prefixSet.add(row.stable_prefix_hash);
    if (!lastAt || row.datetime_utc > lastAt) lastAt = row.datetime_utc;
    const rowCli = normalizeCacheStatsCli(row.cli);
    if (cli === null && rowCli !== null) cli = rowCli;
    if (rowCli !== null) {
      estimatedSavingsUsd += estimateCacheSavingsUsd(rowCli, row.model, reads);
    }
  }

  const requestCount = rows.length;
  return {
    sessionId,
    cli,
    totalCacheReadTokens: totalRead,
    totalCacheCreationTokens: totalCreation,
    requestCount,
    hitCount,
    hitRate: requestCount > 0 ? hitCount / requestCount : 0,
    distinctPrefixCount: prefixSet.size,
    lastRequestAt: lastAt,
    estimatedSavingsUsd,
    // ttlRemainingMs is populated by computeTtlRemaining() — the field
    // exists on the type so the resource shape is uniform, but its value
    // is left null here. Callers (session_get / cache_state resources)
    // apply the configured TTL policy and set the field.
    ttlRemainingMs: null,
    latestCacheControlBlocks: rows.length > 0 ? (rows[0].cache_control_blocks ?? null) : null,
    latestCacheControlTtlSeconds:
      rows.length > 0 ? (rows[0].cache_control_ttl_seconds ?? null) : null,
  };
}

export interface TtlPolicy {
  /**
   * Seconds: how long Anthropic holds a cache entry after the last
   * write. Default 300 (5 minutes). Set to 3600 when the operator has
   * opted into Anthropic's 1-hour cache TTL via
   * `[cache_awareness].anthropic_ttl_seconds = 3600`.
   */
  anthropicTtlSeconds: 300 | 3600;
  /** Defaults to `() => Date.now()`. Overridable for deterministic tests. */
  now?: () => number;
}

/**
 * Slice 3: compute the best-effort milliseconds remaining on the cache
 * breakpoint established at `stats.lastRequestAt`.
 *
 * - Claude: Anthropic's documented TTL (5min default, 1h beta). Computed
 *   as max(0, ttl - (now - lastWriteAt)).
 * - Other CLIs: returns null. We do not observe the provider's actual
 *   cache state, so any number we'd return would be a guess. session_get
 *   and cache_state resources should report null for these.
 *
 * Note: this is "best effort". A cache eviction inside Anthropic's
 * window will NOT be visible to us — the warning may be optimistic
 * (see risks section in dag.toml).
 */
export function computeTtlRemaining(
  stats: SessionCacheStats,
  cli: CacheStatsCli | null,
  ttlPolicy: TtlPolicy
): number | null {
  if (cli !== "claude") return null;
  if (!stats.lastRequestAt) return null;
  const nowMs = (ttlPolicy.now ?? Date.now)();
  const lastWriteMs = Date.parse(stats.lastRequestAt);
  if (!Number.isFinite(lastWriteMs)) return null;
  const elapsedMs = nowMs - lastWriteMs;
  // Slice κ: if the last request had explicit or auto-emitted cache control
  // breakpoints, the actual TTL set on the Anthropic cache breakpoint was
  // 1 hour (3600 seconds), regardless of the configured default policy.
  const isExplicit =
    typeof stats.latestCacheControlBlocks === "number" && stats.latestCacheControlBlocks > 0;
  const recordedTtlSeconds =
    typeof stats.latestCacheControlTtlSeconds === "number" &&
    Number.isFinite(stats.latestCacheControlTtlSeconds) &&
    stats.latestCacheControlTtlSeconds > 0
      ? stats.latestCacheControlTtlSeconds
      : null;
  const ttlSeconds = recordedTtlSeconds ?? (isExplicit ? 3600 : ttlPolicy.anthropicTtlSeconds);
  const ttlMs = ttlSeconds * 1000;
  return Math.max(0, ttlMs - elapsedMs);
}

export function computePrefixCacheStats(
  db: FlightRecorderQuery,
  stablePrefixHash: string
): PrefixCacheStats {
  const rows = db.queryRequests<RawRow>(
    `SELECT cli, model,
            COALESCE(cache_read_tokens, 0) AS cache_read_tokens,
            COALESCE(cache_creation_tokens, 0) AS cache_creation_tokens,
            stable_prefix_hash,
            datetime_utc
     FROM requests
     WHERE stable_prefix_hash = ?
     ORDER BY datetime_utc ASC`,
    stablePrefixHash
  );

  let totalRead = 0;
  let totalCreation = 0;
  let hitCount = 0;
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  let estimatedSavingsUsd = 0;
  const cliMap = new Map<string, { cli: CacheStatsCli; model: string; count: number }>();

  for (const row of rows) {
    const reads = safeNum(row.cache_read_tokens);
    totalRead += reads;
    totalCreation += safeNum(row.cache_creation_tokens);
    if (reads > 0) hitCount += 1;
    if (!firstAt) firstAt = row.datetime_utc;
    lastAt = row.datetime_utc;
    const rowCli = normalizeCacheStatsCli(row.cli);
    if (rowCli !== null) {
      estimatedSavingsUsd += estimateCacheSavingsUsd(rowCli, row.model, reads);
      const key = `${rowCli}::${row.model}`;
      const entry = cliMap.get(key);
      if (entry) {
        entry.count += 1;
      } else {
        cliMap.set(key, { cli: rowCli, model: row.model, count: 1 });
      }
    }
  }

  const requestCount = rows.length;
  return {
    stablePrefixHash,
    requestCount,
    hitCount,
    hitRate: requestCount > 0 ? hitCount / requestCount : 0,
    totalCacheReadTokens: totalRead,
    totalCacheCreationTokens: totalCreation,
    cliBreakdown: Array.from(cliMap.values()).sort((a, b) => b.count - a.count),
    firstSeenAt: firstAt,
    lastSeenAt: lastAt,
    estimatedSavingsUsd,
  };
}

export interface GlobalCacheStatsOpts {
  /** If set, restrict to rows whose datetime_utc is within the last N hours. */
  lastNHours?: number;
}

export function computeGlobalCacheStats(
  db: FlightRecorderQuery,
  opts: GlobalCacheStatsOpts = {}
): GlobalCacheStats {
  const windowHours = opts.lastNHours ?? null;
  const sinceIso =
    windowHours !== null && windowHours > 0
      ? new Date(Date.now() - windowHours * 3600_000).toISOString()
      : null;

  const sql = sinceIso
    ? `SELECT cli, model,
              COALESCE(cache_read_tokens, 0) AS cache_read_tokens,
              COALESCE(cache_creation_tokens, 0) AS cache_creation_tokens,
              stable_prefix_hash,
              datetime_utc,
              cache_control_blocks,
              cache_control_ttl_seconds
       FROM requests
       WHERE datetime_utc >= ?`
    : `SELECT cli, model,
              COALESCE(cache_read_tokens, 0) AS cache_read_tokens,
              COALESCE(cache_creation_tokens, 0) AS cache_creation_tokens,
              stable_prefix_hash,
              datetime_utc,
              cache_control_blocks,
              cache_control_ttl_seconds
       FROM requests`;
  const rows = sinceIso ? db.queryRequests<RawRow>(sql, sinceIso) : db.queryRequests<RawRow>(sql);

  interface CliAgg {
    requestCount: number;
    hitCount: number;
    totalCacheReadTokens: number;
    totalCacheCreationTokens: number;
    estimatedSavingsUsd: number;
  }
  const perCliMap = new Map<CacheStatsCli, CliAgg>();

  let totalRequests = 0;
  let totalHits = 0;
  let totalRead = 0;
  let totalCreation = 0;
  let totalSavings = 0;

  // Rec #3: κ-explicit metrics. A row is "κ-explicit" iff it has
  // `cache_control_blocks > 0` — i.e. the gateway emitted at least one
  // caller-supplied `cache_control` marker. Rows with NULL or 0 are
  // either pre-v4 or non-κ Claude / non-Claude requests.
  let explicitRows = 0;
  let explicitHits = 0;

  // Per-prefix reuse tracking: collect cache_creation_tokens for every
  // row keyed by stable_prefix_hash, ordered ascending by datetime_utc.
  // For each group with >1 row, drop the first (the cache-write call)
  // and average the rest (the cache-read calls).
  const perPrefix = new Map<
    string,
    Array<{ datetime_utc: string; cache_creation_tokens: number }>
  >();

  for (const row of rows) {
    totalRequests += 1;
    const reads = safeNum(row.cache_read_tokens);
    const creation = safeNum(row.cache_creation_tokens);
    totalRead += reads;
    totalCreation += creation;
    if (reads > 0) totalHits += 1;

    const ccBlocks = safeNum(row.cache_control_blocks);
    if (ccBlocks > 0) {
      explicitRows += 1;
      if (reads > 0) explicitHits += 1;
    }

    if (row.stable_prefix_hash) {
      const arr = perPrefix.get(row.stable_prefix_hash) ?? [];
      arr.push({ datetime_utc: row.datetime_utc, cache_creation_tokens: creation });
      perPrefix.set(row.stable_prefix_hash, arr);
    }

    const cli = normalizeCacheStatsCli(row.cli);
    if (cli === null) continue;
    const savings = estimateCacheSavingsUsd(cli, row.model, reads);
    totalSavings += savings;
    const agg = perCliMap.get(cli) ?? {
      requestCount: 0,
      hitCount: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      estimatedSavingsUsd: 0,
    };
    agg.requestCount += 1;
    if (reads > 0) agg.hitCount += 1;
    agg.totalCacheReadTokens += reads;
    agg.totalCacheCreationTokens += creation;
    agg.estimatedSavingsUsd += savings;
    perCliMap.set(cli, agg);
  }

  let stablePrefixReuseCount = 0;
  let creationAfterFirstSum = 0;
  let creationAfterFirstCount = 0;
  for (const arr of perPrefix.values()) {
    if (arr.length <= 1) continue;
    stablePrefixReuseCount += 1;
    arr.sort((a, b) =>
      a.datetime_utc < b.datetime_utc ? -1 : a.datetime_utc > b.datetime_utc ? 1 : 0
    );
    // Every row after the first-by-time in this prefix group (the reuse
    // calls). Iterate the tail directly rather than index-walking `arr`.
    const [, ...afterFirst] = arr;
    for (const entry of afterFirst) {
      creationAfterFirstSum += entry.cache_creation_tokens;
      creationAfterFirstCount += 1;
    }
  }
  const avgCacheCreationAfterFirstCall =
    creationAfterFirstCount > 0 ? creationAfterFirstSum / creationAfterFirstCount : null;

  const perCli = Array.from(perCliMap.entries()).map(([cli, agg]) => ({
    cli,
    requestCount: agg.requestCount,
    hitCount: agg.hitCount,
    hitRate: agg.requestCount > 0 ? agg.hitCount / agg.requestCount : 0,
    totalCacheReadTokens: agg.totalCacheReadTokens,
    totalCacheCreationTokens: agg.totalCacheCreationTokens,
    estimatedSavingsUsd: agg.estimatedSavingsUsd,
  }));

  return {
    windowHours,
    totalRequests,
    totalHits,
    hitRate: totalRequests > 0 ? totalHits / totalRequests : 0,
    totalCacheReadTokens: totalRead,
    totalCacheCreationTokens: totalCreation,
    perCli,
    estimatedSavingsUsd: totalSavings,
    explicitCacheControlRows: explicitRows,
    explicitCacheControlHits: explicitHits,
    explicitCacheControlHitRate: explicitRows > 0 ? explicitHits / explicitRows : 0,
    stablePrefixReuseCount,
    avgCacheCreationAfterFirstCall,
  };
}

//──────────────────────────────────────────────────────────────────────────────
// Read-back of a single persisted request by correlation id.
//
// The flight recorder already persists every request's `response` column on
// logComplete (flight-recorder.ts), regardless of sync vs async. But the only
// MCP read-back surface — llm_job_result — is keyed on an async job id and
// reads the AsyncJobManager, not the recorder. So a *sync* response (which has
// async_job_id = NULL and is handed back inline exactly once) has no retrieval
// path after the fact. This helper closes that gap: given the correlationId
// that every sync/async response echoes in `structuredContent.correlationId`,
// it returns the persisted row from the recorder. Pure read-only — uses the
// same FlightRecorderQuery surface as the cache aggregates above.
//──────────────────────────────────────────────────────────────────────────────

/** Default response truncation budget, matching llm_job_result's maxChars. */
export const PERSISTED_REQUEST_DEFAULT_MAX_CHARS = 200_000;

export interface PersistedRequestRecord {
  correlationId: string;
  cli: string;
  model: string;
  sessionId: string | null;
  datetimeUtc: string;
  durationMs: number | null;
  status: string | null;
  exitCode: number | null;
  errorMessage: string | null;
  retryCount: number | null;
  circuitBreakerState: string | null;
  costUsd: number | null;
  /** NULL for sync requests; the async job UUID for *_request_async rows. */
  asyncJobId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  /** Full character length of the persisted prompt (always reported). */
  promptChars: number;
  /** Full character length of the persisted response (pre-truncation). */
  responseChars: number;
  /** True when `response` was clipped to `maxChars`. */
  responseTruncated: boolean;
  /** Persisted response text, truncated to maxChars. NULL if the row never completed. */
  response: string | null;
  /** Only present when includePrompt = true. */
  prompt?: string;
  /** Parsed thinking blocks (claude), or null. */
  thinkingBlocks: string[] | null;
  /** F3: ownership principal of the request (null for legacy rows). */
  ownerPrincipal: string | null;
}

export interface ReadPersistedRequestOptions {
  /** Truncate the returned response to this many characters. Default 200000. */
  maxChars?: number;
  /** Include the full persisted prompt text in the result. Default false. */
  includePrompt?: boolean;
}

interface PersistedRequestRawRow {
  id: string;
  cli: string;
  model: string;
  prompt: string | null;
  response: string | null;
  session_id: string | null;
  datetime_utc: string;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  retry_count: number | null;
  circuit_breaker_state: string | null;
  cost_usd: number | null;
  exit_code: number | null;
  error_message: string | null;
  async_job_id: string | null;
  status: string | null;
  thinking_blocks: string | null;
  owner_principal: string | null;
}

function parseThinkingBlocks(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((b): b is string => typeof b === "string") : null;
  } catch {
    return null;
  }
}

/**
 * Read a single persisted request by correlation id from the flight recorder.
 * Returns null when no row matches (including a NoopFlightRecorder, which
 * yields no rows — i.e. flight recording disabled). The response is truncated
 * to `maxChars`; the full pre-truncation length is reported via responseChars.
 */
export function readPersistedRequest(
  db: FlightRecorderQuery,
  correlationId: string,
  opts: ReadPersistedRequestOptions = {}
): PersistedRequestRecord | null {
  const maxChars = opts.maxChars ?? PERSISTED_REQUEST_DEFAULT_MAX_CHARS;
  const rows = db.queryRequests<PersistedRequestRawRow>(
    `SELECT r.id, r.cli, r.model, r.prompt, r.response, r.session_id,
            r.datetime_utc, r.duration_ms, r.input_tokens, r.output_tokens,
            r.cache_read_tokens, r.cache_creation_tokens, r.owner_principal,
            m.retry_count, m.circuit_breaker_state, m.cost_usd,
            m.exit_code, m.error_message, m.async_job_id, m.status,
            m.thinking_blocks
     FROM requests r
     LEFT JOIN gateway_metadata m ON m.request_id = r.id
     WHERE r.id = ?
     LIMIT 1`,
    correlationId
  );

  const [row] = rows;
  if (!row) return null;

  const fullResponse = row.response;
  const responseChars = fullResponse ? fullResponse.length : 0;
  const responseTruncated = fullResponse != null && responseChars > maxChars;
  const response = fullResponse == null ? null : fullResponse.slice(0, maxChars);

  const record: PersistedRequestRecord = {
    correlationId: row.id,
    cli: row.cli,
    model: row.model,
    sessionId: row.session_id,
    datetimeUtc: row.datetime_utc,
    durationMs: row.duration_ms,
    status: row.status,
    exitCode: row.exit_code,
    errorMessage: row.error_message,
    retryCount: row.retry_count,
    circuitBreakerState: row.circuit_breaker_state,
    costUsd: row.cost_usd,
    asyncJobId: row.async_job_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    promptChars: row.prompt ? row.prompt.length : 0,
    responseChars,
    responseTruncated,
    response,
    thinkingBlocks: parseThinkingBlocks(row.thinking_blocks),
    ownerPrincipal: row.owner_principal,
  };

  if (opts.includePrompt) {
    record.prompt = row.prompt ?? "";
  }

  return record;
}
