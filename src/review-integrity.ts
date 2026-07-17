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

  if (reviewContext && TOOL_SUPPRESSION_PATTERN.test(input.prompt)) {
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
