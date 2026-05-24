import { existsSync, readFileSync } from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { z } from "zod";
import type { Logger } from "./logger.js";
import { logWarn, noopLogger } from "./logger.js";

// Zod schemas for configuration validation
const DatabaseUrlSchema = z
  .string()
  .url()
  .refine(url => url.startsWith("postgresql://") || url.startsWith("postgres://"), {
    message: "Database URL must start with postgresql:// or postgres://",
  });
const RedisUrlSchema = z.string().url().startsWith("redis://");

export interface CacheTtl {
  session: number;
  activeSession: number;
  sessionList: number;
}

export interface DatabaseConfig {
  connectionString: string;
  pool: {
    max: number;
    idleTimeoutMillis: number;
    connectionTimeoutMillis: number;
    statementTimeout: number;
  };
}

export interface RedisConfig {
  url: string;
  retryStrategy: {
    maxRetries: number;
    initialDelay: number;
    maxDelay: number;
  };
}

export const DEFAULT_SESSION_TTL_SECONDS = 2592000; // 30 days

export interface Config {
  database?: DatabaseConfig;
  redis?: RedisConfig;
  cacheTtl: CacheTtl;
  sessionTtl: number; // Session expiration in seconds
}

/**
 * Load configuration from environment variables.
 * Always returns a Config object with base fields (cacheTtl, sessionTtl).
 * Database and Redis fields are populated only when both env vars are set.
 */
export function loadConfig(): Config {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;

  // Default cache TTLs
  const cacheTtl: CacheTtl = {
    session: 3600, // 1 hour
    activeSession: 1800, // 30 minutes
    sessionList: 120, // 2 minutes
  };

  const rawSessionTtl = parseInt(
    process.env.SESSION_TTL || String(DEFAULT_SESSION_TTL_SECONDS),
    10
  );
  const sessionTtl =
    Number.isFinite(rawSessionTtl) && rawSessionTtl > 0
      ? rawSessionTtl
      : DEFAULT_SESSION_TTL_SECONDS;

  // If no database config, return base config (file-based storage)
  if (!databaseUrl || !redisUrl) {
    return { cacheTtl, sessionTtl };
  }

  // Validate URLs
  try {
    DatabaseUrlSchema.parse(databaseUrl);
    RedisUrlSchema.parse(redisUrl);
  } catch (error) {
    throw new Error(
      `Invalid database or redis URL: ${error instanceof Error ? error.message : String(error)}`
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
    redis: {
      url: redisUrl,
      retryStrategy: {
        maxRetries: 3,
        initialDelay: 50,
        maxDelay: 2000,
      },
    },
    cacheTtl,
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
//   - "postgres": durable in Postgres (interface only — impl not yet shipped).
//   - "memory":   in-process MemoryJobStore. Process-lifetime durability only.
//                 Requires acknowledgeEphemeral=true to register async tools.
//   - "none":     no store. Async tools are NOT registered.
//──────────────────────────────────────────────────────────────────────────────

export const PERSISTENCE_BACKENDS = ["sqlite", "postgres", "memory", "none"] as const;
export type PersistenceBackend = (typeof PERSISTENCE_BACKENDS)[number];

export const DEFAULT_JOB_RETENTION_DAYS = 30;
export const DEFAULT_DEDUP_WINDOW_MS = 60 * 60 * 1000; // 1 hour

const PersistenceSchema = z
  .object({
    backend: z.enum(PERSISTENCE_BACKENDS).default("sqlite"),
    path: z.string().optional(),
    dsn: z.string().optional(),
    retentionDays: z.number().positive().default(DEFAULT_JOB_RETENTION_DAYS),
    dedupWindowMs: z.number().int().nonnegative().default(DEFAULT_DEDUP_WINDOW_MS),
    acknowledgeEphemeral: z.boolean().default(false),
  })
  .strict();

export interface PersistenceConfig {
  backend: PersistenceBackend;
  path: string | null;
  dsn: string | null;
  retentionDays: number;
  dedupWindowMs: number;
  acknowledgeEphemeral: boolean;
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
    asyncJobsEnabled,
    sources,
  };
}
