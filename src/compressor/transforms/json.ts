/**
 * JSON transform: token-preserving whitespace-only minifier (spec 6.3).
 *
 * NEVER JSON.parse + JSON.stringify: that loses -0, big-integer precision,
 * exponent spelling, integer-like key order, and escape spelling. This is a
 * validating recursive-descent pass that copies every token byte-for-byte
 * (strings including their escape spelling, numbers as spelled, literals)
 * and drops only inter-token whitespace. No key sorting. Any lex/grammar
 * error returns null and the caller falls back to identity (Tier B).
 */

interface Cursor {
  text: string;
  pos: number;
  out: string[];
}

const WS = new Set([" ", "\t", "\n", "\r"]);

function skipWs(c: Cursor): void {
  while (c.pos < c.text.length && WS.has(c.text[c.pos])) c.pos += 1;
}

function fail(): never {
  throw new SyntaxError("json-minify: not valid JSON");
}

function copyString(c: Cursor): void {
  const start = c.pos;
  if (c.text[c.pos] !== '"') fail();
  c.pos += 1;
  while (c.pos < c.text.length) {
    const ch = c.text[c.pos];
    if (ch === "\\") {
      c.pos += 2;
      continue;
    }
    if (ch === '"') {
      c.pos += 1;
      c.out.push(c.text.slice(start, c.pos));
      return;
    }
    // Raw control characters are invalid inside JSON strings.
    if (ch.charCodeAt(0) < 0x20) fail();
    c.pos += 1;
  }
  fail();
}

const NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/;

function copyNumber(c: Cursor): void {
  const match = NUMBER.exec(c.text.slice(c.pos));
  if (!match || match[0].length === 0) fail();
  c.out.push(match[0]);
  c.pos += match[0].length;
}

function copyLiteral(c: Cursor, word: "true" | "false" | "null"): void {
  if (c.text.startsWith(word, c.pos)) {
    c.out.push(word);
    c.pos += word.length;
    return;
  }
  fail();
}

function copyValue(c: Cursor): void {
  skipWs(c);
  const ch = c.text[c.pos];
  if (ch === undefined) fail();
  if (ch === "{") {
    c.out.push("{");
    c.pos += 1;
    skipWs(c);
    if (c.text[c.pos] === "}") {
      c.out.push("}");
      c.pos += 1;
      return;
    }
    for (;;) {
      skipWs(c);
      copyString(c);
      skipWs(c);
      if (c.text[c.pos] !== ":") fail();
      c.out.push(":");
      c.pos += 1;
      copyValue(c);
      skipWs(c);
      if (c.text[c.pos] === ",") {
        c.out.push(",");
        c.pos += 1;
        continue;
      }
      if (c.text[c.pos] === "}") {
        c.out.push("}");
        c.pos += 1;
        return;
      }
      fail();
    }
  }
  if (ch === "[") {
    c.out.push("[");
    c.pos += 1;
    skipWs(c);
    if (c.text[c.pos] === "]") {
      c.out.push("]");
      c.pos += 1;
      return;
    }
    for (;;) {
      copyValue(c);
      skipWs(c);
      if (c.text[c.pos] === ",") {
        c.out.push(",");
        c.pos += 1;
        continue;
      }
      if (c.text[c.pos] === "]") {
        c.out.push("]");
        c.pos += 1;
        return;
      }
      fail();
    }
  }
  if (ch === '"') {
    copyString(c);
    return;
  }
  if (ch === "t") {
    copyLiteral(c, "true");
    return;
  }
  if (ch === "f") {
    copyLiteral(c, "false");
    return;
  }
  if (ch === "n") {
    copyLiteral(c, "null");
    return;
  }
  if (ch === "-" || (ch >= "0" && ch <= "9")) {
    copyNumber(c);
    return;
  }
  fail();
}

/**
 * Minify a complete JSON document, preserving every token byte-for-byte.
 * Returns null when the input is not a single valid JSON document (the
 * caller must then return the input unchanged).
 */
export function minifyJson(text: string): string | null {
  const c: Cursor = { text, pos: 0, out: [] };
  try {
    copyValue(c);
    skipWs(c);
    if (c.pos !== text.length) return null;
    return c.out.join("");
  } catch {
    return null;
  }
}
