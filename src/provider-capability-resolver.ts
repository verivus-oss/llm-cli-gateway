/**
 * Provider capability resolver (phase-3 wiring, read-surface projection).
 *
 * This is the seam that makes the phase-1b discovery + cache layer and the
 * phase-3 model-discovery parser actually reach USER-FACING read surfaces
 * (`models://<cli>`, `list_models`) instead of being dead code. It:
 *
 *  - Memoizes the resolved {@link DiscoveredCapabilitySet} per provider for the
 *    server process lifetime (a module-level {@link Map} keyed by {@link CliType}),
 *    so a read never re-spawns a CLI it already resolved.
 *  - On first resolve: seeds from a VALID on-disk cache entry when present
 *    ({@link readCapabilityCache}) to avoid a spawn, else runs
 *    {@link discoverProviderCapabilities} via the real default {@link ProbeRunner}
 *    (which already carries a spawn timeout) and persists through
 *    {@link resolveCapabilitySet} / {@link writeCapabilityCache}.
 *  - Degrades gracefully: ANY discovery failure/timeout returns `null` (never
 *    throws) and is NOT memoized permanently, so a later resolve can retry and
 *    callers fall back to the static registry.
 *  - Is fully injectable for tests: pass an `inject` provider (or a fake
 *    `runner`) so unit tests never spawn real CLIs.
 *
 * Read path vs. warm path: the READ surfaces use {@link peekProviderCapabilitySet}
 * (memo-only, synchronous, never spawns). The process entrypoint calls
 * {@link warmProviderCapabilities} once at startup (fire-and-forget) to populate
 * the memo from cache/discovery. This guarantees reads never hang on a spawn.
 */

import type { CliType } from "./provider-definitions.js";
import { getAllProviderDefinitions, type ProviderDefinition } from "./provider-definitions.js";
import {
  defaultProbeRunner,
  discoverProviderCapabilities,
  type DiscoveredCapabilitySet,
  type ProbeRunner,
} from "./provider-capability-discovery.js";
import { readCapabilityCache, resolveCapabilitySet } from "./provider-capability-cache.js";
import { discoverProviderModels, type DiscoveredModelListing } from "./provider-model-discovery.js";
import type { CliInfo } from "./model-registry.js";
import { noopLogger, type Logger } from "./logger.js";

/** Where the capability set backing a read came from. */
export type CapabilityResolutionSource = "live" | "cache" | "static-fallback";

/** A resolved capability set with provenance (non-static). */
export interface ResolvedProviderCapability {
  readonly set: DiscoveredCapabilitySet;
  /** "live" = fresh discovery this process; "cache" = on-disk/last-valid set. */
  readonly source: "live" | "cache";
  readonly degraded: boolean;
}

/** Options for {@link resolveProviderCapabilitySet}. */
export interface ResolveCapabilityOptions {
  /** Injected probe runner (default = real spawn runner with a timeout). */
  readonly runner?: ProbeRunner;
  /**
   * Injected capability-set provider. When supplied it fully REPLACES the
   * discovery+cache path (tests never spawn). Return null to model "no set".
   */
  readonly inject?: (
    def: ProviderDefinition
  ) => Promise<ResolvedProviderCapability | null> | ResolvedProviderCapability | null;
  /** Bypass the memo/on-disk seed and force a fresh discovery. */
  readonly forceRefresh?: boolean;
  readonly logger?: Logger;
}

// Module-level memo: process-lifetime cache of resolved sets. Keyed by CliType so
// each provider resolves at most once (until forceRefresh). Only successful
// resolutions are memoized; a failure returns null WITHOUT memoizing so a later
// call can retry.
const memo = new Map<CliType, ResolvedProviderCapability>();

/** Test hook: clear the process-lifetime memo. */
export function __resetCapabilityResolverMemoForTest(): void {
  memo.clear();
}

/** Test hook: seed the memo directly (bypasses discovery). */
export function __seedCapabilityResolverMemoForTest(
  id: CliType,
  resolution: ResolvedProviderCapability
): void {
  memo.set(id, resolution);
}

/**
 * Synchronous, memo-only peek used by READ surfaces. Returns the already-resolved
 * capability for a provider or null. NEVER spawns, reads disk, or blocks, so a
 * read can always answer immediately (falling back to static when null).
 */
export function peekProviderCapabilitySet(id: CliType): ResolvedProviderCapability | null {
  return memo.get(id) ?? null;
}

/**
 * Resolve (and memoize) a provider's capability set. See the module docblock for
 * the memo/seed/degrade contract. Returns null on any failure (never throws).
 */
export async function resolveProviderCapabilitySet(
  def: ProviderDefinition,
  options: ResolveCapabilityOptions = {}
): Promise<ResolvedProviderCapability | null> {
  const logger = options.logger ?? noopLogger;
  if (!options.forceRefresh) {
    const memoized = memo.get(def.id);
    if (memoized) return memoized;
  }
  try {
    if (options.inject) {
      const injected = await options.inject(def);
      if (injected) memo.set(def.id, injected);
      return injected;
    }

    // Seed from a VALID on-disk cache entry to avoid an initial spawn.
    if (!options.forceRefresh) {
      const cached = readCapabilityCache(def.id);
      if (cached && cached.capabilitySet.status !== "error") {
        const resolution: ResolvedProviderCapability = {
          set: cached.capabilitySet,
          source: "cache",
          degraded: cached.capabilitySet.status === "degraded",
        };
        memo.set(def.id, resolution);
        return resolution;
      }
    }

    const fresh = await discoverProviderCapabilities(def, {
      runner: options.runner ?? defaultProbeRunner,
      logger,
    });
    // resolveCapabilitySet writes the cache on a non-error set and, on an error
    // set, falls back to the last valid cached set (or "minimal").
    const resolved = resolveCapabilitySet(fresh);
    if (resolved.source === "minimal") {
      // No usable set: let the caller fall back to static. Do NOT memoize so a
      // later resolve (e.g. after auth) can retry.
      return null;
    }
    const resolution: ResolvedProviderCapability = {
      set: resolved.set,
      source: resolved.source === "discovery" ? "live" : "cache",
      degraded: resolved.degraded,
    };
    memo.set(def.id, resolution);
    return resolution;
  } catch (err) {
    logger.debug(`capability resolve failed for ${def.id}`, {
      reason: err instanceof Error ? err.message : String(err),
    });
    return null; // degrade to static; do not memoize (allow later retry)
  }
}

/**
 * Warm the memo for every provider (fire-and-forget at process startup). Never
 * rejects: each provider is fault-isolated so one failed spawn cannot block the
 * others or crash the server.
 */
export async function warmProviderCapabilities(
  options: ResolveCapabilityOptions = {}
): Promise<void> {
  await Promise.all(
    getAllProviderDefinitions().map(def =>
      resolveProviderCapabilitySet(def, options).catch(() => null)
    )
  );
}

/** A read-surface projection of a provider's discovered model listing. */
export interface ProviderDiscoveredView {
  readonly source: CapabilityResolutionSource;
  readonly degraded: boolean;
  /** The parsed, secret-scrubbed listing, or null when static-fallback. */
  readonly listing: DiscoveredModelListing | null;
}

/**
 * Build the additive `discovered` projection a read surface attaches next to the
 * static registry entry. Uses a synchronous resolver (default = memo-only peek),
 * so it NEVER spawns on the read path. When no capability set is resolvable it
 * returns source "static-fallback" with a null listing, and the caller keeps its
 * static output.
 */
export function buildProviderDiscoveredView(
  def: ProviderDefinition,
  registryInfo: CliInfo | undefined,
  peek: (id: CliType) => ResolvedProviderCapability | null = peekProviderCapabilitySet
): ProviderDiscoveredView {
  const resolved = peek(def.id);
  if (!resolved) {
    return { source: "static-fallback", degraded: false, listing: null };
  }
  const listing = discoverProviderModels(def, resolved.set, { registryInfo });
  return { source: resolved.source, degraded: resolved.degraded, listing };
}
