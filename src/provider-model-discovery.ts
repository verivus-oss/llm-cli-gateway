/**
 * Provider model discovery (phase-3, live + account-aware model catalogs).
 *
 * Turns a phase-1b {@link DiscoveredCapabilitySet} into a normalized, per-provider
 * {@link DiscoveredModelListing}. It REUSES the phase-1b discovery machinery: the
 * native model-listing command was already run through the INJECTABLE ProbeRunner
 * (its raw stdout and checksum live on `set.modelCatalog`), so this module never
 * spawns a process of its own. Parsing is driven entirely by the model-discovery
 * DESCRIPTOR in `provider-definitions.ts` (command, parse dialect, config/env
 * sources, fallback policy). The provider-specific dispatch is a single closed
 * switch guarded by {@link assertNever}, so adding a provider whose native output
 * needs a new dialect fails the build until a parser is written.
 *
 * Account/live-vs-bundled distinction: native models parsed from the live command
 * carry origin `live-catalog`/`live-hidden`/`account-label`; the curated bundled
 * catalog (and config/env facts) from {@link CliInfo} carry origin
 * `curated-fallback`/`config`/`env`. Both are represented, never conflated.
 *
 * Secrets: this module returns only parsed model ids/labels and descriptions.
 * The phase-1b cache scrubber (`provider-capability-cache.ts::scrubSecrets`) runs
 * over the WHOLE discovered set before anything is persisted, so any account id /
 * token that leaked into native stdout is redacted before caching.
 */

import { assertNever } from "./provider-definition-assertions.js";
import type {
  CliType,
  ModelCatalogParseFormat,
  ModelFallbackPolicy,
  ProviderDefinition,
  ProviderModelConfigSource,
  ProviderModelFacts,
} from "./provider-definitions.js";
import type { DiscoveredCapabilitySet } from "./provider-capability-discovery.js";
import { checksumText, type DiscoveredUnmapped } from "./provider-help-parser.js";
import { scrubString } from "./provider-capability-cache.js";
import type { CliInfo } from "./model-registry.js";

/** Where a discovered model came from. */
export type ModelOrigin =
  "live-catalog" | "live-hidden" | "account-label" | "config" | "env" | "curated-fallback";

/** One discovered model with its provenance. */
export interface DiscoveredModel {
  /** Machine model id/slug (for account-label dialects this is the label). */
  readonly id: string;
  /** Human display label, when the native output supplies one. */
  readonly label?: string;
  /** Short description (never long system/base instructions). */
  readonly description?: string;
  readonly origin: ModelOrigin;
  readonly isDefault: boolean;
}

/** The normalized model catalog for one provider. */
export interface DiscoveredModelListing {
  readonly providerId: CliType;
  readonly strategy: string;
  readonly parse: ModelCatalogParseFormat;
  readonly fallbackPolicy: ModelFallbackPolicy;
  /** High-level source of the primary catalog. */
  readonly source: "live-command" | "config-or-env" | "curated-catalog";
  readonly defaultModel: string | null;
  readonly models: readonly DiscoveredModel[];
  readonly facts: ProviderModelFacts;
  readonly configSources: readonly ProviderModelConfigSource[];
  /** Checksum of the native catalog (from phase-1b); drives cache invalidation. */
  readonly catalogChecksum: string;
  /** Models/rows discovered but not confidently mapped, with evidence. */
  readonly discoveredUnmapped: readonly DiscoveredUnmapped[];
  readonly evidence: string;
}

/** Options for {@link discoverProviderModels}. */
export interface ModelDiscoveryOptions {
  /**
   * The provider's config/env/fallback model facts (from `getAvailableCliInfo`).
   * When supplied, its models/default are merged as `config`/`env`/`curated-fallback`
   * origins alongside any live catalog. Omitted in pure-native unit tests.
   */
  readonly registryInfo?: CliInfo;
}

/** Truncate any description so long base/system instructions never leak. */
function shortDescription(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > 200 ? `${trimmed.slice(0, 197)}...` : trimmed;
}

/** A plausible machine model id token (rejects prose/marker fragments). */
function isPlausibleModelId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{1,80}$/.test(value);
}

interface NativeParseResult {
  readonly models: DiscoveredModel[];
  readonly defaultModel: string | null;
  readonly unmapped: DiscoveredUnmapped[];
}

const EMPTY_NATIVE: NativeParseResult = { models: [], defaultModel: null, unmapped: [] };

/** Parse `codex debug models` JSON into the live/bundled-distinguished catalog. */
function parseCodexDebugJson(raw: string): NativeParseResult {
  const models: DiscoveredModel[] = [];
  const unmapped: DiscoveredUnmapped[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    unmapped.push({
      kind: "model",
      raw: raw.slice(0, 120),
      checksum: checksumText(raw),
      reason: "codex debug models output is not valid JSON",
    });
    return { models, defaultModel: null, unmapped };
  }
  const list =
    parsed && typeof parsed === "object" && Array.isArray((parsed as { models?: unknown }).models)
      ? ((parsed as { models: unknown[] }).models as unknown[])
      : null;
  if (!list) {
    unmapped.push({
      kind: "model",
      raw: JSON.stringify(parsed).slice(0, 120),
      checksum: checksumText(raw),
      reason: "codex debug models JSON has no models[] array",
    });
    return { models, defaultModel: null, unmapped };
  }
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const slug = typeof record.slug === "string" ? record.slug.trim() : "";
    if (!slug || !isPlausibleModelId(slug)) {
      unmapped.push({
        kind: "model",
        raw: JSON.stringify(record).slice(0, 120),
        checksum: checksumText(JSON.stringify(record)),
        reason: "codex model entry has a missing or non-id slug",
      });
      continue;
    }
    // visibility "list" is the live catalog; anything else (e.g. "hide") is a
    // live-but-hidden internal model. The bundled fallback lives in the registry.
    const origin: ModelOrigin = record.visibility === "list" ? "live-catalog" : "live-hidden";
    models.push({
      id: slug,
      label: typeof record.display_name === "string" ? record.display_name : undefined,
      description: shortDescription(record.description),
      origin,
      isDefault: false,
    });
  }
  return { models, defaultModel: null, unmapped };
}

/** Parse `grok models` text (`Default model: X` + `* id (default)`/`- id`). */
function parseGrokModelsText(raw: string): NativeParseResult {
  const models: DiscoveredModel[] = [];
  const unmapped: DiscoveredUnmapped[] = [];
  let defaultModel: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const defaultMatch = /^default model:\s*(\S+)/i.exec(trimmed);
    if (defaultMatch) {
      defaultModel = defaultMatch[1];
      continue;
    }
    const bullet = /^[*-]\s+(\S+)(\s*\(default\))?\s*$/.exec(trimmed);
    if (!bullet) continue;
    const id = bullet[1];
    if (!isPlausibleModelId(id)) {
      unmapped.push({
        kind: "model",
        raw: trimmed,
        checksum: checksumText(trimmed),
        reason: "grok models bullet line has a non-id token",
      });
      continue;
    }
    const isDefault = Boolean(bullet[2]) || id === defaultModel;
    if (isDefault) defaultModel = id;
    models.push({ id, origin: "live-catalog", isDefault });
  }
  return { models, defaultModel, unmapped };
}

/** Parse `agy models` text: one account model label per line (labels, not ids). */
function parseAgyModelsText(raw: string): NativeParseResult {
  const models: DiscoveredModel[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const label = line.trim();
    if (label.length === 0) continue;
    // agy prints display labels ("Gemini 3.5 Flash (Medium)"), not machine ids.
    models.push({ id: label, label, origin: "account-label", isDefault: false });
  }
  return { models, defaultModel: null, unmapped: [] };
}

/** Map a model-registry metadata source to a discovered-model origin. */
function registryOrigin(source: string | undefined): ModelOrigin {
  switch (source) {
    case "env":
      return "env";
    case "config":
      return "config";
    default:
      return "curated-fallback";
  }
}

/** Fold config/env/fallback registry facts into the listing (deduped by id). */
function mergeRegistryModels(
  base: DiscoveredModel[],
  defaultModel: string | null,
  info: CliInfo | undefined
): { models: DiscoveredModel[]; defaultModel: string | null } {
  if (!info) return { models: base, defaultModel };
  const byId = new Map<string, DiscoveredModel>();
  for (const model of base) byId.set(model.id, model);
  const resolvedDefault = defaultModel ?? info.defaultModel ?? null;
  for (const [id, description] of Object.entries(info.models)) {
    if (byId.has(id)) continue;
    byId.set(id, {
      id,
      description: shortDescription(description),
      origin: registryOrigin(info.modelMetadata?.[id]?.source),
      isDefault: id === resolvedDefault,
    });
  }
  const models = [...byId.values()].map(model => ({
    ...model,
    isDefault: model.id === resolvedDefault ? true : model.isDefault,
  }));
  return { models, defaultModel: resolvedDefault };
}

/**
 * Discover the normalized model catalog for ONE provider from its already-probed
 * capability set. Pure/data-only: no process spawn. The parse dispatch is the
 * closed, `assertNever`-guarded switch that keeps model discovery DRY.
 */
export function discoverProviderModels(
  def: ProviderDefinition,
  set: DiscoveredCapabilitySet,
  options: ModelDiscoveryOptions = {}
): DiscoveredModelListing {
  const md = def.discovery.modelDiscovery;
  const raw = set.modelCatalog.raw ?? "";

  let native: NativeParseResult;
  let source: DiscoveredModelListing["source"];
  switch (md.parse) {
    case "codex-debug-json":
      native = raw.trim().length > 0 ? parseCodexDebugJson(raw) : EMPTY_NATIVE;
      source = "live-command";
      break;
    case "grok-models-text":
      native = raw.trim().length > 0 ? parseGrokModelsText(raw) : EMPTY_NATIVE;
      source = "live-command";
      break;
    case "agy-models-text":
      native = raw.trim().length > 0 ? parseAgyModelsText(raw) : EMPTY_NATIVE;
      source = "live-command";
      break;
    case "config-or-env":
      native = EMPTY_NATIVE;
      source = "config-or-env";
      break;
    case "curated-catalog":
      native = EMPTY_NATIVE;
      source = "curated-catalog";
      break;
    default:
      return assertNever(md.parse, "ModelCatalogParseFormat");
  }

  const merged = mergeRegistryModels(native.models, native.defaultModel, options.registryInfo);

  // Defense in depth: the phase-1b cache scrubber runs before PERSIST, but a
  // discovered listing can be emitted to callers straight from an in-memory set
  // (never cached). Scrub the emitted id/label/description/raw/reason/evidence
  // here too, so a stray secret/account-id in raw CLI output can never surface
  // in a model listing even on the non-cached path.
  return {
    providerId: def.id,
    strategy: md.strategy,
    parse: md.parse,
    fallbackPolicy: md.fallbackPolicy,
    source,
    // Scrub the live-derived default too: parseGrokModelsText reads
    // `Default model: <token>` straight from CLI stdout, so an account id or
    // token printed there must not bypass scrubbing onto a user-visible surface.
    defaultModel: merged.defaultModel ? scrubString(merged.defaultModel) : merged.defaultModel,
    models: merged.models.map(scrubModel),
    facts: md.facts,
    configSources: md.configSources,
    catalogChecksum: set.checksums.modelCatalog,
    discoveredUnmapped: native.unmapped.map(scrubUnmapped),
    evidence: scrubString(md.evidence),
  };
}

/** Scrub the secret-bearing text fields of one emitted model. */
function scrubModel(model: DiscoveredModel): DiscoveredModel {
  return {
    ...model,
    id: scrubString(model.id),
    ...(model.label !== undefined ? { label: scrubString(model.label) } : {}),
    ...(model.description !== undefined ? { description: scrubString(model.description) } : {}),
  };
}

/** Scrub the secret-bearing text fields of one discovered-unmapped row. */
function scrubUnmapped(unmapped: DiscoveredUnmapped): DiscoveredUnmapped {
  return {
    ...unmapped,
    raw: scrubString(unmapped.raw),
    reason: scrubString(unmapped.reason),
  };
}
