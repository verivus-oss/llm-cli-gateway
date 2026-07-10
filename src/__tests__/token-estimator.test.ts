import { describe, it, expect } from "vitest";
import { classifyContent, estimateInputTokens } from "../token-estimator.js";

const PROSE_SAMPLE =
  "The quick brown fox jumped over the lazy dog while the sun was shining brightly over the calm and quiet valley.";
const CODE_SAMPLE =
  "function add(a, b) { return a + b; } const arr = [1, 2, 3]; obj = { k: 9, m: 8 };";
const JSON_SAMPLE = '{"name": "test", "value": 42, "tags": ["a", "b"], "ok": true}';
const CJK_SAMPLE = "これは日本語のテキストです。文章をここに書きます。以上の内容です。";

describe("classifyContent", () => {
  it("buckets prose, code, JSON, and CJK into distinct content types", () => {
    expect(classifyContent(PROSE_SAMPLE)).toBe("prose");
    expect(classifyContent(CODE_SAMPLE)).toBe("code");
    expect(classifyContent(JSON_SAMPLE)).toBe("code");
    expect(classifyContent(CJK_SAMPLE)).toBe("cjk");
  });

  it("treats empty or whitespace-only text as prose", () => {
    expect(classifyContent("")).toBe("prose");
    expect(classifyContent("   \n\t ")).toBe("prose");
  });
});

describe("estimateInputTokens layer 1 (content-aware base)", () => {
  it("gives a denser estimate for code than for prose of equal length, and CJK densest", () => {
    const L = Math.max(PROSE_SAMPLE.length, CODE_SAMPLE.length, CJK_SAMPLE.length);
    // Pad to equal length with characters that preserve each classification.
    const prose = PROSE_SAMPLE.padEnd(L, " words and more prose");
    const code = CODE_SAMPLE.padEnd(L, ";x=1+2;");
    const cjk = CJK_SAMPLE.padEnd(L, "日本語文字");

    // Sanity: padding must not change the bucket.
    expect(classifyContent(prose)).toBe("prose");
    expect(classifyContent(code)).toBe("code");
    expect(classifyContent(cjk)).toBe("cjk");

    const proseTokens = estimateInputTokens(prose);
    const codeTokens = estimateInputTokens(code);
    const cjkTokens = estimateInputTokens(cjk);

    expect(codeTokens).toBeGreaterThan(proseTokens);
    expect(cjkTokens).toBeGreaterThan(codeTokens);
  });

  it("returns 0 for empty text", () => {
    expect(estimateInputTokens("")).toBe(0);
  });
});

describe("estimateInputTokens layer 2 (per-family multiplier)", () => {
  it("changes the result for a known family and leaves unknown/absent at multiplier 1", () => {
    const baseline = estimateInputTokens(PROSE_SAMPLE);

    // claude carries a non-neutral placeholder multiplier (> 1).
    const claude = estimateInputTokens(PROSE_SAMPLE, { family: "claude" });
    expect(claude).toBeGreaterThan(baseline);

    // Composite family labels resolve via substring match.
    const openaiFamily = estimateInputTokens(PROSE_SAMPLE, { family: "openai/o200k" });
    expect(openaiFamily).toBe(baseline); // openai multiplier is neutral 1

    // Unknown and absent families both resolve to multiplier 1.
    expect(estimateInputTokens(PROSE_SAMPLE, { family: "totally-unknown-family" })).toBe(baseline);
    expect(estimateInputTokens(PROSE_SAMPLE, {})).toBe(baseline);
  });
});

describe("estimateInputTokens layer 3 (calibration k hook)", () => {
  it("applies calibrationK when supplied and defaults to 1", () => {
    const base = estimateInputTokens(PROSE_SAMPLE);
    const doubled = estimateInputTokens(PROSE_SAMPLE, { calibrationK: 2 });

    // Ceil rounding keeps this within one token of exactly 2x.
    expect(doubled).toBeGreaterThan(base);
    expect(doubled).toBeLessThanOrEqual(base * 2 + 1);

    // Explicit k = 1 matches the default (absent) path.
    expect(estimateInputTokens(PROSE_SAMPLE, { calibrationK: 1 })).toBe(base);
  });

  it("is deterministic across repeated calls", () => {
    const opts = { family: "claude", calibrationK: 1.3 };
    const first = estimateInputTokens(CODE_SAMPLE, opts);
    for (let i = 0; i < 5; i++) {
      expect(estimateInputTokens(CODE_SAMPLE, opts)).toBe(first);
    }
  });
});
