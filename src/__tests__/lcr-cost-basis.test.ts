import { describe, expect, it } from "vitest";
import { deriveCostBasis, isTransientRouteFailure } from "../index.js";

// LCR phase_1 review-round-1 fixes: cost_basis labelling (T1 provider-reported vs
// T2 derived-from-tokens, never scalar decomposition) and the transient-vs-
// non-transient dispatch classifier used by the reroute loop.

describe("deriveCostBasis", () => {
  it("labels a provider-reported dollar cost as provider-reported (T1)", () => {
    const out = deriveCostBasis("claude", "claude-sonnet-4-6", {
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.42,
    });
    expect(out.costBasis).toBe("provider-reported");
    expect(out.costUsd).toBe(0.42);
  });

  it("derives cost from counts x rate for a T2 provider with no reported cost", () => {
    // gemini/codex report counts but (often) no dollar cost.
    const out = deriveCostBasis("gemini", "gemini-2.5-flash", {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(out.costBasis).toBe("derived-from-tokens");
    // gemini-2.5-flash input is $0.30 / 1M tokens.
    expect(out.costUsd).toBeCloseTo(0.3, 6);
  });

  it("returns no cost/basis for a completion with no counts and no cost", () => {
    const out = deriveCostBasis("grok", "grok-build", {});
    expect(out.costUsd).toBeUndefined();
    expect(out.costBasis).toBeUndefined();
  });

  it("returns no derived cost when the model family is unknown (never a free zero)", () => {
    const out = deriveCostBasis("cursor", "some-unpriced-model", {
      inputTokens: 1000,
      outputTokens: 1000,
    });
    // Unknown family: cannot derive; no cost, no basis.
    expect(out.costUsd).toBeUndefined();
    expect(out.costBasis).toBeUndefined();
  });
});

describe("isTransientRouteFailure", () => {
  function errResponse(exitCode: number | undefined, text: string, errorCategory?: string) {
    return {
      content: [{ type: "text" as const, text }],
      isError: true,
      structuredContent: { exitCode, errorCategory },
    };
  }

  it("classifies a wall-clock timeout (exit 124) as transient (retry.ts parity)", () => {
    expect(isTransientRouteFailure("claude", errResponse(124, "timed out", "timeout"))).toBe(true);
  });

  it("classifies an idle timeout (exit 125) as NON-transient", () => {
    expect(isTransientRouteFailure("claude", errResponse(125, "stuck", "idle_timeout"))).toBe(
      false
    );
  });

  it("classifies a plain provider error (non-zero exit) as NON-transient", () => {
    expect(isTransientRouteFailure("claude", errResponse(1, "bad request", "cli_error"))).toBe(
      false
    );
  });

  it("classifies a network reset in the error text as transient", () => {
    expect(
      isTransientRouteFailure("claude", errResponse(1, "socket ECONNRESET", "spawn_error"))
    ).toBe(true);
  });
});
