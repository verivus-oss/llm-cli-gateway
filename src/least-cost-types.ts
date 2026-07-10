/**
 * Shared type contract for least-cost routing (LCR).
 *
 * This module is the single seam between the LCR modules (pricing/getModelCost,
 * token-estimator, least-cost-router, and the feedback aggregator). It holds
 * only types, no runtime logic, so every module composes against identical
 * shapes. See docs/least-cost-routing-contract.md and
 * docs/plans/least-cost-routing.draft.md (sections 4.1, 4.1a, 4.2).
 */

/** How a family reports the input/cache-token split (contract decision 8). */
export type AccountingMode = "inclusive" | "disjoint";

/**
 * Which of the three composers produced a cost figure, accuracy descending
 * (contract decision 6).
 */
export type CostBasis = "provider-reported" | "derived-from-tokens" | "pre-flight-estimate";

/** Advisory confidence band for a cost figure (spec 4.2, enhancement 5). */
export type Confidence = "high" | "medium" | "low";

/** Coarse capability tier used as the quality floor (contract decision 12). */
export type QualityTier = "economy" | "standard" | "frontier";

/** Where a price rate came from. `unknown` is a hard eligibility signal. */
export type PriceSource = "table" | "api-catalog" | "unknown";

/**
 * Per-candidate cost rates with explicit provenance. Produced by getModelCost
 * (src/pricing.ts). Prices the RESOLVED model family, never the CLI brand.
 */
export interface ModelCost {
  /** Input rate, USD per million tokens. */
  inputUsdPerMTok: number;
  /** Output rate, USD per million tokens (first-class, unlike getPricing). */
  outputUsdPerMTok: number;
  /** Cache-read discount factor (0..1) applied to the input rate. */
  cacheReadMultiplier: number;
  /** Cache-creation rate, USD per million tokens (default = input; Anthropic ~1.25x). */
  cacheWriteUsdPerMTok: number;
  /** How input/cache counts split for this family (contract decision 8). */
  accountingMode: AccountingMode;
  /** Resolved pricing family (from modelIdToFamily), CLI-agnostic. */
  family: string;
  /** Provenance of the rate. `unknown` => router excludes the candidate. */
  source: PriceSource;
  /** PRICING_AS_OF or a per-catalog refresh timestamp. */
  asOf: string;
}

/**
 * Provider-reported token counts captured post-hoc by a parser / the flight
 * recorder. All optional beyond input/output; a null value means "not reported".
 * `reportedCostUsd` present => the provider gave a dollar cost (T1).
 */
export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from cache (billed per accountingMode). */
  cacheReadTokens?: number;
  /** Tokens written to cache (cache creation). */
  cacheCreationTokens?: number;
  /** Hidden reasoning/thinking tokens billed as output (e.g. grok ACP _meta). */
  reasoningTokens?: number;
  /** A provider-reported dollar cost, when present (T1 providers). */
  reportedCostUsd?: number;
}

/**
 * Pre-flight token estimate for a request, produced by src/token-estimator.ts.
 * `estInputTokens` is the WHOLE-PROMPT input estimate; composeCost converts it
 * per accountingMode (spec 4.2).
 */
export interface TokenEstimate {
  estInputTokens: number;
  estOutputTokens: number;
  /** Estimated cache-read subset of the input (from caller cache markers). */
  estCacheReadTokens?: number;
  /** Estimated cache-write (creation) tokens. */
  estCacheWriteTokens?: number;
}

/** The output of composeCost: a cost figure with its basis and confidence. */
export interface CostResult {
  costUsd: number;
  cost_basis: CostBasis;
  confidence: Confidence;
}
