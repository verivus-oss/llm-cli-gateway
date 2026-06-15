import { randomUUID } from "crypto";
import { homedir } from "os";
import { join, dirname } from "path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
  chmodSync,
} from "fs";
import type { Config } from "./config.js";
import { DEFAULT_SESSION_TTL_SECONDS } from "./config.js";
import type { DatabaseConnection } from "./db.js";
import type { Logger } from "./logger.js";
import { noopLogger } from "./logger.js";
import { getRequestContext, resolveOwnerPrincipal } from "./request-context.js";

export const CLI_TYPES = ["claude", "codex", "gemini", "grok", "mistral"] as const;
export type CliType = (typeof CLI_TYPES)[number];

/**
 * Known API-backed provider ids baked into the in-tree config. `grok-api` is
 * the HTTP provider that predates Slice 0.5. Kept as a literal tuple so the
 * *registered* provider set (PROVIDER_TYPES, the session-provider zod enum, the
 * Postgres seed list) stays precise. Arbitrary names are admitted by the TYPE
 * below, not by this tuple.
 */
export const API_PROVIDER_TYPES = ["grok-api"] as const;
export type KnownApiProviderType = (typeof API_PROVIDER_TYPES)[number];

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
 * The registered provider set — the five CLIs plus the known API providers.
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

const KNOWN_SESSION_DESCRIPTIONS: Partial<Record<ProviderType, string>> = {
  claude: "Claude Session",
  codex: "Codex Session",
  gemini: "Gemini Session",
  grok: "Grok Session",
  mistral: "Mistral Session",
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
  metadata?: Record<string, any>;
  /**
   * F3: ownership principal that created the session. Stamped from the request
   * context ambient at creation; `"local"` for stdio. Absent on legacy records
   * (treated as legacy-unowned by F3b enforcement).
   */
  ownerPrincipal?: string | null;
}

export interface SessionStorage {
  sessions: Record<string, Session>;
  activeSession: Record<ProviderType, string | null>;
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

export class FileSessionManager {
  private storagePath: string;
  private storage: SessionStorage = { sessions: {}, activeSession: createEmptyActiveSessions() };
  private readonly sessionTtlMs: number;
  private readonly cleanupHook?: SessionCleanupHook;
  private readonly logger: Logger;

  constructor(
    customPath?: string,
    sessionTtlMs?: number,
    opts?: { cleanupHook?: SessionCleanupHook; logger?: Logger }
  ) {
    this.sessionTtlMs = sessionTtlMs ?? DEFAULT_SESSION_TTL_SECONDS * 1000;
    this.storagePath = customPath || join(homedir(), ".llm-cli-gateway", "sessions.json");
    this.cleanupHook = opts?.cleanupHook;
    this.logger = opts?.logger ?? noopLogger;
    this.ensureStorageDirectory();
    this.loadStorage();
  }

  private invokeCleanupHook(session: Session): void {
    if (!this.cleanupHook) return;
    try {
      const result = this.cleanupHook(session);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch(err => {
          this.logger.error(`session cleanup hook rejected for ${session.id}`, err);
        });
      }
    } catch (err) {
      this.logger.error(`session cleanup hook threw for ${session.id}`, err);
    }
  }

  private isExpired(session: Session): boolean {
    const ts = new Date(session.lastUsedAt).getTime();
    if (!Number.isFinite(ts)) return true; // malformed → expired
    return Date.now() - ts > this.sessionTtlMs;
  }

  private evictExpiredSessions(): number {
    let count = 0;
    for (const [id, session] of Object.entries(this.storage.sessions)) {
      if (this.isExpired(session)) {
        this.invokeCleanupHook(session);
        delete this.storage.sessions[id];
        if (this.storage.activeSession[session.cli] === id) {
          this.storage.activeSession[session.cli] = null;
        }
        count++;
      }
    }
    if (count > 0) this.saveStorage();
    return count;
  }

  private ensureStorageDirectory(): void {
    const storageDir = dirname(this.storagePath);
    if (!existsSync(storageDir)) {
      mkdirSync(storageDir, { recursive: true });
    }
  }

  private loadStorage(): void {
    if (existsSync(this.storagePath)) {
      try {
        const data = readFileSync(this.storagePath, "utf-8");
        this.storage = JSON.parse(data);
      } catch {
        // If file is corrupted, start fresh
        this.storage = { sessions: {}, activeSession: createEmptyActiveSessions() };
      }
    } else {
      this.storage = { sessions: {}, activeSession: createEmptyActiveSessions() };
    }
  }

  private saveStorage(): void {
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

  createSession(cli: ProviderType, description?: string, sessionId?: string): Session {
    this.evictExpiredSessions();
    const id = sessionId || randomUUID();
    const sessionDescription = description ?? defaultSessionDescription(cli);
    const session: Session = {
      id,
      cli,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      description: sessionDescription,
      // F3: stamp the owner from the request context ambient at creation
      // (synchronous with the tool handler). stdio → "local".
      ownerPrincipal: resolveOwnerPrincipal(getRequestContext()),
    };

    this.storage.sessions[id] = session;

    // Set as active session if none exists for this CLI
    if (!this.storage.activeSession[cli]) {
      this.storage.activeSession[cli] = id;
    }

    this.saveStorage();
    return session;
  }

  getSession(sessionId: string): Session | null {
    const session = this.storage.sessions[sessionId];
    if (!session) return null;
    if (this.isExpired(session)) {
      this.deleteSession(sessionId);
      return null;
    }
    return session;
  }

  listSessions(cli?: ProviderType): Session[] {
    this.evictExpiredSessions();
    const sessions = Object.values(this.storage.sessions);
    if (cli) {
      return sessions.filter(s => s.cli === cli);
    }
    return sessions;
  }

  deleteSession(sessionId: string): boolean {
    if (!this.storage.sessions[sessionId]) {
      return false;
    }

    const session = this.storage.sessions[sessionId];
    this.invokeCleanupHook(session);
    delete this.storage.sessions[sessionId];

    // If this was the active session, clear it
    if (this.storage.activeSession[session.cli] === sessionId) {
      this.storage.activeSession[session.cli] = null;
    }

    this.saveStorage();
    return true;
  }

  setActiveSession(cli: ProviderType, sessionId: string | null): boolean {
    if (sessionId !== null) {
      const session = this.storage.sessions[sessionId];
      if (!session) return false;
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
    const sessionId = this.storage.activeSession[cli];
    if (!sessionId) return null;
    const session = this.storage.sessions[sessionId];
    if (!session || this.isExpired(session)) {
      this.storage.activeSession[cli] = null;
      if (session) delete this.storage.sessions[sessionId];
      this.saveStorage();
      return null;
    }
    return session;
  }

  updateSessionUsage(sessionId: string): void {
    const session = this.storage.sessions[sessionId];
    if (!session) return;
    if (this.isExpired(session)) {
      this.deleteSession(sessionId);
      return;
    }
    session.lastUsedAt = new Date().toISOString();
    this.saveStorage();
  }

  updateSessionMetadata(sessionId: string, metadata: Record<string, any>): boolean {
    const session = this.storage.sessions[sessionId];
    if (!session) return false;
    if (this.isExpired(session)) {
      this.deleteSession(sessionId);
      return false;
    }

    session.metadata = { ...session.metadata, ...metadata };
    this.saveStorage();
    return true;
  }

  clearAllSessions(cli?: ProviderType): number {
    const sessionsToDelete = cli
      ? Object.values(this.storage.sessions).filter(s => s.cli === cli)
      : Object.values(this.storage.sessions);

    sessionsToDelete.forEach(session => {
      this.invokeCleanupHook(session);
      delete this.storage.sessions[session.id];
      if (this.storage.activeSession[session.cli] === session.id) {
        this.storage.activeSession[session.cli] = null;
      }
    });

    this.saveStorage();
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
  clearAllSessions(cli?: ProviderType): number | Promise<number>;
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
