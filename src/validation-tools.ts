import { z } from "zod/v3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AsyncJobManager } from "./async-job-manager.js";
import { getAvailableCliInfo } from "./model-registry.js";
import {
  collectValidationJobResult,
  startJudgeSynthesis,
  startValidationRun,
  type ValidationOrchestratorDeps,
} from "./validation-orchestrator.js";

type ValidationProvider = "claude" | "codex" | "gemini" | "grok" | "mistral";

export interface ValidationToolDeps extends ValidationOrchestratorDeps {
  asyncJobManager: AsyncJobManager;
}

const providerSchema = z.enum(["claude", "codex", "gemini", "grok", "mistral"]);
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
  server.tool(
    "validate_with_models",
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
    {
      answer: z.string().min(1).describe("Answer to review."),
      question: z.string().optional().describe("Original question, if available."),
      model: providerSchema.default("codex").describe("Provider to ask for the second opinion."),
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
    {
      question: z.string().min(1).describe("Question the answers respond to."),
      answers: z.array(z.string().min(1)).min(2).describe("Two or more answers to compare."),
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
    {
      content: z.string().min(1).describe("Plan, answer, or document to challenge."),
      riskLevel: z
        .enum(["normal", "high"])
        .default("normal")
        .describe("How aggressively to review."),
      models: providerListSchema.describe("Providers to ask for adversarial review."),
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
    {
      claim: z.string().min(1).describe("Claim to check across providers."),
      models: providerListSchema.describe("Providers to ask for agreement or disagreement."),
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
    {
      question: z.string().min(1).describe("Question for one provider."),
      model: providerSchema.default("claude").describe("Provider to ask."),
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
    {
      question: z.string().min(1).describe("Original request that was validated."),
      providerResults: z
        .array(normalizedProviderResultSchema)
        .min(1)
        .describe("Terminal normalized provider results from job_result."),
      judgeModel: providerSchema.default("codex").describe("Provider to run the judge synthesis."),
    },
    async ({ question, providerResults, judgeModel }) =>
      textResponse({
        success: true,
        tool: "synthesize_validation",
        readMostly: true,
        synthesis: startJudgeSynthesis(deps, {
          question,
          providerResults,
          judgeProvider: judgeModel,
        }),
      })
  );

  server.tool("list_available_models", {}, async () =>
    textResponse({ success: true, models: getAvailableCliInfo() })
  );

  server.tool(
    "job_status",
    {
      jobId: z.string().min(1).describe("Validation job ID."),
    },
    async ({ jobId }) => {
      const job = deps.asyncJobManager.getJobSnapshot(jobId);
      if (!job) {
        return textResponse({ success: false, error: "Job not found", jobId });
      }
      return textResponse({ success: true, job });
    }
  );

  server.tool(
    "job_result",
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
    async ({ jobId, provider, maxChars }) => {
      const result = deps.asyncJobManager.getJobResult(jobId, maxChars);
      if (!result) {
        return textResponse({ success: false, error: "Job not found", jobId });
      }
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
}
