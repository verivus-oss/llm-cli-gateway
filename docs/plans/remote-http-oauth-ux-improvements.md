# Remote HTTP OAuth UX Improvements Plan

Status: starting plan. Update this document with product notes, user feedback,
and implementation discoveries before converting it into a task DAG.

## Problem

Remote HTTP setup is technically capable but still asks operators to piece
together too much state from separate surfaces:

- OAuth has several moving parts: public URL, issuer metadata, client ID,
  redirect URI, client secret, authorization URL, token URL, registration
  policy, consent mode, and token expiry.
- Remote provider execution also depends on workspace readiness: registered
  aliases, default workspace, allowed roots, and the remote HTTP rule that
  arbitrary local paths are not accepted.
- Existing setup output and docs are spread across `doctor --json`,
  `print-client-config`, `oauth client add`, the setup UI, provider guides, and
  endpoint exposure runbooks.
- Deprecated ChatGPT no-auth URLs still exist as a compatibility concept, which
  can obscure the preferred OAuth path for new setups.

The next implementation should make remote HTTP + OAuth setup explicit enough
that an operator or setup assistant can answer four questions without guessing:

1. Is the public HTTP endpoint reachable?
2. Is OAuth enabled and safe for the current bind/public URL?
3. What exact values should be pasted into the remote connector UI?
4. Which workspace will remote provider calls use?

## Goals

- Provide one obvious remote-connector setup path for new installs: HTTPS
  public URL, `/mcp`, OAuth authentication, and registered workspace alias or
  default.
- Emit a copy-safe, client-oriented setup packet that contains URLs, client ID,
  auth mode, and workspace guidance, but never raw bearer tokens or already
  stored OAuth secrets.
- Make first-run OAuth client creation clearer, including redirect URI,
  copy-once secret, consent requirements, and restart instructions when needed.
- Add diagnostics that report remote readiness as a small decision tree, not
  only low-level config fields.
- Keep existing bearer-token HTTP clients and deprecated no-auth connector paths
  compatible, while making OAuth the recommended path everywhere.
- Preserve the current security model: no secrets in logs/doctor/setup JSON,
  no public dynamic registration by default, and no remote provider spawn
  outside registered workspace policy.

## Non-Goals

- Do not replace the OAuth server or change token semantics.
- Do not relax remote workspace gating.
- Do not add remote filesystem browsing, arbitrary absolute path selection, or
  network clone.
- Do not expose provider credentials, bearer tokens, OAuth access tokens,
  client secrets, tunnel tokens, or consent secrets through setup artifacts.
- Do not remove deprecated no-auth connector compatibility in this slice.

## Proposed Features

### 1. Remote Readiness Summary

Add a compact `remote_http_oauth` readiness block to `doctor --json` and the
setup UI status view. The block should be computed from existing HTTP, OAuth,
endpoint exposure, and workspace status rather than duplicating config parsing.

Suggested shape:

```json
{
  "remote_http_oauth": {
    "ready": false,
    "stage": "missing_oauth_client",
    "public_url": "https://example.trycloudflare.com",
    "mcp_url": "https://example.trycloudflare.com/mcp",
    "auth_mode": "oauth",
    "oauth": {
      "enabled": true,
      "issuer": "https://example.trycloudflare.com",
      "authorization_url": "https://example.trycloudflare.com/oauth/authorize",
      "token_url": "https://example.trycloudflare.com/oauth/token",
      "registration_policy": "static_clients",
      "clients_configured": 0,
      "consent_required": false
    },
    "workspace": {
      "ready": true,
      "default": "gateway",
      "aliases": ["gateway"]
    },
    "next_actions": [
      "Create an OAuth client for the connector redirect URI.",
      "Run: llm-cli-gateway oauth client add chatgpt --redirect-uri <callback> --print-once"
    ]
  }
}
```

The `stage` field should be stable enough for assistants and tests. Candidate
values:

- `not_started`
- `missing_public_url`
- `endpoint_unreachable`
- `oauth_disabled`
- `unsafe_oauth_config`
- `missing_oauth_client`
- `missing_workspace`
- `ready`

### 2. Explicit Connector Setup Packet

Extend `print-client-config` or add a narrowly named command such as
`remote-http setup` / `connector setup` that prints a copy-safe JSON and human
summary for a target client.

The output should include:

- MCP URL.
- Authentication mode: `OAuth`.
- Authorization URL.
- Token URL.
- Client ID, when the client exists.
- Whether a client secret must be pasted from a copy-once command.
- Workspace expectation: selected default workspace, required alias, or exact
  next action to add one.
- A warning that bearer tokens, OAuth client secrets, tunnel tokens, provider
  credentials, and consent secrets must not be pasted into chat transcripts.

The output should not include:

- Gateway bearer token.
- Stored OAuth client secret.
- OAuth access token.
- Consent/shared secret value after the copy-once creation moment.
- Deprecated no-auth connector URL unless explicitly requested with a legacy
  flag.

### 3. Guided OAuth Client Creation

Improve `llm-cli-gateway oauth client add` output so the operator sees a
complete checklist at the one moment a raw secret can be printed:

- client ID;
- copy-once client secret;
- redirect URI that was stored;
- MCP URL if public URL is configured;
- authorization URL;
- token URL;
- suggested connector fields;
- restart requirement, if config changes are not hot-loaded in the current
  process.

Validation should catch common mistakes before writing config:

- redirect URI missing scheme;
- localhost redirect for a remote-only connector, with a warning rather than a
  hard failure when local testing is plausible;
- duplicate client ID without explicit rotate/update intent;
- OAuth enabled with static clients but no usable client secret hash;
- public URL missing when connector setup requires issuer metadata.

### 4. Workspace Setup Nudges

Remote OAuth setup should always surface the remote workspace requirement in
the same place as OAuth setup. When no default workspace exists, the setup
packet should show the minimal local command:

```bash
llm-cli-gateway workspace add gateway /absolute/path/to/repo --default
```

When allowed roots are configured but no workspace exists, also show the create
path:

```bash
llm-cli-gateway workspace create <alias> --root <root> --slug <slug> --kind git --default
```

Remote clients should see workspace aliases, not local absolute paths, unless a
local operator command explicitly prints them for administration.

### 5. Setup UI Remote Connector Tab

Update `setup/ui/index.html` so remote setup has a single task-focused view:

- endpoint exposure status;
- OAuth readiness;
- connector field values with copy buttons;
- copy-once secret instructions that clearly point back to the local CLI;
- workspace readiness and default alias;
- deprecated no-auth path shown only as legacy compatibility.

The UI should avoid asking the user to interpret raw doctor JSON for common
states. It can still expose raw status for troubleshooting.

### 6. Assistant Runbook Alignment

Update setup assistant docs to consume the new readiness block first. The
assistant flow should be:

1. Run `llm-cli-gateway doctor --json`.
2. Inspect `remote_http_oauth.stage`.
3. Follow the stage-specific `next_actions`.
4. Use `print-client-config` or the new connector setup command.
5. Ask the user to paste only copy-safe setup fields into the remote UI.

Provider-specific ChatGPT docs should stop mentioning deprecated no-auth setup
except in a short compatibility note.

## File Changes Needed

- `src/doctor.ts`
  - Add the `remote_http_oauth` readiness projection.
  - Reuse existing redaction helpers and endpoint/workspace status.
  - Keep output prompt-free and secret-free.

- `setup/status.schema.json`
  - Add schema coverage for the readiness block, stable `stage` enum, URLs,
    workspace summary, and `next_actions`.

- `src/config.ts`
  - Add any missing normalized config projections needed by doctor/setup
    output, without changing runtime policy.
  - Ensure malformed OAuth config can produce actionable diagnostics.

- `src/oauth.ts`
  - Expose safe metadata helpers if doctor/setup currently has to reconstruct
    URLs by hand.
  - Keep raw token and secret material private.

- `src/http-transport.ts`
  - Confirm protected-resource metadata and authorization-server metadata URLs
    line up with the values printed by setup commands.
  - Add tests if any setup URL construction currently diverges from runtime.

- `src/workspace-registry.ts`
  - Expose a safe workspace summary for setup surfaces: aliases, default alias,
    counts, and readiness only.
  - Avoid leaking local paths into remote-client-oriented output by default.

- `src/index.ts`
  - Improve `oauth client add` / rotate output.
  - Extend `print-client-config` or add a new explicit remote connector setup
    command.
  - Add CLI usage text for the preferred OAuth flow.

- `installer/main.go`
  - Mirror or delegate the improved `print-client-config` behavior in the Go
    bootstrapper.
  - Keep `chatgpt-url` visibly deprecated and route users to OAuth setup.

- `installer/internal/config/config.go`
  - Include the readiness block in installer status/config output if the
    bootstrapper synthesizes or filters doctor data.

- `setup/ui/index.html`
  - Add the remote connector tab/status panel and copy-safe field rendering.
  - Hide legacy no-auth connector values unless explicitly expanded.

- `setup/assistants/*.md`
  - Update assistant contract and endpoint runbook to use
    `remote_http_oauth.stage` and `next_actions`.

- `setup/providers/chatgpt.md` and `docs/personal-mcp/connect-chatgpt.md`
  - Make OAuth the primary setup path.
  - Add a concise troubleshooting table keyed by readiness stage.

- `docs/personal-mcp/ENDPOINT_EXPOSURE.md`
  - Clarify the relationship between public URL, OAuth issuer metadata, MCP
    URL, and workspace gating.

- Tests:
  - `src/__tests__/doctor.test.ts`
  - `src/__tests__/oauth.test.ts`
  - `src/__tests__/http-transport.test.ts`
  - `src/__tests__/workspace-registry.test.ts`
  - `src/__tests__/cli-entrypoint.test.ts`
  - `installer/main_test.go`
  - `installer/internal/config/config_test.go`

## Phased Approach

### Phase 1: Readiness Model

- Define `remote_http_oauth.stage`, `ready`, and `next_actions` semantics.
- Add doctor projection and schema coverage.
- Cover each stage with focused doctor tests.
- Verify no secret values appear in serialized doctor JSON.

Exit criteria:

- `doctor --json` gives one stable readiness block for remote OAuth setup.
- Existing doctor schema tests pass.

### Phase 2: Copy-Safe CLI Output

- Improve or add the connector setup command.
- Update `oauth client add --print-once` output to include the complete field
  checklist.
- Keep legacy `chatgpt-url` available but clearly deprecated.
- Add CLI tests for redaction and common failure states.

Exit criteria:

- A fresh operator can create an OAuth client and get all connector fields from
  local CLI output without reading multiple docs.
- Stored secrets are never reprinted.

### Phase 3: Workspace Guidance

- Add safe workspace summary helpers.
- Include workspace readiness in doctor/setup output.
- Add stage-specific actions for missing default workspace or missing aliases.
- Update tests for default workspace, no workspace, and allowed-root-only
  states.

Exit criteria:

- Remote setup always says which workspace alias will be used or exactly how to
  create/select one.

### Phase 4: Setup UI And Assistant Docs

- Add the setup UI remote connector view.
- Update setup assistant runbooks and provider docs.
- Ensure the UI and docs prefer OAuth and hide deprecated no-auth setup by
  default.

Exit criteria:

- The UI presents the same readiness stage and next actions as doctor.
- ChatGPT setup docs use OAuth-first language.

### Phase 5: HTTP/OAuth Consistency Checks

- Add focused tests that compare printed setup URLs with runtime metadata URLs.
- Smoke test protected `/mcp` challenge, metadata endpoints, auth code flow,
  and MCP initialize with the printed values.
- Confirm workspace-gated provider execution still fails closed when no
  workspace/default exists.

Exit criteria:

- Printed values, setup UI values, doctor values, and runtime OAuth metadata are
  consistent for a configured public URL.

### Phase 6: Release Hardening

- Run the local gates:

```bash
npm run build
npm run lint
npm run format:check
npm test
```

- Update release notes with the simpler remote setup flow.
- Confirm no local tunnel hostnames, machine paths, account names, or secret
  references are committed.

Exit criteria:

- A fresh install can follow one OAuth-first remote connector path from doctor
  to successful MCP initialize and provider request in a registered workspace.

## Acceptance Criteria

- `doctor --json` reports a stable, schema-validated `remote_http_oauth` block.
- Setup output contains all connector fields needed for OAuth setup and no
  secret values except copy-once values created during the same command.
- Setup UI displays endpoint, OAuth, and workspace readiness together.
- Assistant docs use readiness stages instead of asking users to infer state
  from unrelated fields.
- Deprecated no-auth connector paths are compatibility-only in docs and setup
  surfaces.
- Remote provider requests still require a registered workspace alias, session
  workspace, or configured default before spawning a provider CLI.
