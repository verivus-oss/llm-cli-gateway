import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { compressDisplayText, NativeCompressor, type CompressCtx } from "../compressor/index.js";
import { classify } from "../compressor/router.js";
import { minifyJson } from "../compressor/transforms/json.js";
import {
  splitFences,
  normalizeWhitespace,
  mapUnfenced,
} from "../compressor/transforms/whitespace.js";
import {
  dedupAdjacentLines,
  escapeSentinelLikeLines,
  LIT_MARKER,
  type MarkerCounts,
} from "../compressor/transforms/log.js";
import { stripAnsi, hasDangerousSequences } from "../compressor/transforms/ansi.js";
import {
  estimateTokensForRoute,
  estimateTokensSaved,
  setDevTokenizer,
} from "../compressor/estimate.js";

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "compressor"
);

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), "utf8");
}

const OUTBOUND: CompressCtx = {
  provider: "claude",
  direction: "outbound",
  outputFormat: "text",
  outputSchemaDeclared: false,
  lossless: true,
};

// Decode the lit-escape rule (spec 6.4): strip exactly ONE marker prefix per
// line. The inverse of escapeSentinelLikeLines, used to prove bijectivity.
function decodeLit(text: string): string {
  return text
    .split("\n")
    .map(line => (line.startsWith(LIT_MARKER) ? line.slice(LIT_MARKER.length) : line))
    .join("\n");
}

// Expand repeat sentinels back to the original line multiset (spec matrix 5).
function expandRepeats(text: string): string {
  const out: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const marker = /^\[\[gateway-repeat:v1 lines=(\d+) count=(\d+)\]\]$/.exec(lines[i]);
    if (marker && out.length > 0) {
      const blockLines = Number(marker[1]);
      const count = Number(marker[2]);
      const block = out.slice(out.length - blockLines);
      for (let c = 1; c < count; c += 1) out.push(...block);
      continue;
    }
    out.push(lines[i]);
  }
  return out.join("\n");
}

describe("json transform (Tier B, spec 6.3)", () => {
  it("minifies pretty JSON and preserves every token byte-for-byte", () => {
    const src = fixture("pretty.json");
    const min = minifyJson(src.trim());
    expect(min).not.toBeNull();
    // Token preservation the round-trip deep-equality gate cannot catch:
    expect(min).toContain("-0"); // negative zero survives
    expect(min).toContain("9007199254740993"); // big integer, no precision loss
    expect(min).toContain("1.5e10"); // exponent spelling unchanged
    expect(min).toContain('"line1\\nline2\\ttabbed A and \\\\ backslash"'); // escape spelling
    // No inter-token whitespace remains.
    expect(min).not.toMatch(/: /);
    expect(min).not.toContain("\n");
    // Integer-like key order is preserved (2,1,10 as written, not sorted).
    expect(min!.indexOf('"2"')).toBeLessThan(min!.indexOf('"1"'));
    expect(min!.indexOf('"1"')).toBeLessThan(min!.indexOf('"10"'));
  });

  it("returns null (identity) on any lex error", () => {
    expect(minifyJson("{not: json}")).toBeNull();
    expect(minifyJson('{"a":1} trailing')).toBeNull();
    expect(minifyJson('{"a":')).toBeNull();
    expect(minifyJson("")).toBeNull();
    expect(minifyJson('{"a": 01}')).toBeNull(); // leading zero invalid
  });

  it("handles duplicate keys without reordering or dropping", () => {
    const min = minifyJson('{"a": 1, "a": 2}');
    expect(min).toBe('{"a":1,"a":2}');
  });
});

describe("router (spec 6.2)", () => {
  it("routes structural JSON to json", () => {
    expect(classify(fixture("pretty.json"))).toBe("json");
  });

  it("keeps prose that merely quotes JSON on the plain/log route", () => {
    const prose = 'The server returned {"ok": true} which we then logged.';
    expect(classify(prose)).not.toBe("json");
  });

  it("routes ANSI/progress content to ansi-text", () => {
    expect(classify(fixture("ansi-progress.txt"))).toBe("ansi-text");
  });

  it("returns identity for alt-screen / cursor-movement content", () => {
    expect(classify(fixture("ansi-altscreen.txt"))).toBe("identity");
  });

  it("routes repeated-line logs to log", () => {
    expect(classify(fixture("repeated-log.txt"))).toBe("log");
  });

  it("returns identity for empty input", () => {
    expect(classify("")).toBe("identity");
  });
});

describe("log dedup + sentinel grammar (Tier F, spec 6.4/6.5)", () => {
  it("folds runs of 3+ identical lines and expands back to the multiset", () => {
    const counts: MarkerCounts = { folded: 0, escaped: 0 };
    const src = fixture("repeated-log.txt");
    const folded = dedupAdjacentLines(src, counts);
    expect(counts.folded).toBeGreaterThan(0);
    expect(folded.length).toBeLessThan(src.length);
    expect(expandRepeats(folded)).toBe(src);
  });

  it("leaves runs of 2 alone (below MIN_RUN)", () => {
    const counts: MarkerCounts = { folded: 0, escaped: 0 };
    const src = "x\ny\ny\nz\n";
    expect(dedupAdjacentLines(src, counts)).toBe(src);
    expect(counts.folded).toBe(0);
  });

  it("lit-escaping is a per-line bijection (single, self-sentinel, multi-line)", () => {
    for (const src of [
      "[[gateway-repeat:v1 lines=1 count=5]]",
      "[[gateway-repeat:v1 lines=1 count=5]]\n[[gateway-cr:v1 frames=3]]",
      `${LIT_MARKER}already escaped`,
      "normal line\n  [[gateway-note:v1]] indented sentinel\nanother",
    ]) {
      const counts: MarkerCounts = { folded: 0, escaped: 0 };
      const escaped = escapeSentinelLikeLines(src, counts);
      expect(counts.escaped).toBeGreaterThan(0);
      expect(decodeLit(escaped)).toBe(src);
    }
  });

  it("does not escape sentinel-like lines inside fenced code blocks", () => {
    const counts: MarkerCounts = { folded: 0, escaped: 0 };
    const src = "before\n```\n[[gateway-repeat:v1 lines=1 count=2]]\n```\nafter\n";
    const escaped = escapeSentinelLikeLines(src, counts);
    expect(counts.escaped).toBe(0);
    expect(escaped).toBe(src);
  });
});

describe("ansi transform (Tier P + CR fold, spec 6.6)", () => {
  it("strips escapes and collapses carriage-return progress frames", () => {
    const counts: MarkerCounts = { folded: 0, escaped: 0 };
    const out = stripAnsi(fixture("ansi-progress.txt"), counts);
    expect(out).not.toContain("\x1b");
    expect(out).toContain("Downloading 100%");
    expect(out).not.toContain("Downloading 25%");
    expect(out).toContain("[[gateway-cr:v1");
    // OSC 8 hyperlink escapes are stripped but the visible label survives.
    expect(out).toContain("view run");
  });

  it("flags cursor-movement and alt-screen content as dangerous", () => {
    expect(hasDangerousSequences(fixture("ansi-altscreen.txt"))).toBe(true);
    expect(hasDangerousSequences(fixture("ansi-progress.txt"))).toBe(false);
  });
});

describe("whitespace transform + fence protection (Tier P, spec 6.7)", () => {
  it("splitFences round-trips byte-for-byte", () => {
    const src = fixture("claude-markdown.txt");
    expect(
      splitFences(src)
        .map(s => s.text)
        .join("\n")
    ).toBe(src);
  });

  it("leaves fenced bytes untouched while stripping outside them", () => {
    const src = fixture("claude-markdown.txt");
    const out = normalizeWhitespace(src);
    // The fenced code block (with its load-bearing double space) survives.
    expect(out).toContain("JSON.stringify(sessions, null, 2)");
    expect(out).toContain("  const tmp = `${SESSIONS_PATH}.${process.pid}.tmp`;");
  });

  it("collapses 3+ blank lines to 1 and strips trailing whitespace outside fences", () => {
    const out = normalizeWhitespace(fixture("gemini-plain.txt"));
    expect(out).not.toMatch(/\n{3,}/);
    expect(out).not.toMatch(/[ \t]+\n/);
  });

  it("preserves trailing whitespace AND blank runs INSIDE a fence byte-for-byte", () => {
    // A fenced block that itself contains the exact features the transform
    // strips outside fences: trailing spaces and a 4-blank-line run. These
    // must survive verbatim, or a normalizeWhitespace-only fence regression
    // (that the shared mapUnfenced tests would miss) slips through.
    const fenced = "```\nindented code   \nwith trailing tab\t\n\n\n\n\nafter four blanks\n```";
    const src = `prose before   \n\n\n\n\n${fenced}\nprose after   \n`;
    const out = normalizeWhitespace(src);
    // The entire fenced region is untouched.
    expect(out).toContain(fenced);
    // Outside the fence, trailing whitespace and the blank run were normalized.
    expect(out.startsWith("prose before\n\n")).toBe(true);
    expect(out).not.toMatch(/prose before[ \t]+\n/);
  });

  it("mapUnfenced never touches lines with inline code", () => {
    const src = "trailing   \n`inline  code  span`   \n";
    const out = normalizeWhitespace(src);
    expect(out).toContain("`inline  code  span`");
  });
});

describe("NativeCompressor.compact (spec 5.1 integration)", () => {
  it("bypasses to identity when outputFormat is json", () => {
    const src = fixture("pretty.json");
    const r = compressDisplayText(src, { ...OUTBOUND, outputFormat: "json" });
    expect(r.text).toBe(src);
    expect(r.route).toBe("identity");
  });

  it("bypasses to identity when an output schema is declared", () => {
    const src = fixture("pretty.json");
    const r = compressDisplayText(src, { ...OUTBOUND, outputSchemaDeclared: true });
    expect(r.text).toBe(src);
  });

  it("minifies JSON with no markers or note on the json route", () => {
    const r = compressDisplayText(fixture("pretty.json"), OUTBOUND);
    expect(r.route).toBe("json");
    expect(r.transforms).toEqual(["json-minify"]);
    expect(r.text).not.toContain("[[gateway-");
    expect(r.compressedChars).toBeLessThan(r.originalChars);
  });

  it("folds logs, escapes sentinel-like input, and leads with a note", () => {
    const r = compressDisplayText(fixture("repeated-log.txt"), OUTBOUND);
    expect(r.route).toBe("log");
    expect(r.text.startsWith("[[gateway-note:v1")).toBe(true);
    expect(r.compressedChars).toBeLessThan(r.originalChars);
  });

  it("escapes sentinel-like input and leads with a note when net savings hold", () => {
    // A sentinel-like line plus a large foldable run: compression fires with
    // net savings beyond the leading-note overhead, so the escape must be
    // present AND announced by the note (spec 6.4).
    const dupLine = "connection refused, retrying in 250ms exactly as before\n";
    const src = "[[gateway-repeat:v1 lines=1 count=9]]\n" + dupLine.repeat(40);
    const r = compressDisplayText(src, OUTBOUND);
    expect(r.text.startsWith("[[gateway-note:v1")).toBe(true);
    expect(r.text).toContain(LIT_MARKER);
    // The escaped line decodes back to the original sentinel-like content.
    expect(r.text).toContain(`${LIT_MARKER}[[gateway-repeat:v1 lines=1 count=9]]`);
  });

  it("returns identity (no note, no escape) when markers would cost more than saved", () => {
    // A lone sentinel-like line has nothing to compress; escaping+note would
    // inflate, so the raw text passes through unchanged. Safe and unambiguous:
    // gateway markers only ever appear alongside a leading note.
    const src = "[[gateway-repeat:v1 lines=1 count=9]]\njust one line\n";
    const r = compressDisplayText(src, OUTBOUND);
    expect(r.text).toBe(src);
    expect(r.text).not.toContain("[[gateway-note");
  });

  it("returns identity rather than inflating on unique short input", () => {
    const src = "unique line one\nunique line two\n";
    const r = compressDisplayText(src, OUTBOUND);
    expect(r.text).toBe(src);
  });

  it("never changes fenced bytes end-to-end", () => {
    const r = compressDisplayText(fixture("claude-markdown.txt"), OUTBOUND);
    expect(r.text).toContain(
      "  await writeFile(tmp, JSON.stringify(sessions, null, 2), { mode: 0o600 });"
    );
  });
});

describe("estimator (spec Section 8, C5)", () => {
  it("uses content-aware divisors, not words x 1.3", () => {
    const jsonText = fixture("pretty.json");
    const est = estimateTokensForRoute(jsonText, "json");
    // Divisor 3.0 for json; a words-based estimate would be far lower.
    expect(est).toBe(Math.ceil(jsonText.length / 3.0));
  });

  it("estimateTokensSaved is never negative", () => {
    expect(estimateTokensSaved("short", "a much longer string here", "plain")).toBe(0);
  });

  it("honors an injected dev tokenizer, then clears it", () => {
    setDevTokenizer(() => 7);
    expect(estimateTokensForRoute("anything", "plain")).toBe(7);
    setDevTokenizer(null);
    expect(estimateTokensForRoute("", "plain")).toBe(0);
  });
});

describe("provider fixture corpus (spec Section 9 promotion evidence)", () => {
  const compressor = new NativeCompressor();

  it("covers every provider fixture without throwing or inflating", () => {
    const files = readdirSync(FIXTURE_DIR).filter(f => !f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const file of files) {
      const src = fixture(file);
      const r = compressor.compact(src, OUTBOUND);
      // Never inflates (identity floor), and the result is deterministic.
      expect(r.compressedChars).toBeLessThanOrEqual(r.originalChars);
      expect(compressor.compact(src, OUTBOUND).text).toBe(r.text);
    }
  });
});
