#!/usr/bin/env bash
# Deploy the static marketing site (site/) to its Cloudflare Pages project.
#
# llm-cli-gateway.dev is a DIRECT-UPLOAD Pages project (NOT git-connected), so a
# push to the repo or the public mirror does NOT rebuild it — the deploy is this
# explicit step. The Cloudflare token stays in Azure Key Vault and is fetched at
# run time; it is never committed, and never put into GitHub Actions secrets.
#
# Usage:
#   bash scripts/deploy-site.sh           # fetch token from Key Vault, deploy to production
#   CLOUDFLARE_API_TOKEN=… bash scripts/deploy-site.sh   # use a token you already exported
#
# Requires: an authenticated `az` CLI (for the Key Vault fetch) and `npx`/wrangler.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PROJECT="llm-cli-gateway"
# Production branch of the Pages project. The git branch here is `master`, which
# wrangler would otherwise publish as a PREVIEW alias — `main` is what maps to
# the production domain (llm-cli-gateway.dev).
BRANCH="main"
: "${CLOUDFLARE_ACCOUNT_ID:=6e2be897d28f85da0d0551a8b462f851}"  # Wernerk@itee.com.au account
export CLOUDFLARE_ACCOUNT_ID

# Never ship a site whose version disagrees with package.json.
echo "==> verifying site version matches package.json"
node scripts/sync-site-version.mjs --check

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "==> fetching Cloudflare token from Azure Key Vault (verivus-dev-secrets-kv/cloudflare-api-token)"
  CLOUDFLARE_API_TOKEN="$(az keyvault secret show \
    --vault-name verivus-dev-secrets-kv \
    --name cloudflare-api-token \
    --query value -o tsv)"
fi
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "ERROR: no CLOUDFLARE_API_TOKEN (Key Vault fetch failed and none was exported)" >&2
  exit 1
fi
export CLOUDFLARE_API_TOKEN

echo "==> deploying site/ to Pages project '${PROJECT}' (branch ${BRANCH} = production)"
npx --no-install wrangler pages deploy site \
  --project-name="${PROJECT}" \
  --branch="${BRANCH}" \
  --commit-dirty=true

echo "Done. Verify: curl -s https://llm-cli-gateway.dev/ | grep -o 'llm-cli-gateway v[0-9.]*'"
