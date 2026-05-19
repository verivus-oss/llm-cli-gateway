import type { ValidationProvider } from "./validation-normalizer.js";
import type { NormalizedValidationResult } from "./validation-normalizer.js";

export type ValidationIntent =
  | "validate"
  | "second_opinion"
  | "red_team"
  | "consensus"
  | "ask_model";

interface BasePromptInput {
  intent: ValidationIntent;
  question?: string;
  content?: string;
  focus?: string;
  riskLevel?: "normal" | "high";
}

export function buildValidationPrompt(input: BasePromptInput): string {
  const focus = input.focus || "correctness, missing assumptions, and practical next steps";
  const header = [
    "You are one independent reviewer in a personal cross-LLM validation run.",
    "Return a concise answer with these headings: Verdict, Rationale, Risks, Suggested next step.",
    "Do not claim consensus; other model responses will be compared separately.",
  ];

  if (input.intent === "second_opinion") {
    return [
      ...header,
      `Focus: ${focus}`,
      "",
      `Original question: ${input.question || "(not provided)"}`,
      "",
      "Answer to review:",
      input.content || "",
    ].join("\n");
  }

  if (input.intent === "red_team") {
    return [
      ...header,
      `Review intensity: ${input.riskLevel || "normal"}`,
      "Challenge assumptions, unsafe advice, unsupported claims, and likely failure modes.",
      "",
      input.content || "",
    ].join("\n");
  }

  if (input.intent === "consensus") {
    return [
      ...header,
      "Assess whether the claim is true, false, uncertain, or context-dependent.",
      "",
      `Claim: ${input.content || input.question || ""}`,
    ].join("\n");
  }

  if (input.intent === "ask_model") {
    return [input.question || input.content || ""].join("\n");
  }

  return [...header, `Focus: ${focus}`, "", input.question || input.content || ""].join("\n");
}

export function buildJudgePrompt(input: {
  question: string;
  providerResults: NormalizedValidationResult[];
}): string {
  return [
    "You are the explicit judge model for a personal cross-LLM validation run.",
    "Synthesize only from the provider results below. Preserve material disagreement.",
    "Return: Summary, Agreements, Disagreements, Recommendation, Confidence, Limitations.",
    "",
    `Original request: ${input.question}`,
    "",
    "Provider results:",
    JSON.stringify(input.providerResults, null, 2),
  ].join("\n");
}
