import { createHash } from "node:crypto";
import type { AsyncJobManager } from "./async-job-manager.js";
import type {
  ValidationReceiptRecord,
  ValidationRunLink,
  ValidationRunRecord,
  ValidationRunStore,
} from "./job-store.js";
import { normalizeJobResult, normalizeSkippedProvider } from "./validation-normalizer.js";
import type { NormalizedValidationResult, ValidationProvider } from "./validation-normalizer.js";
import {
  buildValidationReport,
  deriveValidationRunStatus,
  renderHumanReport,
  type ValidationReport,
} from "./validation-report.js";
import type { ValidationIntent } from "./validation-prompts.js";
import { getRequestContext, principalCanAccess, resolveOwnerPrincipal } from "./request-context.js";

// Cross-LLM validation receipts (Phase 1): canonical serialization + mint.
//
// The mint reads the durable validation_runs row, pulls each linked provider
// (and judge) job from the job store, and only when the run is terminal builds
// the validation-report.v1 structuredContent (reusing buildValidationReport),
// hashes it canonically, and writes one immutable validation_receipts row
// (INSERT OR IGNORE). Both the validation_receipt tool (mint-on-read fallback)
// and the eager hook on job_result drive the same path, so a receipt is minted
// the first time the run is observed terminal, before job rows are evicted.

export const VALIDATION_RECEIPT_SCHEMA_VERSION = "validation-receipt.v1";

const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "canceled", "orphaned"]);

export interface ReceiptDeps {
  asyncJobManager: AsyncJobManager;
  validationRunStore?: ValidationRunStore | null;
}

/** alias for validation-report.v1's structuredContent object. */
export type ValidationReportV1Content = ValidationReport["structuredContent"];

export interface ValidationReceipt {
  schemaVersion: string;
  validationId: string;
  ownerPrincipal: string;
  mintedAt: string;
  intent: string;
  models: string[];
  report: ValidationReportV1Content;
  humanReadable: string;
  canonicalSha256: string;
  prevSha256?: string | null;
  seq?: number | null;
  signature?: string | null;
}

export interface ValidationRunState {
  validationId: string;
  status: ValidationRunRecord["status"];
  providers: Array<{ provider: string; jobId: string; status: string }>;
  judge: { provider: string; jobId: string; status: string } | null;
}

export interface RawResponse {
  provider: string;
  jobId: string;
  text: string;
}

export type ValidationReceiptResult =
  | {
      status: "minted";
      validationId: string;
      receipt: ValidationReceipt;
      mintedAt: string;
      rawResponses?: RawResponse[];
    }
  | { status: "pending"; validationId: string; run: ValidationRunState }
  | { status: "expired_unminted"; validationId: string }
  | { status: "not_found"; validationId: string };

/**
 * Canonical JSON: objects with keys sorted recursively, arrays in their existing
 * order, no insignificant whitespace, UTF-8. This is the byte definition the
 * hash (and a future chain/signature) is computed over.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** SHA-256 over the canonical serialization of the report structuredContent. */
export function computeCanonicalSha256(structuredContent: ValidationReportV1Content): string {
  return createHash("sha256").update(canonicalJson(structuredContent), "utf8").digest("hex");
}

function isTerminal(status: string): boolean {
  return TERMINAL_JOB_STATUSES.has(status);
}

function parseRequest(requestJson: string): {
  question?: string;
  content?: string;
  focus?: string;
  modelList?: string[];
} {
  try {
    const parsed = JSON.parse(requestJson);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

type MintOutcome =
  | { kind: "minted"; record: ValidationReceiptRecord }
  | { kind: "pending" }
  | { kind: "evicted" };

/**
 * Mint the receipt iff the run is terminal and all linked jobs are still
 * readable. Returns `evicted` when a linked job was already evicted (so a first
 * mint is no longer possible) and `pending` when the run is not yet terminal.
 * The write is INSERT OR IGNORE, so concurrent mints converge on one row.
 */
function tryMint(deps: ReceiptDeps, run: ValidationRunRecord): MintOutcome {
  const store = deps.validationRunStore;
  if (!store) return { kind: "pending" };

  const providerResults: Array<{ link: ValidationRunLink; result: NormalizedValidationResult }> =
    [];
  for (const link of run.providerLinks) {
    const jobResult = deps.asyncJobManager.getJobResult(link.jobId);
    if (!jobResult) return { kind: "evicted" };
    if (!isTerminal(jobResult.status)) return { kind: "pending" };
    providerResults.push({ link, result: normalizeJobResult(link.provider, null, jobResult) });
  }

  let judgeStatus: string | null = null;
  if (run.judgeLink) {
    const judgeResult = deps.asyncJobManager.getJobResult(run.judgeLink.jobId);
    if (!judgeResult) return { kind: "evicted" };
    if (!isTerminal(judgeResult.status)) return { kind: "pending" };
    judgeStatus = judgeResult.status;
  }

  const request = parseRequest(run.requestJson);
  const requested = Array.isArray(request.modelList) ? request.modelList : [];
  const dispatched = new Set(run.providerLinks.map(link => link.provider));
  const results: NormalizedValidationResult[] = providerResults.map(entry => entry.result);
  for (const provider of requested) {
    if (!dispatched.has(provider)) {
      results.push(
        normalizeSkippedProvider(
          provider as ValidationProvider,
          "Provider was not dispatched for this run."
        )
      );
    }
  }

  // A judge job that ended in a non-completed terminal state (failed/canceled/
  // orphaned) produced no synthesis: record it as `skipped` with the actual
  // outcome, never as `completed`. Only a genuinely completed judge is completed.
  const judgeCompleted = judgeStatus === "completed";
  const synthesis: ValidationReport["structuredContent"]["synthesis"] = run.judgeLink
    ? {
        status: judgeCompleted ? "completed" : "skipped",
        judgeModel: run.judgeLink.provider as ValidationProvider,
        rawJobReference: {
          jobId: run.judgeLink.jobId,
          correlationId: run.judgeLink.correlationId,
          statusTool: "job_status",
          resultTool: "job_result",
        },
        note: judgeCompleted
          ? "Judge synthesis completed."
          : `Judge job ended in '${judgeStatus}' without a synthesis result.`,
      }
    : {
        status: "not_requested",
        judgeModel: null,
        rawJobReference: null,
        note: "No judge synthesis was requested.",
      };

  const modelList = (
    requested.length > 0 ? requested : Array.from(dispatched)
  ) as ValidationProvider[];
  const report = buildValidationReport({
    validationId: run.validationId,
    status: deriveValidationRunStatus(results, synthesis.status),
    startedAt: run.createdAt,
    intent: run.intent as ValidationIntent,
    originalRequest: {
      question: request.question,
      content: request.content,
      focus: request.focus,
    },
    modelList,
    results,
    synthesis,
  });
  const structuredContent = report.structuredContent;
  const record: ValidationReceiptRecord = {
    validationId: run.validationId,
    ownerPrincipal: run.ownerPrincipal,
    mintedAt: new Date().toISOString(),
    schemaVersion: VALIDATION_RECEIPT_SCHEMA_VERSION,
    reportJson: JSON.stringify(structuredContent),
    canonicalSha256: computeCanonicalSha256(structuredContent),
    prevSha256: null,
    seq: null,
    signature: null,
    models: structuredContent.modelList as string[],
    hasMaterialDisagreement: structuredContent.disagreements.hasMaterialDisagreement,
    confidence: structuredContent.confidence,
  };
  store.recordValidationReceipt(record);
  // Mark the run finalized now that a receipt exists (idempotent). This keeps
  // validation_runs.status authoritative (running -> finalized) rather than
  // leaving a minted run perpetually "running".
  store.setValidationRunStatus(run.validationId, "finalized");
  // Re-read so a concurrent winner's row (not ours) is what we return.
  const stored = store.getValidationReceipt(run.validationId);
  return { kind: "minted", record: stored ?? record };
}

function receiptEnvelope(record: ValidationReceiptRecord): ValidationReceipt {
  const report = JSON.parse(record.reportJson) as ValidationReportV1Content;
  return {
    schemaVersion: record.schemaVersion,
    validationId: record.validationId,
    ownerPrincipal: record.ownerPrincipal,
    mintedAt: record.mintedAt,
    intent: report.intent,
    models: record.models,
    report,
    humanReadable: renderHumanReport(report),
    canonicalSha256: record.canonicalSha256,
    prevSha256: record.prevSha256,
    seq: record.seq,
    signature: record.signature,
  };
}

/**
 * Read-time-only raw provider answers, pulled live per linked jobId under the
 * SAME owner check, never persisted in the receipt and never part of the hash.
 * Absent for jobs that have been evicted.
 */
function collectRawResponses(
  deps: ReceiptDeps,
  receipt: ValidationReceipt,
  caller: string
): RawResponse[] {
  const out: RawResponse[] = [];
  const refs: Array<{ provider: string; jobId: string }> = [];
  for (const output of receipt.report.perModelOutputs) {
    if (output.jobId) refs.push({ provider: output.provider, jobId: output.jobId });
  }
  const judgeRef = receipt.report.synthesis.rawJobReference;
  if (judgeRef?.jobId) {
    refs.push({ provider: receipt.report.synthesis.judgeModel ?? "judge", jobId: judgeRef.jobId });
  }
  for (const ref of refs) {
    if (!principalCanAccess(deps.asyncJobManager.getJobOwner(ref.jobId), caller)) continue;
    const jobResult = deps.asyncJobManager.getJobResult(ref.jobId);
    if (jobResult) out.push({ provider: ref.provider, jobId: ref.jobId, text: jobResult.stdout });
  }
  return out;
}

function mintedResult(
  deps: ReceiptDeps,
  record: ValidationReceiptRecord,
  includeRawResponses: boolean,
  caller: string
): ValidationReceiptResult {
  const receipt = receiptEnvelope(record);
  return {
    status: "minted",
    validationId: record.validationId,
    receipt,
    mintedAt: record.mintedAt,
    ...(includeRawResponses ? { rawResponses: collectRawResponses(deps, receipt, caller) } : {}),
  };
}

function runStateOf(deps: ReceiptDeps, run: ValidationRunRecord): ValidationRunState {
  const snapStatus = (jobId: string): string =>
    deps.asyncJobManager.getJobSnapshot(jobId)?.status ?? "evicted";
  return {
    validationId: run.validationId,
    status: run.status,
    providers: run.providerLinks.map(link => ({
      provider: link.provider,
      jobId: link.jobId,
      status: snapStatus(link.jobId),
    })),
    judge: run.judgeLink
      ? {
          provider: run.judgeLink.provider,
          jobId: run.judgeLink.jobId,
          status: snapStatus(run.judgeLink.jobId),
        }
      : null,
  };
}

/**
 * Resolve (and mint-on-read if necessary) the receipt for a run, applying
 * own-or-not-found: a run/receipt owned by another principal returns not_found,
 * never another principal's data.
 */
export function resolveValidationReceipt(
  deps: ReceiptDeps,
  validationId: string,
  opts: { caller: string; includeRawResponses?: boolean }
): ValidationReceiptResult {
  const store = deps.validationRunStore;
  if (!store) return { status: "not_found", validationId };

  const existing = store.getValidationReceipt(validationId);
  if (existing) {
    if (!principalCanAccess(existing.ownerPrincipal, opts.caller)) {
      return { status: "not_found", validationId };
    }
    return mintedResult(deps, existing, opts.includeRawResponses ?? false, opts.caller);
  }

  const run = store.getValidationRun(validationId);
  if (!run || !principalCanAccess(run.ownerPrincipal, opts.caller)) {
    return { status: "not_found", validationId };
  }

  const outcome = tryMint(deps, run);
  if (outcome.kind === "minted") {
    return mintedResult(deps, outcome.record, opts.includeRawResponses ?? false, opts.caller);
  }
  if (outcome.kind === "evicted") {
    return { status: "expired_unminted", validationId };
  }
  return { status: "pending", validationId, run: runStateOf(deps, run) };
}

/**
 * Eager mint by run id: mints if the run is terminal and not yet receipted.
 * Best-effort and side-effect-only (no owner check: this is a system action that
 * stamps the receipt with the RUN's owner, never the caller). Never throws.
 */
export function eagerMintFromValidationId(deps: ReceiptDeps, validationId: string): void {
  const store = deps.validationRunStore;
  if (!store) return;
  try {
    if (store.getValidationReceipt(validationId)) return;
    const run = store.getValidationRun(validationId);
    if (!run) return;
    tryMint(deps, run);
  } catch {
    // Best-effort: a mint failure must not break the collection/synthesis path.
  }
}

/**
 * Eager mint hook: called when a validation provider/judge job result is
 * collected. Resolves the owning run from the job id and mints if the run has
 * just become terminal. Best-effort: never throws into the collection path.
 */
export function eagerMintFromJobId(deps: ReceiptDeps, jobId: string): void {
  const store = deps.validationRunStore;
  if (!store) return;
  let validationId: string | null = null;
  try {
    validationId = store.getValidationRunIdByJobId(jobId);
  } catch {
    return;
  }
  if (validationId) eagerMintFromValidationId(deps, validationId);
}

/** Resolve the current request's owner principal (own-or-not-found callers). */
export function currentCaller(): string {
  return resolveOwnerPrincipal(getRequestContext());
}
