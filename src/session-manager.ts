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

export const CLI_TYPES = ["claude", "codex", "gemini", "grok"] as const;
export type CliType = (typeof CLI_TYPES)[number];

const createEmptyActiveSessions = (): Record<CliType, string | null> =>
  Object.fromEntries(CLI_TYPES.map(cli => [cli, null])) as Record<CliType, string | null>;

const DEFAULT_SESSION_DESCRIPTIONS: Record<CliType, string> = {
  claude: "Claude Session",
  codex: "Codex Session",
  gemini: "Gemini Session",
  grok: "Grok Session",
};

export interface Session {
  id: string;
  cli: CliType;
  createdAt: string;
  lastUsedAt: string;
  description?: string;
  metadata?: Record<string, any>;
}

export interface SessionStorage {
  sessions: Record<string, Session>;
  activeSession: Record<CliType, string | null>;
}

export class FileSessionManager {
  private storagePath: string;
  private storage: SessionStorage = { sessions: {}, activeSession: createEmptyActiveSessions() };
  private readonly sessionTtlMs: number;

  constructor(customPath?: string, sessionTtlMs?: number) {
    this.sessionTtlMs = sessionTtlMs ?? DEFAULT_SESSION_TTL_SECONDS * 1000;
    this.storagePath = customPath || join(homedir(), ".llm-cli-gateway", "sessions.json");
    this.ensureStorageDirectory();
    this.loadStorage();
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
      } catch (error) {
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

  createSession(cli: CliType, description?: string, sessionId?: string): Session {
    this.evictExpiredSessions();
    const id = sessionId || randomUUID();
    const sessionDescription = description ?? DEFAULT_SESSION_DESCRIPTIONS[cli];
    const session: Session = {
      id,
      cli,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      description: sessionDescription,
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

  listSessions(cli?: CliType): Session[] {
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
    delete this.storage.sessions[sessionId];

    // If this was the active session, clear it
    if (this.storage.activeSession[session.cli] === sessionId) {
      this.storage.activeSession[session.cli] = null;
    }

    this.saveStorage();
    return true;
  }

  setActiveSession(cli: CliType, sessionId: string | null): boolean {
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

  getActiveSession(cli: CliType): Session | null {
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

  clearAllSessions(cli?: CliType): number {
    const sessionsToDelete = cli
      ? Object.values(this.storage.sessions).filter(s => s.cli === cli)
      : Object.values(this.storage.sessions);

    sessionsToDelete.forEach(session => {
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
  createSession(cli: CliType, description?: string, sessionId?: string): Session | Promise<Session>;
  getSession(sessionId: string): Session | null | Promise<Session | null>;
  listSessions(cli?: CliType): Session[] | Promise<Session[]>;
  deleteSession(sessionId: string): boolean | Promise<boolean>;
  setActiveSession(cli: CliType, sessionId: string | null): boolean | Promise<boolean>;
  getActiveSession(cli: CliType): Session | null | Promise<Session | null>;
  updateSessionUsage(sessionId: string): void | Promise<void>;
  updateSessionMetadata(
    sessionId: string,
    metadata: Record<string, any>
  ): boolean | Promise<boolean>;
  clearAllSessions(cli?: CliType): number | Promise<number>;
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
  logger?: Logger
): Promise<ISessionManager> {
  if (config?.database && config?.redis) {
    // Import dynamically to avoid loading pg/ioredis if not needed
    const { PostgreSQLSessionManager } = await import("./session-manager-pg.js");

    // Use provided db connection or create new one
    if (!db) {
      const { createDatabaseConnection } = await import("./db.js");
      db = await createDatabaseConnection(config, logger);
    }

    return new PostgreSQLSessionManager(
      db.getPool(),
      db.getRedis(),
      config.cacheTtl,
      logger ?? noopLogger
    );
  } else {
    // Use file-based storage with TTL from config
    const sessionTtlMs = config?.sessionTtl
      ? config.sessionTtl * 1000
      : DEFAULT_SESSION_TTL_SECONDS * 1000;
    return new FileSessionManager(undefined, sessionTtlMs);
  }
}
