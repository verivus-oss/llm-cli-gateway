/**
 * Provider capability cache (phase-1b, runtime self-discovery contract).
 *
 * Persists a {@link DiscoveredCapabilitySet} on disk under the existing gateway
 * state directory (`~/.llm-cli-gateway/`, override with
 * `LLM_GATEWAY_CAPABILITY_CACHE_DIR`, consistent with the repo's other
 * `LLM_GATEWAY_*` overrides). One JSON file per provider.
 *
 * Cache key = the DAG `[runtime_self_discovery_contract].cache_key_fields`:
 * provider id, executable ABSOLUTE path, version string, root-help checksum,
 * subcommand-help checksums, ACP initialize checksum, model-catalog checksum,
 * and gateway version. The key is invalidated automatically when ANY field
 * changes (a freshly discovered set that differs in any field produces a
 * different composite key, so {@link lookupCapabilityCache} reports a miss).
 *
 * SECURITY: the cache NEVER persists secrets. Every string in the set is scrubbed
 * for bearer tokens, API keys, OAuth codes, Authorization headers, and account
 * identifiers before it is written. See {@link scrubSecrets}. A test proves a
 * token injected into fake probe output never reaches the cache file.
 *
 * Failure policy (implemented by {@link resolveCapabilitySet}): on discovery
 * failure, degrade to the last valid cached set iff the executable path AND
 * version match; else the caller keeps a minimal prompt surface with explicit
 * degraded-capability metadata.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod/v3";
import type { CliType } from "./provider-definitions.js";
import type { DiscoveredCapabilitySet } from "./provider-capability-discovery.js";

export const CAPABILITY_CACHE_SCHEMA_VERSION = "provider-capability-cache.v1";

/** The cache-key field set, kept explicit for transparency/age reporting. */
export interface CapabilityCacheKeyFields {
  readonly providerId: CliType;
  readonly executablePath: string;
  readonly version: string;
  readonly rootHelpChecksum: string;
  readonly subcommandHelpChecksums: Readonly<Record<string, string>>;
  readonly acpInitializeChecksum: string | null;
  readonly modelCatalogChecksum: string;
  readonly gatewayVersion: string;
}

/** A persisted cache entry. */
export interface CachedCapabilityEntry {
  readonly schemaVersion: typeof CAPABILITY_CACHE_SCHEMA_VERSION;
  readonly providerId: CliType;
  /** The composite cache key (sha-256 of the canonical key fields). */
  readonly cacheKey: string;
  readonly keyFields: CapabilityCacheKeyFields;
  /** The scrubbed capability set. */
  readonly capabilitySet: DiscoveredCapabilitySet;
  readonly cachedAt: string;
  readonly source: "discovery";
}

/** The result of a cache lookup against a freshly discovered set. */
export interface CapabilityCacheLookup {
  readonly hit: boolean;
  readonly ageMs: number | null;
  readonly cachedAt: string | null;
  readonly source: string | null;
  readonly version: string | null;
  /** The cached entry's composite cache key (the "checksum" surfaced to reports). */
  readonly checksum: string | null;
  readonly entry: CachedCapabilityEntry | null;
}

/** Directory where per-provider capability caches live. */
export function capabilityCacheDir(): string {
  const override = process.env.LLM_GATEWAY_CAPABILITY_CACHE_DIR;
  if (override && override.trim().length > 0) return override;
  return path.join(os.homedir(), ".llm-cli-gateway", "capability-cache");
}

function cacheFilePath(providerId: CliType): string {
  return path.join(capabilityCacheDir(), `${providerId}.json`);
}

/** Compute the composite cache key fields from a discovered set. */
export function cacheKeyFields(set: DiscoveredCapabilitySet): CapabilityCacheKeyFields {
  return {
    providerId: set.providerId,
    executablePath: set.executablePath,
    version: set.version,
    rootHelpChecksum: set.checksums.rootHelp,
    subcommandHelpChecksums: set.checksums.subcommandHelp,
    acpInitializeChecksum: set.checksums.acpInitialize,
    modelCatalogChecksum: set.checksums.modelCatalog,
    gatewayVersion: set.gatewayVersion,
  };
}

/** Canonicalize the key fields and hash them into the composite cache key. */
export function computeCacheKey(set: DiscoveredCapabilitySet): string {
  const fields = cacheKeyFields(set);
  const canonical = JSON.stringify([
    fields.providerId,
    fields.executablePath,
    fields.version,
    fields.rootHelpChecksum,
    Object.keys(fields.subcommandHelpChecksums)
      .sort()
      .map(key => [key, fields.subcommandHelpChecksums[key]]),
    fields.acpInitializeChecksum,
    fields.modelCatalogChecksum,
    fields.gatewayVersion,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Secret scrubbing. Applied to the WHOLE serialized set before persist so no
// token/credential/account-id can leak into the on-disk cache, regardless of
// which field (version, help, model catalog, ACP initialize) carried it.
// ---------------------------------------------------------------------------

const REDACTED = "[REDACTED]";

/**
 * A scrub rule. `replacement` is either the literal `[REDACTED]` (the whole
 * match is a secret) or a function that preserves a non-secret key/label while
 * redacting only the value, so the cache stays auditable ("api_key" is still
 * visible; its value is not).
 */
interface SecretRule {
  readonly pattern: RegExp;
  readonly replacement: string | ((match: string, ...groups: string[]) => string);
}

/**
 * GENERIC scrub categories (NOT a per-vendor allowlist). Enumeration is
 * whack-a-mole, so redaction is driven by structural shape:
 *  1. known token PREFIXES followed by a token body (whole match redacted),
 *  2. JSON `"<sensitive-key>": "<value>"` (value redacted, key kept),
 *  3. KV `<sensitive-key>=/: <value>` (value redacted, key kept),
 *  4. bare prefixed NUMERIC identifiers `user_/account_/...NNNNNN` (>=6 digits),
 *  5. Authorization Bearer/Basic headers,
 *  6. email addresses.
 *
 * Over-redaction guard: categories 2 and 3 fire ONLY in `"k":"v"` / `k=v` /
 * `k: v` syntax, so help enum text (`--sandbox=enabled`, `--model=grok-build`)
 * and bare numerics (128000, version 2.1.198) survive. Category 4 requires >=6
 * DIGITS after the prefix, so dictionary words (`user_config`, `org_name`) also
 * survive.
 *
 * A "sensitive key" = a bareword/quoted key whose NAME matches
 * {@link SENSITIVE_KEY_PATTERN}. Matching is CASE-INSENSITIVE and
 * SEPARATOR-AGNOSTIC, so `api-key`, `api_key`, `apiKey`, `access_key`,
 * `accessToken`, `auth_token`, `userId`, `accountId`, `clientId`,
 * `client_secret`, `private-key`, ... all resolve to the same sensitive class
 * without being individually enumerated.
 *
 * The VALUE is redacted as a WHOLE token up to a clear delimiter (KV: up to
 * whitespace/quote/comma/semicolon; JSON: up to the closing quote), so a value
 * that embeds an in-class-excluded char (e.g. `abcd:tailSecret`) cannot leak its
 * tail via a restricted character class.
 */

// Sensitive-key pattern. Compiled case-insensitively. Covers:
//  - bare sensitive words (token, secret, password, passwd, credential, auth);
//  - private/api key spellings (private-key, api_key, apikey);
//  - composite prefix+suffix ids in snake/kebab/camel: (access|api|client|
//    customer|user|account|org)[_-]?(id|key|token|secret) -> userId, user_id,
//    accountId, clientId, orgId, customerId, accessToken, apiKey, access_key...
const SENSITIVE_KEY_PATTERN =
  "token|secret|password|passwd|credential|auth|private[_-]?key|api[_-]?key|apikey|" +
  "(?:access|api|client|customer|user|account|org)[_-]?(?:id|key|token|secret)";

// Bare account-name keys (no id/key/token/secret suffix), redacted in KV form.
const ACCOUNT_KEY_NAMES = "account|acct";

// Value tokens. KV stops at the first whitespace/quote/comma/semicolon so the
// WHOLE value (including embedded ':' etc) is captured. JSON consumes the whole
// string body, honoring backslash escapes (so an escaped quote inside the value
// does not end the match early) up to the real closing quote.
const KV_VALUE = "[^\\s\"',;]+";
const JSON_VALUE = '(?:[^"\\\\]|\\\\.)*';

const REDACT_VALUE = (match: string, keyPart: string): string => `${keyPart}${REDACTED}`;
const REDACT_JSON_VALUE = (match: string, keyPart: string): string => `${keyPart}"${REDACTED}"`;

const SECRET_RULES: readonly SecretRule[] = [
  // (1) Known token PREFIXES + >=8 token chars. The whole token is the secret.
  //     Case-sensitive prefixes; token body = [A-Za-z0-9_.-].
  {
    pattern:
      /\b(?:sk-ant-|anthropic-|sk-|xai-|gsk_|gh[pousr]_|github_pat_|ya29\.|AKIA|ASIA)[A-Za-z0-9_.-]{8,}/g,
    replacement: REDACTED,
  },
  // (1b) Google OAuth refresh tokens `1//...` (no word boundary before a digit).
  { pattern: /1\/\/[A-Za-z0-9_.-]{8,}/g, replacement: REDACTED },
  // (5) Authorization headers (Bearer AND Basic). Redact scheme + token as one
  //     unit so the later KV rule (which sees "auth" in "Authorization") cannot
  //     partially re-process the remainder. The label is not help content.
  { pattern: /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+\S+/gi, replacement: REDACTED },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, replacement: REDACTED },
  // (2) JSON `"<sensitive-key>": "<value>"` -> keep key, redact the WHOLE value.
  {
    pattern: new RegExp(
      `("[A-Za-z0-9_.-]*(?:${SENSITIVE_KEY_PATTERN})[A-Za-z0-9_.-]*"\\s*:\\s*)"${JSON_VALUE}"`,
      "gi"
    ),
    replacement: REDACT_JSON_VALUE,
  },
  // (3) KV `<sensitive-key>=<value>` / `<sensitive-key>: <value>` -> redact the
  //     WHOLE value up to a delimiter (whitespace/quote/comma/semicolon).
  {
    pattern: new RegExp(
      `\\b([A-Za-z0-9_.-]*(?:${SENSITIVE_KEY_PATTERN})[A-Za-z0-9_.-]*\\s*[:=]\\s*)${KV_VALUE}`,
      "gi"
    ),
    replacement: REDACT_VALUE,
  },
  // (3b) Bare account-name keys in KV form -> redact the WHOLE value.
  {
    pattern: new RegExp(`\\b((?:${ACCOUNT_KEY_NAMES})\\s*[:=]\\s*)${KV_VALUE}`, "gi"),
    replacement: REDACT_VALUE,
  },
  // (4) Bare PREFIXED NUMERIC identifiers (>=6 digits avoids dictionary words).
  { pattern: /\b(?:user|customer|account|acct|org)_[0-9]{6,}\b/g, replacement: REDACTED },
  // (6) Email addresses (account identifiers).
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: REDACTED },
];

/** Redact secret-looking substrings from a string. */
export function scrubString(value: string): string {
  let out = value;
  for (const rule of SECRET_RULES) {
    out =
      typeof rule.replacement === "string"
        ? out.replace(rule.pattern, rule.replacement)
        : out.replace(rule.pattern, rule.replacement);
  }
  return out;
}

/** Deep-clone a set with every string field scrubbed of secrets. */
export function scrubSecrets<T>(value: T): T {
  if (typeof value === "string") return scrubString(value) as unknown as T;
  if (Array.isArray(value)) return value.map(entry => scrubSecrets(entry)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubSecrets(entry);
    }
    return out as unknown as T;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Zod validation at the cache-read boundary (external input). The on-disk cache
// JSON is untrusted: a truncated/corrupt file whose schemaVersion+providerId
// happen to match must NOT be treated as a valid capability set (that would let
// the "degrade to last VALID cached set" policy fall back to garbage). We
// safeParse on read and treat any failure as a cache miss (-> rediscover),
// never a throw. Schemas are permissive (`.passthrough()`, loose enums) so
// forward-compatible additions do not spuriously invalidate the cache, while
// structural corruption is still rejected.
// ---------------------------------------------------------------------------

const ParsedUnmappedSchema = z
  .object({
    kind: z.string(),
    raw: z.string(),
    checksum: z.string(),
    reason: z.string(),
  })
  .passthrough();

const ParsedHelpSchema = z
  .object({
    flags: z.array(z.object({ name: z.string() }).passthrough()),
    subcommands: z.array(z.object({ name: z.string() }).passthrough()),
    discoveredUnmapped: z.array(ParsedUnmappedSchema),
    checksum: z.string(),
  })
  .passthrough();

const DiscoveredCapabilitySetSchema = z
  .object({
    providerId: z.string(),
    executable: z.string(),
    executablePath: z.string(),
    version: z.string(),
    rootHelp: ParsedHelpSchema,
    subcommandHelp: z.record(z.string(), ParsedHelpSchema),
    modelCatalog: z
      .object({
        strategy: z.string(),
        argv: z.array(z.string()),
        raw: z.string().nullable(),
        checksum: z.string(),
        evidence: z.string(),
      })
      .passthrough(),
    acpInitialize: z.object({}).passthrough().nullable(),
    checksums: z
      .object({
        version: z.string(),
        rootHelp: z.string(),
        subcommandHelp: z.record(z.string(), z.string()),
        modelCatalog: z.string(),
        acpInitialize: z.string().nullable(),
      })
      .passthrough(),
    sourceEvidence: z.array(z.string()),
    discoveredUnmapped: z.array(ParsedUnmappedSchema),
    status: z.enum(["ok", "degraded", "error"]),
    degradedReason: z.string().optional(),
    gatewayVersion: z.string(),
    discoveredAt: z.string(),
  })
  .passthrough();

const CachedCapabilityEntrySchema = z
  .object({
    schemaVersion: z.literal(CAPABILITY_CACHE_SCHEMA_VERSION),
    providerId: z.string(),
    cacheKey: z.string(),
    keyFields: z.object({}).passthrough(),
    capabilitySet: DiscoveredCapabilitySetSchema,
    cachedAt: z.string(),
    source: z.literal("discovery"),
  })
  .passthrough();

/**
 * Read the cached entry for a provider, or null when absent/unreadable/invalid.
 * The file is validated with Zod (see above): a malformed/truncated body is
 * treated as a cache miss, never a crash or an invalid fallback entry.
 */
export function readCapabilityCache(providerId: CliType): CachedCapabilityEntry | null {
  const file = cacheFilePath(providerId);
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const parsed = CachedCapabilityEntrySchema.safeParse(raw);
  if (!parsed.success) return null;
  if (parsed.data.providerId !== providerId) return null;
  if (parsed.data.capabilitySet.providerId !== providerId) return null;
  return parsed.data as unknown as CachedCapabilityEntry;
}

/**
 * Persist a discovered set. The set is scrubbed of secrets before writing; the
 * returned entry contains the scrubbed set and the composite cache key.
 */
export function writeCapabilityCache(set: DiscoveredCapabilitySet): CachedCapabilityEntry {
  const dir = capabilityCacheDir();
  mkdirSync(dir, { recursive: true });
  const scrubbedSet = scrubSecrets(set);
  const entry: CachedCapabilityEntry = {
    schemaVersion: CAPABILITY_CACHE_SCHEMA_VERSION,
    providerId: set.providerId,
    cacheKey: computeCacheKey(set),
    keyFields: scrubSecrets(cacheKeyFields(set)),
    capabilitySet: scrubbedSet,
    cachedAt: new Date().toISOString(),
    source: "discovery",
  };
  const file = cacheFilePath(set.providerId);
  writeFileSync(file, JSON.stringify(entry, null, 2), { encoding: "utf8", mode: 0o600 });
  return entry;
}

/**
 * Look up the cache for a freshly discovered set. A hit means the persisted
 * entry's composite key equals the fresh set's key (nothing in the cache-key
 * fields changed). Any change to a key field yields a miss (automatic
 * invalidation). Exposes age/source/version/checksum for report consumers.
 */
export function lookupCapabilityCache(freshSet: DiscoveredCapabilitySet): CapabilityCacheLookup {
  const entry = readCapabilityCache(freshSet.providerId);
  if (!entry) {
    return {
      hit: false,
      ageMs: null,
      cachedAt: null,
      source: null,
      version: null,
      checksum: null,
      entry: null,
    };
  }
  const freshKey = computeCacheKey(freshSet);
  const hit = entry.cacheKey === freshKey;
  const cachedAtMs = Date.parse(entry.cachedAt);
  return {
    hit,
    ageMs: Number.isFinite(cachedAtMs) ? Date.now() - cachedAtMs : null,
    cachedAt: entry.cachedAt,
    source: entry.source,
    version: entry.keyFields.version,
    checksum: entry.cacheKey,
    entry,
  };
}

/** The outcome of {@link resolveCapabilitySet}. */
export interface ResolvedCapability {
  readonly set: DiscoveredCapabilitySet;
  /** Where the resolved set came from. */
  readonly source: "discovery" | "cache" | "minimal";
  /** True when this is a fallback (cache/minimal) after a discovery failure. */
  readonly degraded: boolean;
  readonly reason?: string;
}

/**
 * Apply the failure policy to a freshly discovered set:
 *  - `ok`/`degraded` discovery -> use it and refresh the cache.
 *  - `error` discovery -> fall back to the last VALID cached set iff the
 *    executable path AND version match; otherwise return the minimal error set
 *    with explicit degraded-capability metadata.
 */
export function resolveCapabilitySet(freshSet: DiscoveredCapabilitySet): ResolvedCapability {
  if (freshSet.status !== "error") {
    writeCapabilityCache(freshSet);
    return { set: freshSet, source: "discovery", degraded: freshSet.status === "degraded" };
  }

  const entry = readCapabilityCache(freshSet.providerId);
  if (
    entry &&
    entry.keyFields.executablePath === freshSet.executablePath &&
    entry.keyFields.version === freshSet.version &&
    freshSet.version.length > 0
  ) {
    return {
      set: entry.capabilitySet,
      source: "cache",
      degraded: true,
      reason: freshSet.degradedReason ?? "discovery failed; using last valid cached capability set",
    };
  }

  return {
    set: freshSet,
    source: "minimal",
    degraded: true,
    reason:
      freshSet.degradedReason ??
      "discovery failed and no matching cache exists; minimal prompt surface only",
  };
}
