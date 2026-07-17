import type { Pool, PoolClient } from "pg";
import { randomUUID } from "crypto";
import { isDeepStrictEqual } from "node:util";
import {
  getKitSessionBinding,
  kitActiveSessionKey,
  sessionMatchesKitBinding,
  type IKitSessionManager,
  type SessionCleanupHook,
  type SessionRemovalObserverRegistrar,
  Session,
  ProviderType,
  defaultSessionDescription,
  type SessionCompareAndSetMutation,
  type SessionGenerationIdentity,
} from "./session-manager.js";
import { getRequestContext, principalCanAccess, resolveOwnerPrincipal } from "./request-context.js";
import {
  cloneKitSessionBinding,
  cloneKitSessionAttempt,
  isKitSessionAttemptActive,
  sameKitExecutionRef,
  type KitExecutionRef,
  type KitSessionBinding,
  type KitSessionAttempt,
} from "./personal-config-types.js";

export type { Logger } from "./logger.js";

/** One validated source record for an all-or-nothing file-session import. */
export interface FileSessionMigrationRecord {
  id: string;
  cli: ProviderType;
  description?: string;
  metadata: Record<string, unknown>;
  ownerPrincipal: string;
  binding: KitSessionBinding | null;
}

/** An already validated file-session migration, including explicit pointers. */
export interface FileSessionMigrationPlan {
  sessions: readonly FileSessionMigrationRecord[];
  activeSessions: readonly { cli: ProviderType; sessionId: string }[];
  activeKitSessions: readonly {
    cli: ProviderType;
    scopeRoot: string | null;
    sessionId: string;
    execution: KitExecutionRef;
    ownerPrincipal: string;
  }[];
}

/** Counts newly inserted and exact replayed records separately. */
export interface FileSessionMigrationOutcome {
  migrated: number;
  replayed: number;
}

const FILE_SESSION_MIGRATION_LOCK_NAMESPACE = "llm-cli-gateway";
const FILE_SESSION_MIGRATION_LOCK_KEY = "file-session-migration";

/**
 * Every `sessions` column the DML in this module reads or writes, mapped to the
 * migration that introduces it. Runtime roles are DML-only, so a database that
 * skipped a migration must fail with the remedy rather than a raw driver error
 * about a missing column.
 */
const REQUIRED_SESSION_COLUMNS: ReadonlyArray<{ column: string; migration: string }> = [
  { column: "id", migration: "001_initial_schema" },
  { column: "cli", migration: "001_initial_schema" },
  { column: "description", migration: "001_initial_schema" },
  { column: "metadata", migration: "001_initial_schema" },
  { column: "created_at", migration: "001_initial_schema" },
  { column: "last_used_at", migration: "001_initial_schema" },
  { column: "owner_principal", migration: "004_session_owner_principal" },
  { column: "session_generation", migration: "021_session_generation_fence" },
];

/** Preserve the operation failure when a broken connection also rejects rollback. */
async function rollbackPreservingFailure(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The original failed operation remains the actionable error.
  }
}

function storedMigrationMetadata(record: FileSessionMigrationRecord): Record<string, unknown> {
  return record.binding
    ? { ...record.metadata, kit: cloneKitSessionBinding(record.binding) }
    : { ...record.metadata };
}

function migrationRecordMatchesExisting(
  existing: Session,
  record: FileSessionMigrationRecord,
  metadata: Record<string, unknown>
): boolean {
  return (
    existing.id === record.id &&
    existing.cli === record.cli &&
    existing.description === (record.description ?? defaultSessionDescription(record.cli)) &&
    existing.ownerPrincipal === record.ownerPrincipal &&
    isDeepStrictEqual(existing.metadata ?? {}, metadata)
  );
}

/**
 * PostgreSQL-backed session manager. PostgreSQL is the source of truth and
 * the only required service for this backend.
 */
export class PostgreSQLSessionManager
  implements IKitSessionManager, SessionRemovalObserverRegistrar
{
  private kitPointerSchemaReady: Promise<void> | null = null;
  private sessionSchemaReady: Promise<void> | null = null;
  private readonly removalObservers = new Set<SessionCleanupHook>();

  constructor(private pool: Pool) {}

  addSessionRemovalObserver(observer: SessionCleanupHook): () => void {
    this.removalObservers.add(observer);
    return () => this.removalObservers.delete(observer);
  }

  private notifySessionRemoved(session: Session): void {
    for (const observer of this.removalObservers) {
      try {
        const result = observer(session);
        if (result && typeof (result as Promise<void>).catch === "function") {
          void (result as Promise<void>).catch(() => undefined);
        }
      } catch {
        // Session deletion remains best-effort when an in-memory observer fails.
      }
    }
  }

  /**
   * Verify the canonical `sessions` migrations before any session read or
   * write. Runtime roles are deliberately DML-only in production, so this is a
   * read-only preflight rather than opportunistic DDL. Without it, a database
   * that skipped a migration fails every session write with a raw driver error
   * naming the column instead of the remedy.
   */
  private ensureSessionSchema(): Promise<void> {
    if (this.sessionSchemaReady) return this.sessionSchemaReady;
    this.sessionSchemaReady = (async () => {
      // Resolve the unqualified relation once, then inspect attributes by its
      // OID. This matches the later DML resolution even when search_path has
      // more than one schema.
      const attributes = await this.pool.query<{
        table_name: string | null;
        column_name: string | null;
      }>(`
        WITH target AS (
          SELECT to_regclass('sessions') AS relation_oid
        )
        SELECT target.relation_oid::text AS table_name,
               attribute.attname AS column_name
        FROM target
        LEFT JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = target.relation_oid
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      `);
      if (!attributes.rows[0]?.table_name) {
        throw new Error(
          "Session PostgreSQL schema is missing sessions. Run `DATABASE_URL=... npm run migrate` with the migration role before using [persistence] backend = postgres."
        );
      }
      const names = new Set(
        attributes.rows.flatMap(row => (row.column_name ? [row.column_name] : []))
      );
      const missing = REQUIRED_SESSION_COLUMNS.filter(required => !names.has(required.column));
      if (missing.length > 0) {
        const detail = missing
          .map(required => `${required.column} (migration ${required.migration})`)
          .join(", ");
        throw new Error(
          `Session PostgreSQL schema is incomplete. sessions is missing: ${detail}. Run \`DATABASE_URL=... npm run migrate\` with the migration role before using [persistence] backend = postgres.`
        );
      }
    })().catch(error => {
      this.sessionSchemaReady = null;
      throw error;
    });
    return this.sessionSchemaReady;
  }

  /**
   * Verify the canonical Kit pointer migration before a Kit operation. Runtime
   * roles are deliberately DML-only in production, so this is a read-only
   * preflight rather than opportunistic DDL. Operators must run `npm run
   * migrate` with the migration role before enabling the Kit.
   */
  private ensureKitPointerSchema(): Promise<void> {
    if (this.kitPointerSchemaReady) return this.kitPointerSchemaReady;
    this.kitPointerSchemaReady = (async () => {
      // Kit DML writes the sessions table too, and the repair statement below
      // reads it, so the base session schema must be verified first.
      await this.ensureSessionSchema();
      // Resolve the unqualified relation once, then inspect attributes by its
      // OID. This matches the later DML resolution even when search_path has
      // more than one schema.
      const attributes = await this.pool.query<{
        table_name: string | null;
        column_name: string | null;
      }>(`
        WITH target AS (
          SELECT to_regclass('kit_active_sessions') AS relation_oid
        )
        SELECT target.relation_oid::text AS table_name,
               attribute.attname AS column_name
        FROM target
        LEFT JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = target.relation_oid
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      `);
      if (!attributes.rows[0]?.table_name) {
        throw new Error(
          "Personal Agent Config Kit PostgreSQL schema is missing kit_active_sessions. Run `npm run migrate` with the migration role before enabling [personal_config]."
        );
      }
      const names = new Set(
        attributes.rows.flatMap(row => (row.column_name ? [row.column_name] : []))
      );
      for (const required of ["cli", "scope_key", "session_id", "updated_at"]) {
        if (!names.has(required)) {
          throw new Error(
            "Personal Agent Config Kit PostgreSQL schema is incomplete. Run `npm run migrate` with the migration role before enabling [personal_config]."
          );
        }
      }
      // Runtime roles are DML-only, so privacy repair belongs on this startup
      // path as well as in migration 014. This makes a partially migrated
      // database fail closed before a Kit session can be resumed.
      await this.pool.query(`
        UPDATE sessions AS session
        SET metadata = jsonb_set(
          COALESCE(session.metadata, '{}'::jsonb),
          '{kit}',
          CASE
            WHEN jsonb_typeof(session.metadata -> 'kit' -> 'attempt') = 'object' THEN
              jsonb_set(
                jsonb_set(
                  jsonb_set(
                    COALESCE(session.metadata -> 'kit', '{}'::jsonb),
                    '{nativeSessionId}', 'null'::jsonb, true
                  ),
                  '{resumeEligible}', 'false'::jsonb, true
                ),
                '{attempt}',
                jsonb_set(
                  session.metadata -> 'kit' -> 'attempt',
                  '{expectedNativeSessionId}', 'null'::jsonb, true
                ),
                true
              )
            ELSE
              jsonb_set(
                jsonb_set(
                  COALESCE(session.metadata -> 'kit', '{}'::jsonb),
                  '{nativeSessionId}', 'null'::jsonb, true
                ),
                '{resumeEligible}', 'false'::jsonb, true
              )
          END,
          true
        )
        WHERE session.metadata ? 'kit'
          AND jsonb_typeof(session.metadata -> 'kit') = 'object'
          AND (
            session.metadata -> 'kit' -> 'nativeSessionId' IS DISTINCT FROM 'null'::jsonb
            OR session.metadata -> 'kit' -> 'resumeEligible' IS DISTINCT FROM 'false'::jsonb
            OR COALESCE(
              session.metadata -> 'kit' -> 'attempt' -> 'expectedNativeSessionId',
              'null'::jsonb
            ) IS DISTINCT FROM 'null'::jsonb
          )
      `);
    })().catch(error => {
      this.kitPointerSchemaReady = null;
      throw error;
    });
    return this.kitPointerSchemaReady;
  }

  /**
   * Serialize every writer for one exact Kit active-pointer key. Row locks do
   * not cover the first-use case because no pointer row exists yet.
   */
  private async lockKitActivePointer(
    client: PoolClient,
    cli: ProviderType,
    scopeKey: string
  ): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [cli, scopeKey]);
  }

  /** Return a binding only when its session matches one exact accessible context. */
  private getExactKitBinding(
    session: Session | undefined,
    cli: ProviderType,
    execution: KitExecutionRef,
    ownerPrincipal: string
  ): KitSessionBinding | null {
    if (
      !session ||
      session.cli !== cli ||
      !principalCanAccess(session.ownerPrincipal, ownerPrincipal)
    ) {
      return null;
    }
    const binding = getKitSessionBinding(session);
    return binding && sameKitExecutionRef(binding.execution, execution) ? binding : null;
  }

  /**
   * Create a new session.
   */
  async createSession(
    cli: ProviderType,
    description?: string,
    sessionId?: string
  ): Promise<Session> {
    await this.ensureSessionSchema();
    const id = sessionId || randomUUID();
    const sessionDescription = description ?? defaultSessionDescription(cli);
    const now = new Date().toISOString();
    // F3: stamp the owner from the request context ambient at creation.
    const ownerPrincipal = resolveOwnerPrincipal(getRequestContext());
    const generation = randomUUID();

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO sessions (id, cli, description, created_at, last_used_at, owner_principal, session_generation)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, cli, sessionDescription, now, now, ownerPrincipal, generation]
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
        ownerPrincipal,
        generation,
      };
    } catch (error) {
      await rollbackPreservingFailure(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async createSessionWithMetadata(
    cli: ProviderType,
    description: string | undefined,
    sessionId: string,
    metadata: Record<string, any>
  ): Promise<Session> {
    if (Object.prototype.hasOwnProperty.call(metadata, "kit")) {
      throw new Error("Ordinary session metadata cannot set Kit state");
    }
    await this.ensureSessionSchema();
    const sessionDescription = description ?? defaultSessionDescription(cli);
    const now = new Date().toISOString();
    const ownerPrincipal = resolveOwnerPrincipal(getRequestContext());
    const generation = randomUUID();
    const storedMetadata = { ...metadata };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO sessions
           (id, cli, description, metadata, created_at, last_used_at, owner_principal, session_generation)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
        [
          sessionId,
          cli,
          sessionDescription,
          JSON.stringify(storedMetadata),
          now,
          now,
          ownerPrincipal,
          generation,
        ]
      );
      await client.query(
        `INSERT INTO active_sessions (cli, session_id, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (cli) DO NOTHING`,
        [cli, sessionId, now]
      );
      await client.query("COMMIT");
      return {
        id: sessionId,
        cli,
        createdAt: now,
        lastUsedAt: now,
        description: sessionDescription,
        ownerPrincipal,
        generation,
        metadata: storedMetadata,
      };
    } catch (error) {
      await rollbackPreservingFailure(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Persist a Kit binding and its scoped active pointer in one transaction,
   * before a provider can be asked to create or resume its native session.
   */
  async createKitSession(
    cli: ProviderType,
    binding: KitSessionBinding,
    description?: string,
    sessionId?: string
  ): Promise<Session> {
    await this.ensureKitPointerSchema();
    const id = sessionId || randomUUID();
    const sessionDescription = description ?? defaultSessionDescription(cli);
    const now = new Date().toISOString();
    const ownerPrincipal = resolveOwnerPrincipal(getRequestContext());
    const generation = randomUUID();
    const storedBinding = cloneKitSessionBinding(binding);
    const scopeKey = kitActiveSessionKey(
      storedBinding.execution.scopeRoot,
      storedBinding.execution,
      ownerPrincipal
    );
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.lockKitActivePointer(client, cli, scopeKey);
      await client.query(
        `INSERT INTO sessions
           (id, cli, description, metadata, created_at, last_used_at, owner_principal, session_generation)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
        [
          id,
          cli,
          sessionDescription,
          JSON.stringify({ kit: storedBinding }),
          now,
          now,
          ownerPrincipal,
          generation,
        ]
      );
      await client.query(
        `INSERT INTO kit_active_sessions (cli, scope_key, session_id, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (cli, scope_key) DO NOTHING`,
        [cli, scopeKey, id, now]
      );
      await client.query("COMMIT");
      return {
        id,
        cli,
        createdAt: now,
        lastUsedAt: now,
        description: sessionDescription,
        ownerPrincipal,
        generation,
        metadata: { kit: storedBinding },
      };
    } catch (error) {
      await rollbackPreservingFailure(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Migration-only Kit import. It persists the immutable binding and all
   * source metadata atomically, but deliberately creates no active pointer.
   * The migration caller restores only pointers explicitly present in its
   * validated source after every session import has succeeded.
   */
  async importKitSession(
    cli: ProviderType,
    binding: KitSessionBinding,
    description?: string,
    sessionId?: string,
    metadata?: Record<string, any>
  ): Promise<Session> {
    await this.ensureKitPointerSchema();
    const id = sessionId || randomUUID();
    const sessionDescription = description ?? defaultSessionDescription(cli);
    const now = new Date().toISOString();
    const ownerPrincipal = resolveOwnerPrincipal(getRequestContext());
    const generation = randomUUID();
    const storedBinding = cloneKitSessionBinding(binding);
    const storedMetadata = { ...metadata, kit: storedBinding };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO sessions
           (id, cli, description, metadata, created_at, last_used_at, owner_principal, session_generation)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
        [
          id,
          cli,
          sessionDescription,
          JSON.stringify(storedMetadata),
          now,
          now,
          ownerPrincipal,
          generation,
        ]
      );
      await client.query("COMMIT");
      return {
        id,
        cli,
        createdAt: now,
        lastUsedAt: now,
        description: sessionDescription,
        ownerPrincipal,
        generation,
        metadata: storedMetadata,
      };
    } catch (error) {
      await rollbackPreservingFailure(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Import a validated file-session snapshot in one transaction. Exact rows
   * left by an earlier successful or interrupted invocation are accepted as
   * replays, while every mismatch rolls the full import back rather than
   * leaving a committed prefix behind.
   */
  async importFileSessionMigration(
    plan: FileSessionMigrationPlan
  ): Promise<FileSessionMigrationOutcome> {
    await this.ensureKitPointerSchema();

    const recordsById = new Map<string, FileSessionMigrationRecord>();
    for (const record of plan.sessions) {
      if (recordsById.has(record.id)) {
        throw new Error("Session migration plan is invalid");
      }
      recordsById.set(record.id, record);
    }
    const activePointerTargets = new Map<ProviderType, string>();
    for (const pointer of plan.activeSessions) {
      const record = recordsById.get(pointer.sessionId);
      const existingTarget = activePointerTargets.get(pointer.cli);
      if (
        !record ||
        record.cli !== pointer.cli ||
        (existingTarget !== undefined && existingTarget !== pointer.sessionId)
      ) {
        throw new Error("Session migration plan is invalid");
      }
      activePointerTargets.set(pointer.cli, pointer.sessionId);
    }
    const kitPointerTargets = new Map<string, string>();
    for (const pointer of plan.activeKitSessions) {
      const record = recordsById.get(pointer.sessionId);
      if (
        !record ||
        !record.binding ||
        record.cli !== pointer.cli ||
        record.ownerPrincipal !== pointer.ownerPrincipal ||
        record.binding.execution.scopeRoot !== pointer.scopeRoot ||
        !sameKitExecutionRef(record.binding.execution, pointer.execution)
      ) {
        throw new Error("Session migration plan is invalid");
      }
      const scopeKey = kitActiveSessionKey(
        pointer.scopeRoot,
        pointer.execution,
        pointer.ownerPrincipal
      );
      const targetKey = `${pointer.cli}\u0000${scopeKey}`;
      const existingTarget = kitPointerTargets.get(targetKey);
      if (existingTarget !== undefined && existingTarget !== pointer.sessionId) {
        throw new Error("Session migration plan is invalid");
      }
      kitPointerTargets.set(targetKey, pointer.sessionId);
    }

    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      // Serializes two operator invocations against the same database. It also
      // makes a waiting workstation observe exact committed rows as replays.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
        FILE_SESSION_MIGRATION_LOCK_NAMESPACE,
        FILE_SESSION_MIGRATION_LOCK_KEY,
      ]);

      let migrated = 0;
      let replayed = 0;
      for (const record of plan.sessions) {
        const metadata = storedMigrationMetadata(record);
        const existingResult = await client.query<Session>(
          `SELECT id, cli, description, metadata, created_at AS "createdAt",
                  last_used_at AS "lastUsedAt", owner_principal AS "ownerPrincipal",
                  session_generation AS generation
           FROM sessions WHERE id = $1 FOR UPDATE`,
          [record.id]
        );
        const existing = existingResult.rows[0];
        if (existing) {
          if (!migrationRecordMatchesExisting(existing, record, metadata)) {
            throw new Error("A target session conflicts with the source migration");
          }
          replayed++;
          continue;
        }

        const now = new Date().toISOString();
        await client.query(
          `INSERT INTO sessions
             (id, cli, description, metadata, created_at, last_used_at, owner_principal)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
          [
            record.id,
            record.cli,
            record.description ?? defaultSessionDescription(record.cli),
            JSON.stringify(metadata),
            now,
            now,
            record.ownerPrincipal,
          ]
        );
        migrated++;
      }

      const pointerNow = new Date().toISOString();
      for (const pointer of plan.activeSessions) {
        // Never replace a target pointer selected by live traffic. An exact
        // replay is harmless, and an absent pointer may be restored, but a
        // different target is a migration conflict that rolls back all rows.
        const restored = await client.query(
          `INSERT INTO active_sessions (cli, session_id, updated_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (cli) DO UPDATE
             SET session_id = active_sessions.session_id
             WHERE active_sessions.session_id = EXCLUDED.session_id
           RETURNING session_id`,
          [pointer.cli, pointer.sessionId, pointerNow]
        );
        if (restored.rowCount !== 1) {
          throw new Error("A target active session pointer conflicts with the source migration");
        }
      }

      for (const pointer of plan.activeKitSessions) {
        const scopeKey = kitActiveSessionKey(
          pointer.scopeRoot,
          pointer.execution,
          pointer.ownerPrincipal
        );
        await this.lockKitActivePointer(client, pointer.cli, scopeKey);
        // Kit writers share the advisory lock above. The conditional upsert
        // additionally preserves a pointer that was established before this
        // import began, so a stale source snapshot can never displace a live
        // continuation.
        const restored = await client.query(
          `INSERT INTO kit_active_sessions (cli, scope_key, session_id, updated_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (cli, scope_key) DO UPDATE
             SET session_id = kit_active_sessions.session_id
             WHERE kit_active_sessions.session_id = EXCLUDED.session_id
           RETURNING session_id`,
          [pointer.cli, scopeKey, pointer.sessionId, pointerNow]
        );
        if (restored.rowCount !== 1) {
          throw new Error(
            "A target Personal Agent Config Kit pointer conflicts with the source migration"
          );
        }
      }

      // Preserve the legacy first-session-wins behavior for providers whose
      // source file has no explicit active pointer. Do this only after all
      // source pointers have been restored, and never update an existing row,
      // so a concurrent live selection always remains intact.
      for (const record of plan.sessions) {
        if (record.binding || activePointerTargets.has(record.cli)) continue;
        await client.query(
          `INSERT INTO active_sessions (cli, session_id, updated_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (cli) DO NOTHING`,
          [record.cli, record.id, pointerNow]
        );
      }

      await client.query("COMMIT");
      transactionOpen = false;
      return { migrated, replayed };
    } catch (error) {
      if (transactionOpen) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the original migration failure when the connection fails.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Atomically return the active session for one exact Kit execution and
   * principal, or create and bind one. An advisory transaction lock also
   * serializes the absent-pointer case, where row locks alone cannot help.
   */
  async getOrCreateKitSession(
    cli: ProviderType,
    binding: KitSessionBinding,
    description?: string,
    sessionId?: string
  ): Promise<Session> {
    await this.ensureKitPointerSchema();
    const requestedBinding = cloneKitSessionBinding(binding);
    const ownerPrincipal = resolveOwnerPrincipal(getRequestContext());
    const scopeRoot = requestedBinding.execution.scopeRoot;
    const scopeKey = kitActiveSessionKey(scopeRoot, requestedBinding.execution, ownerPrincipal);
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      // `kit_active_sessions` has no row on first use. Locking an advisory key
      // derived from its primary key prevents two first callers from both
      // creating a session before either can insert the pointer.
      await this.lockKitActivePointer(client, cli, scopeKey);

      const activeResult = await client.query<Session>(
        `SELECT s.id, s.cli, s.description, s.metadata,
                s.created_at AS "createdAt", s.last_used_at AS "lastUsedAt",
                s.owner_principal AS "ownerPrincipal", s.session_generation AS generation
         FROM kit_active_sessions AS active
         JOIN sessions AS s ON s.id = active.session_id
         WHERE active.cli = $1 AND active.scope_key = $2
         FOR UPDATE OF active, s`,
        [cli, scopeKey]
      );
      const active = activeResult.rows[0];
      if (active && sessionMatchesKitBinding(active, cli, requestedBinding, ownerPrincipal)) {
        await client.query("COMMIT");
        return active;
      }
      if (active) {
        await client.query(
          "DELETE FROM kit_active_sessions WHERE cli = $1 AND scope_key = $2 AND session_id = $3",
          [cli, scopeKey, active.id]
        );
      }

      if (sessionId) {
        const identifiedResult = await client.query<Session>(
          `SELECT id, cli, description, metadata, created_at AS "createdAt",
                  last_used_at AS "lastUsedAt", owner_principal AS "ownerPrincipal",
                  session_generation AS generation
           FROM sessions WHERE id = $1 FOR UPDATE`,
          [sessionId]
        );
        const identified = identifiedResult.rows[0];
        if (identified) {
          if (!sessionMatchesKitBinding(identified, cli, requestedBinding, ownerPrincipal)) {
            throw new Error(
              `Kit session id ${sessionId} is already bound to a different execution`
            );
          }
          await client.query(
            `INSERT INTO kit_active_sessions (cli, scope_key, session_id, updated_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (cli, scope_key) DO UPDATE
               SET session_id = EXCLUDED.session_id, updated_at = EXCLUDED.updated_at`,
            [cli, scopeKey, identified.id, new Date().toISOString()]
          );
          await client.query("COMMIT");
          return identified;
        }
      }

      const id = sessionId || randomUUID();
      const now = new Date().toISOString();
      const generation = randomUUID();
      const sessionDescription = description ?? defaultSessionDescription(cli);
      await client.query(
        `INSERT INTO sessions
           (id, cli, description, metadata, created_at, last_used_at, owner_principal, session_generation)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
        [
          id,
          cli,
          sessionDescription,
          JSON.stringify({ kit: requestedBinding }),
          now,
          now,
          ownerPrincipal,
          generation,
        ]
      );
      await client.query(
        `INSERT INTO kit_active_sessions (cli, scope_key, session_id, updated_at)
         VALUES ($1, $2, $3, $4)`,
        [cli, scopeKey, id, now]
      );
      await client.query("COMMIT");
      return {
        id,
        cli,
        createdAt: now,
        lastUsedAt: now,
        description: sessionDescription,
        ownerPrincipal,
        generation,
        metadata: { kit: requestedBinding },
      };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The query may have failed before BEGIN; retain the original error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Clear an active pointer only if the exact execution-and-principal slot
   * still points at the failed target session. This never displaces a newer
   * retry or a resumable session that won the slot later.
   */
  async clearActiveKitSessionIfCurrent(
    cli: ProviderType,
    scopeRoot: string | null,
    execution: KitExecutionRef,
    sessionId: string
  ): Promise<boolean> {
    if (execution.scopeRoot !== scopeRoot) return false;
    await this.ensureKitPointerSchema();
    const ownerPrincipal = resolveOwnerPrincipal(getRequestContext());
    const scopeKey = kitActiveSessionKey(scopeRoot, execution, ownerPrincipal);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.lockKitActivePointer(client, cli, scopeKey);
      const sessionResult = await client.query<Session>(
        `SELECT id, cli, description, metadata, created_at AS "createdAt",
                last_used_at AS "lastUsedAt", owner_principal AS "ownerPrincipal",
                session_generation AS generation
         FROM sessions WHERE id = $1 FOR UPDATE`,
        [sessionId]
      );
      const session = sessionResult.rows[0];
      const binding = session ? getKitSessionBinding(session) : null;
      if (
        !session ||
        session.cli !== cli ||
        !principalCanAccess(session.ownerPrincipal, ownerPrincipal) ||
        !binding ||
        !sameKitExecutionRef(binding.execution, execution)
      ) {
        await client.query("ROLLBACK");
        return false;
      }
      const result = await client.query(
        `DELETE FROM kit_active_sessions
         WHERE cli = $1 AND scope_key = $2 AND session_id = $3`,
        [cli, scopeKey, sessionId]
      );
      await client.query("COMMIT");
      return result.rowCount === 1;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The query may have failed before BEGIN; retain the original error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Claim a lease on one exact existing binding. An expired attempt remains a
   * reservation until an external reconciler explicitly releases it, because a
   * durable job may still be queued or running after its nominal expiry.
   */
  async claimKitSessionAttempt(
    cli: ProviderType,
    scopeRoot: string | null,
    execution: KitExecutionRef,
    sessionId: string,
    attempt: KitSessionAttempt
  ): Promise<boolean> {
    if (execution.scopeRoot !== scopeRoot) return false;
    const nextAttempt = cloneKitSessionAttempt(attempt);
    if (!isKitSessionAttemptActive(nextAttempt)) return false;
    await this.ensureKitPointerSchema();
    const ownerPrincipal = resolveOwnerPrincipal(getRequestContext());
    const scopeKey = kitActiveSessionKey(scopeRoot, execution, ownerPrincipal);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.lockKitActivePointer(client, cli, scopeKey);
      const result = await client.query<Session>(
        `SELECT id, cli, description, metadata, created_at AS "createdAt",
                last_used_at AS "lastUsedAt", owner_principal AS "ownerPrincipal",
                session_generation AS generation
         FROM sessions WHERE id = $1 FOR UPDATE`,
        [sessionId]
      );
      const session = result.rows[0];
      const binding = this.getExactKitBinding(session, cli, execution, ownerPrincipal);
      if (
        !binding ||
        binding.attempt ||
        binding.nativeSessionId !== nextAttempt.expectedNativeSessionId
      ) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        `UPDATE sessions
         SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{kit}', $1::jsonb, true)
         WHERE id = $2`,
        [JSON.stringify({ ...binding, attempt: nextAttempt }), sessionId]
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The query may have failed before BEGIN; retain the original error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Renew one exact held attempt without accepting a different holder. */
  async renewKitSessionAttempt(
    cli: ProviderType,
    scopeRoot: string | null,
    execution: KitExecutionRef,
    sessionId: string,
    attemptId: string,
    expiresAt: string
  ): Promise<boolean> {
    if (execution.scopeRoot !== scopeRoot || attemptId.trim().length === 0) return false;
    await this.ensureKitPointerSchema();
    const ownerPrincipal = resolveOwnerPrincipal(getRequestContext());
    const scopeKey = kitActiveSessionKey(scopeRoot, execution, ownerPrincipal);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.lockKitActivePointer(client, cli, scopeKey);
      const result = await client.query<Session>(
        `SELECT id, cli, description, metadata, created_at AS "createdAt",
                last_used_at AS "lastUsedAt", owner_principal AS "ownerPrincipal",
                session_generation AS generation
         FROM sessions WHERE id = $1 FOR UPDATE`,
        [sessionId]
      );
      const session = result.rows[0];
      const binding = this.getExactKitBinding(session, cli, execution, ownerPrincipal);
      const currentAttempt = binding?.attempt;
      if (!binding || !currentAttempt || currentAttempt.id !== attemptId) {
        await client.query("ROLLBACK");
        return false;
      }
      const renewedAttempt = cloneKitSessionAttempt({ ...currentAttempt, expiresAt });
      if (
        !isKitSessionAttemptActive(renewedAttempt) ||
        Date.parse(renewedAttempt.expiresAt) <= Date.parse(currentAttempt.expiresAt)
      ) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        `UPDATE sessions
         SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{kit}', $1::jsonb, true)
         WHERE id = $2`,
        [JSON.stringify({ ...binding, attempt: renewedAttempt }), sessionId]
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The query may have failed before BEGIN; retain the original error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Release one exact attempt without disturbing another lease generation. */
  async releaseKitSessionAttempt(
    cli: ProviderType,
    scopeRoot: string | null,
    execution: KitExecutionRef,
    sessionId: string,
    attemptId: string
  ): Promise<boolean> {
    if (execution.scopeRoot !== scopeRoot || attemptId.trim().length === 0) return false;
    await this.ensureKitPointerSchema();
    const ownerPrincipal = resolveOwnerPrincipal(getRequestContext());
    const scopeKey = kitActiveSessionKey(scopeRoot, execution, ownerPrincipal);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.lockKitActivePointer(client, cli, scopeKey);
      const result = await client.query<Session>(
        `SELECT id, cli, description, metadata, created_at AS "createdAt",
                last_used_at AS "lastUsedAt", owner_principal AS "ownerPrincipal",
                session_generation AS generation
         FROM sessions WHERE id = $1 FOR UPDATE`,
        [sessionId]
      );
      const session = result.rows[0];
      const binding = this.getExactKitBinding(session, cli, execution, ownerPrincipal);
      if (!binding || binding.attempt?.id !== attemptId) {
        await client.query("ROLLBACK");
        return false;
      }
      const bindingWithoutAttempt = { ...binding };
      delete bindingWithoutAttempt.attempt;
      await client.query(
        `UPDATE sessions
         SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{kit}', $1::jsonb, true)
         WHERE id = $2`,
        [JSON.stringify(bindingWithoutAttempt), sessionId]
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The query may have failed before BEGIN; retain the original error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get session by ID.
   */
  async getSession(sessionId: string): Promise<Session | null> {
    await this.ensureSessionSchema();
    const result = await this.pool.query<Session>(
      `SELECT id, cli, description, metadata, created_at AS "createdAt", last_used_at AS "lastUsedAt", owner_principal AS "ownerPrincipal", session_generation AS generation
       FROM sessions
       WHERE id = $1`,
      [sessionId]
    );

    return result.rows[0] ?? null;
  }

  /**
   * List all sessions, optionally filtered by CLI.
   */
  async listSessions(cli?: ProviderType): Promise<Session[]> {
    await this.ensureSessionSchema();
    const query = cli
      ? `SELECT id, cli, description, metadata, created_at AS "createdAt", last_used_at AS "lastUsedAt", owner_principal AS "ownerPrincipal", session_generation AS generation
         FROM sessions
         WHERE cli = $1
         ORDER BY last_used_at DESC`
      : `SELECT id, cli, description, metadata, created_at AS "createdAt", last_used_at AS "lastUsedAt", owner_principal AS "ownerPrincipal", session_generation AS generation
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

    if (getKitSessionBinding(session)?.attempt) return false;
    // Recheck the JSON binding in the DELETE itself. A concurrent Kit claim
    // between getSession() and this statement must win over user deletion.
    const result = await this.pool.query(
      `DELETE FROM sessions
       WHERE id = $1
         AND (NOT (COALESCE(metadata, '{}'::jsonb) ? 'kit')
              OR NOT (COALESCE(metadata, '{}'::jsonb)->'kit' ? 'attempt'))`,
      [sessionId]
    );
    if (result.rowCount === 0) return false;
    this.notifySessionRemoved(session);
    return true;
  }

  /**
   * Set active session for a CLI. The row-level update is serialized by
   * PostgreSQL and the session FK keeps stale IDs from being recorded.
   */
  async setActiveSession(cli: ProviderType, sessionId: string | null): Promise<boolean> {
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
  async getActiveSession(cli: ProviderType): Promise<Session | null> {
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

  async setActiveKitSession(
    cli: ProviderType,
    scopeRoot: string | null,
    sessionId: string | null,
    expectedExecution?: KitExecutionRef
  ): Promise<boolean> {
    if (!expectedExecution && sessionId === null) return false;
    if (expectedExecution && expectedExecution.scopeRoot !== scopeRoot) return false;
    await this.ensureKitPointerSchema();
    const ownerPrincipal = resolveOwnerPrincipal(getRequestContext());
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (sessionId === null) {
        const scopeKey = kitActiveSessionKey(scopeRoot, expectedExecution!, ownerPrincipal);
        await this.lockKitActivePointer(client, cli, scopeKey);
        await client.query("DELETE FROM kit_active_sessions WHERE cli = $1 AND scope_key = $2", [
          cli,
          scopeKey,
        ]);
        await client.query("COMMIT");
        return true;
      }
      // Read without a row lock to derive the exact pointer key, then take the
      // advisory lock before taking the row lock. This matches get-or-create
      // and createKitSession's lock order, avoiding a pointer/session deadlock.
      const candidateResult = await client.query<Session>(
        `SELECT id, cli, description, metadata, created_at AS "createdAt",
                last_used_at AS "lastUsedAt", owner_principal AS "ownerPrincipal",
                session_generation AS generation
         FROM sessions WHERE id = $1`,
        [sessionId]
      );
      const candidate = candidateResult.rows[0];
      const candidateBinding = candidate ? getKitSessionBinding(candidate) : null;
      if (
        !candidate ||
        candidate.cli !== cli ||
        !candidateBinding ||
        candidateBinding.execution.scopeRoot !== scopeRoot ||
        (expectedExecution &&
          !sameKitExecutionRef(candidateBinding.execution, expectedExecution)) ||
        !principalCanAccess(candidate.ownerPrincipal, ownerPrincipal)
      ) {
        await client.query("ROLLBACK");
        return false;
      }
      const scopeKey = kitActiveSessionKey(scopeRoot, candidateBinding.execution, ownerPrincipal);
      await this.lockKitActivePointer(client, cli, scopeKey);
      const sessionResult = await client.query<Session>(
        `SELECT id, cli, description, metadata, created_at AS "createdAt",
                last_used_at AS "lastUsedAt", owner_principal AS "ownerPrincipal",
                session_generation AS generation
         FROM sessions WHERE id = $1 FOR UPDATE`,
        [sessionId]
      );
      const session = sessionResult.rows[0];
      const binding = session ? getKitSessionBinding(session) : null;
      if (
        !session ||
        session.cli !== cli ||
        !binding ||
        binding.execution.scopeRoot !== scopeRoot ||
        !sameKitExecutionRef(binding.execution, candidateBinding.execution) ||
        (expectedExecution && !sameKitExecutionRef(binding.execution, expectedExecution)) ||
        !principalCanAccess(session.ownerPrincipal, ownerPrincipal)
      ) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        `INSERT INTO kit_active_sessions (cli, scope_key, session_id, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (cli, scope_key) DO UPDATE
           SET session_id = EXCLUDED.session_id, updated_at = EXCLUDED.updated_at`,
        [cli, scopeKey, sessionId, new Date().toISOString()]
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The query may have failed before BEGIN; retain the original error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async getActiveKitSession(
    cli: ProviderType,
    scopeRoot: string | null,
    expectedExecution?: KitExecutionRef
  ): Promise<Session | null> {
    if (!expectedExecution || expectedExecution.scopeRoot !== scopeRoot) return null;
    await this.ensureKitPointerSchema();
    const ownerPrincipal = resolveOwnerPrincipal(getRequestContext());
    const scopeKey = kitActiveSessionKey(scopeRoot, expectedExecution, ownerPrincipal);
    const result = await this.pool.query<{ session_id: string }>(
      `SELECT session_id FROM kit_active_sessions
       WHERE cli = $1 AND scope_key = $2`,
      [cli, scopeKey]
    );
    const sessionId = result.rows[0]?.session_id;
    if (!sessionId) return null;
    const session = await this.getSession(sessionId);
    const binding = session ? getKitSessionBinding(session) : null;
    // A stale caller must be rejected without mutating the pointer that is
    // still valid for the execution which originally created this session.
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
    if (!session || session.cli !== cli || !binding || binding.execution.scopeRoot !== scopeRoot) {
      await this.pool.query(
        "DELETE FROM kit_active_sessions WHERE cli = $1 AND scope_key = $2 AND session_id = $3",
        [cli, scopeKey, sessionId]
      );
      return null;
    }
    if (!principalCanAccess(session.ownerPrincipal, ownerPrincipal)) return null;
    return session;
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
    // Kit metadata carries ownership leases and immutable continuation guards.
    // It must only be written by the dedicated, compare-and-swap APIs below.
    if (Object.prototype.hasOwnProperty.call(metadata, "kit")) return false;
    const result = await this.pool.query(
      `UPDATE sessions
       SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
       WHERE id = $2
       RETURNING id`,
      [JSON.stringify(metadata), sessionId]
    );

    return result.rowCount !== 0;
  }

  async compareAndSetSession(
    identity: SessionGenerationIdentity,
    mutation: SessionCompareAndSetMutation
  ): Promise<boolean> {
    await this.ensureSessionSchema();
    const expectedMetadata = mutation.expectedMetadata ?? {};
    const identityPredicate = `id = $2
       AND cli = $3
       AND owner_principal IS NOT DISTINCT FROM $4
       AND created_at = $5::timestamptz
       AND session_generation = $6::uuid
       AND COALESCE(metadata, '{}'::jsonb) = $7::jsonb`;
    const parameters = [
      mutation.kind === "replace_metadata" ? JSON.stringify(mutation.metadata ?? {}) : null,
      identity.id,
      identity.cli,
      identity.ownerPrincipal,
      identity.createdAt,
      identity.generation,
      JSON.stringify(expectedMetadata),
    ];

    if (mutation.kind === "replace_metadata") {
      if (!isDeepStrictEqual(expectedMetadata.kit, mutation.metadata?.kit)) return false;
      const result = await this.pool.query(
        `UPDATE sessions
         SET metadata = $1::jsonb
         WHERE ${identityPredicate}
         RETURNING id`,
        parameters
      );
      return result.rowCount !== 0;
    }

    const deleteIdentityPredicate = `id = $1
       AND cli = $2
       AND owner_principal IS NOT DISTINCT FROM $3
       AND created_at = $4::timestamptz
       AND session_generation = $5::uuid
       AND COALESCE(metadata, '{}'::jsonb) = $6::jsonb`;
    const result = await this.pool.query<Session>(
      `DELETE FROM sessions
       WHERE ${deleteIdentityPredicate}
         AND (NOT (COALESCE(metadata, '{}'::jsonb) ? 'kit')
              OR NOT (COALESCE(metadata, '{}'::jsonb)->'kit' ? 'attempt'))
       RETURNING id, cli, description, metadata, created_at AS "createdAt",
                 last_used_at AS "lastUsedAt", owner_principal AS "ownerPrincipal",
                 session_generation AS generation`,
      parameters.slice(1)
    );
    const removed = result.rows[0];
    if (!removed) return false;
    this.notifySessionRemoved(removed);
    return true;
  }

  /**
   * Atomically refresh provider-native continuation metadata while forbidding a
   * different Kit execution reference on an existing session.
   */
  async updateKitSessionBinding(
    sessionId: string,
    binding: KitSessionBinding,
    expectedAttemptId?: string
  ): Promise<boolean> {
    await this.ensureKitPointerSchema();
    const next = cloneKitSessionBinding(binding);
    const ownerPrincipal = resolveOwnerPrincipal(getRequestContext());
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<Session>(
        `SELECT id, cli, description, metadata, created_at AS "createdAt",
                last_used_at AS "lastUsedAt", owner_principal AS "ownerPrincipal",
                session_generation AS generation
         FROM sessions WHERE id = $1 FOR UPDATE`,
        [sessionId]
      );
      const session = result.rows[0];
      if (!session) {
        await client.query("ROLLBACK");
        return false;
      }
      const existing = getKitSessionBinding(session);
      // Binding creation is intentionally limited to createKitSession, whose
      // transaction also writes the scoped active pointer before execution.
      if (!existing || !sameKitExecutionRef(existing.execution, next.execution)) {
        await client.query("ROLLBACK");
        return false;
      }
      if (existing.attempt && expectedAttemptId === undefined) {
        await client.query("ROLLBACK");
        return false;
      }
      if (expectedAttemptId !== undefined) {
        const currentAttempt = existing.attempt;
        if (
          expectedAttemptId.trim().length === 0 ||
          !principalCanAccess(session.ownerPrincipal, ownerPrincipal) ||
          !currentAttempt ||
          currentAttempt.id !== expectedAttemptId ||
          existing.nativeSessionId !== currentAttempt.expectedNativeSessionId
        ) {
          await client.query("ROLLBACK");
          return false;
        }
      }
      await client.query(
        `UPDATE sessions
         SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{kit}', $1::jsonb, true)
         WHERE id = $2`,
        [JSON.stringify(next), sessionId]
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The query may have failed before BEGIN; retain the original error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async getPinnedKitReleaseIds(): Promise<string[]> {
    const result = await this.pool.query<{ metadata: Record<string, unknown> | null }>(
      "SELECT metadata FROM sessions WHERE metadata ? 'kit'"
    );
    const releases = new Set<string>();
    for (const row of result.rows) {
      const binding = getKitSessionBinding({
        id: "kit-release-query",
        cli: "claude",
        createdAt: "",
        lastUsedAt: "",
        metadata: row.metadata ?? {},
      });
      if (binding && (binding.resumeEligible || binding.attempt)) {
        releases.add(binding.execution.releaseId);
      }
    }
    return [...releases].sort();
  }

  async getReferencedKitReleaseIds(): Promise<string[]> {
    return await this.getPinnedKitReleaseIds();
  }

  /**
   * Clear all sessions, optionally filtered by CLI.
   */
  async clearAllSessions(cli?: ProviderType): Promise<number> {
    await this.ensureSessionSchema();
    const protectedAttempt = `(NOT (COALESCE(metadata, '{}'::jsonb) ? 'kit')
      OR NOT (COALESCE(metadata, '{}'::jsonb)->'kit' ? 'attempt'))`;
    const query = cli
      ? `DELETE FROM sessions WHERE cli = $1 AND ${protectedAttempt}
         RETURNING id, cli, description, metadata, created_at AS "createdAt", last_used_at AS "lastUsedAt", owner_principal AS "ownerPrincipal", session_generation AS generation`
      : `DELETE FROM sessions WHERE ${protectedAttempt}
         RETURNING id, cli, description, metadata, created_at AS "createdAt", last_used_at AS "lastUsedAt", owner_principal AS "ownerPrincipal", session_generation AS generation`;
    const result = cli ? await this.pool.query(query, [cli]) : await this.pool.query(query);

    for (const session of result.rows as Session[]) this.notifySessionRemoved(session);
    return result.rowCount || 0;
  }

  /** Gateway-managed worktrees are rejected with PostgreSQL persistence. */
  async listPendingWorktreeCleanupSessions(): Promise<Session[]> {
    return [];
  }

  /** PostgreSQL never owns filesystem-local worktree cleanup tombstones. */
  async finalizePendingWorktreeCleanup(_session: Session): Promise<boolean> {
    return false;
  }
}
