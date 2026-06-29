import { z } from "zod/v3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AsyncJobManager } from "./async-job-manager.js";
import { CLI_TYPES } from "./session-manager.js";
import { getAvailableCliInfo } from "./model-registry.js";
import { apiProviderCatalogEntry } from "./api-request.js";
import { getRequestContext, principalCanAccess, resolveOwnerPrincipal } from "./request-context.js";
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
}

/**
 * Slice 3: build the validation provider enum from the live enabled set — the
 * five CLIs plus every enabled API provider name. Pre-Slice-3 callers (no
 * apiProviders) get exactly the original five-CLI enum.
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
    },
    {
      title: "Multi-model validation",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({ question, models, focus, judgeModel }) =>
      textResponse({
        success: true,
        tool: "validate_with_models",
        readMostly: true,
        report: startValidationRun(deps, {
          intent: "validate",
          question,
          providers: models,
          focus,
          judgeProvider: judgeModel,
        }),
      })
  );

  server.tool(
    "second_opinion",
    "Ask one provider CLI to review an answer (starts a validation job; poll job_status, collect job_result).",
    {
      answer: z.string().min(1).describe("Answer to review."),
      question: z.string().optional().describe("Original question, if available."),
      model: providerSchema.default("codex").describe("Provider to ask for the second opinion."),
    },
    {
      title: "Second opinion",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({ answer, question, model }) =>
      textResponse({
        success: true,
        tool: "second_opinion",
        readMostly: true,
        report: startValidationRun(deps, {
          intent: "second_opinion",
          question,
          content: answer,
          providers: [model],
        }),
      })
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
    },
    {
      title: "Red-team review",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({ content, riskLevel, models }) =>
      textResponse({
        success: true,
        tool: "red_team_review",
        readMostly: true,
        report: startValidationRun(deps, {
          intent: "red_team",
          content,
          providers: models,
          riskLevel,
        }),
      })
  );

  server.tool(
    "consensus_check",
    "Ask provider CLIs whether they agree or disagree with a claim (starts validation jobs).",
    {
      claim: z.string().min(1).describe("Claim to check across providers."),
      models: providerListSchema.describe("Providers to ask for agreement or disagreement."),
    },
    {
      title: "Consensus check",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({ claim, models }) =>
      textResponse({
        success: true,
        tool: "consensus_check",
        readMostly: true,
        report: startValidationRun(deps, {
          intent: "consensus",
          content: claim,
          providers: models,
        }),
      })
  );

  server.tool(
    "ask_model",
    "Ask one provider CLI a question through the simplified validation surface (starts a validation job).",
    {
      question: z.string().min(1).describe("Question for one provider."),
      model: providerSchema.default("claude").describe("Provider to ask."),
    },
    {
      title: "Ask one model",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({ question, model }) =>
      textResponse({
        success: true,
        tool: "ask_model",
        readMostly: true,
        report: startValidationRun(deps, {
          intent: "ask_model",
          question,
          providers: [model],
        }),
      })
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
  // registered ONLY under the durable gate (a validation run store is wired,
  // which index.ts passes only for sqlite + an attached store). Under
  // memory/postgres/none the tool is absent, so a receipt that cannot be durably
  // retrieved is impossible by construction.
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
