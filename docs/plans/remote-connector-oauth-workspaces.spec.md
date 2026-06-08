# Remote Connector OAuth And Workspace Selection Spec

Status: planning pack, implementation pending.

## Problem

The public HTTP MCP gateway currently has three overlapping concerns that need
to be made coherent before release:

1. Remote web clients need MCP OAuth discovery and sign-in. A public `/mcp`
   endpoint protected only by static bearer auth is not enough for connector
   registration surfaces that expect OAuth.
2. Remote access must be guarded by operator-controlled secrets. A public
   tunnel must not let arbitrary clients dynamically register and mint a token.
3. Provider CLIs inherit the gateway process cwd. In the managed service path
   that cwd is normally `~/.llm-cli-gateway`, the same app dir that contains
   `logs.db`. That directory is not a project workspace, so remote requests
   need explicit repo/workspace selection before spawning Claude, Codex,
   Gemini, Grok, or Mistral.

## Goals

- Serve MCP-compatible OAuth protected-resource metadata and authorization
  server metadata.
- Support ChatGPT-style OAuth connector registration.
- Support safe shared-secret gates:
  - confidential OAuth clients with `client_secret`;
  - optional interactive shared-secret authorization;
  - no secrets in URLs, logs, doctor JSON, or default setup packets.
- Keep existing bearer-token HTTP clients working.
- Replace no-auth ChatGPT high-entropy paths with OAuth for new web setup.
- Add a workspace registry so remote clients choose registered repo aliases.
- Allow authorized operators or admin-scoped remote clients to create new local
  workspace folders and initialize new Git repos under configured allowed roots.
- Ensure provider CLI cwd is the selected repo root or gateway-owned worktree,
  never the gateway app dir by accident.
- Provide diagnostics and setup output that make readiness auditable.

## Non-Goals

- Do not build a general filesystem browser.
- Do not let remote clients clone arbitrary repos from the network in this
  slice. Local folder creation and local `git init` under configured roots are
  in scope.
- Do not expose provider credentials, OAuth refresh tokens, bearer tokens,
  tunnel tokens, or shared secrets through MCP resources.
- Do not remove local bearer-token support.
- Do not require a named Cloudflare tunnel; Quick Tunnel remains acceptable,
  but its hostname rotation must be handled by diagnostics/setup output.

## Functional Requirements

### OAuth Discovery

When `[http.oauth].enabled = true`, the HTTP server must serve:

- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-protected-resource/mcp`
- `GET /.well-known/oauth-authorization-server`
- `GET /.well-known/oauth-authorization-server/mcp`
- `GET /.well-known/openid-configuration` as an alias if useful for client
  compatibility.

Protected `/mcp` 401/403 responses must include:

```text
WWW-Authenticate: Bearer realm="llm-cli-gateway", resource_metadata="<issuer>/.well-known/oauth-protected-resource"
```

### OAuth Authorization

The gateway must support authorization-code flow:

- `GET /oauth/authorize`
- `POST /oauth/token`
- optional `POST /oauth/register` controlled by registration policy.

Authorization codes are single use, short lived, bound to `client_id`,
`redirect_uri`, scope, and PKCE challenge when present.

Token exchange must validate:

- `grant_type = authorization_code`
- code exists, is unexpired, and has not been used
- redirect URI matches exactly
- client ID matches
- PKCE verifier matches when required
- client secret matches for confidential clients.

### Shared Secret And Static Clients

Default public/web mode must require one of:

- static configured OAuth client with hashed client secret; or
- interactive shared-secret proof during authorization; or
- dynamic registration only after a bootstrap shared-secret proof.

Secrets must be generated locally, printed once only on explicit operator
commands, stored as salted hashes, and redacted from all diagnostics.

### Workspace Registry

The gateway must load a workspace registry from `config.toml`.

Each repo entry has:

- alias
- absolute normalized path
- provider allowlist
- worktree permission
- add-dir permission

Remote request handlers use aliases. Absolute paths are disabled by default.
The gateway app dir is not a workspace by default.

### Workspace Creation

The gateway must support controlled creation of new local workspaces:

- local bootstrapper command, for example
  `llm-cli-gateway workspace create <alias> --root <root-alias> --kind folder|git`;
- optional remote MCP admin tool, disabled unless the selected allowed root
  permits creation and the caller has `workspace:admin`;
- required alias and relative slug/path segment; remote clients cannot submit
  arbitrary absolute paths;
- optional `git init` for new repos;
- optional default workspace assignment when explicitly requested.

Creation must be limited to configured allowed roots. The resolved path must be
realpath-normalized after creation, must stay under the allowed root, must not
target denied directories, and must fail if the target exists and is non-empty
unless an explicit register-existing operation is used.

### Provider Spawn Cwd

Provider spawn cwd resolution:

1. Reuse session worktree if present and still valid.
2. Use request `workspace` alias.
3. Use session workspace alias.
4. Use configured default workspace.
5. Fail closed with an actionable error.

The gateway must never silently spawn provider CLIs in `~/.llm-cli-gateway`
for remote connector requests.

## Security Requirements

- Secrets never in query strings.
- Secret verification uses timing-safe comparison after KDF/hash verification.
- Config files containing hashes and generated env files use mode `0600`.
- Doctor reports only secret presence/count/status, never values.
- Workspace path resolution uses realpath and rejects symlink escapes.
- Workspace creation only accepts relative names under configured allowed roots;
  it must reject path traversal, symlink races, existing non-empty targets, and
  denied directory names.
- Workspace registration cannot target `~/.llm-cli-gateway`, `.ssh`, cloud
  credential dirs, or known secret-store dirs unless a dev-only test explicitly
  overrides the denylist.
- No-auth ChatGPT connector path is deprecated and not generated for new OAuth
  setups.

## Compatibility

- Existing local bearer-token clients keep working.
- Existing no-auth ChatGPT paths may continue for one minor release if already
  configured, but doctor must warn and generated setup must prefer OAuth.
- Existing sessions with worktree metadata continue to work.
- Existing sessions without workspace metadata use configured default workspace
  or fail before spawn.

## Acceptance

- Full test suite passes.
- Public tunnel smoke validates OAuth metadata, token exchange, and MCP
  initialize.
- A provider request from a remote client runs in a registered repo alias, not
  the gateway app dir.
- An admin-scoped creation request can create a new local Git repo under an
  allowed root, register its alias, and then run a provider request in that repo.
- Generated ChatGPT setup uses OAuth.
- No secret values appear in doctor, logs, setup UI JSON, or default
  `print-client-config`.
