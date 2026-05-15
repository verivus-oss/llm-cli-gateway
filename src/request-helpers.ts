/**
 * Pure, side-effect-free helpers for request argument planning.
 * Zero I/O, zero dependencies on index-scoped collaborators.
 */

/** Prefix for gateway-generated session IDs. Enforces provenance structurally. */
export const GATEWAY_SESSION_PREFIX = "gw-";

export interface SessionResumeResult {
  resumeArgs: string[];
  effectiveSessionId: string | undefined;
  userProvidedSession: boolean;
}

/**
 * Validate that a user-provided sessionId doesn't use the reserved gateway prefix.
 * Throws if the ID starts with "gw-" — this namespace is reserved for gateway-generated IDs.
 */
export function validateSessionId(sessionId: string): void {
  if (sessionId.startsWith(GATEWAY_SESSION_PREFIX)) {
    throw new Error(
      `Session ID "${sessionId}" uses reserved prefix "${GATEWAY_SESSION_PREFIX}". Gateway-generated session IDs cannot be used for --resume.`
    );
  }
}

/**
 * Pure function: determine --resume args and session provenance from request flags.
 * Does NOT perform any session I/O — callers handle create/update separately.
 */
export function resolveSessionResumeArgs(opts: {
  sessionId?: string;
  resumeLatest?: boolean;
  createNewSession?: boolean;
}): SessionResumeResult {
  if (opts.createNewSession) {
    return { resumeArgs: [], effectiveSessionId: undefined, userProvidedSession: false };
  }
  if (opts.resumeLatest && !opts.sessionId) {
    return { resumeArgs: ["--resume", "latest"], effectiveSessionId: undefined, userProvidedSession: false };
  }
  if (opts.sessionId) {
    validateSessionId(opts.sessionId);
    return { resumeArgs: ["--resume", opts.sessionId], effectiveSessionId: opts.sessionId, userProvidedSession: true };
  }
  return { resumeArgs: [], effectiveSessionId: undefined, userProvidedSession: false };
}

/**
 * Grok-specific resume args. Grok accepts `--resume <id>` to resume a named session,
 * and `--continue` to resume the most recent session for the current working directory.
 * Unlike `resolveSessionResumeArgs`, "resume latest" maps to `--continue` (not `--resume latest`)
 * because Grok would interpret a literal "latest" as a session ID.
 */
export function resolveGrokSessionArgs(opts: {
  sessionId?: string;
  resumeLatest?: boolean;
  createNewSession?: boolean;
}): SessionResumeResult {
  if (opts.createNewSession) {
    return { resumeArgs: [], effectiveSessionId: undefined, userProvidedSession: false };
  }
  if (opts.resumeLatest && !opts.sessionId) {
    return { resumeArgs: ["--continue"], effectiveSessionId: undefined, userProvidedSession: false };
  }
  if (opts.sessionId) {
    validateSessionId(opts.sessionId);
    return { resumeArgs: ["--resume", opts.sessionId], effectiveSessionId: opts.sessionId, userProvidedSession: true };
  }
  return { resumeArgs: [], effectiveSessionId: undefined, userProvidedSession: false };
}
