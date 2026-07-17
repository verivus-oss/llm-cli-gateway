export type ReviewIntegrityViolationType =
  "empty_allowed_tools" | "critical_tools_disallowed" | "tool_suppression";

export interface ReviewIntegrityViolation {
  type: ReviewIntegrityViolationType;
  score: number;
  detail: string;
}

export interface ReviewIntegrityResult {
  isReviewContext: boolean;
  violations: ReviewIntegrityViolation[];
  totalScore: number;
}

export interface ReviewIntegrityInput {
  prompt: string;
  allowedTools?: string[];
  disallowedTools?: string[];
}

const REVIEW_CONTEXT_PATTERN =
  /\b(review|audit|analy[sz]e|analysis|inspect|assess|pentest|security|vulnerabilit(?:y|ies)|bug(?:s)?|defect(?:s)?|quality|code\s+review)\b/i;

// Any character that does not end the current sentence, so a match cannot span
// a sentence boundary or a paragraph break. Single newlines stay allowed
// because prompts wrap mid-sentence.
//
// Why this matters: the earlier pattern was a bare negation within 80
// characters of a tool-ish noun, which glued unrelated sentences together. It
// reported "do not take the packet's word.\n\nNote: a local `rtk` shell" as
// tool suppression, which is exactly backwards: that text tells the reviewer to
// verify independently and warns that a shell proxy can fake success. A
// detector that fires on instructions to be MORE rigorous trains its readers to
// ignore it.
//
// A sentence boundary is end punctuation, then any run of closing Markdown
// emphasis (backtick, asterisk, underscore, tilde), then EITHER whitespace, any
// opening markup/quote delimiters, and a capitalised new-sentence start, OR end
// of text; a blank line also ends a sentence. Anchoring on the capital, via an
// inline case-sensitive group so the outer /i flag does not fold it, is what
// lets the detector tell a real sentence end from a period inside inline markup
// mid-sentence:
//   "trust **summary.** Use the tools"    -> boundary (capital U after closers),
//                                            so "do not" cannot glue to "Use".
//   "summary. **Use the tools.**"         -> boundary (opening ** then capital U).
//   "do not use the `foo.**` shell here"  -> NOT a boundary (lowercase "shell"),
//                                            so this real suppression still fires.
// Doubled markup closes too (** __ ~~), because the closer run is `*`, not `?`.
// The backtick is written as \x60 because a literal backtick would close this
// String.raw template. The closer class and the following \s are disjoint, so
// the run cannot backtrack pathologically.
//
// This is a bounded heuristic, not a parser, with a residual in BOTH directions:
// an adversary who controls the prompt can capitalise a continuation to force a
// false boundary (a missed suppression), and a genuine sentence that begins with
// a lowercase word ("... files. rely on the tool ...") is read as a continuation
// and can over-flag. Both are accepted because review-integrity is defence-in-
// depth scoring, not a hard gate, and closing either needs real sentence parsing.
const SENTENCE_CHAR = String.raw`(?:(?![.!?]["'”’)\]\x60*_~]*(?:\s+["'“‘([*_~\x60]*(?-i:[A-Z])|\s*$)|\n\s*\n)[\s\S])`;
// The negation has to actually govern using a tool, so require a use verb
// between the two. "without" is kept as a second shape because it governs a
// noun on its own ("review this without tools"). The verb list is a curated
// synonym set rather than a wildcard, so it must carry the common ways an
// orchestrator phrases "operate a tool": use/call/invoke/run/execute/access/
// touch plus issue/employ/utilise/leverage and the two multi-word forms
// rely on / resort to. Both spellings of utilise/utilize are covered via
// `utili[sz]`, matching the repo's British-spelling convention. This is a
// recall/precision trade: passive phrasings ("no tools should be used") are
// deliberately out of scope because matching them without a governing
// negation-verb-noun order invites false positives.
const TOOL_USE_VERB = String.raw`(?:us(?:e|ing)|call(?:ing)?|invok(?:e|ing)|run(?:ning)?|execut(?:e|ing)|access(?:ing)?|touch(?:ing)?|issu(?:e|ing)|employ(?:ing)?|utili[sz](?:e|ing)|leverag(?:e|ing)|rely(?:ing)?\s+on|resort(?:ing)?\s+to)`;
const TOOL_NOUN = String.raw`(?:tool(?:s)?|shell|bash|command(?:s)?)`;
const TOOL_SUPPRESSION_PATTERN = new RegExp(
  [
    String.raw`\b(?:do\s*not|don['’]t|never)\b`,
    `${SENTENCE_CHAR}{0,40}?`,
    String.raw`\b${TOOL_USE_VERB}\b`,
    `${SENTENCE_CHAR}{0,40}?`,
    String.raw`\b${TOOL_NOUN}\b`,
    "|",
    String.raw`\bwithout\b`,
    `${SENTENCE_CHAR}{0,40}?`,
    String.raw`\b${TOOL_NOUN}\b`,
  ].join(""),
  "i"
);

// One token of the inline stream: a run of L backticks (canOpen is false when it
// was escaped by an odd backslash run, so it may close a span but not open one,
// matching CommonMark's opener/closer asymmetry), or literal text.
type InlineToken = { btrun: true; len: number; canOpen: boolean } | { btrun: false; text: string };

// Normalise a code span's literal content: keep the WORDS (a verb or noun
// written as code is still seen), turn `*`/`~` and inner backticks into spaces,
// blank INTERNAL sentence punctuation so literal code cannot forge a boundary,
// and keep only TRAILING sentence punctuation so a span that genuinely ends a
// sentence ("... trust the `summary.` Use") still reads as two. `_` is a word
// character and is left alone: an identifier like `use_shell` must stay one word
// so it is not read as the keyword "use".
function normaliseCodeSpanContent(content: string): string {
  const cleaned = content.replace(/[`*~]/g, " ").replace(/\s+$/, "");
  const trailing = /[.!?]+$/.exec(cleaned);
  const end = trailing ? trailing[0] : "";
  return cleaned.slice(0, cleaned.length - end.length).replace(/[.!?]/g, " ") + end;
}

// Inline-markup normaliser, run before the suppression scan. A prompt is
// Markdown, and markers around or inside a suppression were a long tail of both
// false positives (markup faking a sentence boundary, "**summary.** Use") and
// false negatives (markup hiding the verb or noun, "do not `use` the shell").
// Rather than encode Markdown in the detection regex one edge at a time,
// normalise once. This is a real tokenizer:
//
//   - Phase 1 tokenizes the prompt. Backslash escapes are resolved with parity
//     (an odd run of backslashes escapes a following backtick, an even run does
//     not, per GFM) and non-escaping backslashes are kept literal; `*`/`~`
//     become spaces so nothing welds or tears; an underscore run is kept when it
//     is intraword (a literal identifier like `use_shell`) and spaced otherwise
//     (GFM emphasis like `_use_`), following GFM's intraword-underscore rule.
//   - Phase 2 links each backtick run to the next run of the SAME length in one
//     right-to-left pass. This is what keeps the whole function O(n): an
//     unmatched run costs O(1), not a rescan of the tail, so adversarial
//     backtick soup cannot make it quadratic.
//   - Phase 3 matches spans greedily (an unescaped run of L opens a span that
//     closes at the next run of L, escaped or not, mirroring CommonMark's rule
//     that escapes do not operate inside a code span) and emits: matched span
//     content is normalised and padded with spaces, an unmatched or escaped run
//     becomes spaces.
//
// The result feeds TOOL_SUPPRESSION_PATTERN, so the markup classes inside
// SENTENCE_CHAR are now a backstop, not the primary defence.
//
// Residuals (accepted, defence-in-depth scoring, not hide paths that a config
// author hits by accident): a code span whose literal content holds an internal
// sentence break ("`this. Use`"), a genuine lowercase sentence start, an
// adversary who splits a keyword across markup ("u`s`e", "*u*s*e*"), and a
// backslash escaping only the FIRST backtick of a multi-backtick run (the run is
// treated whole). Closing those needs a full CommonMark render, disproportionate
// for a score-4 scorer.
export function neutraliseInlineMarkup(prompt: string): string {
  const tokens: InlineToken[] = [];
  let buf: string[] = [];
  const flush = (): void => {
    if (buf.length) {
      tokens.push({ btrun: false, text: buf.join("") });
      buf = [];
    }
  };
  const n = prompt.length;
  let i = 0;
  let escapePending = false;
  while (i < n) {
    const ch = prompt[i];
    if (ch === "\\") {
      let b = i;
      while (b < n && prompt[b] === "\\") b++;
      const count = b - i;
      // Keep literal backslashes as themselves, not spaces: a stray `do\not`
      // must not synthesise the negation `do not`. An odd run escapes a
      // following backtick, which then may still CLOSE a span (escapes do not
      // operate inside code spans) but not OPEN one, so mark it and let the
      // backtick branch record canOpen rather than consuming the backtick here.
      buf.push("\\".repeat(count));
      i = b;
      escapePending = count % 2 === 1 && i < n && prompt[i] === "`";
      continue;
    }
    if (ch === "`") {
      let j = i;
      while (j < n && prompt[j] === "`") j++;
      flush();
      tokens.push({ btrun: true, len: j - i, canOpen: !escapePending });
      escapePending = false;
      i = j;
      continue;
    }
    if (ch === "_") {
      // GFM does not open emphasis on an intraword underscore, so a run of `_`
      // flanked by word characters on both sides is a literal identifier
      // (use_shell, without_tools) and is kept; otherwise it is emphasis and
      // becomes a space, restoring detection of `_use_` / `__shell__`.
      let u = i;
      while (u < n && prompt[u] === "_") u++;
      const before = i > 0 ? prompt[i - 1] : "";
      const after = u < n ? prompt[u] : "";
      const intraword = /\w/.test(before) && /\w/.test(after);
      buf.push(intraword ? prompt.slice(i, u) : " ".repeat(u - i));
      i = u;
      continue;
    }
    if (ch === "*" || ch === "~") {
      buf.push(" ");
      i++;
      continue;
    }
    buf.push(ch);
    i++;
  }
  flush();

  const nextSame = new Map<number, number>();
  const lastByLen = new Map<number, number>();
  for (let t = tokens.length - 1; t >= 0; t--) {
    const tok = tokens[t];
    if (!tok.btrun) continue;
    nextSame.set(t, lastByLen.has(tok.len) ? (lastByLen.get(tok.len) as number) : -1);
    lastByLen.set(tok.len, t);
  }

  const out: string[] = [];
  let t = 0;
  while (t < tokens.length) {
    const tok = tokens[t];
    if (!tok.btrun) {
      out.push(tok.text);
      t++;
      continue;
    }
    if (!tok.canOpen) {
      // An escaped backtick run cannot open a span; it is literal here (it may
      // still have served as a closer for an earlier opener, in which case this
      // token was skipped over).
      out.push(" ".repeat(tok.len));
      t++;
      continue;
    }
    const close = nextSame.get(t);
    if (close === undefined || close === -1) {
      out.push(" ".repeat(tok.len));
      t++;
      continue;
    }
    let content = "";
    for (let u = t + 1; u < close; u++) {
      const inner = tokens[u];
      content += inner.btrun ? "`".repeat(inner.len) : inner.text;
    }
    out.push(" ", normaliseCodeSpanContent(content), " ");
    t = close + 1;
  }
  return out.join("");
}

const CRITICAL_TOOLS = ["Read", "Grep", "Glob", "Bash"];

function canonicalizeTools(tools: string[]): string[] {
  return tools
    .map(raw => raw.trim())
    .filter(Boolean)
    .map(trimmed => {
      const cut = Math.min(
        ...[trimmed.indexOf("("), trimmed.indexOf(":"), trimmed.length].filter(i => i >= 0)
      );
      return trimmed.slice(0, cut).trim();
    });
}

export function isReviewContext(prompt: string): boolean {
  return REVIEW_CONTEXT_PATTERN.test(prompt);
}

export function checkReviewIntegrity(input: ReviewIntegrityInput): ReviewIntegrityResult {
  const violations: ReviewIntegrityViolation[] = [];
  const reviewContext = isReviewContext(input.prompt);

  if (reviewContext && input.allowedTools && input.allowedTools.length === 0) {
    violations.push({
      type: "empty_allowed_tools",
      score: 6,
      detail: "Review request with empty allowedTools limits reviewer capability",
    });
  }

  if (reviewContext && input.disallowedTools && input.disallowedTools.length > 0) {
    const canonical = canonicalizeTools(input.disallowedTools);
    const blockedCritical = CRITICAL_TOOLS.filter(tool => canonical.includes(tool));
    if (blockedCritical.length > 0) {
      violations.push({
        type: "critical_tools_disallowed",
        score: 6,
        detail: `Critical review tools disallowed: ${blockedCritical.join(", ")}`,
      });
    }
  }

  if (reviewContext && TOOL_SUPPRESSION_PATTERN.test(neutraliseInlineMarkup(input.prompt))) {
    violations.push({
      type: "tool_suppression",
      score: 4,
      detail: "Prompt contains tool-suppression language in review context",
    });
  }

  return {
    isReviewContext: reviewContext,
    violations,
    totalScore: violations.reduce((sum, violation) => sum + violation.score, 0),
  };
}
