import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  DERIVATION_VERSION,
  classifyContent,
  derivePromptSignals,
  estimateInputTokens,
  estimateInputTokensFromDerived,
} from "../token-estimator.js";

// The derived-signal path exists so the routing hot path never reads a prompt
// body, which is what lets the body columns be encrypted (see
// docs/plans/postgres-security-hardening.md 4.2). That is only safe if
// reconstruction is EXACT, not approximate. These tests are the control on that
// claim: if the two paths ever diverge, least-cost routing silently changes.

const FAMILIES = [undefined, "claude", "openai/o200k", "cl100k", "gemini", "mistral", "nonsense"];

describe("prompt derivation reconstructs the estimator exactly", () => {
  it("matches estimateInputTokens for arbitrary text and family", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.constantFrom(...FAMILIES),
        fc.double({ min: 0.1, max: 3, noNaN: true }),
        (text, family, calibrationK) => {
          const direct = estimateInputTokens(text, { family, calibrationK });
          const viaDerived = estimateInputTokensFromDerived(derivePromptSignals(text), {
            family,
            calibrationK,
          });
          expect(viaDerived).toBe(direct);
        }
      ),
      { numRuns: 2000 }
    );
  });

  it("matches for CJK, code and JSON shaped text, which pick non-default divisors", () => {
    const samples = [
      "これは日本語のテキストです。文章をここに書きます。以上の内容です。",
      "function add(a, b) { return a + b; } const arr = [1, 2, 3];",
      '{"name": "test", "value": 42, "tags": ["a", "b"], "ok": true}',
      "The quick brown fox jumped over the lazy dog in the quiet valley.",
      "",
      "   ",
    ];
    for (const text of samples) {
      for (const family of FAMILIES) {
        expect(estimateInputTokensFromDerived(derivePromptSignals(text), { family })).toBe(
          estimateInputTokens(text, { family })
        );
      }
    }
  });

  it("derives the same content class the estimator would classify", () => {
    fc.assert(
      fc.property(fc.string(), text => {
        expect(derivePromptSignals(text).contentClass).toBe(classifyContent(text));
      }),
      { numRuns: 1000 }
    );
  });

  it("records prompt length and the current derivation version", () => {
    const d = derivePromptSignals("hello world");
    expect(d.promptChars).toBe(11);
    expect(d.derivationVersion).toBe(DERIVATION_VERSION);
  });

  it("treats empty and absent text as zero, as the estimator does", () => {
    expect(estimateInputTokensFromDerived({ promptChars: 0, contentClass: "prose" })).toBe(0);
    expect(estimateInputTokens("")).toBe(0);
    expect(derivePromptSignals("").promptChars).toBe(0);
  });

  // Guard against the specific failure this design is meant to prevent: a
  // reconstruction that quietly diverges because the stored class is wrong.
  it("diverges if the stored content class is wrong, proving the class is load-bearing", () => {
    const code = "function add(a, b) { return a + b; } const arr = [1, 2, 3];";
    const honest = derivePromptSignals(code);
    expect(honest.contentClass).toBe("code");
    const mislabelled = { promptChars: honest.promptChars, contentClass: "prose" as const };
    expect(estimateInputTokensFromDerived(mislabelled)).not.toBe(estimateInputTokens(code));
  });
});
