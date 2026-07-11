import { z } from "zod/v3";
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
import type { ValidationProvider } from "./validation-normalizer.js";
import {
  currentCaller,
  eagerMintFromJobId,
  eagerMintFromValidationId,
  resolveValidationReceipt,
} from "./validation-receipt.js";
import {
  collectValidationJobResult,
  startJudgeSynthesis,
  startValidationRun,
  type ValidationOrchestratorDeps,
} from "./validation-orchestrator.js";

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
    "Run an explicit judge model over already-collected validation results to produce a synthesis.",
    {
      question: z.string().min(1).describe("Original request that was validated."),
      providerResults: z
        .array(normalizedProviderResultSchema)
        .min(1)
        .describe("Terminal normalized provider results from job_result."),
      judgeModel: providerSchema.default("codex").describe("Provider to run the judge synthesis."),
      validationId: z
        .string()
        .optional()
        .describe(
          "Optional run id (from the kickoff response) to link this judge job back into the durable validation run."
        ),
    },
    {
      title: "Synthesize validation",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({ question, providerResults, judgeModel, validationId }) => {
      const synthesis = startJudgeSynthesis(deps, {
        question,
        providerResults,
        judgeProvider: judgeModel,
        validationId,
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
      "Retrieve the immutable receipt of a terminal cross-LLM validation run by validationId. Returns minted | pending | expired_unminted | not_found (own-or-not-found).",
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
            "Inline full provider answer text (read-time only; pulled live per job under the same owner check; never persisted or hashed)."
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
