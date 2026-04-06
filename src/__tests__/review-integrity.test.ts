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

    it("does not flag non-suppression language", () => {
      const result = checkReviewIntegrity({
        prompt: "Review the code using all available tools",
      });
      expect(result.violations.filter(v => v.type === "tool_suppression")).toHaveLength(0);
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
