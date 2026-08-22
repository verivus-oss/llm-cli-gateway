-- The flight recorder's transcript schema for PostgreSQL.
--
-- NEW AUTHORSHIP, not a translation: `requests` and `gateway_metadata` have
-- only ever existed in SQLite (storage-unification.dag.toml [facts].schema_gap).
-- The contract is PARITY with src/flight-recorder.ts SQL_SCHEMA plus its eleven
-- idempotent column migrations, so a row written here reads back with the same
-- JavaScript types a `logs.db` row does. Where a "better" PostgreSQL type would
-- change those types, parity wins and the reason is recorded below; changing the
-- shape of what the request-history tools return is a data-visible change, not
-- a port.
--
-- datetime_utc is TEXT, not TIMESTAMPTZ. It holds an ISO-8601 UTC string that
-- readers compare lexicographically (`datetime_utc >= $1`), order on, and hand
-- to callers as a string. TIMESTAMPTZ would come back from `pg` as a Date and
-- change every row the tools return.
--
-- Token, char and duration counters stay INTEGER rather than becoming BIGINT.
-- int4 tops out at 2.1e9, which no single request's token count, character
-- count or millisecond duration reaches, and `pg` returns int8 as a STRING,
-- so BIGINT would silently turn `input_tokens: number` into a string at every
-- reader. No column here holds epoch millis; the one time value is TEXT above.
--
-- cost_usd and route_est_cost_usd are DOUBLE PRECISION, not NUMERIC. The source
-- column is SQLite REAL, which is IEEE-754 binary64, exactly what float8 is, so
-- this is the type that round-trips unchanged. NUMERIC is the better type for
-- money you must not round, but `pg` returns it as a string and it would change
-- both the stored value and the reader's type. Exact decimal cost is a data-model
-- change that must also change `PersistedRequestRow.cost_usd`; it is not this.
--
-- optimization_applied and routed become BOOLEAN. Both are written as 1/0 and
-- read only as a predicate, so nothing outside the database sees the type.
--
-- Nullability is copied exactly. SQLite's `INTEGER DEFAULT 0` still admits an
-- explicit NULL, so these carry a DEFAULT without NOT NULL: adding a constraint
-- the source did not have would refuse a row the SQLite recorder accepts.

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  cli TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  system TEXT,
  response TEXT,
  session_id TEXT,
  duration_ms INTEGER,
  datetime_utc TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  owner_principal TEXT,
  cost_basis TEXT,
  derived_prompt_chars INTEGER,
  derived_content_class TEXT,
  derivation_version INTEGER,
  stable_prefix_hash TEXT,
  stable_prefix_tokens INTEGER,
  cache_control_blocks INTEGER,
  cache_control_ttl_seconds INTEGER
);

CREATE TABLE IF NOT EXISTS gateway_metadata (
  request_id TEXT PRIMARY KEY REFERENCES requests(id),
  retry_count INTEGER DEFAULT 0,
  circuit_breaker_state TEXT,
  cost_usd DOUBLE PRECISION,
  approval_decision TEXT,
  optimization_applied BOOLEAN DEFAULT FALSE,
  thinking_blocks TEXT,
  exit_code INTEGER,
  http_status INTEGER,
  error_message TEXT,
  async_job_id TEXT,
  provider_session_id TEXT,
  stop_reason TEXT,
  routed BOOLEAN,
  route_est_cost_usd DOUBLE PRECISION,
  route_est_confidence TEXT,
  route_reason TEXT,
  route_considered INTEGER,
  route_reroutes INTEGER,
  status TEXT NOT NULL DEFAULT 'started',
  compression_route TEXT,
  compression_transforms TEXT,
  compression_original_chars INTEGER,
  compression_compressed_chars INTEGER,
  compression_tokens_saved_est INTEGER
);

-- The five indexes SQL_SCHEMA creates, plus idx_requests_stable_hash, which the
-- v3 column migration creates beside the columns it adds.
CREATE INDEX IF NOT EXISTS idx_requests_datetime ON requests(datetime_utc);
CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model);
CREATE INDEX IF NOT EXISTS idx_requests_cli ON requests(cli);
CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(session_id);
CREATE INDEX IF NOT EXISTS idx_requests_stable_hash ON requests(stable_prefix_hash);
CREATE INDEX IF NOT EXISTS idx_metadata_status ON gateway_metadata(status);

INSERT INTO schema_migrations (version, name)
VALUES (22, '022_flight_recorder_transcripts')
ON CONFLICT (version) DO NOTHING;
