import { Pool } from "pg";
import type { Redis } from "ioredis";
import { randomUUID } from "crypto";
import { Session, CliType } from "./session-manager.js";
import { CacheTtl } from "./config.js";
import type { Logger } from "./logger.js";

export type { Logger } from "./logger.js";

const DEFAULT_SESSION_DESCRIPTIONS: Record<CliType, string> = {
  claude: "Claude Session",
  codex: "Codex Session",
  gemini: "Gemini Session"
};

/**
 * PostgreSQL-backed session manager with Redis caching
 */
export class PostgreSQLSessionManager {
  constructor(
    private pool: Pool,
    private redis: Redis,
    private cacheTtl: CacheTtl,
    private logger: Logger
  ) {}

  /**
   * Acquire distributed lock using Redis SET NX EX
   * Returns [success, lockValue] tuple
   */
  private async acquireLock(key: string, ttlSeconds: number): Promise<[boolean, string]> {
    const lockKey = `lock:${key}`;
    const lockValue = randomUUID();

    // SET NX EX atomic operation
    const result = await this.redis.set(lockKey, lockValue, "EX", ttlSeconds, "NX");
    return [result === "OK", lockValue];
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Acquire a distributed lock with bounded retries to smooth contention spikes.
   */
  private async acquireLockWithRetry(
    key: string,
    ttlSeconds: number,
    errorLabel: string,
    maxWaitMs = 6000
  ): Promise<string> {
    const deadline = Date.now() + maxWaitMs;

    while (true) {
      const [lockAcquired, lockValue] = await this.acquireLock(key, ttlSeconds);
      if (lockAcquired) {
        return lockValue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Failed to acquire lock for ${errorLabel}`);
      }

      // Small jitter avoids lock-step retries from concurrent callers.
      await this.sleep(25 + Math.floor(Math.random() * 25));
    }
  }

  /**
   * Release distributed lock using Lua script for atomic compare-and-delete
   * Only releases if lockValue matches (prevents releasing another process's lock)
   */
  private async releaseLock(key: string, lockValue: string): Promise<void> {
    const lockKey = `lock:${key}`;

    // Lua script for atomic compare-and-delete
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    await this.redis.eval(script, 1, lockKey, lockValue);
  }

  /**
   * Invalidate session cache
   */
  private async invalidateCache(sessionId: string): Promise<void> {
    try {
      await this.redis.del(`session:${sessionId}`);
    } catch (error) {
      // Graceful degradation - log but don't fail
      this.logger.error(`Cache invalidation failed for session ${sessionId}`, { error, sessionId });
    }
  }

  /**
   * Invalidate session list cache using SCAN (non-blocking)
   */
  private async invalidateListCache(cli?: CliType): Promise<void> {
    try {
      if (cli) {
        await this.redis.del(`session_list:${cli}`);
      } else {
        // Use SCAN instead of KEYS to avoid blocking Redis
        const keys: string[] = [];
        let cursor = "0";

        do {
          const [nextCursor, matchedKeys] = await this.redis.scan(
            cursor,
            "MATCH",
            "session_list:*",
            "COUNT",
            100
          );
          cursor = nextCursor;
          keys.push(...matchedKeys);
        } while (cursor !== "0");

        // Delete in batches to avoid overwhelming Redis
        if (keys.length > 0) {
          await this.redis.del(...keys);
        }
      }
    } catch (error) {
      this.logger.error("List cache invalidation failed", { error });
    }
  }

  /**
   * Create a new session
   */
  async createSession(cli: CliType, description?: string, sessionId?: string): Promise<Session> {
    const id = sessionId || randomUUID();
    const sessionDescription = description ?? DEFAULT_SESSION_DESCRIPTIONS[cli];
    const now = new Date().toISOString();

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Insert session
      await client.query(
        `INSERT INTO sessions (id, cli, description, created_at, last_used_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, cli, sessionDescription, now, now]
      );

      // Set as active if none exists
      await client.query(
        `INSERT INTO active_sessions (cli, session_id, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (cli) DO NOTHING`,
        [cli, id, now]
      );

      await client.query("COMMIT");

      const session: Session = {
        id,
        cli,
        createdAt: now,
        lastUsedAt: now,
        description: sessionDescription
      };

      // Write-through to cache
      try {
        await this.redis.setex(`session:${id}`, this.cacheTtl.session, JSON.stringify(session));
      } catch (error) {
        // Graceful degradation
        this.logger.error("Cache write failed", { error });
      }

      // Invalidate list cache
      await this.invalidateListCache(cli);

      return session;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get session by ID (cache-aside pattern)
   */
  async getSession(sessionId: string): Promise<Session | null> {
    // Try cache first
    try {
      const cached = await this.redis.get(`session:${sessionId}`);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (error) {
      // Graceful degradation - fallback to DB
      this.logger.error("Cache read failed", { error });
    }

    // Cache miss - query database
    const result = await this.pool.query<Session>(
      `SELECT id, cli, description, metadata, created_at AS "createdAt", last_used_at AS "lastUsedAt"
       FROM sessions
       WHERE id = $1`,
      [sessionId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const session = result.rows[0];

    // Populate cache
    try {
      await this.redis.setex(`session:${sessionId}`, this.cacheTtl.session, JSON.stringify(session));
    } catch (error) {
      this.logger.error("Cache write failed", { error });
    }

    return session;
  }

  /**
   * List all sessions, optionally filtered by CLI
   */
  async listSessions(cli?: CliType): Promise<Session[]> {
    // Try cache for CLI-specific lists
    const cacheKey = cli ? `session_list:${cli}` : null;
    if (cacheKey) {
      try {
        const cached = await this.redis.get(cacheKey);
        if (cached) {
          return JSON.parse(cached);
        }
      } catch (error) {
        this.logger.error("Cache read failed", { error });
      }
    }

    // Query database
    const query = cli
      ? `SELECT id, cli, description, metadata, created_at AS "createdAt", last_used_at AS "lastUsedAt"
         FROM sessions
         WHERE cli = $1
         ORDER BY last_used_at DESC`
      : `SELECT id, cli, description, metadata, created_at AS "createdAt", last_used_at AS "lastUsedAt"
         FROM sessions
         ORDER BY last_used_at DESC`;

    const result = cli ? await this.pool.query<Session>(query, [cli]) : await this.pool.query<Session>(query);

    const sessions = result.rows;

    // Cache CLI-specific lists
    if (cacheKey) {
      try {
        await this.redis.setex(cacheKey, this.cacheTtl.sessionList, JSON.stringify(sessions));
      } catch (error) {
        this.logger.error("Cache write failed", { error });
      }
    }

    return sessions;
  }

  /**
   * Delete a session
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    // Get session to find CLI type
    const session = await this.getSession(sessionId);
    if (!session) {
      return false;
    }

    // Delete from database (CASCADE will handle active_sessions)
    const result = await this.pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);

    if (result.rowCount === 0) {
      return false;
    }

    // Invalidate caches (session, active session for this CLI, and list)
    await this.invalidateCache(sessionId);
    try {
      await this.redis.del(`active_session:${session.cli}`);
    } catch (error) {
      this.logger.error(`Failed to invalidate active session cache for ${session.cli}`, { error });
    }
    await this.invalidateListCache(session.cli);

    return true;
  }

  /**
   * Set active session for a CLI (with distributed locking)
   */
  async setActiveSession(cli: CliType, sessionId: string | null): Promise<boolean> {
    // Validate session exists if not null
    if (sessionId !== null) {
      const session = await this.getSession(sessionId);
      if (!session || session.cli !== cli) {
        return false;
      }
    }

    // Acquire lock with bounded retries to avoid failing benign concurrent updates.
    const lockValue = await this.acquireLockWithRetry(
      `active_session:${cli}`,
      5,
      `active session ${cli}`
    );

    try {
      // UPSERT active session
      const now = new Date().toISOString();
      await this.pool.query(
        `INSERT INTO active_sessions (cli, session_id, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (cli) DO UPDATE SET session_id = $2, updated_at = $3`,
        [cli, sessionId, now]
      );

      // Update cache
      try {
        if (sessionId) {
          await this.redis.setex(`active_session:${cli}`, this.cacheTtl.activeSession, sessionId);
        } else {
          await this.redis.del(`active_session:${cli}`);
        }
      } catch (error) {
        this.logger.error("Cache update failed", { error });
      }

      return true;
    } finally {
      // Release lock with ownership verification
      try {
        await this.releaseLock(`active_session:${cli}`, lockValue);
      } catch (error) {
        this.logger.error(`Failed to release lock for active session ${cli}`, { error, cli });
      }
    }
  }

  /**
   * Get active session for a CLI
   */
  async getActiveSession(cli: CliType): Promise<Session | null> {
    // Try cache first
    try {
      const cachedId = await this.redis.get(`active_session:${cli}`);
      if (cachedId) {
        return await this.getSession(cachedId);
      }
    } catch (error) {
      this.logger.error("Cache read failed", { error });
    }

    // Query database
    const result = await this.pool.query<{ session_id: string }>(
      "SELECT session_id FROM active_sessions WHERE cli = $1",
      [cli]
    );

    if (result.rows.length === 0 || !result.rows[0].session_id) {
      return null;
    }

    const sessionId = result.rows[0].session_id;

    // Populate cache
    try {
      await this.redis.setex(`active_session:${cli}`, this.cacheTtl.activeSession, sessionId);
    } catch (error) {
      this.logger.error("Cache write failed", { error });
    }

    return await this.getSession(sessionId);
  }

  /**
   * Update session usage timestamp
   */
  async updateSessionUsage(sessionId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.pool.query("UPDATE sessions SET last_used_at = $1 WHERE id = $2", [now, sessionId]);

    // Invalidate cache to force refresh
    await this.invalidateCache(sessionId);
  }

  /**
   * Update session metadata (atomic JSONB merge)
   */
  async updateSessionMetadata(sessionId: string, metadata: Record<string, any>): Promise<boolean> {
    // Use PostgreSQL JSONB || operator for atomic merge (prevents race conditions)
    const result = await this.pool.query(
      `UPDATE sessions
       SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
       WHERE id = $2
       RETURNING id`,
      [JSON.stringify(metadata), sessionId]
    );

    if (result.rowCount === 0) {
      return false;
    }

    // Invalidate cache
    await this.invalidateCache(sessionId);

    return true;
  }

  /**
   * Clear all sessions, optionally filtered by CLI
   * Invalidates all related caches (session, active, list)
   */
  async clearAllSessions(cli?: CliType): Promise<number> {
    // First get all sessions to invalidate their caches
    const sessions = await this.listSessions(cli);

    // Delete from database
    const query = cli ? "DELETE FROM sessions WHERE cli = $1" : "DELETE FROM sessions";
    const result = cli ? await this.pool.query(query, [cli]) : await this.pool.query(query);

    // Invalidate individual session caches (concurrent — each has its own try/catch)
    await Promise.all(sessions.map(session => this.invalidateCache(session.id)));

    // Invalidate active session caches
    if (cli) {
      try {
        await this.redis.del(`active_session:${cli}`);
      } catch (error) {
        this.logger.error(`Failed to invalidate active session cache for ${cli}`, { error, cli });
      }
    } else {
      // Invalidate all active session caches
      try {
        await Promise.all([
          this.redis.del("active_session:claude"),
          this.redis.del("active_session:codex"),
          this.redis.del("active_session:gemini")
        ]);
      } catch (error) {
        this.logger.error("Failed to invalidate active session caches", { error });
      }
    }

    // Invalidate list caches
    await this.invalidateListCache(cli);

    return result.rowCount || 0;
  }
}
