# Release Readiness Checklist

Status: Layer 8 / U16 release-readiness gate
Date: 2026-05-19

This checklist covers the seven topics U16 acceptance #4 requires:
install, auth, provider login, validation, upgrade, uninstall, and
support diagnostics. Every entry names the artifact that proves the
gate and the command an assistant can quote to a user.

## Install

| Gate                                                                                             | Evidence                                                                                                                |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Go bootstrapper binaries are built on Linux self-hosted plus GitHub-hosted Windows/macOS runners | `.github/workflows/release-installer.yml` `build-binaries` matrix; `installer/build-release.sh` defaults to host target |
| Platform bundles include the gateway, production dependencies, and a managed Node runtime        | `installer/build-release.sh` `package_platform_bundle` + `download_node_runtime`                                        |
| Windows has a one-command installer that still verifies release checksums                        | `installer/build-release.sh` `write_windows_installer_script`                                                           |
| `SHA256SUMS` and Sigstore bundles are produced; users must verify before run                     | `installer/packaging/README.md` "Verification" and "Signing" sections                                                   |
| Bootstrapper has `setup` + `install-bundle` to materialize the gateway dir                       | `installer/main.go:37-42, 96-97`                                                                                        |
| Docker Compose fallback exists                                                                   | `docker-compose.personal.yml`, `Dockerfile.personal`                                                                    |
| Install commands are idempotent and copy/paste safe                                              | `setup/install-plan.dag.toml` step `start-gateway` + `install-bundle`                                                   |
| README documents the single-binary install path                                                  | `README.md` "Install / Upgrade / Uninstall" section                                                                     |

Quote-for-user:

```bash
# Verify before run.
cosign verify-blob SHA256SUMS --bundle SHA256SUMS.sigstore.json \
  --certificate-identity "https://github.com/verivus-oss/llm-cli-gateway/.github/workflows/release-installer.yml@refs/tags/v<ver>" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
sha256sum --check SHA256SUMS

# Windows install: use the release manifest's pinned direct-download PowerShell
# command. Do not pipe remote scripts into Invoke-Expression.

# Install.
chmod +x llm-cli-gateway-<ver>-<os>-<arch>
export RVWR_GATEWAY_BUNDLE_URL=<release-url>/llm-cli-gateway-bundle-<ver>-<os>-<arch>.tar.gz
export RVWR_GATEWAY_BUNDLE_SHA256=<bundle-sha256-from-SHA256SUMS>
./llm-cli-gateway-<ver>-<os>-<arch> setup
./llm-cli-gateway-<ver>-<os>-<arch> install-bundle
./llm-cli-gateway-<ver>-<os>-<arch> start
./llm-cli-gateway-<ver>-<os>-<arch> doctor
```

## Auth

| Gate                                                              | Evidence                                                                                                                   |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Bearer token required on the HTTP transport                       | `src/auth.ts:33-60` (rejects requests without/with wrong token); `src/__tests__/http-transport.test.ts` cases at 81/95/107 |
| Token is generated locally by `setup`, never pasted into chat     | `installer/internal/config/config.go:49-63`                                                                                |
| Doctor JSON reports `auth.token_configured` without echoing value | `src/doctor.ts:144-148`, redaction tested in `doctor.test.ts:161-168`                                                      |
| Universal install prompt forbids requesting tokens                | `setup/assistants/universal-install-prompt.md:15-20`                                                                       |
| `LLM_GATEWAY_AUTH_TOKEN` required to start HTTP transport         | doctor returns `ok=false` + next_action if missing; tested by `doctor.test.ts:114-126`                                     |

Quote-for-user:

```bash
# Generate locally; never paste into chat.
./llm-cli-gateway-<ver>-<os>-<arch> doctor --json | grep token_configured
# Expect: "token_configured": true
```

## Provider login

| Gate                                                                                   | Evidence                                                                                                                                                    |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider login status surfaced per CLI                                                 | `src/provider-status.ts` + doctor `providers.*.login_status`                                                                                                |
| Login guidance never asks for raw credentials                                          | `src/provider-login-guidance.ts`, asserted via assistant contract `setup/assistants/ASSISTANT_CONTRACT.md`                                                  |
| Missing or unauthenticated provider produces an actionable doctor `next_actions` entry | `src/doctor.ts:165-176`                                                                                                                                     |
| validate_with_models warns when a started provider has non-authenticated login         | `src/validation-orchestrator.ts:196-205`, tested in `validation-orchestrator.test.ts` ("warns when a started provider's login status is not authenticated") |

Quote-for-user:

```bash
./llm-cli-gateway-<ver>-<os>-<arch> doctor --json \
  | jq '.providers | to_entries | map({(.key): .value.login_status}) | add'
```

## Validation

| Gate                                                                                                                                                                                    | Evidence                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| validate_with_models, second_opinion, compare_answers, red_team_review, consensus_check, ask_model, synthesize_validation, list_available_models, job_status, job_result all registered | `src/validation-tools.ts:64-268`                                                                                        |
| Layer-4 orchestrator: fan-out + partial-failure preserved                                                                                                                               | `src/validation-orchestrator.ts`; tests in `validation-orchestrator.layer4.test.ts` + `validation-orchestrator.test.ts` |
| Layer-5 report: per-model verdicts, disagreements, confidence, limitations                                                                                                              | `src/validation-report.ts`; tests in `validation-report.layer5.test.ts` + `validation-report.test.ts`                   |
| Live dogfood: validate_with_models exercised end-to-end through the gateway                                                                                                             | DOGFOODING_RESULTS.md "Acceptance #2" + validation `3d214521-2302-46d3-bed6-677aa171e182`                               |

Quote-for-user:

```text
Ask the connected client: validate this sentence with two other models: gateway setup works.
```

## Upgrade

| Gate                                                                                 | Evidence                                                        |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `upgrade` command exists, stops the running gateway, rotates bundle, preserves auth  | `installer/main.go:107-131`                                     |
| Auth token is preserved (Ensure reads existing token without overwrite)              | `installer/internal/config/config.go:49-63`                     |
| Bundle replacement is atomic (rename of `gateway/` to `gateway.previous/` then swap) | `installer/main.go:240-274`                                     |
| User-facing upgrade procedure documented                                             | `installer/packaging/README.md` "Upgrade" section + `README.md` |

Quote-for-user:

```bash
RVWR_GATEWAY_BUNDLE_URL=... RVWR_GATEWAY_BUNDLE_SHA256=... \
  ./llm-cli-gateway-<new>-<os>-<arch> upgrade
./llm-cli-gateway-<new>-<os>-<arch> start
./llm-cli-gateway-<new>-<os>-<arch> doctor
```

## Uninstall

| Gate                                                       | Evidence                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------- |
| `uninstall` command exists; requires `--yes` to delete     | `installer/main.go:133-178`                                       |
| Dry-run by default; idempotent when app dir already absent | `installer/main.go:146-153, 160-167`                              |
| Stops the running gateway before removing the app dir      | `installer/main.go:155-158`                                       |
| Documented in packaging + README                           | `installer/packaging/README.md` "Uninstall" section + `README.md` |

Quote-for-user:

```bash
./llm-cli-gateway-<ver>-<os>-<arch> uninstall          # dry run
./llm-cli-gateway-<ver>-<os>-<arch> uninstall --yes    # commit
```

## Support diagnostics

| Gate                                                                      | Evidence                                                              |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `doctor --json` emits the schema documented in `setup/status.schema.json` | `src/doctor.ts:112-179`; schema asserted by `doctor.test.ts:100-112`  |
| Doctor redacts sensitive fields (tokens in URLs, userinfo, query strings) | `src/endpoint-exposure.ts:94-114`; tested in `doctor.test.ts:127-168` |
| Doctor next_actions are present even on a healthy gateway                 | `src/doctor.ts:172-176`; tested in `doctor.test.ts:170-176`           |
| Bootstrapper `print-client-config` does NOT echo the bearer token         | `installer/main.go:82-93` (headers: "Bearer <redacted>")              |
| Flight recorder logs every request/response by correlation ID             | `src/flight-recorder.ts`                                              |
| Setup UI exposes `/doctor` for the same JSON                              | `installer/internal/setupui/server.go` + `setup/ui/index.html`        |
| Machine-readable install plan for assistants                              | `setup/install-plan.dag.toml`                                         |
| Prompt pack for assistants                                                | `setup/assistants/*.md`                                               |

Quote-for-user:

```bash
./llm-cli-gateway-<ver>-<os>-<arch> doctor --json | jq '.'
# Or via the setup UI: http://127.0.0.1:3340/
```

## Security and supply-chain audit

| Gate                                                                   | Evidence                                                                                                                                                    |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm vulnerability audit is clean before release                        | `npm run security:audit` runs `npm audit --omit=dev --audit-level=moderate`                                                                                 |
| Production source contains no dynamic execution patterns               | `scripts/release-security-audit.sh` scans non-test `src/` files for `eval`, `.eval`, `Function`, and `new Function` usage                                   |
| Production source does not call better-sqlite3's dynamic PRAGMA helper | `scripts/release-security-audit.sh` scans non-test `src/` files for `.pragma()` calls; fixed SQLite setup uses literal `PRAGMA` SQL through `exec`          |
| Socket-flagged dependency versions are blocked in the repo lockfile    | `scripts/release-security-audit.sh` rejects `content-type@2.0.0`, `type-is@2.1.0`, `ioredis@5.10.1`, and `@ioredis/commands@1.5.1` in `package-lock.json`   |
| Published npm consumers resolve the same safe dependency tree          | `scripts/release-security-audit.sh` packs the package, installs it into a temporary consumer project, and rejects the blocked dependency versions there too |
| CI runs the same audit gate                                            | `.github/workflows/ci.yml` `build-and-test` job runs `npm run security:audit`                                                                               |

Socket capability alerts for network and shell access are expected for this
package: the gateway intentionally serves an MCP HTTP endpoint and launches
provider CLIs. Those alerts must be reviewed and documented for each release,
but they cannot be removed without removing the product's core behavior.

The `ioredis` `built/constants/TLSProfiles.js` "obfuscated code" alert is
reviewed as a false positive. The flagged strings are PEM-encoded Redis Cloud
TLS CA certificates, not hidden executable code; the file is static TLS profile
data and is byte-for-byte identical in `ioredis@5.9.2` and `ioredis@5.10.1`.
The package remains outside the default production install path as an optional
peer dependency for PostgreSQL/Redis session storage.

Quote-for-release:

```bash
npm run security:audit
npx socket@latest package score npm llm-cli-gateway@<ver> --markdown
```

The Socket score command uses Socket's API and may require a Socket token or
local `socket login`. If it cannot run in CI, attach the local/Socket dashboard
evidence to the release notes before publishing.

## Final readiness sign-off

The release topics above are gated on artifacts that exist in this commit
and were verified by:

- Build: `npm run build` clean.
- Lint: `npm run lint` 0 errors.
- Security/SCA: `npm run security:audit` clean.
- Unit + integration: 560 tests pass via `npx vitest run`.
- Release pipeline: `.github/workflows/release-installer.yml` builds
  platform binaries on the Linux self-hosted runner plus GitHub-hosted
  Windows/macOS runners; the final packaging job produces combined
  `SHA256SUMS`, Sigstore bundles, and a `release-manifest.json` with
  copy/paste setup commands.
- DAG validator: PASSED, 27 units, layers 0-12, `critical_path_loc=4060`.
- Dogfooding: two target LLMs guided setup without developer
  interpretation; one local-MCP-surface validation run completed
  end-to-end via the gateway's own validate_with_models tool.
- Reviewer gates: every previous layer's three-reviewer gate
  (Codex + Gemini + Grok) returned unconditional APPROVED.

Items intentionally deferred to follow-up tickets (post-MVP), recorded
in `DOGFOODING_RESULTS.md` Acceptance #3:

1. Overall-status enum on top of the existing `confidence` field.
2. `collect_validation` helper that re-renders the report over the
   user's already-collected terminal results in a single call.
3. Public-tunnel web-client live test (gated on user-supplied HTTPS
   endpoint; out of scope for offline release readiness).
4. Native platform signing (codesign / Authenticode); Sigstore keyless
   release-artifact signatures ship through the release workflow.

These do not block `OUT:mvp-release-candidate`; they are tracked here so
the next release planning session can pull them in explicitly.
