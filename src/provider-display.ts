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
 * Both response surfaces call this. The explicit `applyGrokDisplay` input keeps
 * low-level callers able to request raw Grok events, while normal inline and
 * job-result display paths both enable the projection.
 */
import { codexDisplayText } from "./codex-json-parser.js";
import { grokDisplayText, parseGrokOutput } from "./grok-json-parser.js";
import { parseGeminiStreamJson } from "./gemini-json-parser.js";
import { parseVibeStream } from "./vibe-stream-parser.js";
import { parseCursorStreamJson } from "./cursor-stream-parser.js";
import { parseStreamJson } from "./stream-json-parser.js";
import {
  captureFormatCarriesTranscript,
  providerCaptureStreamIsComplete,
} from "./provider-capture.js";

export interface ProviderDisplayInput {
  /** Provider that produced `stdout` (e.g. "codex", "grok", "claude"). */
  readonly cli: string;
  /** Caller-facing output format; "json" is returned verbatim (raw object). */
  readonly outputFormat: string | undefined;
  /** Actual stored provider grammar. Defaults to outputFormat for legacy rows. */
  readonly captureFormat?: string | null;
  /** Raw captured provider stdout. */
  readonly stdout: string;
  /**
   * Whether to apply the grok streaming-json display swap. inline: true;
   * llm_job_result readback: false (locks the current readback asymmetry).
   */
  readonly applyGrokDisplay: boolean;
}

const PROVIDER_RESPONSE_UNAVAILABLE =
  "[provider transcript withheld: response projection unavailable]";

function carriesJsonObjectLine(stdout: string): boolean {
  return lastJsonLine(stdout, () => true) !== null;
}

function projectionFallback(cli: string, captureFormat: string | null, stdout: string): string {
  return captureFormatCarriesTranscript(cli, captureFormat) && carriesJsonObjectLine(stdout)
    ? PROVIDER_RESPONSE_UNAVAILABLE
    : stdout;
}

function inferCaptureFormat(
  cli: string,
  outputFormat: string | undefined,
  stdout: string
): string | null {
  if (["json", "stream-json", "streaming", "streaming-json"].includes(outputFormat ?? "")) {
    return outputFormat ?? null;
  }
  if (cli === "gemini" && parseGeminiStreamJson(stdout)) return "stream-json";
  if (cli === "grok") {
    const parsed = parseGrokOutput("streaming-json", stdout);
    if (
      parsed &&
      (parsed.text !== undefined ||
        parsed.sessionId !== undefined ||
        parsed.stopReason !== undefined ||
        parsed.thought !== undefined ||
        parsed.error !== undefined)
    ) {
      return "streaming-json";
    }
  }
  if (cli === "mistral" && parseVibeStream(stdout)) return "streaming";
  if (cli === "cursor" && parseCursorStreamJson(stdout)) return "stream-json";
  if (cli === "claude" && stdout.trimStart().startsWith("{")) return "stream-json";
  if (cli === "codex" && stdout.trimStart().startsWith("{")) return "json";
  return outputFormat ?? null;
}

function lastJsonLine(
  stdout: string,
  matches: (value: Record<string, unknown>) => boolean
): Record<string, unknown> | null {
  let selected: Record<string, unknown> | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const value = parsed as Record<string, unknown>;
      if (matches(value)) selected = value;
    } catch {
      // Provider banners and partial final lines are not JSON events.
    }
  }
  return selected;
}

function projectCapturedJson(cli: string, captureFormat: string | null, stdout: string): string {
  if (cli === "claude" && captureFormat === "stream-json") {
    const result = lastJsonLine(stdout, value => value.type === "result");
    return result ? JSON.stringify(result) : projectionFallback(cli, captureFormat, stdout);
  }
  if (cli === "gemini" && captureFormat === "stream-json") {
    const result = lastJsonLine(
      stdout,
      value => value.type === "result" || value.event === "result"
    );
    const body = result?.event === "result" ? result.result : result;
    return body && typeof body === "object"
      ? JSON.stringify(body)
      : projectionFallback(cli, captureFormat, stdout);
  }
  if (cli === "grok" && captureFormat === "streaming-json") {
    const parsed = parseGrokOutput("streaming-json", stdout);
    if (!parsed) return projectionFallback(cli, captureFormat, stdout);
    const projected: Record<string, unknown> = {};
    for (const key of [
      "text",
      "stopReason",
      "sessionId",
      "requestId",
      "thought",
      "error",
    ] as const) {
      if (parsed[key] !== undefined) projected[key] = parsed[key];
    }
    return JSON.stringify(projected);
  }
  if (cli === "mistral" && captureFormat === "streaming") {
    const result = lastJsonLine(
      stdout,
      value => value.type === "message" && value.role === "assistant"
    );
    return result ? JSON.stringify(result) : projectionFallback(cli, captureFormat, stdout);
  }
  if (cli === "cursor" && captureFormat === "stream-json") {
    const result = lastJsonLine(stdout, value => value.type === "result");
    return result ? JSON.stringify(result) : projectionFallback(cli, captureFormat, stdout);
  }
  return stdout;
}

/**
 * Reconstruct the human-facing reply text for a provider, or return `stdout`
 * unchanged when no swap applies. At most one provider branch fires because
 * `cli` is a single value.
 */
export function applyProviderDisplayText(input: ProviderDisplayInput): string {
  const { cli, outputFormat, stdout, applyGrokDisplay } = input;
  const captureFormat =
    input.captureFormat === undefined
      ? inferCaptureFormat(cli, outputFormat, stdout)
      : input.captureFormat;
  const callerWantsStructured = ["json", "stream-json", "streaming", "streaming-json"].includes(
    outputFormat ?? ""
  );
  if (outputFormat === "json" && captureFormat !== "json") {
    return projectCapturedJson(cli, captureFormat, stdout);
  }
  // codex always runs with --json; in non-json output the caller wants the
  // reconstructed final agent_message, not the raw JSONL event stream.
  if (cli === "codex" && outputFormat !== "json") {
    const response = codexDisplayText(stdout);
    return response === "" && stdout !== ""
      ? projectionFallback(cli, captureFormat, stdout)
      : response;
  }
  // grok --output-format streaming-json emits raw NDJSON deltas; grokDisplayText
  // concatenates the text deltas into the final reply (no-op outside
  // streaming-json). Behind the flag so readback can keep omitting it.
  if (cli === "grok" && applyGrokDisplay) {
    const response = grokDisplayText(captureFormat ?? undefined, stdout);
    return response === "" && stdout !== ""
      ? projectionFallback(cli, captureFormat, stdout)
      : response;
  }
  if (!callerWantsStructured && cli === "claude" && captureFormat === "stream-json") {
    return lastJsonLine(stdout, value => value.type === "result")
      ? parseStreamJson(stdout).text
      : projectionFallback(cli, captureFormat, stdout);
  }
  if (!callerWantsStructured && cli === "gemini" && captureFormat === "stream-json") {
    const response = parseGeminiStreamJson(stdout)?.response;
    return response === undefined ? projectionFallback(cli, captureFormat, stdout) : response;
  }
  if (!callerWantsStructured && cli === "mistral" && captureFormat === "streaming") {
    const response = parseVibeStream(stdout)?.response;
    return response === undefined ? projectionFallback(cli, captureFormat, stdout) : response;
  }
  if (!callerWantsStructured && cli === "cursor" && captureFormat === "stream-json") {
    const response = parseCursorStreamJson(stdout)?.response;
    return response === undefined ? projectionFallback(cli, captureFormat, stdout) : response;
  }
  return stdout;
}

/**
 * Reduce a provider capture to response text safe for a remote caller. Rich
 * event streams never fail open: an incomplete or unrecognized capture is
 * withheld instead of returning reasoning, tool arguments, or tool results.
 */
export function projectRemoteProviderOutput(
  cli: string,
  stdout: string,
  captureFormat?: string | null
): string {
  // Flight-recorder responses are already projected display text and do not
  // carry a capture grammar. Treat an omitted format as plain text. Inferring
  // from JSON-shaped prose or a path can misclassify an ordinary answer as a
  // provider wire and either redact or withhold it.
  const resolvedFormat = captureFormat === undefined ? null : captureFormat;
  if (
    captureFormatCarriesTranscript(cli, resolvedFormat) &&
    carriesJsonObjectLine(stdout) &&
    !providerCaptureStreamIsComplete(cli, resolvedFormat, stdout)
  ) {
    return "[provider transcript withheld: terminal response unavailable]";
  }
  const display = applyProviderDisplayText({
    cli,
    outputFormat: "text",
    captureFormat: resolvedFormat,
    stdout,
    applyGrokDisplay: true,
  });
  if (
    captureFormatCarriesTranscript(cli, resolvedFormat) &&
    carriesJsonObjectLine(stdout) &&
    display === stdout
  ) {
    return PROVIDER_RESPONSE_UNAVAILABLE;
  }
  return display;
}
