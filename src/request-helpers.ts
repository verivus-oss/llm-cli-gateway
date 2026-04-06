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
/**
 * Reject CLI arg values that start with "-" to prevent argument injection.
 * spawn() doesn't invoke a shell so there's no shell injection, but a value
 * like "--dangerously-skip-permissions" passed as a tool name would be
 * interpreted as a flag by the child CLI.
 */
export function sanitizeCliArgValues(values: string[], fieldName: string): string[] {
  for (const v of values) {
    if (v.startsWith("-")) {
      throw new Error(
        `Invalid ${fieldName} value "${v}": values must not start with "-" (argument injection prevention)`
      );
    }
  }
  return values;
}

export function resolveSessionResumeArgs(opts: {
  sessionId?: string;
  resumeLatest?: boolean;
  createNewSession?: boolean;
}): SessionResumeResult {
  if (opts.createNewSession) {
    return { resumeArgs: [], effectiveSessionId: undefined, userProvidedSession: false };
  }
  if (opts.resumeLatest && !opts.sessionId) {
    return {
      resumeArgs: ["--resume", "latest"],
      effectiveSessionId: undefined,
      userProvidedSession: false,
    };
  }
  if (opts.sessionId) {
    validateSessionId(opts.sessionId);
    return {
      resumeArgs: ["--resume", opts.sessionId],
      effectiveSessionId: opts.sessionId,
      userProvidedSession: true,
    };
  }
  return { resumeArgs: [], effectiveSessionId: undefined, userProvidedSession: false };
}
