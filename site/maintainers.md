# Maintainer Operations

This page documents public workflow behavior for maintainers. It intentionally
does not contain secret values.

## Release Credentials

Workflows that need external service credentials, such as Cloudflare Pages and
provider token smoke checks, fetch them at runtime through GitHub OIDC,
Microsoft Entra, and Azure Key Vault. The repository stores workflow variables
such as client IDs, tenant IDs, vault names, and Key Vault secret names; it does
not store the secret values.

npm publishing uses npm Trusted Publishing instead: the GitHub-hosted job's OIDC
identity exchanges directly for short-lived npm publish credentials. No npm
publish token is fetched from or stored in Azure Key Vault.

The shared helper `.github/scripts/fetch-azure-keyvault-secrets.mjs` requests a
GitHub OIDC token, exchanges it with Entra for a Key Vault access token, masks
every fetched secret with GitHub Actions masking, and exports only the requested
environment variables to the job.

## npm Publish

The npm publish workflow runs on `release: published` or manual dispatch. A
manual run requires an explicit release tag and checks out that tag, so it never
publishes whichever revision happens to be the default branch. The workflow
validates the selected tag before checkout, verifies the trusted-publishing OIDC
exchange, builds and tests the package, generates the prod-only shrinkwrap, runs
the release security audit, strips internal MCP names from `dist`, verifies the
packed tarball, and publishes with scripts disabled.

## Website Deploy

`llm-cli-gateway.dev` is a direct-upload Cloudflare Pages project. It is not a
git-connected Pages site. The Pages workflow deploys `site/` only for a
published non-prerelease release on the public mirror. It checks out that
release tag, verifies it is the highest published stable release before reading
Pages credentials, builds the discovery verifier, verifies the stable site-version
contract and generated discovery files, fetches the Cloudflare Pages token from
Azure Key Vault, and deploys the production branch as `main`.

`package.json#publicSiteVersion` is the independent stable source of truth while
the package version is a prerelease. Stable release preparation advances that
field to the stable package version. The site checker compares every HTML,
OpenAPI, MCP discovery, and generated tools label against this package-owned
target, so the website cannot validate one stale label against another.

The deploy runs on the trusted self-hosted runner because the Cloudflare token is
restricted to an allowlisted egress IP.

## Search Indexing

The public site publishes `robots.txt` and `sitemap.xml` so Google, Bing, and
other crawlers can discover the current canonical URLs.

Google sitemap submission is managed through Google Search Console. Google no
longer supports unauthenticated sitemap ping submissions. The Pages deploy
workflow uses GitHub OIDC and Google Workload Identity Federation to request a
short-lived token for a repository-configured Google service account, then
submits `https://llm-cli-gateway.dev/sitemap.xml` for the
`https://llm-cli-gateway.dev/` URL-prefix property.

The service account is verified with the Google HTML file at
`/googleb0dea30e179d1a8e.html`. The repository stores only non-secret Google
project, workload-identity, service-account, site, and sitemap identifiers as
GitHub environment variables.

Bing submission is automated with IndexNow. The site hosts the public IndexNow
key file at `/3a9d0d7145a50e273758cb63918b496f.txt`, and the Pages deploy
workflow submits the URLs from `site/sitemap.xml` after each production deploy.

## LLM Provider Token Smoke

The LLM provider token smoke workflow is manual only. It fetches provider token
values from Azure Key Vault, verifies the expected environment variables are
present, builds the gateway, and runs `doctor --json` to confirm configured API
providers report `api_key_present = true`.

It does not call vendor model APIs or spend provider tokens.
