import { describe, expect, it } from "vitest";
import { isReviewContext, checkReviewIntegrity } from "../review-integrity.js";

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
