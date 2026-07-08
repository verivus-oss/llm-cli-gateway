/**
 * Whitespace transform + the shared fence-protection helper (spec 6.7).
 *
 * Bytes inside fenced code blocks and inline code spans are untouchable in
 * EVERY transform (spec C3 / 6.7), so the fence splitter lives here and is
 * imported by the other transforms and the escaping pass. This hardens the
 * approach of the existing optimizer (src/optimizer.ts fence regex) rather
 * than inventing a second dialect: tilde fences, fence info strings, and
 * unclosed-fence safety (everything after an unclosed opener is fenced).
 */

export interface FenceSegment {
  text: string;
  fenced: boolean;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Split text into alternating unfenced/fenced segments, line-oriented.
 * A fence closes only on a line whose fence marker uses the same character
 * and is at least as long as the opener (CommonMark rule). An unclosed fence
 * runs to the end of the text. Segments preserve their bytes exactly;
 * concatenating segment texts reproduces the input.
 */
export function splitFences(text: string): FenceSegment[] {
  const segments: FenceSegment[] = [];
  const lines = text.split("\n");
  let current: string[] = [];
  let fenced = false;
  let fenceMarker = "";

  const flush = (nextFenced: boolean): void => {
    if (current.length > 0) {
      segments.push({ text: current.join("\n"), fenced });
      current = [];
    }
    fenced = nextFenced;
  };

  for (const line of lines) {
    if (!fenced) {
      const open = FENCE_OPEN.exec(line);
      if (open) {
        flush(true);
        fenceMarker = open[1];
        current.push(line);
        continue;
      }
      current.push(line);
    } else {
      current.push(line);
      const marker = FENCE_OPEN.exec(line);
      if (
        marker &&
        marker[1][0] === fenceMarker[0] &&
        marker[1].length >= fenceMarker.length &&
        line.trim() === marker[1]
      ) {
        flush(false);
      }
    }
  }
  flush(false);
  return segments;
}

/** Re-join segments produced by splitFences after per-segment editing. */
export function joinFences(segments: FenceSegment[]): string {
  return segments.map(s => s.text).join("\n");
}

/**
 * Map an operation over the unfenced segments only; fenced segments pass
 * through byte-for-byte. The operation receives and returns whole segment
 * texts (line boundaries preserved by the caller's own logic).
 */
export function mapUnfenced(text: string, op: (segment: string) => string): string {
  const segments = splitFences(text);
  return joinFences(segments.map(s => (s.fenced ? s : { ...s, text: op(s.text) })));
}

/**
 * Whitespace normalization (Tier P, spec 6.7): strip trailing spaces/tabs and
 * collapse runs of 3+ blank lines to 1, outside fences only. Lines containing
 * a backtick are left entirely untouched so inline code spans (including any
 * trailing whitespace inside them) are never altered; this is deliberately
 * conservative per the router's identity-on-doubt policy.
 */
export function normalizeWhitespace(text: string): string {
  return mapUnfenced(text, segment => {
    const lines = segment.split("\n").map(line => {
      if (line.includes("`")) return line;
      // Preserve a CRLF artifact: strip trailing spaces/tabs but keep a
      // final \r that belongs to the line ending.
      const crlf = line.endsWith("\r");
      const body = crlf ? line.slice(0, -1) : line;
      const stripped = body.replace(/[ \t]+$/, "");
      return crlf ? `${stripped}\r` : stripped;
    });

    const out: string[] = [];
    let blankRun = 0;
    // Collapse a run of 3+ blank lines to a single blank line, keeping the
    // FIRST blank line's exact bytes so a CRLF blank ("\r") is not silently
    // rewritten to a bare LF line (which would corrupt CRLF line endings).
    const collapse = (): void => {
      if (blankRun < 3) return;
      const keep = out[out.length - blankRun];
      out.splice(out.length - blankRun, blankRun, keep);
    };
    for (const line of lines) {
      const isBlank = line === "" || line === "\r";
      if (isBlank) {
        blankRun += 1;
        out.push(line);
        continue;
      }
      collapse();
      blankRun = 0;
      out.push(line);
    }
    collapse();
    return out.join("\n");
  });
}
