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
}

interface RawRow {
  cli: string;
  model: string;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  stable_prefix_hash: string | null;
  datetime_utc: string;
}

function safeNum(n: number | null | undefined): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

function isCacheStatsCli(s: string): s is CacheStatsCli {
  return s === "claude" || s === "codex" || s === "gemini" || s === "grok" || s === "mistral";
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
            datetime_utc
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
    if (cli === null && isCacheStatsCli(row.cli)) cli = row.cli;
    if (isCacheStatsCli(row.cli)) {
      estimatedSavingsUsd += estimateCacheSavingsUsd(row.cli, row.model, reads);
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
  };
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
    if (isCacheStatsCli(row.cli)) {
      estimatedSavingsUsd += estimateCacheSavingsUsd(row.cli, row.model, reads);
      const key = `${row.cli}::${row.model}`;
      const entry = cliMap.get(key);
      if (entry) {
        entry.count += 1;
      } else {
        cliMap.set(key, { cli: row.cli, model: row.model, count: 1 });
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
              datetime_utc
       FROM requests
       WHERE datetime_utc >= ?`
    : `SELECT cli, model,
              COALESCE(cache_read_tokens, 0) AS cache_read_tokens,
              COALESCE(cache_creation_tokens, 0) AS cache_creation_tokens,
              stable_prefix_hash,
              datetime_utc
       FROM requests`;
  const rows = sinceIso
    ? db.queryRequests<RawRow>(sql, sinceIso)
    : db.queryRequests<RawRow>(sql);

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

  for (const row of rows) {
    totalRequests += 1;
    const reads = safeNum(row.cache_read_tokens);
    const creation = safeNum(row.cache_creation_tokens);
    totalRead += reads;
    totalCreation += creation;
    if (reads > 0) totalHits += 1;
    if (!isCacheStatsCli(row.cli)) continue;
    const cli = row.cli;
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
  };
}
