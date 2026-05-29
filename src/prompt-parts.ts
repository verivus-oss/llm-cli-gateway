import { createHash } from "crypto";
import { z } from "zod/v3";

export interface PromptPartsCacheControl {
  system?: boolean;
  tools?: boolean;
  context?: boolean;
}

export interface PromptParts {
  system?: string;
  tools?: string;
  context?: string;
  task: string;
  /**
   * Slice κ (Claude only): per-block opt-in to Anthropic `cache_control`
   * breakpoints. Setting `system: true` (or tools/context) marks that
   * block with `cache_control: {type:"ephemeral", ttl:"1h"}` in the
   * stream-json payload the gateway pipes to `claude --input-format
   * stream-json`. The `task` block is NEVER marked (it's the volatile
   * tail). Empty parts are silently skipped even if their flag is true.
   *
   * Constraint: callers MUST also pass `outputFormat:"stream-json"` —
   * mixing cacheControl with text/json output returns an error response.
   * `ttl` is hard-coded to `"1h"` because Claude Code injects its own
   * 1h-marked system blocks ahead of caller content and Anthropic
   * rejects a 1h block after a 5m block.
   */
  cacheControl?: PromptPartsCacheControl;
}

const CacheControlSchema = z
  .object({
    system: z.boolean().optional(),
    tools: z.boolean().optional(),
    context: z.boolean().optional(),
  })
  .strict();

export const PromptPartsSchema = z.object({
  system: z.string().optional(),
  tools: z.string().optional(),
  context: z.string().optional(),
  task: z.string().min(1),
  cacheControl: CacheControlSchema.optional(),
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

export interface ClaudeContentBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral"; ttl: "1h" };
}

export interface ClaudeStreamJsonUserMessage {
  type: "user";
  message: {
    role: "user";
    content: ClaudeContentBlock[];
  };
}

export interface AssembleClaudeCacheBlocksResult {
  payload: ClaudeStreamJsonUserMessage;
  markedBlockCount: number;
}

/**
 * Slice κ: build the Claude `--input-format stream-json` payload from
 * a `PromptParts`. Each non-empty part becomes one content block in
 * `system → tools → context → task` order; parts whose name is `true`
 * in `cacheControl` get `cache_control: {type:"ephemeral", ttl:"1h"}`.
 *
 * Empty parts are skipped (no zero-byte blocks) — a true flag on an
 * empty part is silently a no-op and not counted in `markedBlockCount`.
 * The `task` block is never marked, even if a caller accidentally
 * tries (the schema doesn't expose `task` in `cacheControl`).
 */
export function assembleClaudeCacheBlocks(parts: PromptParts): AssembleClaudeCacheBlocksResult {
  const blocks: ClaudeContentBlock[] = [];
  let markedBlockCount = 0;
  const cc = parts.cacheControl ?? {};

  const stableEntries: ReadonlyArray<["system" | "tools" | "context", string | undefined]> = [
    ["system", parts.system],
    ["tools", parts.tools],
    ["context", parts.context],
  ];
  for (const [name, value] of stableEntries) {
    if (value === undefined || value.length === 0) continue;
    const block: ClaudeContentBlock = { type: "text", text: value };
    if (cc[name]) {
      block.cache_control = { type: "ephemeral", ttl: "1h" };
      markedBlockCount += 1;
    }
    blocks.push(block);
  }

  blocks.push({ type: "text", text: parts.task });

  return {
    payload: {
      type: "user",
      message: { role: "user", content: blocks },
    },
    markedBlockCount,
  };
}
