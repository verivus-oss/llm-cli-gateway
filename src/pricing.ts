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
