# Security policy

## Reporting a vulnerability

Email **security@verivus.com** with:

- A short description of the issue, including the affected version (`llm-cli-gateway` npm tag or GitHub release tag) and the affected component (specific tool, MCP resource, executor path, async-job handler, flight-recorder migration, etc.).
- A minimal reproduction if applicable: the MCP tool invocation (or curl against the HTTP transport), the expected outcome, and the observed outcome.
- Whether you believe the issue is exploitable from an MCP client (e.g. an orchestrating agent), from an upstream CLI's stdout/stderr, from the audit-focused flight recorder (`~/.llm-cli-gateway/logs.db`), from the session manager (`~/.llm-cli-gateway/sessions.json`), or from the optional HTTP transport (`LLM_GATEWAY_TRANSPORT=http`).

We aim to acknowledge reports within five business days.

## Scope

In scope:

- **Injection / argument-smuggling** in the executor (`src/executor.ts`) or any `prepare*Request` builder (`src/index.ts`). The executor uses `child_process.spawn` with a fixed allow-list of CLI binaries and never sets `shell: true`; an exploit that bypasses this is a critical finding.
- **Auth / token handling** in the HTTP transport (`src/http-transport.ts`, `src/endpoint-exposure.ts`). The transport defaults to `127.0.0.1`, is auth-token gated via `LLM_GATEWAY_AUTH_TOKEN`, and refuses to bind to a public interface without a token. Bypasses, token-leak vectors, or downgrade paths are in scope.
- **Session-storage invariant violations**: anything that writes conversation content to `~/.llm-cli-gateway/sessions.json`. The session manager is content-free by design; reviewers should see only id / cli / description / created / lastUsed / active fields.
- **SQL injection / data-tampering** through the flight recorder's `queryRequests()` read surface (`src/flight-recorder.ts`). The surface is gated on `stmt.readonly` and rejects mutating SQL.
- **Async-job store** integrity: anything that lets an MCP client read or cancel another tenant's jobs, or that bypasses the structural invariant guaranteeing `*_request_async` tools are only registered when a durable store is attached.
- **Approval-gate bypass**: any path that lets `approvalStrategy: "mcp_managed"` fall through without an approved decision, or any path that lets the gateway report a violated review-integrity result as if compliant.
- **Supply-chain**: lockfile or `npm publish` provenance issues, missing SHA pins on GHA, leaked tokens in build artifacts, or anything caught by gitleaks / osv-scanner / cargo-audit equivalents.

Out of scope (please report upstream):

- Vulnerabilities in the wrapped CLIs themselves (Claude Code, Codex, Gemini, Grok, Mistral Vibe). Report to the CLI vendor.
- Vulnerabilities in transitive npm dependencies — file with the upstream maintainer; we'll bump on disclosure.
- Aesthetic preferences about the tool surface or naming.

## Disclosure

We coordinate disclosure: the reporter and the maintainers agree on a timeline. Default embargo is 30 days from acknowledgement; we extend if a fix needs more time, and we shorten if the issue is already being exploited.

We credit reporters in `CHANGELOG.md` for the release that fixes the finding, unless the reporter requests otherwise.

## Release signing

Release tags are not signed today (matching the historical pattern: v1.0.0 onward are unsigned annotated tags). Starting with v1.15.1, GitHub release installer artifacts are signed with Sigstore keyless signing from GitHub Actions OIDC. Each uploaded artifact gets a `<artifact>.sigstore.json` bundle, including `SHA256SUMS.sigstore.json`.

Verify the checksum manifest before trusting artifact checksums:

```bash
cosign verify-blob SHA256SUMS --bundle SHA256SUMS.sigstore.json \
  --certificate-identity "https://github.com/verivus-oss/llm-cli-gateway/.github/workflows/release-installer.yml@refs/tags/v<version>" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
sha256sum --check SHA256SUMS
```

`npm publish` provenance via the OIDC sigstore path remains the supply-chain integrity gate for the npm artifact.

## Threat surfaces NOT covered by automated CI

- **MCP transport binding** when operators flip `LLM_GATEWAY_HTTP_HOST` away from `127.0.0.1`. The `LLM_GATEWAY_PUBLIC_URL` warning is informational; misconfiguration here is an operator responsibility.
- **CLI authentication tokens** for the wrapped CLIs (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.). The gateway never reads, logs, or persists these; they flow only through the spawned child process environment.
- **Persistence at-rest encryption**. SQLite files are `chmod 0o600` but not encrypted; full-disk encryption is an operator responsibility.

Report findings outside this scope to **security@verivus.com** anyway — we'd rather triage them than miss something.
