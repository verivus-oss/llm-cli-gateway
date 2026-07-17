import { createHash, randomUUID } from "node:crypto";
import type {
  AsyncJobManager,
  AsyncJobSnapshot,
  DeferredJobLaunch,
  StartJobOutcome,
} from "./async-job-manager.js";
import { DurableJobAdmissionError } from "./async-job-manager.js";
import { getProviderRuntimeStatus, type ProviderRuntimeStatus } from "./provider-status.js";
import type { CliType } from "./provider-types.js";
import { createApiProvider } from "./api-provider.js";
import { prepareApiRequest } from "./api-request.js";
import type { ApiProviderRuntime } from "./config.js";
import {
  normalizeJobResult,
  normalizeSkippedProvider,
  normalizeStartedJob,
  type NormalizedValidationResult,
  type ValidationProvider,
} from "./validation-normalizer.js";
import {
  buildValidationReport,
  deriveValidationRunStatus,
  type ValidationReport,
} from "./validation-report.js";
import type {
  ValidationJobAdmission,
  ValidationRunLink,
  ValidationRunRecord,
  ValidationRunStore,
} from "./job-store.js";
import { getRequestContext, principalCanAccess, resolveOwnerPrincipal } from "./request-context.js";
import {
  buildJudgePrompt,
  buildReviewJudgePrompt,
  buildValidationPrompt,
  type DurableReviewJudgeEvidence,
  type ValidationIntent,
} from "./validation-prompts.js";
import { appendCliPrompt, sanitizeCliArgValue } from "./request-helpers.js";
import { assertUpstreamCliArgs } from "./upstream-contracts.js";
import {
  assertCliArgUtf8Size,
  isCliInputAdmissionError,
  planCodexStdinPrompt,
} from "./cli-input-limits.js";
import {
  isAuthorizedReviewRepositoryRoot,
  type ReviewRunAuthorization,
} from "./review-run-authorization.js";

// Slice 3 review-integrity decision (plan §3, option b): validation reviewers —
// CLI *and* API alike — are intentionally OUT OF SCOPE for the direct-request
// `checkReviewIntegrity` gate. That gate runs only inside the per-CLI `*_request`
// handlers in index.ts to detect an orchestrating agent suppressing review tools;
// validation jobs carry no allowed/disallowed-tools surface to inspect, so the
// orchestrator deliberately does not invoke it. Adding an API reviewer does not
// change this (it was never applied on the validation path).

export interface ValidationOrchestratorDeps {
  asyncJobManager: AsyncJobManager;
  getProviderRuntimeStatus?: (provider: ValidationProvider) => ProviderRuntimeStatus;
  /**
   * Slice 3: enabled API providers usable as reviewers. When a requested
   * provider matches one of these by name, the orchestrator dispatches it as an
   * http job (startHttpJob) instead of spawning a CLI. Undefined/empty keeps the
   * pre-Slice-3 CLI-only behaviour.
   */
  apiProviders?: ApiProviderRuntime[];
  /**
   * Cross-LLM validation receipts (Phase 0): when present (attached store with
   * validation-run capability), `startValidationRun` persists a
   * `validation_runs` row at kickoff and `startJudgeSynthesis` links the judge
   * job back into it. Absent under non-durable backends, where no run row is ever
   * written, so the caller still gets a `validationId` but no durable,
   * retrievable run.
   */
  validationRunStore?: ValidationRunStore | null;
  /** Resolve a concrete CLI cwd under the caller's local or remote workspace policy. */
  resolveProviderCwd?: (provider: CliType) => string | undefined;
}

/** Slice 3: the enabled API-provider runtime for `provider`, or null (a CLI). */
function findApiReviewer(
  deps: ValidationOrchestratorDeps,
  provider: ValidationProvider
): ApiProviderRuntime | null {
  return deps.apiProviders?.find(p => p.name === provider) ?? null;
}

/** The reviewer-status fields the orchestrator actually consumes. */
interface ReviewerStatus {
  installed: boolean;
  version: string | null;
  loginStatus: ProviderRuntimeStatus["loginStatus"];
  displayName: string;
}

/**
 * Slice 3: reviewer runtime status that knows about API providers. A configured
 * API provider is "installed" (no version/login probe — it is an HTTP endpoint);
 * everything else falls through to the CLI `getProviderRuntimeStatus`.
 */
function resolveReviewerStatus(
  deps: ValidationOrchestratorDeps,
  provider: ValidationProvider
): ReviewerStatus {
  const api = findApiReviewer(deps, provider);
  if (api) {
    return { installed: true, version: null, loginStatus: "authenticated", displayName: api.name };
  }
  const runtimeStatus = deps.getProviderRuntimeStatus ?? getProviderRuntimeStatus;
  return runtimeStatus(provider as CliType);
}

/**
 * Slice 3: single CLI-vs-API dispatch point used by both the reviewer jobs and
 * the judge synthesis. API providers route through `startHttpJob` with an
 * `ApiRequest` built by the SAME `prepareApiRequest` the direct api_<name>_request
 * tools use; CLI providers keep the argv `startJob` path.
 */
function dispatchProviderJob(
  deps: ValidationOrchestratorDeps,
  provider: ValidationProvider,
  prompt: string,
  correlationId: string,
  options: {
    cwd?: string;
    review?: boolean;
    forceRefresh?: boolean;
    deferLaunch?: boolean;
    validationAdmission?: ValidationJobAdmission;
  } = {}
): StartJobOutcome {
  const api = findApiReviewer(deps, provider);
  if (api) {
    const apiProvider = createApiProvider(api.name, api.kind);
    const apiRequest = prepareApiRequest(api, { prompt });
    const retainFlightRecord = options.review !== true;
    // Slice 1: reviewer http jobs are pure-async (the orchestrator polls the
    // snapshot), so the manager owns logStart + the usage-bearing logComplete.
    // Repository review evidence is retained with the job's configured expiry,
    // not copied into the flight recorder, whose request rows have no matching
    // retention eviction policy.
    return deps.asyncJobManager.startHttpJob({
      provider: apiProvider,
      apiRequest,
      correlationId,
      writeFlightStart: retainFlightRecord,
      flightRecorderEntry: retainFlightRecord ? { model: apiRequest.model, prompt } : undefined,
      forceRefresh: options.forceRefresh,
      deferLaunch: options.deferLaunch,
      validationAdmission: options.validationAdmission,
    });
  }
  const cli = provider as CliType;
  const invocation = buildProviderInvocation(provider, prompt, options.review ?? false);
  assertUpstreamCliArgs(cli, invocation.args);
  const cwd = options.cwd ?? deps.resolveProviderCwd?.(cli);
  if (options.review) {
    const promptSha256 = createHash("sha256").update(prompt).digest("hex");
    return deps.asyncJobManager.startJobWithDedup(cli, invocation.args, correlationId, {
      cwd,
      stdin: invocation.stdin,
      persistedArgs: redactReviewPromptArgs(provider, invocation.args, prompt, promptSha256),
      payloadJson: JSON.stringify({
        schemaVersion: "review-job-input.v1",
        promptSha256,
        prompt,
      }),
      forceRefresh: options.forceRefresh,
      deferLaunch: options.deferLaunch,
      validationAdmission: options.validationAdmission,
    });
  }
  return deps.asyncJobManager.startJobWithDedup(cli, invocation.args, correlationId, {
    cwd,
    stdin: invocation.stdin,
    forceRefresh: options.forceRefresh,
    deferLaunch: options.deferLaunch,
    validationAdmission: options.validationAdmission,
  });
}

function redactReviewPromptArgs(
  provider: ValidationProvider,
  args: string[],
  prompt: string,
  promptSha256: string
): string[] {
  const redacted = [...args];
  const marker = `[review prompt retained in payload_json sha256=${promptSha256}]`;
  if (provider === "grok" || provider === "mistral") {
    const promptArg = `-p=${prompt}`;
    const index = redacted.indexOf(promptArg);
    if (index >= 0) redacted[index] = `-p=${marker}`;
    return redacted;
  }
  const index = redacted.lastIndexOf(prompt);
  if (index >= 0) redacted[index] = marker;
  return redacted;
}

export interface StartValidationInput {
  intent: ValidationIntent;
  question?: string;
  content?: string;
  providers: ValidationProvider[];
  focus?: string;
  riskLevel?: "normal" | "high";
  judgeProvider?: ValidationProvider;
}

export interface StartReviewInput {
  prompt: string;
  providers: ValidationProvider[];
  focus?: string;
  cwd: string;
  artifactSha256: string;
  artifactByteLength: number;
  scope: string;
  judgeProvider?: ValidationProvider;
  /** Explicit repository-upload policy bound durably to this review run. */
  reviewAuthorization: ReviewRunAuthorization;
}

export class ValidationRunPersistenceError extends Error {
  readonly code = "validation_run_persistence_failed";

  constructor() {
    super("The review run could not be bound to durable validation-run storage");
    this.name = "ValidationRunPersistenceError";
  }
}

export class ReviewRunAuthorizationError extends Error {
  readonly code = "review_run_authorization_invalid";

  constructor() {
    super("The review-run authorization does not match the requested repository review plan");
    this.name = "ReviewRunAuthorizationError";
  }
}

export interface ValidationRunReport {
  success: boolean;
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
  report: ValidationReport;
  next: string;
}

export function startValidationRun(
  deps: ValidationOrchestratorDeps,
  input: StartValidationInput
): ValidationRunReport {
  const validationId = randomUUID();
  const startedAt = new Date().toISOString();
  const prompt = buildValidationPrompt({
    intent: input.intent,
    question: input.question,
    content: input.content,
    focus: input.focus,
    riskLevel: input.riskLevel,
  });

  const providers = uniqueProviders(input.providers);
  const results = providers.map(provider => startProviderJob(deps, provider, prompt, validationId));
  const runningCount = results.filter(result => result.status === "running").length;
  const synthesis = plannedJudgeSynthesis(input);
  // Phase 0: derive via the shared helper so the run-level status can reach the
  // terminal `completed` value once results are collected. For kickoff inputs
  // (running/skipped results, non-terminal synthesis) this is identical to the
  // previous `runningCount === 0 ? not_started : skipped > 0 ? partial : running`.
  const status: ValidationRunReport["status"] = deriveValidationRunStatus(
    results,
    synthesis.status
  );

  // Cross-LLM validation receipts (Phase 0): persist durable run identity before
  // returning, mapping validationId -> the provider jobs that carry the outputs.
  // Only happens under a durable backend (validationRunStore present). Persistence
  // failure must not break kickoff: the caller still gets the validationId.
  persistValidationRun(deps, {
    validationId,
    startedAt,
    intent: input.intent,
    input,
    providers,
    results,
  });

  const reportInput = {
    validationId,
    status,
    startedAt,
    intent: input.intent,
    originalRequest: {
      question: input.question,
      content: input.content,
      focus: input.focus,
    },
    modelList: providers,
    results,
    synthesis,
  };

  return {
    success: runningCount > 0,
    validationId,
    status,
    startedAt,
    intent: input.intent,
    originalRequest: reportInput.originalRequest,
    modelList: providers,
    results,
    synthesis,
    report: buildValidationReport(reportInput),
    next: "Use job_status to poll each rawJobReference.jobId, job_result to collect provider outputs, then synthesize_validation if a judge summary is needed.",
  };
}

/**
 * Start a first-class repository review from an already verified and fenced
 * evidence prompt. The raw artifact stays in the provider job prompt; the
 * durable validation-run metadata records only its identity and scope.
 */
export function startReviewRun(
  deps: ValidationOrchestratorDeps,
  input: StartReviewInput
): ValidationRunReport {
  const providers = uniqueProviders(input.providers);
  const apiJudge = findApiReviewer(deps, input.judgeProvider ?? "");
  const includesApiUpload =
    apiJudge !== null || providers.some(provider => findApiReviewer(deps, provider) !== null);
  if (
    !isAuthorizedReviewRepositoryRoot(
      input.reviewAuthorization.repositoryPath,
      input.reviewAuthorization.repositoryRoot
    ) ||
    input.reviewAuthorization.repositoryRoot !== input.cwd ||
    input.reviewAuthorization.judgeProvider !== (input.judgeProvider ?? null) ||
    (includesApiUpload && !input.reviewAuthorization.allowApiUpload)
  ) {
    throw new ReviewRunAuthorizationError();
  }
  const validationId = randomUUID();
  const startedAt = new Date().toISOString();
  const originalRequest = {
    question: `Review artifact sha256=${input.artifactSha256} bytes=${input.artifactByteLength} scope=${input.scope}`,
    focus: input.focus,
  };
  const persistenceInput: StartValidationInput = {
    intent: "review",
    providers,
    question: originalRequest.question,
    focus: input.focus,
    judgeProvider: input.judgeProvider,
  };
  // Establish and verify the owner-scoped review authorization before any
  // reviewer can receive repository evidence. Each provider job is then
  // admitted and linked atomically behind a roster-wide launch barrier.
  persistValidationRun(deps, {
    validationId,
    startedAt,
    intent: "review",
    input: persistenceInput,
    providers,
    results: [],
    reviewAuthorization: input.reviewAuthorization,
    requireDurable: true,
    initialStatus: "admitting",
  });
  const results: NormalizedValidationResult[] = [];
  const deferredLaunches: DeferredJobLaunch[] = [];
  try {
    for (const provider of providers) {
      results.push(
        startProviderJob(deps, provider, input.prompt, validationId, {
          cwd: input.cwd,
          review: true,
          forceRefresh: true,
          deferLaunch: true,
          validationAdmission: { validationId, provider },
          deferredLaunches,
        })
      );
    }
    verifyValidationProviderLinks(deps, validationId, results);
    completeReviewAdmission(deps, validationId);
  } catch (error) {
    for (const deferred of deferredLaunches.reverse()) deferred.cancel();
    fenceReviewAdmission(deps, validationId);
    if (error instanceof DurableJobAdmissionError) {
      throw new ValidationRunPersistenceError();
    }
    throw error;
  }
  for (const deferred of deferredLaunches) deferred.release();
  const runningCount = results.filter(result => result.status === "running").length;
  const synthesis = plannedJudgeSynthesis({
    intent: "review",
    providers,
    judgeProvider: input.judgeProvider,
  });
  const status: ValidationRunReport["status"] = deriveValidationRunStatus(
    results,
    synthesis.status
  );
  const reportInput = {
    validationId,
    status,
    startedAt,
    intent: "review" as const,
    originalRequest,
    modelList: providers,
    results,
    synthesis,
  };
  return {
    success: runningCount > 0,
    validationId,
    status,
    startedAt,
    intent: "review",
    originalRequest,
    modelList: providers,
    results,
    synthesis,
    report: buildValidationReport(reportInput),
    next: "Use job_status to poll each rawJobReference.jobId and job_result to collect the evidence-backed reviews. If a judge was requested, call synthesize_validation only after every provider result is terminal and pass the same workingDir or workspace selector so the judge remains bound to the reviewed repository.",
  };
}

export function startJudgeSynthesis(
  deps: ValidationOrchestratorDeps,
  input: {
    question: string;
    providerResults: NormalizedValidationResult[];
    judgeProvider: ValidationProvider;
    /**
     * Cross-LLM validation receipts (Phase 0): the run this judge belongs to.
     * When supplied and the run exists and is owned by the caller, the judge job
     * is linked back into the durable run (`judge_link`). Absent or unowned: no
     * mutation, behaviour is exactly as before.
     */
    validationId?: string;
    /** Concrete repository cwd for a code-review judge. */
    cwd?: string;
    /** Apply provider-native read-only review controls to the judge. */
    review?: boolean;
    /** Exact terminal durable output, populated only by owned review-run binding. */
    reviewEvidence?: DurableReviewJudgeEvidence[];
  }
): ValidationRunReport["synthesis"] {
  if (input.review && !input.validationId) {
    throw new ValidationRunPersistenceError();
  }
  const pending = input.providerResults.find(
    result => result.status === "running" || result.verdict === "pending"
  );
  if (pending) {
    return {
      status: "waiting_for_provider_results",
      judgeModel: input.judgeProvider,
      rawJobReference: null,
      note: `Provider result for ${pending.provider} is still pending; collect terminal provider results before judge synthesis.`,
    };
  }
  const completedResults = input.providerResults.filter(result => result.status === "completed");
  const omittedResults = input.providerResults.filter(result => result.status !== "completed");
  if (completedResults.length === 0) {
    if (input.review) markReviewJudgeSkipped(deps, input.validationId!, input.judgeProvider);
    return {
      status: "skipped",
      judgeModel: input.judgeProvider,
      rawJobReference: null,
      note: "Judge synthesis requires at least one completed provider result; skipped, failed, canceled, or orphaned results are preserved in the report but are not judge evidence.",
    };
  }

  const runtime = resolveReviewerStatus(deps, input.judgeProvider);
  if (!runtime.installed) {
    if (input.review) markReviewJudgeSkipped(deps, input.validationId!, input.judgeProvider);
    return {
      status: "skipped",
      judgeModel: input.judgeProvider,
      rawJobReference: null,
      note: `${runtime.displayName} was selected as judge but is not installed.`,
    };
  }

  let snapshot: AsyncJobSnapshot;
  let deferredLaunch: DeferredJobLaunch | undefined;
  try {
    if (input.review && (!input.reviewEvidence || input.reviewEvidence.length === 0)) {
      throw new Error("Review judge synthesis requires complete durable provider evidence");
    }
    const judgePrompt = input.review
      ? buildReviewJudgePrompt({
          question: input.question,
          roster: input.providerResults.map(result => ({
            provider: String(result.provider),
            status: result.status,
            verdict: result.verdict,
            dispatched: result.rawJobReference !== null,
            jobId: result.rawJobReference?.jobId ?? null,
            correlationId: result.rawJobReference?.correlationId ?? null,
            error: result.error,
            warning: result.warning ?? null,
          })),
          evidence: input.reviewEvidence!,
        })
      : buildJudgePrompt({
          question: input.question,
          providerResults: completedResults,
        });
    const outcome = dispatchProviderJob(
      deps,
      input.judgeProvider,
      judgePrompt,
      `validation-judge-${randomUUID()}-${input.judgeProvider}`,
      {
        cwd: input.cwd,
        review: input.review,
        ...(input.review
          ? {
              forceRefresh: true,
              deferLaunch: true,
              validationAdmission: {
                validationId: input.validationId!,
                provider: input.judgeProvider,
                role: "judge" as const,
              },
            }
          : {}),
      }
    );
    snapshot = outcome.snapshot;
    deferredLaunch = outcome.deferredLaunch;
    if (input.review && !deferredLaunch) {
      deps.asyncJobManager.cancelJob(snapshot.id);
      throw new ValidationRunPersistenceError();
    }
  } catch (error) {
    if (error instanceof DurableJobAdmissionError) {
      throw new ValidationRunPersistenceError();
    }
    if (!isCliInputAdmissionError(error)) throw error;
    if (input.review) markReviewJudgeSkipped(deps, input.validationId!, input.judgeProvider);
    return {
      status: "skipped",
      judgeModel: input.judgeProvider,
      rawJobReference: null,
      note: error.message,
    };
  }
  if (input.review) deferredLaunch!.release();
  else linkJudgeJob(deps, input.validationId, input.judgeProvider, snapshot);
  return {
    status: "running",
    judgeModel: input.judgeProvider,
    rawJobReference: {
      jobId: snapshot.id,
      correlationId: snapshot.correlationId,
      statusTool: "job_status",
      resultTool: "job_result",
    },
    note:
      omittedResults.length > 0
        ? `Judge synthesis is running on ${runtime.displayName} using ${completedResults.length} completed provider result(s); ${omittedResults.length} non-completed result(s) were preserved but omitted.`
        : `Judge synthesis is running on ${runtime.displayName} using completed provider results.`,
  };
}

export function collectValidationJobResult(
  deps: ValidationOrchestratorDeps,
  provider: ValidationProvider,
  jobId: string,
  model: string | null,
  maxChars = 200000
): NormalizedValidationResult | null {
  const result = deps.asyncJobManager.getJobResult(jobId, maxChars);
  if (!result) return null;
  return normalizeJobResult(provider, model, result);
}

function startProviderJob(
  deps: ValidationOrchestratorDeps,
  provider: ValidationProvider,
  prompt: string,
  validationId: string,
  options: {
    cwd?: string;
    review?: boolean;
    forceRefresh?: boolean;
    deferLaunch?: boolean;
    validationAdmission?: ValidationJobAdmission;
    deferredLaunches?: DeferredJobLaunch[];
  } = {}
): NormalizedValidationResult {
  const runtime = resolveReviewerStatus(deps, provider);
  if (!runtime.installed) {
    return normalizeSkippedProvider(provider, `${runtime.displayName} runtime is not installed.`);
  }

  const warning =
    runtime.loginStatus === "authenticated"
      ? undefined
      : `${runtime.displayName} login status is ${runtime.loginStatus}; the job may fail until login is complete.`;
  let snapshot: AsyncJobSnapshot;
  try {
    const outcome = dispatchProviderJob(
      deps,
      provider,
      prompt,
      `validation-${validationId}-${provider}`,
      options
    );
    if (options.deferLaunch) {
      if (!outcome.deferredLaunch) {
        deps.asyncJobManager.cancelJob(outcome.snapshot.id);
        throw new ValidationRunPersistenceError();
      }
      options.deferredLaunches?.push(outcome.deferredLaunch);
    }
    snapshot = outcome.snapshot;
  } catch (error) {
    if (isCliInputAdmissionError(error)) {
      if (options.deferLaunch) throw error;
      return normalizeSkippedProvider(provider, error.message);
    }
    throw error;
  }
  return normalizeStartedJob(provider, runtime.version, snapshot, warning);
}

function plannedJudgeSynthesis(input: StartValidationInput): ValidationRunReport["synthesis"] {
  if (!input.judgeProvider) {
    return {
      status: "not_requested",
      judgeModel: null,
      rawJobReference: null,
      note: "No judge synthesis was requested; provider disagreement is preserved for the caller.",
    };
  }
  return {
    status: "waiting_for_provider_results",
    judgeModel: input.judgeProvider,
    rawJobReference: null,
    note: "Collect provider results first, then call synthesize_validation with those results.",
  };
}

/**
 * Cross-LLM validation receipts (Phase 0): link the judge job into its durable
 * run. No-op when no run store is wired, the run is unknown, or the run is owned
 * by a different principal (own-or-not-found: never mutate another caller's run).
 * Swallows persistence errors so a storage hiccup never breaks synthesis.
 */
function linkJudgeJob(
  deps: ValidationOrchestratorDeps,
  validationId: string | undefined,
  provider: ValidationProvider,
  snapshot: AsyncJobSnapshot
): void {
  const store = deps.validationRunStore;
  if (!store || !validationId) return;
  try {
    const run = store.getValidationRun(validationId);
    if (!run) return;
    if (!principalCanAccess(run.ownerPrincipal, resolveOwnerPrincipal(getRequestContext()))) return;
    if (run.status !== "running" || run.judgeLink || store.getValidationReceipt(validationId)) {
      return;
    }
    let plannedJudge: unknown = null;
    try {
      const request = JSON.parse(run.requestJson) as { judgeProvider?: unknown };
      plannedJudge = request.judgeProvider ?? null;
    } catch {
      return;
    }
    if (
      (plannedJudge !== null && typeof plannedJudge !== "string") ||
      (typeof plannedJudge === "string" && plannedJudge !== provider)
    ) {
      return;
    }
    store.setValidationJudgeLink(validationId, {
      provider: String(provider),
      jobId: snapshot.id,
      correlationId: snapshot.correlationId,
    });
  } catch {
    // Graceful degradation: a persistence hiccup must not fail synthesis.
  }
}

/**
 * Cross-LLM validation receipts (Phase 0): write the durable `validation_runs`
 * row at kickoff. No-op when no durable run store is wired. Ordinary validation
 * runs degrade gracefully on persistence failure. An API review-judge plan
 * requires an exact durable readback so the stored upload policy is authoritative.
 */
function persistValidationRun(
  deps: ValidationOrchestratorDeps,
  args: {
    validationId: string;
    startedAt: string;
    intent: ValidationIntent;
    input: StartValidationInput;
    providers: ValidationProvider[];
    results: NormalizedValidationResult[];
    reviewAuthorization?: ReviewRunAuthorization;
    requireDurable?: boolean;
    initialStatus?: ValidationRunRecord["status"];
  }
): void {
  const store = deps.validationRunStore;
  if (!store) {
    if (args.requireDurable) throw new ValidationRunPersistenceError();
    return;
  }
  try {
    const providerLinks: ValidationRunLink[] = args.results
      .filter(result => result.rawJobReference !== null)
      .map(result => ({
        provider: String(result.provider),
        jobId: result.rawJobReference!.jobId,
        correlationId: result.rawJobReference!.correlationId,
      }));
    const ownerPrincipal = resolveOwnerPrincipal(getRequestContext());
    const requestJson = JSON.stringify({
      question: args.input.question,
      content: args.input.content,
      focus: args.input.focus,
      riskLevel: args.input.riskLevel,
      modelList: args.providers,
      judgeProvider: args.input.judgeProvider ?? null,
      ...(args.reviewAuthorization ? { reviewAuthorization: args.reviewAuthorization } : {}),
    });
    store.recordValidationRun({
      validationId: args.validationId,
      ownerPrincipal,
      intent: args.intent,
      createdAt: args.startedAt,
      requestJson,
      providerLinks,
      judgeLink: null,
      status: args.initialStatus ?? "running",
    });
    if (args.requireDurable) {
      const persisted = store.getValidationRun(args.validationId);
      if (
        !persisted ||
        persisted.ownerPrincipal !== ownerPrincipal ||
        persisted.intent !== args.intent ||
        persisted.requestJson !== requestJson ||
        persisted.status !== (args.initialStatus ?? "running") ||
        JSON.stringify(persisted.providerLinks) !== JSON.stringify(providerLinks)
      ) {
        throw new ValidationRunPersistenceError();
      }
    }
  } catch (error) {
    if (args.requireDurable) {
      if (error instanceof ValidationRunPersistenceError) throw error;
      throw new ValidationRunPersistenceError();
    }
    // Graceful degradation: a persistence hiccup must not fail the validation
    // kickoff. The validationId is still returned; the run simply is not durable.
  }
}

function completeReviewAdmission(deps: ValidationOrchestratorDeps, validationId: string): void {
  const store = deps.validationRunStore;
  if (!store) throw new ValidationRunPersistenceError();
  const ownerPrincipal = resolveOwnerPrincipal(getRequestContext());
  try {
    if (
      !store.transitionValidationRunStatus(validationId, ownerPrincipal, "admitting", "running")
    ) {
      throw new ValidationRunPersistenceError();
    }
  } catch (error) {
    if (error instanceof ValidationRunPersistenceError) throw error;
    throw new ValidationRunPersistenceError();
  }
}

function fenceReviewAdmission(deps: ValidationOrchestratorDeps, validationId: string): void {
  const store = deps.validationRunStore;
  if (!store) throw new ValidationRunPersistenceError();
  const ownerPrincipal = resolveOwnerPrincipal(getRequestContext());
  try {
    const fenced = store.transitionValidationRunStatus(
      validationId,
      ownerPrincipal,
      "admitting",
      "admission_failed"
    );
    if (!fenced && store.getValidationRun(validationId)?.status !== "admission_failed") {
      throw new ValidationRunPersistenceError();
    }
  } catch (error) {
    if (error instanceof ValidationRunPersistenceError) throw error;
    throw new ValidationRunPersistenceError();
  }
}

function markReviewJudgeSkipped(
  deps: ValidationOrchestratorDeps,
  validationId: string,
  provider: ValidationProvider
): void {
  const store = deps.validationRunStore;
  if (!store) throw new ValidationRunPersistenceError();
  try {
    store.skipValidationJudge(
      validationId,
      String(provider),
      resolveOwnerPrincipal(getRequestContext())
    );
  } catch {
    throw new ValidationRunPersistenceError();
  }
}

function verifyValidationProviderLinks(
  deps: ValidationOrchestratorDeps,
  validationId: string,
  results: NormalizedValidationResult[]
): void {
  const store = deps.validationRunStore;
  if (!store) throw new ValidationRunPersistenceError();
  const providerLinks: ValidationRunLink[] = results
    .filter(result => result.rawJobReference !== null)
    .map(result => ({
      provider: String(result.provider),
      jobId: result.rawJobReference!.jobId,
      correlationId: result.rawJobReference!.correlationId,
    }));
  try {
    const persisted = store.getValidationRun(validationId);
    if (!persisted || JSON.stringify(persisted.providerLinks) !== JSON.stringify(providerLinks)) {
      throw new ValidationRunPersistenceError();
    }
  } catch (error) {
    if (error instanceof ValidationRunPersistenceError) throw error;
    throw new ValidationRunPersistenceError();
  }
}

interface ValidationCliInvocation {
  args: string[];
  stdin?: string;
}

function guardedArgvInvocation(
  provider: string,
  promptArg: string,
  args: string[]
): ValidationCliInvocation {
  assertCliArgUtf8Size(promptArg, { provider, inputName: "validation prompt" });
  return { args };
}

function buildProviderInvocation(
  provider: ValidationProvider,
  prompt: string,
  review = false
): ValidationCliInvocation {
  if (provider === "claude") {
    const args = ["-p", ...(review ? ["--permission-mode", "plan"] : [])];
    appendCliPrompt(args, prompt);
    // The current mechanical contract verifies stream-json stdin only. Keep
    // plain validation prompts on argv until text stdin has equivalent evidence.
    return guardedArgvInvocation(provider, prompt, args);
  }
  // Grok and Vibe do not honor an end-of-options marker after `-p`.
  // Keeping the review prompt in the inline value prevents a leading dash
  // from becoming an independently parsed provider option.
  if (provider === "grok" || provider === "mistral") {
    const promptArg = `-p=${prompt}`;
    const reviewArgs = provider === "grok" ? ["--permission-mode", "plan"] : ["--agent", "plan"];
    return guardedArgvInvocation(provider, promptArg, [promptArg, ...(review ? reviewArgs : [])]);
  }
  if (provider === "devin") {
    const args = ["-p", ...(review ? ["--permission-mode", "auto", "--sandbox"] : [])];
    appendCliPrompt(args, prompt);
    return guardedArgvInvocation(provider, prompt, args);
  }
  if (provider === "cursor") {
    const args = ["--print", "--mode", review ? "plan" : "ask", "--sandbox", "enabled"];
    appendCliPrompt(args, prompt);
    return guardedArgvInvocation(provider, prompt, args);
  }
  if (provider === "codex") {
    const args = ["exec", "--skip-git-repo-check", ...(review ? ["--sandbox", "read-only"] : [])];
    const planned = planCodexStdinPrompt(prompt);
    appendCliPrompt(args, planned.argument);
    return { args, stdin: planned.stdin };
  }
  if (provider === "gemini") {
    const promptArg = sanitizeCliArgValue(prompt, "prompt");
    return guardedArgvInvocation(provider, promptArg, [
      "--print",
      ...(review ? ["--mode", "plan", "--sandbox"] : []),
      promptArg,
    ]);
  }
  throw new Error(`Unsupported CLI validation provider: ${provider}`);
}

function uniqueProviders(providers: ValidationProvider[]): ValidationProvider[] {
  return Array.from(new Set(providers));
}
