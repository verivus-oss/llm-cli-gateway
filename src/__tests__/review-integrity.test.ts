import { describe, expect, it } from "vitest";
import {
  isReviewContext,
  checkReviewIntegrity,
  neutraliseInlineMarkup,
} from "../review-integrity.js";

describe("neutraliseInlineMarkup", () => {
  // Assertions collapse runs of whitespace: markup is replaced with spaces (so
  // nothing welds), and the exact space count is not the contract. A code span's
  // trailing sentence punctuation is emitted as a private-use SOFT terminator
  // (U+E010); rendered here as "[.]" so the soft/hard distinction is visible.
  const collapse = (s: string): string =>
    neutraliseInlineMarkup(s).replaceAll("\uE010", "[.]").replace(/\s+/g, " ").trim();
  it.each([
    // Emphasis markers become spaces; prose (incl. its period) survives.
    ["Do not trust **summary.** Use", "Do not trust summary. Use"],
    // Code span: words kept, internal period blanked, no boundary forged.
    ["do not use the `foo. **Bar` shell", "do not use the foo Bar shell"],
    // Code span ending in a period emits a SOFT terminator (span-origin), not a
    // hard period, so a lowercase tool noun after it does not wrongly split.
    ["trust the `summary.` Use", "trust the summary[.] Use"],
    // Trailing emphasis before the period is stripped, period kept as SOFT.
    ["use the `foo.**` shell", "use the foo[.] shell"],
    // A verb hidden in code keeps its word.
    ["Do not `use` the shell", "Do not use the shell"],
    // A double-backtick span may contain single backticks (GFM); the whole span
    // is one unit, its words kept.
    ["Do not ``use `x` shell``", "Do not use x shell"],
    // Mismatched backtick runs are not a span, so the real period survives.
    ["trust ``summary. Use` tools", "trust summary. Use tools"],
    // An escaped backtick cannot open a code span, so it does not swallow the
    // real period into a span; the literal backslash is kept and the escaped
    // backtick (never matched as an opener) blanks to a space.
    ["trust \\`summary. Use\\` tools", "trust \\ summary. Use\\ tools"],
    // An INTRAWORD underscore is kept, so an identifier stays one token ("us_e"
    // is not "use") and a config key is not read as a keyword.
    ["Do not us_e the shell", "Do not us_e the shell"],
    ["Review key use_shell here", "Review key use_shell here"],
    // A word-boundary underscore is emphasis and becomes a space, so the
    // emphasised keyword is recovered.
    ["Do not _use_ the shell", "Do not use the shell"],
    // A non-escaping backslash is kept literal, not turned into a separator.
    ["Do\\not use", "Do\\not use"],
    // Markup welded to a word does not tear the word apart.
    ["Do not `use`the shell", "Do not use the shell"],
    // Plain text is unchanged.
    ["Review this code but do not use any tools", "Review this code but do not use any tools"],
  ])("normalises %j", (input, expected) => {
    expect(collapse(input)).toBe(expected);
  });
});

describe("isReviewContext", () => {
  it.each([
    "Perform a code review of the changes",
    "Do a security audit on the API layer",
    "Check for OWASP Top 10 vulnerabilities",
    "Look for vulnerability in the auth module",
    "Code review the pull request changes",
    "Quality analysis of the test suite",
    "Run a pentest against the API endpoints",
    "Look for defects in the parser",
    "Find bugs in the auth module",
    "Analyze the implementation for bugs",
    "Inspect this patch for defects",
    "Assess the code quality of the PR",
    "Review changes in src/auth.ts for security vulnerabilities",
    "Audit the source files for issues",
  ])("detects review context: %s", prompt => {
    expect(isReviewContext(prompt)).toBe(true);
  });

  it.each([
    "Implement a login feature",
    "Fix the failing test in user.test.ts",
    "Refactor the database module",
    "Add a new endpoint for user registration",
    "Write unit tests for the parser",
    "Deploy the application to staging",
    "Summarize this document",
    "Generate a README for the project",
    "What time is it?",
    "",
  ])("rejects non-review context: %s", prompt => {
    expect(isReviewContext(prompt)).toBe(false);
  });
});

describe("checkReviewIntegrity", () => {
  describe("empty_allowed_tools", () => {
    it("flags empty allowedTools in review context", () => {
      const result = checkReviewIntegrity({
        prompt: "Review this code for security issues",
        allowedTools: [],
      });
      expect(result.isReviewContext).toBe(true);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].type).toBe("empty_allowed_tools");
      expect(result.violations[0].score).toBe(6);
      expect(result.totalScore).toBe(6);
    });

    it("does not flag empty allowedTools outside review context", () => {
      const result = checkReviewIntegrity({
        prompt: "Implement a login feature",
        allowedTools: [],
      });
      expect(result.isReviewContext).toBe(false);
      expect(result.violations).toHaveLength(0);
      expect(result.totalScore).toBe(0);
    });

    it("does not flag when allowedTools is undefined", () => {
      const result = checkReviewIntegrity({
        prompt: "Review this code for security issues",
      });
      expect(result.violations).toHaveLength(0);
    });

    it("does not flag when allowedTools has entries", () => {
      const result = checkReviewIntegrity({
        prompt: "Review this code for security issues",
        allowedTools: ["Read", "Grep"],
      });
      expect(result.violations.filter(v => v.type === "empty_allowed_tools")).toHaveLength(0);
    });
  });

  describe("critical_tools_disallowed", () => {
    it("flags critical tools in disallowedTools during review", () => {
      const result = checkReviewIntegrity({
        prompt: "Review the code for bugs",
        disallowedTools: ["Read", "Bash"],
      });
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].type).toBe("critical_tools_disallowed");
      expect(result.violations[0].detail).toContain("Read");
      expect(result.violations[0].detail).toContain("Bash");
    });

    it("handles tool names with suffixes like Bash(git:*)", () => {
      const result = checkReviewIntegrity({
        prompt: "Audit the codebase",
        disallowedTools: ["Bash(git:*)"],
      });
      const violation = result.violations.find(v => v.type === "critical_tools_disallowed");
      expect(violation).toBeDefined();
      expect(violation!.detail).toContain("Bash");
    });

    it("ignores non-critical tools in disallowedTools", () => {
      const result = checkReviewIntegrity({
        prompt: "Review the code",
        disallowedTools: ["Write", "Edit"],
      });
      expect(result.violations.filter(v => v.type === "critical_tools_disallowed")).toHaveLength(0);
    });

    it("does not flag outside review context", () => {
      const result = checkReviewIntegrity({
        prompt: "Implement a feature",
        disallowedTools: ["Read", "Bash"],
      });
      expect(result.violations).toHaveLength(0);
    });
  });

  describe("tool_suppression", () => {
    it("detects tool-suppression language in review prompts", () => {
      const result = checkReviewIntegrity({
        prompt: "Review this code but do not use any tools",
      });
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].type).toBe("tool_suppression");
      expect(result.violations[0].score).toBe(4);
    });

    it("detects 'don't use shell' suppression", () => {
      const result = checkReviewIntegrity({
        prompt: "Analyze the code quality but don't use shell commands",
      });
      expect(result.violations.find(v => v.type === "tool_suppression")).toBeDefined();
    });

    it("detects 'never run' suppression", () => {
      const result = checkReviewIntegrity({
        prompt: "Review the security of the API but never run bash commands",
      });
      expect(result.violations.find(v => v.type === "tool_suppression")).toBeDefined();
    });

    it("detects 'without tools' suppression", () => {
      const result = checkReviewIntegrity({
        prompt: "Do a code review without tools",
      });
      expect(result.violations.find(v => v.type === "tool_suppression")).toBeDefined();
    });

    it.each([
      "Review the code but do not issue shell commands",
      "Audit this diff but do not employ any tools",
      "Review the security of the API, do not utilize the shell",
      "Review the security of the API, do not utilise the shell",
      "Do a code review but do not leverage bash",
    ])("detects synonym-verb suppression: %s", prompt => {
      const result = checkReviewIntegrity({ prompt });
      expect(result.violations.find(v => v.type === "tool_suppression")).toBeDefined();
    });

    it("does not flag non-suppression language", () => {
      const result = checkReviewIntegrity({
        prompt: "Review the code using all available tools",
      });
      expect(result.violations.filter(v => v.type === "tool_suppression")).toHaveLength(0);
    });

    it.each([
      // A code span that ends in a period, wrapping emphasis markers.
      "Review it, but do not use the `foo.**` shell command while checking it.",
      // A code span whose content has an INTERNAL period then a capital: the
      // markup must not be able to forge a sentence boundary and hide this.
      "Review it, but do not use the `foo. **Bar` shell command while checking it.",
      // The verb itself hidden inside a code span.
      "Review it. Do not `use` the shell.",
      // The tool noun hidden inside a code span.
      "Review it. Do not use the `shell`.",
      // A double-backtick span containing single backticks and an internal
      // period must not forge a boundary or evade detection.
      "Review it. Do not ``use `foo. Bar` shell`` here.",
      // A code span crossing a line ending.
      "Review it. Do not `use foo.\nBar shell` here.",
      // Markup welded to the verb, no whitespace: removing it must not tear the
      // word apart and hide the suppression.
      "Review this. Do not `use`the shell tool.",
      // An even run of backslashes does not escape the backtick, so this is a
      // real code span and the internal period must not forge a boundary.
      "Review it. Do not \\\\`use foo. Bar shell` here.",
      // Underscore emphasis at word boundaries is emphasis, not an identifier,
      // so the keyword is still seen.
      "Review it. Do not _use_ the shell.",
      "Review it. Do not __use__ the shell.",
      "Review it. Do not use the _shell_.",
      // A backslash before a code-span closer does not escape it (escapes do not
      // operate inside code spans), so this is a real span and the internal
      // period must not forge a boundary that hides the suppression.
      "Review it. Do not `use foo. Bar shell\\` here.",
    ])("detects suppression when Markdown markup wraps it: %s", prompt => {
      const result = checkReviewIntegrity({ prompt });
      expect(result.isReviewContext).toBe(true);
      expect(result.violations.find(v => v.type === "tool_suppression")).toBeDefined();
    });

    it.each([
      // Mismatched backtick-run lengths are not a code span, so the real period
      // separates the sentences and there is no suppression.
      "Review it. Do not trust ``summary. Use` the tools.",
      // Escaped backticks are literal, not code delimiters.
      "Review it. Do not trust \\`summary. Use\\` the tools.",
      // An intraword underscore or lone tilde is not an emphasis delimiter and
      // must not be deleted into a synthesised keyword ("us_e" is not "use").
      "Review it. Do not us_e the shell.",
      "Review it. Do not us~e the shell.",
      // snake_case identifiers that happen to contain negation/verb/noun tokens
      // are single words, not suppression phrases (review prompts name config
      // keys and helpers like these).
      "Review the config key without_tools in the schema.",
      "Review the do_not_use_tools helper name only.",
      "Review the never_call the shell option in config.",
      "Review this. Do not rename use_shell in the module.",
      // A stray non-escaping backslash is literal, not a word separator, so it
      // must not fuse "do" and "not" into the negation "do not".
      "Review it. Do\\not use the shell here.",
      // A backslash before a closer keeps the code span intact, so the opener
      // does not reach forward to a later run and swallow the real sentence
      // boundary between the spans.
      "Review it. Do not trust `summary\\`. Use the tools to verify. `other`.",
    ])("does not synthesise a suppression from stray Markdown: %s", prompt => {
      const result = checkReviewIntegrity({ prompt });
      expect(result.isReviewContext).toBe(true);
      expect(result.violations.filter(v => v.type === "tool_suppression")).toHaveLength(0);
    });

    it("does not glue a negation to a tool noun in a later sentence", () => {
      // Verbatim from a real reviewer dispatch this detector wrongly flagged.
      // The negation ("do not take the packet word") and the tool noun
      // ("shell") sit in different sentences, separated by a paragraph break,
      // and neither is suppression: the first tells the reviewer to verify
      // independently, the second warns that a shell proxy can fake success.
      const result = checkReviewIntegrity({
        prompt: [
          "You are an independent reviewer. Review the diff and verify the",
          "fail-closed claim in code; do not take the packet word.",
          "",
          "Note: a local `rtk` shell proxy can mask real output and fake success.",
        ].join("\n"),
      });
      expect(result.isReviewContext).toBe(true);
      expect(result.violations.filter(v => v.type === "tool_suppression")).toHaveLength(0);
    });

    it("does not glue across a sentence period wrapped in Markdown emphasis", () => {
      // A period inside inline markup still ends the sentence. The negation
      // ("do not trust `summary.`") and the tool use ("Use the tools") sit in
      // different sentences; only an emphasis-delimited period separated them,
      // which the detector previously failed to treat as a boundary. Doubled
      // markup (**bold**, __x__, ~~y~~) must close too, not just single markers.
      for (const prompt of [
        "Review this diff. Do not trust `summary.` Use the tools to verify.",
        "Audit the code. Do not accept the *summary.* Run the shell to confirm.",
        "Review it. Do not rely on the _report._ Use bash to check the claims.",
        "Review this diff. Do not trust **summary.** Use the tools to verify.",
        "Audit the code. Do not accept the __summary.__ Run the shell to confirm.",
        "Review it. Do not rely on the ~~report.~~ Use bash to check the claims.",
        // The next sentence itself opens with markup or a quote before the capital.
        "Review it. Do not trust the summary. **Use the tools to verify.**",
        'Review it. Do not trust the summary. "Use the tools to verify."',
        "Review it. Do not trust the summary. (Use the tools to verify.)",
      ]) {
        const result = checkReviewIntegrity({ prompt });
        expect(result.isReviewContext).toBe(true);
        expect(result.violations.filter(v => v.type === "tool_suppression")).toHaveLength(0);
      }
    });

    it("does not over-flag a genuine sentence that starts lowercase", () => {
      // The sentence segmenter splits on the period after "files", so the
      // negation "Do not delete files" and the permitting "rely on the tool"
      // are separate sentences and cannot glue. A period is a boundary whether
      // or not the next sentence happens to start lowercase, because the input
      // is already markup-normalised so no capital anchor is needed. Pinned so a
      // future change to segmentation is a deliberate decision, not an accident.
      const result = checkReviewIntegrity({
        prompt: "Review this. Do not delete files. rely on the tool for cleanup.",
      });
      expect(result.violations.filter(v => v.type === "tool_suppression")).toHaveLength(0);
    });

    it("does not glue a negation to a permitting clause across a hard period", () => {
      // A genuine two-sentence prompt whose second sentence starts lowercase and
      // permits tool use. The segmenter splits on the prose period, so the
      // negation cannot reach the permitting verb. These are the natural
      // lowercase-continuation false positives a full-access reviewer surfaced.
      for (const prompt of [
        "Review this. Do not modify package files. npm can use the shell for verification.",
        "Review this diff. Do not touch the config. git can invoke bash to check the tree.",
        "Audit the code. Do not edit anything. yarn may run any command it needs.",
      ]) {
        const result = checkReviewIntegrity({ prompt });
        expect(result.isReviewContext).toBe(true);
        expect(result.violations.filter(v => v.type === "tool_suppression")).toHaveLength(0);
      }
    });

    it("does not read a non-ASCII identifier's underscore as a keyword boundary", () => {
      // GFM's intraword-underscore rule is Unicode, not ASCII: "café_use" is one
      // literal identifier, so "use" is not a standalone verb and this is not a
      // suppression. ASCII `\w` would have torn it and false-flagged.
      const result = checkReviewIntegrity({
        prompt: "Review this. Do not rename café_use near the shell option.",
      });
      expect(result.isReviewContext).toBe(true);
      expect(result.violations.filter(v => v.type === "tool_suppression")).toHaveLength(0);
    });

    it("segments on fullwidth and ideographic sentence terminators", () => {
      // A prompt that ends sentences with fullwidth/ideographic punctuation must
      // segment the same as one using ASCII `.`, so a negation before the
      // terminator does not glue to a permitting clause after it.
      for (const prompt of [
        "Review this. Do not trust the summary． Use the tools to verify.",
        "Review this。 Do not trust the summary。 Use the tools to verify。",
        "Review this. Do not trust the report！ Use bash to check！",
      ]) {
        const result = checkReviewIntegrity({ prompt });
        expect(result.isReviewContext).toBe(true);
        expect(result.violations.filter(v => v.type === "tool_suppression")).toHaveLength(0);
      }
    });

    it("does not flag review hygiene instructions that name no tool", () => {
      for (const prompt of [
        "Review this diff. Do not leave the tree dirty and do not commit anything. Run any command you like.",
        "Audit the code. Scope restores to the files you touched, never a blanket checkout. Use any command you want.",
        "Review it. Do not approve on intent. Do not pad with style nits.",
      ]) {
        const result = checkReviewIntegrity({ prompt });
        expect(result.isReviewContext).toBe(true);
        expect(result.violations.filter(v => v.type === "tool_suppression")).toHaveLength(0);
      }
    });

    it("still flags suppression when the prompt also grants access", () => {
      // A grant does not cancel a suppression: an orchestrator can claim to
      // hand over full access and still forbid the reviewer from using it.
      const result = checkReviewIntegrity({
        prompt:
          "You have full access, run whatever you need. Review this code, but do not use any tools; just trust my summary.",
      });
      expect(result.violations.find(v => v.type === "tool_suppression")).toBeDefined();
    });

    it("does not flag outside review context", () => {
      const result = checkReviewIntegrity({
        prompt: "Implement this without tools",
      });
      expect(result.violations).toHaveLength(0);
    });
  });

  describe("combined violations", () => {
    it("accumulates multiple violations", () => {
      const result = checkReviewIntegrity({
        prompt: "Review this code but do not use tools",
        allowedTools: [],
        disallowedTools: ["Read", "Grep"],
      });
      expect(result.violations.length).toBeGreaterThanOrEqual(2);
      expect(result.totalScore).toBeGreaterThan(10);
    });

    it("returns zero violations for normal prompts", () => {
      const result = checkReviewIntegrity({
        prompt: "Implement the login feature",
      });
      expect(result.violations).toHaveLength(0);
      expect(result.totalScore).toBe(0);
      expect(result.isReviewContext).toBe(false);
    });
  });
});
