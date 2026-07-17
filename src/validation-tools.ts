import { z } from "zod/v3";
import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AsyncJobManager } from "./async-job-manager.js";
import { CLI_TYPES } from "./session-manager.js";
import { getAvailableCliInfo } from "./model-registry.js";
import { apiProviderCatalogEntry } from "./api-request.js";
import { getRequestContext, principalCanAccess, resolveOwnerPrincipal } from "./request-context.js";
import { PerformanceMetrics } from "./metrics.js";
import { loadLeastCostConfig, type ApiProviderRuntime, type LeastCostConfig } from "./config.js";
import { buildRouterEnv, toRouterConfig } from "./lcr-router-env.js";
import {
  selectCandidate,
  selectCheapestPerTier,
  type RouteDecision,
  type RouteRequestInput,
} from "./least-cost-router.js";
import type { FlightRecorderQuery } from "./flight-recorder.js";
import {
  normalizeJobResult,
  normalizeSkippedProvider,
  type NormalizedValidationResult,
  type ValidationProvider,
} from "./validation-normalizer.js";
import type { ValidationRunRecord } from "./job-store.js";
import {
  currentCaller,
  eagerMintFromJobId,
  eagerMintFromValidationId,
  resolveValidationReceipt,
} from "./validation-receipt.js";
import {
  collectValidationJobResult,
  ReviewRunAuthorizationError,
  startJudgeSynthesis,
  startReviewRun,
  startValidationRun,
  ValidationRunPersistenceError,
  type ValidationOrchestratorDeps,
} from "./validation-orchestrator.js";
import {
  parseReviewRunAuthorization,
  REVIEW_RUN_AUTHORIZATION_SCHEMA_VERSION,
} from "./review-run-authorization.js";
import type { DurableReviewJudgeEvidence } from "./validation-prompts.js";
import {
  DEFAULT_REVIEW_ARTIFACT_MAX_BYTES,
  MAX_REVIEW_ARTIFACT_BYTES,
  ReviewScopeError,
  resolveReviewScope,
} from "./review-scope.js";
import {
  DEFAULT_REVIEW_PROMPT_MAX_BYTES,
  MAX_REVIEW_PROMPT_BYTES,
  ReviewPromptError,
  buildReviewPrompt,
} from "./review-prompt.js";
import { isCliInputAdmissionError } from "./cli-input-limits.js";

export interface ReviewRepositorySelection {
  workingDir?: string;
  workspace?: string;
  providers: ValidationProvider[];
  allowApiUpload: boolean;
}

export interface ValidationToolDeps extends ValidationOrchestratorDeps {
  asyncJobManager: AsyncJobManager;
  /**
   * Least-cost routing (LCR) phase_3: config for the opt-in
   * `select: "cheapest" | "cheapest_per_tier"` mode. Loaded from
   * `~/.llm-cli-gateway/config.toml` when omitted. `enabled=false` (the default)
   * makes any `select` request fail closed rather than route.
   */
  leastCost?: LeastCostConfig;
  /**
   * Per-provider metrics feeding the LCR tie-break (success rate, latency). A
   * fresh, history-free instance is used when omitted: cost ranking (the primary
   * key) is unaffected, only the secondary tie-break loses historical refinement.
   */
  performanceMetrics?: PerformanceMetrics;
  /** Flight-recorder read handle for LCR calibration priors. Neutral (k=1) when omitted. */
  flightRecorder?: FlightRecorderQuery;
  /** Resolve and authorize the concrete repository used by `review_changes`. */
  resolveReviewRepository?: (selection: ReviewRepositorySelection) => string;
  /** Register review_changes only when durable async jobs are available. */
  reviewChangesEnabled?: boolean;
}

/** LCR phase_3: the opt-in target-selection modes for the validation tools. */
type ProviderSelectMode = "cheapest" | "cheapest_per_tier";

const selectSchema = z
  .enum(["cheapest", "cheapest_per_tier"])
  .optional()
  .describe(
    "Optional least-cost routing: fill the provider target(s) from the LCR selector instead of the explicit list. 'cheapest' picks the single cheapest eligible provider; 'cheapest_per_tier' picks the cheapest in each quality tier. Requires [least_cost].enabled=true; fails closed (no default-list fallback) when disabled or nothing is eligible."
  );

/** Resolved, closure-captured inputs the LCR selection helper needs. */
interface LcrSelectionContext {
  asyncJobManager: AsyncJobManager;
  apiProviders: ApiProviderRuntime[];
  leastCost: LeastCostConfig;
  performanceMetrics: PerformanceMetrics;
  flightRecorder?: FlightRecorderQuery;
}

function selectorFailureMessage(decision: RouteDecision): string {
  const reasons = decision.rejected.map(
    r => `${r.candidate.provider}/${r.candidate.model}: ${r.reason}`
  );
  const detail = reasons.length > 0 ? ` Rejections: ${reasons.join("; ")}.` : "";
  return `least-cost routing found no eligible provider (${decision.error ?? "NoEligibleCandidate"}); no fallback to the default provider list (fail closed).${detail}`;
}

type SelectionResult = { ok: true; providers: ValidationProvider[] } | { ok: false; error: string };

/**
 * LCR phase_3: map a `select` mode to a concrete validation provider list via the
 * PURE selector. Fails closed (never returns the default list) when routing is
 * disabled or nothing is eligible. `singleProvider` tools always take the single
 * cheapest overall; only the multi-provider tools fan out per tier.
 */
function resolveSelectedProviders(
  ctx: LcrSelectionContext,
  prompt: string,
  mode: ProviderSelectMode,
  singleProvider: boolean
): SelectionResult {
  if (!ctx.leastCost.enabled) {
    return {
      ok: false,
      error:
        "select requires least-cost routing; set [least_cost].enabled=true in ~/.llm-cli-gateway/config.toml (no fallback to the default provider list).",
    };
  }
  const env = buildRouterEnv({
    performanceMetrics: ctx.performanceMetrics,
    limiterSnapshot: ctx.asyncJobManager.getLimiterSnapshot(),
    apiProviders: ctx.apiProviders,
    preferCatalogPrice: ctx.leastCost.preferCatalogPrice,
    flightRecorder: ctx.flightRecorder,
    priorsScope: ctx.leastCost.priorsScope,
    ownerPrincipal: resolveOwnerPrincipal(getRequestContext()),
  });
  const config = toRouterConfig(ctx.leastCost);
  const req: RouteRequestInput = { prompt };

  if (singleProvider || mode === "cheapest") {
    const decision = selectCandidate(req, env, config);
    if (!decision.chosen) return { ok: false, error: selectorFailureMessage(decision) };
    return { ok: true, providers: [decision.chosen.provider as ValidationProvider] };
  }

  const decisions = selectCheapestPerTier(req, env, config);
  const seen = new Set<string>();
  const providers: ValidationProvider[] = [];
  for (const decision of decisions) {
    if (!decision.chosen || seen.has(decision.chosen.provider)) continue;
    seen.add(decision.chosen.provider);
    providers.push(decision.chosen.provider as ValidationProvider);
  }
  if (providers.length === 0) {
    return {
      ok: false,
      error:
        "least-cost routing found no eligible provider for select='cheapest_per_tier' (fail closed).",
    };
  }
  return { ok: true, providers };
}

/**
 * Slice 3: build the validation provider enum from the live enabled set — the
 * spawnable CLIs plus every enabled API provider name. Pre-Slice-3 callers (no
 * apiProviders) get the original CLI-only enum shape.
 */
export function buildValidationSchemas(deps: ValidationToolDeps) {
  const apiNames = (deps.apiProviders ?? []).map(p => p.name);
  const allowed = [...CLI_TYPES, ...apiNames] as [string, ...string[]];
  const providerSchema = z.enum(allowed);
  const providerListSchema = z.array(providerSchema).min(1).default(["claude", "codex"]);
  const normalizedProviderResultSchema = z.object({
    provider: providerSchema,
    model: z.string().nullable(),
    status: z.enum(["running", "completed", "failed", "canceled", "orphaned", "skipped"]),
    verdict: z.string().nullable(),
    rationale: z.string().nullable(),
    risks: z.array(z.string()).default([]),
    rawJobReference: z
      .object({
        jobId: z.string(),
        correlationId: z.string(),
        statusTool: z.literal("job_status"),
        resultTool: z.literal("job_result"),
      })
      .nullable(),
    error: z.string().nullable(),
    warning: z.string().optional(),
  });
  return { providerSchema, providerListSchema, normalizedProviderResultSchema };
}

const storedReviewSynthesisRequestSchema = z.object({
  question: z.string().min(1),
  modelList: z.array(z.string().min(1)).min(1),
  judgeProvider: z.string().min(1),
});

type ReviewSynthesisBinding =
  | {
      ok: true;
      question: string;
      providerResults: NormalizedValidationResult[];
      reviewEvidence: DurableReviewJudgeEvidence[];
    }
  | { ok: false; error: string };

function bindReviewSynthesisInput(
  deps: ValidationToolDeps,
  run: ValidationRunRecord,
  caller: string,
  judgeProvider: ValidationProvider
): ReviewSynthesisBinding {
  if (run.ownerPrincipal !== caller) {
    return { ok: false, error: "The review run is not owned by the current caller" };
  }
  if (run.status !== "running") {
    return { ok: false, error: "The review run is not open for judge synthesis" };
  }
  if (run.judgeLink !== null) {
    return { ok: false, error: "The review run already has a judge job" };
  }

  let storedRequest: z.infer<typeof storedReviewSynthesisRequestSchema>;
  try {
    const parsed = storedReviewSynthesisRequestSchema.safeParse(JSON.parse(run.requestJson));
    if (!parsed.success) {
      return { ok: false, error: "The durable review request is incomplete or invalid" };
    }
    storedRequest = parsed.data;
  } catch {
    return { ok: false, error: "The durable review request is incomplete or invalid" };
  }
  if (storedRequest.judgeProvider !== judgeProvider) {
    return { ok: false, error: "judgeModel does not match the judge bound to the review run" };
  }

  const requestedProviders = new Set(storedRequest.modelList);
  const linkedProviders = new Set(run.providerLinks.map(link => link.provider));
  if (
    requestedProviders.size !== storedRequest.modelList.length ||
    linkedProviders.size !== run.providerLinks.length ||
    [...linkedProviders].some(provider => !requestedProviders.has(provider))
  ) {
    return {
      ok: false,
      error: "The durable review provider roster contains duplicate or unexpected links",
    };
  }

  const providerResults: NormalizedValidationResult[] = [];
  const reviewEvidence: DurableReviewJudgeEvidence[] = [];
  const linkedJobIds = new Set<string>();
  const linkedCorrelationIds = new Set<string>();
  const linksByProvider = new Map(run.providerLinks.map(link => [link.provider, link]));
  for (const provider of storedRequest.modelList) {
    const link = linksByProvider.get(provider);
    if (!link) {
      providerResults.push(
        normalizeSkippedProvider(
          provider,
          "Provider was requested but not dispatched for this review run."
        )
      );
      continue;
    }
    if (
      !link.jobId ||
      !link.correlationId ||
      linkedJobIds.has(link.jobId) ||
      linkedCorrelationIds.has(link.correlationId)
    ) {
      return { ok: false, error: "The durable review provider links are invalid" };
    }
    linkedJobIds.add(link.jobId);
    linkedCorrelationIds.add(link.correlationId);
    let linkedValidationId: string | null;
    try {
      linkedValidationId = deps.validationRunStore?.getValidationRunIdByJobId(link.jobId) ?? null;
    } catch {
      return { ok: false, error: "Durable review provider link integrity is unavailable" };
    }
    if (linkedValidationId !== run.validationId) {
      return { ok: false, error: "A durable review provider job is linked to another run" };
    }
    let owner: string | null | undefined;
    let result: ReturnType<ValidationToolDeps["asyncJobManager"]["getJobResult"]>;
    try {
      owner = deps.asyncJobManager.getJobOwner(link.jobId);
      result = deps.asyncJobManager.getJobResult(link.jobId, Number.MAX_SAFE_INTEGER);
    } catch {
      return { ok: false, error: "Durable review provider evidence is unavailable" };
    }
    if (owner !== run.ownerPrincipal || !principalCanAccess(owner, caller)) {
      return { ok: false, error: "A durable review provider job is not owned by this run" };
    }
    if (!result) {
      return { ok: false, error: "A durable review provider result is missing" };
    }
    if (
      result.id !== link.jobId ||
      result.cli !== link.provider ||
      result.correlationId !== link.correlationId
    ) {
      return { ok: false, error: "A durable review provider result is mismatched" };
    }
    if (result.status === "queued" || result.status === "running") {
      return { ok: false, error: "Every durable review provider result must be terminal" };
    }
    if (
      result.outputTruncated ||
      result.stdoutTruncated ||
      result.stderrTruncated ||
      result.stdoutOffsetChars !== 0 ||
      result.stderrOffsetChars !== 0 ||
      result.stdoutNextOffsetChars !== null ||
      result.stderrNextOffsetChars !== null ||
      result.stdoutTotalChars !== result.stdout.length ||
      result.stderrTotalChars !== result.stderr.length
    ) {
      return {
        ok: false,
        error: "A durable review provider output is truncated or paging is incomplete",
      };
    }
    const stdoutByteLength = Buffer.byteLength(result.stdout, "utf8");
    const stderrByteLength = Buffer.byteLength(result.stderr, "utf8");
    if (result.stdoutBytes !== stdoutByteLength || result.stderrBytes !== stderrByteLength) {
      return {
        ok: false,
        error: "A durable review provider output byte identity is inconsistent",
      };
    }
    const stdoutSha256 = createHash("sha256").update(result.stdout).digest("hex");
    const stderrSha256 = createHash("sha256").update(result.stderr).digest("hex");
    reviewEvidence.push({
      schemaVersion: "review-judge-evidence.v1",
      provider: link.provider,
      jobId: link.jobId,
      correlationId: link.correlationId,
      status: result.status,
      exitCode: result.exitCode,
      error: result.error,
      stdout: { text: result.stdout, byteLength: stdoutByteLength, sha256: stdoutSha256 },
      stderr: { text: result.stderr, byteLength: stderrByteLength, sha256: stderrSha256 },
    });
    providerResults.push(normalizeJobResult(link.provider, result.model ?? null, result));
  }

  return {
    ok: true,
    question: storedRequest.question,
    providerResults,
    reviewEvidence,
  };
}

function textResponse(body: unknown) {
  const text = responseText(body);
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: body as Record<string, unknown>,
  };
}

function responseText(body: unknown): string {
  const report = findHumanReadableReport(body);
  if (report) return report;
  return JSON.stringify(body, null, 2);
}

function findHumanReadableReport(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  if (
    "humanReadable" in value &&
    typeof (value as { humanReadable?: unknown }).humanReadable === "string"
  ) {
    return (value as { humanReadable: string }).humanReadable;
  }
  if ("report" in value) {
    return findHumanReadableReport((value as { report?: unknown }).report);
  }
  return null;
}

export function registerValidationTools(server: McpServer, deps: ValidationToolDeps): void {
  const { providerSchema, providerListSchema, normalizedProviderResultSchema } =
    buildValidationSchemas(deps);
  // LCR phase_3: resolve the least-cost inputs once at registration. Config is
  // read from disk only when the runtime did not inject it; metrics default to a
  // fresh (history-free) instance so cost ranking still works without wiring.
  const selectionContext: LcrSelectionContext = {
    asyncJobManager: deps.asyncJobManager,
    apiProviders: deps.apiProviders ?? [],
    leastCost: deps.leastCost ?? loadLeastCostConfig(),
    performanceMetrics: deps.performanceMetrics ?? new PerformanceMetrics(),
    flightRecorder: deps.flightRecorder,
  };
  if (deps.resolveReviewRepository && deps.reviewChangesEnabled) {
    server.tool(
      "review_changes",
      "Capture one complete, immutable Git evidence artifact, fence it as untrusted data, and start independent read-only provider reviews. Includes committed, staged, unstaged, and untracked changes without truncation.",
      {
        workingDir: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Absolute local path to the checkout. Stdio/local callers should use this; remote HTTP/OAuth callers must use workspace instead."
          ),
        workspace: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/)
          .optional()
          .describe("Authorized workspace alias, required for remote HTTP/OAuth callers."),
        scope: z
          .enum(["auto", "uncommitted", "branch", "commit"])
          .default("auto")
          .describe(
            "Review scope. auto reviews a diverged branch from its merge-base with working-tree evidence included, otherwise reviews dirty uncommitted changes, and falls back to the last commit when the tree is clean."
          ),
        base: z
          .string()
          .min(1)
          .max(512)
          .optional()
          .describe("Explicit Git base ref or commit. Overrides automatic base selection."),
        paths: z
          .array(z.string().min(1).max(4096))
          .max(256)
          .optional()
          .describe("Optional literal repository-relative path filters."),
        stance: z.enum(["standard", "adversarial"]).default("standard"),
        focus: z
          .string()
          .max(20000)
          .optional()
          .describe("Additional reviewer focus outside the untrusted evidence boundary."),
        models: providerListSchema.describe(
          "Independent providers to start. Defaults to Claude and Codex."
        ),
        judgeModel: providerSchema
          .optional()
          .describe(
            "Optional judge provider to reconcile terminal reviews in a second step. An HTTP/API judge requires allowApiUpload=true, which is bound to the durable validationId."
          ),
        allowApiUpload: z
          .boolean()
          .default(false)
          .describe(
            "Explicitly allow repository review evidence to be sent to configured HTTP/API reviewers or a planned API judge. API judge consent is bound to the durable validationId; remote workspace reviews do not permit API upload."
          ),
        maxArtifactBytes: z
          .number()
          .int()
          .min(1024)
          .max(MAX_REVIEW_ARTIFACT_BYTES)
          .default(DEFAULT_REVIEW_ARTIFACT_MAX_BYTES)
          .describe("Fail-closed byte ceiling for the complete serialized Git artifact."),
        maxPromptBytes: z
          .number()
          .int()
          .min(1024)
          .max(MAX_REVIEW_PROMPT_BYTES)
          .default(DEFAULT_REVIEW_PROMPT_MAX_BYTES)
          .describe("Fail-closed byte ceiling for the fenced provider prompt."),
      },
      {
        title: "Review repository changes",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      async ({
        workingDir,
        workspace,
        scope,
        base,
        paths,
        stance,
        focus,
        models,
        judgeModel,
        allowApiUpload,
        maxArtifactBytes,
        maxPromptBytes,
      }) => {
        try {
          const providers = Array.from(new Set(models)) as ValidationProvider[];
          const allProviders = judgeModel
            ? (Array.from(new Set([...providers, judgeModel])) as ValidationProvider[])
            : providers;
          const apiReviewers = allProviders.filter(
            provider => !(CLI_TYPES as readonly string[]).includes(provider)
          );
          if (apiReviewers.length > 0 && !allowApiUpload) {
            return textResponse({
              success: false,
              tool: "review_changes",
              error:
                "HTTP/API review seats require allowApiUpload=true because the complete repository artifact leaves the local CLI boundary",
              providers: apiReviewers,
            });
          }
          const apiJudge =
            judgeModel && !(CLI_TYPES as readonly string[]).includes(judgeModel)
              ? judgeModel
              : null;
          if (apiJudge && !deps.validationRunStore) {
            return textResponse({
              success: false,
              tool: "review_changes",
              error:
                "An HTTP/API judge requires durable validation-run storage so upload consent can be bound to the review",
              providers: [apiJudge],
            });
          }
          const repositoryPath = deps.resolveReviewRepository!({
            workingDir,
            workspace,
            providers: allProviders,
            allowApiUpload,
          });
          const resolved = resolveReviewScope({
            repositoryPath,
            mode: scope,
            base,
            paths,
            maxArtifactBytes,
          });
          const built = buildReviewPrompt({
            artifact: resolved.artifact,
            stance,
            focus,
            maxPromptBytes,
          });
          const report = startReviewRun(deps, {
            prompt: built.prompt,
            providers,
            focus,
            cwd: resolved.repositoryRoot,
            artifactSha256: resolved.artifact.sha256,
            artifactByteLength: resolved.artifact.byteLength,
            scope: resolved.resolvedMode,
            judgeProvider: judgeModel,
            reviewAuthorization: {
              schemaVersion: REVIEW_RUN_AUTHORIZATION_SCHEMA_VERSION,
              repositoryPath,
              repositoryRoot: resolved.repositoryRoot,
              judgeProvider: judgeModel ?? null,
              allowApiUpload,
            },
          });
          return textResponse({
            success: report.success,
            tool: "review_changes",
            evidence: {
              schemaVersion: resolved.schemaVersion,
              complete: true,
              sha256: resolved.artifact.sha256,
              byteLength: resolved.artifact.byteLength,
              promptSha256: built.sha256,
              promptByteLength: built.byteLength,
              requestedMode: resolved.requestedMode,
              resolvedMode: resolved.resolvedMode,
              baseRef: resolved.baseRef,
              baseSha: resolved.baseSha,
              baseTipSha: resolved.baseTipSha,
              headSha: resolved.headSha,
              mergeBaseSha: resolved.mergeBaseSha,
              workingTreeIncluded: resolved.workingTreeIncluded,
              files: resolved.files,
              stance: built.stance,
            },
            report,
          });
        } catch (error) {
          if (isCliInputAdmissionError(error)) {
            return textResponse({
              success: false,
              tool: "review_changes",
              error: error.message,
              errorCategory: error.errorCategory,
              retryable: error.retryable,
            });
          }
          if (
            error instanceof ReviewScopeError ||
            error instanceof ReviewPromptError ||
            error instanceof ReviewRunAuthorizationError ||
            error instanceof ValidationRunPersistenceError
          ) {
            return textResponse({
              success: false,
              tool: "review_changes",
              error: error.message,
              errorCategory: error.code,
              ...(error instanceof ReviewScopeError || error instanceof ReviewPromptError
                ? { details: error.details }
                : {}),
            });
          }
          throw error;
        }
      }
    );
  }
  server.tool(
    "validate_with_models",
    "Ask two or more provider CLIs to independently validate a question. Starts validation jobs — poll with job_status, collect with job_result (not llm_job_*).",
    {
      question: z.string().min(1).describe("Question or content to validate."),
      models: providerListSchema.describe("Providers to ask. Defaults to Claude and Codex."),
      focus: z
        .string()
        .default("correctness, missing assumptions, and practical next steps")
        .describe("What reviewers should pay attention to."),
      judgeModel: providerSchema
        .optional()
        .describe("Optional provider to run an explicit judge synthesis job."),
      select: selectSchema,
    },
    {
      title: "Multi-model validation",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({ question, models, focus, judgeModel, select }) => {
      let providers = models;
      if (select) {
        const resolved = resolveSelectedProviders(selectionContext, question, select, false);
        if (!resolved.ok) {
          return textResponse({
            success: false,
            tool: "validate_with_models",
            error: resolved.error,
          });
        }
        providers = resolved.providers;
      }
      return textResponse({
        success: true,
        tool: "validate_with_models",
        readMostly: true,
        report: startValidationRun(deps, {
          intent: "validate",
          question,
          providers,
          focus,
          judgeProvider: judgeModel,
        }),
      });
    }
  );

  server.tool(
    "second_opinion",
    "Ask one provider CLI to review an answer (starts a validation job; poll job_status, collect job_result).",
    {
      answer: z.string().min(1).describe("Answer to review."),
      question: z.string().optional().describe("Original question, if available."),
      model: providerSchema.default("codex").describe("Provider to ask for the second opinion."),
      select: selectSchema,
    },
    {
      title: "Second opinion",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({ answer, question, model, select }) => {
      let providers: ValidationProvider[] = [model];
      if (select) {
        const resolved = resolveSelectedProviders(selectionContext, answer, select, true);
        if (!resolved.ok) {
          return textResponse({ success: false, tool: "second_opinion", error: resolved.error });
        }
        providers = resolved.providers;
      }
      return textResponse({
        success: true,
        tool: "second_opinion",
        readMostly: true,
        report: startValidationRun(deps, {
          intent: "second_opinion",
          question,
          content: answer,
          providers,
        }),
      });
    }
  );

  server.tool(
    "compare_answers",
    "Summarize agreement/differences between caller-provided answers LOCALLY — does not call any provider.",
    {
      question: z.string().min(1).describe("Question the answers respond to."),
      answers: z.array(z.string().min(1)).min(2).describe("Two or more answers to compare."),
    },
    {
      title: "Compare answers (local)",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ question, answers }) =>
      textResponse({
        success: true,
        tool: "compare_answers",
        readMostly: true,
        comparison: {
          question,
          answerCount: answers.length,
          checks: ["agreement", "contradictions", "missing evidence", "actionable recommendation"],
          status: "local_summary_only",
          note: "Use validate_with_models when independent provider review is needed.",
        },
      })
  );

  server.tool(
    "red_team_review",
    "Challenge a plan, answer, or document for risks and failure modes via provider CLIs (starts validation jobs).",
    {
      content: z.string().min(1).describe("Plan, answer, or document to challenge."),
      riskLevel: z
        .enum(["normal", "high"])
        .default("normal")
        .describe("How aggressively to review."),
      models: providerListSchema.describe("Providers to ask for adversarial review."),
      select: selectSchema,
    },
    {
      title: "Red-team review",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({ content, riskLevel, models, select }) => {
      let providers = models;
      if (select) {
        const resolved = resolveSelectedProviders(selectionContext, content, select, false);
        if (!resolved.ok) {
          return textResponse({ success: false, tool: "red_team_review", error: resolved.error });
        }
        providers = resolved.providers;
      }
      return textResponse({
        success: true,
        tool: "red_team_review",
        readMostly: true,
        report: startValidationRun(deps, {
          intent: "red_team",
          content,
          providers,
          riskLevel,
        }),
      });
    }
  );

  server.tool(
    "consensus_check",
    "Ask provider CLIs whether they agree or disagree with a claim (starts validation jobs).",
    {
      claim: z.string().min(1).describe("Claim to check across providers."),
      models: providerListSchema.describe("Providers to ask for agreement or disagreement."),
      select: selectSchema,
    },
    {
      title: "Consensus check",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({ claim, models, select }) => {
      let providers = models;
      if (select) {
        const resolved = resolveSelectedProviders(selectionContext, claim, select, false);
        if (!resolved.ok) {
          return textResponse({ success: false, tool: "consensus_check", error: resolved.error });
        }
        providers = resolved.providers;
      }
      return textResponse({
        success: true,
        tool: "consensus_check",
        readMostly: true,
        report: startValidationRun(deps, {
          intent: "consensus",
          content: claim,
          providers,
        }),
      });
    }
  );

  server.tool(
    "ask_model",
    "Ask one provider CLI a question through the simplified validation surface (starts a validation job).",
    {
      question: z.string().min(1).describe("Question for one provider."),
      model: providerSchema.default("claude").describe("Provider to ask."),
      select: selectSchema,
    },
    {
      title: "Ask one model",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({ question, model, select }) => {
      let providers: ValidationProvider[] = [model];
      if (select) {
        const resolved = resolveSelectedProviders(selectionContext, question, select, true);
        if (!resolved.ok) {
          return textResponse({ success: false, tool: "ask_model", error: resolved.error });
        }
        providers = resolved.providers;
      }
      return textResponse({
        success: true,
        tool: "ask_model",
        readMostly: true,
        report: startValidationRun(deps, {
          intent: "ask_model",
          question,
          providers,
        }),
      });
    }
  );

  server.tool(
    "synthesize_validation",
    "Run an explicit judge model over validation results. General validation uses caller-supplied terminal results; review_changes rebuilds its question and results from the owned durable run.",
    {
      question: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Original request for general validation. Ignored for review_changes, which uses the question stored in the durable run."
        ),
      providerResults: z
        .array(normalizedProviderResultSchema)
        .default([])
        .describe(
          "Terminal normalized results for general validation. Ignored for review_changes, which reloads every exact linked durable job result."
        ),
      judgeModel: providerSchema.default("codex").describe("Provider to run the judge synthesis."),
      validationId: z
        .string()
        .optional()
        .describe(
          "Run id from kickoff. Optional for general validation, but required for review_changes so the stored question, provider jobs, repository, planned judge, and upload policy can be enforced."
        ),
      workingDir: z
        .string()
        .min(1)
        .optional()
        .describe(
          "For a review_changes run, the same absolute local checkout path used at kickoff."
        ),
      workspace: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/)
        .optional()
        .describe("For a remote review_changes run, the same authorized workspace alias."),
    },
    {
      title: "Synthesize validation",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({ question, providerResults, judgeModel, validationId, workingDir, workspace }) => {
      if (workingDir && workspace) {
        return textResponse({
          success: false,
          tool: "synthesize_validation",
          error: "Pass workingDir or workspace, not both",
        });
      }
      let review = false;
      let ownedRun = false;
      let ownedReviewRun: ValidationRunRecord | null = null;
      let reviewAuthorization: ReturnType<typeof parseReviewRunAuthorization> = null;
      if (validationId && deps.validationRunStore) {
        try {
          const run = deps.validationRunStore.getValidationRun(validationId);
          const caller = resolveOwnerPrincipal(getRequestContext());
          ownedRun = Boolean(run && principalCanAccess(run.ownerPrincipal, caller));
          review = Boolean(ownedRun && run?.intent === "review");
          if (review && run) {
            ownedReviewRun = run;
            reviewAuthorization = parseReviewRunAuthorization(run.requestJson);
          }
        } catch {
          return textResponse({
            success: false,
            tool: "synthesize_validation",
            error: "Durable validation-run authorization is unavailable",
          });
        }
      }
      let cwd: string | undefined;
      if (workingDir || workspace) {
        if (!deps.resolveReviewRepository) {
          return textResponse({
            success: false,
            tool: "synthesize_validation",
            error: "Repository review resolution is unavailable",
          });
        }
        if (validationId && deps.validationRunStore && !review) {
          return textResponse({
            success: false,
            tool: "synthesize_validation",
            error: "The validationId does not identify an owned review_changes run",
          });
        }
        if (ownedReviewRun && !reviewAuthorization) {
          return textResponse({
            success: false,
            tool: "synthesize_validation",
            error: "Durable review-run repository and judge authorization is unavailable",
          });
        }
        const apiJudge = !(CLI_TYPES as readonly string[]).includes(judgeModel);
        if (apiJudge) {
          if (!validationId || !reviewAuthorization) {
            return textResponse({
              success: false,
              tool: "synthesize_validation",
              error:
                "An HTTP/API review judge requires upload consent bound to an owned durable review_changes run",
            });
          }
          if (
            reviewAuthorization.judgeProvider !== judgeModel ||
            !reviewAuthorization.allowApiUpload
          ) {
            return textResponse({
              success: false,
              tool: "synthesize_validation",
              error: "The durable review run does not authorize this HTTP/API judge upload",
            });
          }
        } else if (reviewAuthorization && reviewAuthorization.judgeProvider !== judgeModel) {
          return textResponse({
            success: false,
            tool: "synthesize_validation",
            error: "judgeModel does not match the judge bound to the review run",
          });
        }
        const selectedRepositoryPath = deps.resolveReviewRepository({
          workingDir,
          workspace,
          providers: [judgeModel],
          allowApiUpload: reviewAuthorization?.allowApiUpload ?? false,
        });
        if (reviewAuthorization && selectedRepositoryPath !== reviewAuthorization.repositoryPath) {
          return textResponse({
            success: false,
            tool: "synthesize_validation",
            error: "The repository selector does not match the repository bound to the review run",
          });
        }
        cwd = reviewAuthorization?.repositoryRoot ?? selectedRepositoryPath;
        review = true;
      } else if (review) {
        return textResponse({
          success: false,
          tool: "synthesize_validation",
          error:
            "A review_changes judge requires the same workingDir or workspace selector used at kickoff",
        });
      } else if (validationId && deps.validationRunStore && !ownedRun) {
        return textResponse({
          success: false,
          tool: "synthesize_validation",
          error: "The validationId does not identify an owned validation run",
        });
      }
      let synthesisQuestion = question;
      let synthesisProviderResults = providerResults;
      let synthesisReviewEvidence: DurableReviewJudgeEvidence[] | undefined;
      if (ownedReviewRun) {
        const bound = bindReviewSynthesisInput(
          deps,
          ownedReviewRun,
          resolveOwnerPrincipal(getRequestContext()),
          judgeModel
        );
        if (!bound.ok) {
          return textResponse({
            success: false,
            tool: "synthesize_validation",
            error: bound.error,
            errorCategory: "review_synthesis_binding_failed",
          });
        }
        synthesisQuestion = bound.question;
        synthesisProviderResults = bound.providerResults;
        synthesisReviewEvidence = bound.reviewEvidence;
      } else if (!synthesisQuestion || synthesisProviderResults.length === 0) {
        return textResponse({
          success: false,
          tool: "synthesize_validation",
          error: "General validation synthesis requires question and providerResults",
        });
      }
      const synthesis = startJudgeSynthesis(deps, {
        question: synthesisQuestion,
        providerResults: synthesisProviderResults,
        judgeProvider: judgeModel,
        validationId,
        cwd,
        review,
        reviewEvidence: synthesisReviewEvidence,
      });
      // Phase 2: auto-mint convenience. If the run is already terminal (e.g. the
      // judge was skipped, or it had already completed), mint the receipt now
      // rather than requiring a separate validation_receipt call. A still-running
      // judge leaves the run non-terminal, so this is a no-op until the judge's
      // result is collected (where the job_result eager hook mints it).
      if (validationId) eagerMintFromValidationId(deps, validationId);
      return textResponse({
        success: true,
        tool: "synthesize_validation",
        readMostly: true,
        synthesis,
      });
    }
  );

  server.tool(
    "list_available_models",
    "List models and capabilities for every available provider CLI (takes no arguments; complements per-provider list_models).",
    {},
    {
      title: "All provider models",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async () => {
      // Slice 5: enabled API providers, clearly tagged providerKind:"api". OMIT
      // the field entirely when none are enabled so the catalog response is
      // byte-identical to pre-Slice-5 when the feature is dormant.
      const apiProviders = (deps.apiProviders ?? []).map(apiProviderCatalogEntry);
      return textResponse({
        success: true,
        models: getAvailableCliInfo(),
        ...(apiProviders.length > 0 ? { apiProviders } : {}),
      });
    }
  );

  server.tool(
    "job_status",
    "Check a VALIDATION job's status (jobs started by validate_with_models/ask_model/etc.) — distinct from llm_job_status, which tracks provider request jobs.",
    {
      jobId: z.string().min(1).describe("Validation job ID."),
    },
    {
      title: "Validation job status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ jobId }) => {
      // F3b owner check (cross-LLM validation receipts §5a): own-or-not-found.
      // A job owned by another principal is reported as absent, mirroring the
      // llm_job_status path; previously this surface had no ownership check.
      const job = deps.asyncJobManager.getJobSnapshot(jobId);
      const caller = resolveOwnerPrincipal(getRequestContext());
      if (!job || !principalCanAccess(deps.asyncJobManager.getJobOwner(jobId), caller)) {
        return textResponse({ success: false, error: "Job not found", jobId });
      }
      return textResponse({ success: true, job });
    }
  );

  server.tool(
    "job_result",
    "Collect a VALIDATION job's normalized provider output — distinct from llm_job_result, which returns raw provider request job output.",
    {
      jobId: z.string().min(1).describe("Validation job ID."),
      provider: providerSchema
        .optional()
        .describe("Provider that produced the job, used for normalized validation output."),
      maxChars: z
        .number()
        .int()
        .min(1000)
        .max(2000000)
        .default(200000)
        .describe("Maximum result size."),
    },
    {
      title: "Validation job result",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ jobId, provider, maxChars }) => {
      // F3b owner check (cross-LLM validation receipts §5a): own-or-not-found.
      // A job owned by another principal is reported as absent, mirroring the
      // llm_job_result path; previously this surface had no ownership check.
      const result = deps.asyncJobManager.getJobResult(jobId, maxChars);
      const caller = resolveOwnerPrincipal(getRequestContext());
      if (!result || !principalCanAccess(deps.asyncJobManager.getJobOwner(jobId), caller)) {
        return textResponse({ success: false, error: "Job not found", jobId });
      }
      // Cross-LLM validation receipts (Phase 1): eager mint. If this job is the
      // one that just made its validation run terminal, mint the receipt now,
      // while the linked job outputs still exist (they are evicted after the
      // retention window). Best-effort; never affects the job_result response.
      eagerMintFromJobId(deps, jobId);
      return textResponse({
        success: true,
        result,
        normalized:
          provider !== undefined
            ? collectValidationJobResult(deps, provider, jobId, null, maxChars)
            : null,
      });
    }
  );

  // Cross-LLM validation receipts (Phase 1): the validation_receipt tool is
  // registered only when a validation-run store is wired. Under memory/none the
  // tool is absent, so a receipt that cannot be durably retrieved is impossible
  // by construction.
  if (deps.validationRunStore) {
    server.tool(
      "validation_receipt",
      "Retrieve the canonically hashed immutable receipt of a terminal cross-LLM validation run by validationId. Returns minted | pending | expired_unminted (no receipt exists and none can be minted) | verification_failed (a stored receipt does not verify against its run) | not_found (own-or-not-found).",
      {
        validationId: z
          .string()
          .min(1)
          .describe(
            "The run-level validationId from a validation kickoff response (not a job/correlation id)."
          ),
        format: z
          .enum(["json", "markdown"])
          .default("json")
          .describe(
            "Response format. markdown returns the human-readable rendering (derived on read, never stored or hashed)."
          ),
        includeRawResponses: z
          .boolean()
          .default(false)
          .describe(
            "Inline complete provider answer text when the owned linked job still exposes identity-verified output (read-time only; never persisted or hashed)."
          ),
      },
      {
        title: "Validation receipt",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      async ({ validationId, format, includeRawResponses }) => {
        const result = resolveValidationReceipt(deps, validationId, {
          caller: currentCaller(),
          includeRawResponses,
        });
        // Phase 2: markdown is a read-time rendering of the stored
        // structuredContent (renderHumanReport), never stored, never hashed.
        if (format === "markdown" && result.status === "minted") {
          return {
            content: [{ type: "text" as const, text: result.receipt.humanReadable }],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        }
        return textResponse(result);
      }
    );
  }
}
