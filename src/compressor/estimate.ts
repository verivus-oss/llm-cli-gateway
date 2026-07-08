/**
 * Estimated-token accounting for compressor telemetry (spec Section 8, C5).
 *
 * Content-aware chars-per-token divisor table keyed by the router's content
 * class (research annex Part 1, section 5: prose ~3.6, log text ~3.4,
 * minified JSON ~3.0, code ~2.3 chars/token against cl100k-class
 * tokenizers). The words-x-1.3 estimateTokens in src/optimizer.ts and flat
 * chars/4 are BANNED here: they under-count code/JSON by 30-58% and
 * under-counting is the harmful direction. All published numbers derived
 * from this module are labeled estimated; exact char counts are recorded
 * alongside and billed usage never derives from these values.
 */

import type { ContentRoute } from "./router.js";

/** Approximate chars/token per content class (annex Part 1, section 5). */
const DIVISORS: Record<ContentRoute, number> = {
  json: 3.0,
  log: 3.4,
  "ansi-text": 3.4,
  plain: 3.6,
  identity: 3.6,
};

/** Optional real tokenizer, injectable for fixture benchmarking ONLY. */
export type DevTokenizer = (text: string) => number;

let devTokenizer: DevTokenizer | null = null;

/**
 * Install (or clear) a real tokenizer for fixture benchmarking. Test/bench
 * only; production never loads a tokenizer dependency, and the gateway
 * never calls this outside test code.
 */
export function setDevTokenizer(tokenizer: DevTokenizer | null): void {
  devTokenizer = tokenizer;
}

/** Estimated token count of a text for a given route, labeled estimated. */
export function estimateTokensForRoute(text: string, route: ContentRoute): number {
  if (devTokenizer) return devTokenizer(text);
  if (text.length === 0) return 0;
  return Math.ceil(text.length / DIVISORS[route]);
}

/**
 * Estimated tokens saved by compressing originalText to compressedText on
 * the given route. Never negative.
 */
export function estimateTokensSaved(
  originalText: string,
  compressedText: string,
  route: ContentRoute
): number {
  return Math.max(
    0,
    estimateTokensForRoute(originalText, route) - estimateTokensForRoute(compressedText, route)
  );
}
