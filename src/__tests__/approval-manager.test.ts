import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ApprovalManager } from "../approval-manager.js";
import { INTERNAL_MCP_REGISTRY } from "../mcp-registry.js";
import { checkReviewIntegrity } from "../review-integrity.js";

describe("ApprovalManager", () => {
  let testDir: string;
  let logPath: string;
  let originalPolicy: string | undefined;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "approval-manager-test-"));
    logPath = join(testDir, "approvals.jsonl");
    originalPolicy = process.env.LLM_GATEWAY_APPROVAL_POLICY;
    delete process.env.LLM_GATEWAY_APPROVAL_POLICY;
    delete process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
  });

  afterEach(() => {
    if (originalPolicy === undefined) {
      delete process.env.LLM_GATEWAY_APPROVAL_POLICY;
    } else {
      process.env.LLM_GATEWAY_APPROVAL_POLICY = originalPolicy;
    }
    delete process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
    rmSync(testDir, { recursive: true, force: true });
  });

  it("uses env policy when request policy is omitted and records decision", () => {
    process.env.LLM_GATEWAY_APPROVAL_POLICY = "strict";
    const manager = new ApprovalManager(logPath);
    const decision = manager.decide({
      cli: "claude",
      operation: "claude_request",
      prompt: "delete leaked secret immediately",
      bypassRequested: false,
      fullAuto: false,
      requestedMcpServers: [],
    });

    expect(decision.policy).toBe("strict");
    expect(decision.status).toBe("denied");
    expect(
      decision.reasons.some(reason => reason.includes("sensitive or destructive keywords"))
    ).toBe(true);

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const logged = JSON.parse(lines[0]);
    expect(logged.id).toBe(decision.id);
    expect(logged.status).toBe("denied");
  });

  it("lists records newest-first and supports cli filtering", () => {
    const manager = new ApprovalManager(logPath);
    const first = manager.decide({
      cli: "claude",
      operation: "claude_request",
      prompt: "safe prompt one",
      bypassRequested: false,
      fullAuto: false,
      requestedMcpServers: [],
    });
    const second = manager.decide({
      cli: "codex",
      operation: "codex_request",
      prompt: "safe prompt two",
      bypassRequested: false,
      fullAuto: false,
      requestedMcpServers: [],
    });
    const third = manager.decide({
      cli: "claude",
      operation: "claude_request_async",
      prompt: "safe prompt three",
      bypassRequested: false,
      fullAuto: false,
      requestedMcpServers: [],
    });

    const latestTwo = manager.list(2);
    expect(latestTwo.map(item => item.id)).toEqual([third.id, second.id]);

    const claudeOnly = manager.list(10, "claude");
    expect(claudeOnly.map(item => item.id)).toEqual([third.id, first.id]);
    expect(claudeOnly.every(item => item.cli === "claude")).toBe(true);
  });

  it("approves standard full-auto codex requests under balanced policy", () => {
    const manager = new ApprovalManager(logPath);
    const decision = manager.decide({
      cli: "codex",
      operation: "codex_request",
      prompt: "Summarize this document",
      bypassRequested: false,
      fullAuto: true,
      requestedMcpServers: ["sqry", "exa", "ref_tools"],
      policy: "balanced",
    });

    expect(decision.status).toBe("approved");
    expect(decision.score).toBe(5);
  });

  it("denies a bypass request by default under MCP-managed approval, even on permissive policy (F15)", () => {
    const manager = new ApprovalManager(logPath);
    const decision = manager.decide({
      cli: "codex",
      operation: "codex_request",
      prompt: "Summarize this document",
      bypassRequested: true,
      fullAuto: false,
      requestedMcpServers: ["sqry"],
      policy: "permissive", // threshold 7; score would otherwise approve
    });
    expect(decision.status).toBe("denied");
    expect(decision.reasons.join(" ")).toMatch(/bypass denied by default/i);
  });

  it("permits a bypass request only with the explicit operator opt-in (F15)", () => {
    process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = "1";
    const manager = new ApprovalManager(logPath);
    const decision = manager.decide({
      cli: "codex",
      operation: "codex_request",
      prompt: "Summarize this document",
      bypassRequested: true,
      fullAuto: false,
      requestedMcpServers: ["sqry"],
      policy: "permissive",
    });
    expect(decision.status).toBe("approved");
  });

  it("denies bypass plus full-auto even with minimal MCP servers", () => {
    const manager = new ApprovalManager(logPath);
    const decision = manager.decide({
      cli: "codex",
      operation: "codex_request",
      prompt: "Run the task",
      bypassRequested: true,
      fullAuto: true,
      requestedMcpServers: ["sqry"],
      policy: "balanced",
    });

    expect(decision.status).toBe("denied");
    expect(decision.score).toBeGreaterThan(5);
  });

  it("penalizes empty allowedTools in review context (+6 instead of -1)", () => {
    const manager = new ApprovalManager(logPath);
    const prompt = "Review this code for security vulnerabilities";
    const reviewIntegrity = checkReviewIntegrity({ prompt, allowedTools: [] });

    const decision = manager.decide({
      cli: "claude",
      operation: "claude_request",
      prompt,
      bypassRequested: false,
      fullAuto: false,
      requestedMcpServers: [],
      allowedTools: [],
      reviewIntegrity,
    });

    expect(decision.reasons).toContain(
      "Empty allowedTools in review context — reviewers need tool access"
    );
    expect(decision.reasons).not.toContain("No tool permissions requested");
    // Score should include +6 (empty tools in review) — empty_allowed_tools violation from review integrity is skipped
    expect(decision.score).toBe(6);
  });

  it("scores 0 for empty allowedTools in non-review context (neutral, never negative)", () => {
    const manager = new ApprovalManager(logPath);
    const prompt = "Summarize this document";
    const reviewIntegrity = checkReviewIntegrity({ prompt, allowedTools: [] });

    const decision = manager.decide({
      cli: "claude",
      operation: "claude_request",
      prompt,
      bypassRequested: false,
      fullAuto: false,
      requestedMcpServers: [],
      allowedTools: [],
      reviewIntegrity,
    });

    expect(decision.reasons).toContain("No tool permissions requested");
    expect(decision.score).toBe(0);
  });

  it("includes reviewIntegrity in approval record audit trail", () => {
    const manager = new ApprovalManager(logPath);
    const prompt = "Security audit this code. Do not run tools or shell commands.";
    const reviewIntegrity = checkReviewIntegrity({ prompt, allowedTools: [] });

    const decision = manager.decide({
      cli: "claude",
      operation: "claude_request",
      prompt,
      bypassRequested: false,
      fullAuto: false,
      requestedMcpServers: [],
      allowedTools: [],
      reviewIntegrity,
    });

    // Verify in-memory record
    expect(decision.reviewIntegrity).toBeDefined();
    expect(decision.reviewIntegrity!.isReviewContext).toBe(true);
    expect(decision.reviewIntegrity!.violations.length).toBeGreaterThan(0);

    // Verify persisted JSONL record
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    const logged = JSON.parse(lines[lines.length - 1]);
    expect(logged.reviewIntegrity).toBeDefined();
    expect(logged.reviewIntegrity.isReviewContext).toBe(true);
    expect(logged.reviewIntegrity.violations.length).toBeGreaterThan(0);
  });

  it("independently detects review context even if caller supplies false isReviewContext", () => {
    const manager = new ApprovalManager(logPath);
    // Caller lies about review context being false, but the prompt IS a review
    const decision = manager.decide({
      cli: "claude",
      operation: "claude_request",
      prompt: "Review this code for security vulnerabilities",
      bypassRequested: false,
      fullAuto: false,
      requestedMcpServers: [],
      allowedTools: [],
      reviewIntegrity: {
        isReviewContext: false, // caller lies
        violations: [],
        totalScore: 0,
      },
    });

    // ApprovalManager independently calls isReviewContext on the prompt
    expect(decision.reasons).toContain(
      "Empty allowedTools in review context — reviewers need tool access"
    );
    expect(decision.score).toBe(6);
  });

  it("adds tool suppression score from reviewIntegrity violations but skips empty_allowed_tools", () => {
    const manager = new ApprovalManager(logPath);
    const prompt = "Review this code. Do not run tools or shell commands.";
    const reviewIntegrity = checkReviewIntegrity({ prompt, allowedTools: [] });

    const decision = manager.decide({
      cli: "claude",
      operation: "claude_request",
      prompt,
      bypassRequested: false,
      fullAuto: false,
      requestedMcpServers: [],
      allowedTools: [],
      reviewIntegrity,
    });

    // Should have +6 for empty allowedTools in review context (from independent check)
    // Should have +4 for tool_suppression (from reviewIntegrity violations)
    // Should NOT double-count empty_allowed_tools from reviewIntegrity
    expect(decision.score).toBe(10);
    expect(decision.reasons.some(r => r.includes("tool-suppression language"))).toBe(true);
    expect(decision.reasons).toContain(
      "Empty allowedTools in review context — reviewers need tool access"
    );
  });

  it("detects review context from expanded keywords (inspect, assess, pentest)", () => {
    const manager = new ApprovalManager(logPath);

    for (const prompt of [
      "Inspect this patch for defects",
      "Assess the code quality of the PR",
      "Run a pentest against the API",
    ]) {
      const decision = manager.decide({
        cli: "claude",
        operation: "claude_request",
        prompt,
        bypassRequested: false,
        fullAuto: false,
        requestedMcpServers: [],
        allowedTools: [],
      });
      // Each should be detected as review context → +6 for empty allowedTools
      expect(decision.reasons).toContain(
        "Empty allowedTools in review context — reviewers need tool access"
      );
      expect(decision.score).toBe(6);
    }
  });

  it("penalizes critical tools disallowed in review context (+6 instead of -1)", () => {
    const manager = new ApprovalManager(logPath);
    const prompt = "Review this code for vulnerabilities.";
    const reviewIntegrity = checkReviewIntegrity({
      prompt,
      allowedTools: ["Read"],
      disallowedTools: ["Read", "Grep", "Glob", "Bash"],
    });

    const decision = manager.decide({
      cli: "claude",
      operation: "claude_request",
      prompt,
      bypassRequested: false,
      fullAuto: false,
      requestedMcpServers: [],
      disallowedTools: ["Read", "Grep", "Glob", "Bash"],
      reviewIntegrity,
    });

    expect(decision.reasons.some(r => r.includes("Critical review tools disallowed"))).toBe(true);
    expect(decision.reasons).not.toContain("Has explicit disallowed tool restrictions");
    // +6 from approval-manager independent check
    // +4 from review integrity critical_tools_disallowed is skipped (handled above)
    expect(decision.score).toBe(6);
  });

  it("scores 0 for disallowedTools in non-review context (neutral, never negative)", () => {
    const manager = new ApprovalManager(logPath);
    const decision = manager.decide({
      cli: "claude",
      operation: "claude_request",
      prompt: "Summarize this document",
      bypassRequested: false,
      fullAuto: false,
      requestedMcpServers: [],
      disallowedTools: ["Read", "Grep"],
    });

    expect(decision.reasons).toContain("Has explicit disallowed tool restrictions");
    expect(decision.score).toBe(0);
  });

  it("detects scoped disallowedTools like Read(*), Bash(git:*) in review context", () => {
    const manager = new ApprovalManager(logPath);
    const prompt = "Review this code for vulnerabilities.";
    const reviewIntegrity = checkReviewIntegrity({
      prompt,
      disallowedTools: ["Read(*)", "Grep(*)", "Glob(*)", "Bash(git:*)"],
    });

    const decision = manager.decide({
      cli: "claude",
      operation: "claude_request",
      prompt,
      bypassRequested: false,
      fullAuto: false,
      requestedMcpServers: [],
      disallowedTools: ["Read(*)", "Grep(*)", "Glob(*)", "Bash(git:*)"],
      reviewIntegrity,
    });

    expect(decision.reasons.some(r => r.includes("Critical review tools disallowed"))).toBe(true);
    expect(decision.score).toBe(6);
  });

  it("denies empty allowedTools in review context under balanced policy (score > 5)", () => {
    const manager = new ApprovalManager(logPath);
    const decision = manager.decide({
      cli: "claude",
      operation: "claude_request",
      prompt: "Review this code for security vulnerabilities",
      bypassRequested: false,
      fullAuto: false,
      requestedMcpServers: [],
      allowedTools: [],
      policy: "balanced",
    });

    expect(decision.score).toBe(6);
    expect(decision.status).toBe("denied");
  });

  it("denies critical tools disallowed in review context under balanced policy", () => {
    const manager = new ApprovalManager(logPath);
    const decision = manager.decide({
      cli: "claude",
      operation: "claude_request",
      prompt: "Review this code for vulnerabilities.",
      bypassRequested: false,
      fullAuto: false,
      requestedMcpServers: [],
      disallowedTools: ["Read", "Grep", "Glob"],
      policy: "balanced",
    });

    expect(decision.score).toBe(6);
    expect(decision.status).toBe("denied");
  });

  it("tool restrictions never produce negative score when review context evaded", () => {
    const manager = new ApprovalManager(logPath);
    // Prompt that evades review context detection but has aggressive tool restrictions
    const decision = manager.decide({
      cli: "claude",
      operation: "claude_request",
      prompt: "Summarize this document",
      bypassRequested: false,
      fullAuto: false,
      requestedMcpServers: [],
      allowedTools: [],
      disallowedTools: ["Read", "Grep", "Glob", "Bash"],
      policy: "balanced",
    });

    // Score should be 0 (neutral), not -2 (gamed)
    expect(decision.score).toBe(0);
    expect(decision.score).toBeGreaterThanOrEqual(0);
    expect(decision.status).toBe("approved");
  });

  describe("prompt preview redaction", () => {
    let originalApprovalLogPrompts: string | undefined;

    beforeEach(() => {
      originalApprovalLogPrompts = process.env.APPROVAL_LOG_PROMPTS;
      delete process.env.APPROVAL_LOG_PROMPTS;
    });

    afterEach(() => {
      if (originalApprovalLogPrompts === undefined) {
        delete process.env.APPROVAL_LOG_PROMPTS;
      } else {
        process.env.APPROVAL_LOG_PROMPTS = originalApprovalLogPrompts;
      }
    });

    it("redacts prompt preview by default when APPROVAL_LOG_PROMPTS is not set", () => {
      const manager = new ApprovalManager(logPath);
      const decision = manager.decide({
        cli: "claude",
        operation: "claude_request",
        prompt: "This is a sensitive prompt with secret data",
        bypassRequested: false,
        fullAuto: false,
        requestedMcpServers: [],
      });

      expect(decision.promptPreview).toBe("[redacted]");

      // Verify the persisted record is also redacted
      const lines = readFileSync(logPath, "utf-8").trim().split("\n");
      const logged = JSON.parse(lines[lines.length - 1]);
      expect(logged.promptPreview).toBe("[redacted]");
    });

    it("includes actual prompt preview when APPROVAL_LOG_PROMPTS=1", () => {
      process.env.APPROVAL_LOG_PROMPTS = "1";
      const manager = new ApprovalManager(logPath);
      const promptText = "This is a visible prompt for logging";
      const decision = manager.decide({
        cli: "claude",
        operation: "claude_request",
        prompt: promptText,
        bypassRequested: false,
        fullAuto: false,
        requestedMcpServers: [],
      });

      expect(decision.promptPreview).toBe(promptText);
      expect(decision.promptPreview).not.toBe("[redacted]");

      // Verify the persisted record also has the preview
      const lines = readFileSync(logPath, "utf-8").trim().split("\n");
      const logged = JSON.parse(lines[lines.length - 1]);
      expect(logged.promptPreview).toBe(promptText);
    });

    it("redacts prompt preview when APPROVAL_LOG_PROMPTS is set to a value other than 1", () => {
      process.env.APPROVAL_LOG_PROMPTS = "true";
      const manager = new ApprovalManager(logPath);
      const decision = manager.decide({
        cli: "codex",
        operation: "codex_request",
        prompt: "Another sensitive prompt",
        bypassRequested: false,
        fullAuto: false,
        requestedMcpServers: [],
      });

      expect(decision.promptPreview).toBe("[redacted]");
    });

    it("still computes promptSha256 even when preview is redacted", () => {
      const manager = new ApprovalManager(logPath);
      const decision = manager.decide({
        cli: "claude",
        operation: "claude_request",
        prompt: "Prompt for hash verification",
        bypassRequested: false,
        fullAuto: false,
        requestedMcpServers: [],
      });

      expect(decision.promptPreview).toBe("[redacted]");
      // SHA-256 should still be a valid 64-char hex string
      expect(decision.promptSha256).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe("registry-driven MCP scoring", () => {
    it("applies the registry approval weights/reasons for known servers (exa +2, ref_tools +1)", () => {
      const manager = new ApprovalManager(logPath);
      const decision = manager.decide({
        cli: "codex",
        operation: "codex_request",
        prompt: "Summarize this document",
        bypassRequested: false,
        fullAuto: false,
        requestedMcpServers: ["sqry", "exa", "ref_tools"],
      });

      // sqry carries no weight; exa +2 and ref_tools +1.
      expect(decision.score).toBe(3);
      expect(decision.reasons).toContain("Request enables external web/company research MCP (exa)");
      expect(decision.reasons).toContain("Request enables documentation retrieval MCP (ref_tools)");
    });

    it("scores each requested server at most once, in registry declaration order", () => {
      const manager = new ApprovalManager(logPath);
      const decision = manager.decide({
        cli: "codex",
        operation: "codex_request",
        prompt: "Summarize this document",
        bypassRequested: false,
        fullAuto: false,
        requestedMcpServers: ["exa", "exa", "ref_tools"],
      });

      // Duplicate "exa" counted once; exa reason precedes ref_tools reason.
      expect(decision.score).toBe(3);
      const exaIdx = decision.reasons.indexOf(
        "Request enables external web/company research MCP (exa)"
      );
      const refIdx = decision.reasons.indexOf(
        "Request enables documentation retrieval MCP (ref_tools)"
      );
      expect(exaIdx).toBeGreaterThanOrEqual(0);
      expect(refIdx).toBeGreaterThan(exaIdx);
    });

    it("adds no per-server weight for an unknown server name", () => {
      const manager = new ApprovalManager(logPath);
      const decision = manager.decide({
        cli: "codex",
        operation: "codex_request",
        prompt: "Summarize this document",
        bypassRequested: false,
        fullAuto: false,
        requestedMcpServers: ["some_unknown_server"],
      });

      expect(decision.score).toBe(0);
      expect(decision.reasons).toEqual([]);
    });

    it("adds no per-server weight when the registry is empty (stripped public build)", () => {
      // Simulate the stripped build, where INTERNAL_MCP_REGISTRY is {}. Scoring
      // iterates the live registry, so an empty registry yields zero MCP weight
      // even for names that score in a dev build.
      const saved = { ...INTERNAL_MCP_REGISTRY };
      for (const key of Object.keys(INTERNAL_MCP_REGISTRY)) {
        delete INTERNAL_MCP_REGISTRY[key];
      }
      try {
        const manager = new ApprovalManager(logPath);
        const decision = manager.decide({
          cli: "codex",
          operation: "codex_request",
          prompt: "Summarize this document",
          bypassRequested: false,
          fullAuto: false,
          requestedMcpServers: ["exa", "ref_tools"],
        });

        expect(decision.score).toBe(0);
        expect(decision.reasons).toEqual([]);
      } finally {
        Object.assign(INTERNAL_MCP_REGISTRY, saved);
      }
    });
  });
});
