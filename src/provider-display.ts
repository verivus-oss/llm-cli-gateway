// Copyright 2026 Verivus
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

/**
 * Shared provider display-text swap (RequestPipeline design draft v5, section
 * 5.4). Display reconstruction ONLY: no optimizeResponse, no compression, no
 * integrity append. This is one of the two shared helpers the design splits the
 * old fused normalizer into; compression stays the separate, already-shared
 * `compressDisplayText` (src/compressor). Keeping display and compression as two
 * helpers preserves the intentional inline order display -> optimize -> compress
 * -> integrity (index.ts buildCliResponse), which a fused helper would reorder.
 *
 * Both response surfaces call this: the inline `buildCliResponse` path passes
 * `applyGrokDisplay: true`; the `llm_job_result` readback path passes `false`.
 * The grok swap is behind that explicit flag so the readback path keeps its
 * current behavior (it never applied `grokDisplayText`); a separate change flips
 * the flag to true once the grok-readback asymmetry is intentionally fixed.
 */
import { codexDisplayText } from "./codex-json-parser.js";
import { grokDisplayText } from "./grok-json-parser.js";

export interface ProviderDisplayInput {
  /** Provider that produced `stdout` (e.g. "codex", "grok", "claude"). */
  readonly cli: string;
  /** Caller-facing output format; "json" is returned verbatim (raw object). */
  readonly outputFormat: string | undefined;
  /** Raw captured provider stdout. */
  readonly stdout: string;
  /**
   * Whether to apply the grok streaming-json display swap. inline: true;
   * llm_job_result readback: false (locks the current readback asymmetry).
   */
  readonly applyGrokDisplay: boolean;
}

/**
 * Reconstruct the human-facing reply text for a provider, or return `stdout`
 * unchanged when no swap applies. At most one provider branch fires because
 * `cli` is a single value.
 */
export function applyProviderDisplayText(input: ProviderDisplayInput): string {
  const { cli, outputFormat, stdout, applyGrokDisplay } = input;
  // codex always runs with --json; in non-json output the caller wants the
  // reconstructed final agent_message, not the raw JSONL event stream.
  if (cli === "codex" && outputFormat !== "json") {
    return codexDisplayText(stdout);
  }
  // grok --output-format streaming-json emits raw NDJSON deltas; grokDisplayText
  // concatenates the text deltas into the final reply (no-op outside
  // streaming-json). Behind the flag so readback can keep omitting it.
  if (cli === "grok" && applyGrokDisplay) {
    return grokDisplayText(outputFormat, stdout);
  }
  return stdout;
}
