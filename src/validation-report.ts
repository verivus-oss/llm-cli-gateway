import type { NormalizedValidationResult, ValidationProvider } from "./validation-normalizer.js";
import type { ValidationIntent } from "./validation-prompts.js";

export type ValidationReportConfidence = "none" | "low" | "medium" | "high";

export interface ValidationReportInput {
  validationId: string;
  status: "running" | "partial" | "not_started" | "completed";
  startedAt: string;
  intent: ValidationIntent;
  originalRequest: {
    question?: string;
    content?: string;
    focus?: string;
  };
  modelList: ValidationProvider[];
  results: NormalizedValidationResult[];
  synthesis: {
    status: "not_requested" | "waiting_for_provider_results" | "running" | "skipped" | "completed";
    judgeModel: ValidationProvider | null;
    rawJobReference: NormalizedValidationResult["rawJobReference"];
    note: string;
  };
}

export interface ValidationReport {
  schemaVersion: "validation-report.v1";
  humanReadable: string;
  structuredContent: {
    validationId: string;
    status: ValidationReportInput["status"];
    startedAt: string;
    intent: ValidationIntent;
    originalRequest: ValidationReportInput["originalRequest"];
    modelList: ValidationProvider[];
    perModelOutputs: Array<{
      provider: ValidationProvider;
      model: string | null;
      status: NormalizedValidationResult["status"];
      verdict: string | null;
      rationale: string | null;
      risks: string[];
      jobId: string | null;
      correlationId: string | null;
      warning: string | null;
      error: string | null;
    }>;
    disagreements: {
      hasMaterialDisagreement: boolean;
      summary: string;
      signals: string[];
    };
    finalRecommendation: string;
    confidence: ValidationReportConfidence;
    limitations: string[];
    jobIds: string[];
    synthesis: ValidationReportInput["synthesis"];
  };
}

export function buildValidationReport(input: ValidationReportInput): ValidationReport {
  const perModelOutputs = input.results.map(result => ({
    provider: result.provider,
    model: result.model,
    status: result.status,
    verdict: result.verdict,
    rationale: result.rationale,
    risks: result.risks,
    jobId: result.rawJobReference?.jobId ?? null,
    correlationId: result.rawJobReference?.correlationId ?? null,
    warning: result.warning ?? null,
    error: result.error,
  }));
  const jobIds = perModelOutputs.flatMap(output => (output.jobId ? [output.jobId] : []));
  const disagreements = summarizeDisagreement(input.results);
  const limitations = summarizeLimitations(input.results, input.synthesis);
  const confidence = confidenceFor(input.results, disagreements.hasMaterialDisagreement);
  const finalRecommendation = recommendationFor(
    input.results,
    disagreements.hasMaterialDisagreement
  );
  const structuredContent = {
    validationId: input.validationId,
    status: input.status,
    startedAt: input.startedAt,
    intent: input.intent,
    originalRequest: input.originalRequest,
    modelList: input.modelList,
    perModelOutputs,
    disagreements,
    finalRecommendation,
    confidence,
    limitations,
    jobIds,
    synthesis: input.synthesis,
  };

  return {
    schemaVersion: "validation-report.v1",
    humanReadable: renderHumanReport(structuredContent),
    structuredContent,
  };
}

/**
 * Cross-LLM validation receipts (Phase 0): derive the run-level report status,
 * including the terminal `completed` value that the kickoff path never produced.
 *
 * A run is `completed` (terminal) when at least one provider job was dispatched
 * (i.e. not every result is `skipped`), every dispatched provider job is in a
 * terminal state (`completed | failed | canceled | orphaned`), and any requested
 * judge synthesis is no longer pending (`running` / `waiting_for_provider_results`
 * keep the run non-terminal). `skipped` results are themselves terminal and do
 * not block completion, but a run where EVERY provider was skipped never started
 * and stays `not_started`.
 *
 * For the kickoff inputs (results are only `running` or `skipped`, synthesis is
 * `not_requested` / `waiting_for_provider_results`) this reproduces the previous
 * `runningCount === 0 ? not_started : skipped > 0 ? partial : running` formula
 * exactly; it only adds `completed` once results are collected and terminal.
 */
export function deriveValidationRunStatus(
  results: NormalizedValidationResult[],
  synthesisStatus: ValidationReportInput["synthesis"]["status"]
): ValidationReportInput["status"] {
  if (results.length === 0) return "not_started";
  const dispatched = results.filter(result => result.status !== "skipped");
  if (dispatched.length === 0) return "not_started";
  const allDispatchedTerminal = dispatched.every(
    result =>
      result.status === "completed" ||
      result.status === "failed" ||
      result.status === "canceled" ||
      result.status === "orphaned"
  );
  const hasSkipped = results.some(result => result.status === "skipped");
  const judgePending =
    synthesisStatus === "running" || synthesisStatus === "waiting_for_provider_results";
  if (!allDispatchedTerminal || judgePending) {
    return hasSkipped ? "partial" : "running";
  }
  return "completed";
}

function summarizeDisagreement(
  results: NormalizedValidationResult[]
): ValidationReport["structuredContent"]["disagreements"] {
  const completed = results.filter(result => result.status === "completed");
  const terminalProblems = results.filter(result =>
    ["failed", "canceled", "orphaned", "skipped"].includes(result.status)
  );
  const pending = results.filter(
    result => result.status === "running" || result.verdict === "pending"
  );
  const verdicts = new Set(
    completed
      .map(result => normalizeVerdict(result.verdict))
      .filter((verdict): verdict is string => Boolean(verdict))
  );
  const signals: string[] = [];
  if (verdicts.size > 1)
    signals.push(`Completed providers returned ${verdicts.size} different verdicts.`);
  for (const result of terminalProblems) signals.push(`${result.provider} is ${result.status}.`);
  for (const result of pending) signals.push(`${result.provider} is still pending.`);

  const hasMaterialDisagreement =
    verdicts.size > 1 || terminalProblems.length > 0 || pending.length > 0;
  return {
    hasMaterialDisagreement,
    summary: hasMaterialDisagreement
      ? "Do not treat this validation as consensus; inspect the per-model outputs and unresolved states."
      : completed.length > 0
        ? "Completed providers do not show material verdict disagreement in the normalized report."
        : "No completed provider outputs are available yet.",
    signals,
  };
}

function summarizeLimitations(
  results: NormalizedValidationResult[],
  synthesis: ValidationReportInput["synthesis"]
): string[] {
  const limitations: string[] = [];
  if (results.some(result => result.status === "running")) {
    limitations.push(
      "Some provider jobs are still running; poll job_status and job_result before treating the report as final."
    );
  }
  if (results.some(result => result.status !== "completed")) {
    limitations.push("Only completed provider outputs are suitable as judge synthesis evidence.");
  }
  if (synthesis.status === "waiting_for_provider_results") {
    limitations.push(
      "Judge synthesis has not run because provider results still need to be collected."
    );
  } else if (synthesis.status === "skipped") {
    limitations.push(`Judge synthesis skipped: ${synthesis.note}`);
  } else if (synthesis.status === "not_requested") {
    limitations.push(
      "No explicit judge synthesis was requested; use per-model outputs for the decision."
    );
  }
  limitations.push(
    "Large raw outputs are intentionally kept behind job_result references to fit normal MCP client responses."
  );
  return limitations;
}

function confidenceFor(
  results: NormalizedValidationResult[],
  hasMaterialDisagreement: boolean
): ValidationReportConfidence {
  const completedCount = results.filter(result => result.status === "completed").length;
  if (completedCount === 0) return "none";
  if (hasMaterialDisagreement) return "low";
  if (completedCount === 1) return "medium";
  return "high";
}

function recommendationFor(
  results: NormalizedValidationResult[],
  hasMaterialDisagreement: boolean
): string {
  const completedCount = results.filter(result => result.status === "completed").length;
  if (completedCount === 0) {
    return "Wait for at least one provider job to complete, then collect job_result before deciding.";
  }
  if (hasMaterialDisagreement) {
    return "Review the per-model outputs and resolve disagreements manually before acting.";
  }
  return "Completed provider outputs show no normalized verdict disagreement; review rationales and risks before acting.";
}

export function renderHumanReport(content: ValidationReport["structuredContent"]): string {
  const lines = [
    `Validation report ${content.validationId}`,
    `Status: ${content.status}`,
    `Models: ${content.modelList.join(", ") || "none"}`,
    "",
    "Per-model outputs:",
    ...content.perModelOutputs.map(output => {
      const job = output.jobId ? ` job=${output.jobId}` : "";
      const verdict = output.verdict ? ` verdict=${output.verdict}` : "";
      return `- ${output.provider}: ${output.status}${verdict}${job}`;
    }),
    "",
    `Disagreement: ${content.disagreements.summary}`,
    `Recommendation: ${content.finalRecommendation}`,
    `Confidence: ${content.confidence}`,
    "",
    "Limitations:",
    ...content.limitations.map(limitation => `- ${limitation}`),
  ];
  return lines.join("\n");
}

function normalizeVerdict(verdict: string | null): string | null {
  return verdict?.trim().toLowerCase() || null;
}
