import { randomUUID } from "node:crypto";
import type { AsyncJobManager, AsyncJobSnapshot } from "./async-job-manager.js";
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
import type { ValidationRunLink, ValidationRunStore } from "./job-store.js";
import { getRequestContext, principalCanAccess, resolveOwnerPrincipal } from "./request-context.js";
import {
  buildJudgePrompt,
  buildValidationPrompt,
  type ValidationIntent,
} from "./validation-prompts.js";

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
  correlationId: string
): AsyncJobSnapshot {
  const api = findApiReviewer(deps, provider);
  if (api) {
    const apiProvider = createApiProvider(api.name, api.kind);
    const apiRequest = prepareApiRequest(api, { prompt });
    // Slice 1: reviewer http jobs are pure-async (the orchestrator polls the
    // snapshot), so the manager owns logStart + the usage-bearing logComplete.
    return deps.asyncJobManager.startHttpJob({
      provider: apiProvider,
      apiRequest,
      correlationId,
      writeFlightStart: true,
      flightRecorderEntry: { model: apiRequest.model, prompt },
    }).snapshot;
  }
  return deps.asyncJobManager.startJob(
    provider as CliType,
    buildProviderArgs(provider, prompt),
    correlationId
  );
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
  }
): ValidationRunReport["synthesis"] {
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
    return {
      status: "skipped",
      judgeModel: input.judgeProvider,
      rawJobReference: null,
      note: "Judge synthesis requires at least one completed provider result; skipped, failed, canceled, or orphaned results are preserved in the report but are not judge evidence.",
    };
  }

  const runtime = resolveReviewerStatus(deps, input.judgeProvider);
  if (!runtime.installed) {
    return {
      status: "skipped",
      judgeModel: input.judgeProvider,
      rawJobReference: null,
      note: `${runtime.displayName} was selected as judge but is not installed.`,
    };
  }

  const snapshot = dispatchProviderJob(
    deps,
    input.judgeProvider,
    buildJudgePrompt({
      question: input.question,
      providerResults: completedResults,
    }),
    `validation-judge-${randomUUID()}-${input.judgeProvider}`
  );
  linkJudgeJob(deps, input.validationId, input.judgeProvider, snapshot);
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
  validationId: string
): NormalizedValidationResult {
  const runtime = resolveReviewerStatus(deps, provider);
  if (!runtime.installed) {
    return normalizeSkippedProvider(provider, `${runtime.displayName} runtime is not installed.`);
  }

  const warning =
    runtime.loginStatus === "authenticated"
      ? undefined
      : `${runtime.displayName} login status is ${runtime.loginStatus}; the job may fail until login is complete.`;
  const snapshot = dispatchProviderJob(
    deps,
    provider,
    prompt,
    `validation-${validationId}-${provider}`
  );
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
 * row at kickoff. No-op when no durable run store is wired (non-sqlite backend).
 * Swallows persistence errors so a storage hiccup never breaks the kickoff.
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
  }
): void {
  const store = deps.validationRunStore;
  if (!store) return;
  try {
    const providerLinks: ValidationRunLink[] = args.results
      .filter(result => result.rawJobReference !== null)
      .map(result => ({
        provider: String(result.provider),
        jobId: result.rawJobReference!.jobId,
        correlationId: result.rawJobReference!.correlationId,
      }));
    store.recordValidationRun({
      validationId: args.validationId,
      ownerPrincipal: resolveOwnerPrincipal(getRequestContext()),
      intent: args.intent,
      createdAt: args.startedAt,
      requestJson: JSON.stringify({
        question: args.input.question,
        content: args.input.content,
        focus: args.input.focus,
        riskLevel: args.input.riskLevel,
        modelList: args.providers,
        judgeProvider: args.input.judgeProvider ?? null,
      }),
      providerLinks,
      judgeLink: null,
      status: "running",
    });
  } catch {
    // Graceful degradation: a persistence hiccup must not fail the validation
    // kickoff. The validationId is still returned; the run simply is not durable.
  }
}

function buildProviderArgs(provider: ValidationProvider, prompt: string): string[] {
  if (provider === "claude" || provider === "grok" || provider === "mistral") {
    // Mistral Vibe mirrors Grok's `-p PROMPT` headless surface. Model selection
    // is via VIBE_ACTIVE_MODEL env var (no --model flag); for validation runs we
    // let the user's environment pick the active model.
    return ["-p", prompt];
  }
  if (provider === "devin") return ["-p", prompt];
  if (provider === "cursor") return ["--print", "--mode", "ask", "--sandbox", "enabled", prompt];
  if (provider === "codex") return ["exec", "--skip-git-repo-check", prompt];
  return [prompt];
}

function uniqueProviders(providers: ValidationProvider[]): ValidationProvider[] {
  return Array.from(new Set(providers));
}
