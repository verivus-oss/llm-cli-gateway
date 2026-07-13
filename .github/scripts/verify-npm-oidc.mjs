import fs from "node:fs";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function responseJson(response, operation) {
  if (!response.ok) {
    throw new Error(`${operation} failed: HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${operation} returned invalid JSON`);
  }
}

const manifest = JSON.parse(
  fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")
);
if (typeof manifest.name !== "string" || manifest.name.length === 0) {
  throw new Error("package.json must contain a package name");
}

const idTokenRequestUrl = new URL(requiredEnv("ACTIONS_ID_TOKEN_REQUEST_URL"));
idTokenRequestUrl.searchParams.set("audience", "npm:registry.npmjs.org");
const idTokenResponse = await fetch(idTokenRequestUrl, {
  headers: {
    Accept: "application/json",
    Authorization: `Bearer ${requiredEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN")}`,
  },
});
const { value: idToken } = await responseJson(idTokenResponse, "GitHub OIDC token request");
if (typeof idToken !== "string" || idToken.length === 0) {
  throw new Error("GitHub OIDC token request returned no token");
}

const exchangeUrl = new URL(
  `/-/npm/v1/oidc/token/exchange/package/${encodeURIComponent(manifest.name)}`,
  "https://registry.npmjs.org"
);
const exchangeResponse = await fetch(exchangeUrl, {
  method: "POST",
  headers: {
    Accept: "application/json",
    Authorization: `Bearer ${idToken}`,
  },
});
const { token } = await responseJson(exchangeResponse, "npm OIDC token exchange");
if (typeof token !== "string" || token.length === 0) {
  throw new Error("npm OIDC token exchange returned no token");
}

console.log(`Verified npm OIDC exchange for ${manifest.name}.`);
