import type { AsyncJobResult, AsyncJobSnapshot, JobProvider } from "./async-job-manager.js";

/**
 * Slice 3: a validation reviewer is a spawnable CLI OR an enabled API provider
 * (an arbitrary `[providers.<name>]` key). Widened to `JobProvider` so API
 * providers can act as reviewers; the orchestrator branches CLI-vs-API on the
 * configured api-provider set, not on this type.
 */
export type ValidationProvider = JobProvider;

export type NormalizedValidationStatus =
  "running" | "completed" | "failed" | "canceled" | "orphaned" | "skipped";

export interface RawJobReference {
  jobId: string;
  correlationId: string;
  statusTool: "job_status";
  resultTool: "job_result";
}

export interface NormalizedValidationResult {
  provider: ValidationProvider;
  model: string | null;
  status: NormalizedValidationStatus;
  verdict: string | null;
  rationale: string | null;
  risks: string[];
  rawJobReference: RawJobReference | null;
  error: string | null;
  warning?: string;
}

export function normalizeStartedJob(
  provider: ValidationProvider,
  model: string | null,
  snapshot: AsyncJobSnapshot,
  warning?: string
): NormalizedValidationResult {
  // Issue #130: a job may be admitted as "queued" (waiting for a limiter run
  // slot) before it starts. To a validation caller that is indistinguishable
  // from "running": both mean "in progress, poll later".
  const inProgress = snapshot.status === "running" || snapshot.status === "queued";
  return {
    provider,
    model,
    status: snapshot.status === "queued" ? "running" : snapshot.status,
    verdict: inProgress ? "pending" : null,
    rationale: inProgress ? "Provider job is running asynchronously." : null,
    risks: [],
    rawJobReference: {
      jobId: snapshot.id,
      correlationId: snapshot.correlationId,
      statusTool: "job_status",
      resultTool: "job_result",
    },
    error: snapshot.error,
    warning,
  };
}

export function normalizeSkippedProvider(
  provider: ValidationProvider,
  reason: string
): NormalizedValidationResult {
  return {
    provider,
    model: null,
    status: "skipped",
    verdict: "not_run",
    rationale: reason,
    risks: [reason],
    rawJobReference: null,
    error: reason,
  };
}

export function normalizeJobResult(
  provider: ValidationProvider,
  model: string | null,
  result: AsyncJobResult
): NormalizedValidationResult {
  const output = result.stdout.trim();
  const error = result.error || (result.status === "failed" ? result.stderr.trim() : null);
  return {
    provider,
    model,
    // Issue #130: a terminal result is never "queued"; coerce defensively so
    // the normalized status stays within NormalizedValidationStatus.
    status: result.status === "queued" ? "running" : result.status,
    verdict: inferVerdict(output, result.status),
    rationale: output ? excerpt(output, 1800) : error,
    risks: extractRisks(output, error),
    rawJobReference: {
      jobId: result.id,
      correlationId: result.correlationId,
      statusTool: "job_status",
      resultTool: "job_result",
    },
    error,
  };
}

function inferVerdict(output: string, status: AsyncJobResult["status"]): string | null {
  if (status === "running") return "pending";
  if (status === "canceled" || status === "orphaned") return status;
  if (status === "failed") return "failed";
  const verdictMatch = output.match(/(?:^|\n)\s*verdict\s*:\s*(.+)/i);
  if (verdictMatch?.[1]) return excerpt(verdictMatch[1].trim(), 240);
  if (output) return "answered";
  return null;
}

function extractRisks(output: string, error: string | null): string[] {
  const risks = output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /^(?:[-*]\s*)?(?:risk|risks|concern|caution|limitation)\b/i.test(line))
    .slice(0, 5)
    .map(line => excerpt(line, 300));
  if (error && risks.length === 0) risks.push(excerpt(error, 300));
  return risks;
}

function excerpt(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}
