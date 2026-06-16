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

// Spawnable CLI provider names reserved against API-provider name collisions.
// Mirrors session-manager.CLI_TYPES (inlined to avoid an import cycle).
const RESERVED_CLI_PROVIDER_NAMES: readonly string[] = [
  "claude",
  "codex",
  "gemini",
  "grok",
  "mistral",
  "devin",
];

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
}

/** An enabled provider with its API key resolved from the environment. */
export interface ApiProviderRuntime {
  name: string;
  kind: ApiProviderKind;
  baseUrl: string;
  defaultModel: string;
  models?: string[];
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
    // (Inlined rather than importing CLI_TYPES from session-manager, which
    // imports from this module — avoids a value-import cycle. Keep in sync.)
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
      baseUrl: provider.baseUrl,
      defaultModel: provider.defaultModel,
      models: provider.models,
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
    fallbackToCliWhenUnhealthy: parsed.fallback_to_cli_when_unhealthy,
    providers,
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

export function loadRemoteOAuthConfig(
  logger: Logger = noopLogger,
  env: NodeJS.ProcessEnv = process.env
): RemoteOAuthConfig {
  const configPath = defaultGatewayConfigPath();
  const { parsed: configFile, sourcePath } = readGatewayTomlFile(configPath, logger, "OAuth");
  const rawHttp = (configFile?.http as Record<string, unknown> | undefined) ?? {};
  const rawOAuth = (rawHttp.oauth as Record<string, unknown> | undefined) ?? {};
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

  const parsed = OAuthConfigSchema.safeParse(merged);
  if (!parsed.success) {
    logWarn(logger, "Invalid [http.oauth] config; remote OAuth disabled", {
      error: parsed.error.message,
    });
    return disabledOAuthConfig(sourcePath, envOverrides);
  }
  const data = parsed.data;
  if (data.issuer !== "auto" && !isHttpsOrLoopbackUrl(data.issuer)) {
    logWarn(logger, "Invalid [http.oauth].issuer; remote OAuth disabled");
    return disabledOAuthConfig(sourcePath, envOverrides);
  }
  for (const client of data.clients) {
    if (!data.allow_public_clients && !client.client_secret_hash) {
      logWarn(logger, "OAuth client secret hash is required when public clients are disabled", {
        client_id: client.client_id,
      });
      return disabledOAuthConfig(sourcePath, envOverrides);
    }
    if (client.client_secret_hash && !isSecretHash(client.client_secret_hash)) {
      logWarn(logger, "Invalid OAuth client secret hash; remote OAuth disabled", {
        client_id: client.client_id,
      });
      return disabledOAuthConfig(sourcePath, envOverrides);
    }
    if (
      client.allowed_redirect_uris.length === 0 ||
      client.allowed_redirect_uris.some(uri => !isSafeRedirectUri(uri))
    ) {
      logWarn(logger, "Invalid OAuth client redirect URI; remote OAuth disabled", {
        client_id: client.client_id,
      });
      return disabledOAuthConfig(sourcePath, envOverrides);
    }
  }
  if (data.shared_secret?.enabled) {
    if (!data.shared_secret.secret_hash || !isSecretHash(data.shared_secret.secret_hash)) {
      logWarn(logger, "Invalid [http.oauth.shared_secret] secret_hash; remote OAuth disabled");
      return disabledOAuthConfig(sourcePath, envOverrides);
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
      return disabledOAuthConfig(sourcePath, envOverrides);
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
