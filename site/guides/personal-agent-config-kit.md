# Personal Agent Config Kit

Personal Agent Config Kit gives one developer a private, Git-synchronised
instruction and preference baseline for several workstations and repositories.
It is an opt-in personal configuration layer, not an organisation, team, or
multi-tenant policy service.

## What it compiles

For each supported request, the gateway compiles these layers in order:

1. A verified release from the developer's private Git baseline.
2. One repository overlay at `.agents/gateway/config.toml`.
3. Bounded request instructions.

The result is bound to the selected repository scope, revision, release, and
workstation context. Repository overlays do not merge up the directory tree, and
machine-local binding data never enters the Git baseline. Syncing to another
workstation gives it the verified baseline and repository overlay, not a shared
native provider conversation.

The gateway reads a repository overlay only when it can verify that the opened
descriptor still resolves under its selected scope root, using `/proc/self/fd`
on Linux and `/dev/fd` where supported. If that proof is unavailable, the
overlay is rejected rather than read through a pathname fallback. A
parent-directory symlink replacement during the open is rejected instead of
read.

Scope selection is provider specific. `explain_effective_config` accepts an
absolute `workingDir` for read-only inspection, and a Codex Kit request can use
it to select its canonical folder. A Claude Kit request deliberately rejects a
caller-supplied `workingDir`; select its target with an already configured
registered `workspace` alias or the configured default workspace. A Codex Kit
request must supply an absolute `workingDir`, select a registered `workspace`,
or use the configured default. Neither provider uses the gateway process cwd
for Kit scope discovery. Relative `workingDir` values are rejected before
filesystem or Git inspection, and an unscoped request fails before reading an
overlay or starting a provider.

## Enable and synchronise

Configure each workstation with a private baseline repository:

```toml
[personal_config]
enabled = true
baseline_path = "~/.agent-config"
max_stale_hours = 168
```

`baseline_path` must resolve to a non-home, non-symlinked descendant of the
current user's home directory. The gateway rejects relative paths, `/`, `~`,
`..` traversal, and existing symbolic-link components before recursively
hardening baseline permissions. Omit it to use `~/.agent-config`.

Use the local gateway to initialise, publish, and synchronise it:

```text
config_init(...)
config_publish()
config_sync()
```

For a fresh local baseline, use ordinary Git tooling to create an initial commit
on a named branch and configure its `origin` with supported HTTPS or SSH fetch
and push URLs before `config_publish()` or `config_sync()`.

Run `config_sync()` on every workstation after publishing a new baseline. It
fetches and fast-forwards only, verifies the committed tree, creates an immutable
local release, and atomically activates it. A failed sync keeps the previously
active verified release in place.

`config_publish()` and `config_sync()` revalidate every effective configured
`origin` fetch and push URL before network use, including an origin added after
a local `config_init()`. Every URL must remain a supported non-credential HTTPS
or SSH form, with no query or fragment and a host that does not begin with `-`.

Use `config_status()` and `explain_effective_config()` before a consequential
request to inspect selected release, scope, provenance, and effective preferences
without exposing the baseline path or instruction text. `config_rollback()` can
activate a retained verified release. A stale baseline fails closed; an explicit
`config_ack_stale()` acknowledgement is limited to 24 hours for that release,
survives rollback cycles, and can be renewed only after a successful sync. A
legacy state without complete acknowledgement history also requires a sync.

## Boundaries and prerequisites

- Kit operations and Kit provider execution are local-gateway only. HTTP and
  OAuth callers cannot read, change, or execute against a personal Kit.
- Kit provider execution, and recovery of an unadmitted attempt, require healthy
  durable SQLite or PostgreSQL async-job admission. Durable admission protects
  those restart and recovery boundaries.
- Kit mode currently supports Claude and Codex provider requests, including their
  async variants. Other provider requests fail closed. Cross-model validation and
  `route_request` / `route_request_async` are intentionally not registered in Kit
  mode, even when `[least_cost].enabled = true`.
- Keep the baseline remote private and never store credentials, tokens, or `.env`
  files in it. Provider-native sessions remain local to the workstation.
- A stuck Kit attempt is not a general filesystem or SQL repair problem.
  `config_recover_kit_attempt()` is a local-only, exact-attempt recovery action
  with a required acknowledgement. It never accepts arbitrary paths, hostnames,
  scopes, or manual provenance repair.

## Configuration-management lock recovery

`config_init`, `config_publish`, `config_sync`, `config_rollback`, and
`config_ack_stale` serialize on a local configuration lock, normally
`~/.llm-cli-gateway/personal-config/lock`. A `kit_busy` result from one of those
operations is not an unadmitted provider attempt and is not a reason to call
`config_recover_kit_attempt`.

On retry, the gateway automatically reclaims only a well-formed lock from the
same host when its recorded PID is provably absent. It moves the candidate to a
private quarantine and rechecks its token before deletion, so a racing
replacement at the authoritative lock path is not removed. It never age-breaks
a lock. A live local PID, a foreign hostname, malformed owner data, unavailable
liveness proof, or an ambiguous replacement remains busy and is not removed. Do not
delete, overwrite, or recreate the lock, and do not edit Kit state or durable
rows to bypass it. Stop an actual local configuration operation first; when its
same-host PID is confirmed gone, rerun the same configuration operation and let
the gateway perform token-checked recovery. Otherwise retain the lock and
investigate the workstation.

`config_recover_kit_attempt` instead permanently fences one exact locally
observed unadmitted durable provider attempt before releasing that attempt's
session lease. It neither clears nor authorizes clearing a configuration lock.

For full configuration formats, provider isolation details, PostgreSQL migration
requirements, and the same-host MCP artifact recovery contract, read the
[repository guide](https://github.com/verivus-oss/llm-cli-gateway/blob/main/docs/guides/PERSONAL_AGENT_CONFIG_KIT.md).
