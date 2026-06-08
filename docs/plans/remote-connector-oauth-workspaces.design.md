# Remote Connector OAuth And Workspace Selection Design

## Architecture

Split the implementation into three small layers:

- `src/oauth.ts`: OAuth metadata, registration policy, authorization code,
  token exchange, secret verification, and redaction helpers.
- `src/workspace-registry.ts`: config loading, alias validation, realpath
  normalization, allowed-root checks, and provider policy checks.
- Existing HTTP/provider handlers: wire OAuth routes into the HTTP transport
  and workspace resolution into provider request paths.

This keeps the MCP server surface narrow and prevents OAuth/workspace policy
from being embedded across individual provider handlers.

## Config Shape

```toml
[http.oauth]
enabled = true
issuer = "auto"
require_pkce = true
registration_policy = "static_clients"
allow_public_clients = false
token_ttl_seconds = 3600

[[http.oauth.clients]]
client_id = "gtwy-wh3"
client_secret_hash = "scrypt:N=32768,r=8,p=1:<salt>:<hash>"
allowed_redirect_uris = ["https://chat.openai.com/aip/callback"]
scopes = ["mcp"]

[http.oauth.shared_secret]
enabled = false
secret_hash = "scrypt:N=32768,r=8,p=1:<salt>:<hash>"
prompt_label = "Gateway access code"

[workspaces]
default = "gateway"
allow_unregistered_working_dir = false

[[workspaces.repos]]
alias = "gateway"
path = "/absolute/path/to/repo"
providers = ["claude", "codex", "gemini", "grok", "mistral"]
allow_worktree = true
allow_add_dir = false

[[workspaces.allowed_roots]]
path = "/absolute/path/to/parent"
allow_register_existing_git_repos = true
allow_create_directories = true
allow_init_git_repos = true
max_create_depth = 2
```

Use the existing `~/.llm-cli-gateway/config.toml` loader pattern. Add separate
loaders so malformed OAuth config disables only OAuth and malformed workspace
config disables only workspace registration.

## OAuth Policy

Registration policies:

- `static_clients`: public default. Only preconfigured client IDs are accepted.
  `/oauth/register` returns 403 unless a future explicit bootstrap path is
  enabled.
- `shared_secret`: DCR or authorization requires an operator-shared secret.
  The secret is submitted in POST body or an authorization form, never URL
  query.
- `open_dev`: testing only. Allowed on localhost or when an explicit
  `LLM_GATEWAY_OAUTH_OPEN_DEV=1` flag is set.

Token choices:

- The token endpoint issues separate opaque OAuth access tokens and maps them to
  client id, scope, and expiry in server memory.

OAuth issuance is gated by static client secrets or shared-secret proof.
Per-client revoke and rotate prevent future OAuth code exchanges for that
client. Already-issued opaque access tokens expire by token TTL or server
restart.

## Shared Secret UX

Local bootstrapper commands generate secrets:

```bash
llm-cli-gateway oauth client add gtwy-wh3 --redirect-uri https://chat.openai.com/aip/callback --print-once
llm-cli-gateway oauth client rotate gtwy-wh3 --print-once
llm-cli-gateway oauth shared-secret set --print-once
```

The command prints:

- client ID
- client secret or shared access code once
- MCP URL
- authentication mode

It must not print the gateway bearer token. It must warn that the value should
be pasted only into the connector settings/sign-in page, not into remote chat.

## Workspace Registry UX

Local bootstrapper commands can manage repo entries:

```bash
llm-cli-gateway workspace add gateway <absolute-repo-path> --default
llm-cli-gateway workspace create example-client --root projects --kind git --default
llm-cli-gateway workspace list
llm-cli-gateway workspace remove gateway
```

Remote MCP tools can list registered workspaces. Remote registration is
optional and requires an admin scope or explicit allowed-root policy.
Remote creation is also optional and requires both `workspace:admin` and an
allowed root with creation enabled.

Creation rules:

- The caller supplies an alias and a relative slug, not an absolute path.
- The slug is normalized, restricted to safe path segments, and resolved under a
  configured allowed root.
- `kind = "folder"` creates a directory only.
- `kind = "git"` creates the directory and runs local `git init`; network clone
  remains out of scope for this slice.
- Existing non-empty directories are rejected; existing Git repos use the
  separate register-existing flow.
- Created workspaces are written to `config.toml` atomically with mode `0600`
  preservation, then are immediately selectable by provider requests.

Provider tools gain:

```ts
workspace?: string;
```

Examples:

```json
{ "prompt": "Run tests", "workspace": "gateway" }
{ "prompt": "Make the change", "workspace": "gateway", "worktree": true }
```

## Spawn Cwd

Every provider request should resolve an `EffectiveWorkspace` before spawning:

```ts
interface EffectiveWorkspace {
  alias: string;
  root: string;
  cwd: string;
  worktreePath?: string;
}
```

For non-worktree requests, `cwd = root`.
For gateway worktree requests, `cwd = worktreePath`.

If no workspace can be resolved, fail before spawning:

```text
No workspace selected. Configure [workspaces].default or pass a registered workspace alias.
```

## Diagnostics

Doctor should add:

```json
"auth": {
  "oauth": {
    "enabled": true,
    "registration_policy": "static_clients",
    "clients_configured": 1,
    "shared_secret_enabled": false,
    "pkce_required": true,
    "issuer": "https://example.trycloudflare.com",
    "metadata_reachable": true
  }
}
```

and:

```json
"workspaces": {
  "enabled": true,
  "default": "gateway",
  "repo_count": 1,
  "allowed_root_count": 1,
  "gateway_app_dir_is_workspace": false
}
```

## Test Strategy

- Unit tests for OAuth config, secret hashing, and route handlers.
- HTTP integration tests for successful and failing OAuth flows.
- Workspace registry tests with temp dirs and symlink escape fixtures.
- Provider handler tests that assert mocked executor receives the expected cwd.
- End-to-end smoke with local HTTP server and public tunnel.

## Release Strategy

Ship as a minor version because it changes public setup behavior and adds
user-facing MCP auth/workspace capability.

New installs:

- OAuth enabled for web connector setup.
- Static client or shared-secret setup generated by bootstrapper.
- No-auth ChatGPT URL no longer preferred.

Existing installs:

- Bearer `/mcp` unchanged.
- Existing no-auth connector path works for one minor release with warnings.
