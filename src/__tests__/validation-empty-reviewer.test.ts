import { describe, expect, it } from "vitest";
import { buildValidationReport } from "../validation-report.js";
import { normalizeJobResult } from "../validation-normalizer.js";
import { startJudgeSynthesis } from "../validation-orchestrator.js";
import { buildValidationSchemas } from "../validation-tools.js";
import type { NormalizedValidationResult, ValidationProvider } from "../validation-normalizer.js";
import type { AsyncJobResult } from "../async-job-manager.js";

// Issue #269: a reviewer that completes with zero bytes of output must not be
// counted as agreement.
//
// The failure this guards was observed live: three mistral review jobs exited 0
// with 0 bytes, the normaliser produced `verdict: null`, the disagreement
// summary filtered null verdicts out of the verdict set, and the report stated
// that the completed providers did not disagree. A silent reviewer and an
// approving reviewer were indistinguishable.

function result(
  overrides: Partial<NormalizedValidationResult> & { provider: ValidationProvider }
): NormalizedValidationResult {
  return {
    provider: overrides.provider,
    model: overrides.model ?? `${overrides.provider}-fake`,
    status: overrides.status ?? "completed",
    verdict: overrides.verdict ?? "approve",
    rationale: overrides.rationale ?? "ok",
    risks: overrides.risks ?? [],
    rawJobReference: {
      jobId: `job-${overrides.provider}`,
      correlationId: `corr-${overrides.provider}`,
      statusTool: "job_status",
      resultTool: "job_result",
    },
    error: overrides.error ?? null,
    ...(overrides.emptyOutput === undefined ? {} : { emptyOutput: overrides.emptyOutput }),
  };
}

function job(overrides: Partial<AsyncJobResult>): AsyncJobResult {
  return {
    id: "job-1",
    correlationId: "corr-1",
    cli: "mistral",
    status: "completed",
    stdout: "",
    stderr: "",
    error: null,
    ...overrides,
  } as AsyncJobResult;
}

function report_of(results: NormalizedValidationResult[]) {
  return buildValidationReport({
    validationId: "validation-269",
    status: "running",
    startedAt: new Date(0).toISOString(),
    intent: "validate",
    originalRequest: { question: "?" },
    modelList: results.map(r => r.provider),
    results,
    synthesis: {
      status: "not_requested",
      judgeModel: null,
      rawJobReference: null,
      note: "No judge requested.",
    },
  });
}

describe("issue #269: an empty completed reviewer is not agreement", () => {
  it("normaliser marks a completed job with no stdout as emptyOutput", () => {
    const normalized = normalizeJobResult("mistral", "m", job({ stdout: "" }));
    expect(normalized.status).toBe("completed");
    expect(normalized.emptyOutput).toBe(true);
  });

  it("normaliser marks whitespace-only output as empty too", () => {
    const normalized = normalizeJobResult("mistral", "m", job({ stdout: "\n \t\n" }));
    expect(normalized.emptyOutput).toBe(true);
  });

  it("normaliser does NOT mark a real review as empty", () => {
    const normalized = normalizeJobResult("mistral", "m", job({ stdout: "APPROVE, looks fine" }));
    expect(normalized.emptyOutput).toBeUndefined();
  });

  it("normaliser does not mark a FAILED empty job as emptyOutput", () => {
    // A failed job is already a terminal problem; emptyOutput is specifically
    // about the deceptive case of SUCCESS with nothing to show for it.
    const normalized = normalizeJobResult("mistral", "m", job({ status: "failed", stdout: "" }));
    expect(normalized.emptyOutput).toBeUndefined();
  });

  it("an empty reviewer alongside an approving one is MATERIAL disagreement", () => {
    // THE REGRESSION TEST. Before the fix this returned false, and the summary
    // read "Completed providers do not show material verdict disagreement".
    const report = report_of([
      result({ provider: "codex", verdict: "approve" }),
      result({ provider: "mistral", verdict: null, rationale: null, emptyOutput: true }),
    ]);
    expect(report.structuredContent.disagreements.hasMaterialDisagreement).toBe(true);
  });

  it("names the silent provider in the signals, so the reader knows WHICH", () => {
    const report = report_of([
      result({ provider: "codex", verdict: "approve" }),
      result({ provider: "mistral", verdict: null, rationale: null, emptyOutput: true }),
    ]);
    const signals = report.structuredContent.disagreements.signals.join(" ");
    expect(signals).toContain("mistral");
    expect(signals).toMatch(/no output|unusable/i);
  });

  it("two genuinely approving reviewers still report no disagreement", () => {
    // Negative control: the fix must not make every report noisy.
    const report = report_of([
      result({ provider: "codex", verdict: "approve" }),
      result({ provider: "grok", verdict: "approve" }),
    ]);
    expect(report.structuredContent.disagreements.hasMaterialDisagreement).toBe(false);
  });

  it("carries the flag end to end, from the normaliser into the report", () => {
    // Round 1 (grok): every disagreement case above INJECTS emptyOutput rather
    // than piping the normaliser's own output in, so a rename on one side only
    // would leave them all green while the pipeline was broken.
    const normalized = [
      normalizeJobResult("codex", "c", job({ cli: "codex", stdout: "APPROVE" })),
      normalizeJobResult("mistral", "m", job({ cli: "mistral", stdout: "" })),
    ];
    const report = report_of(normalized);
    expect(report.structuredContent.disagreements.hasMaterialDisagreement).toBe(true);
    expect(report.structuredContent.disagreements.signals.join(" ")).toContain("mistral");
  });

  it("survives the synthesize_validation input schema instead of being stripped", () => {
    // Round 1 (codex): Zod strips unknown keys, so an omitted field in
    // normalizedProviderResultSchema silently discards the flag at the
    // synthesize_validation boundary and the judge sees a plain completed
    // result. The report was fixed; this is the layer under it.
    const { normalizedProviderResultSchema } = buildValidationSchemas({});
    const parsed = normalizedProviderResultSchema.parse(
      result({ provider: "mistral", verdict: null, rationale: null, emptyOutput: true })
    );
    expect(parsed.emptyOutput).toBe(true);
  });

  it("does not feed an empty reviewer to the judge as evidence", () => {
    // Round 1 (codex and grok, independently): startJudgeSynthesis filtered on
    // status === "completed", so the reviewer just declared unusable was still
    // handed to the judge as a participant.
    const synthesis = startJudgeSynthesis({ asyncJobManager: {} as never }, {
      judgeProvider: "claude",
      providerResults: [
        result({ provider: "mistral", verdict: null, rationale: null, emptyOutput: true }),
      ],
      intent: "validate",
      question: "?",
    } as never);
    expect(synthesis.status).toBe("skipped");
    expect(synthesis.note).toMatch(/empty/i);
  });
});
