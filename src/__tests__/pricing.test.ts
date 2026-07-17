import { describe, it, expect } from "vitest";
import {
  getPricing,
  estimateCacheSavingsUsd,
  PRICING_AS_OF,
  modelIdToFamily,
  getModelCost,
  composeCost,
} from "../pricing.js";
import type { TokenCounts, TokenEstimate } from "../least-cost-types.js";

describe("pricing", () => {
  it("PRICING_AS_OF is a recent ISO-ish date string", () => {
    expect(PRICING_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  describe("getPricing — recognised families", () => {
    it("claude sonnet variants → ANTHROPIC_SONNET pricing", () => {
      expect(getPricing("claude", "claude-sonnet-4-5").inputUsd).toBe(3);
      expect(getPricing("claude", "claude-3-5-sonnet-20241022").inputUsd).toBe(3);
    });
    it("claude opus variants → ANTHROPIC_OPUS pricing", () => {
      expect(getPricing("claude", "claude-opus-4-7").inputUsd).toBe(15);
    });
    it("claude haiku variants → ANTHROPIC_HAIKU pricing", () => {
      expect(getPricing("claude", "claude-haiku-4-5").inputUsd).toBe(1);
    });
    it("codex gpt-5.x → OPENAI_GPT5 pricing", () => {
      expect(getPricing("codex", "gpt-5.4").inputUsd).toBe(1.25);
      expect(getPricing("codex", "openai/gpt-5-mini").inputUsd).toBe(1.25);
    });
    it("codex o3 → OPENAI_GPT5 pricing (treated as same tier today)", () => {
      expect(getPricing("codex", "o3-2025-01-31").inputUsd).toBe(1.25);
    });
  });

  describe("getPricing — claude unknown family falls back to Sonnet", () => {
    // Claude Code logs cache rows as `resolvedModel || "default"`, so most
    // claude rows carry a family-less model name. Returning ZERO there
    // silently zeroes claude cache savings; Sonnet (Claude Code's default
    // tier) is the correct non-zero estimate.
    it("claude with unknown family → Sonnet pricing", () => {
      const p = getPricing("claude", "claude-mystery-1");
      expect(p.inputUsd).toBe(3);
      expect(p.outputUsd).toBe(15);
      expect(p.cacheReadMultiplier).toBe(0.1);
    });
    it('claude "default" model → Sonnet pricing (the common logged shape)', () => {
      expect(getPricing("claude", "default").inputUsd).toBe(3);
    });
    it("claude with empty model → Sonnet pricing", () => {
      expect(getPricing("claude", "").inputUsd).toBe(3);
    });
  });

  describe("getPricing — gemini / grok / mistral families (#44)", () => {
    it("gemini 2.5 flash → 2.5 Flash pricing ($0.30 / $2.50, 0.10× cache)", () => {
      const p = getPricing("gemini", "gemini-2.5-flash");
      expect(p.inputUsd).toBe(0.3);
      expect(p.outputUsd).toBe(2.5);
      expect(p.cacheReadMultiplier).toBe(0.1);
    });
    it("gemini 2.5 pro → 2.5 Pro pricing ($1.25 / $10)", () => {
      expect(getPricing("gemini", "gemini-2.5-pro").inputUsd).toBe(1.25);
      expect(getPricing("gemini", "gemini-2.5-pro").outputUsd).toBe(10);
    });
    it("gemini 3 pro preview → 3 Pro pricing ($2.00 / $12)", () => {
      const p = getPricing("gemini", "gemini-3-pro-preview");
      expect(p.inputUsd).toBe(2);
      expect(p.outputUsd).toBe(12);
    });
    it("grok-build (and grok-code-* aliases) → grok-build pricing ($1.00 / $2.00, 0.20× cache)", () => {
      const p = getPricing("grok", "grok-build");
      expect(p.inputUsd).toBe(1);
      expect(p.outputUsd).toBe(2);
      expect(p.cacheReadMultiplier).toBe(0.2);
      // grok-code-fast-1 etc. are grok-build aliases (no "build" substring).
      expect(getPricing("grok", "grok-code-fast-1").inputUsd).toBe(1);
    });
    it("grok-4.x flagship + grok-3/grok-latest aliases → grok-4 pricing ($1.25 / $2.50)", () => {
      expect(getPricing("grok", "grok-4-fast").inputUsd).toBe(1.25);
      expect(getPricing("grok", "grok-4.3").outputUsd).toBe(2.5);
      expect(getPricing("grok", "grok-4.3").cacheReadMultiplier).toBe(0.16);
      // grok-3 / grok-latest redirect to grok-4.3 pricing (xAI, post 2026-05-15).
      expect(getPricing("grok", "grok-3").inputUsd).toBe(1.25);
      expect(getPricing("grok", "grok-3-mini").inputUsd).toBe(1.25);
      expect(getPricing("grok", "grok-latest").inputUsd).toBe(1.25);
    });
    it("grok-4.5 → its own pricing ($2.00 / $6.00, 0.25x cache), never the grok-4.3 rate", () => {
      const p = getPricing("grok", "grok-4.5");
      expect(p.inputUsd).toBe(2);
      expect(p.outputUsd).toBe(6);
      expect(p.cacheReadMultiplier).toBe(0.25);
      // The bug this guards: "grok-4.5" contains "grok-4", so an ordering slip
      // silently bills the Grok CLI's DEFAULT model at grok-4.3's cheaper rate.
      expect(p.inputUsd).not.toBe(1.25);
      expect(p.outputUsd).not.toBe(2.5);
      // The neighbouring flagship rate must not move with it.
      expect(getPricing("grok", "grok-4.3").inputUsd).toBe(1.25);
      expect(getPricing("grok", "grok-4.20-0309-reasoning").inputUsd).toBe(1.25);
      expect(modelIdToFamily("grok-4.5")).toBe("grok-4.5");
      expect(modelIdToFamily("grok-4.3")).toBe("grok-4");
    });
    it("mistral medium-3.5 → Medium pricing ($1.50 / $7.50)", () => {
      const p = getPricing("mistral", "mistral-medium-3.5");
      expect(p.inputUsd).toBe(1.5);
      expect(p.outputUsd).toBe(7.5);
    });
    it("mistral devstral-small → Devstral Small pricing ($0.10 / $0.30)", () => {
      expect(getPricing("mistral", "devstral-small").inputUsd).toBe(0.1);
    });
  });

  describe("getPricing — precise matching: related-but-differently-priced models are NOT mis-priced", () => {
    // Loose substring matching would over/under-report these; they must be ZERO
    // until a verified rate is added (conservative).
    it("gen-3 Flash is NOT priced as 2.5 Flash → ZERO", () => {
      expect(getPricing("gemini", "gemini-3-flash-preview").inputUsd).toBe(0);
      expect(getPricing("gemini", "gemini-3.0-flash-preview").inputUsd).toBe(0);
    });
    it("Gemini specialty variants (flash-lite / image / audio / pro-tts) are NOT priced as a standard tier → ZERO", () => {
      // Cheaper / differently-priced tiers must not inherit a standard rate.
      expect(getPricing("gemini", "gemini-2.5-flash-lite").inputUsd).toBe(0);
      expect(getPricing("gemini", "gemini-2.5-flash-lite-preview-09-2025").inputUsd).toBe(0);
      expect(getPricing("gemini", "gemini-2.5-flash-image").inputUsd).toBe(0);
      expect(getPricing("gemini", "gemini-2.5-flash-native-audio-preview").inputUsd).toBe(0);
      // 2.5-pro-preview-tts is $1.00/$20, NOT 2.5 Pro's $1.25/$10.
      expect(getPricing("gemini", "gemini-2.5-pro-preview-tts").inputUsd).toBe(0);
    });
    it("legacy mistral-medium-3 is NOT priced as medium-3.5 → ZERO", () => {
      // medium-3 is $0.40/$2.00; must not inherit 3.5's $1.50/$7.50.
      expect(getPricing("mistral", "mistral-medium-3").inputUsd).toBe(0);
      expect(getPricing("mistral", "mistral-medium-latest").inputUsd).toBe(0);
    });
    it("bare gemini aliases ('flash'/'pro') → ZERO (not version-anchored)", () => {
      expect(getPricing("gemini", "flash").inputUsd).toBe(0);
      expect(getPricing("gemini", "pro").inputUsd).toBe(0);
    });
    it("Mistral Small / Large / Codestral are NOT priced as Medium → ZERO", () => {
      expect(getPricing("mistral", "mistral-small-latest").inputUsd).toBe(0);
      expect(getPricing("mistral", "mistral-large-latest").inputUsd).toBe(0);
      expect(getPricing("mistral", "codestral-latest").inputUsd).toBe(0);
      // devstral-medium is a distinct, pricier model — not Devstral Small.
      expect(getPricing("mistral", "devstral-medium-latest").inputUsd).toBe(0);
    });
    it("unknown grok slug → ZERO (no verified rate)", () => {
      expect(getPricing("grok", "some-future-xai-model").inputUsd).toBe(0);
    });
  });

  describe("getPricing — non-claude unknown / default models return ZERO (no over-reporting)", () => {
    it("codex with unknown OpenAI family → zero", () => {
      expect(getPricing("codex", "davinci-002").inputUsd).toBe(0);
      expect(getPricing("codex", "future-model-7").inputUsd).toBe(0);
    });
    it("bare 'default' rows for gemini / grok / mistral → zero (conservative)", () => {
      expect(getPricing("gemini", "default").inputUsd).toBe(0);
      expect(getPricing("grok", "default").inputUsd).toBe(0);
      expect(getPricing("mistral", "default").inputUsd).toBe(0);
    });
    it("magistral does not collide with the 'mistral-medium' match → zero", () => {
      expect(getPricing("mistral", "magistral-medium").inputUsd).toBe(0);
    });
  });

  describe("estimateCacheSavingsUsd", () => {
    it("returns 0 for zero cache reads", () => {
      expect(estimateCacheSavingsUsd("claude", "claude-sonnet-4-5", 0)).toBe(0);
    });
    it("returns 0 for non-claude unknown model (consistent with getPricing zero)", () => {
      expect(estimateCacheSavingsUsd("codex", "davinci-002", 1000)).toBe(0);
    });
    it("sonnet 1000 cache-read tokens saves ~$0.0027 (1000 × $3 × 0.9 / 1M)", () => {
      const saved = estimateCacheSavingsUsd("claude", "claude-sonnet-4-5", 1000);
      expect(saved).toBeCloseTo((1000 * 3 * 0.9) / 1_000_000, 8);
    });
    it('claude "default" model is priced at Sonnet → non-zero savings (Fix 1)', () => {
      // 29.3M cache-read tokens logged under model "default" should price
      // as Sonnet (≈ $79), not $0. Verify both non-zero and the exact value.
      const saved = estimateCacheSavingsUsd("claude", "default", 1000);
      expect(saved).toBeGreaterThan(0);
      expect(saved).toBeCloseTo((1000 * 3 * 0.9) / 1_000_000, 8);
      const bulk = estimateCacheSavingsUsd("claude", "default", 29_300_000);
      expect(bulk).toBeCloseTo((29_300_000 * 3 * 0.9) / 1_000_000, 4); // ≈ $79.11
    });
    it("gemini flash cache reads now yield non-zero savings (#44)", () => {
      // 10000 × $0.30 × (1 - 0.10) / 1M.
      const saved = estimateCacheSavingsUsd("gemini", "gemini-2.5-flash", 10_000);
      expect(saved).toBeCloseTo((10_000 * 0.3 * 0.9) / 1_000_000, 10);
      expect(saved).toBeGreaterThan(0);
    });
    it("grok-build cache reads yield non-zero savings (#44)", () => {
      // 10000 × $1.00 × (1 - 0.20) / 1M.
      const saved = estimateCacheSavingsUsd("grok", "grok-build", 10_000);
      expect(saved).toBeCloseTo((10_000 * 1 * (1 - 0.2)) / 1_000_000, 10);
    });
    it("gemini 'default' row still 0 (conservative, no model resolved)", () => {
      expect(estimateCacheSavingsUsd("gemini", "default", 9999)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Least-cost-routing (LCR) accessors: modelIdToFamily / getModelCost /
  // composeCost. Router-only surface added beside getPricing (sections 4.1,
  // 4.1a, 4.2). getPricing's ZERO-for-unknown semantics must stay intact.
  // -------------------------------------------------------------------------

  describe("modelIdToFamily: CLI-agnostic family resolution", () => {
    it("maps claude ids (what devin / cursor-agent run) to priced families", () => {
      expect(modelIdToFamily("claude-sonnet-4-5")).toBe("claude-sonnet");
      expect(modelIdToFamily("claude-opus-4-7")).toBe("claude-opus");
      expect(modelIdToFamily("claude-haiku-4-5")).toBe("claude-haiku");
    });
    it("maps gpt ids (what codex / cursor-agent --model gpt-* run) to openai-gpt5", () => {
      expect(modelIdToFamily("gpt-5.4")).toBe("openai-gpt5");
      expect(modelIdToFamily("openai/gpt-5-mini")).toBe("openai-gpt5");
      expect(modelIdToFamily("o3-2025-01-31")).toBe("openai-gpt5");
    });
    it("maps gemini / grok / mistral version-anchored ids to their families", () => {
      expect(modelIdToFamily("gemini-2.5-flash")).toBe("gemini-2.5-flash");
      expect(modelIdToFamily("gemini-2.5-pro")).toBe("gemini-2.5-pro");
      expect(modelIdToFamily("gemini-3-pro-preview")).toBe("gemini-3-pro");
      expect(modelIdToFamily("grok-4.3")).toBe("grok-4");
      expect(modelIdToFamily("grok-code-fast-1")).toBe("grok-build");
      expect(modelIdToFamily("mistral-medium-3.5")).toBe("mistral-medium");
      expect(modelIdToFamily("devstral-small")).toBe("mistral-devstral");
    });
    it("returns 'unknown' for an unrecognised / specialty / bare id", () => {
      expect(modelIdToFamily("davinci-002")).toBe("unknown");
      expect(modelIdToFamily("default")).toBe("unknown");
      expect(modelIdToFamily("")).toBe("unknown");
      // Specialty gemini tiers are gated out (they carry different rates).
      expect(modelIdToFamily("gemini-2.5-flash-lite")).toBe("unknown");
      // Legacy mistral-medium-3 must not resolve to Medium 3.5.
      expect(modelIdToFamily("mistral-medium-3")).toBe("unknown");
    });
  });

  describe("getModelCost: table rates, cacheWrite, accountingMode, family", () => {
    it("claude (any CLI) resolves to disjoint accounting + full Sonnet rates", () => {
      // A devin run of claude-sonnet has no getPricing brand branch, but
      // getModelCost prices it by resolved family (contract decision 4).
      const mc = getModelCost("devin", "claude-sonnet-4-5");
      expect(mc.family).toBe("claude-sonnet");
      expect(mc.inputUsdPerMTok).toBe(3);
      expect(mc.outputUsdPerMTok).toBe(15);
      expect(mc.cacheReadMultiplier).toBe(0.1);
      // cacheWrite defaults to the input rate (table encodes no cache-write mult).
      expect(mc.cacheWriteUsdPerMTok).toBe(3);
      expect(mc.accountingMode).toBe("disjoint");
      expect(mc.source).toBe("table");
      expect(mc.asOf).toBe(PRICING_AS_OF);
    });
    it("codex / gemini / grok / mistral resolve to inclusive accounting", () => {
      expect(getModelCost("codex", "gpt-5.4").accountingMode).toBe("inclusive");
      expect(getModelCost("gemini", "gemini-2.5-pro").accountingMode).toBe("inclusive");
      expect(getModelCost("grok", "grok-4.3").accountingMode).toBe("inclusive");
      expect(getModelCost("mistral", "mistral-medium-3.5").accountingMode).toBe("inclusive");
      // A cursor-agent run of gpt-* is priced by the gpt family it runs.
      const cur = getModelCost("cursor", "gpt-5-mini");
      expect(cur.family).toBe("openai-gpt5");
      expect(cur.inputUsdPerMTok).toBe(1.25);
      expect(cur.outputUsdPerMTok).toBe(10);
    });
    it("unknown family => source 'unknown' with zeroed rates (never looks free)", () => {
      const mc = getModelCost("cursor", "davinci-002");
      expect(mc.source).toBe("unknown");
      expect(mc.family).toBe("unknown");
      expect(mc.inputUsdPerMTok).toBe(0);
      expect(mc.outputUsdPerMTok).toBe(0);
      expect(mc.cacheWriteUsdPerMTok).toBe(0);
    });
  });

  describe("getPricing regression: ZERO-for-unknown UNCHANGED by the LCR path", () => {
    // getModelCost's exclude-unknown rule must NOT leak into getPricing, whose
    // ZERO (and claude-default-to-Sonnet) semantics the cache-savings path needs.
    it("getPricing still ZERO for an unknown codex model", () => {
      expect(getPricing("codex", "davinci-002").inputUsd).toBe(0);
    });
    it("getPricing still falls claude 'default' back to Sonnet", () => {
      expect(getPricing("claude", "default").inputUsd).toBe(3);
    });
  });

  describe("composeCost: basis matrix (one pure fn drives derive AND rank)", () => {
    const zeroEstimate: TokenEstimate = { estInputTokens: 0, estOutputTokens: 0 };

    it("provider-reported dollar cost passes through verbatim (high confidence)", () => {
      const counts: TokenCounts = {
        inputTokens: 1000,
        outputTokens: 500,
        reportedCostUsd: 0.0421,
      };
      const mc = getModelCost("claude", "claude-sonnet-4-5");
      const r = composeCost(counts, zeroEstimate, mc);
      expect(r.cost_basis).toBe("provider-reported");
      expect(r.confidence).toBe("high");
      expect(r.costUsd).toBe(0.0421);
    });

    it("provider-reported wins even when the rate is unknown", () => {
      const counts: TokenCounts = { inputTokens: 10, outputTokens: 10, reportedCostUsd: 1.5 };
      const mc = getModelCost("cursor", "davinci-002"); // source: unknown
      const r = composeCost(counts, zeroEstimate, mc);
      expect(r.cost_basis).toBe("provider-reported");
      expect(r.costUsd).toBe(1.5);
    });

    it("derived inclusive SUBTRACTS the cache-read discount off the base", () => {
      // gpt-5.4: input $1.25, output $10, cacheReadMult 0.5. inclusive =>
      // input includes the cache-read subset, so read is a discount.
      const mc = getModelCost("codex", "gpt-5.4");
      const counts: TokenCounts = {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 400_000,
        cacheCreationTokens: 100_000,
      };
      const expected =
        (1_000_000 * 1.25) / 1e6 + // base input (includes cache read)
        (100_000 * 1.25) / 1e6 + // cache write at input rate default
        (1_000_000 * 10) / 1e6 - // output
        (400_000 * 1.25 * (1 - 0.5)) / 1e6; // cache-read discount subtracted
      const r = composeCost(counts, zeroEstimate, mc);
      expect(r.cost_basis).toBe("derived-from-tokens");
      expect(r.confidence).toBe("high");
      expect(r.costUsd).toBeCloseTo(expected, 10);
    });

    it("derived disjoint BILLS cache_read on fresh-only input (claude)", () => {
      // claude sonnet: input $3, output $15, cacheReadMult 0.1. disjoint =>
      // input_tokens is fresh-only; cache read is billed at the discounted rate.
      const mc = getModelCost("claude", "claude-sonnet-4-5");
      const counts: TokenCounts = {
        inputTokens: 1_000_000, // fresh only
        outputTokens: 1_000_000,
        cacheReadTokens: 400_000,
        cacheCreationTokens: 100_000,
      };
      const expected =
        (1_000_000 * 3) / 1e6 + // fresh input
        (100_000 * 3) / 1e6 + // cache write at input rate default
        (400_000 * 3 * 0.1) / 1e6 + // cache read BILLED (not subtracted)
        (1_000_000 * 15) / 1e6; // output
      const r = composeCost(counts, zeroEstimate, mc);
      expect(r.cost_basis).toBe("derived-from-tokens");
      expect(r.costUsd).toBeCloseTo(expected, 10);
    });

    it("inclusive and disjoint differ for the SAME counts (mode is not blind)", () => {
      const counts: TokenCounts = {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 500_000,
      };
      const incl = getModelCost("codex", "gpt-5.4"); // inclusive, mult 0.5
      const inclCost = composeCost(counts, zeroEstimate, incl).costUsd;
      // inclusive: 1.25 - 500k*1.25*0.5/1e6 = 1.25 - 0.3125 = 0.9375
      expect(inclCost).toBeCloseTo(1.25 - (500_000 * 1.25 * 0.5) / 1e6, 10);
      const disj = getModelCost("claude", "claude-sonnet-4-5"); // disjoint, mult 0.1
      const disjCost = composeCost(counts, zeroEstimate, disj).costUsd;
      // disjoint: fresh 1M*3 + read 500k*3*0.1 = 3 + 0.15 = 3.15
      expect(disjCost).toBeCloseTo((1_000_000 * 3) / 1e6 + (500_000 * 3 * 0.1) / 1e6, 10);
    });

    it("reasoningTokens are added at the OUTPUT rate", () => {
      const mc = getModelCost("grok", "grok-4.3"); // input 1.25, output 2.5, incl
      const base: TokenCounts = { inputTokens: 0, outputTokens: 0 };
      const withReasoning: TokenCounts = {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 200_000,
      };
      const baseCost = composeCost(base, zeroEstimate, mc).costUsd;
      const reasonCost = composeCost(withReasoning, zeroEstimate, mc).costUsd;
      expect(baseCost).toBe(0);
      expect(reasonCost).toBeCloseTo((200_000 * 2.5) / 1e6, 10); // billed as output
    });

    it("unknown rate => pre-flight-estimate with low confidence (falls back)", () => {
      const mc = getModelCost("cursor", "davinci-002"); // source unknown, zero rates
      const counts: TokenCounts = { inputTokens: 1000, outputTokens: 1000 };
      const estimate: TokenEstimate = { estInputTokens: 5000, estOutputTokens: 5000 };
      const r = composeCost(counts, estimate, mc);
      expect(r.cost_basis).toBe("pre-flight-estimate");
      expect(r.confidence).toBe("low");
      // Zero rates => zero cost, but the BASIS is the observable signal here.
      expect(r.costUsd).toBe(0);
    });

    it("no counts => pre-flight-estimate uses the estimate at table rates", () => {
      const mc = getModelCost("codex", "gpt-5.4"); // inclusive, input 1.25 output 10
      const estimate: TokenEstimate = {
        estInputTokens: 2_000_000,
        estOutputTokens: 500_000,
        estCacheReadTokens: 1_000_000,
        estCacheWriteTokens: 200_000,
      };
      const expected =
        (2_000_000 * 1.25) / 1e6 + // whole-prompt input (inclusive)
        (200_000 * 1.25) / 1e6 + // cache write
        (500_000 * 10) / 1e6 - // output
        (1_000_000 * 1.25 * (1 - 0.5)) / 1e6; // cache-read discount
      const r = composeCost(null, estimate, mc);
      expect(r.cost_basis).toBe("pre-flight-estimate");
      expect(r.confidence).toBe("low");
      expect(r.costUsd).toBeCloseTo(expected, 10);
    });

    it("disjoint ESTIMATE removes cache subsets from the whole-prompt input", () => {
      // claude estimate: estInputTokens is whole-prompt; fresh = whole - read - write.
      const mc = getModelCost("claude", "claude-sonnet-4-5");
      const estimate: TokenEstimate = {
        estInputTokens: 1_000_000, // whole prompt
        estOutputTokens: 100_000,
        estCacheReadTokens: 300_000,
        estCacheWriteTokens: 100_000,
      };
      const fresh = 1_000_000 - 300_000 - 100_000;
      const expected =
        (fresh * 3) / 1e6 +
        (100_000 * 3) / 1e6 + // cache write
        (300_000 * 3 * 0.1) / 1e6 + // cache read billed
        (100_000 * 15) / 1e6; // output
      const r = composeCost(null, estimate, mc);
      expect(r.cost_basis).toBe("pre-flight-estimate");
      expect(r.costUsd).toBeCloseTo(expected, 10);
    });
  });
});
