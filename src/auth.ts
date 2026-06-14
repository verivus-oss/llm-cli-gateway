import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface AuthConfig {
  required: boolean;
  tokenConfigured: boolean;
  source: "env" | "disabled";
}

export interface AuthResult {
  ok: boolean;
  status?: number;
  message?: string;
  kind?: "disabled" | "gateway_bearer" | "oauth";
  scopes?: string[];
  clientId?: string;
}

export type OAuthRegistrationPolicy = "static_clients" | "shared_secret" | "open_dev";

export interface RemoteOAuthClientConfig {
  clientId: string;
  clientSecretHash: string | null;
  allowedRedirectUris: string[];
  scopes: string[];
}

export interface RemoteOAuthSharedSecretConfig {
  enabled: boolean;
  secretHash: string | null;
  promptLabel: string;
}

export interface RemoteOAuthConfig {
  enabled: boolean;
  issuer: string | "auto";
  requirePkce: boolean;
  allowPlainPkce: boolean;
  registrationPolicy: OAuthRegistrationPolicy;
  allowPublicClients: boolean;
  tokenTtlSeconds: number;
  clients: RemoteOAuthClientConfig[];
  sharedSecret: RemoteOAuthSharedSecretConfig | null;
  sources: { configFile: string | null; envOverrides: string[] };
}

const AUTH_SCHEME = "Bearer ";
const OAUTH_ACCESS_TOKEN_BYTES = 32;

interface OAuthAccessTokenEntry {
  clientId: string;
  scopes: string[];
  issuedAt: number;
  expiresAt: number;
}

const oauthAccessTokens = new Map<string, OAuthAccessTokenEntry>();

export function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const token = env.LLM_GATEWAY_AUTH_TOKEN;
  const disabled = env.LLM_GATEWAY_AUTH_DISABLED === "1";
  return {
    required: !disabled,
    tokenConfigured: Boolean(token),
    source: disabled ? "disabled" : "env",
  };
}

export function getRequiredBearerToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const config = loadAuthConfig(env);
  if (!config.required) return null;
  return env.LLM_GATEWAY_AUTH_TOKEN || null;
}

export function issueOAuthAccessToken(args: {
  clientId: string;
  scopes: string[];
  ttlSeconds: number;
  now?: number;
}): { accessToken: string; expiresIn: number; scope: string } {
  const now = args.now ?? Date.now();
  const ttlSeconds = Math.max(1, Math.floor(args.ttlSeconds));
  const scopes = [...new Set(args.scopes.length ? args.scopes : ["mcp"])];
  const accessToken = `oauth_${randomBytes(OAUTH_ACCESS_TOKEN_BYTES).toString("base64url")}`;
  oauthAccessTokens.set(accessToken, {
    clientId: args.clientId,
    scopes,
    issuedAt: now,
    expiresAt: now + ttlSeconds * 1000,
  });
  return { accessToken, expiresIn: ttlSeconds, scope: scopes.join(" ") };
}

function validateOAuthAccessToken(token: string, now = Date.now()): OAuthAccessTokenEntry | null {
  const entry = oauthAccessTokens.get(token);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    oauthAccessTokens.delete(token);
    return null;
  }
  return entry;
}

export function authorizeBearerRequest(
  req: IncomingMessage,
  token: string | null = getRequiredBearerToken()
): AuthResult {
  if (!loadAuthConfig().required) {
    return { ok: true, kind: "disabled", scopes: [] };
  }

  const header = req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !value.startsWith(AUTH_SCHEME)) {
    return { ok: false, status: 401, message: "Unauthorized" };
  }

  const supplied = value.slice(AUTH_SCHEME.length);
  if (token && timingSafeStringEqual(supplied, token)) {
    return { ok: true, kind: "gateway_bearer", scopes: [] };
  }

  const oauthToken = validateOAuthAccessToken(supplied);
  if (oauthToken) {
    return {
      ok: true,
      kind: "oauth",
      scopes: oauthToken.scopes,
      clientId: oauthToken.clientId,
    };
  }

  if (!token) {
    return {
      ok: false,
      status: 503,
      message: "HTTP transport requires LLM_GATEWAY_AUTH_TOKEN",
    };
  }

  return { ok: false, status: 401, message: "Unauthorized" };
}

// F14 trusted-principal-header seam. An identity-aware front door (any IdP)
// authenticates the user and forwards their identity in a header, then proxies
// to the gateway as the shared static bearer. We trust that header ONLY when the
// caller authenticated as the gateway's own static bearer (`gateway_bearer`) —
// i.e. it came from the trusted upstream, not an arbitrary remote client — and
// only when the operator has named the header (opt-in). The value is sanitised
// to a conservative principal charset to avoid log/identity injection.
const TRUSTED_PRINCIPAL_PATTERN = /^[A-Za-z0-9._@:+=/-]{1,256}$/;

export function trustedPrincipalHeaderName(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.LLM_GATEWAY_TRUSTED_PRINCIPAL_HEADER || "").trim().toLowerCase();
  return raw || null;
}

export function resolveTrustedPrincipal(
  req: IncomingMessage,
  auth: AuthResult,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const headerName = trustedPrincipalHeaderName(env);
  if (!headerName || auth.kind !== "gateway_bearer") return undefined;
  const raw = req.headers[headerName];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  const trimmed = value.trim();
  return TRUSTED_PRINCIPAL_PATTERN.test(trimmed) ? trimmed : undefined;
}

export function writeAuthFailure(
  res: ServerResponse,
  result: AuthResult,
  options: { resourceMetadataUrl?: string } = {}
): void {
  const status = result.status ?? 401;
  let wwwAuthenticate = 'Bearer realm="llm-cli-gateway"';
  if (options.resourceMetadataUrl) {
    wwwAuthenticate += `, resource_metadata="${options.resourceMetadataUrl}"`;
  }
  res.writeHead(status, {
    "content-type": "application/json",
    "www-authenticate": wwwAuthenticate,
  });
  res.end(JSON.stringify({ error: result.message || "Unauthorized" }));
}
