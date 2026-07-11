/**
 * ACP flight-recorder redaction (plan step `define-acp-flight-recorder-redaction`).
 *
 * The existing flight recorder persists request `prompt` and response `response`
 * text (with secret redaction). For ACP that is not enough: a raw ACP prompt or
 * response can carry JSON-RPC bodies, file contents, terminal output, local
 * paths, and credential material. This module is the ONLY way the ACP runtime
 * builds flight-recorder entries, and it guarantees by construction that none of
 * that reaches the audit DB:
 *
 *   - The persisted `prompt` is a block-count SUMMARY — the raw prompt content
 *     is never recorded.
 *   - The persisted `response` is a length SUMMARY — the raw agent output (which
 *     may quote file contents or terminal output) is never recorded. The full
 *     response still reaches the caller via the sync reply / async job result;
 *     it is simply not persisted in the audit DB
 *     (`acp_json_rpc_bodies_must_be_redacted_before_flight_recorder`,
 *     `no_prompt_payloads_in_default_logs`).
 *   - Only method-class metadata — provider, model, gateway session id, tokens,
 *     duration, status, exit code, and a REDACTED error message — is recorded.
 *
 * The recorder thus stores "method names, provider, gateway session id,
 * duration, status, and error class", per the plan's flight-recorder
 * requirements, and never a raw ACP body.
 */

import { redactAcpMessage } from "./errors.js";
import { isGatewaySessionId } from "./session-map.js";
import type { ContentBlock } from "./types.js";
import type { FlightLogResult, FlightLogStart } from "../flight-recorder.js";
import { redactSecrets } from "../secret-redaction.js";
import type { CliType } from "../session-manager.js";

/**
 * Summarize an ACP prompt for the recorder. NEVER returns the raw prompt text —
 * only the number of content blocks.
 */
export function summarizeAcpPromptForFlight(prompt: ReadonlyArray<ContentBlock>): string {
  const n = prompt.length;
  return `[acp prompt: ${n} content block${n === 1 ? "" : "s"}]`;
}

/**
 * Summarize an ACP response for the recorder. NEVER returns the raw response
 * text (which may quote file contents or terminal output) — only its length.
 */
export function summarizeAcpResponseForFlight(responseText: string): string {
  return `[acp response: ${responseText.length} char${responseText.length === 1 ? "" : "s"}]`;
}

/**
 * Redact a free-form ACP string (e.g. an error message) before it reaches a log
 * sink: collapse JSON-RPC / JSON bodies, strip local paths, bearer/api tokens,
 * emails, and recognizable secrets. Used for the recorder's error-class field —
 * never as a way to persist a raw body.
 */
export function redactAcpTextForFlight(text: string): string {
  return redactSecrets(redactAcpMessage(text));
}

/** Parameters for {@link buildAcpFlightStart}. */
export interface AcpFlightStartParams {
  readonly correlationId: string;
  readonly provider: CliType;
  readonly model: string;
  readonly prompt: ReadonlyArray<ContentBlock>;
  /**
   * Gateway-owned gw-* session id. Enforced at the boundary: a non-gw-* value
   * (e.g. a provider ACP id) is dropped, never persisted as the session id.
   */
  readonly gatewaySessionId?: string;
  readonly asyncJobId?: string;
}

/** Build a flight-recorder start entry for an ACP request with a summarized prompt. */
export function buildAcpFlightStart(params: AcpFlightStartParams): FlightLogStart {
  // Enforce the gateway-id invariant at this trust boundary rather than trusting
  // the caller: only a gateway-owned gw-* id is persisted to the audit row's
  // session_id. A provider ACP id (or any other string) is dropped so it can
  // never be recorded as the gateway session id.
  const sessionId =
    params.gatewaySessionId !== undefined && isGatewaySessionId(params.gatewaySessionId)
      ? params.gatewaySessionId
      : undefined;
  return {
    correlationId: params.correlationId,
    cli: params.provider,
    model: params.model,
    prompt: summarizeAcpPromptForFlight(params.prompt),
    sessionId,
    asyncJobId: params.asyncJobId,
  };
}

/** Parameters for {@link buildAcpFlightResult}. */
export interface AcpFlightResultParams {
  /** Full agent response text (returned to the caller, summarized for the recorder). */
  readonly responseText: string;
  readonly durationMs: number;
  readonly status: "completed" | "failed";
  readonly exitCode: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /**
   * Phase 7 / acceptance #1: cache-READ tokens lifted from the ACP
   * `session/prompt` response `_meta` (grok `cachedReadTokens`). Undefined when
   * the provider's ACP transport does not report it (capability fact: the FR
   * `cache_read_tokens` column stays NULL rather than being fabricated).
   */
  readonly cacheReadTokens?: number;
  /** Raw error message; redacted before recording. */
  readonly errorMessage?: string;
  /**
   * Phase 7: the provider-minted ACP session id captured from the session
   * lifecycle (newSession/loadSession), persisted so a deferred/async ACP job
   * stays resumable. Stored for resume; remote caller-facing surfaces redact it
   * per phase-5 (not surfaced raw here).
   */
  readonly providerSessionId?: string;
  /** Phase 7: the ACP `session/prompt` response stopReason (always supplied by ACP). */
  readonly stopReason?: string;
  /**
   * LCR phase_2b: the per-request cost derived from the ACP-reported token counts
   * (reasoningTokens folded into the output-rate term by composeCost). Undefined
   * when no known rate resolved or the provider reported no usage, leaving the FR
   * `cost_usd` column NULL rather than fabricating a figure.
   */
  readonly costUsd?: number;
  /** LCR phase_2b: how `costUsd` was derived (composeCost cost_basis), for the `cost_basis` column. */
  readonly costBasis?: string;
}

/** Build a flight-recorder result for an ACP request with a summarized response. */
export function buildAcpFlightResult(params: AcpFlightResultParams): FlightLogResult {
  return {
    response: summarizeAcpResponseForFlight(params.responseText),
    durationMs: params.durationMs,
    status: params.status,
    exitCode: params.exitCode,
    retryCount: 0,
    circuitBreakerState: "closed",
    optimizationApplied: false,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    cacheReadTokens: params.cacheReadTokens,
    errorMessage:
      params.errorMessage !== undefined ? redactAcpTextForFlight(params.errorMessage) : undefined,
    providerSessionId: params.providerSessionId,
    stopReason: params.stopReason,
    costUsd: params.costUsd,
    costBasis: params.costBasis,
  };
}
