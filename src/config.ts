import { existsSync, readFileSync } from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { z } from "zod/v3";
import type { Logger } from "./logger.js";
import { logWarn, noopLogger } from "./logger.js";
import type { RemoteOAuthConfig, OAuthRegistrationPolicy } from "./auth.js";
import { hashSecret, isSecretHash } from "./oauth.js";
import { isHttpsOrLoopbackUrl, isLoopbackUrl } from "./api-http.js";
import type { ApiProviderKind } from "./api-provider.js";
import { CLI_TYPES } from "./provider-types.js";

// Zod schemas for configuration validation
const DatabaseUrlSchema = z
  .string()
  .url()
  .refine(url => url.startsWith("postgresql://") || url.startsWith("postgres://"), {
    message: "Database URL must start with postgresql:// or postgres://",
  });

export interface DatabaseConfig {
  connectionString: string;
  pool: {
    max: number;
    idleTimeoutMillis: number;
    connectionTimeoutMillis: number;
    statementTimeout: number;
  };
}

export const DEFAULT_SESSION_TTL_SECONDS = 2592000; // 30 days

export interface Config {
  database?: DatabaseConfig;
  sessionTtl: number; // Session expiration in seconds
}

/**
 * Load configuration from environment variables.
 * Always returns a Config object with base fields.
 * Database fields are populated when DATABASE_URL is set.
 */
export function loadConfig(): Config {
  const databaseUrl = process.env.DATABASE_URL;

  const rawSessionTtl = parseInt(
    process.env.SESSION_TTL || String(DEFAULT_SESSION_TTL_SECONDS),
    10
  );
  const sessionTtl =
    Number.isFinite(rawSessionTtl) && rawSessionTtl > 0
      ? rawSessionTtl
      : DEFAULT_SESSION_TTL_SECONDS;

  // If no database config, return base config (file-based storage)
  if (!databaseUrl) {
    return { sessionTtl };
  }

  // Validate URL
  try {
    DatabaseUrlSchema.parse(databaseUrl);
  } catch (error) {
    throw new Error(
      `Invalid database URL: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return {
    database: {
      connectionString: databaseUrl,
      pool: {
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
        statementTimeout: 10000,
      },
    },
    sessionTtl,
  };
}

//──────────────────────────────────────────────────────────────────────────────
// Persistence configuration
//
// The async job store is now driven by a typed config (TOML file +
// validated env-var overrides) instead of a single LLM_GATEWAY_LOGS_DB env
// var. The structural invariant: `*_request_async` tools are only registered
// when a real durable store is attached, so silent in-memory loss after the
// 1h TTL becomes impossible.
//
// Backends:
//   - "sqlite":   durable on disk (default).
//   - "postgres": durable in Postgres.
//   - "memory":   in-process MemoryJobStore. Process-lifetime durability only.
//                 Requires acknowledgeEphemeral=true to register async tools.
//   - "none":     no store. Async tools are NOT registered.
//──────────────────────────────────────────────────────────────────────────────

export const PERSISTENCE_BACKENDS = ["sqlite", "postgres", "memory", "none"] as const;
export type PersistenceBackend = (typeof PERSISTENCE_BACKENDS)[number];

export const DEFAULT_JOB_RETENTION_DAYS = 30;
export const DEFAULT_DEDUP_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Issue #139 (durable instance-lease orphan recovery): the lease/heartbeat/sweep
// knobs. Defaults: heartbeat every 15s; a per-job lease TTL of 90s (6x
// heartbeat) so up to five consecutive missed heartbeats never orphan a live
// job; a larger 5-minute grace for no-pid http-transport jobs (their only
// secondary liveness signal); a 30s reaper cadence; and a 1h GC horizon for the
// observability-only gateway_instances rows. Zod enforces
// leaseTtl >= 2*heartbeat and httpJobGrace >= leaseTtl.
export const DEFAULT_INSTANCE_HEARTBEAT_MS = 15000;
export const DEFAULT_INSTANCE_LEASE_TTL_MS = 90000;
export const DEFAULT_HTTP_JOB_GRACE_MS = 300000;
export const DEFAULT_ORPHAN_SWEEP_INTERVAL_MS = 30000;
export const DEFAULT_INSTANCE_GC_MS = 3600000;

const PersistenceSchema = z
  .object({
    backend: z.enum(PERSISTENCE_BACKENDS).default("sqlite"),
    path: z.string().optional(),
    dsn: z.string().optional(),
    retentionDays: z.number().positive().default(DEFAULT_JOB_RETENTION_DAYS),
    dedupWindowMs: z.number().int().nonnegative().default(DEFAULT_DEDUP_WINDOW_MS),
    acknowledgeEphemeral: z.boolean().default(false),
    // Issue #139 (interim gate, DEPRECATED): superseded by the durable per-job
    // lease. Still parsed for one release so existing configs do not error, but
    // it is no longer load-bearing: the lease recovery is safe to run from every
    // instance (heartbeat and sweep serialize on the job row), so no instance
    // needs to be the designated sweep "owner". loadPersistenceConfig emits a
    // one-time deprecation warning when it is set. Will be removed in a later
    // release. See the durable lease knobs below.
    ownsOrphanRecovery: z.boolean().default(false),
    // Issue #139 (durable lease): heartbeat/lease/sweep/GC cadences (ms).
    instanceHeartbeatMs: z.number().int().positive().default(DEFAULT_INSTANCE_HEARTBEAT_MS),
    instanceLeaseTtlMs: z.number().int().positive().default(DEFAULT_INSTANCE_LEASE_TTL_MS),
    httpJobGraceMs: z.number().int().positive().default(DEFAULT_HTTP_JOB_GRACE_MS),
    orphanSweepIntervalMs: z.number().int().positive().default(DEFAULT_ORPHAN_SWEEP_INTERVAL_MS),
    instanceGcMs: z.number().int().positive().default(DEFAULT_INSTANCE_GC_MS),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    // A lease must survive at least one missed heartbeat, so require it to be at
    // least twice the heartbeat cadence; otherwise a single delayed heartbeat
    // could let another instance sweep a live job.
    if (cfg.instanceLeaseTtlMs < 2 * cfg.instanceHeartbeatMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["instanceLeaseTtlMs"],
        message: `instanceLeaseTtlMs (${cfg.instanceLeaseTtlMs}) must be >= 2 * instanceHeartbeatMs (${2 * cfg.instanceHeartbeatMs})`,
      });
    }
    // The http grace is an EXTRA hold on top of the lease for no-pid jobs, so it
    // can never be shorter than the lease itself.
    if (cfg.httpJobGraceMs < cfg.instanceLeaseTtlMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["httpJobGraceMs"],
        message: `httpJobGraceMs (${cfg.httpJobGraceMs}) must be >= instanceLeaseTtlMs (${cfg.instanceLeaseTtlMs})`,
      });
    }
  });

export interface PersistenceConfig {
  backend: PersistenceBackend;
  path: string | null;
  dsn: string | null;
  retentionDays: number;
  dedupWindowMs: number;
  acknowledgeEphemeral: boolean;
  /**
   * Issue #139 (interim gate, DEPRECATED): retained only so old configs still
   * parse. No longer load-bearing (the durable per-job lease recovery runs
   * safely from every instance). loadPersistenceConfig warns once when it is
   * explicitly set. See PersistenceSchema.
   */
  ownsOrphanRecovery: boolean;
  /** Issue #139 (durable lease): heartbeat cadence in ms. */
  instanceHeartbeatMs: number;
  /** Issue #139 (durable lease): per-job fencing lease TTL in ms. */
  instanceLeaseTtlMs: number;
  /** Issue #139 (durable lease): extra grace for no-pid http-transport jobs in ms. */
  httpJobGraceMs: number;
  /** Issue #139 (durable lease): reaper sweep cadence in ms. */
  orphanSweepIntervalMs: number;
  /** Issue #139 (durable lease): gateway_instances GC horizon in ms. */
  instanceGcMs: number;
  /** True iff async-job tools should be registered on the MCP server. */
  asyncJobsEnabled: boolean;
  /** Audit trail: which inputs (file, env vars) contributed to the resolved config. */
  sources: PersistenceConfigSources;
}

export interface PersistenceConfigSources {
  configFile: string | null;
  envOverrides: string[];
}

const DEFAULT_SQLITE_PATH = path.join(os.homedir(), ".llm-cli-gateway", "logs.db");

function defaultPersistenceConfigPath(): string {
  return (
    process.env.LLM_GATEWAY_CONFIG ?? path.join(os.homedir(), ".llm-cli-gateway", "config.toml")
  );
}

export function defaultGatewayConfigPath(): string {
  return defaultPersistenceConfigPath();
}

/**
 * Read and parse the optional TOML config file. Returns the raw `[persistence]`
 * table (if present) and the file path. Missing file is fine — defaults apply.
 */
function readPersistenceFile(
  configPath: string,
  logger: Logger
): { raw: unknown; sourcePath: string | null } {
  if (!existsSync(configPath)) {
    return { raw: undefined, sourcePath: null };
  }
  try {
    const require = createRequire(import.meta.url);
    const TOML = require("smol-toml");
    const text = readFileSync(configPath, "utf-8");
    const parsed = TOML.parse(text) as Record<string, unknown>;
    return { raw: parsed?.persistence, sourcePath: configPath };
  } catch (err) {
    logger.error(`Failed to parse gateway config at ${configPath}; using defaults`, err);
    return { raw: undefined, sourcePath: null };
  }
}

function readGatewayTomlFile(
  configPath: string,
  logger: Logger,
  fallbackLabel: string
): { parsed: Record<string, unknown> | null; sourcePath: string | null } {
  if (!existsSync(configPath)) {
    return { parsed: null, sourcePath: null };
  }
  try {
    const require = createRequire(import.meta.url);
    const TOML = require("smol-toml");
    const text = readFileSync(configPath, "utf-8");
    return { parsed: TOML.parse(text) as Record<string, unknown>, sourcePath: configPath };
  } catch (err) {
    logger.error(
      `Failed to parse gateway config at ${configPath}; using ${fallbackLabel} defaults`,
      err
    );
    return { parsed: null, sourcePath: null };
  }
}

/**
 * Apply legacy env-var overrides on top of the file/defaults. Each application
 * appends a string to `sources.envOverrides` and emits a one-time deprecation
 * warning so operators can migrate to the config file.
 */
function applyEnvOverrides(
  base: Record<string, unknown>,
  logger: Logger,
  sources: PersistenceConfigSources
): Record<string, unknown> {
  const out = { ...base };

  const jobsDbEnv = process.env.LLM_GATEWAY_JOBS_DB;
  const logsDbEnv = process.env.LLM_GATEWAY_LOGS_DB;
  // Empty string is treated as "not set" — only an explicitly non-empty value
  // (or the literal "none") overrides the file/defaults. This avoids the
  // old footgun where `LLM_GATEWAY_LOGS_DB=` silently disabled persistence.
  const dbEnvRaw =
    jobsDbEnv && jobsDbEnv.length > 0
      ? jobsDbEnv
      : logsDbEnv && logsDbEnv.length > 0
        ? logsDbEnv
        : undefined;
  if (dbEnvRaw !== undefined) {
    const normalized = dbEnvRaw.trim().toLowerCase();
    if (normalized === "none") {
      out.backend = "none";
      out.path = undefined;
    } else {
      out.backend = "sqlite";
      out.path = dbEnvRaw.trim();
    }
    const which = jobsDbEnv && jobsDbEnv.length > 0 ? "LLM_GATEWAY_JOBS_DB" : "LLM_GATEWAY_LOGS_DB";
    sources.envOverrides.push(which);
    logWarn(
      logger,
      `${which} is deprecated; migrate to [persistence] in ~/.llm-cli-gateway/config.toml`,
      { backend: out.backend, path: out.path ?? null }
    );
  }

  const retEnv = process.env.LLM_GATEWAY_JOB_RETENTION_DAYS;
  if (retEnv !== undefined) {
    const n = Number(retEnv);
    if (Number.isFinite(n) && n > 0) {
      out.retentionDays = n;
      sources.envOverrides.push("LLM_GATEWAY_JOB_RETENTION_DAYS");
      logWarn(
        logger,
        "LLM_GATEWAY_JOB_RETENTION_DAYS is deprecated; set [persistence].retentionDays in config.toml",
        { retentionDays: n }
      );
    }
  }

  const dedupEnv = process.env.LLM_GATEWAY_DEDUP_WINDOW_MS;
  if (dedupEnv !== undefined) {
    const n = Number(dedupEnv);
    if (Number.isFinite(n) && n >= 0) {
      out.dedupWindowMs = n;
      sources.envOverrides.push("LLM_GATEWAY_DEDUP_WINDOW_MS");
      logWarn(
        logger,
        "LLM_GATEWAY_DEDUP_WINDOW_MS is deprecated; set [persistence].dedupWindowMs in config.toml",
        { dedupWindowMs: n }
      );
    }
  }

  const ackEnv = process.env.LLM_GATEWAY_ACKNOWLEDGE_EPHEMERAL;
  if (ackEnv && ackEnv.length > 0) {
    out.acknowledgeEphemeral = /^(1|true|yes)$/i.test(ackEnv.trim());
    sources.envOverrides.push("LLM_GATEWAY_ACKNOWLEDGE_EPHEMERAL");
    logWarn(
      logger,
      "LLM_GATEWAY_ACKNOWLEDGE_EPHEMERAL is deprecated; set [persistence].acknowledgeEphemeral in config.toml",
      { acknowledgeEphemeral: out.acknowledgeEphemeral }
    );
  }

  return out;
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/**
 * Load and validate the persistence config from (in order, last-write-wins):
 *   1. Built-in defaults (backend=sqlite, default retention/dedup).
 *   2. ~/.llm-cli-gateway/config.toml (or $LLM_GATEWAY_CONFIG).
 *   3. Legacy env vars (with deprecation warning).
 *
 * Throws on incoherent configs (memory/none + asyncJobsEnabled without ack).
 */
export function loadPersistenceConfig(logger: Logger = noopLogger): PersistenceConfig {
  const configPath = defaultPersistenceConfigPath();
  const { raw, sourcePath } = readPersistenceFile(configPath, logger);
  const sources: PersistenceConfigSources = {
    configFile: sourcePath,
    envOverrides: [],
  };

  const merged = applyEnvOverrides(
    (raw as Record<string, unknown> | undefined) ?? {},
    logger,
    sources
  );

  // Issue #139: one-time deprecation warning when the interim gate is set. The
  // durable lease supersedes it; the value is parsed but no longer load-bearing.
  if (merged.ownsOrphanRecovery !== undefined) {
    logWarn(
      logger,
      "[persistence].ownsOrphanRecovery is deprecated and no longer used; the durable per-job lease recovery (#139) runs safely from every instance. Remove it from config.toml."
    );
  }

  let parsed;
  try {
    parsed = PersistenceSchema.parse(merged);
  } catch (err) {
    throw new Error(
      `Invalid [persistence] config: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const backend = parsed.backend;
  const resolvedPath = backend === "sqlite" ? expandHome(parsed.path ?? DEFAULT_SQLITE_PATH) : null;
  const dsn = backend === "postgres" ? (parsed.dsn ?? null) : null;

  if (backend === "postgres" && !dsn) {
    throw new Error(
      "[persistence].backend = 'postgres' requires a non-empty 'dsn' (e.g. postgresql://user:pw@host/db)"
    );
  }

  if (backend === "memory" && !parsed.acknowledgeEphemeral) {
    throw new Error(
      "[persistence].backend = 'memory' is ephemeral — async job results are lost on gateway exit. " +
        "Set [persistence].acknowledgeEphemeral = true (or LLM_GATEWAY_ACKNOWLEDGE_EPHEMERAL=1) to confirm this is intentional."
    );
  }

  const asyncJobsEnabled = backend === "sqlite" || backend === "postgres" || backend === "memory";

  if (backend === "none") {
    logWarn(
      logger,
      "Async job persistence is DISABLED (backend = 'none'). " +
        "*_request_async tools will NOT be registered on this gateway."
    );
  }

  return {
    backend,
    path: resolvedPath,
    dsn,
    retentionDays: parsed.retentionDays,
    dedupWindowMs: parsed.dedupWindowMs,
    acknowledgeEphemeral: parsed.acknowledgeEphemeral,
    ownsOrphanRecovery: parsed.ownsOrphanRecovery,
    instanceHeartbeatMs: parsed.instanceHeartbeatMs,
    instanceLeaseTtlMs: parsed.instanceLeaseTtlMs,
    httpJobGraceMs: parsed.httpJobGraceMs,
    orphanSweepIntervalMs: parsed.orphanSweepIntervalMs,
    instanceGcMs: parsed.instanceGcMs,
    asyncJobsEnabled,
    sources,
  };
}

//──────────────────────────────────────────────────────────────────────────────
// Host-protection limits (issue #130)
//
// Reads the [http] (session lifecycle) and [limits] (async/sync job execution
// backpressure) tables from the same ~/.llm-cli-gateway/config.toml file, using
// a SEPARATE loader/schema so a malformed limits block never breaks persistence
// loading and vice versa. Defaults are conservative but chosen NOT to surprise
// local stdio development: they only bite genuinely pathological session/job
// growth. [http] is read with passthrough() because that table also carries the
// [http.oauth] sub-table owned by loadRemoteOAuthConfig; we own only the three
// session-lifecycle scalar keys here.
//──────────────────────────────────────────────────────────────────────────────

export const DEFAULT_HTTP_MAX_SESSIONS = 100;
export const DEFAULT_HTTP_SESSION_IDLE_TTL_MS = 30 * 60 * 1000; // 30 minutes
export const DEFAULT_HTTP_SESSION_REAPER_INTERVAL_MS = 60 * 1000; // 1 minute

export const DEFAULT_MAX_RUNNING_JOBS = 32;
export const DEFAULT_MAX_RUNNING_JOBS_PER_PROVIDER = 16;
export const DEFAULT_MAX_QUEUED_JOBS = 128;
export const DEFAULT_QUEUE_TIMEOUT_MS = 120000; // 2 minutes
export const DEFAULT_COMPLETED_JOB_MEMORY_TTL_MS = 60 * 60 * 1000; // 1 hour (durable store keeps its own, longer, retention)
export const DEFAULT_MAX_JOB_OUTPUT_BYTES = 50 * 1024 * 1024; // 50MB

// [http] carries the [http.oauth] sub-table (owned by loadRemoteOAuthConfig) plus
// possibly other keys, so tolerate unknown keys via passthrough(). Only the three
// session-lifecycle scalars below are owned/validated here.
const HttpSessionLimitsSchema = z
  .object({
    max_sessions: z.number().int().positive().default(DEFAULT_HTTP_MAX_SESSIONS),
    session_idle_ttl_ms: z.number().int().positive().default(DEFAULT_HTTP_SESSION_IDLE_TTL_MS),
    session_reaper_interval_ms: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_HTTP_SESSION_REAPER_INTERVAL_MS),
  })
  .passthrough();

// [limits] is fully owned here, so it is strict: a typo'd key is a hard error
// rather than a silently-ignored misconfiguration.
const JobLimitsSchema = z
  .object({
    max_running_jobs: z.number().int().positive().default(DEFAULT_MAX_RUNNING_JOBS),
    max_running_jobs_per_provider: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_MAX_RUNNING_JOBS_PER_PROVIDER),
    max_queued_jobs: z.number().int().positive().default(DEFAULT_MAX_QUEUED_JOBS),
    queue_timeout_ms: z.number().int().positive().default(DEFAULT_QUEUE_TIMEOUT_MS),
    completed_job_memory_ttl_ms: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_COMPLETED_JOB_MEMORY_TTL_MS),
    max_job_output_bytes: z.number().int().positive().default(DEFAULT_MAX_JOB_OUTPUT_BYTES),
  })
  .strict();

export interface HttpSessionLimitsConfig {
  maxSessions: number;
  sessionIdleTtlMs: number;
  sessionReaperIntervalMs: number;
}

export interface JobLimitsConfig {
  maxRunningJobs: number;
  maxRunningJobsPerProvider: number;
  maxQueuedJobs: number;
  queueTimeoutMs: number;
  completedJobMemoryTtlMs: number;
  maxJobOutputBytes: number;
}

export interface GatewayLimitsConfig {
  http: HttpSessionLimitsConfig;
  jobs: JobLimitsConfig;
  /** Audit trail: file the config was loaded from (or null if defaults). */
  sources: { configFile: string | null };
}

export const DEFAULT_HTTP_SESSION_LIMITS: HttpSessionLimitsConfig = {
  maxSessions: DEFAULT_HTTP_MAX_SESSIONS,
  sessionIdleTtlMs: DEFAULT_HTTP_SESSION_IDLE_TTL_MS,
  sessionReaperIntervalMs: DEFAULT_HTTP_SESSION_REAPER_INTERVAL_MS,
};

export const DEFAULT_JOB_LIMITS: JobLimitsConfig = {
  maxRunningJobs: DEFAULT_MAX_RUNNING_JOBS,
  maxRunningJobsPerProvider: DEFAULT_MAX_RUNNING_JOBS_PER_PROVIDER,
  maxQueuedJobs: DEFAULT_MAX_QUEUED_JOBS,
  queueTimeoutMs: DEFAULT_QUEUE_TIMEOUT_MS,
  completedJobMemoryTtlMs: DEFAULT_COMPLETED_JOB_MEMORY_TTL_MS,
  maxJobOutputBytes: DEFAULT_MAX_JOB_OUTPUT_BYTES,
};

/**
 * Load [http] session-lifecycle limits and [limits] job-execution backpressure
 * from ~/.llm-cli-gateway/config.toml (override via $LLM_GATEWAY_CONFIG).
 *
 * Defaults apply when the tables/keys are absent. Syntax-invalid TOML keeps the
 * whole-file fallback (defaults). Schema-invalid values (negative/zero/non-int)
 * THROW a clear config error: a bad limit must not silently fall back to an
 * unbounded or surprising value.
 */
export function loadLimitsConfig(logger: Logger = noopLogger): GatewayLimitsConfig {
  const configPath = defaultGatewayConfigPath();
  const { parsed, sourcePath } = readGatewayTomlFile(configPath, logger, "limits");
  const rawHttp = (parsed?.http as Record<string, unknown> | undefined) ?? {};
  const rawLimits = (parsed?.limits as Record<string, unknown> | undefined) ?? {};

  let httpParsed;
  try {
    httpParsed = HttpSessionLimitsSchema.parse(rawHttp);
  } catch (err) {
    throw new Error(
      `Invalid [http] session-limit config: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  let limitsParsed;
  try {
    limitsParsed = JobLimitsSchema.parse(rawLimits);
  } catch (err) {
    throw new Error(`Invalid [limits] config: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    http: {
      maxSessions: httpParsed.max_sessions,
      sessionIdleTtlMs: httpParsed.session_idle_ttl_ms,
      sessionReaperIntervalMs: httpParsed.session_reaper_interval_ms,
    },
    jobs: {
      maxRunningJobs: limitsParsed.max_running_jobs,
      maxRunningJobsPerProvider: limitsParsed.max_running_jobs_per_provider,
      maxQueuedJobs: limitsParsed.max_queued_jobs,
      queueTimeoutMs: limitsParsed.queue_timeout_ms,
      completedJobMemoryTtlMs: limitsParsed.completed_job_memory_ttl_ms,
      maxJobOutputBytes: limitsParsed.max_job_output_bytes,
    },
    sources: { configFile: sourcePath },
  };
}

//──────────────────────────────────────────────────────────────────────────────
// Cache-awareness configuration
//
// Reads the [cache_awareness] block from the same ~/.llm-cli-gateway/config.toml
// file as [persistence], but uses a SEPARATE loader and schema. Keeping the two
// independent means a malformed [cache_awareness] never breaks persistence
// loading and vice versa. No env-var overrides — purely TOML.
//
// All defaults are "off"; behavioural changes (slice 1 cache_control, slice 3
// TTL warnings) ship dormant until operators opt in.
//──────────────────────────────────────────────────────────────────────────────

export const ANTHROPIC_TTL_SECONDS_VALUES = [300, 3600] as const;
export type AnthropicTtlSeconds = (typeof ANTHROPIC_TTL_SECONDS_VALUES)[number];

/**
 * Per-Anthropic-model-family minimum cacheable tokens. Sourced from
 * docs/personal-mcp/PROVIDER_CACHE_SURFACES.md (Anthropic API docs as of
 * 2026-05-26). Models below the threshold cannot be cached even with
 * cache_control set — Anthropic silently returns un-cached.
 */
export const DEFAULT_MIN_STABLE_TOKENS_FOR_CACHE_CONTROL = {
  sonnet: 1024,
  opus: 4096,
  haiku: 4096,
  default: 4096,
} as const;

export type ModelFamilyAlias = keyof typeof DEFAULT_MIN_STABLE_TOKENS_FOR_CACHE_CONTROL;

const MinStableTokensSchema = z
  .object({
    sonnet: z.number().int().positive().default(DEFAULT_MIN_STABLE_TOKENS_FOR_CACHE_CONTROL.sonnet),
    opus: z.number().int().positive().default(DEFAULT_MIN_STABLE_TOKENS_FOR_CACHE_CONTROL.opus),
    haiku: z.number().int().positive().default(DEFAULT_MIN_STABLE_TOKENS_FOR_CACHE_CONTROL.haiku),
    default: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_MIN_STABLE_TOKENS_FOR_CACHE_CONTROL.default),
  })
  .strict()
  .default({
    sonnet: DEFAULT_MIN_STABLE_TOKENS_FOR_CACHE_CONTROL.sonnet,
    opus: DEFAULT_MIN_STABLE_TOKENS_FOR_CACHE_CONTROL.opus,
    haiku: DEFAULT_MIN_STABLE_TOKENS_FOR_CACHE_CONTROL.haiku,
    default: DEFAULT_MIN_STABLE_TOKENS_FOR_CACHE_CONTROL.default,
  });

const CacheAwarenessSchema = z
  .object({
    emit_anthropic_cache_control: z.boolean().default(false),
    anthropic_ttl_seconds: z.union([z.literal(300), z.literal(3600)]).default(300),
    warn_on_ttl_expiry: z.boolean().default(false),
    min_stable_tokens_for_cache_control: MinStableTokensSchema,
  })
  .strict();

export interface CacheAwarenessConfig {
  emitAnthropicCacheControl: boolean;
  anthropicTtlSeconds: AnthropicTtlSeconds;
  warnOnTtlExpiry: boolean;
  minStableTokensForCacheControl: {
    sonnet: number;
    opus: number;
    haiku: number;
    default: number;
  };
  /** Audit trail: file the config was loaded from (or null if defaults). */
  sources: { configFile: string | null };
}

function readCacheAwarenessFile(
  configPath: string,
  logger: Logger
): { raw: unknown; sourcePath: string | null } {
  if (!existsSync(configPath)) {
    return { raw: undefined, sourcePath: null };
  }
  try {
    const require = createRequire(import.meta.url);
    const TOML = require("smol-toml");
    const text = readFileSync(configPath, "utf-8");
    const parsed = TOML.parse(text) as Record<string, unknown>;
    return { raw: parsed?.cache_awareness, sourcePath: configPath };
  } catch (err) {
    logger.error(
      `Failed to parse gateway config at ${configPath}; using cache_awareness defaults`,
      err
    );
    return { raw: undefined, sourcePath: null };
  }
}

/**
 * Load [cache_awareness] from ~/.llm-cli-gateway/config.toml. Defaults: all
 * behaviour off, per-model min-token thresholds from PROVIDER_CACHE_SURFACES.md.
 */
export function loadCacheAwarenessConfig(logger: Logger = noopLogger): CacheAwarenessConfig {
  const configPath = defaultPersistenceConfigPath();
  const { raw, sourcePath } = readCacheAwarenessFile(configPath, logger);

  let parsed;
  try {
    parsed = CacheAwarenessSchema.parse((raw as Record<string, unknown> | undefined) ?? {});
  } catch (err) {
    throw new Error(
      `Invalid [cache_awareness] config: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return {
    emitAnthropicCacheControl: parsed.emit_anthropic_cache_control,
    anthropicTtlSeconds: parsed.anthropic_ttl_seconds as AnthropicTtlSeconds,
    warnOnTtlExpiry: parsed.warn_on_ttl_expiry,
    minStableTokensForCacheControl: {
      sonnet: parsed.min_stable_tokens_for_cache_control.sonnet,
      opus: parsed.min_stable_tokens_for_cache_control.opus,
      haiku: parsed.min_stable_tokens_for_cache_control.haiku,
      default: parsed.min_stable_tokens_for_cache_control.default,
    },
    sources: { configFile: sourcePath },
  };
}

/**
 * Look up the per-model-family threshold. `modelName` is the user-facing model
 * string (e.g. "claude-sonnet-4-6", "claude-opus-4-7"). Falls back to `default`
 * when the family is unrecognised.
 */
export function minStableTokensForModel(config: CacheAwarenessConfig, modelName: string): number {
  const lower = modelName.toLowerCase();
  const table = config.minStableTokensForCacheControl;
  if (lower.includes("sonnet")) return table.sonnet;
  if (lower.includes("opus")) return table.opus;
  if (lower.includes("haiku")) return table.haiku;
  return table.default;
}

//──────────────────────────────────────────────────────────────────────────────
// Outbound API provider configuration
//
// Reads [providers.xai] independently from persistence/cache_awareness. The
// resolved config never contains provider secret material; it carries only the
// environment-variable name to read at request time. Schema-invalid provider
// config disables only that provider and emits a warning. Syntax-invalid TOML
// keeps the existing whole-file fallback behaviour and returns defaults.
//──────────────────────────────────────────────────────────────────────────────

// Spawnable CLI provider names reserved against API-provider name collisions.
const RESERVED_CLI_PROVIDER_NAMES: readonly string[] = CLI_TYPES;

export const DEFAULT_XAI_API_KEY_ENV = "XAI_API_KEY";
export const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
export const DEFAULT_XAI_MODEL = "grok-build-0.1";

const XaiProviderSchema = z
  .object({
    api_key_env: z.string().min(1).default(DEFAULT_XAI_API_KEY_ENV),
    base_url: z
      .string()
      .url()
      .refine(isHttpsOrLoopbackUrl, {
        message: "base_url must use https unless it targets localhost/loopback for tests",
      })
      .default(DEFAULT_XAI_BASE_URL),
    default_model: z.string().min(1).default(DEFAULT_XAI_MODEL),
  })
  .strict();

export interface XaiProviderConfig {
  apiKeyEnv: string;
  baseUrl: string;
  defaultModel: string;
}

// Slice 0: generic `[providers.<name>]` config. `kind` selects the adapter; a
// missing `api_key_env` is allowed only for keyless-local providers (see
// isApiProviderEnabled). Strict so typos surface as a disabled-provider warning
// rather than being silently ignored.
const ApiProviderSchema = z
  .object({
    kind: z.enum(["openai-compatible", "anthropic", "xai-responses"]),
    base_url: z.string().url().refine(isHttpsOrLoopbackUrl, {
      message: "base_url must use https unless it targets localhost/loopback",
    }),
    api_key_env: z.string().min(1).optional(),
    default_model: z.string().min(1),
    models: z.array(z.string().min(1)).nonempty().optional(),
    // Slice 1 (telemetry parity): opt the openai-compatible adapter into the
    // OpenRouter `usage: { include: true }` body flag so token/cost usage is
    // returned in the response. Capability-typed (not name-branched) so strict
    // OpenAI-compatible servers that reject the field stay unaffected by default.
    usage_include: z.boolean().optional(),
  })
  .strict();

export interface ApiProviderConfig {
  name: string;
  kind: ApiProviderKind;
  /** Env var name to read the key from at request time; null = keyless-local. */
  apiKeyEnv: string | null;
  baseUrl: string;
  defaultModel: string;
  /** Optional model allowlist; undefined = no restriction. */
  models?: string[];
  /** Slice 1: emit `usage:{include:true}` (OpenRouter token/cost reporting). */
  usageInclude?: boolean;
}

/** An enabled provider with its API key resolved from the environment. */
export interface ApiProviderRuntime {
  name: string;
  kind: ApiProviderKind;
  /** Env var name to read the key from at request time; null = keyless-local. */
  apiKeyEnv: string | null;
  baseUrl: string;
  defaultModel: string;
  models?: string[];
  /** Slice 1: emit `usage:{include:true}` (OpenRouter token/cost reporting). */
  usageInclude?: boolean;
  /** Resolved key — empty string for a keyless-local provider. */
  apiKey: string;
}

export interface ProvidersConfig {
  /** Back-compat: the xAI provider, also present in `providers["xai"]`. */
  xai: XaiProviderConfig | null;
  /** All configured API providers keyed by config name (incl. xai). */
  providers: Record<string, ApiProviderConfig>;
  sources: { configFile: string | null };
}

function readProvidersFile(
  configPath: string,
  logger: Logger
): { raw: unknown; sourcePath: string | null } {
  if (!existsSync(configPath)) {
    return { raw: undefined, sourcePath: null };
  }
  try {
    const require = createRequire(import.meta.url);
    const TOML = require("smol-toml");
    const text = readFileSync(configPath, "utf-8");
    const parsed = TOML.parse(text) as Record<string, unknown>;
    return { raw: parsed?.providers, sourcePath: configPath };
  } catch (err) {
    logger.error(`Failed to parse gateway config at ${configPath}; using provider defaults`, err);
    return { raw: undefined, sourcePath: null };
  }
}

export function loadProvidersConfig(logger: Logger = noopLogger): ProvidersConfig {
  const configPath = defaultGatewayConfigPath();
  const { raw, sourcePath } = readProvidersFile(configPath, logger);
  const rawProviders = (raw as Record<string, unknown> | undefined) ?? {};
  const providers: Record<string, ApiProviderConfig> = {};

  // xAI keeps its dedicated schema (defaults + no required `kind`) so existing
  // `[providers.xai]` configs continue to load unchanged.
  let xai: XaiProviderConfig | null = null;
  const rawXai = rawProviders.xai;
  if (rawXai !== undefined) {
    const parsed = XaiProviderSchema.safeParse(rawXai);
    if (parsed.success) {
      xai = {
        apiKeyEnv: parsed.data.api_key_env,
        baseUrl: parsed.data.base_url,
        defaultModel: parsed.data.default_model,
      };
      providers.xai = {
        name: "xai",
        kind: "xai-responses",
        apiKeyEnv: parsed.data.api_key_env,
        baseUrl: parsed.data.base_url,
        defaultModel: parsed.data.default_model,
      };
    } else {
      logWarn(logger, "Invalid [providers.xai] config; xAI API provider disabled", {
        error: parsed.error.message,
      });
    }
  }

  // Every other `[providers.<name>]` entry parses with the generic schema.
  // Failure isolation: a malformed single provider disables only itself (warn),
  // never the whole map, never persistence.
  for (const [name, rawProvider] of Object.entries(rawProviders)) {
    if (name === "xai") continue;
    // An API provider MUST NOT be named after a spawnable CLI. Otherwise it would
    // shadow that CLI on the validation reviewer path (matched by name) and
    // confuse metrics/catalogs. Reject the collision with a warning rather than
    // silently letting an HTTP endpoint impersonate `claude`/`codex`/etc.
    if (RESERVED_CLI_PROVIDER_NAMES.includes(name)) {
      logWarn(
        logger,
        `[providers.${name}] is rejected: "${name}" is a reserved CLI provider name and cannot be used for an API provider`
      );
      continue;
    }
    const parsed = ApiProviderSchema.safeParse(rawProvider);
    if (!parsed.success) {
      logWarn(logger, `Invalid [providers.${name}] config; API provider disabled`, {
        error: parsed.error.message,
      });
      continue;
    }
    providers[name] = {
      name,
      kind: parsed.data.kind,
      apiKeyEnv: parsed.data.api_key_env ?? null,
      baseUrl: parsed.data.base_url,
      defaultModel: parsed.data.default_model,
      models: parsed.data.models ? [...parsed.data.models] : undefined,
      usageInclude: parsed.data.usage_include,
    };
  }

  return { xai, providers, sources: { configFile: sourcePath } };
}

/**
 * Resolve a provider's API key from the environment, or `null` when it is not
 * set. Empty/whitespace-only values count as unset.
 */
function resolveProviderKey(apiKeyEnv: string | null, env: NodeJS.ProcessEnv): string | null {
  if (!apiKeyEnv) return null;
  const value = env[apiKeyEnv];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * A provider is enabled when its key is present, OR — the keyless-local
 * exception — it is an `openai-compatible` provider on a loopback `base_url`
 * (Ollama/llama.cpp need no key). Everything else with an empty key is disabled.
 */
export function isApiProviderEnabled(
  provider: ApiProviderConfig,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (resolveProviderKey(provider.apiKeyEnv, env) !== null) return true;
  return provider.kind === "openai-compatible" && isLoopbackUrl(provider.baseUrl);
}

/**
 * Slice 6: whether a provider's API key is resolvable from the environment,
 * reported by doctor / provider-status / login-guidance without exposing the
 * value. A keyless-local provider (apiKeyEnv null) reports `false` here even
 * though it is still enabled (see the loopback exception in
 * `isApiProviderEnabled`).
 */
export function apiProviderKeyPresent(
  provider: ApiProviderConfig,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return resolveProviderKey(provider.apiKeyEnv, env) !== null;
}

/** The enabled API providers with keys resolved (empty string for keyless). */
export function enabledApiProviders(
  config: ProvidersConfig,
  env: NodeJS.ProcessEnv = process.env
): ApiProviderRuntime[] {
  const runtimes: ApiProviderRuntime[] = [];
  // Defensive: tolerate a ProvidersConfig built before the `providers` map
  // existed (older callers / test mocks pass only { xai, sources }).
  for (const provider of Object.values(config.providers ?? {})) {
    if (!isApiProviderEnabled(provider, env)) continue;
    runtimes.push({
      name: provider.name,
      kind: provider.kind,
      apiKeyEnv: provider.apiKeyEnv,
      baseUrl: provider.baseUrl,
      defaultModel: provider.defaultModel,
      models: provider.models,
      usageInclude: provider.usageInclude,
      apiKey: resolveProviderKey(provider.apiKeyEnv, env) ?? "",
    });
  }
  return runtimes;
}

export function isXaiProviderEnabled(
  config: ProvidersConfig,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const keyEnv = config.xai?.apiKeyEnv;
  if (!keyEnv) return false;
  return typeof env[keyEnv] === "string" && env[keyEnv]!.trim().length > 0;
}

//──────────────────────────────────────────────────────────────────────────────
// ACP (Agent Client Protocol) transport configuration
//
// Reads the [acp] block (and [acp.providers.<name>] sub-tables) from the same
// ~/.llm-cli-gateway/config.toml file as [persistence]/[cache_awareness], but
// uses a SEPARATE loader and schema so a malformed [acp] block never breaks
// other config loaders. All behaviour ships dormant: enabled=false, every
// provider runtime gate off, write/terminal host services off, and
// default_transport stays "cli" so existing CLI request paths are unchanged.
//
// SECURITY: provider entrypoints are stored as an executable plus an argv array
// only. Shell-style command strings (anything that requires shell parsing —
// spaces, pipes, redirects, command substitution, globbing, etc.) are rejected
// at validation time so the gateway can spawn without a shell. No secret
// material is ever stored here.
//──────────────────────────────────────────────────────────────────────────────

export const ACP_TRANSPORTS = ["cli", "acp"] as const;
export type AcpTransport = (typeof ACP_TRANSPORTS)[number];

export const DEFAULT_ACP_PROCESS_IDLE_TIMEOUT_MS = 600000; // 10 minutes
export const DEFAULT_ACP_INITIALIZE_TIMEOUT_MS = 10000;
export const DEFAULT_ACP_SESSION_NEW_TIMEOUT_MS = 10000;
export const DEFAULT_ACP_PROMPT_TIMEOUT_MS = 600000; // 10 minutes

/**
 * Characters that imply a string must be interpreted by a shell rather than
 * spawned directly as an executable. Their presence in a `command` is a hard
 * validation error — entrypoints are never passed through a shell.
 */
// eslint-disable-next-line no-control-regex
const SHELL_METACHARACTERS = /[\s|&;<>(){}$`"'\\*?[\]~#!\0]/;

function isSafeExecutable(value: string): boolean {
  if (value.length === 0) return false;
  return !SHELL_METACHARACTERS.test(value);
}

const SafeExecutableSchema = z
  .string()
  .min(1)
  .refine(isSafeExecutable, {
    message:
      "ACP provider command must be a bare executable name or path with no shell metacharacters " +
      "(no spaces, quotes, pipes, redirects, globs, or command substitution); pass arguments via 'args'",
  });

const SafeArgSchema = z.string();

const AcpProviderSchema = z
  .object({
    enabled: z.boolean().default(false),
    command: SafeExecutableSchema,
    args: z.array(SafeArgSchema).default([]),
    runtime_enabled: z.boolean().default(false),
    isolated_leader_socket: z.boolean().default(false),
  })
  .strict();

const AcpConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    default_transport: z.enum(ACP_TRANSPORTS).default("cli"),
    smoke_on_startup: z.boolean().default(false),
    process_idle_timeout_ms: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_ACP_PROCESS_IDLE_TIMEOUT_MS),
    initialize_timeout_ms: z.number().int().positive().default(DEFAULT_ACP_INITIALIZE_TIMEOUT_MS),
    session_new_timeout_ms: z.number().int().positive().default(DEFAULT_ACP_SESSION_NEW_TIMEOUT_MS),
    prompt_timeout_ms: z.number().int().positive().default(DEFAULT_ACP_PROMPT_TIMEOUT_MS),
    allow_write_host_services: z.boolean().default(false),
    allow_terminal_host_services: z.boolean().default(false),
    allow_mutating_session_ops: z.boolean().default(false),
    fallback_to_cli_when_unhealthy: z.boolean().default(true),
    providers: z.record(z.string(), AcpProviderSchema).default({}),
  })
  .strict();

export interface AcpProviderConfig {
  enabled: boolean;
  command: string;
  args: string[];
  runtimeEnabled: boolean;
  isolatedLeaderSocket: boolean;
}

export interface AcpConfig {
  enabled: boolean;
  defaultTransport: AcpTransport;
  smokeOnStartup: boolean;
  processIdleTimeoutMs: number;
  initializeTimeoutMs: number;
  sessionNewTimeoutMs: number;
  promptTimeoutMs: number;
  allowWriteHostServices: boolean;
  allowTerminalHostServices: boolean;
  /**
   * Whether state-mutating ACP admin ops (`session/delete`, `session/set_mode`,
   * `session/set_config_option`) may be invoked. Deny-by-default.
   */
  allowMutatingSessionOps: boolean;
  fallbackToCliWhenUnhealthy: boolean;
  providers: Record<string, AcpProviderConfig>;
  /** Audit trail: file the config was loaded from (or null if defaults). */
  sources: { configFile: string | null };
}

function defaultAcpConfig(sourcePath: string | null): AcpConfig {
  return {
    enabled: false,
    defaultTransport: "cli",
    smokeOnStartup: false,
    processIdleTimeoutMs: DEFAULT_ACP_PROCESS_IDLE_TIMEOUT_MS,
    initializeTimeoutMs: DEFAULT_ACP_INITIALIZE_TIMEOUT_MS,
    sessionNewTimeoutMs: DEFAULT_ACP_SESSION_NEW_TIMEOUT_MS,
    promptTimeoutMs: DEFAULT_ACP_PROMPT_TIMEOUT_MS,
    allowWriteHostServices: false,
    allowTerminalHostServices: false,
    allowMutatingSessionOps: false,
    fallbackToCliWhenUnhealthy: true,
    providers: {},
    sources: { configFile: sourcePath },
  };
}

function readAcpFile(
  configPath: string,
  logger: Logger
): { raw: unknown; sourcePath: string | null } {
  if (!existsSync(configPath)) {
    return { raw: undefined, sourcePath: null };
  }
  try {
    const require = createRequire(import.meta.url);
    const TOML = require("smol-toml");
    const text = readFileSync(configPath, "utf-8");
    const parsed = TOML.parse(text) as Record<string, unknown>;
    return { raw: parsed?.acp, sourcePath: configPath };
  } catch (err) {
    logger.error(`Failed to parse gateway config at ${configPath}; using acp defaults`, err);
    return { raw: undefined, sourcePath: null };
  }
}

/**
 * Load [acp] from ~/.llm-cli-gateway/config.toml (override via $LLM_GATEWAY_CONFIG).
 *
 * Defaults are fully dormant: ACP disabled, default_transport "cli", every
 * provider runtime gate off, write/terminal host services off. Syntax-invalid
 * TOML keeps the whole-file fallback (defaults). Schema-invalid [acp] config
 * THROWS — a malformed ACP block (e.g. a shell-style command, invalid transport,
 * or non-positive timeout) is a hard error so misconfiguration cannot silently
 * spawn the wrong process or run with the wrong gate.
 */
export function loadAcpConfig(logger: Logger = noopLogger): AcpConfig {
  const configPath = defaultGatewayConfigPath();
  const { raw, sourcePath } = readAcpFile(configPath, logger);

  if (raw === undefined) {
    return defaultAcpConfig(sourcePath);
  }

  let parsed;
  try {
    parsed = AcpConfigSchema.parse(raw);
  } catch (err) {
    throw new Error(`Invalid [acp] config: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }

  const providers: Record<string, AcpProviderConfig> = {};
  for (const [name, p] of Object.entries(parsed.providers)) {
    providers[name] = {
      enabled: p.enabled,
      command: p.command,
      args: p.args,
      runtimeEnabled: p.runtime_enabled,
      isolatedLeaderSocket: p.isolated_leader_socket,
    };
  }

  return {
    enabled: parsed.enabled,
    defaultTransport: parsed.default_transport,
    smokeOnStartup: parsed.smoke_on_startup,
    processIdleTimeoutMs: parsed.process_idle_timeout_ms,
    initializeTimeoutMs: parsed.initialize_timeout_ms,
    sessionNewTimeoutMs: parsed.session_new_timeout_ms,
    promptTimeoutMs: parsed.prompt_timeout_ms,
    allowWriteHostServices: parsed.allow_write_host_services,
    allowTerminalHostServices: parsed.allow_terminal_host_services,
    allowMutatingSessionOps: parsed.allow_mutating_session_ops,
    fallbackToCliWhenUnhealthy: parsed.fallback_to_cli_when_unhealthy,
    providers,
    sources: { configFile: sourcePath },
  };
}

//──────────────────────────────────────────────────────────────────────────────
// CLI admin operations configuration ([admin])
//
// Gates the phase-6 provider-admin MUTATING surface (mcp add/remove, login/
// logout, plugin install/remove, session delete/archive, ...). Deny-by-default,
// parallel to acp.allow_mutating_session_ops: when false, a mutating admin tool
// call fails closed WITHOUT spawning; when true it routes through the approval
// manager and is audited. Read-only admin ops are unaffected by this gate.
//──────────────────────────────────────────────────────────────────────────────

const AdminConfigSchema = z
  .object({
    allow_mutating_cli_admin_ops: z.boolean().default(false),
  })
  .strict();

export interface AdminConfig {
  /** Whether mutating provider CLI admin ops may run. Deny-by-default. */
  allowMutatingCliAdminOps: boolean;
  /** Audit trail: file the config was loaded from (or null if defaults). */
  sources: { configFile: string | null };
}

function defaultAdminConfig(sourcePath: string | null): AdminConfig {
  return { allowMutatingCliAdminOps: false, sources: { configFile: sourcePath } };
}

function readAdminFile(
  configPath: string,
  logger: Logger
): { raw: unknown; sourcePath: string | null } {
  if (!existsSync(configPath)) {
    return { raw: undefined, sourcePath: null };
  }
  try {
    const require = createRequire(import.meta.url);
    const TOML = require("smol-toml");
    const text = readFileSync(configPath, "utf-8");
    const parsed = TOML.parse(text) as Record<string, unknown>;
    return { raw: parsed?.admin, sourcePath: configPath };
  } catch (err) {
    logger.error(`Failed to parse gateway config at ${configPath}; using admin defaults`, err);
    return { raw: undefined, sourcePath: null };
  }
}

/**
 * Load [admin] from ~/.llm-cli-gateway/config.toml (override via $LLM_GATEWAY_CONFIG).
 *
 * Defaults are fully locked down (mutating CLI admin ops OFF). A syntax-invalid
 * TOML keeps the whole-file fallback (defaults). A schema-invalid [admin] block
 * THROWS so a misconfiguration cannot silently flip the mutating gate on.
 */
export function loadAdminConfig(logger: Logger = noopLogger): AdminConfig {
  const configPath = defaultGatewayConfigPath();
  const { raw, sourcePath } = readAdminFile(configPath, logger);
  if (raw === undefined) {
    return defaultAdminConfig(sourcePath);
  }
  let parsed;
  try {
    parsed = AdminConfigSchema.parse(raw);
  } catch (err) {
    throw new Error(`Invalid [admin] config: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  return {
    allowMutatingCliAdminOps: parsed.allow_mutating_cli_admin_ops,
    sources: { configFile: sourcePath },
  };
}

//──────────────────────────────────────────────────────────────────────────────
// Remote connector OAuth configuration
//──────────────────────────────────────────────────────────────────────────────

const OAuthRegistrationPolicySchema = z.enum(["static_clients", "shared_secret", "open_dev"]);

const OAuthClientSchema = z
  .object({
    client_id: z.string().min(1),
    client_secret_hash: z.string().optional(),
    allowed_redirect_uris: z.array(z.string().url()).default([]),
    scopes: z.array(z.string().min(1)).default(["mcp"]),
  })
  .strict();

const OAuthSharedSecretSchema = z
  .object({
    enabled: z.boolean().default(false),
    secret_hash: z.string().optional(),
    prompt_label: z.string().min(1).default("Gateway access code"),
  })
  .strict();

const OAuthConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    issuer: z.string().min(1).default("auto"),
    require_pkce: z.boolean().default(true),
    allow_plain_pkce: z.boolean().default(false),
    registration_policy: OAuthRegistrationPolicySchema.default("static_clients"),
    allow_public_clients: z.boolean().default(false),
    token_ttl_seconds: z.number().int().positive().default(3600),
    // F14b: opt-in human-consent gate before /oauth/authorize issues a code.
    require_consent: z.boolean().default(false),
    consent_secret_hash: z.string().optional(),
    clients: z.array(OAuthClientSchema).default([]),
    shared_secret: OAuthSharedSecretSchema.optional(),
  })
  .strict();

function disabledOAuthConfig(
  sourcePath: string | null = null,
  envOverrides: string[] = []
): RemoteOAuthConfig {
  return {
    enabled: false,
    issuer: "auto",
    requirePkce: true,
    allowPlainPkce: false,
    registrationPolicy: "static_clients",
    allowPublicClients: false,
    tokenTtlSeconds: 3600,
    requireConsent: false,
    consentSecretHash: null,
    clients: [],
    sharedSecret: null,
    sources: { configFile: sourcePath, envOverrides },
  };
}

function isSafeRedirectUri(uri: string): boolean {
  return isHttpsOrLoopbackUrl(uri);
}

/**
 * Coarse status of the remote OAuth config, used by the doctor readiness
 * projection to distinguish "operator has not enabled OAuth" from "operator
 * enabled OAuth but the config is unsafe/malformed". `loadRemoteOAuthConfig`
 * wraps this and returns only the resolved config for back-compat.
 *
 *   - "absent":    no [http.oauth] table and no OAuth env overrides.
 *   - "disabled":  OAuth config is present but enabled = false.
 *   - "enabled":   OAuth config is present, enabled, and passed validation.
 *   - "malformed": OAuth is enabled but failed schema/semantic validation
 *                  (remote OAuth is therefore disabled at runtime, fail-closed).
 */
export type RemoteOAuthConfigStatus = "absent" | "disabled" | "enabled" | "malformed";

export interface RemoteOAuthConfigDiagnostics {
  config: RemoteOAuthConfig;
  status: RemoteOAuthConfigStatus;
  /** True when an [http.oauth] table or OAuth env override is present at all. */
  configured: boolean;
  /**
   * Concise, secret-free descriptions of why an enabled config is malformed.
   * Empty for "absent"/"disabled"/"enabled". Never contains secret material.
   */
  issues: string[];
}

/**
 * Apply the OAuth env-var compatibility overrides on top of the raw TOML block.
 * Returns the merged object plus the list of override names applied.
 */
function mergeOAuthEnvOverrides(
  rawOAuth: Record<string, unknown>,
  env: NodeJS.ProcessEnv
): { merged: Record<string, unknown>; envOverrides: string[] } {
  const envOverrides: string[] = [];
  const merged: Record<string, unknown> = { ...rawOAuth };

  if (env.LLM_GATEWAY_OAUTH_ENABLED !== undefined) {
    merged.enabled = env.LLM_GATEWAY_OAUTH_ENABLED === "1";
    envOverrides.push("LLM_GATEWAY_OAUTH_ENABLED");
  }
  if (env.LLM_GATEWAY_OAUTH_REGISTRATION_SECRET || env.LLM_GATEWAY_OAUTH_SHARED_SECRET) {
    const rawSecret =
      env.LLM_GATEWAY_OAUTH_REGISTRATION_SECRET || env.LLM_GATEWAY_OAUTH_SHARED_SECRET;
    merged.registration_policy = "shared_secret";
    merged.shared_secret = {
      enabled: true,
      // Env-only compatibility path: plaintext is converted to a hash in memory
      // and never written back to config.
      secret_hash: rawSecret ? hashSecret(rawSecret) : undefined,
      prompt_label: "Gateway access code",
    };
    envOverrides.push(
      env.LLM_GATEWAY_OAUTH_REGISTRATION_SECRET
        ? "LLM_GATEWAY_OAUTH_REGISTRATION_SECRET"
        : "LLM_GATEWAY_OAUTH_SHARED_SECRET"
    );
  }
  if (env.LLM_GATEWAY_OAUTH_REQUIRE_CONSENT !== undefined) {
    merged.require_consent = env.LLM_GATEWAY_OAUTH_REQUIRE_CONSENT === "1";
    envOverrides.push("LLM_GATEWAY_OAUTH_REQUIRE_CONSENT");
  }
  if (env.LLM_GATEWAY_OAUTH_CONSENT_SECRET) {
    // Env-only compatibility path: plaintext hashed in memory, never persisted.
    merged.consent_secret_hash = hashSecret(env.LLM_GATEWAY_OAUTH_CONSENT_SECRET);
    merged.require_consent = merged.require_consent ?? true;
    envOverrides.push("LLM_GATEWAY_OAUTH_CONSENT_SECRET");
  }
  return { merged, envOverrides };
}

/**
 * Run the semantic (post-schema) validations on a parsed OAuth config. Pushes a
 * secret-free issue string for each failure. Returns the resolved config on
 * success, or null when any semantic check failed (fail-closed: caller returns
 * the disabled config so remote OAuth stays off at runtime).
 */
function validateParsedOAuthConfig(
  data: z.infer<typeof OAuthConfigSchema>,
  env: NodeJS.ProcessEnv,
  sourcePath: string | null,
  envOverrides: string[],
  logger: Logger,
  issues: string[]
): RemoteOAuthConfig | null {
  if (data.issuer !== "auto" && !isHttpsOrLoopbackUrl(data.issuer)) {
    logWarn(logger, "Invalid [http.oauth].issuer; remote OAuth disabled");
    issues.push("OAuth issuer must be an https:// URL (or a loopback URL for local testing).");
    return null;
  }
  for (const client of data.clients) {
    if (!data.allow_public_clients && !client.client_secret_hash) {
      logWarn(logger, "OAuth client secret hash is required when public clients are disabled", {
        client_id: client.client_id,
      });
      issues.push(
        "An OAuth client is missing a client_secret_hash (required when public clients are disabled). Recreate it with `llm-cli-gateway oauth client add`."
      );
      return null;
    }
    if (client.client_secret_hash && !isSecretHash(client.client_secret_hash)) {
      logWarn(logger, "Invalid OAuth client secret hash; remote OAuth disabled", {
        client_id: client.client_id,
      });
      issues.push(
        "An OAuth client secret hash is not a valid scrypt hash. Rotate it with `llm-cli-gateway oauth client rotate`."
      );
      return null;
    }
    if (
      client.allowed_redirect_uris.length === 0 ||
      client.allowed_redirect_uris.some(uri => !isSafeRedirectUri(uri))
    ) {
      logWarn(logger, "Invalid OAuth client redirect URI; remote OAuth disabled", {
        client_id: client.client_id,
      });
      issues.push(
        "An OAuth client has a missing or non-https/loopback redirect URI. Re-add the client with a valid --redirect-uri."
      );
      return null;
    }
  }
  if (data.shared_secret?.enabled) {
    if (!data.shared_secret.secret_hash || !isSecretHash(data.shared_secret.secret_hash)) {
      logWarn(logger, "Invalid [http.oauth.shared_secret] secret_hash; remote OAuth disabled");
      issues.push(
        "The OAuth shared-secret hash is missing or invalid. Reset it with `llm-cli-gateway oauth shared-secret set`."
      );
      return null;
    }
  }
  if (data.registration_policy === "open_dev" && env.LLM_GATEWAY_OAUTH_OPEN_DEV !== "1") {
    logWarn(
      logger,
      "[http.oauth].registration_policy='open_dev' is intended for localhost/dev only"
    );
  }
  // F14b: the consent gate cannot fail closed without a credential to verify.
  if (data.require_consent) {
    if (!data.consent_secret_hash || !isSecretHash(data.consent_secret_hash)) {
      logWarn(
        logger,
        "[http.oauth].require_consent is set but consent_secret_hash is missing/invalid; remote OAuth disabled"
      );
      issues.push(
        "require_consent is set but the consent secret hash is missing or invalid. Set it with `llm-cli-gateway oauth shared-secret set` or LLM_GATEWAY_OAUTH_CONSENT_SECRET."
      );
      return null;
    }
  }

  return {
    enabled: data.enabled,
    issuer: data.issuer,
    requirePkce: data.require_pkce,
    allowPlainPkce: data.allow_plain_pkce,
    registrationPolicy: data.registration_policy as OAuthRegistrationPolicy,
    allowPublicClients: data.allow_public_clients,
    tokenTtlSeconds: data.token_ttl_seconds,
    requireConsent: data.require_consent,
    consentSecretHash: data.consent_secret_hash ?? null,
    clients: data.clients.map(client => ({
      clientId: client.client_id,
      clientSecretHash: client.client_secret_hash ?? null,
      allowedRedirectUris: client.allowed_redirect_uris,
      scopes: client.scopes,
    })),
    sharedSecret: data.shared_secret
      ? {
          enabled: data.shared_secret.enabled,
          secretHash: data.shared_secret.secret_hash ?? null,
          promptLabel: data.shared_secret.prompt_label,
        }
      : null,
    sources: { configFile: sourcePath, envOverrides },
  };
}

/**
 * Load and classify the remote OAuth config. Unlike `loadRemoteOAuthConfig`,
 * this reports WHY OAuth is off so the readiness projection can distinguish a
 * deliberately-disabled server from a misconfigured one. Never throws and never
 * emits secret material.
 */
export function diagnoseRemoteOAuthConfig(
  logger: Logger = noopLogger,
  env: NodeJS.ProcessEnv = process.env
): RemoteOAuthConfigDiagnostics {
  const configPath = defaultGatewayConfigPath();
  const { parsed: configFile, sourcePath } = readGatewayTomlFile(configPath, logger, "OAuth");
  const rawHttp = (configFile?.http as Record<string, unknown> | undefined) ?? {};
  const rawOAuth = (rawHttp.oauth as Record<string, unknown> | undefined) ?? {};
  const { merged, envOverrides } = mergeOAuthEnvOverrides(rawOAuth, env);
  const configured = Object.keys(rawOAuth).length > 0 || envOverrides.length > 0;

  const parsed = OAuthConfigSchema.safeParse(merged);
  if (!parsed.success) {
    logWarn(logger, "Invalid [http.oauth] config; remote OAuth disabled", {
      error: parsed.error.message,
    });
    // A parse failure can only happen when an [http.oauth] table (or override)
    // exists, since an empty object parses to the all-default disabled config.
    return {
      config: disabledOAuthConfig(sourcePath, envOverrides),
      status: "malformed",
      configured: true,
      issues: [
        "The [http.oauth] config is invalid (schema validation failed); remote OAuth is disabled.",
      ],
    };
  }

  const data = parsed.data;
  const issues: string[] = [];
  const built = validateParsedOAuthConfig(data, env, sourcePath, envOverrides, logger, issues);
  if (!built) {
    // Semantic validation failed. Only surface it as "malformed" when the
    // operator actually asked for OAuth (enabled); an enabled=false block with
    // stale/invalid material is just "disabled".
    return {
      config: disabledOAuthConfig(sourcePath, envOverrides),
      status: data.enabled ? "malformed" : configured ? "disabled" : "absent",
      configured,
      issues: data.enabled ? issues : [],
    };
  }

  const status: RemoteOAuthConfigStatus = built.enabled
    ? "enabled"
    : configured
      ? "disabled"
      : "absent";
  return { config: built, status, configured, issues: [] };
}

export function loadRemoteOAuthConfig(
  logger: Logger = noopLogger,
  env: NodeJS.ProcessEnv = process.env
): RemoteOAuthConfig {
  return diagnoseRemoteOAuthConfig(logger, env).config;
}
