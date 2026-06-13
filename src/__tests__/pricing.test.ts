import { describe, it, expect } from "vitest";
import { getPricing, estimateCacheSavingsUsd, PRICING_AS_OF } from "../pricing.js";

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
});
