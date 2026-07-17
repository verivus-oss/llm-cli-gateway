# Personal Agent Config Kit

Personal Agent Config Kit gives one developer a Git-synchronised instruction and preference baseline across multiple workstations and repositories. It is deliberately a personal configuration layer, not an organisation or multi-tenant policy service.

The default gateway compiles three instruction layers, applied in order:

1. A verified release from the developer's private `~/.agent-config` Git repository.
2. A repository overlay at `.agents/gateway/config.toml`.
3. Bounded request instructions supplied as `requestInstructions`.

The compiler also supports an optional immutable gateway-bundled layer for a future gateway-owned deployment policy, but the default runtime does not supply one. Every active instruction layer and the canonical selected working folder are compiled into an immutable context stamp. Machine-local binding data at `~/.llm-cli-gateway/local.toml` is never committed or synchronised. A matching provider session is only resumed when its release, repository scope, repository revision, selected folder, context stamp, owner, and workstation binding all match.

## Enable it

Add this to the gateway configuration on each workstation:

```toml
[personal_config]
enabled = true
baseline_path = "~/.agent-config"
max_stale_hours = 168
```

`baseline_path` must resolve to a non-home, non-symlinked descendant of the
current user's home directory. The gateway rejects relative paths, `/`, `~`,
`..` traversal, and existing symbolic-link components before it can recursively
harden baseline permissions. Omit the setting to use `~/.agent-config`.

Use a private Git remote for the baseline. `config_init` accepts HTTPS without userinfo, an SSH URL with an optional username but no password, or standard `user@host:path` SSH notation. Plaintext `git://`, local paths, helper transports, HTTPS credentials, SSH passwords, query or fragment components, and dash-leading hosts are rejected. Use your normal Git credential helper or SSH agent. The baseline must be a clean named branch with an `origin` remote before it can be published or synced.

```text
config_init(remote: "git@github.com:you/agent-config.git")
config_sync()
```

For a new local repository, run `config_init()`, add a remote and an initial commit with normal Git tooling, then use `config_publish()` and `config_sync()`.

`config_publish()` and `config_sync()` revalidate every effective configured `origin` fetch and push URL before network use, including an origin added after `config_init()` created a local baseline. Every URL must remain a supported non-credential HTTPS or SSH form, with no query or fragment and a host that does not begin with `-`.

Run `config_sync()` on every workstation after publishing a new baseline. It fetches only, fast-forwards only, verifies the committed tree, creates an immutable local release, and then switches the active pointer atomically. A failed fetch never refreshes the successful-sync timestamp or changes the active release.

### PostgreSQL upgrade prerequisite

If `[persistence].backend = "postgres"`, stop every gateway instance and run the schema migrations with the database migration role before enabling the Kit:

```bash
DATABASE_URL='postgresql://…' npm run migrate
```

Migrations `006_personal_config_kit_sessions` through `017_async_job_mcp_artifact_scope` create the scoped session pointers, durable job schema, permanent single-use attempt fences, privacy boundary, restart-safe async compression state, opaque historical Kit request keys, native-handle retirement, and durable request-artifact recovery state. They protect active attempts from ordinary retention cleanup. Migration 011 scrubs raw Kit job arguments, payloads, output, and errors from pre-upgrade rows, including queued and running jobs that already captured provider error text; migration 013 replaces historical deterministic Kit request keys with opaque job-id keys; migration 014 retires durable provider-native handles; migrations 015 through 017 retain enough origin-host, exact-artifact, and scope provenance for safe origin-host-only cleanup in a cross-workstation deployment. A different workstation fails closed rather than deleting an artifact owned by another host. Once they are applied, the normal gateway runtime only verifies the schema and can use a DML-only database role.

## Baseline and repository files

The baseline can contain `instructions.md` (or `global.md`) and optional preferences:

```toml
# preferences.toml
[preferences]
model_default = "gpt-5.4"
output_format_default = "json"
max_turns_cap = 12
max_budget_usd_cap = 5
codex_sandbox_mode = "workspace-write" # or "read-only"
```

The baseline can also use `config.toml` for `instructions` (or `[context].instructions`) and `[preferences]`. If `instructions.md` or `global.md` exists, it takes precedence over the instruction field in `config.toml`. `preferences.toml` accepts either the preference keys directly or a `[preferences]` table; its values are then combined with the baseline `config.toml` preferences.

A repository can add an intentionally narrow overlay:

```toml
# .agents/gateway/config.toml
instructions = "Follow this repository's contribution and test conventions."

[preferences]
max_turns_cap = 8
codex_sandbox_mode = "read-only"
```

An overlay may choose its own model or output-format default. Its turn and budget caps can only reduce the effective personal caps, and its Codex sandbox posture can only stay the same or tighten. `output_format_default` is an effective personal-or-repository cross-provider response preference, limited to `text` or `json`. Claude uses `stream-json` when this preference is absent. For Codex, the Kit default is `workspace-write`; a personal or repository preference may tighten it to `read-only`, and `danger-full-access` is rejected. The effective context is limited in size, carries source provenance internally, and is never written into durable job or session records.

Preference tables are closed schemas. Unknown keys, malformed values, and model identifiers containing whitespace or control characters reject the release or overlay rather than silently falling back to a less restrictive default.

The repository overlay and `requestInstructions` are deliberate Kit inputs. They are suitable only for repositories and local callers the developer trusts. They are not an untrusted-content sandbox. The gateway reads an overlay only when it can verify the opened descriptor still resolves within the selected scope root, using `/proc/self/fd` on Linux and `/dev/fd` where supported. If that proof is unavailable, the overlay is rejected rather than read through a pathname fallback. A parent-directory symlink replacement during the open is therefore rejected instead of read.

## Local caller and repository scope

Kit provider execution and `explain_effective_config` are local-gateway operations. HTTP and OAuth callers, including callers that reach a local HTTP listener, are refused so the gateway does not expose personal instruction-derived state through its remote surface. Git synchronization still works across workstations: run the local gateway and `config_sync()` on each workstation.

Scope selection is provider and operation specific. `explain_effective_config` accepts an explicit absolute `workingDir` for read-only inspection, and a Codex Kit request can use an absolute `workingDir` to select its canonical folder. A Claude Kit request deliberately rejects caller-supplied `workingDir`, so an untrusted path cannot make Claude execute outside the compiled Kit context. A Claude Kit request must select an already configured registered `workspace` alias or use the configured default workspace. A Codex Kit request must supply an absolute `workingDir`, select a registered `workspace`, or use the configured default. Neither provider uses the gateway process cwd for Kit scope discovery. Relative `workingDir` values are rejected before any filesystem or Git inspection. An unscoped request fails before the gateway reads a repository overlay or starts a provider. When a registered workspace contains the selected folder, its root is the Kit scope; otherwise the Git top-level is the scope. The gateway reads one overlay only, `.agents/gateway/config.toml` at that scope root, so it does not merge overlays from ancestor folders. `requestInstructions` is limited to 16 KiB and the compiled context to 64 KiB. Use `explain_effective_config` before an important run to check the selected scope, release, provenance, and effective preferences without exposing instruction text.

## Provider and session behavior

Kit mode currently supports `claude_request`, `claude_request_async`, `codex_request`, and `codex_request_async`. Provider requests for other models fail closed instead of silently running without the configured context. Cross-model validation tools and `route_request` / `route_request_async` are intentionally not registered in Kit mode, even when `[least_cost].enabled = true`, because they could select providers outside the Kit's compiled-context and provider-isolation boundary.

Every Kit turn is admitted as a durable job. If `SYNC_DEADLINE_MS=0`, the synchronous Kit request tools reject before claiming a session attempt, because direct in-process execution would not survive or safely fence a restart. Use `claude_request_async` or `codex_request_async` in that configuration. The async Kit tools continue to work when the durable SQLite or PostgreSQL admission checks are healthy. The manager and durable stores reject any Kit admission that carries MCP artifact provenance, rather than dropping that provenance.

The Kit owns its compiled provider instruction context and a small set of forced provider controls. Calls that try to override provider instructions, settings, tool or MCP inputs, permission-bypass controls, raw provider session aliases, or related high-impact flags are rejected. For Claude, this includes `workingDir`, `effort`, and `name`, which would otherwise alter its execution context or become `--effort` and `--name` provider arguments. Claude's public `outputFormat` field is accepted because its normal schema supplies a default, but Kit ignores it and resolves the format from the verified baseline. The current baseline format does not define synced provider MCP or tool configurations; it prevents caller overrides rather than importing those controls from the baseline. `prompt`, bounded `requestInstructions`, model selection, and capped turn or budget inputs remain available as documented by the request tools.

For Claude, Kit forces safe mode, uses a gateway-owned prompt artifact, and enables `--bare` so local configuration and keychain discovery cannot add an instruction or credential layer. Claude Code OAuth and keychain authentication are intentionally unavailable in this mode. Claude Kit calls therefore require `ANTHROPIC_API_KEY` in the gateway process environment; a normal `claude auth status` result is not a readiness check for a Kit request. For Codex, Kit forces user-config and rules exclusion; disables apps, plugins, hooks, multi-agent execution, memories, and web search; disables project prompt discovery; makes the selected canonical folder the only project root and marks it untrusted; and removes inherited `CODEX_*`, endpoint, and proxy redirects before launch. Before each actual Codex Kit turn, the gateway asynchronously probes the installed CLI, disables every discovered skill path, and verifies that skills and apps no longer appear in the model-visible prompt. Both probe passes must expose at least one developer-message surface, so an unrecognized debug-output format fails closed rather than being interpreted as an empty capability list. The probe output is never logged or persisted.

That Codex preflight is a verified-at-probe-time control for a single developer's non-adversarial local filesystem. A concurrent process that modifies a discovered skill after the probe and before provider startup is outside its guarantee. It is not an operating-system security boundary and does not override provider built-ins or administrator-managed policy. Keep the installed provider binary and host administrator policy trusted. Where the CLI permits it, the Kit disables discovered skills regardless of user, repository, system, or plugin origin; an administrator can still enforce managed requirements outside this personal configuration surface.

On a successful first Claude run, the gateway supplies a fresh UUID to Claude and may resume by explicit native session ID while that gateway process remains alive. Codex may do the same only when its structured output provides a verified native session ID. The gateway never uses a provider's process-global "latest session" selector in Kit mode. A gateway restart intentionally retires every Kit native continuation and requires a fresh native conversation.

Native handles are local provider state. A second workstation gets the same verified baseline and repository instructions after `config_sync()`, but it starts its own native conversation. This prevents two workstations working in the same repository from accidentally resuming or overwriting each other's provider state. Sibling working folders also have distinct Kit execution identities, so their Codex project-root controls and native handles cannot be crossed.

Async terminal state is durable. A Kit job never writes its compiled context, request arguments, provider stdout, stderr, provider error, provider session handle, or a request-key fingerprint derived from those inputs to the job store, session store, or flight recorder. To fence unsafe continuation, it retains a `KitExecutionRef`: `releaseId`, `configStamp`, `scopeRoot`, `scopeHead`, and `contextIdentity`. `contextIdentity` is an unkeyed SHA-256 digest of the complete effective context, and `configStamp` incorporates it. These fields are integrity metadata, not instruction text, request arguments, or a request deduplication key, but database backups must be protected because someone able to guess low-entropy inputs can confirm them against the digest. Flight Recorder start and completion rows use fixed withheld markers rather than retaining the caller task or provider reply. At terminal completion, the gateway extracts a validated UUID native continuation handle only into current-process memory. The live caller can read its in-memory reply and the same running gateway can continue that conversation; after a gateway restart, `llm_job_result` returns an explicit withheld marker and reconciliation releases the completed attempt without restoring a provider handle. Migration 014 retires legacy handles from PostgreSQL job and session records; SQLite performs the equivalent repair when its job and file-session stores open. Migration 011 removes raw material from earlier Kit job rows and migration 013 replaces historical Kit request keys with opaque job-id keys. Neither privacy repair rewrites historical Flight Recorder rows in the configured Flight Recorder database (normally `logs.db`), because those rows have no trustworthy Kit marker. If this workstation used an earlier Kit build, let durable jobs settle and stop every gateway process before rotating or deleting every copy of the complete configured SQLite Flight Recorder database set: `<configured-db>`, `<configured-db>-wal`, and `<configured-db>-shm`, including retained backups and replicas under the normal retention process. The default SQLite persistence path is shared by the job store and Flight Recorder. Do not retain or copy the old database to preserve jobs, because that also retains the legacy Flight Recorder rows. Let jobs settle where possible, or migrate only required durable job or session state into a clean store before deleting every old database, sidecar, backup, and replica copy. This operation intentionally discards historical diagnostic rows and must not be attempted by selectively editing individual SQLite rows.

### Kit context artifacts and non-Kit Claude MCP request configs

These are separate artifact classes with different retention and recovery contracts. Do not use one class's procedure for the other.

#### Kit Claude context artifact

For a Claude Kit turn, the gateway writes the compiled private context to a gateway-owned prompt artifact and passes it through the Kit-owned `--append-system-prompt-file` control. Before it creates that artifact or allocates or claims a durable Kit session, the gateway admits a pure projection of the complete eventual Claude argv, including verified Kit preferences, fixed safe/bare controls, caller model and prompt, native continuity, and an exact-width artifact path. A rejected individual or aggregate argv input therefore leaves no artifact, Kit session, attempt claim, or job. This is not an MCP configuration. Its adjacent owner record contains only the gateway job ID and the artifact basename. The durable job does not store this file's path or an MCP artifact scope.

Normal request completion removes the Kit context artifact. If a process stops before that cleanup, maintenance reaps a bound artifact immediately only after its owner is terminal. An unbound artifact, or a bound artifact whose owner is positively absent from a healthy store, remains for the normal 24-hour grace period before reaping. An unavailable store, an active or orphaned owner, or a malformed owner record is ambiguous and leaves the artifact in place. This Kit lifecycle does not use origin-host path validation or a durable cleanup acknowledgement.

#### Non-Kit Claude MCP request configuration

When a non-Kit Claude request needs a gateway-generated `--mcp-config`, its request-scoped `config.json` is a separate artifact. Kit mode rejects caller-supplied MCP configuration, so it never repurposes its prompt artifact as this config. On durable async admission, the job row records the exact generated path, the scope captured when that config was created, its owner instance and hostname, and a pending-cleanup flag. After the child exits, only the origin host may prove the exact regular file is still in that captured scope, remove it, and compare-and-set the matching durable acknowledgement. Retention cannot evict a row while that acknowledgement is pending. A path in a durable row is recovery input, never authority to delete another path.

If the recorded origin host has been retired, renamed, or reinstalled with a different hostname, no other host can acknowledge the pin or clean the artifact. The row remains retention-pinned indefinitely, even when its path and scope are present, because a new hostname cannot satisfy the host proof. This is an accepted fail-closed limitation. Monitor pending cleanup pins as part of durable-store capacity planning; do not clear a pin or fabricate hostname or scope with SQL. A supported recovery workflow on the recorded origin host is required before the row can be released safely.

On Linux with a usable `/proc/self/fd`, non-Kit Claude MCP cleanup pins each request's private `0700` directory with non-symlink directory descriptors before unlinking the exact config. This prevents a concurrent replacement of the visible artifact root or request-directory pathname from redirecting cleanup to the replacement. On other platforms, cleanup validates every directory component and scope marker read-only before a pathname unlink, and never creates or repairs a missing component during cleanup. Both paths rely on the same operating-system boundary: this is not a security boundary against a hostile process that shares the gateway UID and can write inside that `0700` directory, because it can still replace the final filename between validation and unlink. Run the gateway under an account not shared with untrusted processes. Automatic cleanup retains and never acknowledges a missing, unreadable, symlinked, or scope-mismatched config. The explicit same-host recovery workflow below is the only absent-config exception, and it requires a separate scope proof. After config removal, the private request directory and its non-secret scope marker are intentionally retained because portable Node cannot identity-bind a safe directory removal. Prune them only after every gateway is stopped and no active or retention-pinned request artifact remains.

### Legacy artifact provenance

Migration 017, plus the matching SQLite and PostgreSQL job-store startup repair, make one narrow automatic repair for pre-015 rows: they backfill `owner_hostname` only by joining a null job value to its still-present matching `gateway_instances` row with a non-empty hostname. They never guess a hostname or scope. A null hostname after that repair is intentionally unknown, not a request to infer one from a shared hostname. A legacy pending row with an unknown origin remains retention-pinned indefinitely. This automatic, evidence-bound backfill is not an operator repair surface. Do not use SQL to add, alter, or infer hostname or scope provenance; clear the pending cleanup pin; acknowledge cleanup; or delete a path.

The supported local recovery workflow below applies only to a row that already has an exact generated path, captured scope, and owner hostname equal to the current host. It cannot repair missing provenance. A row whose origin host was retired, renamed, or reinstalled likewise remains retention-pinned, because no other host can satisfy the durable host proof.

### Same-host MCP cleanup-pin recovery

Use this local maintenance command only for a **non-Kit Claude MCP request configuration** whose pending pin already has an exact generated path, captured scope, and owner hostname. It is not a way to repair a legacy row with missing provenance, and it never accepts a caller-provided path, hostname, scope, or force override.

1. On the recorded origin host, confirm the exact durable job and artifact identity, then stop every gateway process and provider child that could still use the request config. Do not manually delete or recreate artifact directories, follow a symlink, or alter the durable row to make the check pass. If any identity or proof is uncertain, leave normal lifecycle cleanup in place.
2. Run the local gateway CLI with the exact durable job ID and its explicit acknowledgement:

   ```bash
   llm-cli-gateway mcp-artifact recover <job-id> --acknowledge-local-mcp-artifact-proof
   ```

3. Let the command perform the proof and compare-and-set acknowledgement. It reloads the configured durable store and requires a terminal Claude process job, a pending pin, a hostname equal to the current host, and the recorded path and scope. It removes only the exact verified generated config when it is still present. When the config is already absent, it requires a separate platform-matched, read-only scope proof before acknowledging it: descriptor-pinned on Linux with usable `/proc/self/fd`, otherwise strict pathname and scope validation.
4. Restart normal gateway processes only after the command reports success. A missing row, active or non-Claude job, different host, absent scope, changed path, symlink, replacement directory, failed proof, or failed compare-and-set leaves the pin unchanged. Investigate those conditions rather than retrying with SQL or a broader filesystem cleanup.

Do not clear `mcp_artifact_cleanup_pending`, delete the job row, or fabricate scope or hostname values with manual SQL. The command's final acknowledgement is the existing exact-row compare-and-set over job ID, owner hostname, scope, path, pending state, and terminal state; it grants no authority to clean any other artifact.

An attempt retained as "not durably admitted" is deliberately not retried automatically. A gateway can be paused after it has claimed the session lease but before it writes the durable job row. Releasing that lease based only on expiry or a missing row could create two native provider turns when the paused gateway resumes.

### Configuration-management lock recovery

The local Kit configuration operations (`config_init`, `config_publish`, `config_sync`, `config_rollback`, and `config_ack_stale`) serialize on the local configuration lock, normally `~/.llm-cli-gateway/personal-config/lock`. A `kit_busy` result from one of those operations is separate from an unadmitted provider attempt and is **not** a reason to call `config_recover_kit_attempt`.

On a retry, the gateway automatically reclaims only a well-formed lock whose hostname equals the current host and whose recorded PID is provably absent. It moves the candidate to a private quarantine and rechecks its token before deletion, so a racing replacement at the authoritative lock path is not removed. It never age-breaks a lock. A live local PID, a foreign hostname, a malformed owner record, an unavailable liveness proof, or an ambiguous replacement remains busy and is not removed.

Do not delete, overwrite, or recreate this lock, and do not edit Kit state or durable rows to bypass it. First identify and stop the actual local configuration operation if one is still running. If the recorded same-host PID is confirmed gone, rerun the same configuration operation and let the gateway perform its token-checked recovery. If that proof cannot be made, retain the lock and investigate the workstation before attempting another Kit operation.

`config_recover_kit_attempt` has a narrower, different purpose: it permanently fences one exact locally observed unadmitted durable provider attempt before releasing that attempt's session lease. It neither clears nor authorizes clearing a configuration-management lock.

## Operating safely

- Keep the baseline remote private and do not put `.env`, credentials, secrets, or tokens in it. Release validation rejects those path names, symbolic links, non-regular files, oversized files, oversized trees, and a caller-supplied `manifest.json`.
- `config_status()` and `explain_effective_config()` expose release and provenance metadata but not baseline paths, local machine details, or instruction text.
- `config_init`, `config_publish`, `config_sync`, `config_rollback`, and `config_ack_stale` are local-only operations. A remote gateway caller cannot alter another workstation's baseline state.
- `config_recover_kit_attempt` is a local-only, destructive last-resort action for an exact durable attempt that has no job row. First stop every previous gateway process that could still own the attempt. Then use local `session_get` to copy the gateway session ID, `metadata.kit.execution`, and `metadata.kit.attempt.id`; call the recovery tool with those exact values and its required acknowledgement. The tool requires a healthy durable store, rejects an existing or unverifiable job, atomically writes a permanent fence for that attempt ID, and only then releases the exact matching lease. A fence conflict, identity mismatch, or storage failure leaves the lease retained. Do not use it for terminal, orphaned, or legacy non-durable attempts.
- Verified releases are retained locally until an explicit safe maintenance workflow is introduced. This prevents an in-flight or crash-recovered Kit attempt from losing the immutable release it was compiled from. `config_rollback(releaseId)` can activate only a locally verified retained release.
- Attempt fences are deliberately permanent, single-use records. They prevent a paused pre-admission gateway from launching an old provider turn after manual recovery. Each Kit attempt receives a new UUID, so automatic fence pruning would weaken the recovery guarantee. Monitor durable-store growth as part of normal database retention and capacity planning.
- When a baseline becomes stale, execution fails closed. `config_ack_stale()` grants one release-bound acknowledgement for at most 24 hours. Its consumed-release record survives rollback cycles, and a successful sync is required before that release can be acknowledged again. A legacy state without complete acknowledgement history also requires a successful sync before it can issue an acknowledgement.

Use `explain_effective_config` before a consequential run when you need to confirm the selected workspace, release ID, stamp, and provenance without exposing the instructions themselves.
