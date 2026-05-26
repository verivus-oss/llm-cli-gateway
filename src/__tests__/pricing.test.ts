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

  describe("getPricing — unknown models return ZERO (no over-reporting)", () => {
    it("claude with unknown family → zero", () => {
      const p = getPricing("claude", "claude-mystery-1");
      expect(p.inputUsd).toBe(0);
      expect(p.outputUsd).toBe(0);
      expect(p.cacheReadMultiplier).toBe(0);
    });
    it("claude with empty model → zero", () => {
      expect(getPricing("claude", "").inputUsd).toBe(0);
    });
    it("codex with unknown OpenAI family → zero", () => {
      expect(getPricing("codex", "davinci-002").inputUsd).toBe(0);
      expect(getPricing("codex", "future-model-7").inputUsd).toBe(0);
    });
    it("gemini, grok, mistral → always zero (no pricing table today)", () => {
      expect(getPricing("gemini", "gemini-2.5-flash").inputUsd).toBe(0);
      expect(getPricing("grok", "grok-build").inputUsd).toBe(0);
      expect(getPricing("mistral", "mistral-medium-3.5").inputUsd).toBe(0);
    });
  });

  describe("estimateCacheSavingsUsd", () => {
    it("returns 0 for zero cache reads", () => {
      expect(estimateCacheSavingsUsd("claude", "claude-sonnet-4-5", 0)).toBe(0);
    });
    it("returns 0 for unknown model (consistent with getPricing zero)", () => {
      expect(estimateCacheSavingsUsd("claude", "claude-mystery-1", 1000)).toBe(0);
      expect(estimateCacheSavingsUsd("codex", "davinci-002", 1000)).toBe(0);
    });
    it("sonnet 1000 cache-read tokens saves ~$0.0027 (1000 × $3 × 0.9 / 1M)", () => {
      const saved = estimateCacheSavingsUsd("claude", "claude-sonnet-4-5", 1000);
      expect(saved).toBeCloseTo((1000 * 3 * 0.9) / 1_000_000, 8);
    });
    it("gemini always 0 (no pricing)", () => {
      expect(estimateCacheSavingsUsd("gemini", "flash", 9999)).toBe(0);
    });
  });
});
