/**
 * Per-model pricing for cache-savings estimation.
 *
 * `priced_as_of` is the date these numbers were last refreshed. The
 * gateway's doctor surfaces this so operators can see when the table is
 * stale — pricing is an ESTIMATE, not a billing number.
 *
 * Pricing units: USD per 1M tokens.
 *
 * Anthropic source: <https://platform.claude.com/docs/en/about-claude/pricing>
 *   - Sonnet 4.x / Sonnet 3.5: $3 input / $15 output.
 *   - Opus 4.5+ / Mythos Preview: $15 input / $75 output.
 *   - Opus 4 / 4.1 (deprecated): same as 4.5+.
 *   - Haiku 4.5: $1 input / $5 output.
 *   - Haiku 3.5 (Vertex-only): $0.80 input / $4 output.
 *
 * Cache pricing multipliers (Anthropic):
 *   - cache write 5-min TTL: 1.25× base input.
 *   - cache write 1-hour TTL: 2× base input.
 *   - cache read: 0.10× base input (90% savings).
 *
 * Codex / OpenAI: GPT-5.4 input ~$1.25 / output $10 per 1M (approx; OpenAI
 * does not publish a stable per-CLI table). Cached input ~50% of base.
 *
 * Gemini (source: <https://ai.google.dev/gemini-api/docs/pricing>, ≤200k tier):
 *   - 2.5 Pro: $1.25 input / $10 output; cached input $0.125 (0.10× = 90% off).
 *   - 2.5 Flash: $0.30 / $2.50; cached input $0.03 (0.10×).
 *   - 3 Pro Preview: $2.00 / $12; cached input $0.20 (0.10×).
 *   Google bills cached (context-cache read) tokens at 10% of input across the
 *   family, so cacheReadMultiplier = 0.10.
 *
 * Grok / xAI (source: <https://docs.x.ai/developers/models/grok-4.3> and
 * <https://docs.x.ai/developers/models/grok-build-0.1>):
 *   - grok-4.x flagship: $1.25 input / $2.50 output; cached input $0.20 (0.16×).
 *     The grok-4-fast / grok-4.20 / grok-3 names are flagship aliases at the
 *     same rate per xAI's model pages.
 *   - grok-build-0.1 (coding CLI model; aliases grok-code-fast-*): $1.00 / $2.00;
 *     cached input $0.20 (0.20×).
 *
 * Mistral (source: <https://mistral.ai/pricing/>):
 *   - Medium 3.5: $1.50 input / $7.50 output.
 *   - Devstral Small: $0.10 / $0.30.
 *   Mistral lists cache-read at ~10% of input (Medium 3 cached $0.04 on $0.40
 *   input), so cacheReadMultiplier = 0.10. NOTE: Vibe emits no cache fields
 *   today, so Mistral cache savings stay $0 regardless — this entry is
 *   forward-looking and prices fresh input/output only.
 *
 * Forward-looking caveat: Gemini (Antigravity text-only output) and Grok-CLI
 * cache telemetry are not yet extracted, so non-zero cache savings for those
 * providers only appear once their token extraction lands (#44). These entries
 * make the pricing correct in advance so savings are no longer hard-zeroed.
 */

import type { CliType } from "./provider-types.js";
import type {
  ModelCost,
  TokenCounts,
  TokenEstimate,
  CostResult,
  AccountingMode,
} from "./least-cost-types.js";

export interface PricePerMillion {
  inputUsd: number;
  outputUsd: number;
  /** Multiplier on inputUsd for a cache HIT (read). Anthropic: 0.10. */
  cacheReadMultiplier: number;
}

export const PRICING_AS_OF = "2026-06-13";

const ANTHROPIC_SONNET: PricePerMillion = {
  inputUsd: 3,
  outputUsd: 15,
  cacheReadMultiplier: 0.1,
};
const ANTHROPIC_OPUS: PricePerMillion = {
  inputUsd: 15,
  outputUsd: 75,
  cacheReadMultiplier: 0.1,
};
const ANTHROPIC_HAIKU: PricePerMillion = {
  inputUsd: 1,
  outputUsd: 5,
  cacheReadMultiplier: 0.1,
};
const OPENAI_GPT5: PricePerMillion = {
  inputUsd: 1.25,
  outputUsd: 10,
  // OpenAI prompt-caching: cached input tokens billed at 50% of base.
  cacheReadMultiplier: 0.5,
};

// Gemini — Google bills context-cache reads at 10% of input across the family.
const GEMINI_25_PRO: PricePerMillion = {
  inputUsd: 1.25,
  outputUsd: 10,
  cacheReadMultiplier: 0.1,
};
const GEMINI_FLASH: PricePerMillion = {
  inputUsd: 0.3,
  outputUsd: 2.5,
  cacheReadMultiplier: 0.1,
};
const GEMINI_3_PRO: PricePerMillion = {
  inputUsd: 2,
  outputUsd: 12,
  cacheReadMultiplier: 0.1,
};

// Grok — xAI publishes cached input rates per model: flagship $0.20 on $1.25
// base (0.16×); grok-build $0.20 on $1.00 base (0.20×).
const GROK_4: PricePerMillion = {
  inputUsd: 1.25,
  outputUsd: 2.5,
  cacheReadMultiplier: 0.16,
};
const GROK_BUILD: PricePerMillion = {
  inputUsd: 1,
  outputUsd: 2,
  cacheReadMultiplier: 0.2,
};

// Mistral — cache-read ~10% of input. Vibe emits no cache fields today, so the
// multiplier is forward-looking; input/output are billed as listed.
const MISTRAL_MEDIUM: PricePerMillion = {
  inputUsd: 1.5,
  outputUsd: 7.5,
  cacheReadMultiplier: 0.1,
};
const MISTRAL_DEVSTRAL: PricePerMillion = {
  inputUsd: 0.1,
  outputUsd: 0.3,
  cacheReadMultiplier: 0.1,
};

const ZERO: PricePerMillion = {
  inputUsd: 0,
  outputUsd: 0,
  cacheReadMultiplier: 0,
};

/**
 * Look up pricing by (cli, model) name. Best-effort; unknown models return
 * ZEROED pricing so estimated_savings_usd in aggregates falls back to 0
 * rather than throwing OR over-reporting savings on an unpriced model.
 *
 * Recognised model families:
 *   - claude: model name contains "sonnet" | "opus" | "haiku".
 *   - codex: model name contains "gpt-5" or "o3" (current OpenAI families).
 *   - gemini: standard generative tiers only — any "lite"/"image"/"audio"/"tts"
 *     specialty variant is excluded first; then 2.5 Flash → 2.5 Flash, 2.5 Pro →
 *     2.5 Pro, "gemini-3" + "pro" → 3 Pro.
 *   - grok: "grok-build"/"grok-code" → grok-build; "grok-4"/"grok-3"/
 *     "grok-latest" → grok-4.x flagship (grok-3 redirects to grok-4.3 pricing).
 *   - mistral: "devstral-small" → Devstral Small; "mistral-medium-3.5" → Medium
 *     3.5 (NOT the cheaper legacy medium-3, nor floating "-latest").
 *
 * Matches are deliberately PRECISE (version-anchored), not loose substrings: a
 * loose `includes("flash")`/`includes("mistral-medium")` would mis-price a
 * cheaper variant (flash-lite, medium-3) at a pricier tier and OVER-report
 * savings. We never want that.
 *
 * Conversely, any non-flagship model we have NOT added a verified rate for —
 * gen-3 Flash, Gemini Flash-Lite, Mistral Small/Large/Codestral, the legacy
 * medium-3, and bare "default" rows — returns ZERO. This intentionally scopes
 * the table to the families these CLIs actually run by default; it mirrors the
 * pre-existing codex policy (non-gpt-5/o3 OpenAI models also return ZERO). ZERO
 * UNDER-reports (safe) and is preferred over guessing a rate for a model that
 * either won't appear or whose price we have not primary-sourced. Add an entry
 * when a new default ships.
 *
 * Claude is the one exception: an unknown / empty / "default" claude model
 * name falls back to the Sonnet family. The gateway logs claude cache rows
 * as `resolvedModel || "default"`, so unresolved rows carry the literal
 * model "default" (and other Claude Code aliases never contain a family
 * keyword). Returning ZERO for those silently zeroes claude cache savings —
 * Claude Code's default model is Sonnet, so Sonnet pricing is the correct,
 * non-zero estimate. Update this table when a new model family ships.
 */
export function getPricing(cli: CliType, model: string): PricePerMillion {
  const lower = model.toLowerCase();
  if (cli === "claude") {
    if (lower.includes("sonnet")) return ANTHROPIC_SONNET;
    if (lower.includes("opus")) return ANTHROPIC_OPUS;
    if (lower.includes("haiku")) return ANTHROPIC_HAIKU;
    // Unknown / "default" / empty claude model → Sonnet (Claude Code's
    // default tier). A reasonable non-zero estimate beats silently
    // zeroing savings for the most common, family-less row shape.
    return ANTHROPIC_SONNET;
  }
  if (cli === "codex") {
    if (lower.includes("gpt-5") || lower.includes("o3")) return OPENAI_GPT5;
    return ZERO;
  }
  if (cli === "gemini") {
    // Specialty / non-standard tiers carry DIFFERENT rates from the standard
    // generative Flash/Pro tiers the agy CLI uses (flash-lite $0.10/$0.40;
    // 2.5-pro-preview-tts $1.00/$20; flash-image and native-audio have their own
    // per-modality pricing). Gate them out so they fall through to ZERO instead
    // of inheriting a standard tier's price. gen-3 Flash and bare aliases
    // ("flash"/"pro") are also ZERO: no verified current rate, and gemini cache
    // telemetry is upstream-blocked regardless.
    const specialtyVariant =
      lower.includes("lite") ||
      lower.includes("image") ||
      lower.includes("audio") ||
      lower.includes("tts");
    if (!specialtyVariant) {
      if (lower.includes("2.5-flash")) return GEMINI_FLASH;
      if (lower.includes("2.5-pro")) return GEMINI_25_PRO;
      if (lower.includes("gemini-3") && lower.includes("pro")) return GEMINI_3_PRO;
    }
    return ZERO;
  }
  if (cli === "grok") {
    if (lower.includes("grok-build") || lower.includes("grok-code")) return GROK_BUILD;
    // grok-4.x AND the grok-3 / grok-latest slugs, which xAI now bills at the
    // grok-4.3 flagship rate (grok-3 redirected to grok-4.3 after 2026-05-15).
    if (lower.includes("grok-4") || lower.includes("grok-3") || lower.includes("grok-latest")) {
      return GROK_4;
    }
    return ZERO;
  }
  if (cli === "mistral") {
    if (lower.includes("devstral-small")) return MISTRAL_DEVSTRAL;
    // Anchor to Medium 3.5 specifically — the legacy "mistral-medium-3"
    // ($0.40/$2.00) and "mistral-medium-latest" (floating) must NOT inherit
    // 3.5's $1.50/$7.50; they fall through to ZERO.
    if (lower.includes("mistral-medium-3.5")) return MISTRAL_MEDIUM;
    return ZERO;
  }
  return ZERO;
}

/**
 * Estimate USD saved by `cacheReadTokens` being served from cache instead
 * of fresh input. Returns 0 for zero cache reads or unknown pricing.
 */
export function estimateCacheSavingsUsd(
  cli: CliType,
  model: string,
  cacheReadTokens: number
): number {
  if (cacheReadTokens <= 0) return 0;
  const p = getPricing(cli, model);
  if (p.inputUsd === 0) return 0;
  // Savings = (fresh-input-cost) - (cache-read-cost) = inputUsd × (1 - mult)
  const savedPerToken = (p.inputUsd * (1 - p.cacheReadMultiplier)) / 1_000_000;
  return cacheReadTokens * savedPerToken;
}

// ---------------------------------------------------------------------------
// Least-cost-routing (LCR) accessors: router-only, additive.
//
// These sit BESIDE getPricing and share its rate constants (DRY: one price
// table). Unlike getPricing (whose ZERO-for-unknown / claude-default-to-Sonnet
// semantics are load-bearing for the cache-savings path and stay untouched),
// the router surface treats an unresolved family as `source: "unknown"` so an
// unpriced candidate can never look free and win a route (contract decision 5).
// See docs/least-cost-routing-contract.md and least-cost-routing.draft.md
// (sections 4.1, 4.1a, 4.2).
// ---------------------------------------------------------------------------

/**
 * Map a concrete model id / alias to a CLI-agnostic pricing family string, or
 * "unknown" when nothing matches. This is how cursor-agent and devin (which
 * have NO brand branch in getPricing but run claude/gpt/gemini/... models) get
 * priced by the family they actually run (contract decision 4).
 *
 * Matches mirror getPricing's PRECISE, version-anchored rules so a cheaper
 * variant (gemini flash-lite, legacy mistral-medium-3) never inherits a pricier
 * tier. Anthropic (sonnet/opus/haiku) and OpenAI (gpt-5/o3) are matched by
 * family keyword so a cross-brand run resolves regardless of the invoking CLI.
 */
export function modelIdToFamily(model: string): string {
  const lower = model.toLowerCase();

  // Anthropic / Claude family (also what devin, and cursor-agent --model, run).
  if (lower.includes("sonnet")) return "claude-sonnet";
  if (lower.includes("opus")) return "claude-opus";
  if (lower.includes("haiku")) return "claude-haiku";

  // OpenAI / GPT family (codex, and cursor-agent --model gpt-*).
  if (lower.includes("gpt-5") || lower.includes("o3")) return "openai-gpt5";

  // Gemini family. Specialty tiers (flash-lite / image / audio / tts) carry
  // different rates, so gate them out first (they fall through to "unknown")
  // rather than inheriting a standard tier's price (mirrors getPricing).
  const geminiSpecialty =
    lower.includes("lite") ||
    lower.includes("image") ||
    lower.includes("audio") ||
    lower.includes("tts");
  if (!geminiSpecialty) {
    if (lower.includes("2.5-flash")) return "gemini-2.5-flash";
    if (lower.includes("2.5-pro")) return "gemini-2.5-pro";
    if (lower.includes("gemini-3") && lower.includes("pro")) return "gemini-3-pro";
  }

  // Grok family. grok-build / grok-code (cheaper coding tier) before flagship.
  // `grok-build` stays: the xAI HTTP API still exposes grok-build-0.1, even
  // though the Grok CLI dropped the bare `grok-build` id at 0.2.99.
  if (lower.includes("grok-build") || lower.includes("grok-code")) return "grok-build";
  // grok-4.5 (the Grok CLI 0.2.99 default) resolves here via the grok-4 match.
  if (lower.includes("grok-4") || lower.includes("grok-3") || lower.includes("grok-latest")) {
    return "grok-4";
  }
  // grok-composer-2.5-fast (Grok CLI 0.2.99) is DELIBERATELY unpriced: xAI
  // publishes no rate for it, and inventing one would silently corrupt cost
  // telemetry and let a made-up price win a route. It falls through to
  // "unknown", which fails closed by design (contract decision 5: unpriced
  // candidates are excluded from routing, never treated as free). Add a family
  // + rate here only once a published rate exists.

  // Mistral family. Version-anchored so legacy medium-3 / -latest do not
  // inherit Medium 3.5's rate.
  if (lower.includes("devstral-small")) return "mistral-devstral";
  if (lower.includes("mistral-medium-3.5")) return "mistral-medium";

  return "unknown";
}

// Resolved-family to rate constant. Reuses the SAME PricePerMillion constants
// getPricing uses (no second price map, no new numbers).
const FAMILY_PRICING = new Map<string, PricePerMillion>([
  ["claude-sonnet", ANTHROPIC_SONNET],
  ["claude-opus", ANTHROPIC_OPUS],
  ["claude-haiku", ANTHROPIC_HAIKU],
  ["openai-gpt5", OPENAI_GPT5],
  ["gemini-2.5-pro", GEMINI_25_PRO],
  ["gemini-2.5-flash", GEMINI_FLASH],
  ["gemini-3-pro", GEMINI_3_PRO],
  ["grok-4", GROK_4],
  ["grok-build", GROK_BUILD],
  ["mistral-medium", MISTRAL_MEDIUM],
  ["mistral-devstral", MISTRAL_DEVSTRAL],
]);

// ---------------------------------------------------------------------------
// API-provider published catalog (phase_2, DAG step api-catalog-pricing).
//
// OpenRouter (`/models` prompt/completion prices) and xAI publish PER-TOKEN
// rates directly, so an API-provider candidate is priced from this catalog with
// `source: "api-catalog"` rather than the CLI family table. This is a CURATED
// static snapshot with its own asOf (mirroring the table); a periodic live
// `/models` fetch is a deferred open question, NOT this phase. The forbidden
// direction (splitting a reported scalar `costUsd` into rates) never appears:
// these are published per-token rates, used as-is.
//
// Keyed by the LOWERCASED model id the API provider serves (OpenRouter uses
// "vendor/model" slugs; xAI uses bare model ids). CLI model aliases (sonnet,
// gpt-5.5, ...) are not catalog keys, so a CLI candidate never resolves here.
// ---------------------------------------------------------------------------

export const API_CATALOG_AS_OF = "2026-07-11";

/** A published per-token rate for an API-provider model (USD per 1M tokens). */
export interface ApiCatalogEntry {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  /** Multiplier on input for a cache-read hit; 0 when the vendor bills no discount. */
  cacheReadMultiplier: number;
  /** How input/cache split for this model (spec 4.1a). Default inclusive. */
  accountingMode?: AccountingMode;
  /** Resolved pricing family label for prior/calibration bucketing (optional). */
  family?: string;
}

export type ApiCatalog = ReadonlyMap<string, ApiCatalogEntry>;

// Curated snapshot. Extend as providers/models are added; every entry is a
// vendor-published per-token rate, never a decomposed total. Anthropic-served
// models are disjoint; OpenAI/Google/xAI are inclusive.
export const API_CATALOG: ApiCatalog = new Map<string, ApiCatalogEntry>([
  // OpenRouter "vendor/model" slugs.
  [
    "openai/gpt-5.5",
    {
      inputUsdPerMTok: 1.25,
      outputUsdPerMTok: 10,
      cacheReadMultiplier: 0.5,
      family: "openai-gpt5",
    },
  ],
  [
    "anthropic/claude-sonnet-4.5",
    {
      inputUsdPerMTok: 3,
      outputUsdPerMTok: 15,
      cacheReadMultiplier: 0.1,
      accountingMode: "disjoint",
      family: "claude-sonnet",
    },
  ],
  [
    "google/gemini-2.5-flash",
    {
      inputUsdPerMTok: 0.3,
      outputUsdPerMTok: 2.5,
      cacheReadMultiplier: 0.1,
      family: "gemini-2.5-flash",
    },
  ],
  // xAI published rates (bare model ids served by the xai-responses provider).
  [
    "grok-build-0.1",
    { inputUsdPerMTok: 1, outputUsdPerMTok: 2, cacheReadMultiplier: 0.2, family: "grok-build" },
  ],
  [
    "grok-4",
    { inputUsdPerMTok: 1.25, outputUsdPerMTok: 2.5, cacheReadMultiplier: 0.16, family: "grok-4" },
  ],
]);

function tableModelCost(family: string, rate: PricePerMillion): ModelCost {
  const accountingMode: AccountingMode = family.startsWith("claude-") ? "disjoint" : "inclusive";
  return {
    inputUsdPerMTok: rate.inputUsd,
    outputUsdPerMTok: rate.outputUsd,
    cacheReadMultiplier: rate.cacheReadMultiplier,
    // Default cache-write to the input rate (see doc note above).
    cacheWriteUsdPerMTok: rate.inputUsd,
    accountingMode,
    family,
    source: "table",
    asOf: PRICING_AS_OF,
  };
}

function catalogModelCost(model: string, entry: ApiCatalogEntry): ModelCost {
  const family = entry.family ?? modelIdToFamily(model);
  return {
    inputUsdPerMTok: entry.inputUsdPerMTok,
    outputUsdPerMTok: entry.outputUsdPerMTok,
    cacheReadMultiplier: entry.cacheReadMultiplier,
    // Published catalogs list input/output/cache-read but not a separate
    // cache-write rate, so default it to input (parity with the table path).
    cacheWriteUsdPerMTok: entry.inputUsdPerMTok,
    accountingMode: entry.accountingMode ?? "inclusive",
    family: family === "unknown" ? model.toLowerCase() : family,
    source: "api-catalog",
    asOf: API_CATALOG_AS_OF,
  };
}

const UNKNOWN_MODEL_COST: ModelCost = {
  inputUsdPerMTok: 0,
  outputUsdPerMTok: 0,
  cacheReadMultiplier: 0,
  cacheWriteUsdPerMTok: 0,
  accountingMode: "inclusive",
  family: "unknown",
  source: "unknown",
  asOf: PRICING_AS_OF,
};

/**
 * Router-only per-candidate cost accessor built beside getPricing. Two price
 * sources: the CLI family table (priced by resolved model family, contract
 * decision 4) and, for API-provider models, the published api-catalog
 * (`API_CATALOG`). When a model resolves in BOTH, `preferCatalog` (config
 * `prefer_catalog_price`, default true) decides which wins; otherwise whichever
 * is present is used.
 *
 * accountingMode is "disjoint" for the claude/anthropic family (input_tokens is
 * fresh-only, cache read is billed) and "inclusive" otherwise (spec 4.1a).
 * cacheWriteUsdPerMTok defaults to the input rate (the rate sources do not carry
 * a separate cache-creation number yet).
 *
 * An unresolved model returns `source: "unknown"` with zeroed rates so the
 * router EXCLUDES the candidate (contract decision 5). This deliberately does
 * NOT inherit getPricing's ZERO-that-looks-free behaviour. NEVER derives rates
 * from a scalar total (contract decision 7).
 */
export function getModelCost(
  provider: string,
  model: string,
  opts?: { catalog?: ApiCatalog; preferCatalog?: boolean }
): ModelCost {
  const catalog = opts?.catalog ?? API_CATALOG;
  const preferCatalog = opts?.preferCatalog ?? true;
  const catalogEntry = catalog.get(model.toLowerCase());
  const family = modelIdToFamily(model);
  const familyRate = FAMILY_PRICING.get(family);

  // Catalog wins when preferred (default) or when it is the only source.
  if (catalogEntry !== undefined && (preferCatalog || familyRate === undefined)) {
    return catalogModelCost(model, catalogEntry);
  }
  if (familyRate !== undefined) {
    return tableModelCost(family, familyRate);
  }
  // Model in neither catalog nor table.
  return { ...UNKNOWN_MODEL_COST };
}

/**
 * Compose a total cost from token counts (or an estimate) and per-token rates,
 * branching on accountingMode. This is the ONE place the inclusive-vs-disjoint
 * arithmetic lives, so both the derive path (reported counts) and the
 * rank/budget path (estimated counts) share an identical mode branch and it can
 * never drift (contract decision 8).
 *
 * `inputIsWholePrompt` distinguishes the two input conventions: a reported
 * disjoint (Anthropic) count already carries FRESH-only input, whereas a
 * pre-flight estimate's estInputTokens is the WHOLE prompt and must have the
 * cache subsets removed to recover fresh (spec 4.2). Inclusive families treat
 * input as already including the cache-read subset in both conventions.
 */
function composeTotalUsd(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  reasoningTokens: number,
  modelCost: ModelCost,
  inputIsWholePrompt: boolean
): number {
  const M = 1_000_000;
  const { inputUsdPerMTok, outputUsdPerMTok, cacheWriteUsdPerMTok, cacheReadMultiplier } =
    modelCost;
  // Reasoning/thinking tokens are billed at the output rate (spec 4.1a).
  const outputCost = ((outputTokens + reasoningTokens) * outputUsdPerMTok) / M;
  const cacheWriteCost = (cacheWriteTokens * cacheWriteUsdPerMTok) / M;

  if (modelCost.accountingMode === "disjoint") {
    // Anthropic-style: fresh input billed at base, cache read BILLED at the
    // discounted rate (not subtracted). Reported input_tokens is already
    // fresh-only; a whole-prompt estimate removes the cache subsets.
    const freshTokens = inputIsWholePrompt
      ? inputTokens - cacheReadTokens - cacheWriteTokens
      : inputTokens;
    const freshCost = (freshTokens * inputUsdPerMTok) / M;
    const cacheReadCost = (cacheReadTokens * inputUsdPerMTok * cacheReadMultiplier) / M;
    return freshCost + cacheWriteCost + cacheReadCost + outputCost;
  }

  // inclusive (OpenAI-style): input already INCLUDES the cache-read subset in
  // both conventions, so the cache read is a DISCOUNT off the base.
  const baseCost = (inputTokens * inputUsdPerMTok) / M;
  const cacheReadDiscount = (cacheReadTokens * inputUsdPerMTok * (1 - cacheReadMultiplier)) / M;
  return baseCost + cacheWriteCost + outputCost - cacheReadDiscount;
}

/**
 * The SINGLE pure composer for a candidate's cost, used for BOTH derive
 * (reported counts) and rank/budget (estimated counts). Precedence, accuracy
 * descending (spec 4.1a / contract decision 6):
 *
 *   1. provider-reported: a dollar cost was reported, use it verbatim (high).
 *   2. derived-from-tokens: real counts x known rates, per accountingMode, when
 *      the rate is known (source != "unknown") (high).
 *   3. pre-flight-estimate: estimated counts x rates; the fallback when no
 *      counts were reported OR the rate is unknown (low).
 *
 * Never decomposes a scalar total into rates (contract decision 7).
 */
export function composeCost(
  counts: TokenCounts | null,
  estimate: TokenEstimate,
  modelCost: ModelCost
): CostResult {
  // 1. Provider-reported dollar cost is trusted verbatim, regardless of whether
  //    a table/catalog rate is known for the family.
  if (counts?.reportedCostUsd != null) {
    return {
      costUsd: counts.reportedCostUsd,
      cost_basis: "provider-reported",
      confidence: "high",
    };
  }

  // 2. Derive from reported token counts when we have a known rate.
  if (counts != null && modelCost.source !== "unknown") {
    const costUsd = composeTotalUsd(
      counts.inputTokens,
      counts.outputTokens,
      counts.cacheReadTokens ?? 0,
      counts.cacheCreationTokens ?? 0,
      counts.reasoningTokens ?? 0,
      modelCost,
      false
    );
    return { costUsd, cost_basis: "derived-from-tokens", confidence: "high" };
  }

  // 3. Pre-flight estimate: no counts, or an unknown rate. Least accurate; the
  //    estimate's estInputTokens is the WHOLE prompt (inputIsWholePrompt=true).
  const costUsd = composeTotalUsd(
    estimate.estInputTokens,
    estimate.estOutputTokens,
    estimate.estCacheReadTokens ?? 0,
    estimate.estCacheWriteTokens ?? 0,
    0,
    modelCost,
    true
  );
  return { costUsd, cost_basis: "pre-flight-estimate", confidence: "low" };
}
