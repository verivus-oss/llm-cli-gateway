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
import {
  getRequestContext,
  principalCanAccess,
  principalScopeSql,
  resolveOwnerPrincipal,
} from "./request-context.js";
import {
  cloneKitSessionBinding,
  cloneKitSessionAttempt,
  isKitSessionAttemptActive,
  sameKitExecutionRef,
  type KitExecutionRef,
  type KitSessionBinding,
  type KitSessionAttempt,
} from "./personal-config-types.js";
import type { StorageConnection, StorageDriver } from "./storage/store.js";

export type { Logger } from "./logger.js";

/** One validated source record for an all-or-nothing file-session import. */
export interface FileSessionMigrationRecord {
  id: string;
  cli: ProviderType;
  description?: string;
  metadata: Record<string, unknown>;
  ownerPrincipal: string;
  binding: KitSessionBinding | null;
  /**
   * The SOURCE timestamps, carried across the store boundary.
   *
   * These fields did not exist, so the importer had nothing to write and
   * stamped `new Date()` for both. A 3,590-session import then landed with
   * every row created and last-used inside the same 22-second window, which
   * silently destroys three things: `cleanup_expired_sessions(max_age_days)`
   * sees a June session as minutes old and never reaps it, ordering by
   * `last_used_at` (and `idx_sessions_cli_last_used`) becomes arbitrary, and
   * any most-recent-session resolution picks effectively at random.
   *
   * ISO 8601 strings, validated by the caller before the record is built.
   */
  createdAt: string;
  lastUsedAt: string;
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

/**
 * An early return that must ROLLBACK, not COMMIT.
 *
 * Eleven methods here read under `FOR UPDATE`, decide the caller loses a race,
 * and issue `ROLLBACK` before returning `false`. `driver.transaction()` owns
 * the terminator, so a body that issued its own `ROLLBACK` would be followed by
 * the driver's `COMMIT` on a transaction that no longer exists: PostgreSQL
 * answers that with a WARNING, not an error, so the method would return the
 * right value and the abort would be silently downgraded.
 *
 * Throwing instead makes the driver roll back, and this wrapper turns the throw
 * back into the return value. The value is carried rather than assumed, so a
 * future non-boolean early return cannot quietly become `false`.
 */
class TransactionAbort<T> extends Error {
  constructor(readonly value: T) {
    super("storage: transaction aborted with a result");
    this.name = "TransactionAbort";
  }
}

function abortWith<T>(value: T): never {
  throw new TransactionAbort(value);
}

async function transactionWithAbort<T>(
  driver: StorageDriver,
  body: (connection: StorageConnection) => Promise<T>
): Promise<T> {
  try {
    return await driver.transaction("write", body);
  } catch (error) {
    if (error instanceof TransactionAbort) return error.value as T;
    throw error;
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

  constructor(private driver: StorageDriver) {}

  /**
   * One statement outside a transaction.
   *
   * Every operation in this module declares the class `write`, including the
   * reads, and that is deliberate rather than lazy. The class picks a
   * CREDENTIAL, and the only credential this store has ever had is `app`.
   * Routing session reads to the `reader` identity would be a grant decision
   * about a role defined for transcript text, on tables it may hold no SELECT
   * on; `[persistence.roles]` and the per-role DSNs belong to s9, which can
   * make that decision once for every subsystem. Until then `write` resolves to
   * `app`, which is exactly what the private pool did.
   */
  private query<T>(statement: string, params: readonly unknown[] = []): Promise<T[]> {
    return this.driver.withConnection("write", connection =>
      connection.query<T>(statement, params)
    );
  }

  /** One mutation outside a transaction, returning the affected row count. */
  private async execute(statement: string, params: readonly unknown[] = []): Promise<number> {
    return this.driver.withConnection(
      "write",
      async connection => (await connection.execute(statement, params)).rowsAffected
    );
  }

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
      const attributes = await this.query<{
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
      if (!attributes[0]?.table_name) {
        throw new Error(
          "Session PostgreSQL schema is missing sessions. Run `DATABASE_URL=... npm run migrate` with the migration role before using [persistence] backend = postgres."
        );
      }
      const names = new Set(attributes.flatMap(row => (row.column_name ? [row.column_name] : [])));
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
      const attributes = await this.query<{
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
      if (!attributes[0]?.table_name) {
        throw new Error(
          "Personal Agent Config Kit PostgreSQL schema is missing kit_active_sessions. Run `npm run migrate` with the migration role before enabling [personal_config]."
        );
      }
      const names = new Set(attributes.flatMap(row => (row.column_name ? [row.column_name] : [])));
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
      // `jsonb_exists(x, 'k')`, not `x ? 'k'`. The port's Postgres driver
      // rewrites `?` placeholders into `$n`, and it cannot tell a placeholder
      // from jsonb's key-exists OPERATOR, which is the same character. The
      // operator form here became `metadata $1 'kit'` and failed as a syntax
      // error the moment this statement went through the driver. Every such
      // operator in this file is spelled as its function for that reason; they
      // are the same operator, so the semantics are unchanged.
      await this.execute(`
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
        WHERE jsonb_exists(session.metadata, 'kit')
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
    connection: StorageConnection,
    cli: ProviderType,
    scopeKey: string
  ): Promise<void> {
    await connection.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
      cli,
      scopeKey,
    ]);
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

    return transactionWithAbort(this.driver, async connection => {
      await connection.execute(
        `INSERT INTO sessions (id, cli, description, created_at, last_used_at, owner_principal, session_generation)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, cli, sessionDescription, now, now, ownerPrincipal, generation]
      );

      await connection.execute(
        `INSERT INTO active_sessions (cli, session_id, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (cli) DO NOTHING`,
        [cli, id, now]
      );

      return {
        id,
        cli,
        createdAt: now,
        lastUsedAt: now,
        description: sessionDescription,
        ownerPrincipal,
        generation,
      };
    });
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
    return transactionWithAbort(this.driver, async connection => {
      await connection.execute(
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
      await connection.execute(
        `INSERT INTO active_sessions (cli, session_id, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (cli) DO NOTHING`,
        [cli, sessionId, now]
      );
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
    });
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
    return transactionWithAbort(this.driver, async connection => {
      await this.lockKitActivePointer(connection, cli, scopeKey);
      await connection.execute(
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
      await connection.execute(
        `INSERT INTO kit_active_sessions (cli, scope_key, session_id, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (cli, scope_key) DO NOTHING`,
        [cli, scopeKey, id, now]
      );
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
    });
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
    return transactionWithAbort(this.driver, async connection => {
      await connection.execute(
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
    });
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

    return transactionWithAbort(this.driver, async connection => {
      // Serializes two operator invocations against the same database. It also
      // makes a waiting workstation observe exact committed rows as replays.
      await connection.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
        FILE_SESSION_MIGRATION_LOCK_NAMESPACE,
        FILE_SESSION_MIGRATION_LOCK_KEY,
      ]);

      let migrated = 0;
      let replayed = 0;
      for (const record of plan.sessions) {
        const metadata = storedMigrationMetadata(record);
        const existingRows = await connection.query<Session>(
          `SELECT id, cli, description, metadata, created_at AS "createdAt",
                  last_used_at AS "lastUsedAt", owner_principal AS "ownerPrincipal",
                  session_generation AS generation
           FROM sessions WHERE id = $1 FOR UPDATE`,
          [record.id]
        );
        const existing = existingRows[0];
        if (existing) {
          if (!migrationRecordMatchesExisting(existing, record, metadata)) {
            throw new Error("A target session conflicts with the source migration");
          }
          replayed++;
          continue;
        }

        // The SOURCE timestamps, not `now`. A migration is a copy; stamping the
        // import time makes every row look freshly created and destroys age,
        // ordering and TTL semantics in one pass.
        await connection.execute(
          `INSERT INTO sessions
             (id, cli, description, metadata, created_at, last_used_at, owner_principal)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
          [
            record.id,
            record.cli,
            record.description ?? defaultSessionDescription(record.cli),
            JSON.stringify(metadata),
            record.createdAt,
            record.lastUsedAt,
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
        const restored = await connection.query(
          `INSERT INTO active_sessions (cli, session_id, updated_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (cli) DO UPDATE
             SET session_id = active_sessions.session_id
             WHERE active_sessions.session_id = EXCLUDED.session_id
           RETURNING session_id`,
          [pointer.cli, pointer.sessionId, pointerNow]
        );
        if (restored.length !== 1) {
          throw new Error("A target active session pointer conflicts with the source migration");
        }
      }

      for (const pointer of plan.activeKitSessions) {
        const scopeKey = kitActiveSessionKey(
          pointer.scopeRoot,
          pointer.execution,
          pointer.ownerPrincipal
        );
        await this.lockKitActivePointer(connection, pointer.cli, scopeKey);
        // Kit writers share the advisory lock above. The conditional upsert
        // additionally preserves a pointer that was established before this
        // import began, so a stale source snapshot can never displace a live
        // continuation.
        const restored = await connection.query(
          `INSERT INTO kit_active_sessions (cli, scope_key, session_id, updated_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (cli, scope_key) DO UPDATE
             SET session_id = kit_active_sessions.session_id
             WHERE kit_active_sessions.session_id = EXCLUDED.session_id
           RETURNING session_id`,
          [pointer.cli, scopeKey, pointer.sessionId, pointerNow]
        );
        if (restored.length !== 1) {
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
        await connection.execute(
          `INSERT INTO active_sessions (cli, session_id, updated_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (cli) DO NOTHING`,
          [record.cli, record.id, pointerNow]
        );
      }

      return { migrated, replayed };
    });
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

    return transactionWithAbort(this.driver, async connection => {
      // `kit_active_sessions` has no row on first use. Locking an advisory key
      // derived from its primary key prevents two first callers from both
      // creating a session before either can insert the pointer.
      await this.lockKitActivePointer(connection, cli, scopeKey);

      const activeRows = await connection.query<Session>(
        `SELECT s.id, s.cli, s.description, s.metadata,
                s.created_at AS "createdAt", s.last_used_at AS "lastUsedAt",
                s.owner_principal AS "ownerPrincipal", s.session_generation AS generation
         FROM kit_active_sessions AS active
         JOIN sessions AS s ON s.id = active.session_id
         WHERE active.cli = $1 AND active.scope_key = $2
         FOR UPDATE OF active, s`,
        [cli, scopeKey]
      );
      const active = activeRows[0];
      if (active && sessionMatchesKitBinding(active, cli, requestedBinding, ownerPrincipal)) {
        return active;
      }
      if (active) {
        await connection.execute(
          "DELETE FROM kit_active_sessions WHERE cli = $1 AND scope_key = $2 AND session_id = $3",
          [cli, scopeKey, active.id]
        );
      }

      if (sessionId) {
        const identifiedRows = await connection.query<Session>(
          `SELECT id, cli, description, metadata, created_at AS "createdAt",
                  last_used_at AS "lastUsedAt", owner_principal AS "ownerPrincipal",
                  session_generation AS generation
           FROM sessions WHERE id = $1 FOR UPDATE`,
          [sessionId]
        );
        const identified = identifiedRows[0];
        if (identified) {
          if (!sessionMatchesKitBinding(identified, cli, requestedBinding, ownerPrincipal)) {
            throw new Error(
              `Kit session id ${sessionId} is already bound to a different execution`
            );
          }
          await connection.execute(
            `INSERT INTO kit_active_sessions (cli, scope_key, session_id, updated_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (cli, scope_key) DO UPDATE
               SET session_id = EXCLUDED.session_id, updated_at = EXCLUDED.updated_at`,
            [cli, scopeKey, identified.id, new Date().toISOString()]
          );
          return identified;
        }
      }

      const id = sessionId || randomUUID();
      const now = new Date().toISOString();
      const generation = randomUUID();
      const sessionDescription = description ?? defaultSessionDescription(cli);
      await connection.execute(
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
      await connection.execute(
        `INSERT INTO kit_active_sessions (cli, scope_key, session_id, updated_at)
         VALUES ($1, $2, $3, $4)`,
        [cli, scopeKey, id, now]
      );
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
    });
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
    return transactionWithAbort(this.driver, async connection => {
      await this.lockKitActivePointer(connection, cli, scopeKey);
      const sessionRows = await connection.query<Session>(
        `SELECT id, cli, description, metadata, created_at AS "createdAt",
                last_used_at AS "lastUsedAt", owner_principal AS "ownerPrincipal",
                session_generation AS generation
         FROM sessions WHERE id = $1 FOR UPDATE`,
        [sessionId]
      );
      const session = sessionRows[0];
      const binding = session ? getKitSessionBinding(session) : null;
      if (
        !session ||
        session.cli !== cli ||
        !principalCanAccess(session.ownerPrincipal, ownerPrincipal) ||
        !binding ||
        !sameKitExecutionRef(binding.execution, execution)
      ) {
        abortWith(false);
      }
      const result = await connection.execute(
        `DELETE FROM kit_active_sessions
         WHERE cli = $1 AND scope_key = $2 AND session_id = $3`,
        [cli, scopeKey, sessionId]
      );
      return result.rowsAffected === 1;
    });
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
    return transactionWithAbort(this.driver, async connection => {
      await this.lockKitActivePointer(connection, cli, scopeKey);
      const rows = await connection.query<Session>(
        `SELECT id, cli, description, metadata, created_at AS "createdAt",
                last_used_at AS "lastUsedAt", owner_principal AS "ownerPrincipal",
                session_generation AS generation
         FROM sessions WHERE id = $1 FOR UPDATE`,
        [sessionId]
      );
      const session = rows[0];
      const binding = this.getExactKitBinding(session, cli, execution, ownerPrincipal);
      if (
        !binding ||
        binding.attempt ||
        binding.nativeSessionId !== nextAttempt.expectedNativeSessionId
      ) {
        abortWith(false);
      }
      await connection.execute(
        `UPDATE sessions
         SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{kit}', $1::jsonb, true)
         WHERE id = $2`,
        [JSON.stringify({ ...binding, attempt: nextAttempt }), sessionId]
      );
      return true;
    });
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
    return transactionWithAbort(this.driver, async connection => {
      await this.lockKitActivePointer(connection, cli, scopeKey);
      const rows = await connection.query<Session>(
        `SELECT id, cli, description, metadata, created_at AS "createdAt",
                last_used_at AS "lastUsedAt", owner_principal AS "ownerPrincipal",
                session_generation AS generation
         FROM sessions WHERE id = $1 FOR UPDATE`,
        [sessionId]
      );
      const session = rows[0];
      const binding = this.getExactKitBinding(session, cli, execution, ownerPrincipal);
      const currentAttempt = binding?.attempt;
      if (!binding || !currentAttempt || currentAttempt.id !== attemptId) {
        abortWith(false);
      }
      const renewedAttempt = cloneKitSessionAttempt({ ...currentAttempt, expiresAt });
      if (
        !isKitSessionAttemptActive(renewedAttempt) ||
        Date.parse(renewedAttempt.expiresAt) <= Date.parse(currentAttempt.expiresAt)
      ) {
        abortWith(false);
      }
      await connection.execute(
        `UPDATE sessions
         SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{kit}', $1::jsonb, true)
         WHERE id = $2`,
        [JSON.stringify({ ...binding, attempt: renewedAttempt }), sessionId]
      );
      return true;
    });
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
    return transactionWithAbort(this.driver, async connection => {
      await this.lockKitActivePointer(connection, cli, scopeKey);
      const rows = await connection.query<Session>(
        `SELECT id, cli, description, metadata, created_at AS "createdAt",
                last_used_at AS "lastUsedAt", owner_principal AS "ownerPrincipal",
                session_generation AS generation
         FROM sessions WHERE id = $1 FOR UPDATE`,
        [sessionId]
      );
      const session = rows[0];
      const binding = this.getExactKitBinding(session, cli, execution, ownerPrincipal);
      if (!binding || binding.attempt?.id !== attemptId) {
        abortWith(false);
      }
      const bindingWithoutAttempt = { ...binding };
      delete bindingWithoutAttempt.attempt;
      await connection.execute(
        `UPDATE sessions
         SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{kit}', $1::jsonb, true)
         WHERE id = $2`,
        [JSON.stringify(bindingWithoutAttempt), sessionId]
      );
      return true;
    });
  }

  /**
   * Get session by ID.
   */
  async getSession(sessionId: string): Promise<Session | null> {
    await this.ensureSessionSchema();
    const rows = await this.query<Session>(
      `SELECT id, cli, description, metadata, created_at AS "createdAt", last_used_at AS "lastUsedAt", owner_principal AS "ownerPrincipal", session_generation AS generation
       FROM sessions
       WHERE id = $1`,
      [sessionId]
    );

    return rows[0] ?? null;
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

    return cli ? await this.query<Session>(query, [cli]) : await this.query<Session>(query);
  }

  /**
   * Delete a session.
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    const caller = resolveOwnerPrincipal(getRequestContext());
    const session = await this.getSession(sessionId);
    if (!session) {
      return false;
    }
    if (!principalCanAccess(session.ownerPrincipal, caller)) return false;

    if (getKitSessionBinding(session)?.attempt) return false;
    // Recheck the JSON binding in the DELETE itself. A concurrent Kit claim
    // between getSession() and this statement must win over user deletion.
    // The OWNER is rechecked here for the same reason, and it was missing: a
    // handler decides ownership an await earlier, and an id whose row is
    // deleted in that window can be re-created under another principal before
    // this statement runs. `principalScopeSql` is the one spelling of that
    // rule, so the predicate here cannot drift from the in-memory one.
    // `?` placeholders (not `$n`) because the driver numbers them; the Kit arm
    // uses jsonb_exists rather than the `?` operator, so nothing collides.
    const scope = principalScopeSql("owner_principal", caller);
    const rowsAffected = await this.execute(
      `DELETE FROM sessions
       WHERE id = ?
         AND ${scope.sql}
         AND (NOT jsonb_exists(COALESCE(metadata, '{}'::jsonb), 'kit')
              OR NOT jsonb_exists(COALESCE(metadata, '{}'::jsonb)->'kit', 'attempt'))`,
      [sessionId, ...scope.params]
    );
    if (rowsAffected === 0) return false;
    this.notifySessionRemoved(session);
    return true;
  }

  /**
   * Set active session for a CLI. The row-level update is serialized by
   * PostgreSQL and the session FK keeps stale IDs from being recorded.
   */
  async setActiveSession(cli: ProviderType, sessionId: string | null): Promise<boolean> {
    await this.ensureSessionSchema();
    const now = new Date().toISOString();
    if (sessionId === null) {
      await this.execute(
        `INSERT INTO active_sessions (cli, session_id, updated_at)
         VALUES ($1, NULL, $2)
         ON CONFLICT (cli) DO UPDATE SET session_id = NULL, updated_at = $2`,
        [cli, now]
      );
      return true;
    }

    // The target's provider and OWNER are selected by the same statement that
    // writes the pointer. Read-then-write let a row deleted and re-created
    // under another principal in the gap inherit this caller's decision.
    const scope = principalScopeSql(
      "s.owner_principal",
      resolveOwnerPrincipal(getRequestContext())
    );
    const rowsAffected = await this.execute(
      `INSERT INTO active_sessions (cli, session_id, updated_at)
       SELECT ?, s.id, ?
         FROM sessions s
        WHERE s.id = ? AND s.cli = ? AND ${scope.sql}
       ON CONFLICT (cli) DO UPDATE
          SET session_id = EXCLUDED.session_id, updated_at = EXCLUDED.updated_at`,
      [cli, now, sessionId, cli, ...scope.params]
    );

    return rowsAffected !== 0;
  }

  /**
   * Get active session for a CLI.
   */
  async getActiveSession(cli: ProviderType): Promise<Session | null> {
    const rows = await this.query<{ session_id: string | null }>(
      "SELECT session_id FROM active_sessions WHERE cli = $1",
      [cli]
    );

    const sessionId = rows[0]?.session_id;
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
    return transactionWithAbort(this.driver, async connection => {
      if (sessionId === null) {
        const scopeKey = kitActiveSessionKey(scopeRoot, expectedExecution!, ownerPrincipal);
        await this.lockKitActivePointer(connection, cli, scopeKey);
        await connection.execute(
          "DELETE FROM kit_active_sessions WHERE cli = $1 AND scope_key = $2",
          [cli, scopeKey]
        );
        return true;
      }
      // Read without a row lock to derive the exact pointer key, then take the
      // advisory lock before taking the row lock. This matches get-or-create
      // and createKitSession's lock order, avoiding a pointer/session deadlock.
      const candidateRows = await connection.query<Session>(
        `SELECT id, cli, description, metadata, created_at AS "createdAt",
                last_used_at AS "lastUsedAt", owner_principal AS "ownerPrincipal",
                session_generation AS generation
         FROM sessions WHERE id = $1`,
        [sessionId]
      );
      const candidate = candidateRows[0];
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
        abortWith(false);
      }
      const scopeKey = kitActiveSessionKey(scopeRoot, candidateBinding.execution, ownerPrincipal);
      await this.lockKitActivePointer(connection, cli, scopeKey);
      const sessionRows = await connection.query<Session>(
        `SELECT id, cli, description, metadata, created_at AS "createdAt",
                last_used_at AS "lastUsedAt", owner_principal AS "ownerPrincipal",
                session_generation AS generation
         FROM sessions WHERE id = $1 FOR UPDATE`,
        [sessionId]
      );
      const session = sessionRows[0];
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
        abortWith(false);
      }
      await connection.execute(
        `INSERT INTO kit_active_sessions (cli, scope_key, session_id, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (cli, scope_key) DO UPDATE
           SET session_id = EXCLUDED.session_id, updated_at = EXCLUDED.updated_at`,
        [cli, scopeKey, sessionId, new Date().toISOString()]
      );
      return true;
    });
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
    const rows = await this.query<{ session_id: string }>(
      `SELECT session_id FROM kit_active_sessions
       WHERE cli = $1 AND scope_key = $2`,
      [cli, scopeKey]
    );
    const sessionId = rows[0]?.session_id;
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
      await this.execute(
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
  async updateSessionUsage(sessionId: string): Promise<boolean> {
    const now = new Date().toISOString();
    // Reports whether the row was written. The previous `void` contract could
    // not tell a caller that the session it is about to report no longer
    // exists, which is the same swallowed-loss shape the file store had.
    const rowsAffected = await this.execute("UPDATE sessions SET last_used_at = $1 WHERE id = $2", [
      now,
      sessionId,
    ]);
    return rowsAffected !== 0;
  }

  /**
   * Update session metadata using PostgreSQL's atomic JSONB merge.
   */
  async updateSessionMetadata(sessionId: string, metadata: Record<string, any>): Promise<boolean> {
    // Kit metadata carries ownership leases and immutable continuation guards.
    // It must only be written by the dedicated, compare-and-swap APIs below.
    if (Object.prototype.hasOwnProperty.call(metadata, "kit")) return false;
    const rowsAffected = await this.execute(
      `UPDATE sessions
       SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
       WHERE id = $2
       RETURNING id`,
      [JSON.stringify(metadata), sessionId]
    );

    return rowsAffected !== 0;
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
      const rowsAffected = await this.execute(
        `UPDATE sessions
         SET metadata = $1::jsonb
         WHERE ${identityPredicate}
         RETURNING id`,
        parameters
      );
      return rowsAffected !== 0;
    }

    const deleteIdentityPredicate = `id = $1
       AND cli = $2
       AND owner_principal IS NOT DISTINCT FROM $3
       AND created_at = $4::timestamptz
       AND session_generation = $5::uuid
       AND COALESCE(metadata, '{}'::jsonb) = $6::jsonb`;
    const rows = await this.query<Session>(
      `DELETE FROM sessions
       WHERE ${deleteIdentityPredicate}
         AND (NOT jsonb_exists(COALESCE(metadata, '{}'::jsonb), 'kit')
              OR NOT jsonb_exists(COALESCE(metadata, '{}'::jsonb)->'kit', 'attempt'))
       RETURNING id, cli, description, metadata, created_at AS "createdAt",
                 last_used_at AS "lastUsedAt", owner_principal AS "ownerPrincipal",
                 session_generation AS generation`,
      parameters.slice(1)
    );
    const removed = rows[0];
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
    return transactionWithAbort(this.driver, async connection => {
      const rows = await connection.query<Session>(
        `SELECT id, cli, description, metadata, created_at AS "createdAt",
                last_used_at AS "lastUsedAt", owner_principal AS "ownerPrincipal",
                session_generation AS generation
         FROM sessions WHERE id = $1 FOR UPDATE`,
        [sessionId]
      );
      const session = rows[0];
      if (!session) {
        abortWith(false);
      }
      const existing = getKitSessionBinding(session);
      // Binding creation is intentionally limited to createKitSession, whose
      // transaction also writes the scoped active pointer before execution.
      if (!existing || !sameKitExecutionRef(existing.execution, next.execution)) {
        abortWith(false);
      }
      if (existing.attempt && expectedAttemptId === undefined) {
        abortWith(false);
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
          abortWith(false);
        }
      }
      await connection.execute(
        `UPDATE sessions
         SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{kit}', $1::jsonb, true)
         WHERE id = $2`,
        [JSON.stringify(next), sessionId]
      );
      return true;
    });
  }

  async getPinnedKitReleaseIds(): Promise<string[]> {
    const rows = await this.query<{ metadata: Record<string, unknown> | null }>(
      "SELECT metadata FROM sessions WHERE jsonb_exists(metadata, 'kit')"
    );
    const releases = new Set<string>();
    for (const row of rows) {
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
    const protectedAttempt = `(NOT jsonb_exists(COALESCE(metadata, '{}'::jsonb), 'kit')
      OR NOT jsonb_exists(COALESCE(metadata, '{}'::jsonb)->'kit', 'attempt'))`;
    const query = cli
      ? `DELETE FROM sessions WHERE cli = $1 AND ${protectedAttempt}
         RETURNING id, cli, description, metadata, created_at AS "createdAt", last_used_at AS "lastUsedAt", owner_principal AS "ownerPrincipal", session_generation AS generation`
      : `DELETE FROM sessions WHERE ${protectedAttempt}
         RETURNING id, cli, description, metadata, created_at AS "createdAt", last_used_at AS "lastUsedAt", owner_principal AS "ownerPrincipal", session_generation AS generation`;
    const removed = cli
      ? await this.query<Session>(query, [cli])
      : await this.query<Session>(query);

    for (const session of removed) this.notifySessionRemoved(session);
    return removed.length;
  }

  /**
   * Hidden durable worktree-cleanup tombstones awaiting origin-host retry.
   *
   * A git worktree is a local filesystem artifact, and this store is shared:
   * instances on other hosts read the same `sessions` rows. The hostname filter
   * therefore lives in the SQL, not in a post-fetch `.filter()`. Applied after
   * the fetch, a foreign host's tombstones would already be in this process's
   * memory, one bug away from being acted on; applied in the query, they are
   * never returned at all.
   *
   * @param ownerHostname This instance's hostname; only its own rows are listed.
   */
  async listPendingWorktreeCleanupSessions(ownerHostname?: string): Promise<Session[]> {
    if (!ownerHostname) return [];
    await this.ensureSessionSchema();
    return await this.query<Session>(
      `SELECT id, cli, description, metadata, created_at AS "createdAt", last_used_at AS "lastUsedAt", owner_principal AS "ownerPrincipal", session_generation AS generation
       FROM sessions
       WHERE metadata->>'worktreeCleanupPendingDeletion' = 'true'
         AND metadata->>'worktreeOwnerHostname' = $1`,
      [ownerHostname]
    );
  }

  /**
   * Finalize an exact tombstone only after verified worktree removal.
   *
   * Fenced on the generation AND on the row still being a tombstone owned by
   * the same host, so a concurrent instance that re-created or adopted the
   * session cannot have its row deleted by a late acknowledgement from here.
   * This mirrors the status fencing the job store uses for the same reason.
   */
  async finalizePendingWorktreeCleanup(session: Session): Promise<boolean> {
    await this.ensureSessionSchema();
    const ownerHostname = session.metadata?.worktreeOwnerHostname;
    if (typeof ownerHostname !== "string" || ownerHostname.length === 0) return false;
    const rowsAffected = await this.execute(
      `DELETE FROM sessions
       WHERE id = $1
         AND session_generation IS NOT DISTINCT FROM $2
         AND metadata->>'worktreeCleanupPendingDeletion' = 'true'
         AND metadata->>'worktreeOwnerHostname' = $3`,
      [session.id, session.generation ?? null, ownerHostname]
    );
    return rowsAffected === 1;
  }
}
