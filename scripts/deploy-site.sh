#!/usr/bin/env bash
# Deploy the static marketing site (site/) to its Cloudflare Pages project.
#
# llm-cli-gateway.dev is a DIRECT-UPLOAD Pages project (NOT git-connected), so a
# push to the repo or the public mirror does NOT rebuild it — the deploy is this
# explicit step. The Cloudflare token stays in Azure Key Vault and is fetched at
# run time; it is never committed, and never put into GitHub Actions secrets.
#
# Usage:
#   bash scripts/deploy-site.sh           # fetch token from Key Vault, deploy a stable release to production
#   CLOUDFLARE_API_TOKEN=<token> bash scripts/deploy-site.sh   # use a token you already exported
#
# Requires: an authenticated `az` CLI (for the Key Vault fetch), a prepared
# Node workspace (`npm ci`), and `npx`/wrangler.
# Run this from the checkout of the stable release tag to deploy. The script
# validates the public-site contract but deliberately does not select a Git ref.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PROJECT="llm-cli-gateway"
# Production branch of the Pages project. The git branch here is `master`, which
# wrangler would otherwise publish as a PREVIEW alias — `main` is what maps to
# the production domain (llm-cli-gateway.dev).
BRANCH="main"
: "${CLOUDFLARE_ACCOUNT_ID:=6e2be897d28f85da0d0551a8b462f851}"  # Account that owns the production Pages project.
export CLOUDFLARE_ACCOUNT_ID

# Discovery validation imports dist/, so rebuild it from this checkout before
# asserting that generated public artifacts describe the upload payload.
echo "==> building site discovery verifier"
npm run build

# Production Pages represents npm `latest`; reject an RC even if its static
# labels correctly retain the last stable version.
echo "==> verifying stable site version contract"
node scripts/sync-site-version.mjs --check --require-stable

echo "==> verifying generated site discovery files"
node scripts/generate-site-discovery.mjs --check
node scripts/validate-site-discovery.mjs

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "==> fetching Cloudflare Pages token from Azure Key Vault (verivus-dev-secrets-kv/cloudflare-pages-llm-cli-gateway-token)"
  CLOUDFLARE_API_TOKEN="$(az keyvault secret show \
    --vault-name verivus-dev-secrets-kv \
    --name cloudflare-pages-llm-cli-gateway-token \
    --query value -o tsv)"
fi
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "ERROR: no CLOUDFLARE_API_TOKEN (Key Vault fetch failed and none was exported)" >&2
  exit 1
fi
export CLOUDFLARE_API_TOKEN

echo "==> deploying site/ to Pages project '${PROJECT}' (branch ${BRANCH} = production)"
npx -y wrangler@4.100.0 pages deploy site \
  --project-name="${PROJECT}" \
  --branch="${BRANCH}" \
  --commit-dirty=true

echo "Done. Verify: curl -s https://llm-cli-gateway.dev/ | grep -o 'llm-cli-gateway v[0-9.]*'"
