# Implementation Prompt: Remote Connector OAuth And Workspace Selection

Paste this into a fresh coding-agent session opened from the repo root.

```bash
<repo-root>
```

## Task

Execute:

```text
docs/plans/remote-connector-oauth-workspaces.dag.toml
```

Implement public-ready remote MCP connector OAuth with safe shared-secret
gating, repo/workspace selection, and controlled local workspace creation for
spawned provider CLIs.

## Read First

- `docs/plans/remote-connector-oauth-workspaces.dag.toml`
- `docs/plans/remote-connector-oauth-workspaces.spec.md`
- `docs/plans/remote-connector-oauth-workspaces.design.md`
- `src/http-transport.ts`
- `src/auth.ts`
- `src/config.ts`
- `src/index.ts`
- `src/worktree-manager.ts`
- `src/request-helpers.ts`
- `installer/main.go`
- `installer/internal/config/config.go`
- `setup/assistants/endpoint-exposure-agent-runbook.md`
- `setup/providers/chatgpt.md`
- `docs/personal-mcp/connect-chatgpt.md`

If `AGENTS.md` exists, read it and follow it. Do not add internal-only machine
paths, account names, tunnel hostnames, or secret references to tracked public
files.

## Implementation Order

1. Baseline current behavior and write a local scratch note with no secrets.
2. Add typed OAuth config and tests.
3. Move OAuth route logic into a small module and harden registration/token
   exchange.
4. Add bootstrapper secret-management commands.
5. Add workspace registry and allowed-root creation config with tests.
6. Add workspace MCP tools/resources, including admin-scoped create/register.
7. Wire `workspace` into every provider sync and async request path.
8. Update doctor, setup output, docs, and schemas.
9. Add security regression tests.
10. Run full verification and release prep.

## Non-Negotiables

- No secret values in tracked files, logs, doctor output, setup UI JSON, or
  default `print-client-config`.
- No shared secret in query strings.
- No remote arbitrary path selection.
- No remote arbitrary folder creation: new folders/repos must be created only
  under configured allowed roots from safe relative slugs.
- No network clone in this slice; new repos use local `git init`.
- No implicit provider spawn cwd of `~/.llm-cli-gateway`.
- Existing bearer-token local clients must continue to work.
- Any no-auth ChatGPT path must be deprecated, not the recommended new path.

## Validation Commands

Run at minimum:

```bash
npm run build
npm run lint
npm run format:check
npm test
npm run upstream:contracts
```

Run focused suites as they are created:

```bash
npx vitest run src/__tests__/http-transport.test.ts
npx vitest run src/__tests__/workspace-registry.test.ts
npx vitest run src/__tests__/workspace-creation.test.ts
npx vitest run src/__tests__/oauth.test.ts
```

Run a live smoke before release:

1. Start HTTP gateway with OAuth enabled and one static client.
2. Start HTTPS tunnel or reverse proxy.
3. Verify `.well-known` metadata.
4. Register or use static client according to policy.
5. Complete authorization-code token exchange.
6. Initialize MCP with the issued Bearer token.
7. Call `workspace_list`.
8. Create a new local Git workspace under an allowed root with an admin-scoped
   request or local bootstrap command.
9. Run a harmless provider request with `workspace = "<alias>"`.

Capture only status codes, redacted URLs, aliases, and command names. Do not
capture tokens, client secrets, or authorization headers.

## Reviewer Prompt

Use this for cross-model/code review if orchestration tools are available:

```text
ROLE: Critical reviewer for llm-cli-gateway remote connector OAuth/workspace plan.

REPO
<repo-root>

SPEC
docs/plans/remote-connector-oauth-workspaces.dag.toml
docs/plans/remote-connector-oauth-workspaces.spec.md
docs/plans/remote-connector-oauth-workspaces.design.md

REVIEW REQUIREMENTS
1. Inspect source, tests, docs, and generated outputs directly.
2. Verify OAuth discovery, shared-secret/client-secret enforcement, secret
   redaction, workspace cwd selection, and allowed-root workspace creation.
3. Do not accept implementation summaries as evidence.
4. Cite file:line and command output for every finding.
5. End with exactly one verdict:
   - UNCONDITIONAL APPROVAL
   - NOT APPROVED with findings
   - CONCRETE BLOCKER: <reason>
```
