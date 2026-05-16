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

/**
 * Codex-specific resume planning.
 *
 * Codex CLI ≥ 0.30 exposes session resume as a subcommand (`codex exec resume`),
 * not a flag pair like Claude/Gemini/Grok. So we can't return a simple list of
 * args — we describe the *mode* and let the caller branch when building argv:
 *
 *   - "new"            → `codex exec [...flags] PROMPT`
 *   - "resume-by-id"   → `codex exec resume [...resume-safe flags] <SESSION_ID> PROMPT`
 *   - "resume-latest"  → `codex exec resume --last [...resume-safe flags] PROMPT`
 *
 * `codex exec resume` rejects `--full-auto`; the original session's approval
 * policy is inherited. Callers MUST filter `--full-auto` out of the flag set
 * when mode is one of the resume forms (see `prepareCodexRequest`).
 *
 * `sessionId` MUST be a real Codex session UUID (as recorded under
 * `~/.codex/sessions/`). Gateway-generated `gw-*` IDs are rejected, since
 * they are bookkeeping handles and would 404 against `codex resume`.
 */
export type CodexSessionMode = "new" | "resume-by-id" | "resume-latest";

export interface CodexSessionPlan {
  mode: CodexSessionMode;
  /** Real Codex session UUID. Present only when mode === "resume-by-id". */
  sessionId?: string;
}

export function resolveCodexSessionArgs(opts: {
  sessionId?: string;
  resumeLatest?: boolean;
  createNewSession?: boolean;
}): CodexSessionPlan {
  if (opts.createNewSession) {
    return { mode: "new" };
  }
  if (opts.sessionId) {
    validateSessionId(opts.sessionId);
    return { mode: "resume-by-id", sessionId: opts.sessionId };
  }
  if (opts.resumeLatest) {
    return { mode: "resume-latest" };
  }
  return { mode: "new" };
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
    return {
      resumeArgs: ["--continue"],
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
