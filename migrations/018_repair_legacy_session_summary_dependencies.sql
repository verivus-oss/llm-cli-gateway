-- Repair historical session schemas without changing published migrations 002
-- or 003. The runner wraps still-pending versions in a transaction-local view
-- compatibility step; this forward migration repairs a database that already
-- recorded those versions but retains an older physical column shape or lost
-- the canonical active_sessions.session_id -> sessions.id cascade.

DO $$
DECLARE
  sessions_id_is_uuid BOOLEAN;
  active_session_id_is_uuid BOOLEAN;
  canonical_session_id_foreign_key_exists BOOLEAN;
  conflicting_session_id_foreign_key TEXT;
  required_foreign_key_name_conflict TEXT;
  session_id_foreign_key RECORD;
BEGIN
  IF to_regclass('session_summary') IS NULL
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute
       WHERE attrelid = to_regclass('sessions')
         AND attname = 'id'
         AND atttypid = 'uuid'::regtype
         AND attnum > 0
         AND NOT attisdropped
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid = to_regclass('active_sessions')
         AND constraint_row.confrelid = to_regclass('sessions')
         AND constraint_row.contype = 'f'
         AND constraint_row.convalidated
         AND constraint_row.confdeltype = 'c'
         AND array_length(constraint_row.conkey, 1) = 1
         AND constraint_row.conkey[1] = (
           SELECT attribute_row.attnum
           FROM pg_catalog.pg_attribute AS attribute_row
           WHERE attribute_row.attrelid = to_regclass('active_sessions')
             AND attribute_row.attname = 'session_id'
             AND attribute_row.attnum > 0
             AND NOT attribute_row.attisdropped
         )
         AND array_length(constraint_row.confkey, 1) = 1
         AND constraint_row.confkey[1] = (
           SELECT attribute_row.attnum
           FROM pg_catalog.pg_attribute AS attribute_row
           WHERE attribute_row.attrelid = to_regclass('sessions')
             AND attribute_row.attname = 'id'
             AND attribute_row.attnum > 0
             AND NOT attribute_row.attisdropped
         )
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute
       WHERE attrelid = to_regclass('active_sessions')
         AND attname = 'session_id'
         AND atttypid = 'uuid'::regtype
         AND attnum > 0
         AND NOT attisdropped
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute
       WHERE attrelid IN (to_regclass('sessions'), to_regclass('active_sessions'))
         AND attname = 'cli'
         AND (atttypid <> 'character varying'::regtype OR atttypmod <> 36)
         AND attnum > 0
         AND NOT attisdropped
     ) THEN
    DROP VIEW IF EXISTS session_summary;

    SELECT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute
      WHERE attrelid = to_regclass('sessions')
        AND attname = 'id'
        AND atttypid = 'uuid'::regtype
        AND attnum > 0
        AND NOT attisdropped
    ) INTO sessions_id_is_uuid;
    SELECT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute
      WHERE attrelid = to_regclass('active_sessions')
        AND attname = 'session_id'
        AND atttypid = 'uuid'::regtype
        AND attnum > 0
        AND NOT attisdropped
    ) INTO active_session_id_is_uuid;

    SELECT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = to_regclass('active_sessions')
        AND constraint_row.confrelid = to_regclass('sessions')
        AND constraint_row.contype = 'f'
        AND constraint_row.convalidated
        AND constraint_row.confdeltype = 'c'
        AND array_length(constraint_row.conkey, 1) = 1
        AND constraint_row.conkey[1] = (
          SELECT attribute_row.attnum
          FROM pg_catalog.pg_attribute AS attribute_row
          WHERE attribute_row.attrelid = to_regclass('active_sessions')
            AND attribute_row.attname = 'session_id'
            AND attribute_row.attnum > 0
            AND NOT attribute_row.attisdropped
        )
        AND array_length(constraint_row.confkey, 1) = 1
        AND constraint_row.confkey[1] = (
          SELECT attribute_row.attnum
          FROM pg_catalog.pg_attribute AS attribute_row
          WHERE attribute_row.attrelid = to_regclass('sessions')
            AND attribute_row.attname = 'id'
            AND attribute_row.attnum > 0
            AND NOT attribute_row.attisdropped
        )
    ) INTO canonical_session_id_foreign_key_exists;

    IF sessions_id_is_uuid
       OR active_session_id_is_uuid
       OR NOT canonical_session_id_foreign_key_exists THEN
      -- A foreign key on session_id that targets anything other than
      -- sessions.id is application-owned schema. Never drop or reinterpret it
      -- as the canonical relationship during a compatibility repair.
      SELECT constraint_row.conname
        INTO conflicting_session_id_foreign_key
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = to_regclass('active_sessions')
        AND constraint_row.contype = 'f'
        AND array_position(
          constraint_row.conkey,
          (
            SELECT attribute_row.attnum
            FROM pg_catalog.pg_attribute AS attribute_row
            WHERE attribute_row.attrelid = to_regclass('active_sessions')
              AND attribute_row.attname = 'session_id'
              AND attribute_row.attnum > 0
              AND NOT attribute_row.attisdropped
          )
        ) IS NOT NULL
        AND NOT (
          constraint_row.confrelid = to_regclass('sessions')
          AND array_length(constraint_row.conkey, 1) = 1
          AND constraint_row.conkey[1] = (
            SELECT attribute_row.attnum
            FROM pg_catalog.pg_attribute AS attribute_row
            WHERE attribute_row.attrelid = to_regclass('active_sessions')
              AND attribute_row.attname = 'session_id'
              AND attribute_row.attnum > 0
              AND NOT attribute_row.attisdropped
          )
          AND array_length(constraint_row.confkey, 1) = 1
          AND constraint_row.confkey[1] = (
            SELECT attribute_row.attnum
            FROM pg_catalog.pg_attribute AS attribute_row
            WHERE attribute_row.attrelid = to_regclass('sessions')
              AND attribute_row.attname = 'id'
              AND attribute_row.attnum > 0
              AND NOT attribute_row.attisdropped
          )
        )
      LIMIT 1;
      IF conflicting_session_id_foreign_key IS NOT NULL THEN
        RAISE EXCEPTION
          'Cannot repair session schema: active_sessions.session_id foreign key "%" does not reference sessions.id',
          conflicting_session_id_foreign_key;
      END IF;

      -- A conflicting constraint name would make the canonical ADD below
      -- ambiguous. Preserve it and require an explicit manual migration.
      SELECT constraint_row.conname
        INTO required_foreign_key_name_conflict
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = to_regclass('active_sessions')
        AND constraint_row.conname = 'active_sessions_session_id_fkey'
        AND NOT (
          constraint_row.contype = 'f'
          AND constraint_row.confrelid = to_regclass('sessions')
          AND array_length(constraint_row.conkey, 1) = 1
          AND constraint_row.conkey[1] = (
            SELECT attribute_row.attnum
            FROM pg_catalog.pg_attribute AS attribute_row
            WHERE attribute_row.attrelid = to_regclass('active_sessions')
              AND attribute_row.attname = 'session_id'
              AND attribute_row.attnum > 0
              AND NOT attribute_row.attisdropped
          )
          AND array_length(constraint_row.confkey, 1) = 1
          AND constraint_row.confkey[1] = (
            SELECT attribute_row.attnum
            FROM pg_catalog.pg_attribute AS attribute_row
            WHERE attribute_row.attrelid = to_regclass('sessions')
              AND attribute_row.attname = 'id'
              AND attribute_row.attnum > 0
              AND NOT attribute_row.attisdropped
          )
        )
      LIMIT 1;
      IF required_foreign_key_name_conflict IS NOT NULL THEN
        RAISE EXCEPTION
          'Cannot repair session schema: active_sessions constraint "%" conflicts with the required session foreign key',
          required_foreign_key_name_conflict;
      END IF;

      -- Historical schemas may use a nonstandard name for the exact
      -- session_id -> sessions.id relationship. Drop only that verified
      -- relationship before changing either endpoint or normalizing cascade.
      FOR session_id_foreign_key IN
        SELECT constraint_row.conname
        FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.conrelid = to_regclass('active_sessions')
          AND constraint_row.confrelid = to_regclass('sessions')
          AND constraint_row.contype = 'f'
          AND array_length(constraint_row.conkey, 1) = 1
          AND constraint_row.conkey[1] = (
            SELECT attribute_row.attnum
            FROM pg_catalog.pg_attribute AS attribute_row
            WHERE attribute_row.attrelid = to_regclass('active_sessions')
              AND attribute_row.attname = 'session_id'
              AND attribute_row.attnum > 0
              AND NOT attribute_row.attisdropped
          )
          AND array_length(constraint_row.confkey, 1) = 1
          AND constraint_row.confkey[1] = (
            SELECT attribute_row.attnum
            FROM pg_catalog.pg_attribute AS attribute_row
            WHERE attribute_row.attrelid = to_regclass('sessions')
              AND attribute_row.attname = 'id'
              AND attribute_row.attnum > 0
              AND NOT attribute_row.attisdropped
          )
      LOOP
        EXECUTE format(
          'ALTER TABLE active_sessions DROP CONSTRAINT %I',
          session_id_foreign_key.conname
        );
      END LOOP;
      IF sessions_id_is_uuid THEN
        ALTER TABLE sessions ALTER COLUMN id TYPE TEXT USING id::text;
      END IF;
      IF active_session_id_is_uuid THEN
        ALTER TABLE active_sessions ALTER COLUMN session_id TYPE TEXT USING session_id::text;
      END IF;
      ALTER TABLE active_sessions
        ADD CONSTRAINT active_sessions_session_id_fkey
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;
    END IF;

    ALTER TABLE sessions ALTER COLUMN cli TYPE VARCHAR(32);
    ALTER TABLE active_sessions ALTER COLUMN cli TYPE VARCHAR(32);

    CREATE OR REPLACE VIEW session_summary AS
    SELECT
      s.id,
      s.cli,
      s.description,
      s.created_at,
      s.last_used_at,
      (a.session_id IS NOT NULL) AS is_active
    FROM sessions s
    LEFT JOIN active_sessions a ON s.id = a.session_id;
  END IF;
END;
$$ LANGUAGE plpgsql;

INSERT INTO schema_migrations (version, name)
VALUES (18, '018_repair_legacy_session_summary_dependencies')
ON CONFLICT (version) DO NOTHING;
