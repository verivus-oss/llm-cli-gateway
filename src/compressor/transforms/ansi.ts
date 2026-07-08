/**
 * ANSI transform (Tier P + a Tier F fold, spec 6.6): full ECMA-48 stripping,
 * carriage-return overwrite collapsing with a counted sentinel, and a hard
 * skip on cursor-movement / alternate-screen content. Scoped by the router
 * to the log/terminal content class only.
 */

import { mapUnfenced } from "./whitespace.js";
import { crMarker, type MarkerCounts } from "./log.js";

// Control-char regexes are intentional here: this transform exists precisely
// to recognise ECMA-48 escape and C0 control bytes.
// CSI: ESC [ parameter-bytes intermediate-bytes final-byte
// eslint-disable-next-line no-control-regex
const CSI = /\x1b\[([0-9:;<=>?]*)[ -/]*([@-~])/g;
// OSC with BEL or ST terminator
// eslint-disable-next-line no-control-regex
const OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
// DCS / SOS / APC / PM with ST terminator
// eslint-disable-next-line no-control-regex
const DCS_APC_PM_SOS = /\x1b[PX^_][\s\S]*?\x1b\\/g;
// Remaining two-byte ESC sequences (after the string-introducer forms above)
// eslint-disable-next-line no-control-regex
const ESC_TWO_BYTE = /\x1b[@-Z\\-_]/g;
// Stray C0 controls, second pass; \t (0x09), \n (0x0a), \r (0x0d) preserved.
// \b (0x08) is NOT here: backspace is an overwrite mechanic and is treated
// as dangerous below (identity), same policy as cursor movement.
// eslint-disable-next-line no-control-regex
const STRAY_C0 = /[\x00-\x07\x0b\x0c\x0e-\x1f]/g;

// Cursor movement (CUU/CUD/CUF/CUB/CNL/CPL/CHA/CUP/HVP), scrolling, save/
// restore, and erase-in-display; EL (K) is deliberately allowed because
// \r + ESC[2K rewrites are the progress-bar idiom the CR fold handles.
const DANGEROUS_CSI_FINALS = new Set([
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "f",
  "S",
  "T",
  "J",
  "s",
  "u",
]);
// Alt-screen and cursor-addressing private modes.
const DANGEROUS_PRIVATE_MODES = /^\?(?:47|1047|1049)$/;

/**
 * True when the text contains sequences that make lexical stripping unsafe
 * (a terminal UI recording rather than a log): cursor movement, scrolling,
 * erase-in-display, alt-screen private modes, or backspace overwrites.
 * The router calls this during classification (spec 6.2); the transform
 * checks again as defense in depth.
 */
export function hasDangerousSequences(text: string): boolean {
  if (text.includes("\b")) return true;
  CSI.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CSI.exec(text)) !== null) {
    const params = match[1];
    const final = match[2];
    if (DANGEROUS_CSI_FINALS.has(final)) return true;
    if ((final === "h" || final === "l") && DANGEROUS_PRIVATE_MODES.test(params)) {
      return true;
    }
  }
  return false;
}

function stripEscapes(text: string): string {
  return text
    .replace(OSC, "")
    .replace(DCS_APC_PM_SOS, "")
    .replace(CSI, "")
    .replace(ESC_TWO_BYTE, "")
    .replace(STRAY_C0, "");
}

/**
 * Collapse carriage-return overwrites: for a line with INTERNAL \r
 * characters, keep the final visible frame (the segment after the last \r)
 * and append a counted sentinel. A trailing \r is a CRLF line-ending
 * artifact, not an overwrite, and is preserved as-is.
 */
function collapseCrOverwrites(text: string, counts: MarkerCounts): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const crlf = line.endsWith("\r");
    const body = crlf ? line.slice(0, -1) : line;
    if (!body.includes("\r")) {
      out.push(line);
      continue;
    }
    const frames = body.split("\r");
    // Empty final frame (e.g. "...\r") keeps the last non-empty frame: the
    // writer rewound the cursor but had not redrawn yet.
    let final = frames[frames.length - 1];
    if (final === "") {
      for (let i = frames.length - 1; i >= 0; i -= 1) {
        if (frames[i] !== "") {
          final = frames[i];
          break;
        }
      }
    }
    out.push(crlf ? `${final}\r` : final);
    out.push(crMarker(frames.length - 1));
    counts.folded += 1;
  }
  return out.join("\n");
}

/**
 * The ANSI route body: strip ECMA-48 sequences and stray C0 controls, then
 * collapse \r overwrites, outside fences only. Callers must have routed
 * through hasDangerousSequences first; this returns the input unchanged if
 * dangerous sequences are present (defense in depth).
 */
export function stripAnsi(text: string, counts: MarkerCounts): string {
  if (hasDangerousSequences(text)) return text;
  return mapUnfenced(text, segment => collapseCrOverwrites(stripEscapes(segment), counts));
}
