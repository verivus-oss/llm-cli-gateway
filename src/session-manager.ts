import { randomUUID } from "crypto";
import { isDeepStrictEqual } from "node:util";
import { homedir, hostname } from "os";
import {
  join,
  dirname,
  relative as pathRelative,
  isAbsolute as pathIsAbsolute,
  basename as pathBasename,
} from "path";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
  chmodSync,
  unlinkSync,
} from "fs";
import type { Config } from "./config.js";
import { DEFAULT_SESSION_TTL_SECONDS } from "./config.js";
import type { DatabaseConnection } from "./db.js";
import type { Logger } from "./logger.js";
import { noopLogger } from "./logger.js";
import { getRequestContext, principalCanAccess, resolveOwnerPrincipal } from "./request-context.js";
import {
  API_PROVIDER_TYPES,
  CLI_TYPES,
  type CliType,
  type KnownApiProviderType,
} from "./provider-types.js";
import { getAllProviderDefinitions } from "./provider-definitions.js";
import {
  cloneKitSessionBinding,
  cloneKitSessionAttempt,
  isKitSessionBinding,
  isKitSessionAttemptActive,
  kitExecutionIdentity,
  kitScopeKey,
  sameKitExecutionRef,
  type KitExecutionRef,
  type KitSessionBinding,
  type KitSessionAttempt,
} from "./personal-config-types.js";

export { API_PROVIDER_TYPES, CLI_TYPES, type CliType, type KnownApiProviderType };

/**
 * Slice 0.5 — provider-identity widening (locked decision B: arbitrary names).
 *
 * An API provider id is any `[providers.<name>]` config key, tagged
 * `kind:"api"`. The `(string & {})` member admits arbitrary names while
 * preserving editor autocomplete for the known literals. This widening is
 * deliberately identity-layer only: `CliType`/`LlmCli` and every CLI call site
 * (spawn argv, `providerCommandName`, ACP) stay narrow, and no API provider is
 * registered yet — the open type ships dormant.
 */
export type ApiProviderType = KnownApiProviderType | (string & {});

/** A provider id: a spawnable CLI, or an (open) API-backed provider. */
export type ProviderType = CliType | ApiProviderType;

/** Provider transport family. CLIs spawn subprocesses; api providers are HTTP. */
export type ProviderKind = "cli" | "api";

/**
 * The registered provider set — the spawnable CLIs plus the known API providers.
 * Used to build the default per-provider maps and the session-provider zod
 * enum. Arbitrary API ids are valid `ProviderType`s but are not members of this
 * tuple until a provider is configured.
 */
export const PROVIDER_TYPES = [...CLI_TYPES, ...API_PROVIDER_TYPES] as const;

/** True when `provider` is one of the spawnable CLIs (narrowing guard). */
export function isCliType(provider: string): provider is CliType {
  return (CLI_TYPES as readonly string[]).includes(provider);
}

/**
 * The `kind` tag for a provider id: spawnable CLIs are `"cli"`, everything else
 * (grok-api and any arbitrary `[providers.<name>]` key) is `"api"`. This is the
 * single source of truth for the kind:"api" tagging the Slice 0.5 widening adds.
 */
export function providerKind(provider: ProviderType): ProviderKind {
  return isCliType(provider) ? "cli" : "api";
}

// Session labels for the spawnable CLIs are DERIVED from the provider
// definition registry (`sessionLabel`), not owned here: session-manager keeps
// no separate provider list. Only the API-provider labels (no registry entry
// yet) stay local.
const KNOWN_SESSION_DESCRIPTIONS: Partial<Record<ProviderType, string>> = {
  ...(Object.fromEntries(
    getAllProviderDefinitions().map(def => [def.id, def.sessionLabel])
  ) as Record<CliType, string>),
  "grok-api": "Grok API Session",
};

/**
 * Default human-readable description for a new session. Falls back to a derived
 * label for arbitrary API providers so the open `ProviderType` never yields an
 * `undefined` description.
 */
export function defaultSessionDescription(provider: ProviderType): string {
  return KNOWN_SESSION_DESCRIPTIONS[provider] ?? `${provider} Session`;
}

const createEmptyActiveSessions = (): Record<ProviderType, string | null> =>
  Object.fromEntries(PROVIDER_TYPES.map(provider => [provider, null])) as Record<
    ProviderType,
    string | null
  >;

export interface Session {
  id: string;
  cli: ProviderType;
  createdAt: string;
  lastUsedAt: string;
  description?: string;
  metadata?: Record<string, any> & { kit?: KitSessionBinding };
  /**
   * F3: ownership principal that created the session. Stamped from the request
   * context ambient at creation; `"local"` for stdio. Absent on legacy records
   * (treated as legacy-unowned by F3b enforcement).
   */
  ownerPrincipal?: string | null;
  /** Opaque durable generation fence. Never expose through MCP responses. */
  generation?: string;
}

export interface SessionGenerationIdentity {
  id: string;
  cli: ProviderType;
  ownerPrincipal: string | null;
  createdAt: string;
  generation: string;
}

export type SessionCompareAndSetMutation =
  | {
      kind: "replace_metadata";
      expectedMetadata?: Record<string, any>;
      metadata?: Record<string, any>;
    }
  | {
      kind: "delete";
      expectedMetadata?: Record<string, any>;
    };

export function sessionGenerationIdentity(session: Session): SessionGenerationIdentity {
  if (typeof session.generation !== "string" || session.generation.length === 0) {
    throw new Error("Session has no durable generation identity");
  }
  return {
    id: session.id,
    cli: session.cli,
    ownerPrincipal: session.ownerPrincipal ?? null,
    createdAt: session.createdAt,
    generation: session.generation,
  };
}

export interface SessionStorage {
  sessions: Record<string, Session>;
  activeSession: Record<ProviderType, string | null>;
  /**
   * Personal Agent Config Kit pointers are intentionally separate from legacy
   * per-provider active sessions. The outer key is a provider, the inner key
   * is the exact Kit execution plus principal, and the value is the gateway
   * session id. Optional preserves the public shape of legacy sessions files;
   * FileSessionManager normalizes it before use.
   */
  activeKitSession?: Record<string, Record<string, string>>;
}

const createEmptyActiveKitSessions = (): Record<string, Record<string, string>> => ({});

function isStorageRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyStorageString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasOwnStorageProperty(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * A persisted file session store could not be read or validated. Kit callers
 * must treat this as busy rather than allocate a competing continuation.
 */
export class FileSessionStorageFaultError extends Error {
  readonly code = "kit_busy" as const;

  constructor() {
    super(
      "Personal Agent Config Kit session storage is unreadable or invalid; repair sessions.json before retrying"
    );
    this.name = "FileSessionStorageFaultError";
  }
}

export function isFileSessionStorageFaultError(
  value: unknown
): value is FileSessionStorageFaultError {
  return value instanceof FileSessionStorageFaultError;
}

const FILE_SESSION_LOCK_WAIT_MS = 10;
const FILE_SESSION_LOCK_TIMEOUT_MS = 5_000;
const fileSessionLockWaiter = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

type NormalizedSessionStorage = SessionStorage & {
  activeKitSession: Record<string, Record<string, string>>;
};

function createEmptySessionStorage(): NormalizedSessionStorage {
  return {
    sessions: {},
    activeSession: createEmptyActiveSessions(),
    activeKitSession: createEmptyActiveKitSessions(),
  };
}

/** Return valid Kit metadata only. Legacy or malformed metadata is ignored. */
export function getKitSessionBinding(session: Session): KitSessionBinding | null {
  const binding = session.metadata?.kit;
  return isKitSessionBinding(binding) ? cloneKitSessionBinding(binding) : null;
}

/** True if a session belongs to the exact immutable Kit execution context. */
export function sessionMatchesKitExecution(session: Session, execution: KitExecutionRef): boolean {
  const binding = getKitSessionBinding(session);
  return binding !== null && sameKitExecutionRef(binding.execution, execution);
}

/**
 * Stable pointer key for one exact Kit execution and principal. A config stamp
 * is deliberately insufficient here: two executions may share it while
 * differing in release, repository head, or request-context identity.
 */
export function kitActiveSessionKey(
  scopeRoot: string | null,
  execution: KitExecutionRef,
  ownerPrincipal: string
): string {
  if (execution.scopeRoot !== scopeRoot) {
    throw new TypeError("Kit active session scope must match the execution scope");
  }
  if (ownerPrincipal.trim().length === 0) {
    throw new TypeError("Kit active session owner principal must be non-empty");
  }
  return JSON.stringify([kitExecutionIdentity(execution), ownerPrincipal]);
}

/**
 * Canonicalize one persisted Kit active-pointer key only when it exactly
 * matches a known encoding for the already validated binding and owner. This
 * permits the two historical file-store encodings without treating arbitrary
 * JSON as a trusted pointer.
 */
export function canonicalizeKitActiveSessionPointerKey(
  sourceKey: string,
  execution: KitExecutionRef,
  ownerPrincipal: string
): string | null {
  const canonicalKey = kitActiveSessionKey(execution.scopeRoot, execution, ownerPrincipal);
  if (sourceKey === canonicalKey) return canonicalKey;
  if (sourceKey === kitScopeKey(execution.scopeRoot, execution.configStamp, ownerPrincipal)) {
    return canonicalKey;
  }
  return ownerPrincipal === "local" && sourceKey === kitScopeKey(execution.scopeRoot)
    ? canonicalKey
    : null;
}

/**
 * Whether a stored session can be returned for an exact Kit get-or-create
 * request. Native continuation details are intentionally mutable and may have
 * been refreshed after creation. Legacy-unowned sessions remain accessible to
 * the local principal only, matching the repository-wide ownership policy.
 */
export function sessionMatchesKitBinding(
  session: Session,
  cli: ProviderType,
  binding: KitSessionBinding,
  ownerPrincipal: string
): boolean {
  return (
    session.cli === cli &&
    principalCanAccess(session.ownerPrincipal, ownerPrincipal) &&
    sessionMatchesKitExecution(session, binding.execution)
  );
}

/** Strip internal concurrency and worktree ownership fields from every
 * caller-facing session projection. Durable storage retains them for CAS,
 * same-host reuse validation, and cleanup authorization.
 */
export function publicSafeSession(session: Session): Session {
  const hasInternalWorktreeOwnership =
    session.metadata !== undefined &&
    ("worktreeOwnerHostname" in session.metadata ||
      "worktreeOwnerInstanceId" in session.metadata ||
      "worktreeCleanupPending" in session.metadata ||
      "worktreeCleanupPendingDeletion" in session.metadata);
  if (session.generation === undefined && !hasInternalWorktreeOwnership) return session;
  const { generation: _generation, ...publicSession } = session;
  if (!hasInternalWorktreeOwnership) return publicSession;
  const metadata: Record<string, any> = { ...publicSession.metadata };
  delete metadata.worktreeOwnerHostname;
  delete metadata.worktreeOwnerInstanceId;
  delete metadata.worktreeCleanupPending;
  delete metadata.worktreeCleanupPendingDeletion;
  return { ...publicSession, metadata };
}

/**
 * Project a session for a remote HTTP/OAuth caller: additionally strip local
 * absolute paths from metadata (`workspaceRoot`, and `worktreePath` reduced to
 * a workspace-relative label). The stored session keeps the absolute paths for
 * resume, while `workspaceAlias` remains safe to return.
 */
export function remoteSafeSession(session: Session): Session {
  const publicSession = publicSafeSession(session);
  const metadata = publicSession.metadata;
  if (!metadata) return publicSession;
  const next: Record<string, any> = { ...metadata };
  const root = typeof next.workspaceRoot === "string" ? next.workspaceRoot : undefined;
  const reducePath = (absolute: string): string => {
    const rel = root ? pathRelative(root, absolute) : "";
    return rel && !rel.startsWith("..") && !pathIsAbsolute(rel) ? rel : pathBasename(absolute);
  };
  if (typeof next.worktreePath === "string") {
    next.worktreePath = reducePath(next.worktreePath);
  }
  // Sanitize the nested ACP metadata block for the caller-facing projection: the
  // provider-owned ACP session id is removed (it stays gateway-internal), and
  // local absolute paths (`cwd`, `worktreePath`) are reduced to a
  // workspace-relative label or basename so a remote caller cannot learn the
  // operator's filesystem layout or the provider session id via `session_get` /
  // `sessions://*`. STORAGE keeps the full values (resume needs them); only this
  // shallow-copied projection is sanitized.
  if (next.acp && typeof next.acp === "object" && !Array.isArray(next.acp)) {
    const acp: Record<string, any> = { ...(next.acp as Record<string, any>) };
    if (typeof acp.cwd === "string") acp.cwd = reducePath(acp.cwd);
    if (typeof acp.worktreePath === "string") acp.worktreePath = reducePath(acp.worktreePath);
    if ("sessionId" in acp) delete acp.sessionId;
    next.acp = acp;
  }
  // Kit scope roots and release/stamp identities are gateway-internal
  // continuation guards. They are not meaningful to a remote caller and can
  // reveal local repository layout, so omit them from the remote projection.
  if ("kit" in next) delete next.kit;
  if (typeof next.workspaceRoot === "string") delete next.workspaceRoot;
  return { ...publicSession, metadata: next };
}

/**
 * Whether the ambient request is a remote HTTP/OAuth caller (as opposed to a
 * local stdio operator). Used to decide when to apply `remoteSafeSession`.
 */
export function callerIsRemote(): boolean {
  const ctx = getRequestContext();
  return ctx?.transport === "http" || ctx?.authKind === "oauth";
}

/**
 * Slice λ: callback invoked before a session record is removed (whether via
 * explicit `deleteSession`, TTL eviction, or `clearAllSessions`). Used to
 * tear down per-session resources owned by the gateway — currently git
 * worktrees registered on `session.metadata.worktreePath`. The hook
 * receives the path; promise failures are logged but do not block session
 * removal (gateway-owned-lifecycle invariant: `session_delete` must always
 * succeed for the caller).
 */
export type SessionCleanupHook = (session: Session) => void | Promise<void>;

/**
 * Optional lifecycle surface for gateway-owned state that is tied to a
 * session record but deliberately kept outside durable session metadata.
 */
export interface SessionCleanupHookRegistrar {
  addSessionCleanupHook(hook: SessionCleanupHook): () => void;
}

/** Observes committed session removal, after the durable record is gone. */
export interface SessionRemovalObserverRegistrar {
  addSessionRemovalObserver(observer: SessionCleanupHook): () => void;
}

export class FileSessionManager
  implements SessionCleanupHookRegistrar, SessionRemovalObserverRegistrar
{
  private storagePath: string;
  private storage: NormalizedSessionStorage = createEmptySessionStorage();
  /**
   * Retained until a subsequent locked reload validates the complete file.
   * Never replace a malformed on-disk store with an empty snapshot: doing so
   * could erase an active Kit lease and permit a competing provider turn.
   */
  private storageFault: FileSessionStorageFaultError | null = null;
  private storageLockDepth = 0;
  /** True while validated legacy Kit state needs an atomic on-disk rewrite. */
  private pendingKitStorageRewrite = false;
  private readonly sessionTtlMs: number;
  private readonly cleanupHooks = new Set<SessionCleanupHook>();
  private readonly removalObservers = new Set<SessionCleanupHook>();
  private readonly logger: Logger;

  constructor(
    customPath?: string,
    sessionTtlMs?: number,
    opts?: { cleanupHook?: SessionCleanupHook; logger?: Logger }
  ) {
    this.sessionTtlMs = sessionTtlMs ?? DEFAULT_SESSION_TTL_SECONDS * 1000;
    this.storagePath = customPath || join(homedir(), ".llm-cli-gateway", "sessions.json");
    if (opts?.cleanupHook) this.cleanupHooks.add(opts.cleanupHook);
    this.logger = opts?.logger ?? noopLogger;
    this.ensureStorageDirectory();
    this.loadStorage();
    if (!this.storageFault && this.pendingKitStorageRewrite) {
      this.withStorageLock(() => {
        if (!this.pendingKitStorageRewrite) return;
        this.saveStorage();
        this.pendingKitStorageRewrite = false;
      });
    }
  }

  addSessionCleanupHook(hook: SessionCleanupHook): () => void {
    this.cleanupHooks.add(hook);
    return () => this.cleanupHooks.delete(hook);
  }

  addSessionRemovalObserver(observer: SessionCleanupHook): () => void {
    this.removalObservers.add(observer);
    return () => this.removalObservers.delete(observer);
  }

  private invokeCleanupHook(session: Session): void {
    for (const hook of this.cleanupHooks) {
      try {
        const result = hook(session);
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch(err => {
            this.logger.error(`session cleanup hook rejected for ${session.id}`, err);
          });
        }
      } catch (err) {
        this.logger.error(`session cleanup hook threw for ${session.id}`, err);
      }
    }
  }

  private notifySessionRemoved(session: Session): void {
    for (const observer of this.removalObservers) {
      try {
        const result = observer(session);
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch(err => {
            this.logger.error(`session removal observer rejected for ${session.id}`, err);
          });
        }
      } catch (err) {
        this.logger.error(`session removal observer threw for ${session.id}`, err);
      }
    }
  }

  private isPendingWorktreeDeletion(session: Session): boolean {
    return session.metadata?.worktreeCleanupPendingDeletion === true;
  }

  private hasDurablyOwnedWorktree(session: Session): boolean {
    const metadata = session.metadata;
    return (
      typeof metadata?.worktreePath === "string" &&
      typeof metadata.worktreeName === "string" &&
      typeof metadata.worktreeOwnerHostname === "string" &&
      typeof metadata.worktreeOwnerInstanceId === "string"
    );
  }

  /**
   * Make a session caller-invisible before asynchronous worktree cleanup. A
   * fully proven gateway worktree remains as a hidden durable tombstone until
   * the cleanup observer acknowledges removal. Other sessions retain the
   * historical immediate-delete behavior.
   */
  private removeOrStageSession(session: Session): void {
    this.invokeCleanupHook(session);
    if (this.storage.activeSession[session.cli] === session.id) {
      this.storage.activeSession[session.cli] = null;
    }
    this.clearActiveKitPointersForSession(session.id);
    if (this.hasDurablyOwnedWorktree(session)) {
      session.metadata = {
        ...session.metadata,
        worktreeCleanupPending: true,
        worktreeCleanupPendingDeletion: true,
      };
      return;
    }
    delete this.storage.sessions[session.id];
  }

  /** Hidden durable worktree-cleanup tombstones awaiting origin-host retry. */
  listPendingWorktreeCleanupSessions(): Session[] {
    if (this.storageLockDepth === 0) {
      return this.withStorageLock(() => this.listPendingWorktreeCleanupSessions());
    }
    return Object.values(this.storage.sessions).filter(session =>
      this.isPendingWorktreeDeletion(session)
    );
  }

  /** Finalize an exact tombstone only after verified worktree removal. */
  finalizePendingWorktreeCleanup(session: Session): boolean {
    if (this.storageLockDepth === 0) {
      return this.withStorageLock(() => this.finalizePendingWorktreeCleanup(session));
    }
    this.assertStorageWritable();
    const current = this.storage.sessions[session.id];
    if (
      !current ||
      !this.isPendingWorktreeDeletion(current) ||
      current.generation !== session.generation ||
      !isDeepStrictEqual(current.metadata ?? {}, session.metadata ?? {})
    ) {
      return false;
    }
    delete this.storage.sessions[session.id];
    this.saveStorage();
    return true;
  }

  private isExpired(session: Session): boolean {
    if (this.isPendingWorktreeDeletion(session)) return false;
    const binding = getKitSessionBinding(session);
    // Personal Agent Config Kit state is pinned independently of ordinary
    // session TTL. An active scope pointer, a resumable provider handle, or a
    // persisted attempt survives until the Kit lifecycle explicitly releases
    // it, including when a durable job outlives its nominal lease expiry.
    if (binding?.attempt || binding?.resumeEligible || this.hasActiveKitPointer(session.id)) {
      return false;
    }
    const ts = new Date(session.lastUsedAt).getTime();
    if (!Number.isFinite(ts)) return true; // malformed → expired
    return Date.now() - ts > this.sessionTtlMs;
  }

  private evictExpiredSessions(): number {
    // Reads may safely use the last verified snapshot while the file is being
    // repaired, but expiry eviction is a mutation and must never overwrite it.
    if (this.storageFault) return 0;
    const removed: Session[] = [];
    for (const session of Object.values(this.storage.sessions)) {
      if (this.isExpired(session)) {
        this.removeOrStageSession(session);
        removed.push(session);
      }
    }
    if (removed.length > 0) {
      this.saveStorage();
      removed.forEach(session => this.notifySessionRemoved(session));
    }
    return removed.length;
  }

  private ensureStorageDirectory(): void {
    const storageDir = dirname(this.storagePath);
    try {
      mkdirSync(storageDir, { recursive: true });
    } catch (error) {
      this.recordStorageFault(error);
    }
  }

  private loadStorage(): void {
    let data: string;
    try {
      data = readFileSync(this.storagePath, "utf-8");
    } catch (error) {
      // `existsSync` conflates an absent path with access and I/O failures.
      // Only a confirmed absence may initialize an empty store.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.storageFault = null;
        this.storage = createEmptySessionStorage();
        return;
      }
      this.recordStorageFault(error);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(data);
      const normalised = this.normaliseStorage(parsed);
      this.storage = normalised;
      this.storageFault = null;
    } catch (error) {
      this.recordStorageFault(error);
    }
  }

  private recordStorageFault(error: unknown): void {
    if (!this.storageFault) {
      this.storageFault = new FileSessionStorageFaultError();
    }
    this.logger.error(
      `Unable to read validated file session storage ${this.storagePath}; retaining the last valid snapshot`,
      error
    );
  }

  private assertStorageWritable(): void {
    if (this.storageFault) throw this.storageFault;
  }

  /**
   * Gateway Kit orchestration calls this before generic session reads such as
   * terminal reconciliation. It keeps a corrupt file from being interpreted as
   * an absent Kit binding by a generic `getSession` call.
   */
  assertKitStorageHealthy(): void {
    if (this.storageLockDepth === 0) {
      this.withStorageLock(() => this.assertKitStorageHealthy());
      return;
    }
    if (this.storageFault) throw this.storageFault;
  }

  /**
   * Serialize file-store reads and writes across gateway processes. The file
   * backend normally has short synchronous mutations, so a sidecar O_EXCL
   * lock plus a reload while held is sufficient to prevent stale snapshots
   * from overwriting Kit pointers, attempts, or terminal CAS results.
   */
  private withStorageLock<T>(operation: () => T): T {
    if (this.storageLockDepth > 0) return operation();

    const lockPath = `${this.storagePath}.lock`;
    const deadline = Date.now() + FILE_SESSION_LOCK_TIMEOUT_MS;
    const token = randomUUID();
    let lockFd: number | null = null;
    while (lockFd === null) {
      try {
        lockFd = openSync(lockPath, "wx", 0o600);
        writeFileSync(
          lockFd,
          JSON.stringify({
            token,
            pid: process.pid,
            hostname: hostname(),
            acquiredAt: new Date().toISOString(),
          })
        );
        fsyncSync(lockFd);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          if (lockFd !== null) {
            try {
              closeSync(lockFd);
              unlinkSync(lockPath);
            } catch (cleanupError) {
              this.logger.error(
                `Unable to clean failed file session lock ${lockPath}`,
                cleanupError
              );
            }
          }
          this.recordStorageFault(error);
          throw this.storageFault;
        }
        if (this.reclaimConfirmedDeadStorageLock(lockPath)) continue;
        if (Date.now() >= deadline) {
          throw new Error(`Timed out acquiring file session lock: ${lockPath}`, { cause: error });
        }
        Atomics.wait(fileSessionLockWaiter, 0, 0, FILE_SESSION_LOCK_WAIT_MS);
      }
    }

    this.storageLockDepth++;
    try {
      this.loadStorage();
      return operation();
    } finally {
      this.storageLockDepth--;
      closeSync(lockFd);
      try {
        const current: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
        if (
          current &&
          typeof current === "object" &&
          !Array.isArray(current) &&
          (current as { token?: unknown }).token === token
        ) {
          unlinkSync(lockPath);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          this.logger.error(`Unable to release file session lock ${lockPath}`, error);
        }
      }
    }
  }

  /**
   * Recover only a same-host lock whose recorded PID is provably gone. A
   * companion recovery lock serializes reclaimers, so no second contender can
   * delete a newly-created replacement lock between validation and unlink.
   * Foreign, malformed, or live-PID locks deliberately fail closed.
   */
  private reclaimConfirmedDeadStorageLock(lockPath: string): boolean {
    const recoveryPath = `${lockPath}.recovery`;
    let recoveryFd: number;
    try {
      recoveryFd = openSync(recoveryPath, "wx", 0o600);
    } catch {
      return false;
    }
    try {
      const parseOwner = (): { token: string; pid: number; hostname: string } | null => {
        try {
          const value: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
          if (!value || typeof value !== "object" || Array.isArray(value)) return null;
          const record = value as { token?: unknown; pid?: unknown; hostname?: unknown };
          return typeof record.token === "string" &&
            typeof record.pid === "number" &&
            Number.isInteger(record.pid) &&
            typeof record.hostname === "string"
            ? { token: record.token, pid: record.pid, hostname: record.hostname }
            : null;
        } catch {
          return null;
        }
      };
      const owner = parseOwner();
      if (!owner || owner.hostname !== hostname()) return false;
      try {
        process.kill(owner.pid, 0);
        return false;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") return false;
      }
      // Re-read while holding the recovery mutex. A changed token means the
      // original owner was replaced and must never be removed by this caller.
      if (parseOwner()?.token !== owner.token) return false;
      unlinkSync(lockPath);
      return true;
    } catch {
      return false;
    } finally {
      try {
        closeSync(recoveryFd);
        unlinkSync(recoveryPath);
      } catch {
        // A stale recovery mutex is harmless and conservatively blocks reuse.
      }
    }
  }

  /**
   * Additive file-store migration. Existing `sessions.json` files have no
   * `activeKitSession`; their legacy active-session behavior remains untouched.
   */
  private normaliseStorage(value: unknown): NormalizedSessionStorage {
    this.pendingKitStorageRewrite = false;
    if (!isStorageRecord(value)) {
      throw new TypeError("sessions.json must contain an object");
    }
    if (!hasOwnStorageProperty(value, "sessions") || !isStorageRecord(value.sessions)) {
      throw new TypeError("sessions.json has missing or invalid sessions state");
    }
    if (!hasOwnStorageProperty(value, "activeSession") || !isStorageRecord(value.activeSession)) {
      throw new TypeError("sessions.json has missing or invalid activeSession state");
    }

    const rawSessions = value.sessions;
    for (const [sessionId, rawSession] of Object.entries(rawSessions)) {
      if (!isStorageRecord(rawSession)) {
        throw new TypeError(`sessions.json session ${sessionId} is invalid`);
      }
      if (
        rawSession.id !== sessionId ||
        !isNonEmptyStorageString(rawSession.id) ||
        !isNonEmptyStorageString(rawSession.cli) ||
        !isNonEmptyStorageString(rawSession.createdAt) ||
        !isNonEmptyStorageString(rawSession.lastUsedAt)
      ) {
        throw new TypeError(`sessions.json session ${sessionId} has invalid state`);
      }
      if (rawSession.description !== undefined && typeof rawSession.description !== "string") {
        throw new TypeError(`sessions.json session ${sessionId} has invalid description`);
      }
      if (
        rawSession.ownerPrincipal !== undefined &&
        rawSession.ownerPrincipal !== null &&
        !isNonEmptyStorageString(rawSession.ownerPrincipal)
      ) {
        throw new TypeError(`sessions.json session ${sessionId} has invalid owner principal`);
      }
      if (rawSession.generation === undefined) {
        rawSession.generation = randomUUID();
        this.pendingKitStorageRewrite = true;
      } else if (!isNonEmptyStorageString(rawSession.generation)) {
        throw new TypeError(`sessions.json session ${sessionId} has invalid generation`);
      }
      if (rawSession.metadata !== undefined && !isStorageRecord(rawSession.metadata)) {
        throw new TypeError(`sessions.json session ${sessionId} has invalid metadata`);
      }
      if (
        isStorageRecord(rawSession.metadata) &&
        hasOwnStorageProperty(rawSession.metadata, "kit") &&
        !isKitSessionBinding(rawSession.metadata.kit)
      ) {
        throw new TypeError(`sessions.json session ${sessionId} has malformed Kit metadata`);
      }
      if (
        isStorageRecord(rawSession.metadata) &&
        hasOwnStorageProperty(rawSession.metadata, "kit")
      ) {
        const legacyBinding = rawSession.metadata.kit as KitSessionBinding;
        const canonicalBinding = cloneKitSessionBinding(legacyBinding);
        if (
          legacyBinding.nativeSessionId !== null ||
          legacyBinding.resumeEligible !== false ||
          legacyBinding.attempt?.expectedNativeSessionId !== null
        ) {
          rawSession.metadata.kit = canonicalBinding;
          this.pendingKitStorageRewrite = true;
        }
      }
    }

    const rawActiveSession = value.activeSession;
    for (const [cli, sessionId] of Object.entries(rawActiveSession)) {
      if (
        !isNonEmptyStorageString(cli) ||
        (sessionId !== null && !isNonEmptyStorageString(sessionId))
      ) {
        throw new TypeError("sessions.json has invalid activeSession pointer state");
      }
    }

    const activeKitSession = createEmptyActiveKitSessions();
    if (hasOwnStorageProperty(value, "activeKitSession")) {
      if (!isStorageRecord(value.activeKitSession)) {
        throw new TypeError("sessions.json has invalid activeKitSession state");
      }
      for (const [cli, rawPointers] of Object.entries(value.activeKitSession)) {
        if (!isNonEmptyStorageString(cli) || !isStorageRecord(rawPointers)) {
          throw new TypeError("sessions.json has malformed Kit pointer state");
        }
        const pointers: Record<string, string> = {};
        for (const [pointerKey, sessionId] of Object.entries(rawPointers)) {
          if (!isNonEmptyStorageString(sessionId)) {
            throw new TypeError("sessions.json has malformed Kit pointer target");
          }
          const session = rawSessions[sessionId];
          const binding = session ? getKitSessionBinding(session as Session) : null;
          if (!session || !binding || (session as Session).cli !== cli) {
            throw new TypeError("sessions.json has a Kit pointer that does not match its session");
          }
          const sessionOwnerPrincipal = (session as Session).ownerPrincipal;
          const ownerPrincipal = isNonEmptyStorageString(sessionOwnerPrincipal)
            ? sessionOwnerPrincipal
            : "local";
          const canonicalPointerKey = canonicalizeKitActiveSessionPointerKey(
            pointerKey,
            binding.execution,
            ownerPrincipal
          );
          if (!canonicalPointerKey) {
            throw new TypeError("sessions.json has malformed Kit pointer key");
          }
          const existingSessionId = pointers[canonicalPointerKey];
          if (existingSessionId !== undefined && existingSessionId !== sessionId) {
            throw new TypeError("sessions.json has conflicting Kit pointer targets");
          }
          if (canonicalPointerKey !== pointerKey) this.pendingKitStorageRewrite = true;
          pointers[canonicalPointerKey] = sessionId;
        }
        activeKitSession[cli] = pointers;
      }
    }

    const activeSession = {
      ...createEmptyActiveSessions(),
      ...(rawActiveSession as Record<ProviderType, string | null>),
    } as Record<ProviderType, string | null>;
    return {
      sessions: rawSessions as Record<string, Session>,
      activeSession,
      activeKitSession,
    };
  }

  private clearActiveKitPointersForSession(sessionId: string): void {
    for (const scopes of Object.values(this.storage.activeKitSession)) {
      for (const [scope, pointedSessionId] of Object.entries(scopes)) {
        if (pointedSessionId === sessionId) delete scopes[scope];
      }
    }
  }

  private hasActiveKitPointer(sessionId: string): boolean {
    return Object.values(this.storage.activeKitSession).some(scopes =>
      Object.values(scopes).includes(sessionId)
    );
  }

  private getActiveKitSessionId(
    cli: ProviderType,
    scopeRoot: string | null,
    execution: KitExecutionRef,
    ownerPrincipal = resolveOwnerPrincipal(getRequestContext())
  ): string | null {
    const scope = kitActiveSessionKey(scopeRoot, execution, ownerPrincipal);
    return this.storage.activeKitSession[cli]?.[scope] ?? null;
  }

  private setActiveKitSessionId(
    cli: ProviderType,
    scopeRoot: string | null,
    sessionId: string | null,
    execution: KitExecutionRef,
    ownerPrincipal = resolveOwnerPrincipal(getRequestContext())
  ): void {
    const scope = kitActiveSessionKey(scopeRoot, execution, ownerPrincipal);
    if (sessionId === null) {
      if (this.storage.activeKitSession[cli]) delete this.storage.activeKitSession[cli][scope];
      return;
    }
    this.storage.activeKitSession[cli] ??= {};
    this.storage.activeKitSession[cli][scope] = sessionId;
  }

  /** Resolve a session that belongs to one exact execution and principal. */
  private getExactKitSession(
    cli: ProviderType,
    scopeRoot: string | null,
    execution: KitExecutionRef,
    sessionId: string,
    ownerPrincipal: string
  ): { session: Session; binding: KitSessionBinding } | null {
    if (execution.scopeRoot !== scopeRoot) return null;
    const session = this.storage.sessions[sessionId];
    if (!session) return null;
    if (this.isExpired(session)) {
      this.deleteSession(sessionId);
      return null;
    }
    const binding = getKitSessionBinding(session);
    if (
      !binding ||
      session.cli !== cli ||
      !principalCanAccess(session.ownerPrincipal, ownerPrincipal) ||
      !sameKitExecutionRef(binding.execution, execution)
    ) {
      return null;
    }
    return { session, binding };
  }

  private saveStorage(): void {
    this.assertStorageWritable();
    const tempPath = `${this.storagePath}.tmp.${process.pid}`;
    writeFileSync(tempPath, JSON.stringify(this.storage, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    const fd = openSync(tempPath, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tempPath, this.storagePath);
    chmodSync(this.storagePath, 0o600);
  }

  createSession(
    cli: ProviderType,
    description?: string,
    sessionId?: string,
    kitBinding?: KitSessionBinding,
    initialMetadata?: Record<string, any>
  ): Session {
    if (this.storageLockDepth === 0) {
      return this.withStorageLock(() =>
        this.createSession(cli, description, sessionId, kitBinding, initialMetadata)
      );
    }
    if (initialMetadata && Object.prototype.hasOwnProperty.call(initialMetadata, "kit")) {
      throw new Error("Ordinary session metadata cannot set Kit state");
    }
    if (kitBinding && initialMetadata) {
      throw new Error("Kit and ordinary initial session metadata are mutually exclusive");
    }
    if (kitBinding) {
      this.assertKitStorageHealthy();
    } else {
      this.assertStorageWritable();
    }
    this.evictExpiredSessions();
    const id = sessionId || randomUUID();
    if (this.storage.sessions[id]) {
      throw new Error(`Session ${id} already exists`);
    }
    const sessionDescription = description ?? defaultSessionDescription(cli);
    const clonedBinding = kitBinding ? cloneKitSessionBinding(kitBinding) : null;
    const session: Session = {
      id,
      cli,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      description: sessionDescription,
      // F3: stamp the owner from the request context ambient at creation
      // (synchronous with the tool handler). stdio → "local".
      ownerPrincipal: resolveOwnerPrincipal(getRequestContext()),
      generation: randomUUID(),
      ...(clonedBinding
        ? { metadata: { kit: clonedBinding } }
        : initialMetadata
          ? { metadata: { ...initialMetadata } }
          : {}),
    };

    this.storage.sessions[id] = session;

    if (clonedBinding) {
      // Kit sessions are active per provider AND canonical scope. They must not
      // overwrite the legacy provider-only pointer used while the Kit is off.
      if (
        !this.getActiveKitSessionId(
          cli,
          clonedBinding.execution.scopeRoot,
          clonedBinding.execution,
          session.ownerPrincipal ?? "local"
        )
      ) {
        this.setActiveKitSessionId(
          cli,
          clonedBinding.execution.scopeRoot,
          id,
          clonedBinding.execution,
          session.ownerPrincipal ?? "local"
        );
      }
    } else {
      // Preserve legacy behavior exactly for non-Kit sessions.
      if (!this.storage.activeSession[cli]) {
        this.storage.activeSession[cli] = id;
      }
    }

    this.saveStorage();
    return session;
  }

  createSessionWithMetadata(
    cli: ProviderType,
    description: string | undefined,
    sessionId: string,
    metadata: Record<string, any>
  ): Session {
    return this.createSession(cli, description, sessionId, undefined, metadata);
  }

  /**
   * Create and durably bind a Kit session before provider execution. This is
   * intentionally separate from `createSession` so disabled callers continue
   * using the original provider-only active-session behavior.
   */
  createKitSession(
    cli: ProviderType,
    binding: KitSessionBinding,
    description?: string,
    sessionId?: string
  ): Session {
    return this.createSession(cli, description, sessionId, binding);
  }

  /**
   * Return the active session for the exact Kit execution and principal, or
   * create and bind one as a single synchronous critical section. `description`
   * and `sessionId` are used only when a new session is required.
   */
  getOrCreateKitSession(
    cli: ProviderType,
    binding: KitSessionBinding,
    description?: string,
    sessionId?: string
  ): Session {
    if (this.storageLockDepth === 0) {
      return this.withStorageLock(() =>
        this.getOrCreateKitSession(cli, binding, description, sessionId)
      );
    }
    this.assertKitStorageHealthy();
    const requestedBinding = cloneKitSessionBinding(binding);
    const ownerPrincipal = resolveOwnerPrincipal(getRequestContext());
    const scopeRoot = requestedBinding.execution.scopeRoot;
    this.evictExpiredSessions();

    const activeSessionId = this.getActiveKitSessionId(
      cli,
      scopeRoot,
      requestedBinding.execution,
      ownerPrincipal
    );
    if (activeSessionId) {
      const active = this.storage.sessions[activeSessionId];
      if (
        active &&
        !this.isExpired(active) &&
        sessionMatchesKitBinding(active, cli, requestedBinding, ownerPrincipal)
      ) {
        return active;
      }
      // This pointer is scoped to the current exact execution and principal,
      // so clearing it cannot disturb another caller's active session.
      this.setActiveKitSessionId(cli, scopeRoot, null, requestedBinding.execution, ownerPrincipal);
      this.saveStorage();
    }

    if (sessionId) {
      const identified = this.storage.sessions[sessionId];
      if (identified) {
        if (!sessionMatchesKitBinding(identified, cli, requestedBinding, ownerPrincipal)) {
          throw new Error(`Kit session id ${sessionId} is already bound to a different execution`);
        }
        this.setActiveKitSessionId(
          cli,
          scopeRoot,
          identified.id,
          requestedBinding.execution,
          ownerPrincipal
        );
        this.saveStorage();
        return identified;
      }
    }

    return this.createSession(cli, description, sessionId, requestedBinding);
  }

  /**
   * Clear a Kit pointer only when this principal's exact execution slot still
   * points to `sessionId`. Used after a failed initial provider invocation so
   * a later retry can safely acquire a fresh pending session.
   */
  clearActiveKitSessionIfCurrent(
    cli: ProviderType,
    scopeRoot: string | null,
    execution: KitExecutionRef,
    sessionId: string
  ): boolean {
    if (this.storageLockDepth === 0) {
      return this.withStorageLock(() =>
        this.clearActiveKitSessionIfCurrent(cli, scopeRoot, execution, sessionId)
      );
    }
    this.assertKitStorageHealthy();
    if (execution.scopeRoot !== scopeRoot) return false;
    const ownerPrincipal = resolveOwnerPrincipal(getRequestContext());
    this.evictExpiredSessions();
    const activeSessionId = this.getActiveKitSessionId(cli, scopeRoot, execution, ownerPrincipal);
    if (activeSessionId !== sessionId) return false;
    const session = this.storage.sessions[sessionId];
    const binding = session ? getKitSessionBinding(session) : null;
    if (
      !session ||
      session.cli !== cli ||
      !principalCanAccess(session.ownerPrincipal, ownerPrincipal) ||
      !binding ||
      !sameKitExecutionRef(binding.execution, execution)
    ) {
      return false;
    }
    this.setActiveKitSessionId(cli, scopeRoot, null, execution, ownerPrincipal);
    this.saveStorage();
    return true;
  }

  /**
   * Claim an invocation lease on one exact existing Kit binding. Attempts are
   * intentionally not auto-replaced after expiry: durable jobs may outlive a
   * nominal lease and must be explicitly released by their reconciler first.
   */
  claimKitSessionAttempt(
    cli: ProviderType,
    scopeRoot: string | null,
    execution: KitExecutionRef,
    sessionId: string,
    attempt: KitSessionAttempt
  ): boolean {
    if (this.storageLockDepth === 0) {
      return this.withStorageLock(() =>
        this.claimKitSessionAttempt(cli, scopeRoot, execution, sessionId, attempt)
      );
    }
    this.assertKitStorageHealthy();
    if (execution.scopeRoot !== scopeRoot) return false;
    const nextAttempt = cloneKitSessionAttempt(attempt);
    if (!isKitSessionAttemptActive(nextAttempt)) return false;
    const ownerPrincipal = resolveOwnerPrincipal(getRequestContext());
    const exact = this.getExactKitSession(cli, scopeRoot, execution, sessionId, ownerPrincipal);
    if (!exact || exact.binding.attempt) return false;
    if (exact.binding.nativeSessionId !== nextAttempt.expectedNativeSessionId) return false;
    exact.session.metadata = {
      ...exact.session.metadata,
      kit: { ...exact.binding, attempt: nextAttempt },
    };
    this.saveStorage();
    return true;
  }

  /** Extend one exact held attempt without allowing a different holder to act. */
  renewKitSessionAttempt(
    cli: ProviderType,
    scopeRoot: string | null,
    execution: KitExecutionRef,
    sessionId: string,
    attemptId: string,
    expiresAt: string
  ): boolean {
    if (this.storageLockDepth === 0) {
      return this.withStorageLock(() =>
        this.renewKitSessionAttempt(cli, scopeRoot, execution, sessionId, attemptId, expiresAt)
      );
    }
    this.assertKitStorageHealthy();
    if (execution.scopeRoot !== scopeRoot || attemptId.trim().length === 0) return false;
    const ownerPrincipal = resolveOwnerPrincipal(getRequestContext());
    const exact = this.getExactKitSession(cli, scopeRoot, execution, sessionId, ownerPrincipal);
    const currentAttempt = exact?.binding.attempt;
    if (!exact || !currentAttempt || currentAttempt.id !== attemptId) return false;
    const renewedAttempt = cloneKitSessionAttempt({ ...currentAttempt, expiresAt });
    if (
      !isKitSessionAttemptActive(renewedAttempt) ||
      Date.parse(renewedAttempt.expiresAt) <= Date.parse(currentAttempt.expiresAt)
    ) {
      return false;
    }
    exact.session.metadata = {
      ...exact.session.metadata,
      kit: { ...exact.binding, attempt: renewedAttempt },
    };
    this.saveStorage();
    return true;
  }

  /** Release one exact held attempt, without touching another lease generation. */
  releaseKitSessionAttempt(
    cli: ProviderType,
    scopeRoot: string | null,
    execution: KitExecutionRef,
    sessionId: string,
    attemptId: string
  ): boolean {
    if (this.storageLockDepth === 0) {
      return this.withStorageLock(() =>
        this.releaseKitSessionAttempt(cli, scopeRoot, execution, sessionId, attemptId)
      );
    }
    this.assertKitStorageHealthy();
    if (execution.scopeRoot !== scopeRoot || attemptId.trim().length === 0) return false;
    const ownerPrincipal = resolveOwnerPrincipal(getRequestContext());
    const exact = this.getExactKitSession(cli, scopeRoot, execution, sessionId, ownerPrincipal);
    const currentAttempt = exact?.binding.attempt;
    if (!exact || !currentAttempt || currentAttempt.id !== attemptId) return false;
    const bindingWithoutAttempt = { ...exact.binding };
    delete bindingWithoutAttempt.attempt;
    exact.session.metadata = {
      ...exact.session.metadata,
      kit: bindingWithoutAttempt,
    };
    this.saveStorage();
    return true;
  }

  getSession(sessionId: string): Session | null {
    if (this.storageLockDepth === 0) {
      return this.withStorageLock(() => this.getSession(sessionId));
    }
    const session = this.storage.sessions[sessionId];
    if (!session) return null;
    if (this.isPendingWorktreeDeletion(session)) return null;
    if (this.isExpired(session)) {
      if (this.storageFault) return null;
      this.deleteSession(sessionId);
      return null;
    }
    return session;
  }

  listSessions(cli?: ProviderType): Session[] {
    if (this.storageLockDepth === 0) {
      return this.withStorageLock(() => this.listSessions(cli));
    }
    this.evictExpiredSessions();
    const sessions = Object.values(this.storage.sessions).filter(
      session => !this.isPendingWorktreeDeletion(session)
    );
    if (cli) {
      return sessions.filter(s => s.cli === cli);
    }
    return sessions;
  }

  deleteSession(sessionId: string): boolean {
    if (this.storageLockDepth === 0) {
      return this.withStorageLock(() => this.deleteSession(sessionId));
    }
    this.assertStorageWritable();
    if (!this.storage.sessions[sessionId]) {
      return false;
    }

    const session = this.storage.sessions[sessionId];
    if (this.isPendingWorktreeDeletion(session)) return false;
    if (getKitSessionBinding(session)?.attempt) {
      // Deleting a binding while its provider child owns the attempt would let
      // a later request allocate a competing native turn. Cancellation must
      // wait for confirmed process termination and terminal finalization.
      return false;
    }
    this.removeOrStageSession(session);

    this.saveStorage();
    this.notifySessionRemoved(session);
    return true;
  }

  setActiveSession(cli: ProviderType, sessionId: string | null): boolean {
    if (this.storageLockDepth === 0) {
      return this.withStorageLock(() => this.setActiveSession(cli, sessionId));
    }
    this.assertStorageWritable();
    if (sessionId !== null) {
      const session = this.storage.sessions[sessionId];
      if (!session || this.isPendingWorktreeDeletion(session)) return false;
      if (this.isExpired(session)) {
        this.deleteSession(sessionId);
        return false;
      }
      if (session.cli !== cli) return false;
    }

    this.storage.activeSession[cli] = sessionId;
    this.saveStorage();
    return true;
  }

  getActiveSession(cli: ProviderType): Session | null {
    if (this.storageLockDepth === 0) {
      return this.withStorageLock(() => this.getActiveSession(cli));
    }
    const sessionId = this.storage.activeSession[cli];
    if (!sessionId) return null;
    const session = this.storage.sessions[sessionId];
    const pendingDeletion = session ? this.isPendingWorktreeDeletion(session) : false;
    if (!session || pendingDeletion || this.isExpired(session)) {
      if (this.storageFault) return null;
      this.storage.activeSession[cli] = null;
      if (session && !pendingDeletion) this.removeOrStageSession(session);
      this.saveStorage();
      if (session && !pendingDeletion) this.notifySessionRemoved(session);
      return null;
    }
    return session;
  }

  /**
   * Point a provider-plus-scope slot at a matching Kit session. When an
   * expected execution is supplied, any stamp, release, or context mismatch is
   * rejected instead of silently continuing a session under a new config.
   */
  setActiveKitSession(
    cli: ProviderType,
    scopeRoot: string | null,
    sessionId: string | null,
    expectedExecution?: KitExecutionRef
  ): boolean {
    if (this.storageLockDepth === 0) {
      return this.withStorageLock(() =>
        this.setActiveKitSession(cli, scopeRoot, sessionId, expectedExecution)
      );
    }
    this.assertKitStorageHealthy();
    if (expectedExecution && expectedExecution.scopeRoot !== scopeRoot) return false;
    let execution = expectedExecution;
    let ownerPrincipal = resolveOwnerPrincipal(getRequestContext());
    if (sessionId !== null) {
      const session = this.storage.sessions[sessionId];
      if (!session) return false;
      if (this.isExpired(session)) {
        this.deleteSession(sessionId);
        return false;
      }
      const binding = getKitSessionBinding(session);
      if (!binding || session.cli !== cli || binding.execution.scopeRoot !== scopeRoot)
        return false;
      if (expectedExecution && !sameKitExecutionRef(binding.execution, expectedExecution))
        return false;
      if (!principalCanAccess(session.ownerPrincipal, ownerPrincipal)) return false;
      execution = binding.execution;
      ownerPrincipal = session.ownerPrincipal ?? ownerPrincipal;
    }
    if (!execution) return false;
    this.setActiveKitSessionId(cli, scopeRoot, sessionId, execution, ownerPrincipal);
    this.saveStorage();
    return true;
  }

  /**
   * Resolve the active session for one provider and canonical scope. A supplied
   * execution ref acts as a continuation gate: stale pointers return null.
   */
  getActiveKitSession(
    cli: ProviderType,
    scopeRoot: string | null,
    expectedExecution?: KitExecutionRef
  ): Session | null {
    if (this.storageLockDepth === 0) {
      return this.withStorageLock(() =>
        this.getActiveKitSession(cli, scopeRoot, expectedExecution)
      );
    }
    this.assertKitStorageHealthy();
    if (!expectedExecution || expectedExecution.scopeRoot !== scopeRoot) return null;
    const ownerPrincipal = resolveOwnerPrincipal(getRequestContext());
    const sessionId = this.getActiveKitSessionId(cli, scopeRoot, expectedExecution, ownerPrincipal);
    if (!sessionId) return null;
    const session = this.storage.sessions[sessionId];
    const binding = session ? getKitSessionBinding(session) : null;
    // A caller carrying a newer/different stamp must not resume this session,
    // but it also must not erase the valid pointer for the older execution.
    if (
      session &&
      binding &&
      session.cli === cli &&
      binding.execution.scopeRoot === scopeRoot &&
      expectedExecution &&
      !sameKitExecutionRef(binding.execution, expectedExecution)
    ) {
      return null;
    }
    if (
      !session ||
      this.isPendingWorktreeDeletion(session) ||
      this.isExpired(session) ||
      session.cli !== cli ||
      !binding ||
      binding.execution.scopeRoot !== scopeRoot
    ) {
      this.setActiveKitSessionId(cli, scopeRoot, null, expectedExecution, ownerPrincipal);
      const expiredSession =
        session && !this.isPendingWorktreeDeletion(session) && this.isExpired(session)
          ? session
          : null;
      if (expiredSession) {
        this.removeOrStageSession(expiredSession);
      }
      this.saveStorage();
      if (expiredSession) this.notifySessionRemoved(expiredSession);
      return null;
    }
    if (!principalCanAccess(session.ownerPrincipal, ownerPrincipal)) return null;
    return session;
  }

  updateSessionUsage(sessionId: string): void {
    if (this.storageLockDepth === 0) {
      this.withStorageLock(() => this.updateSessionUsage(sessionId));
      return;
    }
    this.assertStorageWritable();
    const session = this.storage.sessions[sessionId];
    if (!session || this.isPendingWorktreeDeletion(session)) return;
    if (this.isExpired(session)) {
      this.deleteSession(sessionId);
      return;
    }
    session.lastUsedAt = new Date().toISOString();
    this.saveStorage();
  }

  updateSessionMetadata(sessionId: string, metadata: Record<string, any>): boolean {
    if (this.storageLockDepth === 0) {
      return this.withStorageLock(() => this.updateSessionMetadata(sessionId, metadata));
    }
    this.assertStorageWritable();
    if (Object.prototype.hasOwnProperty.call(metadata, "kit")) return false;
    const session = this.storage.sessions[sessionId];
    if (!session || this.isPendingWorktreeDeletion(session)) return false;
    if (this.isExpired(session)) {
      this.deleteSession(sessionId);
      return false;
    }

    session.metadata = { ...session.metadata, ...metadata };
    this.saveStorage();
    return true;
  }

  compareAndSetSession(
    identity: SessionGenerationIdentity,
    mutation: SessionCompareAndSetMutation
  ): boolean {
    if (this.storageLockDepth === 0) {
      return this.withStorageLock(() => this.compareAndSetSession(identity, mutation));
    }
    this.assertStorageWritable();
    const session = this.storage.sessions[identity.id];
    if (
      !session ||
      this.isPendingWorktreeDeletion(session) ||
      session.cli !== identity.cli ||
      (session.ownerPrincipal ?? null) !== identity.ownerPrincipal ||
      session.createdAt !== identity.createdAt ||
      session.generation !== identity.generation ||
      !isDeepStrictEqual(session.metadata ?? {}, mutation.expectedMetadata ?? {})
    ) {
      return false;
    }

    if (mutation.kind === "replace_metadata") {
      if (
        !isDeepStrictEqual(session.metadata?.kit, mutation.metadata?.kit) ||
        (mutation.metadata?.kit !== undefined && !isKitSessionBinding(mutation.metadata.kit))
      ) {
        return false;
      }
      session.metadata = mutation.metadata ? { ...mutation.metadata } : undefined;
      this.saveStorage();
      return true;
    }

    if (getKitSessionBinding(session)?.attempt) return false;
    this.removeOrStageSession(session);
    this.saveStorage();
    this.notifySessionRemoved(session);
    return true;
  }

  /**
   * Update the durable attempt state for a Kit session without permitting a
   * change to the immutable execution reference. Native handles are held by
   * the gateway runtime, and a config change requires a new session.
   */
  updateKitSessionBinding(
    sessionId: string,
    binding: KitSessionBinding,
    expectedAttemptId?: string
  ): boolean {
    if (this.storageLockDepth === 0) {
      return this.withStorageLock(() =>
        this.updateKitSessionBinding(sessionId, binding, expectedAttemptId)
      );
    }
    this.assertKitStorageHealthy();
    const session = this.storage.sessions[sessionId];
    if (!session) return false;
    if (this.isExpired(session)) {
      this.deleteSession(sessionId);
      return false;
    }
    const existing = getKitSessionBinding(session);
    const next = cloneKitSessionBinding(binding);
    // Binding creation must use createKitSession so the scoped active pointer
    // and metadata are committed together before execution. This mutation only
    // refreshes provider-native state on an already-bound session.
    if (!existing || !sameKitExecutionRef(existing.execution, next.execution)) return false;
    if (existing.attempt && expectedAttemptId === undefined) return false;
    if (expectedAttemptId !== undefined) {
      const ownerPrincipal = resolveOwnerPrincipal(getRequestContext());
      const currentAttempt = existing.attempt;
      if (
        expectedAttemptId.trim().length === 0 ||
        !principalCanAccess(session.ownerPrincipal, ownerPrincipal) ||
        !currentAttempt ||
        currentAttempt.id !== expectedAttemptId ||
        existing.nativeSessionId !== currentAttempt.expectedNativeSessionId
      ) {
        return false;
      }
    }
    session.metadata = { ...session.metadata, kit: next };
    this.saveStorage();
    return true;
  }

  /**
   * Releases referenced by resume-eligible Kit sessions or held invocation
   * attempts must survive release garbage collection. Legacy sessions and
   * idle non-resumable Kit sessions never contribute a pin.
   */
  getPinnedKitReleaseIds(): string[] {
    if (this.storageLockDepth === 0) {
      return this.withStorageLock(() => this.getPinnedKitReleaseIds());
    }
    this.assertKitStorageHealthy();
    this.evictExpiredSessions();
    const releases = new Set<string>();
    for (const session of Object.values(this.storage.sessions)) {
      const binding = getKitSessionBinding(session);
      if (binding && (binding.resumeEligible || binding.attempt)) {
        releases.add(binding.execution.releaseId);
      }
    }
    return [...releases].sort();
  }

  /** Alias with explicit retention language for release-GC callers. */
  getReferencedKitReleaseIds(): string[] {
    return this.getPinnedKitReleaseIds();
  }

  clearAllSessions(cli?: ProviderType): number {
    if (this.storageLockDepth === 0) {
      return this.withStorageLock(() => this.clearAllSessions(cli));
    }
    this.assertStorageWritable();
    const sessionsToDelete = (
      cli
        ? Object.values(this.storage.sessions).filter(s => s.cli === cli)
        : Object.values(this.storage.sessions)
    ).filter(
      session => !this.isPendingWorktreeDeletion(session) && !getKitSessionBinding(session)?.attempt
    );

    sessionsToDelete.forEach(session => {
      this.removeOrStageSession(session);
    });

    this.saveStorage();
    sessionsToDelete.forEach(session => this.notifySessionRemoved(session));
    return sessionsToDelete.length;
  }
}

// Maintain backward compatibility
export const SessionManager = FileSessionManager;

/**
 * Session manager interface supporting both sync (file) and async (PostgreSQL) backends.
 * Methods return T | Promise<T> so both backends satisfy the contract.
 * Callers must always use `await` for uniform handling.
 */
export interface ISessionManager {
  createSession(
    cli: ProviderType,
    description?: string,
    sessionId?: string
  ): Session | Promise<Session>;
  createSessionWithMetadata(
    cli: ProviderType,
    description: string | undefined,
    sessionId: string,
    metadata: Record<string, any>
  ): Session | Promise<Session>;
  getSession(sessionId: string): Session | null | Promise<Session | null>;
  listSessions(cli?: ProviderType): Session[] | Promise<Session[]>;
  deleteSession(sessionId: string): boolean | Promise<boolean>;
  setActiveSession(cli: ProviderType, sessionId: string | null): boolean | Promise<boolean>;
  getActiveSession(cli: ProviderType): Session | null | Promise<Session | null>;
  updateSessionUsage(sessionId: string): void | Promise<void>;
  updateSessionMetadata(
    sessionId: string,
    metadata: Record<string, any>
  ): boolean | Promise<boolean>;
  compareAndSetSession(
    identity: SessionGenerationIdentity,
    mutation: SessionCompareAndSetMutation
  ): boolean | Promise<boolean>;
  listPendingWorktreeCleanupSessions(): Session[] | Promise<Session[]>;
  finalizePendingWorktreeCleanup(session: Session): boolean | Promise<boolean>;
  clearAllSessions(cli?: ProviderType): number | Promise<number>;
}

/**
 * Additive Personal Agent Config Kit session surface. It extends rather than
 * widens `ISessionManager` so existing provider and ACP test doubles retain the
 * disabled-mode contract unchanged.
 */
export interface IKitSessionManager extends ISessionManager {
  getOrCreateKitSession(
    cli: ProviderType,
    binding: KitSessionBinding,
    description?: string,
    sessionId?: string
  ): Session | Promise<Session>;
  clearActiveKitSessionIfCurrent(
    cli: ProviderType,
    scopeRoot: string | null,
    execution: KitExecutionRef,
    sessionId: string
  ): boolean | Promise<boolean>;
  claimKitSessionAttempt(
    cli: ProviderType,
    scopeRoot: string | null,
    execution: KitExecutionRef,
    sessionId: string,
    attempt: KitSessionAttempt
  ): boolean | Promise<boolean>;
  renewKitSessionAttempt(
    cli: ProviderType,
    scopeRoot: string | null,
    execution: KitExecutionRef,
    sessionId: string,
    attemptId: string,
    expiresAt: string
  ): boolean | Promise<boolean>;
  releaseKitSessionAttempt(
    cli: ProviderType,
    scopeRoot: string | null,
    execution: KitExecutionRef,
    sessionId: string,
    attemptId: string
  ): boolean | Promise<boolean>;
  createKitSession(
    cli: ProviderType,
    binding: KitSessionBinding,
    description?: string,
    sessionId?: string
  ): Session | Promise<Session>;
  setActiveKitSession(
    cli: ProviderType,
    scopeRoot: string | null,
    sessionId: string | null,
    expectedExecution?: KitExecutionRef
  ): boolean | Promise<boolean>;
  getActiveKitSession(
    cli: ProviderType,
    scopeRoot: string | null,
    expectedExecution?: KitExecutionRef
  ): Session | null | Promise<Session | null>;
  updateKitSessionBinding(
    sessionId: string,
    binding: KitSessionBinding,
    expectedAttemptId?: string
  ): boolean | Promise<boolean>;
  getPinnedKitReleaseIds(): string[] | Promise<string[]>;
  getReferencedKitReleaseIds(): string[] | Promise<string[]>;
}

/** Runtime narrowing for Kit-aware call sites without changing legacy mocks. */
export function isKitSessionManager(value: ISessionManager): value is IKitSessionManager {
  const candidate = value as Partial<IKitSessionManager>;
  return (
    typeof candidate.getOrCreateKitSession === "function" &&
    typeof candidate.clearActiveKitSessionIfCurrent === "function" &&
    typeof candidate.claimKitSessionAttempt === "function" &&
    typeof candidate.renewKitSessionAttempt === "function" &&
    typeof candidate.releaseKitSessionAttempt === "function" &&
    typeof candidate.createKitSession === "function" &&
    typeof candidate.setActiveKitSession === "function" &&
    typeof candidate.getActiveKitSession === "function" &&
    typeof candidate.updateKitSessionBinding === "function" &&
    typeof candidate.getPinnedKitReleaseIds === "function" &&
    typeof candidate.getReferencedKitReleaseIds === "function"
  );
}

/**
 * File-backed Kit callers must fail before any generic session read can treat
 * an unreadable store as an absent binding. PostgreSQL is independently
 * transactional and has no file-storage fault state.
 */
export function assertKitSessionManagerStorageHealthy(value: IKitSessionManager): void {
  if (value instanceof FileSessionManager) value.assertKitStorageHealthy();
}

/**
 * Factory function to create session manager
 * Returns PostgreSQLSessionManager if config present, otherwise FileSessionManager
 * @param config - Configuration object
 * @param db - Optional pre-existing DatabaseConnection (avoids creating duplicate connections)
 * @param logger - Logger instance for structured logging
 */
export async function createSessionManager(
  config?: Config,
  db?: DatabaseConnection,
  logger?: Logger,
  opts?: { cleanupHook?: SessionCleanupHook }
): Promise<ISessionManager> {
  if (config?.database) {
    // Import dynamically to avoid loading pg if not needed.
    const { PostgreSQLSessionManager } = await import("./session-manager-pg.js");

    // Use provided db connection or create new one
    if (!db) {
      const { createDatabaseConnection } = await import("./db.js");
      db = await createDatabaseConnection(config, logger);
    }

    return new PostgreSQLSessionManager(db.getPool());
  } else {
    // Use file-based storage with TTL from config
    const sessionTtlMs = config?.sessionTtl
      ? config.sessionTtl * 1000
      : DEFAULT_SESSION_TTL_SECONDS * 1000;
    return new FileSessionManager(undefined, sessionTtlMs, {
      cleanupHook: opts?.cleanupHook,
      logger,
    });
  }
}
