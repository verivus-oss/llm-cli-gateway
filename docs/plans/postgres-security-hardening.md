# Postgres security hardening

Status: draft. One change applied (2.1); everything else unimplemented.
Scope: the `llm-gateway-pg` deployment on `workhorse3`, and the preconditions
for moving flight-recorder transcripts into Postgres.

Revision 4, after three adversarial review rounds (Codex, 2026-08-13). All
defects were independently verified against the code and the live deployment
before being accepted; none were contested. Corrections are marked inline,
because several invalidated design pillars rather than wording.

Section 4.4's policy set is the only part of this document that has been
**executed** rather than reasoned about. Doing so found a defect three review
rounds had missed, which is the strongest available argument for executing the
rest before treating it as deployable.

## 1. Why this exists

The gateway moved its control plane to Postgres, but the flight recorder is
still SQLite-only (`flight-recorder.ts:24`), so prompt and response bodies land
in `~/.llm-cli-gateway/logs.db`. See `storage-unification.md` for that problem.
This document covers what the Postgres deployment must become before transcript
bodies are moved into it.

## 2. Verified current state

Measured on `workhorse3` 2026-08-13, container `llm-gateway-pg`,
`postgres:17-alpine`, rootless podman, port bound to `127.0.0.1:5432`.

| Property              | State                             | Evidence                                                         |
| --------------------- | --------------------------------- | ---------------------------------------------------------------- |
| Encryption at rest    | none                              | no LUKS/dm-crypt on the host; pgdata on plain btrfs              |
| Block checksums       | off                               | `data_checksums = off`                                           |
| Encryption in transit | none                              | `ssl = off`; a live connection reports `pg_stat_ssl.ssl = false` |
| Authentication        | SCRAM for all callers (since 2.1) | `pg_hba_file_rules`: 7 rules, all `scram-sha-256`                |
| RBAC                  | none                              | single role `llmgw`, `rolsuper = true`, owns all six tables      |
| Row-level security    | none                              | `relrowsecurity = false` on every table                          |
| Topology              | single host                       | all `gateway_instances` rows are `workhorse3`                    |

**Correction (was wrong in revision 1).** Revision 1's table said
"Authentication: none for local callers". That was false even before the 2.1
change, for the reason 2.1 itself explains, and it contradicted the rest of this
document. Real host callers were always authenticated by the final SCRAM rule.

Row counts are snapshots of a live system and drift during any review. At
measurement time: 3,278 jobs, rising to 3,291 during the review.

### 2.1 The `trust` rules, and what they actually exposed

The original configuration had seven rules; abridged here to the three that
matter for the argument, with the IPv6 and replication entries omitted:

```
local   all   all                    trust      # + local replication
host    all   all   127.0.0.1/32     trust      # + ::1/128, + replication
host    all   all   all              scram-sha-256
```

The obvious reading is that any local caller connected untrusted. That reading
is wrong here, and the reason is the single most important fact about this
deployment.

Under rootless podman with pasta networking, a host process connecting to the
forwarded `127.0.0.1:5432` is NAT'd and arrives bearing the host's LAN address.
Measured: gateway connections present as `192.168.1.33`, and
`inet_client_addr()` from a fresh host connection returns `192.168.1.33/32`.
The `127.0.0.1/32` and `local` rules therefore matched only the container's own
network namespace, and every real gateway connection matched the final
`scram-sha-256` rule.

So the exposure was latent: passwordless superuser access for anything executing
inside the container namespace, and one networking change away from applying to
host processes.

**Resolved 2026-08-12.** All `trust` methods replaced with `scram-sha-256`
(seven rules, `pg_hba_file_rules` reports no parse errors), reloaded via
`pg_reload_conf()`. Verified: passwordless socket access rejected with
`fe_sendauth: no password supplied`; a fresh connection over the gateway's own
path authenticates and reads. Previous config retained in-container as
`pg_hba.conf.bak-20260812T205823Z`.

## 3. Threat model

1. **Local process reads the database.** A spawned provider CLI or any process
   under the same OS user. It needs the DSN, which sits in `config.toml` at
   `0600` under the account those CLIs run as. Dominant threat, and the one most
   "encryption at rest" answers do not address.
2. **Credential theft from disk.** Against the standing rule that secrets do not
   live on disk.
3. **Backup or dump exfiltration.**
4. **Physical or offline access.**

Threat 1 defeats the encryption controls available today. On a running host the
filesystem is mounted, so LUKS answers threat 4 only.

Envelope encryption's standing against threat 1 is **undetermined, not
defeated**, and revision 3 asserted both in consecutive paragraphs. The
determining factor is a vault authentication design that does not exist yet: if
the gateway can fetch the KEK by presenting nothing a sibling process cannot
also present, then threat 1 defeats it; a service-bound broker, cgroup-bound
identity or hardware-backed credential could change that. Until that design
exists the question is open, and this document must not answer it in either
direction. Section 4.6 tracks it as one of four separate boundaries.

The rest of this document addresses threats 2, 3 and 4, which are addressable
today.

## 4. Target design

### 4.1 Encryption in transit

```
ssl = on
ssl_min_protocol_version = 'TLSv1.3'
log_connections = on
```

**Correction (was wrong in revision 1).** Revision 1's target `pg_hba.conf`
permitted only `127.0.0.1/32` and then rejected everything else. **That would
have locked out the gateway.** PostgreSQL matches the first rule whose address
covers the actual client address, and this document measures that address as
`192.168.1.33` two sections earlier. Revision 1 contradicted its own evidence.

The address rule must be derived from a measurement, not from an assumption
about loopback. Three viable options, in preference order:

1. **Unix socket.** Bind-mount the socket and use `peer`. Does not extend to a
   second host. **Correction: revision 3 said this "removes the network path
   entirely", which is false as written.** The socket only removes TCP if TCP is
   actually removed: `listen_addresses` is currently `*`, and the podman
   `127.0.0.1:5432` binding remains. This branch additionally requires
   `listen_addresses = ''`, dropping the port binding, `unix_socket_permissions`
   plus socket ownership on the bind mount, and `pg_ident.conf` mappings from
   the OS user to the per-role database usernames, since `peer` authenticates
   the kernel identity and needs a mapping to reach `llmgw_app` and friends.
2. **Preserve loopback.** Change the container networking so the client address
   is genuinely `127.0.0.1`, then the loopback rule is correct.
3. **Match the NAT-visible address**, pinned to whatever
   `inet_client_addr()` actually reports. Fragile if that address changes.

Whichever is chosen, the deployment procedure must verify with a real connection
**before** the reject rule is armed, and must keep a rollback path as the 2.1
change did. The check differs by branch, and revision 3 wrongly applied the
IP check to both: for the TCP branches, assert `inet_client_addr()` matches the
configured rule; for the socket branch, assert `inet_client_addr() IS NULL`,
plus the expected peer identity and socket permissions, because a unix-socket
connection has no client address at all.

Authentication moves to client certificates:

```
hostssl  llm_cli_gateway  <role>  <verified-address>  cert  clientcert=verify-full
```

**Correction (was wrong in revision 1).** Revision 1 claimed certificate auth
"closes threat 2 by construction". It does not. It replaces a password with a
client private key, which is still an authentication credential on disk at
`0600`, readable by the same OS user, and libpq requires access to it. The
accurate claim: certificates **reduce** credential-theft impact through per-role
scoping, expiry and revocation, and remove a shared reusable secret. They do not
eliminate the on-disk credential.

**Correction (revision 2 was internally inconsistent).** Revision 2 offered the
unix-socket option and then moved authentication to certificates
unconditionally. Certificates apply to the **TLS branch only**; under the socket
branch, `peer` is the authentication mechanism and there is no certificate.

**Server verification was also missing.** Enabling server TLS and client
certificates does not make the client verify the server. The TLS branch
additionally requires:

- server certificate, key and CA placement, with the CA trusted by the client
- a server name or SAN that the client actually checks
- client connection string using `sslmode=verify-full` with `sslrootcert`
  pinned to that CA

**Correction: revision 3 overstated this.** It claimed anything short of
`verify-full` accepts any certificate. Not so: `verify-ca` does validate that
the certificate chains to the trusted CA, it simply does not check that the
server name matches. `require` and `prefer` are the modes with no identity
verification. `verify-full` is still the correct choice, because a CA-valid
certificate for a different host would otherwise pass.

### 4.2 Encryption at rest

**Layer 1, block level (threat 4).** LUKS-backed volume for pgdata. There is no
encrypted device on this host today.

**Correction.** Revision 1 relocated only the podman volume. The verified backup
at `/srv/data/backups/llm-cli-gateway/` is on a **different, also unencrypted
filesystem**. Any at-rest scheme must cover backup placement explicitly, or the
backup becomes the soft target.

**Layer 2, application-level envelope encryption of transcript bodies.**
AES-256-GCM, per-row data key, KEK from the vault, for `requests.prompt`,
`requests.system` and `requests.response`.

**Correction (was wrong in revision 1), and it broke the feasibility argument.**
Revision 1 asserted that body columns are never filtered or searched and are
fetched only by primary key. False. `lcr-priors.ts:397` selects `r.prompt` in a
bulk scan, and `lcr-priors.ts:290-293` passes it to `estimateInputTokens` and
`classifyContent`, on the routing path behind a 60-second cache. Encrypting the
prompt column would break least-cost routing.

The fix is a design change, not a doc edit: **derive at write time what the
routing path needs, and store the derivations.** `estimateInputTokens` and
`classifyContent` are both computable when the row is written. Persisting a
token estimate and a content class as their own columns removes the only bulk
reader of prompt bodies, after which the encryption scheme is viable and the
analytics role never needs body access. This is a prerequisite, not a follow-up.

`lcr-priors.ts:398` is confirmed as the **only** production bulk body reader.
`cache-stats.ts:615` also reads `prompt` and `response` but only by request id,
which encryption tolerates.

Five constraints the derivation must satisfy, none of which revision 2 stated:

1. **Derive after redaction.** The persisted copy is redacted by `redactStart`
   (`flight-recorder.ts:735`). Deriving from the pre-redaction text would make
   routing statistics disagree with the stored row; deriving from the redacted
   text is the correct choice and must be explicit.
2. **Version the estimator.** Store an estimator identifier and model-family
   alongside the value, or a future estimator change silently averages new
   values with stale historical ones and routing degrades invisibly.
3. **Backfill and reconcile** existing rows before encryption, since an
   unencrypted historical row is still readable but an encrypted one without a
   derivation is permanently unusable for routing.
4. **Commit body and derivations atomically**, so no row can exist with an
   encrypted body and a missing derivation.
5. **Close the escape hatch.** Column grants prove today's queries are
   compatible; they do not prevent a future bulk body query through the generic
   `queryRequests<T>(sql)` entry point. `storage-unification.md` section 3.4
   replaces it with named typed readers, and the ratchet forbids raw SQL outside
   the drivers. Without that, this whole scheme is one convenient query away
   from breaking again.

**The cryptographic record format is unspecified** and must be before
implementation: wrapped-DEK storage and key version, per-column nonce
allocation, additional authenticated data binding a ciphertext to its row and
column, rotation procedure, and behaviour on authentication-tag failure. Known
answer tests, a tamper test and a restore rehearsal are required.

**Correction: the encryption claim was cluster-wide but the scheme covers three
columns.** Revision 1 said a stolen DSN, dump or superuser yields ciphertext.
Postgres also stores plaintext in `jobs.args_json`, `jobs.payload_json`,
`jobs.stdout`, `jobs.stderr`, `jobs.error`, `validation_runs.request_json`,
`validation_receipts.report_json`, and `gateway_metadata.thinking_blocks` and
`error_message`. The claim is therefore **narrowed to the three transcript
columns**. A full data classification across those other columns is owed before
any broader claim is made.

**Enable `data_checksums`**, currently off, during the same maintenance window
as the volume move.

### 4.3 RBAC

| Role              | Login | Purpose                 | Privileges                                                    |
| ----------------- | ----- | ----------------------- | ------------------------------------------------------------- |
| `llmgw_owner`     | no    | owns schema and tables  | DDL only                                                      |
| `llmgw_migrate`   | yes   | `npm run migrate` only  | member of `llmgw_owner`                                       |
| `llmgw_app`       | yes   | gateway runtime         | `SELECT`, `INSERT`, `UPDATE`, and **scoped `DELETE`** (below) |
| `llmgw_reader`    | yes   | transcript read-back    | `SELECT` including bodies, RLS-scoped                         |
| `llmgw_analytics` | yes   | cache stats, LCR priors | `SELECT` on non-body columns only                             |
| `llmgw_retention` | yes   | bulk expiry             | `DELETE` for retention sweeps                                 |

**Correction (was wrong in revision 1).** Revision 1 gave `llmgw_app` no
`DELETE` at all. That breaks verified runtime behaviour: the worker deletes from
`gateway_instances` (`:795`, `:949`), `jobs` (`:1095`) and `validation_run_jobs`
(`:1164`), and `session-manager-pg.ts` contains 8 `DELETE FROM` statements
including user-requested session deletion. A retention-only role cannot serve
`session_delete` or instance deregistration.

**Correction (revision 2's list was incomplete, revision 3 contradicted itself,
and revision 4 was over-privileged).** `llmgw_app` needs `DELETE` on
`gateway_instances`, `sessions`, `validation_run_jobs` and
**`kit_active_sessions`**, and nothing else.

- It does **not** need `DELETE` on `jobs`; revision 3 listed it here and then
  decided four paragraphs later that it was not needed. The decision below
  governs.
- It does **not** need `DELETE` on `active_sessions` either. Verified: there
  are **zero** `DELETE FROM active_sessions` statements in production. The
  table is maintained by upsert, and rows are removed through the
  `ON DELETE CASCADE` foreign key at `migrations/001_initial_schema.sql:17`.
  Revisions 1 through 4 all granted a privilege nothing uses, which is the
  quieter failure mode of a least-privilege design: too much, not too little.

- `kit_active_sessions` is deleted on four ordinary runtime paths:
  `session-manager-pg.ts:780`, `:898`, `:1201`, `:1308`. Revision 2 granted
  `active_sessions` and omitted this table entirely.
- **Job expiry is on the ordinary runtime sweep path**, not a retention job:
  `async-job-manager.ts:2268` calls `this.store.evictExpired()`. Revision 2 left
  the role choice "to be resolved per call site", which is not a resolution and
  is not implementable while the storage design has no app-versus-retention
  routing seam.

That seam now exists: `storage-unification.md` section 3.1 defines per-role
pools and an operation-class routing rule. **Decision: `evictExpired` is a
retention operation and routes to `llmgw_retention`**, so `llmgw_app` does not
need `DELETE` on `jobs`.

**`llmgw_retention` needs `SELECT`, not only `DELETE`.** The expiry statement at
`postgres-job-store-worker.ts:1095` filters on `expires_at`,
`kit_execution_json`, `kit_terminal_finalized` and `mcp_artifact_cleanup_pending`,
and PostgreSQL requires `SELECT` on every column referenced in a `DELETE`
predicate. A `DELETE`-only grant fails at runtime. Revision 3's role table
granted only `DELETE`.

**Every instance runs this sweep.** All gateway instances execute the
five-minute expiry, so either every instance carries the retention credential,
or the sweep is elected to one instance. That choice must be made, along with
single-flight behaviour once the operation is asynchronous.

**Correction.** Revision 1's revocations removed `CONNECT` and schema privileges
from `PUBLIC` without granting them back to the service roles, which would have
locked out every role it created. Revision 3's replacement was **invalid SQL**:
`REVOKE ALL, CONNECT` is a syntax error, because `ALL [PRIVILEGES]` is an
alternative to a privilege list, not a member of one.

```sql
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE llm_cli_gateway FROM PUBLIC;
GRANT CONNECT ON DATABASE llm_cli_gateway TO llmgw_app, llmgw_reader,
      llmgw_analytics, llmgw_retention, llmgw_migrate;
GRANT USAGE ON SCHEMA public TO llmgw_app, llmgw_reader,
      llmgw_analytics, llmgw_retention;
-- REQUIRED: referential-integrity checks run with the referencing table's
-- owner privileges. Without this, foreign-key enforcement fails at runtime
-- with "permission denied for schema public". Found by executing the DDL,
-- not by reviewing it. See 4.4.
GRANT USAGE ON SCHEMA public TO llmgw_owner;
```

Every statement in this document must be executed against a scratch database
before it is treated as deployable. Revision 3 shipped a syntax error through a
review round.

**The analytics grant must be derived from the actual queries.** Revision 1's
column list was invented and would have broken current behaviour. Verified
requirements include `stable_prefix_hash`, `cache_control_blocks` and
`cache_control_ttl_seconds` (`cache-stats.ts:173-182`), plus `gateway_metadata`
routing and cost columns (`resources.ts:378`), plus the new derived LCR columns
from 4.2. The grant must be generated from an enumeration of every analytics
query, and a test must fail if a query references a column the role lacks.

### 4.4 Row-level security

Principal isolation is currently enforced in application code at
`index.ts:21884` via `principalCanAccess` (`request-context.ts:51`). RLS makes
that a backstop rather than the only line of defence.

**Correction (was wrong in revision 1): the policy set was non-functional.**
Revision 1 defined only `SELECT` policies. PostgreSQL default-denies when RLS is
enabled and no applicable policy exists, so `llmgw_app`, deliberately a
non-owner without `BYPASSRLS`, would have had every `INSERT` and `UPDATE` on
`requests` denied. The policy set must cover write commands explicitly.

Three further verified gaps:

- **Legacy rows.** The live store has **3,455 rows with
  `owner_principal IS NULL`** out of 34,382. `principalCanAccess` currently
  exposes those to `local`. A naive equality policy hides them, silently
  changing behaviour. The policy must reproduce the existing rule, or the
  backfill must assign ownership, and that choice must be explicit.
- **`gateway_metadata` has no `owner_principal`.** Verified against the live
  schema. Its policy needs an `EXISTS` join to `requests`, or the column must be
  added and backfilled.
- **`SET LOCAL app.principal` is not an implementation-ready design over a
  pool.** It must be a `set_config(...)` call parameterised rather than
  interpolated, inside an explicit transaction on a single checked-out client,
  with guaranteed rollback and release. A pooled query without those guarantees
  can leak a principal setting into an unrelated later query, which would be a
  worse bug than the one RLS is fixing.

**Revision 4: executed, not asserted.** Revisions 2 and 3 described a policy set
in prose and a table with an unresolved `<same predicate>` placeholder. The
following DDL was **executed against a scratch database on this deployment** and
the assertions below were observed, so it is evidence rather than intent.

```sql
ALTER TABLE requests         ENABLE ROW LEVEL SECURITY;
ALTER TABLE requests         FORCE  ROW LEVEL SECURITY;
ALTER TABLE gateway_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE gateway_metadata FORCE  ROW LEVEL SECURITY;

CREATE POLICY req_app_ins ON requests FOR INSERT TO llmgw_app
  WITH CHECK (owner_principal = current_setting('app.principal', true));

CREATE POLICY req_app_sel ON requests FOR SELECT TO llmgw_app
  USING (owner_principal = current_setting('app.principal', true));

CREATE POLICY req_app_upd ON requests FOR UPDATE TO llmgw_app
  USING      (owner_principal = current_setting('app.principal', true))
  WITH CHECK (owner_principal = current_setting('app.principal', true));

-- Reproduces principalCanAccess exactly, including the legacy-null rule.
CREATE POLICY req_reader_sel ON requests FOR SELECT TO llmgw_reader
  USING (
    owner_principal = current_setting('app.principal', true)
    OR (owner_principal IS NULL
        AND current_setting('app.principal', true) = 'local')
  );

CREATE POLICY req_analytics_sel ON requests FOR SELECT TO llmgw_analytics
  USING (true);   -- bodies withheld by column grant, not by policy

CREATE POLICY meta_app_all ON gateway_metadata FOR ALL TO llmgw_app
  USING      (EXISTS (SELECT 1 FROM requests r WHERE r.id = request_id
                AND r.owner_principal = current_setting('app.principal', true)))
  WITH CHECK (EXISTS (SELECT 1 FROM requests r WHERE r.id = request_id
                AND r.owner_principal = current_setting('app.principal', true)));

-- REQUIRED, and missed by the first execution pass: metadata needs its own
-- policies for the read roles, mirroring each role's `requests` predicate.
-- Without them every joined metadata column comes back NULL for the reader and
-- the analytics routing query returns zero rows, because RLS default-denies.
CREATE POLICY meta_reader_sel ON gateway_metadata FOR SELECT TO llmgw_reader
  USING (EXISTS (SELECT 1 FROM requests r WHERE r.id = request_id
    AND (r.owner_principal = current_setting('app.principal', true)
         OR (r.owner_principal IS NULL
             AND current_setting('app.principal', true) = 'local'))));

CREATE POLICY meta_analytics_sel ON gateway_metadata FOR SELECT TO llmgw_analytics
  USING (true);
```

The affected joins are `cache-stats.ts:623` (reader), `lcr-priors.ts:405` and
`resources.ts:379` (analytics). **This gap was found by probing the executed
policy set further than my own assertions did**, which is the second time
executing has beaten reading on this design. Re-proved: with the two policies
added, a reader scoped to `alpha` gets its joined `route_reason` back instead of
`NULL`, and the analytics routing query returns all rows.

Observed results:

| Test                                         | Expected            | Observed                                                  |
| -------------------------------------------- | ------------------- | --------------------------------------------------------- |
| app inserts a row it owns                    | succeeds            | 1 row inserted                                            |
| app inserts a row owned by another principal | denied              | `new row violates row-level security policy`              |
| reader as `alpha`                            | own rows only       | sees `alpha` rows, legacy-null row hidden                 |
| reader as `beta`                             | nothing             | 0 rows                                                    |
| reader as `local`                            | legacy-null visible | legacy-null row returned                                  |
| **no principal set**                         | fail closed         | 0 rows                                                    |
| analytics aggregate                          | all rows, no bodies | all rows counted; `SELECT prompt` gives permission denied |

**A defect found by executing rather than reviewing.** The first run failed with
`permission denied for schema public` on a foreign-key check. Referential
integrity checks run with the referencing table's owner privileges, and the
grant block in 4.3 never gave `llmgw_owner` `USAGE ON SCHEMA public`, because it
only granted it to the four runtime roles. Foreign-key enforcement would have
broken at runtime. **`GRANT USAGE ON SCHEMA public TO llmgw_owner;` is
required** and is now part of 4.3. Neither three rounds of review nor my own
reading found this; running it did.

Four decisions revision 2 left open:

- **Owners bypass RLS.** `llmgw_owner` owns the tables, so any path running as
  the owner is unprotected. `FORCE ROW LEVEL SECURITY` must be set on
  `requests` and `gateway_metadata`, and no runtime path may connect as the
  owner.
- **Policy expressions run with the querying user's privileges**, so the
  `gateway_metadata` `EXISTS` predicate requires `llmgw_app` and `llmgw_reader`
  to hold `SELECT` on the referenced `requests` columns. That is already implied
  by their grants, but it must be stated or the policy fails at runtime rather
  than at deploy time.
- **The call must be transaction-local**: `set_config('app.principal', $1, true)`
  with the third argument `true`, parameterised, never string-interpolated,
  inside an explicit transaction on a single checked-out client, with guaranteed
  rollback and release. A pooled query without those guarantees leaks a
  principal into an unrelated later query, which is worse than the bug RLS fixes.
- **Background writers: the revision-3 premise was false and the decision is
  withdrawn.** Revision 3 claimed ACP and orphan completion have no caller
  context and therefore need a privileged global completion role. Verified
  otherwise:
  - HTTP ACP execution runs **inside** `runWithRequestContext`
    (`http-transport.ts:431`), so ACP completion does have ambient caller
    context.
  - Async jobs **already persist their owner**: `async-job-manager.ts:2493`
    resolves `ownerPrincipal` and stores it on the durable `jobs` row.

  So the principal is available in both cases. The orphan snapshot currently
  omits it, but it can carry it, because the durable row has it. Introducing a
  role able to modify rows it does not own would have weakened the very backstop
  RLS exists to provide, in exchange for solving a problem that does not exist.

  **Revised design:** completion writers set the principal from the job row
  rather than from ambient context, and run under `llmgw_app` with the ordinary
  owner-scoped policy. `FlightLogResult` (`flight-recorder.ts:62`) is widened to
  carry the owner, or the completion path reads it from the job. Only a genuinely
  ownerless completion, meaning one with no start row and no job row, needs the
  side-table path from `storage-unification.md` section 3.4, and that path writes
  to a quarantine table rather than to `requests`.

  This also removes the cross-document conflict revision 3 introduced: a
  `status = 'started'` fence would have denied the deliberate second completion
  that refreshes `response` with late child output
  (`async-job-manager.ts:2957`). An owner-scoped policy permits it; a
  status-fenced global role does not.

Positive and negative integration tests are required per row of that matrix; a
policy set that is merely deployed proves nothing.

The routing seam this depends on is defined in `storage-unification.md`
section 3.1.

### 4.5 Transport surfaces, and the limit on what RLS can buy

|                    | stdio                           | http                                                                        |
| ------------------ | ------------------------------- | --------------------------------------------------------------------------- |
| Front door         | OS process boundary, local user | OAuth, Entra front-door, Cloudflare tunnel                                  |
| Principal recorded | always `local`                  | `auth.clientId` under OAuth; `gateway-bearer` under the static bearer token |

Measured: two distinct principals across 3,278 jobs, `local` (3,153) and
`gateway-bearer` (125). Every http-side row arrived through the static bearer
path.

**Correction, twice over.** Revision 1 said a trusted upstream principal is used
"under OAuth", which is exactly inverted. Revision 2 then called the OAuth
interaction "undefined", which is also wrong: the code defines it.
`auth.ts:176` returns `undefined` for a trusted principal unless authentication
is static bearer, so under OAuth **the trusted-principal header is already
disabled and `auth.clientId` wins**. There is nothing undefined to resolve; the
migration simply inherits that behaviour.

Concretely: `resolveTrustedPrincipal` (`auth.ts:171`) returns `undefined` unless
`auth.kind === "gateway_bearer"`, so the trusted-principal header applies **only
to the static bearer path**. Under OAuth the principal is `auth.clientId`
(`http-transport.ts:395`), and the header is already inert.

#### Why stdio principals are not worth making granular

**Unenforceable.** All instances run as the same OS user, and `logs.db` and
`config.toml` are `0600` owned by that user. Any stdio agent can read the store
directly, read the DSN, or spawn its own gateway asserting any principal. A
database control cannot constrain a process holding the database file and its
credentials.

**It breaks continuity.** A principal derived from instance identity changes on
restart, losing read-back access to the agent's own transcripts. Continuity
across restarts is required. `local` is stable and satisfies it.

Conclusion: leave stdio at `local`. Real local isolation needs distinct OS users
or containers.

#### Where granularity pays

The http surface, where the caller is remote and `auth.clientId` is stable
across restarts. The action is to move off the static bearer token so each
client carries its own principal. The trusted-principal header needs no separate
decision: `auth.ts:176` already disables it outside the static-bearer path, so
moving to OAuth retires it automatically.

### 4.6 The boundary this design draws

On a single-user host, **the OS user account is the boundary for the state this
design touches**: `config.toml` and `logs.db` are `0600` under `werner`, so the
DSN and the transcript file are available to any process running as that user.
That is a verified statement about files and credentials, not a universal claim
about host security, and revision 2 phrased it as the latter.

**Correction: distinguish what is verified from what is assumed.** Revision 1
asserted flatly that any same-user process can fetch the KEK, and used that to
dismiss envelope encryption against threat 1. The first half is verified for
today's DSN and file access. The KEK half is **not** verified, because there is
no vault authentication design yet. A service-bound broker, cgroup-bound
identity, or hardware-backed credential could make KEK retrieval unavailable to
a sibling process. Four distinct boundaries must be tracked separately:

1. current same-UID access to files and DSN: **verified, no boundary exists**
2. remote OAuth and RLS isolation: **a real boundary**
3. root and kernel boundaries: out of scope here
4. future KEK-retrieval boundary: **UNASSESSABLE until the vault design exists**

What this design protects: remote http callers; **accidental** cross-role access
and theft of any single credential; future topologies; and, **for the three
encrypted transcript columns only**, the Postgres host, its dumps and its disks.

**Correction (revision 3 overstated the blast-radius benefit).** Role separation
does not bound a compromised gateway process. That process holds every runtime
credential and, once encryption exists, the KEK as well. What role separation
buys is protection against an accidental over-privileged query and against the
theft of one credential in isolation, not containment of arbitrary code
execution inside the gateway.

**Correction (revision 2 re-broadened here).** Having narrowed the encryption
claim in 4.2 to three columns, revision 2 then restated dump and disk protection
without that limit. A `pg_dump` still yields plaintext `jobs.args_json`,
`jobs.payload_json`, `jobs.stdout`, `jobs.stderr`, `validation_runs.request_json`
and `validation_receipts.report_json`. LUKS covers those at rest on disk;
nothing in this design covers them in a dump.

What it does not protect today: one local process from another under the same
OS user.

## 5. Control parity ledger

| Control today                               | Mechanism                                             | Replacement                          | Verdict                     |
| ------------------------------------------- | ----------------------------------------------------- | ------------------------------------ | --------------------------- |
| Store is owner-only                         | `chmodSync(dbPath, 0o600)` (`flight-recorder.ts:560`) | peer or cert auth, role grants, LUKS | parity, different mechanism |
| Reads cannot write                          | `openReadOnly`, `SQLITE_READONLY` (`:776`)            | `llmgw_reader` holds no write grant  | parity                      |
| No cross-principal read                     | fetch-then-filter (`index.ts:21884`)                  | RLS backstop, app check retained     | improvement, subject to 4.4 |
| Secrets stripped pre-write                  | `redactSecrets`                                       | unchanged                            | parity                      |
| Bodies readable via dump/disk/DB compromise | none                                                  | envelope encryption of 3 columns     | improvement, scope-limited  |
| Bodies readable by same-user local process  | true today                                            | still true, see 4.6                  | unchanged                   |
| Corruption detection                        | none (`data_checksums = off`)                         | checksums on                         | improvement                 |

## 6. Sequencing

0. **Back up `logs.db`.** Done: `/srv/data/backups/llm-cli-gateway/`,
   `VACUUM INTO` snapshot, `integrity_check` ok both sides, 34,373 rows.
   Currently plaintext on an unencrypted filesystem; see 4.2.
1. **Fix `pg_hba.conf`.** Done 2026-08-12, see 2.1.
2. **Derive and persist the LCR inputs** (4.2), removing the bulk prompt reader.
   Prerequisite for encryption.
3. **An authenticated, confidential channel** (4.1): either the unix-socket plus
   `peer` branch, or the TLS plus client-certificate branch with
   `sslmode=verify-full` and a pinned CA. The address rule must be verified by a
   real `inet_client_addr()` measurement before any reject rule is armed.
4. Role separation, generated grants, revocations with `CONNECT`/`USAGE`
   restored (4.3).
5. LUKS volume move, backup placement, and `data_checksums`.
6. RLS with complete write policies, legacy-null policy, metadata policy, and
   transactional principal propagation (4.4).
7. Envelope encryption of the three transcript columns.
8. http principal granularity (4.5).
9. Only then: transcripts into Postgres, per `storage-unification.md`.

## 7. Residual risks

- **`llmgw_app` sees plaintext bodies in process.** Unavoidable; it writes them.
- **KEK availability becomes a dependency.** If the vault is unreachable the
  recorder must fail closed or stop recording, never record plaintext. Decide
  explicitly.
- **Client certificates are still on-disk credentials.** Reduced, not
  eliminated; see 4.1.
- **`listen_addresses = *`** is mitigated only by the podman port binding.
- **Row counts in this document are snapshots** and drift on a live system.
