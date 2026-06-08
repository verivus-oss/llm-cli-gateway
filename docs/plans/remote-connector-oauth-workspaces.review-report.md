# Remote Connector OAuth And Workspace Selection Review Report

Date: 2026-06-08

## Scope Under Review

Changed tracked source files:

- `src/auth.ts`
- `src/http-transport.ts`
- `src/__tests__/http-transport.test.ts`

New planning-pack files:

- `docs/plans/remote-connector-oauth-workspaces.dag.toml`
- `docs/plans/remote-connector-oauth-workspaces.spec.md`
- `docs/plans/remote-connector-oauth-workspaces.design.md`
- `docs/plans/remote-connector-oauth-workspaces.implementation-prompt.md`
- `docs/plans/remote-connector-oauth-workspaces.release-checklist.md`

Round 2 diff artifact:

- `/tmp/remote-connector-review-r2.diff`

## Round 1 Findings Used As Corrective Spec

Independent reviewers found that the initial OAuth scaffold was not safe to
ship as public connector behavior:

- Bearer-token comparison used ordinary string equality instead of a
  timing-safe comparison.
- Dynamic client registration was open to any reachable client.
- Authorization accepted arbitrary client IDs and redirect URIs.
- Token exchange did not validate a client secret.
- OAuth issuer and resource metadata could be derived from hostile request
  headers when `LLM_GATEWAY_PUBLIC_URL` was absent or invalid.
- The implementation prompt included a private checkout path.
- The focused tests asserted insecure open-registration behavior.

No reviewer identified a design blocker in the DAG/spec approach. The remaining
large implementation item is the planned workspace registry and provider cwd
wiring, which is intentionally specified in the pack for the follow-on
implementation slice.

## Corrective Changes In Round 2

- Added `timingSafeStringEqual()` in `src/auth.ts` and routed bearer validation
  through it.
- Required OAuth dynamic client registration to submit
  `shared_secret` or `registration_secret` in the POST body matching
  `LLM_GATEWAY_OAUTH_REGISTRATION_SECRET` or
  `LLM_GATEWAY_OAUTH_SHARED_SECRET`.
- Issued confidential OAuth clients with `client_secret` and
  `token_endpoint_auth_method = "client_secret_post"`.
- Bound authorization codes to registered client IDs and registered redirect
  URIs.
- Required token exchange to include the registered client secret.
- Added PKCE verification when a request includes `code_challenge`.
- Stopped advertising OAuth issuer metadata from arbitrary non-local `Host`
  headers when no valid `LLM_GATEWAY_PUBLIC_URL` is configured.
- Replaced private checkout paths in the new implementation prompt with
  `<repo-root>`.
- Replaced open-DCR tests with shared-secret registration, missing-secret
  rejection, wrong-client-secret rejection, and hostile-Host metadata tests.

## Corrective Changes In Round 3

- Changed OAuth authorization errors so unknown clients and unregistered
  redirect URIs return JSON `invalid_request` instead of redirecting to an
  untrusted URI.
- Added a regression test proving the authorize endpoint does not set a
  `Location` header for an unregistered redirect URI.
- Redacted the private-path scan pattern in this report.
- Clarified that `oauth client revoke` and `oauth client rotate` stop future
  OAuth exchanges, while already-issued opaque access tokens expire by token TTL
  or server restart.

## Scope Update After Review

The workspace plan was expanded to include controlled local creation of new
workspace folders and local Git repositories. Creation is limited to configured
allowed roots, requires local bootstrapper access or `workspace:admin`, accepts
safe relative slugs rather than arbitrary absolute paths, rejects traversal and
existing non-empty targets, and does not perform network clone in this slice.

## Verification

Commands run after the latest corrective patch:

```bash
npm run build
npx vitest run src/__tests__/http-transport.test.ts
npm run format:check
rg -n "<private-checkout-path>|<user-home>" \
  docs/plans/remote-connector-oauth-workspaces.* \
  src/auth.ts src/http-transport.ts src/__tests__/http-transport.test.ts
```

Observed results:

- Build passed.
- Focused HTTP transport suite passed: 20 tests, 1 file.
- Prettier check passed for `src/**/*.ts`.
- Private-path scan returned no matches for the new pack and touched source
  files.
