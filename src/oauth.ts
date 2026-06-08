import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { URLSearchParams } from "node:url";
import type { Logger } from "./logger.js";
import {
  issueOAuthAccessToken,
  timingSafeStringEqual,
  type RemoteOAuthClientConfig,
  type RemoteOAuthConfig,
} from "./auth.js";

export interface OAuthServerOptions {
  protectedPath: string;
  config: RemoteOAuthConfig;
  logger?: Logger;
}

export interface OAuthRequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  baseUrl: string;
}

interface OAuthCodeEntry {
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  expiresAt: number;
}

interface RuntimeOAuthClient {
  clientId: string;
  clientSecretHash: string | null;
  redirectUris: Set<string>;
  scopes: Set<string>;
  issuedAt: number;
  publicClient: boolean;
}

interface OAuthRequestBody {
  params: URLSearchParams;
  json: Record<string, unknown>;
}

export const OAUTH_CODE_TTL_MS = 5 * 60 * 1000;
const GENERATED_SECRET_BYTES = 32;
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export function generateSecret(bytes = GENERATED_SECRET_BYTES): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(secret, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt:N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}:${salt.toString("base64url")}:${hash.toString("base64url")}`;
}

export function isSecretHash(value: string): boolean {
  return /^scrypt:N=\d+,r=\d+,p=\d+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(value);
}

export function verifySecret(secret: string, encodedHash: string): boolean {
  const parts = encodedHash.split(":");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const params = Object.fromEntries(
    parts[1].split(",").map(entry => {
      const [key, value] = entry.split("=");
      return [key, Number(value)];
    })
  ) as { N?: number; r?: number; p?: number };
  if (!params.N || !params.r || !params.p) return false;
  const salt = Buffer.from(parts[2], "base64url");
  const expected = Buffer.from(parts[3], "base64url");
  const actual = scryptSync(secret, salt, expected.length, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: SCRYPT_MAXMEM,
  });
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function redactSecret(value: string | null | undefined): string | null {
  return value ? "<redacted>" : null;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function methodNotAllowed(res: ServerResponse): void {
  res.writeHead(405, { allow: "GET, POST", "content-type": "application/json" });
  res.end(JSON.stringify({ error: "Method not allowed" }));
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function isHttpsOrLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

export function isLocalHost(host: string): boolean {
  const hostname = host.split(":")[0]?.toLowerCase() ?? "";
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function oauthBaseUrlFromRequest(
  req: IncomingMessage,
  config: RemoteOAuthConfig
): string | null {
  if (config.issuer && config.issuer !== "auto") {
    try {
      return new URL(config.issuer).origin;
    } catch {
      return null;
    }
  }
  const configured = process.env.LLM_GATEWAY_PUBLIC_URL;
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      return null;
    }
  }
  const host = firstHeader(req.headers.host) ?? "127.0.0.1:3333";
  if (!isLocalHost(host)) return null;
  return `http://${host}`;
}

function extractStringArray(value: unknown, params: URLSearchParams, key: string): string[] {
  const values = Array.isArray(value) ? value : params.getAll(key);
  return values.filter((item): item is string => typeof item === "string" && item.length > 0);
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("error", reject);
    req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks).toString("utf8") : ""));
  });
}

async function readOAuthBody(req: IncomingMessage): Promise<OAuthRequestBody> {
  const raw = await readRawBody(req);
  const contentType = firstHeader(req.headers["content-type"]) ?? "";
  if (contentType.includes("application/json")) {
    const parsed = JSON.parse(raw || "{}") as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") params.set(key, value);
      else if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string") params.append(key, item);
        }
      }
    }
    return { params, json: parsed };
  }
  return { params: new URLSearchParams(raw), json: {} };
}

function basicClientCredentials(
  req: IncomingMessage
): { clientId: string; clientSecret: string } | null {
  const authorization = firstHeader(req.headers.authorization);
  if (!authorization?.startsWith("Basic ")) return null;
  const raw = Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8");
  const separator = raw.indexOf(":");
  if (separator < 0) return null;
  return {
    clientId: decodeURIComponent(raw.slice(0, separator)),
    clientSecret: decodeURIComponent(raw.slice(separator + 1)),
  };
}

function oauthClientSecret(req: IncomingMessage, params: URLSearchParams): string | null {
  return params.get("client_secret") ?? basicClientCredentials(req)?.clientSecret ?? null;
}

function oauthClientId(req: IncomingMessage, params: URLSearchParams): string | null {
  return params.get("client_id") ?? basicClientCredentials(req)?.clientId ?? null;
}

function validPkceVerifier(
  verifier: string | null,
  challenge: string | null,
  method: string | null
): boolean {
  if (!challenge) return true;
  if (!verifier) return false;
  if (method === "S256") {
    const digest = createHash("sha256").update(verifier).digest("base64url");
    return timingSafeStringEqual(digest, challenge);
  }
  if (!method || method === "plain") {
    return timingSafeStringEqual(verifier, challenge);
  }
  return false;
}

function oauthErrorRedirect(redirectUri: string, error: string, state: string | null): string {
  const target = new URL(redirectUri);
  target.searchParams.set("error", error);
  if (state) target.searchParams.set("state", state);
  return target.toString();
}

function normalizeScopes(scope: string | null): string[] {
  const scopes = (scope ?? "mcp")
    .split(/\s+/)
    .map(item => item.trim())
    .filter(Boolean);
  return [...new Set(scopes.length ? scopes : ["mcp"])];
}

function scopesAllowed(requested: string[], client: RuntimeOAuthClient): boolean {
  return requested.every(scope => client.scopes.has(scope));
}

function toRuntimeClient(
  client: RemoteOAuthClientConfig,
  allowPublicClients: boolean
): RuntimeOAuthClient {
  return {
    clientId: client.clientId,
    clientSecretHash: client.clientSecretHash ?? null,
    redirectUris: new Set(client.allowedRedirectUris),
    scopes: new Set(client.scopes.length ? client.scopes : ["mcp"]),
    issuedAt: Math.floor(Date.now() / 1000),
    publicClient: allowPublicClients && !client.clientSecretHash,
  };
}

export class OAuthServer {
  private readonly codes = new Map<string, OAuthCodeEntry>();
  private readonly clients = new Map<string, RuntimeOAuthClient>();

  constructor(private readonly opts: OAuthServerOptions) {
    for (const client of opts.config.clients) {
      this.clients.set(client.clientId, toRuntimeClient(client, opts.config.allowPublicClients));
    }
  }

  resourceMetadataUrl(baseUrl: string): string {
    return `${baseUrl}/.well-known/oauth-protected-resource`;
  }

  isOAuthPath(pathname: string): boolean {
    return (
      pathname.startsWith("/.well-known/oauth-protected-resource") ||
      pathname.startsWith("/.well-known/oauth-authorization-server") ||
      pathname === "/.well-known/openid-configuration" ||
      pathname.startsWith("/oauth/")
    );
  }

  async handle(ctx: OAuthRequestContext): Promise<boolean> {
    const { req, res, url, baseUrl } = ctx;
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      if (req.method !== "GET") {
        methodNotAllowed(res);
        return true;
      }
      jsonResponse(res, 200, this.protectedResourceMetadata(baseUrl));
      return true;
    }
    if (
      url.pathname.startsWith("/.well-known/oauth-authorization-server") ||
      url.pathname === "/.well-known/openid-configuration"
    ) {
      if (req.method !== "GET") {
        methodNotAllowed(res);
        return true;
      }
      jsonResponse(res, 200, this.authorizationServerMetadata(baseUrl));
      return true;
    }
    if (url.pathname === "/oauth/register") {
      await this.handleRegister(req, res);
      return true;
    }
    if (url.pathname === "/oauth/authorize") {
      await this.handleAuthorize(req, res);
      return true;
    }
    if (url.pathname === "/oauth/token") {
      await this.handleToken(req, res);
      return true;
    }
    return false;
  }

  private protectedResourceMetadata(baseUrl: string): Record<string, unknown> {
    return {
      resource: `${baseUrl}${this.opts.protectedPath}`,
      authorization_servers: [baseUrl],
      scopes_supported: ["mcp", "workspace:admin"],
      bearer_methods_supported: ["header"],
    };
  }

  private authorizationServerMetadata(baseUrl: string): Record<string, unknown> {
    return {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      token_endpoint_auth_methods_supported: this.opts.config.allowPublicClients
        ? ["client_secret_post", "client_secret_basic", "none"]
        : ["client_secret_post", "client_secret_basic"],
      code_challenge_methods_supported: this.opts.config.allowPlainPkce
        ? ["S256", "plain"]
        : ["S256"],
      scopes_supported: ["mcp", "workspace:admin"],
    };
  }

  private registrationAllowedByPolicy(req: IncomingMessage, params: URLSearchParams): boolean {
    const policy = this.opts.config.registrationPolicy;
    if (policy === "open_dev") {
      const host = firstHeader(req.headers.host) ?? "";
      return isLocalHost(host) || process.env.LLM_GATEWAY_OAUTH_OPEN_DEV === "1";
    }
    if (policy === "static_clients") return false;
    const supplied = params.get("shared_secret") ?? params.get("registration_secret");
    if (!supplied || supplied.includes("?")) return false;
    const hash = this.opts.config.sharedSecret?.enabled
      ? this.opts.config.sharedSecret.secretHash
      : null;
    return Boolean(hash && verifySecret(supplied, hash));
  }

  private async handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }
    const { params, json } = await readOAuthBody(req);
    if (new URL(req.url ?? "/", "http://localhost").searchParams.has("shared_secret")) {
      jsonResponse(res, 400, { error: "invalid_request" });
      return;
    }
    if (!this.registrationAllowedByPolicy(req, params)) {
      jsonResponse(res, 403, { error: "invalid_client" });
      return;
    }
    const redirectUris = extractStringArray(json.redirect_uris, params, "redirect_uris");
    if (redirectUris.length === 0 || redirectUris.some(uri => !isHttpsOrLoopbackUrl(uri))) {
      jsonResponse(res, 400, { error: "invalid_redirect_uri" });
      return;
    }
    const clientId = `llm-cli-gateway-${randomUUID()}`;
    const clientSecret = this.opts.config.allowPublicClients ? null : generateSecret();
    const issuedAt = Math.floor(Date.now() / 1000);
    this.clients.set(clientId, {
      clientId,
      clientSecretHash: clientSecret ? hashSecret(clientSecret) : null,
      redirectUris: new Set(redirectUris),
      scopes: new Set(["mcp"]),
      issuedAt,
      publicClient: !clientSecret,
    });
    jsonResponse(res, 201, {
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      client_id_issued_at: issuedAt,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      redirect_uris: redirectUris,
      token_endpoint_auth_method: clientSecret ? "client_secret_post" : "none",
      scope: "mcp",
    });
  }

  private async handleAuthorize(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "GET" && req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }
    const params =
      req.method === "POST"
        ? (await readOAuthBody(req)).params
        : new URL(req.url ?? "/", "http://localhost").searchParams;
    if (params.has("shared_secret")) {
      jsonResponse(res, 400, { error: "invalid_request" });
      return;
    }
    const responseType = params.get("response_type");
    const clientId = params.get("client_id") ?? "";
    const redirectUri = params.get("redirect_uri");
    const state = params.get("state");
    if (!redirectUri) {
      jsonResponse(res, 400, { error: "invalid_request" });
      return;
    }
    const client = this.clients.get(clientId);
    if (!client || !client.redirectUris.has(redirectUri)) {
      jsonResponse(res, 400, { error: "invalid_request" });
      return;
    }
    const method = params.get("code_challenge_method");
    const codeChallenge = params.get("code_challenge");
    if (
      responseType !== "code" ||
      (this.opts.config.requirePkce && !codeChallenge) ||
      (codeChallenge &&
        method !== "S256" &&
        !(this.opts.config.allowPlainPkce && method === "plain"))
    ) {
      res.writeHead(302, {
        location: oauthErrorRedirect(redirectUri, "invalid_request", state),
      });
      res.end();
      return;
    }
    const requestedScopes = normalizeScopes(params.get("scope"));
    if (!scopesAllowed(requestedScopes, client)) {
      res.writeHead(302, {
        location: oauthErrorRedirect(redirectUri, "invalid_scope", state),
      });
      res.end();
      return;
    }
    this.pruneExpiredCodes();
    const code = randomUUID();
    this.codes.set(code, {
      clientId,
      redirectUri,
      scope: requestedScopes.join(" "),
      codeChallenge,
      codeChallengeMethod: method,
      expiresAt: Date.now() + OAUTH_CODE_TTL_MS,
    });
    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    if (state) target.searchParams.set("state", state);
    res.writeHead(302, { location: target.toString() });
    res.end();
  }

  private async handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }
    if (new URL(req.url ?? "/", "http://localhost").searchParams.has("client_secret")) {
      jsonResponse(res, 400, { error: "invalid_request" });
      return;
    }
    const { params } = await readOAuthBody(req);
    const code = params.get("code") ?? "";
    const entry = this.codes.get(code);
    const clientId = oauthClientId(req, params);
    const client = clientId ? this.clients.get(clientId) : undefined;
    const clientSecret = oauthClientSecret(req, params);
    const secretOk =
      client?.publicClient ||
      Boolean(
        client?.clientSecretHash &&
        clientSecret &&
        verifySecret(clientSecret, client.clientSecretHash)
      );
    if (
      params.get("grant_type") !== "authorization_code" ||
      !entry ||
      entry.expiresAt < Date.now() ||
      !client ||
      client.clientId !== entry.clientId ||
      !secretOk ||
      params.get("redirect_uri") !== entry.redirectUri ||
      !validPkceVerifier(
        params.get("code_verifier"),
        entry.codeChallenge,
        entry.codeChallengeMethod
      )
    ) {
      jsonResponse(res, 400, { error: "invalid_grant" });
      return;
    }
    this.codes.delete(code);
    const token = issueOAuthAccessToken({
      clientId: client.clientId,
      scopes: normalizeScopes(entry.scope),
      ttlSeconds: this.opts.config.tokenTtlSeconds,
    });
    jsonResponse(res, 200, {
      access_token: token.accessToken,
      token_type: "Bearer",
      expires_in: token.expiresIn,
      scope: token.scope,
    });
  }

  private pruneExpiredCodes(now = Date.now()): void {
    for (const [code, entry] of this.codes) {
      if (entry.expiresAt < now) this.codes.delete(code);
    }
  }
}
