import { randomUUID } from "node:crypto";
import type { AsyncJobManager } from "./async-job-manager.js";
import { getProviderRuntimeStatus, type ProviderRuntimeStatus } from "./provider-status.js";
import {
  normalizeJobResult,
  normalizeSkippedProvider,
  normalizeStartedJob,
  type NormalizedValidationResult,
  type ValidationProvider,
} from "./validation-normalizer.js";
import { buildValidationReport, type ValidationReport } from "./validation-report.js";
import {
  buildJudgePrompt,
  buildValidationPrompt,
  type ValidationIntent,
} from "./validation-prompts.js";

export interface ValidationOrchestratorDeps {
  asyncJobManager: AsyncJobManager;
  getProviderRuntimeStatus?: (provider: ValidationProvider) => ProviderRuntimeStatus;
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
  status: "running" | "partial" | "not_started";
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
    status: "not_requested" | "waiting_for_provider_results" | "running" | "skipped";
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
  const skippedCount = results.filter(result => result.status === "skipped").length;
  const synthesis = plannedJudgeSynthesis(input);
  const status: ValidationRunReport["status"] =
    runningCount === 0 ? "not_started" : skippedCount > 0 ? "partial" : "running";
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

  const runtimeStatus = deps.getProviderRuntimeStatus ?? getProviderRuntimeStatus;
  const runtime = runtimeStatus(input.judgeProvider);
  if (!runtime.installed) {
    return {
      status: "skipped",
      judgeModel: input.judgeProvider,
      rawJobReference: null,
      note: `${runtime.displayName} was selected as judge but is not installed.`,
    };
  }

  const snapshot = deps.asyncJobManager.startJob(
    input.judgeProvider,
    buildProviderArgs(
      input.judgeProvider,
      buildJudgePrompt({
        question: input.question,
        providerResults: completedResults,
      })
    ),
    `validation-judge-${randomUUID()}-${input.judgeProvider}`
  );
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
  const runtimeStatus = deps.getProviderRuntimeStatus ?? getProviderRuntimeStatus;
  const runtime = runtimeStatus(provider);
  if (!runtime.installed) {
    return normalizeSkippedProvider(provider, `${runtime.displayName} runtime is not installed.`);
  }

  const warning =
    runtime.loginStatus === "authenticated"
      ? undefined
      : `${runtime.displayName} login status is ${runtime.loginStatus}; the job may fail until login is complete.`;
  const snapshot = deps.asyncJobManager.startJob(
    provider,
    buildProviderArgs(provider, prompt),
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

function buildProviderArgs(provider: ValidationProvider, prompt: string): string[] {
  if (provider === "claude" || provider === "grok" || provider === "mistral") {
    // Mistral Vibe mirrors Grok's `-p PROMPT` headless surface. Model selection
    // is via VIBE_ACTIVE_MODEL env var (no --model flag); for validation runs we
    // let the user's environment pick the active model.
    return ["-p", prompt];
  }
  if (provider === "codex") return ["exec", "--skip-git-repo-check", prompt];
  return [prompt];
}

function uniqueProviders(providers: ValidationProvider[]): ValidationProvider[] {
  return Array.from(new Set(providers));
}
