/**
 * Log transform: exact-adjacent run-length dedup (Tier F, spec 6.5) plus the
 * shared sentinel grammar (spec 6.4) and the lit-escaping pass. Sentinel
 * helpers live here so ansi.ts and the top-level compact() reuse one grammar.
 */

import { mapUnfenced } from "./whitespace.js";

/** Every gateway marker opens with this; the escaping rule keys off it. */
export const SENTINEL_PREFIX = "[[gateway-";

/** Marker prefix a decoder strips (exactly one per line) to recover input. */
export const LIT_MARKER = "[[gateway-lit:v1]] ";

export function repeatMarker(lines: number, count: number): string {
  return `[[gateway-repeat:v1 lines=${lines} count=${count}]]`;
}

export function crMarker(frames: number): string {
  return `[[gateway-cr:v1 frames=${frames}]]`;
}

export function noteLine(folded: number, escaped: number): string {
  return (
    `[[gateway-note:v1 folded=${folded} escaped=${escaped}]] ` +
    "Gateway compressor markers follow: [[gateway-repeat:v1 ...]] folds byte-identical repeated lines (count included), " +
    "[[gateway-cr:v1 ...]] keeps the final frame of carriage-return-rewritten lines, " +
    "and lines opening with [[gateway-lit:v1]] are verbatim input with that prefix added."
  );
}

/** Number of markers of each kind a transform pass produced. */
export interface MarkerCounts {
  folded: number;
  escaped: number;
}

/**
 * Lit-escape pass (spec 6.4): any input line whose first non-whitespace
 * content starts with `[[gateway-` is emitted as LIT_MARKER + original line
 * byte-for-byte. Applied outside fences only. The decode rule (strip exactly
 * one LIT_MARKER per line) makes encode/decode a per-line bijection.
 */
export function escapeSentinelLikeLines(text: string, counts: MarkerCounts): string {
  return mapUnfenced(text, segment =>
    segment
      .split("\n")
      .map(line => {
        if (line.trimStart().startsWith(SENTINEL_PREFIX)) {
          counts.escaped += 1;
          return LIT_MARKER + line;
        }
        return line;
      })
      .join("\n")
  );
}

/** Minimum run length before a fold pays for its sentinel line (spec 6.5). */
export const MIN_RUN = 3;

/**
 * Exact-adjacent dedup (spec 6.5): a run of MIN_RUN+ byte-identical,
 * non-blank lines is replaced by one exemplar plus a repeat sentinel.
 * Blank/whitespace-only lines are left to the whitespace transform. Runs
 * inside fences are untouched (fence rule). No value masking, no windowing.
 */
export function dedupAdjacentLines(text: string, counts: MarkerCounts): string {
  return mapUnfenced(text, segment => {
    const lines = segment.split("\n");
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      let runEnd = i + 1;
      if (line.trim() !== "") {
        while (runEnd < lines.length && lines[runEnd] === line) runEnd += 1;
      }
      const runLength = runEnd - i;
      if (runLength >= MIN_RUN) {
        out.push(line);
        out.push(repeatMarker(1, runLength));
        counts.folded += 1;
      } else {
        for (let j = i; j < runEnd; j += 1) out.push(lines[j]);
      }
      i = runEnd;
    }
    return out.join("\n");
  });
}
