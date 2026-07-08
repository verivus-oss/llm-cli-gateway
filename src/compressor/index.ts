/**
 * Native compressor (spec docs/plans/native-compressor.spec.md, PR-1).
 *
 * Compresses ONLY post-parse, caller-facing display text at the MCP
 * tool-response boundary (invariants C1/C7). Content-preserving by
 * construction (C3 tiers): token-preserving JSON minification (Tier B),
 * counted folds with versioned sentinels (Tier F), and presentation-byte
 * discards (Tier P) whose originals stay recoverable via the
 * flight-recorder read-back escape hatch (spec 5.3). Default off; the
 * effective decision is computed by the caller (config + request param +
 * outputFormat + output schema) and double-checked here.
 */

import { classify, type ContentRoute } from "./router.js";
import { minifyJson } from "./transforms/json.js";
import {
  dedupAdjacentLines,
  escapeSentinelLikeLines,
  noteLine,
  type MarkerCounts,
} from "./transforms/log.js";
import { stripAnsi } from "./transforms/ansi.js";
import { normalizeWhitespace } from "./transforms/whitespace.js";
import { estimateTokensSaved } from "./estimate.js";

export interface CompressCtx {
  /** Member of CLI_TYPES ("claude" | "codex" | ...); telemetry only. */
  provider: string;
  /** PR-1 is outbound-only; "inbound" arrives in PR-2. */
  direction: "outbound";
  /** Bypass guard: skip when "json" (mirrors the optimizer guard). */
  outputFormat?: string;
  /** Bypass guard: skip when the request declared an output schema. */
  outputSchemaDeclared: boolean;
  /** PR-1 is content-preserving-only (C3 tiers); PR-3 adds false. */
  lossless: true;
}

export interface CompressResult {
  /** Compressed display text (or the input, verbatim, on identity). */
  text: string;
  originalChars: number;
  compressedChars: number;
  /** Content class routed to, or "identity". */
  route: ContentRoute;
  /** Transforms that actually changed bytes. */
  transforms: string[];
  /** Divisor-table estimate (spec Section 8); labeled estimated. */
  estimatedTokensSaved: number;
}

export interface Compressor {
  compact(text: string, ctx: CompressCtx): CompressResult;
}

function identityResult(text: string, route: ContentRoute = "identity"): CompressResult {
  return {
    text,
    originalChars: text.length,
    compressedChars: text.length,
    route,
    transforms: [],
    estimatedTokensSaved: 0,
  };
}

/**
 * PR-1 implementation. The Compressor interface exists so a later
 * HeadroomCompressor (PR-4) can back heavy transforms without touching call
 * sites; native stays the default.
 */
export class NativeCompressor implements Compressor {
  compact(text: string, ctx: CompressCtx): CompressResult {
    // Defense in depth: the caller's effective decision already folds these
    // guards in; a direct caller gets the same bypasses (C1).
    if (ctx.outputFormat === "json" || ctx.outputSchemaDeclared) {
      return identityResult(text);
    }
    const route = classify(text);
    if (route === "identity") return identityResult(text);

    if (route === "json") {
      // Tier B only: the body must remain pure JSON, so no markers and no
      // whitespace pass ever run on this route.
      const minified = minifyJson(text.trim());
      if (minified === null || minified.length >= text.length) {
        return identityResult(text);
      }
      return {
        text: minified,
        originalChars: text.length,
        compressedChars: minified.length,
        route,
        transforms: ["json-minify"],
        estimatedTokensSaved: estimateTokensSaved(text, minified, route),
      };
    }

    const counts: MarkerCounts = { folded: 0, escaped: 0 };
    const transforms: string[] = [];
    let current = text;

    const apply = (name: string, fn: (input: string) => string): void => {
      const next = fn(current);
      if (next !== current) transforms.push(name);
      current = next;
    };

    // Escaping precedes the folds so gateway markers stay unambiguous even
    // against sentinel-like input (spec 6.4).
    apply("lit-escape", input => escapeSentinelLikeLines(input, counts));
    if (route === "ansi-text") {
      apply("ansi-strip", input => stripAnsi(input, counts));
      apply("dedup", input => dedupAdjacentLines(input, counts));
    }
    if (route === "log") {
      apply("dedup", input => dedupAdjacentLines(input, counts));
    }
    apply("whitespace", normalizeWhitespace);

    if (counts.folded + counts.escaped > 0) {
      current = `${noteLine(counts.folded, counts.escaped)}\n${current}`;
      transforms.push("leading-note");
    }

    // Never inflate: if markers plus note cost more than the transforms
    // saved, the response is returned verbatim (identity beats negative
    // savings; the fixture-level promotion rule is separate, spec Section 9).
    if (current.length >= text.length) {
      return identityResult(text, route);
    }

    return {
      text: current,
      originalChars: text.length,
      compressedChars: current.length,
      route,
      transforms,
      estimatedTokensSaved: estimateTokensSaved(text, current, route),
    };
  }
}

const defaultCompressor = new NativeCompressor();

/**
 * The single shared compression entry point both wiring sites call
 * (spec 5.1 sync, 5.2 async). One call per response, after display
 * extraction and optimizeResponse, before the review-integrity append.
 */
export function compressDisplayText(text: string, ctx: CompressCtx): CompressResult {
  return defaultCompressor.compact(text, ctx);
}
