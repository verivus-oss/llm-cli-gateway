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
/**
 * True when the text contains sequences that make lexical stripping unsafe
 * (a terminal UI recording rather than a log): cursor movement, scrolling,
 * erase-in-display, any DEC private-mode set/reset (alt-screen and cursor
 * addressing live here), or backspace overwrites. Private modes are matched
 * broadly (any `?`-prefixed parameter with an h/l final, including combined
 * lists like `?1049;25h`) because "correctness beats savings": a private
 * mode we cannot cheaply prove benign is treated as dangerous (identity).
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
    if ((final === "h" || final === "l") && params.includes("?")) {
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

// Column overlay is only safe when every character is one display column
// wide (7-bit ASCII printable). Wide chars (CJK), zero-width combining marks,
// and emoji make UTF-16-index overlay lossy, so a CR line containing any
// non-ASCII byte is left unchanged rather than risk dropping content.
// \r (frame separator) and \t are allowed alongside printable ASCII; the
// visible frame characters must all be single-column ASCII.
const ASCII_ONLY = /^[\x09\x0d\x20-\x7e]*$/;

/**
 * Compute the visible line produced by carriage-return overwrites on an
 * ASCII-only line. A CR moves the cursor to column 0 WITHOUT clearing, so each
 * frame's characters overwrite from column 0 and any columns a later (shorter)
 * frame does not reach retain the earlier frame's character. E.g.
 * "abcdef\rXY" renders as "XYcdef", not "XY" (keeping only the last segment
 * would be content loss).
 */
function overlayFrames(frames: string[]): string {
  const cells: string[] = [];
  for (const frame of frames) {
    for (let i = 0; i < frame.length; i += 1) cells[i] = frame[i];
  }
  return cells.join("");
}

/** Collapse the CR overwrites in one already-escape-stripped line, appending
 * the counted sentinel when any internal \r was present. Non-ASCII bodies are
 * left byte-identical (overlay by code unit would be column-inaccurate). */
function collapseLine(line: string, out: string[], counts: MarkerCounts): void {
  const crlf = line.endsWith("\r");
  const body = crlf ? line.slice(0, -1) : line;
  if (!body.includes("\r")) {
    out.push(line);
    return;
  }
  if (!ASCII_ONLY.test(body)) {
    // Cannot compute display columns cheaply; keep the raw line (identity).
    out.push(line);
    return;
  }
  const frames = body.split("\r");
  const visible = overlayFrames(frames);
  out.push(crlf ? `${visible}\r` : visible);
  out.push(crMarker(frames.length - 1));
  counts.folded += 1;
}

// Split a segment into alternating [non-code, inline-code, non-code, ...]
// pieces (odd indices are backtick-delimited spans). Matches the optimizer's
// inline-code convention so ANSI is stripped only OUTSIDE inline code.
const INLINE_CODE = /(`[^`]*`)/g;

/**
 * The ANSI route body (outside fenced blocks): strip ECMA-48 sequences and
 * stray C0 controls OUTSIDE inline code spans, then collapse \r overwrites per
 * line. Escape-stripping runs over whole non-code pieces (not per line) so a
 * multi-line OSC/DCS string is matched and removed as one control string.
 * Inline code spans (backtick-delimited) and lines containing a backtick are
 * left byte-identical (spec 6.7). Callers must have routed through
 * hasDangerousSequences first; this returns the input unchanged if dangerous
 * sequences are present (defense in depth).
 */
export function stripAnsi(text: string, counts: MarkerCounts): string {
  if (hasDangerousSequences(text)) return text;
  return mapUnfenced(text, segment => {
    // Strip escapes only in the non-inline-code pieces, over the whole piece
    // so multi-line string sequences (OSC/DCS) are handled correctly.
    const stripped = segment
      .split(INLINE_CODE)
      .map((piece, i) => (i % 2 === 1 ? piece : stripEscapes(piece)))
      .join("");
    // CR-collapse per line; a line carrying inline code is left untouched.
    const out: string[] = [];
    for (const line of stripped.split("\n")) {
      if (line.includes("`")) {
        out.push(line);
        continue;
      }
      collapseLine(line, out, counts);
    }
    return out.join("\n");
  });
}
