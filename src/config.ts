import { existsSync, readFileSync } from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { z } from "zod/v3";
import type { Logger } from "./logger.js";
import { logWarn, noopLogger } from "./logger.js";

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

export const DEFAULT_XAI_API_KEY_ENV = "XAI_API_KEY";
export const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
export const DEFAULT_XAI_MODEL = "grok-build-0.1";

function isHttpsOrLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

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

export interface ProvidersConfig {
  xai: XaiProviderConfig | null;
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
  const providers = (raw as Record<string, unknown> | undefined) ?? {};
  const rawXai = providers.xai;

  if (rawXai === undefined) {
    return {
      xai: null,
      sources: { configFile: sourcePath },
    };
  }

  const parsed = XaiProviderSchema.safeParse(rawXai);
  if (!parsed.success) {
    logWarn(logger, "Invalid [providers.xai] config; xAI API provider disabled", {
      error: parsed.error.message,
    });
    return {
      xai: null,
      sources: { configFile: sourcePath },
    };
  }

  return {
    xai: {
      apiKeyEnv: parsed.data.api_key_env,
      baseUrl: parsed.data.base_url,
      defaultModel: parsed.data.default_model,
    },
    sources: { configFile: sourcePath },
  };
}

export function isXaiProviderEnabled(
  config: ProvidersConfig,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const keyEnv = config.xai?.apiKeyEnv;
  if (!keyEnv) return false;
  return typeof env[keyEnv] === "string" && env[keyEnv]!.trim().length > 0;
}
