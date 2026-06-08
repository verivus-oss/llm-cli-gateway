# Remote Connector OAuth/Workspaces Review Report

Date: 2026-06-08

## Scope

Implementation of `docs/plans/remote-connector-oauth-workspaces.dag.toml`:

- MCP OAuth discovery and authorization-code flow.
- Static-client and shared-secret gates with hash-only persisted secrets.
- Copy-once local OAuth secret commands.
- Workspace registry, allowed roots, local folder/Git repo creation, and MCP
  workspace tools.
- Provider `workspace` alias selection wired into sync/async provider spawns and
  async dedup cwd.
- Doctor/setup/docs/schema updates.

## Changed Files

```text
CHANGELOG.md
package-lock.json
package.json
README.md
docs/personal-mcp/connect-chatgpt.md
docs/personal-mcp/ENDPOINT_EXPOSURE.md
docs/plans/remote-connector-oauth-workspaces.dag.toml
docs/plans/remote-connector-oauth-workspaces.design.md
docs/plans/remote-connector-oauth-workspaces.implementation-prompt.md
docs/plans/remote-connector-oauth-workspaces.release-checklist.md
docs/plans/remote-connector-oauth-workspaces.review-report.md
docs/plans/remote-connector-oauth-workspaces.spec.md
docs/reviews/remote-connector-oauth-workspaces-review-2026-06-08.md
installer/internal/config/config.go
installer/internal/config/config_test.go
installer/main.go
setup/assistants/chatgpt-install-prompt.md
setup/assistants/endpoint-exposure-agent-runbook.md
setup/assistants/mcp-config-samples.md
setup/install-plan.dag.toml
setup/providers/chatgpt.md
setup/status.schema.json
setup/ui/index.html
src/__tests__/http-transport.test.ts
src/__tests__/gemini-async-handler.test.ts
src/__tests__/doctor.test.ts
src/__tests__/mcp-surface-usability.test.ts
src/__tests__/oauth.test.ts
src/__tests__/workspace-creation.test.ts
src/__tests__/workspace-registry.test.ts
src/auth.ts
src/config.ts
src/doctor.ts
src/http-transport.ts
src/index.ts
src/oauth.ts
src/request-context.ts
src/upstream-contracts.ts
src/workspace-registry.ts
```

## Diff Artifact

Exact diff artifact, including untracked new files:

```text
/tmp/remote-connector-oauth-workspaces-final.diff
```

## Verification

Commands run locally:

```text
npm run build
```

Result: passed.

```text
npm run lint
```

Result: passed with the repository's existing ignored-test-file warnings and
one pre-existing test setup security warning; no lint errors.

```text
npm run format:check
```

Result: passed.

```text
npm test
```

Result: passed, 70 files, 1150 tests.

```text
npm run upstream:contracts
```

Result: passed, 5 providers, fixtures/report/TOML sync verified offline.

```text
npx vitest run src/__tests__/http-transport.test.ts
```

Result: passed, 1 file, 22 tests.

```text
npx vitest run src/__tests__/oauth.test.ts
```

Result: passed, 1 file, 5 tests.

```text
npx vitest run src/__tests__/workspace-registry.test.ts
```

Result: passed, 1 file, 7 tests.

```text
npx vitest run src/__tests__/workspace-creation.test.ts
```

Result: passed, 1 file, 4 tests.

```text
node -e "const fs=require('fs'); const toml=require('smol-toml'); toml.parse(fs.readFileSync('docs/plans/remote-connector-oauth-workspaces.dag.toml','utf8')); console.log('DAG TOML parse ok')"
```

Result: `DAG TOML parse ok`.

```text
Added-lines scan over tracked modifications plus new files for private paths,
local account names, raw bearer strings, and obvious raw secret assignments.
```

Result: no matches.

## Reviewer Instructions

Enable MCP tool access, at minimum `sqry`.

Reviewers must receive:

- This report.
- The diff artifact path above.
- The changed-file list above.
- The verification command summaries above.
- The plan/spec/design docs in `docs/plans/remote-connector-oauth-workspaces.*`.

Reviewers must directly inspect source, tests, docs, schema, and the diff. They
must not accept this report as evidence. Findings require file:line and
command-output evidence.

Each reviewer must end with exactly one terminal verdict:

```text
UNCONDITIONAL APPROVAL
```

or:

```text
CONCRETE BLOCKER: <reason>
```

## Review Jobs

Initial review jobs:

```text
Claude: 25375c92-9cc3-4115-bbe4-68c3ae3a142d
Gemini: f30e8d3d-f0b7-4bdf-8a95-86bc1861f217
Codex: 1247c9fc-5c2a-4c51-9d77-9845b68e6d52
```

Initial result:

- Gemini returned `UNCONDITIONAL APPROVAL`.
- Codex returned `CONCRETE BLOCKER: OAuth static clients without
  client_secret_hash can exchange codes without any client secret`.
- Claude result retrieval was too large for the first pass and will be repeated
  after the concrete blocker fix.

Blocker fix:

- `src/config.ts` now disables OAuth when `allow_public_clients = false` and a
  static configured client omits `client_secret_hash`.
- `src/oauth.ts` now marks runtime clients public only when public clients are
  explicitly allowed, and omits `none` from token endpoint auth metadata when
  public clients are disabled.
- `src/__tests__/oauth.test.ts` adds a regression for the rejected static
  public-client config.

Re-review jobs after blocker fix:

```text
Claude: b218aa99-ea15-498e-a3fd-585a9c17f88e
Gemini: 797acc39-0a3b-412b-acb0-fdd4ba9bc676
Codex: 2366bed7-f969-482e-93cb-9938bb1706bd
Mistral replacement for Gemini quota failure: 85d6bbe2-f64c-4d98-86ac-e095b59e4569
```

Re-review result:

- Gemini failed before review on provider quota.
- Mistral returned `UNCONDITIONAL APPROVAL`.
- Codex returned `CONCRETE BLOCKER: workspace registry policy can be bypassed
  because provider requests without a resolved workspace skip workingDir/addDir
  validation and do not fail closed unless the process cwd is exactly
  ~/.llm-cli-gateway`.
- Claude completed, but result output was too large to use as terminal evidence
  for this iteration.

Second blocker fix:

- `src/index.ts` now rejects `workingDir` and `addDir` when no workspace is
  resolved unless `[workspaces].allow_unregistered_working_dir = true`.
- `src/__tests__/workspace-registry.test.ts` now invokes the registered
  `codex_request` tool with an unregistered `workingDir` and asserts the
  fail-closed error.

Post-second-fix verification:

```text
npm run build
npm run lint
npm run format:check
npm test
npm run upstream:contracts
npx vitest run src/__tests__/http-transport.test.ts
npx vitest run src/__tests__/oauth.test.ts
npx vitest run src/__tests__/workspace-registry.test.ts
npx vitest run src/__tests__/workspace-creation.test.ts
```

Result: passed. Full suite is 70 files, 1148 tests. Focused suite counts are
22, 5, 6, and 4 tests respectively. Lint has the same existing warnings noted
above and no errors.

Final re-review jobs after second blocker fix:

```text
Codex: 027abac2-1c11-44aa-aed9-eebfd6d8b70d
Mistral: 6cc870d1-c224-41ae-ab2b-2f9012e4030b
Grok: 4edf9a44-8980-4ee5-8958-6122aa27475e
```

Final re-review result after second blocker fix:

- Mistral returned `UNCONDITIONAL APPROVAL`.
- Grok returned `UNCONDITIONAL APPROVAL`.
- Codex returned `CONCRETE BLOCKER: workspace_create/register_existing_repo
  can be used by any authenticated caller when LLM_GATEWAY_WORKSPACE_ADMIN=1,
  without enforcing the required workspace:admin caller scope`.

Third blocker fix:

- `src/auth.ts` now issues in-memory opaque OAuth access tokens mapped to client
  id, scope, and expiry instead of returning the gateway bearer token from the
  OAuth token endpoint.
- `src/oauth.ts` validates requested authorization scopes against the registered
  client and returns `invalid_scope` for unauthorized scope requests.
- `src/http-transport.ts` propagates auth kind, client id, and scopes through a
  per-request async context.
- `src/index.ts` now requires both `LLM_GATEWAY_WORKSPACE_ADMIN=1` and request
  scope `workspace:admin` before `workspace_create` or
  `workspace_register_existing_repo` may run.
- `src/__tests__/http-transport.test.ts` proves OAuth token exchange returns an
  opaque scoped token accepted by MCP and rejects dynamic-client
  `workspace:admin` escalation.
- `src/__tests__/workspace-registry.test.ts` proves the admin workspace tools
  reject a caller that has the process admin flag but lacks OAuth
  `workspace:admin` scope.

Post-third-fix verification:

```text
npm run build
npm run lint
npm run format:check
npm test
npm run upstream:contracts
npx vitest run src/__tests__/http-transport.test.ts
npx vitest run src/__tests__/oauth.test.ts
npx vitest run src/__tests__/workspace-registry.test.ts
npx vitest run src/__tests__/workspace-creation.test.ts
```

Result: passed. Full suite is 70 files, 1148 tests. Focused suite counts are
22, 5, 6, and 4 tests respectively. Lint has the same existing warnings noted
above and no errors.

```text
node -e "const fs=require('fs'); const toml=require('smol-toml'); toml.parse(fs.readFileSync('docs/plans/remote-connector-oauth-workspaces.dag.toml','utf8')); console.log('DAG TOML parse ok')"
```

Result: `DAG TOML parse ok`.

Final re-review jobs after third blocker fix:

```text
Codex: c8b3047a-884e-42d7-8fa8-a47f3a9cff40
Mistral: 19e45604-521f-437a-8d49-d8b5cae5bd32
Grok: fef78046-be1f-45f0-9c74-b7e8d050adb7
```

Final re-review result after third blocker fix:

- Grok returned `UNCONDITIONAL APPROVAL`.
- Codex returned `CONCRETE BLOCKER: sync Gemini workspace cwd is passed as
  stdin, so workspace selection is not applied to gemini_request`.
- The stale Mistral review was canceled after Codex returned the blocker because
  it was reviewing the pre-fix tree.

Fourth blocker fix:

- `src/index.ts` now passes an explicit `undefined` stdin argument before
  `worktreeResolution.cwd` in the sync `gemini_request` `awaitJobOrDefer` call,
  matching the Grok and Mistral sync call shape.
- `src/index.ts` now forwards `workspaces` through `resolveHandlerRuntime` so
  direct handler tests can inject the same workspace registry used by server
  runtime paths.
- `src/__tests__/gemini-async-handler.test.ts` adds a regression proving sync
  `gemini_request` sends the selected workspace path as executor `cwd` and does
  not put it in `stdin`.

Post-fourth-fix verification:

```text
npm run build
npm run lint
npm run format:check
npm test
npm run upstream:contracts
npx vitest run src/__tests__/http-transport.test.ts
npx vitest run src/__tests__/oauth.test.ts
npx vitest run src/__tests__/workspace-registry.test.ts
npx vitest run src/__tests__/workspace-creation.test.ts
npx vitest run src/__tests__/gemini-async-handler.test.ts
```

Result: passed. Full suite is 70 files, 1149 tests. Focused suite counts are
22, 5, 7, 4, and 14 tests respectively. Lint has the same existing warnings
noted above and no errors.

```text
node -e "const fs=require('fs'); const toml=require('smol-toml'); toml.parse(fs.readFileSync('docs/plans/remote-connector-oauth-workspaces.dag.toml','utf8')); console.log('DAG TOML parse ok')"
```

Result: `DAG TOML parse ok`.

Final re-review jobs after fourth blocker fix:

```text
Codex: 8cbd7213-b11b-4921-aeb6-558ea18ab23f
Mistral: 7c9ede60-5073-442c-a2a9-3d1e12d1d758
Grok: 13221aae-7501-4e83-a035-21cd8a7f8975
```

Final re-review result after fourth blocker fix:

- Mistral returned `UNCONDITIONAL APPROVAL`.
- Grok completed without a terminal verdict, so the result was not accepted.
- Codex returned `CONCRETE BLOCKER: tunnel start still generates and serves
  deprecated no-auth ChatGPT connector paths for new OAuth setup`.

Fifth blocker fix:

- `installer/main.go` no longer calls no-auth ChatGPT path generation from
  `tunnel start`, `public-url`, or default `chatgpt-url`.
- `installer/main.go` reports ChatGPT setup as OAuth and shows any deprecated
  no-auth URL only as `<redacted>` if one already exists.
- `installer/internal/config/config.go` no longer emits
  `LLM_GATEWAY_NO_AUTH_PATHS` from persisted ChatGPT no-auth settings, and
  `public-url clear` clears deprecated ChatGPT no-auth settings.
- `installer/internal/config/config_test.go` now asserts public URL setup does
  not create a ChatGPT no-auth path and `EnvForGateway` does not expose
  `LLM_GATEWAY_NO_AUTH_PATHS`.

Post-fifth-fix verification:

```text
go test ./...
```

Result: passed from the installer module.

```text
npm run build
npm run lint
npm run format:check
npm test
npm run upstream:contracts
npx vitest run src/__tests__/http-transport.test.ts
npx vitest run src/__tests__/oauth.test.ts
npx vitest run src/__tests__/workspace-registry.test.ts
npx vitest run src/__tests__/workspace-creation.test.ts
npx vitest run src/__tests__/gemini-async-handler.test.ts
```

Result: passed. Full suite is 70 files, 1149 tests. Focused suite counts are
22, 5, 6, 4, and 14 tests respectively. Lint has the same existing warnings
noted above and no errors.

```text
node -e "const fs=require('fs'); const toml=require('smol-toml'); toml.parse(fs.readFileSync('docs/plans/remote-connector-oauth-workspaces.dag.toml','utf8')); console.log('DAG TOML parse ok')"
```

Result: `DAG TOML parse ok`.

Final re-review jobs after fifth blocker fix:

```text
Codex: 2bb8eac6-c058-47da-8cf4-9eb13f4a7bf0
Mistral: ab27c83b-a730-4b63-816f-1fde5af7d9a6
```

Final re-review result after fifth blocker fix:

- Mistral returned `UNCONDITIONAL APPROVAL`.
- Codex returned `CONCRETE BLOCKER: remote OAuth provider requests can still
  inherit the gateway process cwd without a registered workspace`.

Sixth blocker fix:

- `src/index.ts` now rejects OAuth-authenticated provider requests that do not
  resolve to a registered workspace via explicit `workspace`, session metadata,
  or `[workspaces].default`.
- Local bearer/stdin clients retain the existing cwd behavior unless they select
  unsafe `workingDir`/`addDir` paths, preserving local bearer-token clients.
- `src/__tests__/workspace-registry.test.ts` adds a regression proving an OAuth
  request context without a workspace fails before provider spawn.

Post-sixth-fix verification:

```text
go test ./...
```

Result: passed from the installer module.

```text
npm run build
npm run lint
npm run format:check
npm test
npm run upstream:contracts
npx vitest run src/__tests__/http-transport.test.ts
npx vitest run src/__tests__/oauth.test.ts
npx vitest run src/__tests__/workspace-registry.test.ts
npx vitest run src/__tests__/workspace-creation.test.ts
npx vitest run src/__tests__/gemini-async-handler.test.ts
```

Result: passed. Full suite is 70 files, 1150 tests. Focused suite counts are
22, 5, 7, 4, and 14 tests respectively. Lint has the same existing warnings
noted above and no errors.

```text
node -e "const fs=require('fs'); const toml=require('smol-toml'); toml.parse(fs.readFileSync('docs/plans/remote-connector-oauth-workspaces.dag.toml','utf8')); console.log('DAG TOML parse ok')"
```

Result: `DAG TOML parse ok`.

Final re-review jobs after sixth blocker fix:

```text
Codex: f23f3dea-8c07-4d3b-86e0-a6122f65b146
Mistral: bc9cafc1-80b5-40bb-ace5-f42ca1e83f86
```

Final re-review result after sixth blocker fix:

- Mistral completed without a terminal verdict and entered a planning flow, so
  the result was not accepted as review evidence.
- Codex returned `CONCRETE BLOCKER: doctor output can leak existing deprecated
  ChatGPT no-auth connector path secrets instead of redacting them`.

Seventh blocker fix:

- `src/doctor.ts` now reports deprecated `LLM_GATEWAY_NO_AUTH_PATHS` ChatGPT
  connector URLs as `<redacted>` instead of reconstructing a URL that contains
  the legacy path secret.
- `installer/internal/config/config.go` now reports old persisted
  `chatgpt_connector_url` settings as `<redacted>` in the bootstrapper fallback
  doctor report.
- `src/__tests__/doctor.test.ts` and
  `installer/internal/config/config_test.go` add regressions proving deprecated
  ChatGPT no-auth path secrets do not appear in doctor output.

Post-seventh-fix verification:

```text
go test ./...
```

Result: passed from the installer module.

```text
npm run build
npm run lint
npm run format:check
npm test
npm run upstream:contracts
npx vitest run src/__tests__/http-transport.test.ts
npx vitest run src/__tests__/oauth.test.ts
npx vitest run src/__tests__/workspace-registry.test.ts
npx vitest run src/__tests__/workspace-creation.test.ts
npx vitest run src/__tests__/gemini-async-handler.test.ts
npx vitest run src/__tests__/doctor.test.ts
```

Result: passed. Full suite is 70 files, 1151 tests. Focused suite counts are
22, 5, 7, 4, 14, and 21 tests respectively. Lint has the same existing warnings
noted above and no errors.

```text
node -e "const fs=require('fs'); const toml=require('smol-toml'); toml.parse(fs.readFileSync('docs/plans/remote-connector-oauth-workspaces.dag.toml','utf8')); console.log('DAG TOML parse ok')"
```

Result: `DAG TOML parse ok`.

```text
Added-lines scan over /tmp/remote-connector-oauth-workspaces-final.diff for
private paths, local account names, raw bearer strings, and obvious raw secret
assignments.
```

Result: no matches. Current diff artifact length is 6370 lines.

Final re-review jobs after seventh blocker fix:

```text
Codex: 57fd1853-c41d-46d0-8c70-d4247e85bee2
Mistral: 735b093f-da96-4712-9ba1-8952f30e7289
```

Final re-review result after seventh blocker fix:

- Mistral returned `UNCONDITIONAL APPROVAL`.
- Codex returned `CONCRETE BLOCKER: shipped setup surfaces still recommend or
  generate non-OAuth ChatGPT connector guidance instead of the required OAuth
  setup flow`.

Eighth blocker fix:

- `setup/assistants/endpoint-exposure-agent-runbook.md`,
  `setup/assistants/chatgpt-install-prompt.md`,
  `setup/assistants/mcp-config-samples.md`,
  `docs/personal-mcp/ENDPOINT_EXPOSURE.md`, and `setup/install-plan.dag.toml`
  now describe ChatGPT setup as OAuth against the verified public `/mcp` URL,
  with copy-once local OAuth client secret output.
- `setup/ui/index.html` now renders a ChatGPT-specific OAuth snippet and
  assistant packet entries for authorization/token/registration URLs, client id,
  and copy-once client secret placeholder instead of falling through to bearer
  token guidance.
- A stale guidance scan over setup docs now leaves only historical changelog
  entries and explicit deprecated/no-use warnings.

Post-eighth-fix verification:

```text
go test ./...
```

Result: passed from the installer module.

```text
npm run build
npm run lint
npm run format:check
npm test
npm run upstream:contracts
npx vitest run src/__tests__/http-transport.test.ts
npx vitest run src/__tests__/oauth.test.ts
npx vitest run src/__tests__/workspace-registry.test.ts
npx vitest run src/__tests__/workspace-creation.test.ts
npx vitest run src/__tests__/gemini-async-handler.test.ts
npx vitest run src/__tests__/doctor.test.ts
```

Result: passed. Full suite is 70 files, 1151 tests. Focused suite counts are
22, 5, 7, 4, 14, and 21 tests respectively. Lint has the same existing warnings
noted above and no errors.

```text
node -e "const fs=require('fs'); const toml=require('smol-toml'); for (const file of ['docs/plans/remote-connector-oauth-workspaces.dag.toml','setup/install-plan.dag.toml']) toml.parse(fs.readFileSync(file,'utf8')); console.log('DAG TOML parse ok')"
```

Result: `DAG TOML parse ok`.

```text
Added-lines scan over /tmp/remote-connector-oauth-workspaces-final.diff for
private paths, local account names, raw bearer strings, and obvious raw secret
assignments.
```

Result: no matches. Current diff artifact length is 6723 lines.

Final re-review jobs after eighth blocker fix:

```text
Codex: 98b8b93d-c6d2-46a4-988b-2c53d69d9c5e
Mistral: fe17689d-d05d-4c8d-bcf0-f24dc1199b1f
```

Final re-review result after eighth blocker fix:

- Mistral returned `UNCONDITIONAL APPROVAL`.
- Codex returned `CONCRETE BLOCKER: codex_fork_session bypasses workspace
  resolution and can spawn Codex in inherited cwd for remote OAuth callers`.

Ninth blocker fix:

- `src/index.ts` now adds a `workspace` input to `codex_fork_session`, invokes
  `resolveWorkspaceAndWorktreeForRequest` before spawning, and passes the
  resolved `cwd` through `awaitJobOrDefer`.
- Local bearer callers without a selected workspace retain the existing cwd
  behavior; OAuth callers without an explicit/default/session workspace now fail
  closed before spawning.
- `src/__tests__/workspace-registry.test.ts` adds a regression proving
  OAuth-authenticated `codex_fork_session` without a workspace returns the
  remote-workspace-required error.

Post-ninth-fix verification:

```text
go test ./...
```

Result: passed from the installer module.

```text
npm run build
npm run lint
npm run format:check
npm test
npm run upstream:contracts
npx vitest run src/__tests__/http-transport.test.ts
npx vitest run src/__tests__/oauth.test.ts
npx vitest run src/__tests__/workspace-registry.test.ts
npx vitest run src/__tests__/workspace-creation.test.ts
npx vitest run src/__tests__/gemini-async-handler.test.ts
npx vitest run src/__tests__/doctor.test.ts
```

Result: passed. Full suite is 70 files, 1152 tests. Focused suite counts are
22, 5, 8, 4, 14, and 21 tests respectively. Lint has the same existing warnings
noted above and no errors.

```text
node -e "const fs=require('fs'); const toml=require('smol-toml'); for (const file of ['docs/plans/remote-connector-oauth-workspaces.dag.toml','setup/install-plan.dag.toml']) toml.parse(fs.readFileSync(file,'utf8')); console.log('DAG TOML parse ok')"
```

Result: `DAG TOML parse ok`.

```text
Added-lines scan over /tmp/remote-connector-oauth-workspaces-final.diff for
private paths, local account names, raw bearer strings, and obvious raw secret
assignments.
```

Result: no matches. Current diff artifact length is 6859 lines.

Final re-review jobs after ninth blocker fix:

```text
Codex: ed9e443a-4d3c-466c-aed8-3f8f4aa76a2a
Mistral: a94325a3-7d5b-4092-ab55-f2479f4fa948
```

Final re-review result after ninth blocker fix:

- Codex returned `UNCONDITIONAL APPROVAL`.
- Mistral returned `UNCONDITIONAL APPROVAL`.

Post-approval release metadata update:

- `package.json` and `package-lock.json` were bumped from `2.4.0` to `2.5.0`.
- `CHANGELOG.md` moved the remote connector OAuth/workspaces notes from
  `Unreleased` to `[2.5.0] - 2026-06-08`.
- Post-bump local gates passed:
  `go test ./...`, `npm run build`, `npm run lint`, `npm run format:check`,
  `npm test`, and `npm run upstream:contracts`.
- Final diff artifact after the release metadata update:
  `/tmp/remote-connector-oauth-workspaces-final.diff`, 6908 lines.
- Added-lines scan over the final diff artifact for private paths, local account
  names, raw bearer strings, and obvious raw secret assignments returned no
  matches.
