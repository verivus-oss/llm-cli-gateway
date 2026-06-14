-- F3: per-principal isolation. Add an ownership principal to PostgreSQL-backed
-- sessions, mirroring the file backend's `ownerPrincipal` and the job store's
-- `owner_principal`. Additive and nullable: rows created before this migration
-- keep NULL and are treated as legacy-unowned by F3b enforcement.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS owner_principal TEXT;

INSERT INTO schema_migrations (version, name)
VALUES (4, '004_session_owner_principal')
ON CONFLICT (version) DO NOTHING;
