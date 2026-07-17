---
name: personal-agent-config-kit
description: Synchronize a single developer's verified agent instructions and bounded preferences across local workstations and repositories. Use when setting up, publishing, syncing, inspecting, rolling back, or recovering Personal Agent Config Kit state.
---

# Personal Agent Config Kit

Use the Kit for one developer who wants the same personal agent baseline on
multiple workstations and repositories. It is a local, Git-synchronized personal
configuration layer, not an organization, team, tenancy, or remote policy
service.

Read [the Kit guide](../../../docs/guides/PERSONAL_AGENT_CONFIG_KIT.md) before
changing the baseline or recovering an interrupted attempt.

## Enable and bootstrap

Configure each workstation's local gateway:

```toml
[personal_config]
enabled = true
baseline_path = "~/.agent-config"
max_stale_hours = 168
```

`baseline_path` must resolve to a non-home, non-symlinked descendant of the
current user's home directory. Relative paths, `/`, `~`, `..` traversal, and
existing symbolic-link components are rejected before permission hardening.

Use a private Git remote. `config_init` accepts an HTTPS URL without userinfo,
authenticated through the normal Git credential helper, an SSH URL without a
password authenticated through the normal SSH agent, or standard SSH shorthand.
It rejects local paths, plaintext `git://`, helper transports, URL credentials,
query or fragment components, and dash-leading hosts.

```text
config_init({remote:"git@github.com:you/agent-config.git"})
```

For a new baseline, initialize it, use ordinary Git tooling to add a remote and
first commit, then publish. Do not put secrets, tokens, `.env` files, or machine
binding data in the baseline.

## Synchronization workflow

1. Edit and commit the personal baseline with normal Git tooling.
2. Call `config_publish()` from the local gateway. It requires a clean named
   branch and never force-pushes.
3. On every workstation, call `config_sync()`. It fetches, fast-forwards only,
   verifies the committed tree, creates an immutable local release, then changes
   the active pointer atomically.
4. Call `config_status()` to inspect freshness, the active release ID, and the
   last sync error without exposing baseline paths or binding values.
5. Before consequential work, call `explain_effective_config` with the intended
   absolute `workingDir` or registered `workspace`. This is read-only scope
   inspection: it reports release, scope, provenance, and effective preferences,
   never instruction text or local paths.

A failed sync does not advance the successful-sync timestamp or replace the
active release. If an active release is stale, execution fails closed.
`config_ack_stale()` is a local emergency acknowledgement for the current
release only, lasting at most 24 hours. Its consumed-release record survives a
rollback cycle. It is not a substitute for a successful sync and cannot be
used repeatedly for that release. A legacy state without complete acknowledgement
history also requires a successful sync before it can issue an acknowledgement.

`config_publish()` and `config_sync()` revalidate every effective configured
`origin` fetch and push URL before network use, including an origin added after
a local `config_init()`. Every URL must remain a supported non-credential HTTPS
or SSH form, with no query or fragment and a host that does not begin with `-`.

## Effective configuration and repository scope

The normal effective context is compiled in this order:

1. Verified personal baseline release (`instructions.md` or `global.md`, with
   optional `config.toml` and `preferences.toml`).
2. Exactly one repository overlay at `.agents/gateway/config.toml` at the
   selected scope root.
3. Bounded `requestInstructions` supplied by the local caller.

Scope selection depends on the operation and provider. `explain_effective_config`
accepts an absolute `workingDir` for read-only inspection, and Codex Kit requests
can use it to select their canonical folder. Claude Kit requests reject caller-supplied
`workingDir`, because the Kit owns Claude's execution context. A Claude Kit
request must select an already configured registered `workspace` alias or use
the configured default workspace. A Codex Kit request must supply an absolute
`workingDir`, select a registered `workspace`, or use the configured default.
Neither provider uses the gateway process cwd for Kit scope discovery. Relative
`workingDir` values are rejected before filesystem or Git inspection. Unscoped
requests fail before an overlay is read or a provider starts. A registered workspace root is
the scope when it contains the selected folder; otherwise the Git top level is
the scope. Ancestor overlays are not merged.

Repository preferences may specialize model or output defaults, but may only
tighten personal turn/budget caps and Codex sandbox posture. The default Codex
Kit sandbox is `workspace-write`; a personal or repository layer may tighten it
to `read-only`, and `danger-full-access` is rejected. Treat the repository
overlay and `requestInstructions` as trusted local inputs, not as an untrusted
content sandbox. The gateway reads an overlay only when it can verify that the
opened descriptor still resolves under the selected scope root, using
`/proc/self/fd` on Linux and `/dev/fd` where supported. If that proof is
unavailable, the overlay is rejected rather than read through a pathname
fallback. An out-of-root parent-directory symlink replacement is rejected.

For a mandatory exhaustive review, inspect the effective preferences first. If
they impose a turn or budget cap, the review is constrained and cannot be
reported as unconditional or complete under the no-limit review contract. Use
an approved uncapped review profile or obtain explicit user direction before
claiming a final review verdict. This does not remove normal Kit caps for
ordinary non-review work.

## Execution boundary

Kit execution and `explain_effective_config` are local-gateway operations. HTTP
and OAuth callers, including a local HTTP listener, are refused. Syncing works
across workstations because each workstation runs its own local gateway and
calls `config_sync()`.

The Kit currently supports only:

| Provider | Sync             | Async                  |
| -------- | ---------------- | ---------------------- |
| Claude   | `claude_request` | `claude_request_async` |
| Codex    | `codex_request`  | `codex_request_async`  |

Gemini, Grok, Mistral, Devin, Cursor, API-provider requests, native ACP, and
cross-model validation fail closed in Kit mode. Validation tools and least-cost
routing (`route_request` and `route_request_async`) are intentionally not
registered, even when `[least_cost].enabled = true`. Do not describe a
Claude/Codex Kit run as a full multi-provider review. Disable Kit for a normal
cross-provider review only when the user explicitly chooses that different
security boundary.

Every Kit turn requires healthy durable SQLite or PostgreSQL admission. Memory
and `none` persistence do not satisfy this requirement. With
`SYNC_DEADLINE_MS=0`, synchronous Kit requests reject; use the corresponding
async tool instead. A terminal Kit job retains privacy-safe state, but does not
persist compiled instructions, request arguments, provider output/error, or a
provider-native session handle.

Claude admits a pure projection of its complete eventual argv before creating
the compiled context artifact or allocating or claiming a Kit session. An
`input_too_large` rejection, including a multibyte prompt or aggregate argv
overflow, therefore creates no artifact, session, attempt claim, or job.

The Kit owns provider instruction/configuration and rejects caller overrides for
MCP, tools, permission bypasses, raw provider-session aliases, and other
high-impact controls. Claude uses a Kit-owned prompt artifact and safe, bare
execution. Codex is launched with the Kit's isolated configuration and verified
skill/app exclusions. These controls are designed for a trusted single
developer's local filesystem, not a hostile-process operating-system boundary.

## Sessions, recovery, and rollback

Native provider continuity is scoped to the same workstation, process, release,
repository scope/revision, selected folder, context stamp, and owner. A gateway
restart retires the native handle; a different workstation always begins a new
provider conversation even after it syncs the same release.

Use `config_rollback({releaseId})` only to atomically activate a locally
retained, already verified release. Do not manually edit Kit state, durable job
rows, session rows, release pointers, or artifact files.

`config_recover_kit_attempt` is a destructive, local-only last resort for one
exact unadmitted durable attempt. Use it only after every previous gateway
process that might own the attempt has stopped. Copy the exact `sessionId`,
`metadata.kit.execution`, and `metadata.kit.attempt.id` from local
`session_get`, provide the required acknowledgement, and let the tool write its
permanent fence before it releases the lease. It cannot recover an existing
durable job and must not be used for terminal, orphaned, or legacy non-durable
attempts.

## Configuration-management lock recovery

`config_init`, `config_publish`, `config_sync`, `config_rollback`, and
`config_ack_stale` serialize on the local configuration lock, normally
`~/.llm-cli-gateway/personal-config/lock`. A `kit_busy` response from one of
those operations is separate from an unadmitted provider attempt. Do not use
`config_recover_kit_attempt` to clear it.

On retry, the gateway reclaims only a well-formed same-host lock whose recorded
PID is provably absent. It quarantines the candidate and rechecks its token
before deletion, so a racing replacement at the authoritative lock path is not
removed. It never age-breaks a lock. A live local PID, foreign hostname,
malformed owner record, unavailable liveness proof, or ambiguous replacement
remains busy and is not removed. Do not delete, overwrite, or
recreate the lock or edit Kit state or durable rows to bypass it. Stop the actual
local configuration operation first. When its same-host PID is confirmed gone,
rerun the same configuration operation and let token-checked recovery proceed;
otherwise retain the lock and investigate the workstation.

`config_recover_kit_attempt` instead permanently fences one exact locally
observed unadmitted durable provider attempt before releasing that attempt's
session lease. It neither clears nor authorizes clearing a configuration lock.

## Verification checklist

- `config_status()` reports Kit enabled, a verified active release, and no
  unresolved stale/error state.
- `explain_effective_config({workingDir:"<absolute-target>"})` shows the intended
  scope, release, provenance, and safe effective preferences. This does not
  authorize passing `workingDir` to a Claude Kit request.
- The local durable store is SQLite or PostgreSQL and its admission health is
  good.
- A provider request uses only Claude or Codex and does not supply rejected
  provider/MCP/tool/session override fields. In particular, a Claude Kit
  request does not supply `workingDir`.
- A workstation that needs an updated baseline completed `config_sync()` after
  the publisher's successful `config_publish()`.
