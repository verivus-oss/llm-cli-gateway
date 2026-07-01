/**
 * v2.12.0 usability quality pass: behavioral (additive) result-health and
 * error-guidance improvements. All changes are additive: they never hard-fail a
 * previously-successful call, only attach warnings / structured signals /
 * actionable error text. These tests pin the new behaviour so it cannot
 * silently regress.
 */
import { describe, expect, it } from "vitest";
import {
  buildCliResponse,
  createErrorResponse,
  extractUsageAndCost,
  prepareClaudeRequest,
} from "../index.js";

// Minimal CliRequestPrep for buildCliResponse (only the fields it reads).
function minimalPrep(): never {
  return {
    corrId: "test-corr",
    effectivePrompt: "hi",
    resolvedModel: undefined,
    requestedMcpServers: [],
    approvalDecision: null,
    args: [],
    stablePrefixHash: null,
    stablePrefixTokens: null,
  } as never;
}

// A single Claude `--output-format json` result object (also the terminal
// stream-json `result` event). parseStreamJson reads it line-by-line.
function claudeResult(isError: boolean): string {
  return JSON.stringify({
    type: "result",
    subtype: isError ? "error_max_turns" : "success",
    is_error: isError,
    result: isError ? "" : "the answer",
    usage: {
      input_tokens: 12,
      output_tokens: 7,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    total_cost_usd: 0.0021,
  });
}

describe("v2.12.0 behavioral: extractUsageAndCost claude json mode (#4)", () => {
  it("parses usage + cost from --output-format json (previously returned {})", () => {
    const usage = extractUsageAndCost("claude", claudeResult(false), "json");
    expect(usage.inputTokens).toBe(12);
    expect(usage.outputTokens).toBe(7);
    expect(usage.costUsd).toBeCloseTo(0.0021);
  });

  it("still parses stream-json mode", () => {
    const usage = extractUsageAndCost("claude", claudeResult(false), "stream-json");
    expect(usage.outputTokens).toBe(7);
  });
});

describe("v2.12.0 behavioral: buildCliResponse result-health signals (#1, #3, #6)", () => {
  it("flags Claude is_error:true as a warning + structured signal but still returns text", () => {
    const res = buildCliResponse(
      "claude",
      claudeResult(true),
      false,
      "c1",
      undefined,
      minimalPrep(),
      5,
      undefined,
      "json"
    );
    expect(res.structuredContent?.resultIsError).toBe(true);
    expect(res.warnings?.some(w => w.code === "claude_result_error")).toBe(true);
    // Additive: the response is still returned (not a hard error).
    expect(res.isError).toBeUndefined();
  });

  it("does NOT flag a clean Claude result", () => {
    const res = buildCliResponse(
      "claude",
      claudeResult(false),
      false,
      "c1",
      undefined,
      minimalPrep(),
      5,
      undefined,
      "json"
    );
    expect(res.structuredContent?.resultIsError).toBeUndefined();
    expect(res.warnings?.some(w => w.code === "claude_result_error")).toBeFalsy();
  });

  it("surfaces the real Codex session UUID (thread_id) as codexSessionId", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "0199-codex-uuid" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }),
    ].join("\n");
    const res = buildCliResponse(
      "codex",
      stdout,
      false,
      "c1",
      undefined,
      minimalPrep(),
      5,
      undefined,
      "text"
    );
    expect(res.structuredContent?.codexSessionId).toBe("0199-codex-uuid");
  });

  it("warns on exit-0 empty output (silent-success guard)", () => {
    const res = buildCliResponse(
      "grok",
      "   ",
      false,
      "c1",
      undefined,
      minimalPrep(),
      5,
      undefined,
      "plain"
    );
    expect(res.structuredContent?.emptyOutput).toBe(true);
    expect(res.warnings?.some(w => w.code === "empty_output")).toBe(true);
  });

  it("does NOT warn empty_output when content is present", () => {
    const res = buildCliResponse(
      "grok",
      "a real reply",
      false,
      "c1",
      undefined,
      minimalPrep(),
      5,
      undefined,
      "plain"
    );
    expect(res.structuredContent?.emptyOutput).toBeUndefined();
    expect(res.warnings?.some(w => w.code === "empty_output")).toBeFalsy();
  });
});

describe("v2.12.0 behavioral: createErrorResponse remediation + categories (#2, #8)", () => {
  it("classifies auth failures and adds per-CLI remediation", () => {
    const res = createErrorResponse(
      "claude",
      1,
      "Error: not logged in. Please run claude login",
      "c1"
    );
    expect(res.structuredContent?.errorCategory).toBe("auth_error");
    expect(res.content[0].text).toContain("claude login");
  });

  it("uses devin-specific auth remediation", () => {
    const res = createErrorResponse("devin", 1, "401 unauthorized", "c1");
    expect(res.structuredContent?.errorCategory).toBe("auth_error");
    expect(res.content[0].text).toMatch(/devin auth login|WINDSURF_API_KEY/);
  });

  it("categorizes 50MB output overflow with remediation (not spawn_error)", () => {
    const res = createErrorResponse(
      "grok",
      1,
      "",
      "c1",
      new Error("Output exceeded maximum size (50MB)")
    );
    expect(res.structuredContent?.errorCategory).toBe("output_overflow");
    expect(res.content[0].text).toContain("50MB");
  });

  it("categorizes a JobSaturationError as a retryable 'saturated' backpressure error (issue #130)", async () => {
    const { JobSaturationError } = await import("../async-job-manager.js");
    const res = createErrorResponse(
      "claude",
      1,
      "",
      "c1",
      new JobSaturationError("claude", "running limit reached and the queue is full; retry shortly")
    );
    expect(res.structuredContent?.errorCategory).toBe("saturated");
    expect(res.structuredContent?.retryable).toBe(true);
    expect(res.content[0].text).toMatch(/at capacity/i);
    expect(res.content[0].text).toMatch(/retry/i);
    // Must not be misclassified as a provider/CLI failure.
    expect(res.content[0].text).not.toContain("Error executing");
  });

  it("adds async-retry guidance on wall-clock timeout (124)", () => {
    const res = createErrorResponse("codex", 124, "", "c1");
    expect(res.structuredContent?.errorCategory).toBe("timeout");
    expect(res.content[0].text).toMatch(/_request_async|llm_job_status/);
  });

  it("adds an interactive/idle hint on idle timeout (125)", () => {
    const res = createErrorResponse("claude", 125, "", "c1");
    expect(res.structuredContent?.errorCategory).toBe("idle_timeout");
    expect(res.content[0].text).toMatch(/idleTimeoutMs|interactive/i);
  });

  it("adds a fallback hint when a non-zero exit captured no stderr", () => {
    const res = createErrorResponse("grok", 1, "", "c1");
    expect(res.content[0].text).toMatch(/No error output was captured/i);
  });
});

describe("v2.12.0 behavioral: whitespace-only prompt is rejected (#9)", () => {
  it("rejects a whitespace-only prompt instead of passing it to the CLI", () => {
    const res = prepareClaudeRequest({
      prompt: "   \n\t ",
      outputFormat: "text",
      dangerouslySkipPermissions: false,
      approvalStrategy: "legacy",
      strictMcpConfig: false,
      optimizePrompt: false,
      operation: "claude_request",
    } as never);
    // An error response (not a CliRequestPrep with args).
    expect("args" in res).toBe(false);
    expect((res as { isError?: boolean }).isError).toBe(true);
  });
});
