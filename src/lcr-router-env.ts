/**
 * Production {@link RouterEnv} builder for least-cost routing (LCR).
 *
 * `src/least-cost-router.ts` is a PURE selector: it takes every environment fact
 * (auth, breaker health, capacity, model lists, capabilities, prices, metrics)
 * through an injected {@link RouterEnv} so it never spawns a CLI, reads a clock,
 * or reaches into a live module. This file is the one place those facts are
 * gathered from the real modules and packed into a `RouterEnv` for the
 * `route_request` dispatcher. It also projects a resolved {@link LeastCostConfig}
 * into the router's {@link RouterConfig}.
 *
 * Clock/impurity note: the ranker (least-cost-router.ts) is clock-free by
 * contract (decision 11). This module is the impure seam BY DESIGN, so a signal
 * that would need `Date.now` / spawning lives here, never in the ranker.
 *
 * Auth (phase_1): a real per-candidate auth probe (`provider-status.ts`) spawns
 * the provider CLI (`--version`) synchronously, which must NEVER run in the
 * routing hot path (it would block the event loop for up to seconds per
 * provider). So production `isAuthed` is OPTIMISTIC for spawnable CLI providers:
 * an unauthenticated provider surfaces its failure at dispatch time, which the
 * resilience loop treats as a non-transient failure and drops the candidate
 * (re-selecting over the remainder). API providers are authed by construction
 * (only enabled providers, whose key resolved, are ever passed in). The seam is
 * injectable so unit tests still exercise the router's auth-eligibility filter,
 * and a later phase can wire a cached async auth snapshot without touching the
 * ranker. See docs/least-cost-routing-contract.md and
 * docs/plans/least-cost-routing.draft.md (section 4.3).
 */

import { CLI_TYPES, type CliType } from "./provider-types.js";
import { getCliInfo } from "./model-registry.js";
import { getProviderDefinition } from "./provider-definitions.js";
import { cliBreakerState } from "./executor.js";
import { apiProviderBreakerState } from "./api-provider.js";
import { providerAtCapacity, type JobLimiterSnapshot } from "./async-job-manager.js";
import { getModelCost } from "./pricing.js";
import { classifyContent } from "./token-estimator.js";
import {
  computeLcrPriorsFromDb,
  lookupCalibrationK,
  type LcrPriors,
  type PriorsScope,
} from "./lcr-priors.js";
import type { FlightRecorderQuery } from "./flight-recorder.js";
import type { PerformanceMetrics } from "./metrics.js";
import type { ApiProviderRuntime, LeastCostConfig } from "./config.js";
import type { ModelCost } from "./least-cost-types.js";
import type { RouterEnv, RouterConfig, CandidateCapabilities } from "./least-cost-router.js";

const CLI_TYPE_SET: ReadonlySet<string> = new Set<string>(CLI_TYPES);

function isCliType(provider: string): provider is CliType {
  return CLI_TYPE_SET.has(provider);
}

/** Permissive capability defaults for an API provider (phase_2 refines these). */
const API_PROVIDER_CAPABILITIES: CandidateCapabilities = {
  acceptsImages: false,
  acceptsAttachments: false,
  toolCalling: true,
  jsonSchema: true,
  outputFormats: ["text", "json"],
  capabilityScope: "full",
  effortLevels: [],
};

/** Environment inputs the production RouterEnv is built from. */
export interface RouterEnvDeps {
  /** Per-provider success-rate / mean-latency source for tie-break (4.5.3). */
  performanceMetrics: PerformanceMetrics;
  /** A single limiter snapshot; capacity is read from it (deterministic per call). */
  limiterSnapshot: JobLimiterSnapshot;
  /** Enabled API providers (already key-resolved), part of the candidate pool. */
  apiProviders: readonly ApiProviderRuntime[];
  /**
   * Auth override (tests). Production default is optimistic for CLI providers
   * and true for the (already-enabled) API providers; see the module doc.
   */
  isAuthed?: (provider: string) => boolean;
  /**
   * Prefer the published api-catalog price over the CLI family table when a
   * model resolves in both (config `prefer_catalog_price`, default true).
   */
  preferCatalogPrice?: boolean;
  /**
   * Flight-recorder read handle for the calibration priors (token-estimator
   * layer 3). Omitted / absent => calibration is neutral (k = 1). Priors are
   * memoized with a short TTL so routing does not scan the recorder per request.
   */
  flightRecorder?: FlightRecorderQuery;
  /** Learning scope for priors (config `priors_scope`); default global. */
  priorsScope?: PriorsScope;
  /** Caller principal for `priors_scope = "principal"` scoping. */
  ownerPrincipal?: string;
  /** Test override: supply priors directly, bypassing the recorder + cache. */
  priors?: LcrPriors;
}

const EMPTY_PRIORS: LcrPriors = {
  outputPriors: new Map(),
  calibration: new Map(),
  accuracyByBasis: new Map(),
};

// Priors are expensive to compute (a flight-recorder scan), so memoize them with
// a short TTL keyed by (scope, principal). The clock read lives in this env seam
// by design (the ranker stays clock-free). One in-process entry is enough: the
// router reads priors for one (scope, principal) at a time per request.
const PRIORS_TTL_MS = 60_000;
let priorsCacheEntry: { at: number; key: string; priors: LcrPriors } | null = null;

function resolvePriors(deps: RouterEnvDeps): LcrPriors {
  if (deps.priors) return deps.priors;
  const scope: PriorsScope = deps.priorsScope ?? "global";
  if (scope === "off" || !deps.flightRecorder) return EMPTY_PRIORS;
  const key = `${scope}:${deps.ownerPrincipal ?? ""}`;
  const now = Date.now();
  if (
    priorsCacheEntry &&
    priorsCacheEntry.key === key &&
    now - priorsCacheEntry.at < PRIORS_TTL_MS
  ) {
    return priorsCacheEntry.priors;
  }
  const priors = computeLcrPriorsFromDb(deps.flightRecorder, {
    priorsScope: scope,
    ownerPrincipal: deps.ownerPrincipal,
  });
  priorsCacheEntry = { at: now, key, priors };
  return priors;
}

/** Test-only: clear the memoized priors so a test's injected recorder is re-read. */
export function resetLcrPriorsCacheForTest(): void {
  priorsCacheEntry = null;
}

function candidateCapabilities(provider: string): CandidateCapabilities {
  if (isCliType(provider)) {
    const def = getProviderDefinition(provider);
    return {
      acceptsImages: def.requestSurface.acceptsImages,
      acceptsAttachments: def.requestSurface.acceptsAttachments,
      toolCalling: def.requestSurface.toolCalling,
      jsonSchema: def.requestSurface.jsonSchema,
      outputFormats: def.outputFormats,
      capabilityScope: def.capabilityScope,
      effortLevels: def.discovery.modelDiscovery.facts.effortLevels,
    };
  }
  return API_PROVIDER_CAPABILITIES;
}

/**
 * Build the production {@link RouterEnv}. The pool is `CLI_TYPES` plus the
 * enabled API-provider names (contract non-goal `no_new_provider_lists`: the
 * enumeration derives from `CLI_TYPES` + `enabledApiProviders()`, never a
 * hand-maintained array). Every accessor is deterministic for the life of one
 * call: metrics and the limiter snapshot are captured once by the caller.
 */
export function buildRouterEnv(deps: RouterEnvDeps): RouterEnv {
  const apiProviderByName = new Map<string, ApiProviderRuntime>(
    deps.apiProviders.map(p => [p.name, p])
  );
  const providerNames: string[] = [...CLI_TYPES, ...deps.apiProviders.map(p => p.name)];
  const metricsByTool = deps.performanceMetrics.snapshot().byTool as Record<
    string,
    { successRate: number; averageResponseTimeMs: number }
  >;
  // Resolve priors ONCE per build (memoized), so calibrationK is O(1) per candidate.
  const priors = resolvePriors(deps);

  const isAuthed =
    deps.isAuthed ??
    ((provider: string): boolean => {
      // API providers are authed by construction (only enabled ones are listed).
      // CLI providers: optimistic (see module doc); dispatch + reroute enforce it.
      return isCliType(provider) || apiProviderByName.has(provider);
    });

  return {
    providers(): readonly string[] {
      return providerNames;
    },
    models(provider: string): readonly string[] {
      if (isCliType(provider)) {
        return Object.keys(getCliInfo()[provider].models);
      }
      const api = apiProviderByName.get(provider);
      if (!api) return [];
      // Explicit allowlist wins; otherwise the single default model.
      return api.models && api.models.length > 0 ? api.models : [api.defaultModel];
    },
    isAuthed,
    breakerState(provider: string): string {
      return isCliType(provider) ? cliBreakerState(provider) : apiProviderBreakerState(provider);
    },
    atCapacity(provider: string): boolean {
      return providerAtCapacity(deps.limiterSnapshot, provider);
    },
    capabilities(provider: string): CandidateCapabilities {
      return candidateCapabilities(provider);
    },
    modelCost(provider: string, model: string): ModelCost {
      return getModelCost(provider, model, { preferCatalog: deps.preferCatalogPrice });
    },
    successRate(provider: string): number {
      return metricsByTool[provider]?.successRate ?? 0;
    },
    meanLatencyMs(provider: string): number {
      return metricsByTool[provider]?.averageResponseTimeMs ?? 0;
    },
    calibrationK(prompt: string, family: string): number {
      return lookupCalibrationK(priors, classifyContent(prompt), family);
    },
  };
}

/**
 * Project a resolved {@link LeastCostConfig} into the pure router's
 * {@link RouterConfig}. The config loader already merged shipped tier defaults
 * with operator overrides, so this is a shape adaptation only.
 */
export function toRouterConfig(cfg: LeastCostConfig): RouterConfig {
  return {
    minTier: cfg.minTier,
    maxCostUsd: cfg.maxCostUsd,
    defaultExpectedOutputTokens: cfg.defaultExpectedOutputTokens,
    budgetOutputSafetyFactor: cfg.budgetOutputSafetyFactor,
    allowUnpriced: cfg.allowUnpriced,
    tiers: cfg.tiers,
    candidates: cfg.candidates,
    preferenceOrder: cfg.preferenceOrder.length > 0 ? cfg.preferenceOrder : undefined,
  };
}
