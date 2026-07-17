/**
 * Durable identity for one Personal Agent Config Kit execution.
 *
 * This record deliberately contains references and digests only. It must never
 * carry assembled instructions, secrets, provider-home paths, or generated
 * artifact paths. The config compiler owns those transient values; jobs and
 * sessions only need enough immutable identity to reject unsafe continuation,
 * select the correct active session, and pin an activated release during
 * execution.
 */
export interface KitExecutionRef {
  /** Schema marker for forward-compatible durable records. */
  version: 1;
  /** Immutable activated release identifier. */
  releaseId: string;
  /** Full effective-config stamp, including source and compiler identity. */
  configStamp: string;
  /** Canonical selected workspace root, or null for a baseline-only scope. */
  scopeRoot: string | null;
  /** Selected repository HEAD at preparation time, or null when unavailable. */
  scopeHead: string | null;
  /** Digest over the complete effective context, including request instructions. */
  contextIdentity: string;
}

/**
 * A short-lived ownership lease for one provider invocation. The expected
 * native handle prevents a holder from finalizing a session whose native state
 * changed after it acquired the attempt.
 */
export interface KitSessionAttempt {
  id: string;
  kind: "durable" | "direct";
  acquiredAt: string;
  expiresAt: string;
  /**
   * Legacy shape retained solely so older session rows can be recognized and
   * scrubbed. Durable Kit records always store null here: a provider-native
   * continuation handle is process-local state.
   */
  expectedNativeSessionId: string | null;
}

/**
 * The durable Kit binding for a gateway session. It pins the immutable config
 * identity and attempt fence only. Provider-native continuation handles remain
 * in the current gateway process and are never serialized here.
 */
export interface KitSessionBinding {
  execution: KitExecutionRef;
  /**
   * Legacy field retained for read compatibility. Durable Kit bindings always
   * store null; the live gateway keeps a validated native handle in memory.
   */
  nativeSessionId: string | null;
  /**
   * Legacy durable resume marker. It is always false because a process restart
   * intentionally retires the in-memory provider continuation handle.
   */
  resumeEligible: boolean;
  /** Optional invocation lease, removed after a holder finalizes or releases it. */
  attempt?: KitSessionAttempt;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// Claude and Codex both issue UUID native continuation IDs. Treat every other
// durable value as untrusted legacy data rather than passing it to `--resume`.
const KIT_NATIVE_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isKitNativeSessionId(value: unknown): value is string {
  return typeof value === "string" && KIT_NATIVE_SESSION_ID.test(value);
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** Runtime guard for an optional Kit invocation lease. */
export function isKitSessionAttempt(value: unknown): value is KitSessionAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const acquiredAt = isValidTimestamp(candidate.acquiredAt)
    ? Date.parse(candidate.acquiredAt)
    : NaN;
  const expiresAt = isValidTimestamp(candidate.expiresAt) ? Date.parse(candidate.expiresAt) : NaN;
  return (
    isNonEmptyString(candidate.id) &&
    (candidate.kind === "durable" || candidate.kind === "direct") &&
    Number.isFinite(acquiredAt) &&
    Number.isFinite(expiresAt) &&
    expiresAt > acquiredAt &&
    (candidate.expectedNativeSessionId === null ||
      isKitNativeSessionId(candidate.expectedNativeSessionId))
  );
}

/** Return a detached, validated lease suitable for durable storage. */
export function cloneKitSessionAttempt(value: KitSessionAttempt): KitSessionAttempt {
  if (!isKitSessionAttempt(value)) {
    throw new TypeError("Invalid Personal Agent Config Kit session attempt");
  }
  return {
    id: value.id,
    kind: value.kind,
    acquiredAt: value.acquiredAt,
    expiresAt: value.expiresAt,
    // A session attempt is durable, whereas a provider continuation handle is
    // intentionally process-local. Canonicalizing here also retires any
    // legacy handle found in a file or PostgreSQL session row.
    expectedNativeSessionId: null,
  };
}

/** Whether the lease is still held at `now`, measured against its expiry. */
export function isKitSessionAttemptActive(attempt: KitSessionAttempt, now = Date.now()): boolean {
  return Date.parse(attempt.expiresAt) > now;
}

/** Runtime guard for JSON read from durable job/session stores. */
export function isKitExecutionRef(value: unknown): value is KitExecutionRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    isNonEmptyString(candidate.releaseId) &&
    isNonEmptyString(candidate.configStamp) &&
    (candidate.scopeRoot === null || isNonEmptyString(candidate.scopeRoot)) &&
    (candidate.scopeHead === null || isNonEmptyString(candidate.scopeHead)) &&
    isNonEmptyString(candidate.contextIdentity)
  );
}

/** Runtime guard for the typed Kit session metadata stored under `metadata.kit`. */
export function isKitSessionBinding(value: unknown): value is KitSessionBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isKitExecutionRef(candidate.execution) &&
    (candidate.nativeSessionId === null || isKitNativeSessionId(candidate.nativeSessionId)) &&
    typeof candidate.resumeEligible === "boolean" &&
    (candidate.attempt === undefined || isKitSessionAttempt(candidate.attempt))
  );
}

/** Return a detached, validated copy suitable for durable storage. */
export function cloneKitExecutionRef(value: KitExecutionRef): KitExecutionRef {
  if (!isKitExecutionRef(value)) {
    throw new TypeError("Invalid Personal Agent Config Kit execution reference");
  }
  return {
    version: 1,
    releaseId: value.releaseId,
    configStamp: value.configStamp,
    scopeRoot: value.scopeRoot,
    scopeHead: value.scopeHead,
    contextIdentity: value.contextIdentity,
  };
}

/** Return a detached, validated copy suitable for durable session metadata. */
export function cloneKitSessionBinding(value: KitSessionBinding): KitSessionBinding {
  if (!isKitSessionBinding(value)) {
    throw new TypeError("Invalid Personal Agent Config Kit session binding");
  }
  return {
    execution: cloneKitExecutionRef(value.execution),
    // Never place provider-native continuation state in the durable session
    // document. Same-process continuation is held by the gateway runtime.
    nativeSessionId: null,
    resumeEligible: false,
    ...(value.attempt ? { attempt: cloneKitSessionAttempt(value.attempt) } : {}),
  };
}

/**
 * Stable serialized identity for comparing Kit executions and indexing their
 * active-session pointers. It is not a durable request deduplication key: Kit
 * jobs always receive an opaque, freshly reserved job id.
 */
export function kitExecutionIdentity(value: KitExecutionRef): string {
  const execution = cloneKitExecutionRef(value);
  return JSON.stringify([
    execution.version,
    execution.releaseId,
    execution.configStamp,
    execution.scopeRoot,
    execution.scopeHead,
    execution.contextIdentity,
  ]);
}

/**
 * Opaque durable key for one Kit job. It is derived only from the gateway
 * reserved job id, never from compiled context, argv, stdin, or environment.
 */
export function personalKitJobRequestKey(jobId: string): string {
  return `kit:${jobId}`;
}

/** True when both records represent the same immutable Kit execution context. */
export function sameKitExecutionRef(left: KitExecutionRef, right: KitExecutionRef): boolean {
  return kitExecutionIdentity(left) === kitExecutionIdentity(right);
}

/**
 * Stable key for an active Kit session pointer. JSON avoids ambiguity when a
 * canonical root contains characters that would make delimiter-based keys
 * collide. `null` is a valid baseline-only scope.
 */
export function kitScopeKey(
  scopeRoot: string | null,
  configStamp?: string,
  ownerPrincipal?: string
): string {
  if (scopeRoot !== null && !isNonEmptyString(scopeRoot)) {
    throw new TypeError("Kit scope root must be a non-empty canonical path or null");
  }
  if (configStamp === undefined && ownerPrincipal === undefined) return JSON.stringify(scopeRoot);
  if (!isNonEmptyString(configStamp ?? "")) {
    throw new TypeError("Kit active pointer requires a non-empty config stamp");
  }
  if (!isNonEmptyString(ownerPrincipal ?? "")) {
    throw new TypeError("Kit active pointer requires a non-empty owner principal");
  }
  // A config stamp embeds machine identity plus full effective context. Pairing
  // it with the principal prevents workstations and remote callers operating
  // on the same repository root from replacing one another's active pointer.
  return JSON.stringify([scopeRoot, configStamp, ownerPrincipal]);
}
