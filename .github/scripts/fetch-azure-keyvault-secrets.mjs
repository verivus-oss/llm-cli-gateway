#!/usr/bin/env node
import fs from "node:fs";

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const KEY_VAULT_SECRET_NAME_RE = /^[0-9A-Za-z-]{1,127}$/;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseSecretArgs(argv) {
  const pairs = new Map();
  for (const arg of argv) {
    const eq = arg.indexOf("=");
    if (eq <= 0 || eq === arg.length - 1) {
      throw new Error(`Secret mapping must be ENV_NAME=key-vault-secret-name, got: ${arg}`);
    }
    const envName = arg.slice(0, eq);
    const secretName = arg.slice(eq + 1);
    if (!ENV_NAME_RE.test(envName)) {
      throw new Error(`Invalid exported environment variable name: ${envName}`);
    }
    if (!KEY_VAULT_SECRET_NAME_RE.test(secretName)) {
      throw new Error(`Invalid Azure Key Vault secret name for ${envName}: ${secretName}`);
    }
    pairs.set(envName, secretName);
  }
  if (pairs.size === 0) {
    throw new Error("Provide at least one secret mapping as ENV_NAME=key-vault-secret-name");
  }
  return pairs;
}

async function jsonResponse(response, message) {
  if (!response.ok) {
    throw new Error(`${message}: HTTP ${response.status}`);
  }
  return response.json();
}

function appendGithubEnv(name, value) {
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error(
      `${name} contains a newline; refusing to write a multiline secret to GITHUB_ENV`
    );
  }
  fs.appendFileSync(requiredEnv("GITHUB_ENV"), `${name}=${value}\n`);
}

async function main() {
  const clientId = requiredEnv("AZURE_CLIENT_ID");
  const tenantId = requiredEnv("AZURE_TENANT_ID");
  const vaultName = requiredEnv("AZURE_KEY_VAULT_NAME");
  const oidcRequestToken = requiredEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
  const oidcRequestUrl = requiredEnv("ACTIONS_ID_TOKEN_REQUEST_URL");
  const secretMap = parseSecretArgs(process.argv.slice(2));

  const oidcUrl = new URL(oidcRequestUrl);
  oidcUrl.searchParams.set("audience", "api://AzureADTokenExchange");
  const oidc = await jsonResponse(
    await fetch(oidcUrl, { headers: { Authorization: `Bearer ${oidcRequestToken}` } }),
    "GitHub OIDC token request failed"
  );
  if (!oidc.value) {
    throw new Error("GitHub OIDC token response did not include a client assertion");
  }

  const tokenBody = new URLSearchParams({
    client_id: clientId,
    scope: "https://vault.azure.net/.default",
    grant_type: "client_credentials",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: oidc.value,
  });
  const aad = await jsonResponse(
    await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody,
    }),
    "Azure token exchange failed"
  );
  if (!aad.access_token) {
    throw new Error("Azure token exchange response did not include an access token");
  }

  for (const [envName, secretName] of secretMap) {
    const secretUrl = new URL(
      `https://${vaultName}.vault.azure.net/secrets/${encodeURIComponent(secretName)}`
    );
    secretUrl.searchParams.set("api-version", "7.4");
    const secret = await jsonResponse(
      await fetch(secretUrl, { headers: { Authorization: `Bearer ${aad.access_token}` } }),
      `Key Vault secret fetch failed for ${secretName}`
    );
    if (!secret.value) {
      throw new Error(`Azure Key Vault returned an empty value for ${secretName}`);
    }
    console.log(`::add-mask::${secret.value}`);
    appendGithubEnv(envName, secret.value);
    console.log(`Exported ${envName} from Key Vault secret ${secretName}`);
  }
}

await main();
