/**
 * Content-class router (spec 6.2): classify the post-parse display string
 * into one of {json, log, ansi-text, plain} and let the compressor dispatch.
 * Unknown or risky content falls through to identity. Correctness beats
 * savings; on any doubt, identity. The router never sees raw stdout (C1).
 */

import { hasDangerousSequences } from "./transforms/ansi.js";
import { minifyJson } from "./transforms/json.js";
import { splitFences } from "./transforms/whitespace.js";
import { MIN_RUN } from "./transforms/log.js";

export type ContentRoute = "json" | "log" | "ansi-text" | "plain" | "identity";

// Any ECMA-48 escape or an internal (non-CRLF) carriage return marks
// terminal-ish content. The ESC-byte regex is intentional (see ansi.ts).
// eslint-disable-next-line no-control-regex
const HAS_ESCAPE = /\x1b/;
const HAS_INTERNAL_CR = /\r(?!\n|$)/;

/** True when some unfenced run of MIN_RUN+ byte-identical non-blank lines exists. */
function hasRepeatedRuns(text: string): boolean {
  for (const segment of splitFences(text)) {
    if (segment.fenced) continue;
    const lines = segment.text.split("\n");
    let run = 1;
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i] === lines[i - 1] && lines[i].trim() !== "") {
        run += 1;
        if (run >= MIN_RUN) return true;
      } else {
        run = 1;
      }
    }
  }
  return false;
}

/**
 * Structural JSON evidence (the C1 content sniff): after trimming, the text
 * begins with { or [, ends with the matching close, and minifies cleanly
 * end-to-end. Prose that merely contains or quotes JSON stays plain; fenced
 * JSON never triggers the route (the fence rule would forbid touching it
 * anyway).
 */
function isStructuralJson(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  const structural = (first === "{" && last === "}") || (first === "[" && last === "]");
  if (!structural) return false;
  return minifyJson(trimmed) !== null;
}

/**
 * Classify a display string. The dangerous-sequence check is part of
 * classification (spec 6.2): cursor-movement / alt-screen / backspace
 * content returns "identity" directly and no transform of any class runs.
 */
export function classify(text: string): ContentRoute {
  if (text.length === 0) return "identity";
  const escapes = HAS_ESCAPE.test(text);
  const internalCr = HAS_INTERNAL_CR.test(text);
  if (escapes || internalCr) {
    if (hasDangerousSequences(text)) return "identity";
    return "ansi-text";
  }
  if (isStructuralJson(text)) return "json";
  if (hasRepeatedRuns(text)) return "log";
  return "plain";
}
