# Local stdio vs remote HTTP workspace gating spec

Date: 2026-06-14

## Status

Design review artifact. This spec defines the scoped implementation for a later
code diff. It does not change runtime behavior by itself.

## Problem

The gateway has two materially different entry points:

- local stdio MCP, normally started by a local MCP client inside the same user
  account and process environment as the provider CLIs
- HTTP MCP, which can be placed behind a tunnel and reached by an external MCP
  client

Workspace registration is the boundary for remote filesystem access. External
HTTP/tunnel clients should select a registered workspace alias, or rely on a
configured default workspace, before the gateway spawns provider CLIs in a
filesystem context.

The current implementation does not model that boundary directly. HTTP requests
carry auth context in `src/request-context.ts`, but no transport/origin marker.
`src/index.ts` currently has an OAuth-specific remote guard in
`resolveWorkspaceAndWorktreeForRequest`, while the unregistered
`workingDir/addDir` guard applies to all transports when
`allow_unregistered_working_dir` is false. That creates the wrong split:

- local stdio callers can be forced to register a workspace before using a
  local absolute `workingDir` or `addDir`
- HTTP bearer and auth-disabled connector paths are not treated as remote just
  because they are not OAuth

## Goal

Make the access model explicit:

- local stdio is internal and unrestricted by workspace registration
- HTTP is remote-capable and must use registered workspaces for provider
  execution, including HTTP behind a tunnel, bearer-token HTTP, OAuth HTTP, and
  auth-disabled connector paths
- local clients that need unrestricted machine-local behavior should keep using
  stdio rather than HTTP

## Non-goals

- Do not change provider CLI sandbox semantics, approval semantics, or upstream
  CLI argument contracts.
- Do not add a new general-purpose HTTP bypass for arbitrary filesystem paths.
- Do not infer trust from `Host`, loopback addresses, `X-Forwarded-*`, tunnel
  headers, or bearer-vs-OAuth auth kind.
- Do not change workspace admin authorization. Workspace mutation remains gated
  by `LLM_GATEWAY_WORKSPACE_ADMIN=1` plus the `workspace:admin` OAuth scope.
- Do not include async orphan restart/readback behavior from issue #39.

## Proposed Policy

### Request origin

Extend `GatewayRequestContext` with an explicit transport marker:

```ts
transport: "http";
```

Stdio requests do not currently run inside `runWithRequestContext`; absence of a
request context remains the stdio/internal case. If a future stdio wrapper adds
context, it should use `transport: "stdio"` rather than relying on absence.

`src/http-transport.ts` should set `transport: "http"` for every MCP request it
passes to the server transport. This includes authenticated requests and
configured no-auth connector paths.

### Remote workspace requirement

`resolveWorkspaceAndWorktreeForRequest` should derive a single remote predicate:

```ts
const requestContext = getRequestContext();
const isRemoteTransport = requestContext?.transport === "http";
```

The initial implementation may also treat `authKind === "oauth"` as remote for
backward compatibility while all HTTP paths are updated to set the transport
marker.

For remote HTTP provider execution:

- a registered `workspace` alias, session workspace metadata, or
  `[workspaces].default` is required before spawning a provider CLI
- `workingDir`, `addDir`, `includeDirs`, and worktree creation must be resolved
  relative to the selected workspace and validated by
  `validatePathInsideWorkspace`
- absolute `workingDir` stays rejected for registered workspaces
- absolute `addDir` stays allowed only when the selected workspace explicitly
  allows it and the resolved path remains inside the workspace root
- `allow_unregistered_working_dir` must not create an external HTTP/tunnel path
  bypass

For local stdio provider execution:

- lack of a registered workspace must not reject local `workingDir` or `addDir`
  by default
- explicit workspace aliases, defaults, worktrees, and session workspace
  metadata continue to work as today
- provider CLI argument sanitization and existing session validation still apply

The conservative rule is transport based, not auth based: every HTTP MCP request
is remote-capable even when it arrives through a local reverse proxy or with
gateway bearer auth.

## Affected Runtime Surfaces

Apply the policy to every provider spawn path that calls
`resolveWorkspaceAndWorktreeForRequest`:

- `claude_request`
- `claude_request_async`
- `codex_request`
- `codex_request_async`
- `gemini_request`
- `gemini_request_async`
- `grok_request`
- `grok_request_async`
- `mistral_request`
- `mistral_request_async`
- `codex_fork_session`

`codex_fork_session` matters because it still spawns Codex in a cwd and accepts
`workspace`; HTTP callers must not be able to fork from an unregistered
filesystem context.

## Compatibility

This deliberately changes the default split:

- local stdio becomes easier to use because workspace registration is not
  required for local absolute paths
- HTTP becomes stricter because bearer-token and auth-disabled HTTP are gated
  like OAuth HTTP

That is acceptable because HTTP is the tunnelable surface. Operators who need
unrestricted local access should use stdio. Operators who expose HTTP should
register workspaces and pass aliases from external clients.

The existing `[workspaces].allow_unregistered_working_dir` key is ambiguous for
this model. The scoped implementation should avoid expanding it into a remote
HTTP bypass. If backward compatibility requires retaining it, document it as a
stdio/local legacy setting only and add tests proving HTTP still fails closed.

## Implementation Slice

1. Extend `GatewayRequestContext` with `transport?: "stdio" | "http"` and keep
   `authScopes` required.
2. Set `transport: "http"` in `src/http-transport.ts` before every
   `runWithRequestContext` call for HTTP MCP requests, including no-auth paths.
3. Replace the OAuth-only guard in
   `resolveWorkspaceAndWorktreeForRequest` with a transport-based remote guard.
4. Allow stdio/no-context calls to use unregistered local `workingDir` and
   `addDir` without consulting workspace registration by default.
5. Keep registered workspace path validation unchanged for both stdio and HTTP
   when a workspace is selected.
6. Update README and personal-MCP docs to state that stdio is the unrestricted
   local transport and HTTP/tunnel clients must use registered workspace
   aliases/defaults.

## Regression Tests

Add or update focused tests in `src/__tests__/workspace-registry.test.ts` and
`src/__tests__/http-transport.test.ts`:

- local stdio/no request context provider request with an unregistered
  `workingDir` succeeds past workspace gating
- local stdio/no request context provider request with unregistered `addDir`
  succeeds past workspace gating
- HTTP request context with `authKind: "gateway_bearer"` and
  `transport: "http"` rejects provider execution without a workspace/default
- HTTP request context with `authKind: "disabled"` and `transport: "http"`
  rejects provider execution without a workspace/default
- HTTP request context with `transport: "http"` and no `authKind` rejects
  provider execution without a workspace/default, matching configured no-auth
  connector paths
- OAuth HTTP still rejects provider execution without a workspace/default
- `codex_fork_session` rejects remote HTTP without a workspace/default
- registered workspace aliases still reject escaping `workingDir` and `addDir`
- `[workspaces].allow_unregistered_working_dir = true` does not bypass the HTTP
  workspace requirement
- workspace admin tools still require `workspace:admin` and
  `LLM_GATEWAY_WORKSPACE_ADMIN=1`

The tests should assert the error text names HTTP/remote workspace registration,
not OAuth specifically, once the transport-based guard lands.

## Documentation Updates

Update public docs where transport setup is described:

- stdio examples: clarify they are the recommended path for local unrestricted
  development access
- HTTP/tunnel examples: require a bearer token or OAuth plus registered
  workspace aliases/defaults for provider execution
- workspace registry docs: describe aliases as the remote filesystem boundary
  and note that remote clients pass relative paths inside the selected
  workspace

## Review Gate

This spec needs its own cross-LLM review before implementation. Reviewers must
inspect `src/request-context.ts`, `src/http-transport.ts`, `src/index.ts`,
`src/workspace-registry.ts`, the workspace/http tests, and the README/docs
sections directly. Approval is based on the inspected code and this spec, not on
the author summary.
