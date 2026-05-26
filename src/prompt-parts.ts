import { createHash } from "crypto";
import { z } from "zod";

export interface PromptParts {
  system?: string;
  tools?: string;
  context?: string;
  task: string;
}

export const PromptPartsSchema = z.object({
  system: z.string().optional(),
  tools: z.string().optional(),
  context: z.string().optional(),
  task: z.string().min(1),
});

const SEPARATOR = "\n\n";

export interface AssembleResult {
  text: string;
  stableByteEnd: number;
}

export function assemble(parts: PromptParts): AssembleResult {
  const stableSegments: string[] = [];
  if (parts.system && parts.system.length > 0) stableSegments.push(parts.system);
  if (parts.tools && parts.tools.length > 0) stableSegments.push(parts.tools);
  if (parts.context && parts.context.length > 0) stableSegments.push(parts.context);

  const stableText = stableSegments.join(SEPARATOR);
  const stableByteEnd = Buffer.byteLength(stableText, "utf8");

  const text = stableText.length > 0 ? `${stableText}${SEPARATOR}${parts.task}` : parts.task;

  return { text, stableByteEnd };
}

export interface ResolvedPromptInput {
  assembledPrompt: string;
  stablePrefixHash: string | null;
  stablePrefixTokens: number | null;
}

export interface ResolvePromptInputArgs {
  prompt?: string;
  promptParts?: PromptParts;
}

export function resolvePromptInput(input: ResolvePromptInputArgs): ResolvedPromptInput {
  if (input.promptParts !== undefined) {
    const assembled = assemble(input.promptParts);
    const stableBytes = Buffer.from(assembled.text, "utf8").subarray(0, assembled.stableByteEnd);
    const hash =
      assembled.stableByteEnd > 0
        ? createHash("sha256").update(stableBytes).digest("hex")
        : createHash("sha256").update("").digest("hex");
    const tokens = Math.ceil(assembled.stableByteEnd / 4);
    return {
      assembledPrompt: assembled.text,
      stablePrefixHash: hash,
      stablePrefixTokens: tokens,
    };
  }

  return {
    assembledPrompt: input.prompt ?? "",
    stablePrefixHash: null,
    stablePrefixTokens: null,
  };
}
