import { randomUUID } from "crypto";
import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "fs";

export type CliType = "claude" | "codex" | "gemini";

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

export class SessionManager {
  private storagePath: string;
  private storage: SessionStorage = { sessions: {}, activeSession: { claude: null, codex: null, gemini: null } };

  constructor(customPath?: string) {
    this.storagePath = customPath || join(homedir(), ".llm-cli-gateway", "sessions.json");
    this.ensureStorageDirectory();
    this.loadStorage();
  }

  private ensureStorageDirectory(): void {
    const dir = join(homedir(), ".llm-cli-gateway");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  private loadStorage(): void {
    if (existsSync(this.storagePath)) {
      try {
        const data = readFileSync(this.storagePath, "utf-8");
        this.storage = JSON.parse(data);
      } catch (error) {
        // If file is corrupted, start fresh
        this.storage = { sessions: {}, activeSession: { claude: null, codex: null, gemini: null } };
      }
    } else {
      this.storage = { sessions: {}, activeSession: { claude: null, codex: null, gemini: null } };
    }
  }

  private saveStorage(): void {
    writeFileSync(this.storagePath, JSON.stringify(this.storage, null, 2), "utf-8");
  }

  createSession(cli: CliType, description?: string, sessionId?: string): Session {
    const id = sessionId || randomUUID();
    const session: Session = {
      id,
      cli,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      description
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
    return this.storage.sessions[sessionId] || null;
  }

  listSessions(cli?: CliType): Session[] {
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
    if (sessionId !== null && !this.storage.sessions[sessionId]) {
      return false;
    }

    if (sessionId !== null && this.storage.sessions[sessionId].cli !== cli) {
      return false;
    }

    this.storage.activeSession[cli] = sessionId;
    this.saveStorage();
    return true;
  }

  getActiveSession(cli: CliType): Session | null {
    const sessionId = this.storage.activeSession[cli];
    if (!sessionId) {
      return null;
    }
    return this.storage.sessions[sessionId] || null;
  }

  updateSessionUsage(sessionId: string): void {
    if (this.storage.sessions[sessionId]) {
      this.storage.sessions[sessionId].lastUsedAt = new Date().toISOString();
      this.saveStorage();
    }
  }

  updateSessionMetadata(sessionId: string, metadata: Record<string, any>): boolean {
    if (!this.storage.sessions[sessionId]) {
      return false;
    }

    this.storage.sessions[sessionId].metadata = {
      ...this.storage.sessions[sessionId].metadata,
      ...metadata
    };
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
