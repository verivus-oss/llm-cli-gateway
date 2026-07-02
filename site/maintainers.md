# Maintainer Operations

This page documents public workflow behavior for maintainers. It intentionally
does not contain secret values.

## Release Credentials

Release workflows fetch publish credentials at runtime through GitHub OIDC,
Microsoft Entra, and Azure Key Vault. The repository stores workflow variables
such as client IDs, tenant IDs, vault names, and Key Vault secret names; it does
not store the secret values.

The shared helper `.github/scripts/fetch-azure-keyvault-secrets.mjs` requests a
GitHub OIDC token, exchanges it with Entra for a Key Vault access token, masks
every fetched secret with GitHub Actions masking, and exports only the requested
environment variables to the job.

## npm Publish

The npm publish workflow runs on `release: published` or manual dispatch. It
fetches `NODE_AUTH_TOKEN` from Azure Key Vault, builds the package, generates
the prod-only shrinkwrap, runs the release security audit, strips internal MCP
names from `dist`, verifies the packed tarball, and publishes with scripts
disabled.

## Website Deploy

`llm-cli-gateway.dev` is a direct-upload Cloudflare Pages project. It is not a
git-connected Pages site. The Pages workflow deploys `site/` on
`release: published` or manual dispatch, verifies the hard-coded site version
matches `package.json`, fetches the Cloudflare Pages token from Azure Key Vault,
and deploys the production branch as `main`.

The deploy runs on the trusted self-hosted runner because the Cloudflare token is
restricted to an allowlisted egress IP.

## LLM Provider Token Smoke

The LLM provider token smoke workflow is manual only. It fetches provider token
values from Azure Key Vault, verifies the expected environment variables are
present, builds the gateway, and runs `doctor --json` to confirm configured API
providers report `api_key_present = true`.

It does not call vendor model APIs or spend provider tokens.
