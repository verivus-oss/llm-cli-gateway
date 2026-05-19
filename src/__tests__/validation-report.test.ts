import { describe, expect, it } from "vitest";
import { buildValidationReport } from "../validation-report.js";
import type { NormalizedValidationResult, ValidationProvider } from "../validation-normalizer.js";

// Layer 6 / U20: validation report structuredContent coverage.
//
// Layer 5 tests assert the report's MCP-content / disagreement framing. These
// tests assert the structuredContent invariants U20 needs for release: jobId
// preservation across mixed states, limitations content, confidence grades,
// and the no-completed-results path.

function startedAt(): string {
  return new Date(0).toISOString();
}

function result(
  overrides: Partial<NormalizedValidationResult> & { provider: ValidationProvider }
): NormalizedValidationResult {
  const hasExplicitJobRef = Object.prototype.hasOwnProperty.call(overrides, "rawJobReference");
  return {
    provider: overrides.provider,
    model: overrides.model ?? `${overrides.provider}-fake`,
    status: overrides.status ?? "completed",
    verdict: overrides.verdict ?? "approve",
    rationale: overrides.rationale ?? "ok",
    risks: overrides.risks ?? [],
    rawJobReference: hasExplicitJobRef
      ? (overrides.rawJobReference ?? null)
      : {
          jobId: `job-${overrides.provider}`,
          correlationId: `corr-${overrides.provider}`,
          statusTool: "job_status",
          resultTool: "job_result",
        },
    error: overrides.error ?? null,
    warning: overrides.warning,
  };
}

describe("Layer 6 validation report structuredContent (U20)", () => {
  it("reports high confidence for two completed agreeing providers", () => {
    const report = buildValidationReport({
      validationId: "validation-agree",
      status: "running",
      startedAt: startedAt(),
      intent: "validate",
      originalRequest: { question: "Is this connected?" },
      modelList: ["claude", "codex"],
      results: [result({ provider: "claude" }), result({ provider: "codex" })],
      synthesis: {
        status: "not_requested",
        judgeModel: null,
        rawJobReference: null,
        note: "No judge requested.",
      },
    });

    expect(report.structuredContent.confidence).toBe("high");
    expect(report.structuredContent.disagreements.hasMaterialDisagreement).toBe(false);
    expect(report.structuredContent.jobIds).toEqual(["job-claude", "job-codex"]);
    expect(report.structuredContent.finalRecommendation).toContain(
      "no normalized verdict disagreement"
    );
  });

  it("returns medium confidence for a single completed provider", () => {
    const report = buildValidationReport({
      validationId: "validation-solo",
      status: "running",
      startedAt: startedAt(),
      intent: "validate",
      originalRequest: { question: "?" },
      modelList: ["claude"],
      results: [result({ provider: "claude" })],
      synthesis: {
        status: "not_requested",
        judgeModel: null,
        rawJobReference: null,
        note: "No judge requested.",
      },
    });
    expect(report.structuredContent.confidence).toBe("medium");
  });

  it("returns none confidence and waits when no provider has completed yet", () => {
    const report = buildValidationReport({
      validationId: "validation-empty",
      status: "running",
      startedAt: startedAt(),
      intent: "validate",
      originalRequest: { question: "?" },
      modelList: ["claude", "codex"],
      results: [
        result({ provider: "claude", status: "running", verdict: "pending", rationale: "running" }),
        result({ provider: "codex", status: "running", verdict: "pending", rationale: "running" }),
      ],
      synthesis: {
        status: "waiting_for_provider_results",
        judgeModel: "gemini",
        rawJobReference: null,
        note: "Collect provider results first.",
      },
    });

    expect(report.structuredContent.confidence).toBe("none");
    expect(report.structuredContent.disagreements.hasMaterialDisagreement).toBe(true);
    expect(report.structuredContent.finalRecommendation).toMatch(/wait/i);
    expect(report.structuredContent.limitations.some(l => /running/i.test(l))).toBe(true);
  });

  it("preserves disagreement when one provider failed and another completed", () => {
    const report = buildValidationReport({
      validationId: "validation-fail",
      status: "partial",
      startedAt: startedAt(),
      intent: "validate",
      originalRequest: { question: "?" },
      modelList: ["claude", "codex"],
      results: [
        result({ provider: "claude" }),
        result({
          provider: "codex",
          status: "failed",
          verdict: "failed",
          rationale: "auth required",
          error: "auth required",
          risks: ["risk: auth"],
        }),
      ],
      synthesis: {
        status: "skipped",
        judgeModel: "gemini",
        rawJobReference: null,
        note: "Judge synthesis requires more than one completed provider.",
      },
    });

    expect(report.structuredContent.disagreements.hasMaterialDisagreement).toBe(true);
    expect(report.structuredContent.disagreements.signals.some(s => /failed/i.test(s))).toBe(true);
    expect(report.structuredContent.confidence).toBe("low");
    expect(report.structuredContent.limitations.some(l => /skipped/i.test(l))).toBe(true);
  });

  it("never claims consensus on conflicting completed verdicts", () => {
    const report = buildValidationReport({
      validationId: "validation-conflict",
      status: "running",
      startedAt: startedAt(),
      intent: "validate",
      originalRequest: { question: "?" },
      modelList: ["claude", "codex"],
      results: [
        result({ provider: "claude", verdict: "approve" }),
        result({ provider: "codex", verdict: "reject", risks: ["bug"] }),
      ],
      synthesis: {
        status: "not_requested",
        judgeModel: null,
        rawJobReference: null,
        note: "No judge requested.",
      },
    });

    expect(report.structuredContent.disagreements.hasMaterialDisagreement).toBe(true);
    expect(report.structuredContent.confidence).toBe("low");
    expect(report.structuredContent.finalRecommendation).toMatch(/resolve disagreements/i);
    expect(report.humanReadable).toContain("verdict=approve");
    expect(report.humanReadable).toContain("verdict=reject");
  });

  it("returned structuredContent includes the judge synthesis state without leaking job IDs from skipped jobs", () => {
    const report = buildValidationReport({
      validationId: "validation-judge",
      status: "running",
      startedAt: startedAt(),
      intent: "validate",
      originalRequest: { question: "?" },
      modelList: ["claude"],
      results: [
        result({ provider: "claude" }),
        result({
          provider: "grok",
          status: "skipped",
          rawJobReference: null,
          error: "not installed",
          verdict: "not_run",
        }),
      ],
      synthesis: {
        status: "running",
        judgeModel: "gemini",
        rawJobReference: {
          jobId: "job-gemini-judge",
          correlationId: "corr-judge",
          statusTool: "job_status",
          resultTool: "job_result",
        },
        note: "Judge synthesis running.",
      },
    });

    expect(report.structuredContent.jobIds).toEqual(["job-claude"]);
    expect(report.structuredContent.synthesis.status).toBe("running");
    expect(report.structuredContent.synthesis.rawJobReference?.jobId).toBe("job-gemini-judge");
  });

  it("includes the validation ID and model list in the human-readable text", () => {
    const report = buildValidationReport({
      validationId: "validation-text",
      status: "running",
      startedAt: startedAt(),
      intent: "validate",
      originalRequest: { question: "?" },
      modelList: ["claude", "codex"],
      results: [result({ provider: "claude" }), result({ provider: "codex" })],
      synthesis: {
        status: "not_requested",
        judgeModel: null,
        rawJobReference: null,
        note: "No judge requested.",
      },
    });
    expect(report.humanReadable.startsWith("Validation report validation-text")).toBe(true);
    expect(report.humanReadable).toContain("Models: claude, codex");
    expect(report.humanReadable).toContain("Confidence:");
  });
});
