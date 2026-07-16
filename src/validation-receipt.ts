import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod/v3";
import type { AsyncJobManager, AsyncJobResult } from "./async-job-manager.js";
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

const rawJobReferenceSchema = z
  .object({
    jobId: z.string().min(1),
    correlationId: z.string().min(1),
    statusTool: z.literal("job_status"),
    resultTool: z.literal("job_result"),
  })
  .strict();

const validationReportV1ContentSchema = z
  .object({
    validationId: z.string().min(1),
    status: z.enum(["running", "partial", "not_started", "completed"]),
    startedAt: z.string().min(1),
    intent: z.enum(["validate", "second_opinion", "red_team", "consensus", "ask_model", "review"]),
    originalRequest: z
      .object({
        question: z.string().optional(),
        content: z.string().optional(),
        focus: z.string().optional(),
      })
      .strict(),
    modelList: z.array(z.string().min(1)),
    perModelOutputs: z.array(
      z
        .object({
          provider: z.string().min(1),
          model: z.string().nullable(),
          status: z.enum(["running", "completed", "failed", "canceled", "orphaned", "skipped"]),
          verdict: z.string().nullable(),
          rationale: z.string().nullable(),
          risks: z.array(z.string()),
          jobId: z.string().nullable(),
          correlationId: z.string().nullable(),
          warning: z.string().nullable(),
          error: z.string().nullable(),
        })
        .strict()
    ),
    disagreements: z
      .object({
        hasMaterialDisagreement: z.boolean(),
        summary: z.string(),
        signals: z.array(z.string()),
      })
      .strict(),
    finalRecommendation: z.string(),
    confidence: z.enum(["none", "low", "medium", "high"]),
    limitations: z.array(z.string()),
    jobIds: z.array(z.string()),
    synthesis: z
      .object({
        status: z.enum([
          "not_requested",
          "waiting_for_provider_results",
          "running",
          "skipped",
          "completed",
        ]),
        judgeModel: z.string().nullable(),
        rawJobReference: rawJobReferenceSchema.nullable(),
        note: z.string(),
      })
      .strict(),
  })
  .strict();

const validationRunRequestSchema = z
  .object({
    question: z.string().optional(),
    content: z.string().optional(),
    focus: z.string().optional(),
    modelList: z.array(z.string().min(1)).min(1),
    judgeProvider: z.string().min(1).nullable().optional(),
  })
  .passthrough();

interface VerifiedValidationRunRequest {
  question?: string;
  content?: string;
  focus?: string;
  modelList: string[];
  judgeProvider: string | null;
}

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
  /**
   * No receipt exists and none can be minted: the exact immutable evidence is
   * missing, incomplete, truncated, or fails link integrity. This is an
   * ABSENCE, never the outcome of checking a receipt that does exist.
   */
  | { status: "expired_unminted"; validationId: string }
  /**
   * A receipt row EXISTS but does not verify against the durable run: corrupt
   * report bytes, a hash mismatch, forged envelope metadata, or a report whose
   * roster/synthesis contradicts the run it claims to attest. Distinct from
   * `expired_unminted` on purpose: a verification FAILURE must never be
   * reported as an absence, because the two demand opposite responses (an
   * absence is expected after eviction; a failure means stored evidence and
   * the durable run disagree and someone must look).
   */
  | { status: "verification_failed"; validationId: string }
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

function hasCompleteOutput(result: AsyncJobResult): boolean {
  return (
    !result.outputTruncated &&
    !result.stdoutTruncated &&
    !result.stderrTruncated &&
    result.stdoutOffsetChars === 0 &&
    result.stderrOffsetChars === 0 &&
    result.stdoutNextOffsetChars === null &&
    result.stderrNextOffsetChars === null &&
    result.stdout.length === result.stdoutTotalChars &&
    result.stderr.length === result.stderrTotalChars &&
    Buffer.byteLength(result.stdout, "utf8") === result.stdoutBytes &&
    Buffer.byteLength(result.stderr, "utf8") === result.stderrBytes
  );
}

function parseValidationRunRequest(requestJson: string): VerifiedValidationRunRequest | null {
  try {
    const parsed = validationRunRequestSchema.safeParse(JSON.parse(requestJson));
    if (!parsed.success || new Set(parsed.data.modelList).size !== parsed.data.modelList.length) {
      return null;
    }
    return {
      question: parsed.data.question,
      content: parsed.data.content,
      focus: parsed.data.focus,
      modelList: parsed.data.modelList,
      judgeProvider: parsed.data.judgeProvider ?? null,
    };
  } catch {
    return null;
  }
}

type MintOutcome =
  | { kind: "minted"; record: ValidationReceiptRecord }
  | { kind: "pending" }
  | { kind: "unmintable" };

type VerifiedLinkedJob =
  { kind: "terminal"; result: AsyncJobResult } | { kind: "pending" } | { kind: "unmintable" };

/**
 * Reload one exact linked job through the durable manager boundary. A receipt
 * is immutable evidence, so legacy-unowned, cross-owner, mislinked, or partial
 * output is permanently unmintable rather than something the hash may bless.
 */
function readVerifiedLinkedJob(
  deps: ReceiptDeps,
  store: ValidationRunStore,
  run: ValidationRunRecord,
  link: ValidationRunLink
): VerifiedLinkedJob {
  let jobOwner: string | null | undefined;
  try {
    jobOwner = deps.asyncJobManager.getJobOwner(link.jobId);
  } catch {
    return { kind: "unmintable" };
  }
  if (jobOwner !== run.ownerPrincipal) {
    return { kind: "unmintable" };
  }

  let linkedValidationId: string | null;
  try {
    linkedValidationId = store.getValidationRunIdByJobId(link.jobId);
  } catch {
    return { kind: "unmintable" };
  }
  if (linkedValidationId !== run.validationId) return { kind: "unmintable" };

  let result: AsyncJobResult | null;
  try {
    result = deps.asyncJobManager.getJobResult(link.jobId, Number.MAX_SAFE_INTEGER);
  } catch {
    return { kind: "unmintable" };
  }
  if (!result) return { kind: "unmintable" };
  if (
    result.id !== link.jobId ||
    String(result.cli) !== link.provider ||
    result.correlationId !== link.correlationId
  ) {
    return { kind: "unmintable" };
  }
  if (!isTerminal(result.status)) return { kind: "pending" };

  return hasCompleteOutput(result) ? { kind: "terminal", result } : { kind: "unmintable" };
}

/**
 * Mint the receipt iff the run is terminal and all linked jobs are still
 * readable and pass durable owner/link/output integrity checks. Returns
 * `unmintable` when exact evidence is missing, incomplete, truncated, or
 * mismatched, and `pending` when the run is not yet terminal. The public result
 * maps `unmintable` to the terminal `expired_unminted` status: in both cases no
 * receipt exists and immutable evidence can no longer be minted safely. A
 * receipt that DOES exist but fails verification is reported as
 * `verification_failed` instead (see `mintedResult`). The write is INSERT OR
 * IGNORE, so concurrent mints converge on one row.
 */
function tryMint(deps: ReceiptDeps, run: ValidationRunRecord): MintOutcome {
  const store = deps.validationRunStore;
  if (!store) return { kind: "pending" };
  if (run.status === "admitting" || run.status === "admission_failed") {
    return { kind: "pending" };
  }
  const request = parseValidationRunRequest(run.requestJson);
  if (!request) return { kind: "unmintable" };
  const requested = request.modelList;
  const requestedProviders = new Set(requested);

  const providerNames = new Set<string>();
  const providerJobIds = new Set<string>();
  const providerCorrelationIds = new Set<string>();
  for (const link of run.providerLinks) {
    if (
      !requestedProviders.has(link.provider) ||
      providerNames.has(link.provider) ||
      providerJobIds.has(link.jobId) ||
      providerCorrelationIds.has(link.correlationId)
    ) {
      return { kind: "unmintable" };
    }
    providerNames.add(link.provider);
    providerJobIds.add(link.jobId);
    providerCorrelationIds.add(link.correlationId);
  }
  if (
    run.judgeLink &&
    (providerJobIds.has(run.judgeLink.jobId) ||
      providerCorrelationIds.has(run.judgeLink.correlationId))
  ) {
    return { kind: "unmintable" };
  }

  const plannedJudge = request.judgeProvider;
  if (plannedJudge && run.judgeLink && run.judgeLink.provider !== plannedJudge) {
    return { kind: "unmintable" };
  }
  if (plannedJudge && !run.judgeLink && run.status !== "judge_skipped") {
    return { kind: "pending" };
  }

  const providerResults: Array<{ link: ValidationRunLink; result: NormalizedValidationResult }> =
    [];
  for (const link of run.providerLinks) {
    const verified = readVerifiedLinkedJob(deps, store, run, link);
    if (verified.kind !== "terminal") return verified;
    providerResults.push({
      link,
      result: normalizeJobResult(link.provider, null, verified.result),
    });
  }

  let judgeStatus: string | null = null;
  if (run.judgeLink) {
    const verified = readVerifiedLinkedJob(deps, store, run, run.judgeLink);
    if (verified.kind !== "terminal") return verified;
    judgeStatus = verified.result.status;
  }

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
    : run.status === "judge_skipped" && plannedJudge
      ? {
          status: "skipped",
          judgeModel: plannedJudge as ValidationProvider,
          rawJobReference: null,
          note: "The planned judge could not be dispatched.",
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

function equalSha256(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function originalRequestMatchesRun(
  report: ValidationReportV1Content,
  request: VerifiedValidationRunRequest
): boolean {
  return (
    report.originalRequest.question === request.question &&
    report.originalRequest.content === request.content &&
    report.originalRequest.focus === request.focus
  );
}

function providerRosterMatchesRun(
  report: ValidationReportV1Content,
  run: ValidationRunRecord,
  request: VerifiedValidationRunRequest
): boolean {
  if (!sameStrings(report.modelList, request.modelList)) return false;

  const requestedProviders = new Set(request.modelList);
  const linkedProviders = new Set<string>();
  const linkedJobIds = new Set<string>();
  const linkedCorrelationIds = new Set<string>();
  for (const link of run.providerLinks) {
    if (
      !link.provider ||
      !link.jobId ||
      !link.correlationId ||
      !requestedProviders.has(link.provider) ||
      linkedProviders.has(link.provider) ||
      linkedJobIds.has(link.jobId) ||
      linkedCorrelationIds.has(link.correlationId)
    ) {
      return false;
    }
    linkedProviders.add(link.provider);
    linkedJobIds.add(link.jobId);
    linkedCorrelationIds.add(link.correlationId);
  }

  const expectedOutputs: Array<{
    provider: string;
    jobId: string | null;
    correlationId: string | null;
    dispatched: boolean;
  }> = run.providerLinks.map(link => ({
    provider: link.provider,
    jobId: link.jobId,
    correlationId: link.correlationId,
    dispatched: true,
  }));
  for (const provider of request.modelList) {
    if (!linkedProviders.has(provider)) {
      expectedOutputs.push({ provider, jobId: null, correlationId: null, dispatched: false });
    }
  }
  if (report.perModelOutputs.length !== expectedOutputs.length) return false;
  const remainingOutputs = [...report.perModelOutputs];
  for (const expected of expectedOutputs) {
    const actual = remainingOutputs.shift();
    if (
      !actual ||
      actual.provider !== expected.provider ||
      actual.jobId !== expected.jobId ||
      actual.correlationId !== expected.correlationId ||
      (expected.dispatched ? !isTerminal(actual.status) : actual.status !== "skipped")
    ) {
      return false;
    }
  }

  return (
    sameStrings(
      report.jobIds,
      run.providerLinks.map(link => link.jobId)
    ) && report.status === (run.providerLinks.length === 0 ? "not_started" : "completed")
  );
}

function synthesisMatchesRun(
  report: ValidationReportV1Content,
  run: ValidationRunRecord,
  request: VerifiedValidationRunRequest
): boolean {
  const synthesis = report.synthesis;
  const plannedJudge = request.judgeProvider;
  const boundJudge = plannedJudge ?? run.judgeLink?.provider ?? null;
  if (run.judgeLink) {
    const link = run.judgeLink;
    return (
      Boolean(link.provider && link.jobId && link.correlationId) &&
      !run.providerLinks.some(
        providerLink =>
          providerLink.jobId === link.jobId || providerLink.correlationId === link.correlationId
      ) &&
      link.provider === boundJudge &&
      (run.status === "running" || run.status === "finalized") &&
      (synthesis.status === "completed" || synthesis.status === "skipped") &&
      synthesis.judgeModel === link.provider &&
      synthesis.rawJobReference?.jobId === link.jobId &&
      synthesis.rawJobReference.correlationId === link.correlationId &&
      synthesis.rawJobReference.statusTool === "job_status" &&
      synthesis.rawJobReference.resultTool === "job_result"
    );
  }

  if (boundJudge) {
    if (synthesis.rawJobReference !== null) return false;
    // Current shape: a planned judge that was never claimed is recorded as an
    // explicit `skipped` bound to the planned provider.
    if (
      (run.status === "judge_skipped" || run.status === "finalized") &&
      synthesis.status === "skipped" &&
      synthesis.judgeModel === boundJudge
    ) {
      return true;
    }
    // Legacy shape (receipts minted by <= 2.17.x): before the plannedJudge
    // pending gate existed, a run with a planned judge and no judge link was
    // minted immediately as `not_requested` with a null judgeModel, then marked
    // `finalized`. Those receipts are valid immutable evidence produced by
    // shipped production code, and the canonical hashing they were minted under
    // is byte-identical to today's, so they must keep verifying. Accepting them
    // costs no integrity: it is reachable only when the run has NO judge link,
    // so no judge job's evidence can be hidden by this shape, and `finalized`
    // is exactly the state the legacy mint left behind (a `running` run with a
    // planned judge is still gated to `pending` and can never reach here).
    return (
      run.status === "finalized" &&
      synthesis.status === "not_requested" &&
      synthesis.judgeModel === null
    );
  }

  return (
    (run.status === "running" || run.status === "finalized") &&
    synthesis.status === "not_requested" &&
    synthesis.judgeModel === null &&
    synthesis.rawJobReference === null
  );
}

function verifiedReceiptEnvelope(
  record: ValidationReceiptRecord,
  run: ValidationRunRecord
): ValidationReceipt | null {
  if (
    record.schemaVersion !== VALIDATION_RECEIPT_SCHEMA_VERSION ||
    record.validationId !== run.validationId ||
    record.ownerPrincipal !== run.ownerPrincipal ||
    record.prevSha256 !== null ||
    record.seq !== null ||
    record.signature !== null
  ) {
    return null;
  }
  let rawReport: unknown;
  try {
    rawReport = JSON.parse(record.reportJson);
  } catch {
    return null;
  }
  const parsed = validationReportV1ContentSchema.safeParse(rawReport);
  if (!parsed.success) return null;
  const report = parsed.data as ValidationReportV1Content;
  const request = parseValidationRunRequest(run.requestJson);
  if (!request) return null;
  const actualSha256 = computeCanonicalSha256(report);
  if (!equalSha256(actualSha256, record.canonicalSha256)) return null;
  if (
    report.validationId !== record.validationId ||
    JSON.stringify(report.modelList) !== JSON.stringify(record.models) ||
    report.disagreements.hasMaterialDisagreement !== record.hasMaterialDisagreement ||
    report.confidence !== record.confidence ||
    report.intent !== run.intent ||
    report.startedAt !== run.createdAt ||
    !originalRequestMatchesRun(report, request) ||
    !providerRosterMatchesRun(report, run, request) ||
    !synthesisMatchesRun(report, run, request)
  ) {
    return null;
  }
  return {
    schemaVersion: record.schemaVersion,
    validationId: record.validationId,
    ownerPrincipal: record.ownerPrincipal,
    mintedAt: record.mintedAt,
    intent: report.intent,
    models: report.modelList as string[],
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
 * Absent for jobs that have been evicted or no longer expose a complete,
 * identity-matching output page.
 */
function collectRawResponses(
  deps: ReceiptDeps,
  receipt: ValidationReceipt,
  caller: string
): RawResponse[] {
  const out: RawResponse[] = [];
  const refs: Array<{ provider: string; jobId: string; correlationId: string }> = [];
  for (const output of receipt.report.perModelOutputs) {
    if (output.jobId && output.correlationId) {
      refs.push({
        provider: output.provider,
        jobId: output.jobId,
        correlationId: output.correlationId,
      });
    }
  }
  const judgeRef = receipt.report.synthesis.rawJobReference;
  if (judgeRef?.jobId) {
    refs.push({
      provider: receipt.report.synthesis.judgeModel ?? "judge",
      jobId: judgeRef.jobId,
      correlationId: judgeRef.correlationId,
    });
  }
  for (const ref of refs) {
    let owner: string | null | undefined;
    let jobResult: AsyncJobResult | null;
    try {
      owner = deps.asyncJobManager.getJobOwner(ref.jobId);
      jobResult = deps.asyncJobManager.getJobResult(ref.jobId, Number.MAX_SAFE_INTEGER);
    } catch {
      continue;
    }
    if (
      !principalCanAccess(owner, caller) ||
      !jobResult ||
      jobResult.id !== ref.jobId ||
      String(jobResult.cli) !== ref.provider ||
      jobResult.correlationId !== ref.correlationId ||
      !isTerminal(jobResult.status) ||
      !hasCompleteOutput(jobResult)
    ) {
      continue;
    }
    out.push({ provider: ref.provider, jobId: ref.jobId, text: jobResult.stdout });
  }
  return out;
}

function mintedResult(
  deps: ReceiptDeps,
  record: ValidationReceiptRecord,
  run: ValidationRunRecord,
  includeRawResponses: boolean,
  caller: string
): ValidationReceiptResult {
  const receipt = verifiedReceiptEnvelope(record, run);
  // A stored receipt that fails verification is a failure, not an absence:
  // report it as such rather than as `expired_unminted` ("never minted").
  if (!receipt) return { status: "verification_failed", validationId: run.validationId };
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
    // The run is the durable ownership authority. Authorizing from receipt
    // metadata before cross-checking it would let a corrupted receipt owner
    // transfer visibility without invalidating the report-only canonical hash.
    const run = store.getValidationRun(validationId);
    if (
      !run ||
      run.validationId !== validationId ||
      !principalCanAccess(run.ownerPrincipal, opts.caller)
    ) {
      return { status: "not_found", validationId };
    }
    return mintedResult(deps, existing, run, opts.includeRawResponses ?? false, opts.caller);
  }

  const run = store.getValidationRun(validationId);
  if (!run || !principalCanAccess(run.ownerPrincipal, opts.caller)) {
    return { status: "not_found", validationId };
  }

  const outcome = tryMint(deps, run);
  if (outcome.kind === "minted") {
    return mintedResult(deps, outcome.record, run, opts.includeRawResponses ?? false, opts.caller);
  }
  if (outcome.kind === "unmintable") {
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
  let validationId: string | null;
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
