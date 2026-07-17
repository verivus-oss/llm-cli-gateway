/**
 * Phase 7: single, DRY dispatcher that extracts the provider-minted session id
 * and terminal stop reason from captured CLI stdout, plus a typed
 * capability fact naming the fields the transport genuinely does not emit.
 *
 * Both the synchronous handlers (`src/index.ts`) and the async job manager
 * (`src/async-job-manager.ts`) call this so the flight recorder's
 * `provider_session_id` / `stop_reason` columns are written identically on
 * every path. Kept in its own module (importing only the leaf parsers) so
 * neither `index.ts` nor `async-job-manager.ts` has to import the other.
 *
 * No fabrication: a field is only populated when the provider actually supplies
 * it on the given transport; otherwise it is named in `absentFields` (a typed
 * capability fact) rather than silently dropped.
 */
import { parseStreamJson } from "./stream-json-parser.js";
import { parseCodexJsonStream } from "./codex-json-parser.js";
import { parseGeminiJson, parseGeminiStreamJson } from "./gemini-json-parser.js";
import { parseGrokOutput } from "./grok-json-parser.js";
import { isKitNativeSessionId } from "./personal-config-types.js";

/** A field the transport genuinely does not emit (typed capability fact). */
export type ProviderMetadataAbsentField = "sessionId" | "stopReason" | "usage";

export interface ProviderOutputMetadata {
  /** Provider-minted session id parsed from stdout, when the transport emits one. */
  sessionId?: string;
  /** Provider terminal stop reason parsed from stdout, when the transport emits one. */
  stopReason?: string;
  /**
   * Fields upstream does not emit on this provider/transport. Present so a
   * missing value is a recorded capability fact, never a silent drop.
   */
  absentFields: readonly ProviderMetadataAbsentField[];
}

/**
 * Replace a known provider-native continuation handle in caller-visible text.
 * The gateway keeps the original value in its local durable store, but a
 * remote caller must never receive a handle that could resume a host-owned
 * provider session. Callers must perform this on complete values before they
 * truncate, page, or serialize them.
 */
export function redactKnownProviderSessionId(
  value: string,
  providerSessionId: string | null | undefined
): string {
  if (!providerSessionId || !value.includes(providerSessionId)) return value;
  return value.split(providerSessionId).join("[redacted-session-id]");
}

/**
 * The provider-derived fact a live Kit terminal callback may use. Provider
 * stdout/stderr can echo the compiled instruction context, and neither this
 * record nor a provider-native continuation handle may cross a durable-store
 * boundary.
 */
export interface PersonalKitTerminalMetadata {
  version: 1;
  nativeSessionId: string | null;
}

function isPersonalKitTerminalMetadata(value: unknown): value is PersonalKitTerminalMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const metadata = value as Record<string, unknown>;
  return (
    metadata.version === 1 &&
    (typeof metadata.nativeSessionId === "string" || metadata.nativeSessionId === null) &&
    (metadata.nativeSessionId === null || isKitNativeSessionId(metadata.nativeSessionId))
  );
}

/**
 * Extract and validate the continuation metadata for the current process. A
 * schema drift or unexpected provider value fails closed to null rather than
 * treating arbitrary stdout as a native handle.
 */
export function createPersonalKitTerminalMetadata(
  cli: string,
  stdout: string,
  outputFormat: string | undefined
): PersonalKitTerminalMetadata {
  const metadata = extractProviderOutputMetadata(cli, stdout, outputFormat);
  return {
    version: 1,
    nativeSessionId:
      metadata.sessionId && isKitNativeSessionId(metadata.sessionId) ? metadata.sessionId : null,
  };
}

/**
 * Parse a legacy terminal metadata record only for compatibility tests and
 * defensive migration handling. Runtime persistence retires this value.
 */
export function parsePersonalKitTerminalMetadata(
  value: unknown
): PersonalKitTerminalMetadata | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isPersonalKitTerminalMetadata(parsed)) return null;
    // Canonicalize rather than returning the parsed object. A durable metadata
    // record has exactly two fields even if a hand-edited or low-level caller
    // supplied harmless-looking extra JSON keys.
    return { version: 1, nativeSessionId: parsed.nativeSessionId };
  } catch {
    return null;
  }
}

/**
 * Extract `{ sessionId, stopReason, absentFields }` from captured process
 * stdout. `cli` is the gateway provider bucket; `outputFormat` is the
 * caller-facing output format (some providers only emit structured metadata in
 * their json/stream modes). Purely functional and lenient: any parse miss
 * leaves the value undefined and names it in `absentFields`.
 */
export function extractProviderOutputMetadata(
  cli: string,
  stdout: string,
  outputFormat: string | undefined
): ProviderOutputMetadata {
  switch (cli) {
    case "claude": {
      // Claude always runs stream-json/json; the terminal result event carries
      // session_id and stop_reason.
      const parsed = parseStreamJson(stdout);
      const out: ProviderOutputMetadata = { absentFields: [] };
      if (parsed.sessionId) out.sessionId = parsed.sessionId;
      if (parsed.stopReason) out.stopReason = parsed.stopReason;
      if (!out.sessionId) (out.absentFields as ProviderMetadataAbsentField[]).push("sessionId");
      if (!out.stopReason) (out.absentFields as ProviderMetadataAbsentField[]).push("stopReason");
      return out;
    }
    case "codex": {
      // Codex always runs `exec --json`; thread.started carries the thread id.
      // Capability fact: the `exec --json` wire carries no stop reason today.
      const parsed = parseCodexJsonStream(stdout);
      const out: ProviderOutputMetadata = { absentFields: [] };
      if (parsed.threadId) out.sessionId = parsed.threadId;
      if (parsed.stopReason) out.stopReason = parsed.stopReason;
      if (!out.sessionId) (out.absentFields as ProviderMetadataAbsentField[]).push("sessionId");
      if (!out.stopReason) (out.absentFields as ProviderMetadataAbsentField[]).push("stopReason");
      return out;
    }
    case "gemini": {
      // Session id is only in the stream-json init event; -o json emits none.
      const parsed =
        outputFormat === "stream-json"
          ? parseGeminiStreamJson(stdout)
          : outputFormat === "json"
            ? parseGeminiJson(stdout)
            : null;
      const out: ProviderOutputMetadata = { absentFields: [] };
      if (parsed?.sessionId) out.sessionId = parsed.sessionId;
      if (parsed?.stopReason) out.stopReason = parsed.stopReason;
      if (!out.sessionId) (out.absentFields as ProviderMetadataAbsentField[]).push("sessionId");
      if (!out.stopReason) (out.absentFields as ProviderMetadataAbsentField[]).push("stopReason");
      return out;
    }
    case "grok": {
      // Grok `-p` json/streaming-json carry stopReason + sessionId but NO usage.
      const parsed = parseGrokOutput(outputFormat, stdout);
      const out: ProviderOutputMetadata = { absentFields: ["usage"] };
      if (parsed?.sessionId) out.sessionId = parsed.sessionId;
      if (parsed?.stopReason) out.stopReason = parsed.stopReason;
      if (!out.sessionId) (out.absentFields as ProviderMetadataAbsentField[]).push("sessionId");
      if (!out.stopReason) (out.absentFields as ProviderMetadataAbsentField[]).push("stopReason");
      return out;
    }
    case "mistral":
      // Capability fact: Mistral Vibe `-p` emits neither a session id nor a
      // stop reason on stdout. (Its session id lives on disk in
      // ~/.vibe/logs/session/<id>/meta.json, resolved separately from the
      // gateway sessionId, not from this stdout.)
      return { absentFields: ["sessionId", "stopReason"] };
    default:
      return { absentFields: ["sessionId", "stopReason"] };
  }
}
