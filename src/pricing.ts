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
 * Gemini, Grok, Mistral: pricing varies by model and is not surfaced in
 * gateway today. Returns 0 for unknown.
 */

export interface PricePerMillion {
  inputUsd: number;
  outputUsd: number;
  /** Multiplier on inputUsd for a cache HIT (read). Anthropic: 0.10. */
  cacheReadMultiplier: number;
}

export const PRICING_AS_OF = "2026-05-26";

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
 *
 * Anything outside these explicit matches returns ZERO. This is a
 * deliberate conservative choice — we'd rather under-report savings on
 * an unrecognised model than over-report on one whose actual pricing we
 * don't know. Update this table when a new model family ships.
 */
export function getPricing(
  cli: "claude" | "codex" | "gemini" | "grok" | "mistral",
  model: string
): PricePerMillion {
  const lower = model.toLowerCase();
  if (cli === "claude") {
    if (lower.includes("sonnet")) return ANTHROPIC_SONNET;
    if (lower.includes("opus")) return ANTHROPIC_OPUS;
    if (lower.includes("haiku")) return ANTHROPIC_HAIKU;
    return ZERO;
  }
  if (cli === "codex") {
    if (lower.includes("gpt-5") || lower.includes("o3")) return OPENAI_GPT5;
    return ZERO;
  }
  return ZERO;
}

/**
 * Estimate USD saved by `cacheReadTokens` being served from cache instead
 * of fresh input. Returns 0 for zero cache reads or unknown pricing.
 */
export function estimateCacheSavingsUsd(
  cli: "claude" | "codex" | "gemini" | "grok" | "mistral",
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
