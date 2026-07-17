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

// Detection runs per sentence, on the markup-normalised prompt. The suppression
// patterns below match WITHIN one sentence; `segmentSentences` (defined after
// the normaliser) splits the text first, so a negation in one sentence can never
// glue across a boundary to a permitting clause in the next.
//
// Why this matters: an earlier pattern was a bare negation within 80 characters
// of a tool-ish noun, which glued unrelated sentences together. It reported
// "do not take the packet's word.\n\nNote: a local `rtk` shell" as tool
// suppression, which is exactly backwards: that text tells the reviewer to
// verify independently and warns that a shell proxy can fake success. A detector
// that fires on instructions to be MORE rigorous trains its readers to ignore
// it. Segmenting also fixes the converse over-flag: a genuine lowercase sentence
// start ("... do not modify files. npm can use the shell ...") is now its own
// sentence, so the negation does not reach the permitting verb.
//
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
// Unicode-aware word boundary via lookarounds. JS `\b` is ASCII-only even under
// the /u flag, so a non-ASCII character next to a keyword forges a boundary:
// `\buse\b` matches the "use" inside "caféuse" because "é" is not an ASCII word
// char. The word-char class is letters/numbers/underscore plus combining marks
// (\p{M}, so a decomposed NFD "café" whose accent is U+0301 does not read as a
// boundary) plus format characters (\p{Cf}: zero-width joiner/non-joiner, soft
// hyphen and the like, which sit inside words and must not forge one either).
const WORD_CHAR = String.raw`[\p{L}\p{N}\p{M}\p{Cf}_]`;
const WB = String.raw`(?<!${WORD_CHAR})`;
const WA = String.raw`(?!${WORD_CHAR})`;
const uword = (body: string): string => `${WB}(?:${body})${WA}`;
const NEGATION = uword(String.raw`do\s*not|don['’]t|never`);
// Within one sentence: a negation that governs a tool-use verb that governs a
// tool noun. The 40-char windows keep the three parts in proximity so unrelated
// clauses in a long sentence do not glue. `[\s\S]` (not SENTENCE_CHAR) because
// the sentence has already been segmented, so there is no boundary to cross;
// the class is disjoint enough that the lazy quantifiers cannot backtrack
// pathologically. All flags include `u` for the Unicode boundary lookarounds.
const SUPPRESSION_VERB_NOUN = new RegExp(
  [
    NEGATION,
    String.raw`[\s\S]{0,40}?`,
    uword(TOOL_USE_VERB),
    String.raw`[\s\S]{0,40}?`,
    uword(TOOL_NOUN),
  ].join(""),
  "iu"
);
// "without" governs a tool noun on its own ("review this without tools").
const WITHOUT_NOUN = new RegExp(
  [uword("without"), String.raw`[\s\S]{0,40}?`, uword(TOOL_NOUN)].join(""),
  "iu"
);

// One token of the inline stream: a run of L backticks (canOpen is false when it
// was escaped by an odd backslash run, so it may close a span but not open one,
// matching CommonMark's opener/closer asymmetry), or literal text.
type InlineToken = { btrun: true; len: number; canOpen: boolean } | { btrun: false; text: string };

// A private-use sentinel marking a sentence terminator that ORIGINATED inside a
// code span. The segmenter treats it as a SOFT boundary (splits only before a
// capitalised next sentence), unlike a real prose terminator which is a hard
// boundary. This is what tells "... trust the `summary.` Use the tools" (a span
// period ending a real sentence, next word capitalised -> split, no false
// positive) from "... do not use the `foo.` shell" (a span period mid-clause
// before the lowercase tool noun -> no split, real suppression still fires).
// Prose periods do not get this treatment, so a genuine lowercase continuation
// ("... modify files. npm can use the shell") still splits and does not glue.
const SOFT_TERMINATOR = "\uE010";

// The full sentence-terminator set: ASCII plus fullwidth/ideographic. Shared so
// the code-span normaliser and the segmenter treat the SAME characters as
// sentence ends. An asymmetry here (the normaliser handling only ASCII while the
// segmenter also split on fullwidth) was a fail-open: a fullwidth period trailing
// a code span leaked as a hard boundary and hid a real suppression.
// A plain string (not String.raw) so the \u escapes resolve to the fullwidth /
// ideographic characters; the value is the regex char class "[.!?\uFF0E\u3002\uFF01\uFF1F]".
const TERMINATOR_CLASS = "[.!?\uFF0E\u3002\uFF01\uFF1F]";
const FULLWIDTH_TERMINATOR = /[\uFF0E\u3002\uFF01\uFF1F]/u;
const TERMINATOR_CHARS = new Set([".", "!", "?", "\uFF0E", "\u3002", "\uFF01", "\uFF1F"]);
const TERMINATOR_GLOBAL = new RegExp(TERMINATOR_CLASS, "gu");

// Normalise a code span's literal content: keep the WORDS (a verb or noun
// written as code is still seen), turn `*`/`~` and inner backticks into spaces,
// blank INTERNAL sentence punctuation so literal code cannot forge a boundary,
// and collapse any TRAILING sentence punctuation to a single soft terminator so
// a span that genuinely ends a sentence ("... trust the `summary.` Use") still
// reads as two while a span period before a lowercase tool noun does not split.
// `_` is a word character and is left alone: an identifier like `use_shell` must
// stay one word so it is not read as the keyword "use".
function normaliseCodeSpanContent(content: string): string {
  // trimEnd (not `/\s+$/`) and a backward scan for the trailing terminator run
  // (not `[class]+$`) so a long space or dot run inside a code span cannot make
  // this quadratic through regex backtracking. Uses the full terminator set
  // (ASCII + fullwidth/ideographic): otherwise a fullwidth period trailing a span
  // leaks into the stream as a HARD terminator and hides a suppression. Newlines
  // inside the span become spaces: a code span is inlined content, so a line
  // break inside it is a code wrap, not a sentence boundary the segmenter should
  // split on.
  const cleaned = content.replace(/[`*~\r\n]/g, " ").trimEnd();
  let end = cleaned.length;
  while (end > 0 && TERMINATOR_CHARS.has(cleaned[end - 1])) end--;
  const body = cleaned.slice(0, end).replace(TERMINATOR_GLOBAL, " ");
  return body + (end < cleaned.length ? SOFT_TERMINATOR : "");
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
// The result feeds `segmentSentences` and the per-sentence suppression
// patterns, so blanking a code span's internal punctuation is what keeps a
// literal like "`foo. Bar`" from forging a sentence boundary.
//
// Residuals (accepted, defence-in-depth scoring, not hide paths that a config
// author hits by accident): a code span whose literal content holds an internal
// sentence break ("`this. Use`") still reads as one sentence because its period
// is blanked; an adversary who splits a keyword across markup ("u`s`e",
// "*u*s*e*"); and a backslash escaping only the FIRST backtick of a
// multi-backtick run (the run is treated whole). A further recall residual: an
// ellipsis or repeated terminator run mid-suppression ("do not use... tools",
// "do not use!!! tools") is read as a sentence end, so that (contrived) phrasing
// is missed. Closing these needs a full CommonMark render, disproportionate for
// a score-4 scorer; a miss is acceptable where a false alarm on prose is not.
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
      // Word char per Unicode, not ASCII `\w`: a non-ASCII identifier like
      // `café_use` is one literal word, so its `_` must stay and it must not be
      // read as the keyword "use".
      const intraword =
        /[\p{L}\p{N}\p{M}\p{Cf}_]/u.test(before) && /[\p{L}\p{N}\p{M}\p{Cf}_]/u.test(after);
      buf.push(intraword ? prompt.slice(i, u) : " ".repeat(u - i));
      i = u;
      continue;
    }
    if (ch === "*" || ch === "~") {
      buf.push(" ");
      i++;
      continue;
    }
    if (ch === SOFT_TERMINATOR) {
      // Scrub any raw sentinel from the caller's text so an adversary cannot
      // inject a soft boundary to split a suppression's verb from its noun. Only
      // this module may mint the sentinel, via normaliseCodeSpanContent.
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

// ASCII plus fullwidth/ideographic sentence terminators (the shared
// TERMINATOR_CLASS), so a prompt that ends its sentences with the fullwidth /
// ideographic marks segments the same as one using `.!?`.
const SENTENCE_TERMINATOR = new RegExp(TERMINATOR_CLASS, "u");

// Abbreviations are NOT special-cased. A period after an abbreviation ("Inc.",
// "e.g.") is genuinely ambiguous between a sentence end and a mid-sentence use,
// and the two collide in both case directions: "Acme Inc. shell" (mid-sentence,
// lowercase next) vs "Acme Inc. npm can ..." (new sentence, lowercase next); or
// the metalinguistic "the abbreviation \"e.g.\" Shell access ..." (sentence-final)
// vs "use e.g. the shell" (mid-sentence). No regex heuristic can separate these
// without real parsing, and every heuristic tried flipped one class of error for
// another. So every abbreviation period is treated as an ordinary boundary. The
// only cost is a defence-in-depth MISS on the contrived phrasing of a suppression
// that embeds a sentence-internal abbreviation ("do not use e.g. the shell"); a
// miss is acceptable here, whereas false-flagging benign or metalinguistic prose
// (an instruction to be rigorous) is the worse fault this detector must avoid.

// A soft boundary (code-span-origin terminator) splits only when the next
// sentence is capitalised, optionally behind opening quote/bracket delimiters
// that survive normalisation. This is the old capital anchor, applied ONLY to
// soft terminators: it tells "`summary.` Use" (split, no false positive) from
// "`foo.` shell" (no split, real suppression fires), while prose periods split
// regardless of the next word's case (so "files. npm ..." still splits).
//
// Accepted residual (defence-in-depth, not a hard gate): a code span that ends
// in a period immediately before a CAPITALISED tool noun ("do not use the
// `foo.` Bash command") splits on the capital and misses that suppression. This
// is left as a documented fail-open rather than "fixed" by holding the boundary,
// because holding it fires on ordinary review-hygiene prose whose next sentence
// merely starts with a capitalised tool noun ("do not use the `rtk.` Shell
// proxy can fake success; verify independently"). Firing on an instruction to be
// MORE rigorous is the exact anti-pattern this detector exists to avoid, and a
// false alarm trains readers to ignore it; a rare miss on a contrived construct
// does not. Both directions need real parsing to separate, so the miss is the
// safer bias here.
const SOFT_BOUNDARY_NEXT = /^\s+["'“‘([]*\p{Lu}/u;

// Closing quotes/brackets that may sit between a terminator and the whitespace
// that ends a sentence, so a sentence ending inside quotes or parens
// ("... stale.") still splits and its negation cannot glue to the next clause.
const SENTENCE_CLOSERS = /["'”’)\]]/u;

// Split markup-normalised prompt text into sentences. An ASCII HARD terminator
// (`.!?`) ends a sentence when followed by optional closing quotes/brackets then
// whitespace or end-of-text. There are no exceptions: abbreviations, initials
// ("Inc.", "e.g.", "A.") and decimals are all ordinary boundaries (a real
// decimal "2.1" has no trailing space, so it is never a boundary candidate). A
// fullwidth/ideographic terminator always ends a sentence (CJK typography puts
// no space after it). A SOFT terminator (minted only for a code span's trailing
// punctuation) ends a sentence only before a capitalised next sentence.
// Splitting on real terminators is what makes "do not modify files. npm can use
// the shell" two sentences, so the negation cannot reach the permitting verb.
// O(n): every slice is bounded, so each index costs O(1).
function segmentSentences(text: string): string[] {
  const sentences: string[] = [];
  const n = text.length;
  let start = 0;
  let i = 0;
  const emit = (end: number): void => {
    sentences.push(text.slice(start, end));
    let k = end;
    while (k < n && /\s/.test(text[k])) k++;
    start = k;
    i = k;
  };
  while (i < n) {
    const ch = text[i];
    if (ch === SOFT_TERMINATOR) {
      let j = i;
      while (j < n && text[j] === SOFT_TERMINATOR) j++;
      // Bounded slice keeps the boundary check O(1) per soft terminator.
      if (j >= n || SOFT_BOUNDARY_NEXT.test(text.slice(j, j + 48))) {
        emit(j);
        continue;
      }
      i = j;
      continue;
    }
    if (ch === "\n") {
      // A blank line (paragraph break) always ends a sentence. A single newline
      // ends one only before a capitalised next sentence (a line break used as a
      // sentence separator, "... the summary\nUse the tools ..."), not a
      // mid-sentence wrap ("... use the\nshell ...", which stays one sentence so a
      // real suppression that wraps is still detected).
      //
      // Accepted residual (the dual of that hygiene fix, same class as the soft
      // capital-tool-noun residual): a suppression whose wrap falls right before a
      // CAPITALISED tool noun ("do not use\nBash commands") splits and is missed.
      // A single newline before a capital is genuinely ambiguous between a new
      // sentence and a wrapped proper noun, and no line heuristic separates them;
      // biasing toward the split avoids false-flagging pro-tool hygiene prose,
      // which this detector treats as the worse fault, and a lowercase wrap (the
      // common way a suppression continues) is still detected.
      const rest = text.slice(i + 1, i + 48);
      if (/^[ \t\r]*\n/.test(rest) || SOFT_BOUNDARY_NEXT.test(text.slice(i, i + 48))) {
        emit(i + 1);
        continue;
      }
      i++;
      continue;
    }
    if (!SENTENCE_TERMINATOR.test(ch)) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && SENTENCE_TERMINATOR.test(text[j])) j++;
    // Fullwidth/ideographic terminators are unambiguous sentence ends and, per
    // CJK typography, are NOT followed by a space, so they split regardless of
    // what follows (no whitespace requirement and no decimal guard, which only
    // applies to an ASCII ".").
    // Test the WHOLE terminator run for a fullwidth mark, not just its first
    // character: a mixed run like ".。" must still split (an earlier version
    // checked only the first char and glued "summary.。Use").
    if (FULLWIDTH_TERMINATOR.test(text.slice(i, j))) {
      emit(j);
      continue;
    }
    // A terminator may be followed by closing quotes/brackets before the
    // sentence-ending whitespace (as in a quoted or parenthesised sentence end),
    // so consume them before deciding the boundary. A terminator followed by
    // whitespace or end-of-text is a boundary: no decimal special-case, because a
    // real decimal ("2.1") has no space after the "." and so is never a boundary
    // candidate here, while "2. 3" (period then space) is a genuine sentence end.
    let boundaryEnd = j;
    while (boundaryEnd < n && SENTENCE_CLOSERS.test(text[boundaryEnd])) boundaryEnd++;
    if (boundaryEnd >= n || /\s/.test(text[boundaryEnd])) {
      emit(boundaryEnd);
      continue;
    }
    i = j;
  }
  if (start < n) sentences.push(text.slice(start));
  return sentences;
}

// True when any single sentence of the markup-normalised prompt tells the
// reviewer to suppress tool use. Segmenting first is what stops a negation
// gluing across a sentence boundary to an unrelated permitting clause.
export function containsToolSuppression(prompt: string): boolean {
  const normalised = neutraliseInlineMarkup(prompt);
  return segmentSentences(normalised).some(
    sentence => SUPPRESSION_VERB_NOUN.test(sentence) || WITHOUT_NOUN.test(sentence)
  );
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

  if (reviewContext && containsToolSuppression(input.prompt)) {
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
