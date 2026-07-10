// Layered, PURE input-token estimator for the least-cost-routing path (spec 4.2,
// enhancements 2 + 3). Best-available layer wins:
//   Layer 1 (content-aware base): a content-type classifier picks a per-character
//     divisor over the whole text (prose ~chars/4, code/JSON/markup ~chars/3,
//     CJK ~chars/1.5).
//   Layer 2 (per-tokenizer-family multiplier): a small table keyed off the
//     candidate's resolved tokenizer family adjusts the base so cross-model
//     ranking near ties is less arbitrary. Unknown or absent family => 1.
//   Layer 3 (self-calibration hook): a correction factor k, learned by the
//     phase_2 flight-recorder aggregator, multiplies the base. phase_0 ships a
//     hook that defaults to 1 (no aggregator wired yet).
//
// This module is dependency-free and deterministic: NO Math.random, NO Date.now.
// It replaces optimizer.estimateTokens (ceil(words * 1.3)) on the routing path
// only; the crude heuristic stays as the layer-1 floor for other callers. The
// optional real-BPE tokenizer is a separate gated add-on, never a default here.

/**
 * Coarse content buckets that drive the layer-1 per-character divisor. Distinct
 * from a tokenizer family: a family multiplier (layer 2) is applied on top.
 */
export type ContentType = "prose" | "code" | "cjk";

// CJK punctuation, Hiragana, Katakana, CJK ideographs (BMP + compat), fullwidth
// forms, and Hangul. A dense run of these signals a non-space-delimited script
// whose per-character token cost is far higher than Latin prose. Ranges are
// spelled with unicode escapes so the character class carries no literal
// irregular whitespace (the block opens at U+3000, the ideographic space).
const CJK_RE =
  /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/g;

// Structural / code-ish symbols (deliberately excludes sentence punctuation like
// "." and "," so ordinary prose does not read as code).
const CODE_SYMBOL_RE = /[{}[\]()<>;=+\-*/\\|&%$#@`~]/g;

const CODE_KEYWORD_RE =
  /\b(function|const|let|var|return|import|export|class|def|public|private|static|void|for|while|switch|case)\b/;

// Layer-1 per-character divisors. Denser content yields more tokens per char, so
// a smaller divisor. See spec 4.2 layer 1. A Map keeps the ContentType lookup off
// a plain-object index (no object-injection surface).
const DIVISOR_BY_TYPE: ReadonlyMap<ContentType, number> = new Map([
  ["prose", 4],
  ["code", 3],
  ["cjk", 1.5],
]);

// Layer-2 per-tokenizer-family multipliers. Pre-calibration placeholders (real
// data-derived values arrive with the phase_2 aggregator, spec 4.2 layer 3);
// they only need to break near-ties in cross-model ranking. Keyed by lowercased
// family token; matched by exact key or substring so composite family labels
// (for example "openai/o200k", "gemini/sentencepiece") resolve. Any family not
// covered here falls back to the neutral 1 multiplier.
const FAMILY_MULTIPLIERS: ReadonlyMap<string, number> = new Map([
  ["openai", 1.0],
  ["o200k", 1.0],
  ["cl100k", 1.02],
  ["claude", 1.08],
  ["gemini", 0.98],
  ["sentencepiece", 0.98],
  ["grok", 1.0],
  ["mistral", 1.05],
]);

/**
 * Bucket a text sample into a coarse {@link ContentType} for layer-1 estimation.
 * CJK dominance wins first; otherwise structural-symbol density (and code
 * keywords / JSON shape) distinguishes code/JSON/markup from prose.
 */
export function classifyContent(text: string): ContentType {
  if (!text) return "prose";

  const nonSpace = text.replace(/\s+/g, "").length;
  if (nonSpace === 0) return "prose";

  const cjkMatches = text.match(CJK_RE);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  if (cjkCount / nonSpace >= 0.2) return "cjk";

  const trimmed = text.trim();
  const looksJson = /^[[{]/.test(trimmed) && /[}\]]/.test(trimmed) && /[:,]/.test(trimmed);

  const symbolMatches = trimmed.match(CODE_SYMBOL_RE);
  const symbolCount = symbolMatches ? symbolMatches.length : 0;
  const symbolRatio = symbolCount / nonSpace;
  const hasKeyword = CODE_KEYWORD_RE.test(trimmed);

  if (looksJson || symbolRatio >= 0.08 || (hasKeyword && symbolRatio >= 0.03)) {
    return "code";
  }
  return "prose";
}

function familyMultiplier(family?: string): number {
  if (!family) return 1;
  const f = family.toLowerCase();
  for (const [key, multiplier] of FAMILY_MULTIPLIERS) {
    if (f === key || f.includes(key)) return multiplier;
  }
  return 1;
}

/**
 * Estimate whole-text input tokens with the layered content-aware model.
 *
 * @param text  the whole prompt (system + tools + context + task for structured
 *              prompts); estimation is over the entire string.
 * @param opts.family        resolved tokenizer family for the layer-2 multiplier
 *                           (unknown or absent => neutral 1).
 * @param opts.calibrationK  layer-3 self-calibration factor (defaults to 1 until
 *                           the phase_2 aggregator supplies one).
 * @returns a deterministic, non-negative integer token estimate.
 */
export function estimateInputTokens(
  text: string,
  opts?: { family?: string; calibrationK?: number }
): number {
  if (!text) return 0;

  const type = classifyContent(text);
  const divisor = DIVISOR_BY_TYPE.get(type) ?? 4;
  const base = text.length / divisor;
  const familyMult = familyMultiplier(opts?.family);
  const k = opts?.calibrationK ?? 1;

  return Math.ceil(base * familyMult * k);
}
