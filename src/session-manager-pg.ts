import type { Pool } from "pg";
import { randomUUID } from "crypto";
import { Session, CliType } from "./session-manager.js";

export type { Logger } from "./logger.js";

const DEFAULT_SESSION_DESCRIPTIONS: Record<CliType, string> = {
  claude: "Claude Session",
  codex: "Codex Session",
  gemini: "Gemini Session",
  grok: "Grok Session",
  mistral: "Mistral Session",
};

/**
 * PostgreSQL-backed session manager. PostgreSQL is the source of truth and
 * the only required service for this backend.
 */
export class PostgreSQLSessionManager {
  constructor(private pool: Pool) {}

  /**
   * Create a new session.
   */
  async createSession(cli: CliType, description?: string, sessionId?: string): Promise<Session> {
    const id = sessionId || randomUUID();
    const sessionDescription = description ?? DEFAULT_SESSION_DESCRIPTIONS[cli];
    const now = new Date().toISOString();

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO sessions (id, cli, description, created_at, last_used_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, cli, sessionDescription, now, now]
      );

      await client.query(
        `INSERT INTO active_sessions (cli, session_id, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (cli) DO NOTHING`,
        [cli, id, now]
      );

      await client.query("COMMIT");

      return {
        id,
        cli,
        createdAt: now,
        lastUsedAt: now,
        description: sessionDescription,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get session by ID.
   */
  async getSession(sessionId: string): Promise<Session | null> {
    const result = await this.pool.query<Session>(
      `SELECT id, cli, description, metadata, created_at AS "createdAt", last_used_at AS "lastUsedAt"
       FROM sessions
       WHERE id = $1`,
      [sessionId]
    );

    return result.rows[0] ?? null;
  }

  /**
   * List all sessions, optionally filtered by CLI.
   */
  async listSessions(cli?: CliType): Promise<Session[]> {
    const query = cli
      ? `SELECT id, cli, description, metadata, created_at AS "createdAt", last_used_at AS "lastUsedAt"
         FROM sessions
         WHERE cli = $1
         ORDER BY last_used_at DESC`
      : `SELECT id, cli, description, metadata, created_at AS "createdAt", last_used_at AS "lastUsedAt"
         FROM sessions
         ORDER BY last_used_at DESC`;

    const result = cli
      ? await this.pool.query<Session>(query, [cli])
      : await this.pool.query<Session>(query);

    return result.rows;
  }

  /**
   * Delete a session.
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return false;
    }

    const result = await this.pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
    return result.rowCount !== 0;
  }

  /**
   * Set active session for a CLI. The row-level update is serialized by
   * PostgreSQL and the session FK keeps stale IDs from being recorded.
   */
  async setActiveSession(cli: CliType, sessionId: string | null): Promise<boolean> {
    if (sessionId !== null) {
      const session = await this.getSession(sessionId);
      if (!session || session.cli !== cli) {
        return false;
      }
    }

    const now = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO active_sessions (cli, session_id, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (cli) DO UPDATE SET session_id = $2, updated_at = $3`,
      [cli, sessionId, now]
    );

    return true;
  }

  /**
   * Get active session for a CLI.
   */
  async getActiveSession(cli: CliType): Promise<Session | null> {
    const result = await this.pool.query<{ session_id: string | null }>(
      "SELECT session_id FROM active_sessions WHERE cli = $1",
      [cli]
    );

    const sessionId = result.rows[0]?.session_id;
    if (!sessionId) {
      return null;
    }

    return await this.getSession(sessionId);
  }

  /**
   * Update session usage timestamp.
   */
  async updateSessionUsage(sessionId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.pool.query("UPDATE sessions SET last_used_at = $1 WHERE id = $2", [now, sessionId]);
  }

  /**
   * Update session metadata using PostgreSQL's atomic JSONB merge.
   */
  async updateSessionMetadata(sessionId: string, metadata: Record<string, any>): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE sessions
       SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
       WHERE id = $2
       RETURNING id`,
      [JSON.stringify(metadata), sessionId]
    );

    return result.rowCount !== 0;
  }

  /**
   * Clear all sessions, optionally filtered by CLI.
   */
  async clearAllSessions(cli?: CliType): Promise<number> {
    const query = cli ? "DELETE FROM sessions WHERE cli = $1" : "DELETE FROM sessions";
    const result = cli ? await this.pool.query(query, [cli]) : await this.pool.query(query);

    return result.rowCount || 0;
  }
}
