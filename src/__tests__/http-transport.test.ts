import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { request } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashSecret } from "../oauth.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpGateway, type HttpGatewayHandle } from "../http-transport.js";
import { getRequestContext } from "../request-context.js";

// Layer 6 / U20: HTTP MCP transport coverage with mocked gateway server.
//
// We construct a minimal McpServer that exposes a single deterministic tool
// (echo) so we can exercise the real Streamable HTTP transport, real bearer
// auth, real session lifecycle, and real shutdown without spawning provider
// CLIs.

const TEST_TOKEN = "test-bearer-XYZ-987"; // gitleaks:allow — deliberate test fixture token, not a real secret
const TEST_OAUTH_SHARED_SECRET = "oauth-registration-secret-test"; // gitleaks:allow
const ORIGINAL_ENV = { ...process.env };

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function makeEchoServer(): McpServer {
  const server = new McpServer({ name: "echo-test-server", version: "0.0.1" });
  server.tool("echo", { value: z.string().describe("Value to echo back.") }, async ({ value }) => ({
    content: [{ type: "text" as const, text: `echo:${value}` }],
    structuredContent: { value, requestContext: getRequestContext() ?? null },
  }));
  return server;
}

function withAuth(token: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  };
}

async function startGateway(): Promise<HttpGatewayHandle> {
  return startHttpGateway({
    host: "127.0.0.1",
    port: 0, // ephemeral
    path: "/mcp",
    createGatewayServer: () => makeEchoServer(),
  });
}

function httpGetWithHost(
  target: URL,
  hostHeader: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      target,
      {
        method: "GET",
        headers: { host: hostHeader },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function parseSseOrJson(body: string): any {
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  // Streamable HTTP returns server-sent events: "event:" / "data: <json>".
  const dataLine = trimmed.split(/\r?\n/).find(line => line.startsWith("data:"));
  if (!dataLine) {
    throw new Error(`No JSON payload in response body: ${body}`);
  }
  return JSON.parse(dataLine.slice("data:".length).trim());
}

describe("Layer 6 HTTP MCP transport (U20)", () => {
  let gateway: HttpGatewayHandle | null = null;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, LLM_GATEWAY_AUTH_TOKEN: TEST_TOKEN };
    delete process.env.LLM_GATEWAY_AUTH_DISABLED;
    delete process.env.LLM_GATEWAY_NO_AUTH_PATHS;
    delete process.env.LLM_GATEWAY_OAUTH_ENABLED;
    delete process.env.LLM_GATEWAY_PUBLIC_URL;
    delete process.env.LLM_GATEWAY_OAUTH_REGISTRATION_SECRET;
    delete process.env.LLM_GATEWAY_OAUTH_SHARED_SECRET;
    delete process.env.LLM_GATEWAY_CONFIG;
    delete process.env.LLM_GATEWAY_OAUTH_OPEN_DEV;
    delete process.env.LLM_GATEWAY_HTTP_HOST;
    delete process.env.LLM_GATEWAY_TRUSTED_PRINCIPAL_HEADER;
    delete process.env.LLM_GATEWAY_OAUTH_REQUIRE_CONSENT;
    delete process.env.LLM_GATEWAY_OAUTH_CONSENT_SECRET;
  });

  function writeOAuthConfig(lines: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "f17-oauth-"));
    const cfg = join(dir, "config.toml");
    writeFileSync(cfg, lines.join("\n"));
    process.env.LLM_GATEWAY_CONFIG = cfg;
    return dir;
  }

  it("refuses to start public-client OAuth on a non-loopback bind (F17)", async () => {
    const dir = writeOAuthConfig([
      "[http.oauth]",
      "enabled = true",
      "allow_public_clients = true",
      "",
    ]);
    try {
      await expect(
        startHttpGateway({
          host: "0.0.0.0",
          port: 0,
          path: "/mcp",
          createGatewayServer: () => makeEchoServer(),
        })
      ).rejects.toThrow(/Refusing to start/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows public-client OAuth on a loopback bind (F17)", async () => {
    const dir = writeOAuthConfig([
      "[http.oauth]",
      "enabled = true",
      "allow_public_clients = true",
      "",
    ]);
    try {
      gateway = await startHttpGateway({
        host: "127.0.0.1",
        port: 0,
        path: "/mcp",
        createGatewayServer: () => makeEchoServer(),
      });
      expect(gateway.url).toContain("127.0.0.1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("open_dev registration is env-gated, not Host-header inferred (F17)", async () => {
    const dir = writeOAuthConfig([
      "[http.oauth]",
      "enabled = true",
      'registration_policy = "open_dev"',
      "",
    ]);
    process.env.LLM_GATEWAY_PUBLIC_URL = "https://gateway.example.test/mcp";
    try {
      // Loopback bind so the F17 fail-closed guard does not trip.
      gateway = await startHttpGateway({
        host: "127.0.0.1",
        port: 0,
        path: "/mcp",
        createGatewayServer: () => makeEchoServer(),
      });
      const body = JSON.stringify({ redirect_uris: ["https://chat.openai.com/aip/callback"] });
      // Without the explicit operator opt-in, registration is refused — the Host
      // header (whatever fetch sends) is no longer trusted to mean "local".
      const denied = await fetch(new URL("/oauth/register", gateway.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(denied.status).toBe(403);

      // With the explicit opt-in, the same request is accepted.
      process.env.LLM_GATEWAY_OAUTH_OPEN_DEV = "1";
      const allowed = await fetch(new URL("/oauth/register", gateway.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(allowed.status).toBe(201);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // F14b consent-gate fixtures: a registered confidential client + consent secret.
  function startConsentGateway(): Promise<HttpGatewayHandle> {
    const dir = mkdtempSync(join(tmpdir(), "f14b-consent-"));
    const cfg = join(dir, "config.toml");
    writeFileSync(
      cfg,
      [
        "[http.oauth]",
        "enabled = true",
        "require_consent = true",
        `consent_secret_hash = "${hashSecret("approve-me")}"`,
        "",
        "[[http.oauth.clients]]",
        'client_id = "test-client"',
        `client_secret_hash = "${hashSecret("client-secret")}"`,
        'allowed_redirect_uris = ["https://app.example/cb"]',
        'scopes = ["mcp"]',
        "",
      ].join("\n")
    );
    process.env.LLM_GATEWAY_CONFIG = cfg;
    process.env.LLM_GATEWAY_PUBLIC_URL = "https://gw.example.test/mcp";
    return startGateway();
  }

  function authorizeQuery(challenge: string): URLSearchParams {
    return new URLSearchParams({
      response_type: "code",
      client_id: "test-client",
      redirect_uri: "https://app.example/cb",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp",
      state: "xyz",
    });
  }

  it("renders a consent page instead of issuing a code when require_consent is set (F14b)", async () => {
    gateway = await startConsentGateway();
    const { challenge } = { challenge: pkceChallenge("verifier-" + "a".repeat(48)) };
    const res = await fetch(
      new URL(`/oauth/authorize?${authorizeQuery(challenge).toString()}`, gateway.url),
      { redirect: "manual" }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("set-cookie") ?? "").toContain("gw_oauth_csrf=");
    const html = await res.text();
    expect(html).toContain("Authorize access");
    expect(html).toContain("test-client");
    // No authorization code is issued on the GET render.
    expect(html).not.toContain("code=");
  });

  it("issues a code only after a valid consent submission (F14b)", async () => {
    gateway = await startConsentGateway();
    const challenge = pkceChallenge("verifier-" + "b".repeat(48));
    const page = await fetch(
      new URL(`/oauth/authorize?${authorizeQuery(challenge).toString()}`, gateway.url),
      { redirect: "manual" }
    );
    const csrf = /gw_oauth_csrf=([^;]+)/.exec(page.headers.get("set-cookie") ?? "")?.[1] ?? "";
    expect(csrf).not.toBe("");

    const form = authorizeQuery(challenge);
    form.set("gw_consent", "1");
    form.set("gw_csrf", csrf);
    form.set("consent_secret", "approve-me");
    const approved = await fetch(new URL("/oauth/authorize", gateway.url), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `gw_oauth_csrf=${csrf}`,
      },
      body: form.toString(),
      redirect: "manual",
    });
    expect(approved.status).toBe(302);
    const location = approved.headers.get("location") ?? "";
    expect(location).toContain("https://app.example/cb?");
    expect(location).toContain("code=");
  });

  it("rejects a consent submission with the wrong access code (F14b)", async () => {
    gateway = await startConsentGateway();
    const challenge = pkceChallenge("verifier-" + "c".repeat(48));
    const page = await fetch(
      new URL(`/oauth/authorize?${authorizeQuery(challenge).toString()}`, gateway.url),
      { redirect: "manual" }
    );
    const csrf = /gw_oauth_csrf=([^;]+)/.exec(page.headers.get("set-cookie") ?? "")?.[1] ?? "";

    const form = authorizeQuery(challenge);
    form.set("gw_consent", "1");
    form.set("gw_csrf", csrf);
    form.set("consent_secret", "wrong-code");
    const rejected = await fetch(new URL("/oauth/authorize", gateway.url), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `gw_oauth_csrf=${csrf}`,
      },
      body: form.toString(),
      redirect: "manual",
    });
    // Re-renders the consent page (no redirect, no code).
    expect(rejected.status).toBe(200);
    expect(await rejected.text()).toContain("Incorrect access code");
  });

  it("rejects a consent submission with a mismatched CSRF token (F14b)", async () => {
    gateway = await startConsentGateway();
    const challenge = pkceChallenge("verifier-" + "d".repeat(48));
    const form = authorizeQuery(challenge);
    form.set("gw_consent", "1");
    form.set("gw_csrf", "attacker-supplied");
    form.set("consent_secret", "approve-me");
    const res = await fetch(new URL("/oauth/authorize", gateway.url), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `gw_oauth_csrf=different-cookie-value`,
      },
      body: form.toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  afterEach(async () => {
    if (gateway) {
      await gateway.close();
      gateway = null;
    }
    process.env = { ...ORIGINAL_ENV };
  });

  it("rejects requests with no Authorization header without leaking auth details", async () => {
    gateway = await startGateway();
    const response = await fetch(gateway.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer/);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBeDefined();
    expect(body.error).not.toContain(TEST_TOKEN);
  });

  it("rejects oversized request bodies with 413 instead of buffering them (F1)", async () => {
    process.env.LLM_GATEWAY_MAX_HTTP_BODY_BYTES = "1024";
    gateway = await startGateway();
    const oversized = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { padding: "x".repeat(5000) },
    });
    const response = await fetch(
      gateway.url,
      withAuth(TEST_TOKEN, { method: "POST", body: oversized })
    );
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toMatch(/too large/i);
  });

  it("advertises OAuth protected-resource metadata on bearer auth failures when enabled", async () => {
    process.env.LLM_GATEWAY_OAUTH_ENABLED = "1";
    process.env.LLM_GATEWAY_PUBLIC_URL = "https://gateway.example.test/mcp";
    gateway = await startGateway();

    const response = await fetch(gateway.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://gateway.example.test/.well-known/oauth-protected-resource"'
    );
  });

  it("serves MCP OAuth discovery metadata and shared-secret dynamic client registration", async () => {
    process.env.LLM_GATEWAY_OAUTH_ENABLED = "1";
    process.env.LLM_GATEWAY_PUBLIC_URL = "https://gateway.example.test/mcp";
    process.env.LLM_GATEWAY_OAUTH_REGISTRATION_SECRET = TEST_OAUTH_SHARED_SECRET;
    gateway = await startGateway();

    const protectedMetadata = await fetch(
      new URL("/.well-known/oauth-protected-resource", gateway.url)
    );
    expect(protectedMetadata.status).toBe(200);
    const protectedBody = (await protectedMetadata.json()) as { scopes_supported: string[] };
    expect(protectedBody).toMatchObject({
      resource: "https://gateway.example.test/mcp",
      authorization_servers: ["https://gateway.example.test"],
      bearer_methods_supported: ["header"],
    });
    expect(protectedBody.scopes_supported).toContain("mcp");

    const authorizationMetadata = await fetch(
      new URL("/.well-known/oauth-authorization-server", gateway.url)
    );
    expect(authorizationMetadata.status).toBe(200);
    await expect(authorizationMetadata.json()).resolves.toMatchObject({
      issuer: "https://gateway.example.test",
      authorization_endpoint: "https://gateway.example.test/oauth/authorize",
      token_endpoint: "https://gateway.example.test/oauth/token",
      registration_endpoint: "https://gateway.example.test/oauth/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
    });

    const pathSpecificAuthorizationMetadata = await fetch(
      new URL("/.well-known/oauth-authorization-server/mcp", gateway.url)
    );
    expect(pathSpecificAuthorizationMetadata.status).toBe(200);

    const registration = await fetch(new URL("/oauth/register", gateway.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shared_secret: TEST_OAUTH_SHARED_SECRET,
        redirect_uris: ["https://chat.openai.com/aip/callback"],
      }),
    });
    expect(registration.status).toBe(201);
    const body = (await registration.json()) as {
      client_id?: string;
      client_secret?: string;
      token_endpoint_auth_method?: string;
    };
    expect(body.client_id).toMatch(/^llm-cli-gateway-/);
    expect(body.client_secret).toBeDefined();
    expect(body.token_endpoint_auth_method).toBe("client_secret_post");
  });

  it("rejects OAuth dynamic registration without the shared registration secret", async () => {
    process.env.LLM_GATEWAY_OAUTH_ENABLED = "1";
    process.env.LLM_GATEWAY_PUBLIC_URL = "https://gateway.example.test/mcp";
    process.env.LLM_GATEWAY_OAUTH_REGISTRATION_SECRET = TEST_OAUTH_SHARED_SECRET;
    gateway = await startGateway();

    const registration = await fetch(new URL("/oauth/register", gateway.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://chat.openai.com/aip/callback"] }),
    });
    expect(registration.status).toBe(403);
    await expect(registration.json()).resolves.toMatchObject({ error: "invalid_client" });
  });

  it("rejects OAuth registration secrets in query strings", async () => {
    process.env.LLM_GATEWAY_OAUTH_ENABLED = "1";
    process.env.LLM_GATEWAY_PUBLIC_URL = "https://gateway.example.test/mcp";
    process.env.LLM_GATEWAY_OAUTH_REGISTRATION_SECRET = TEST_OAUTH_SHARED_SECRET;
    gateway = await startGateway();

    const url = new URL("/oauth/register", gateway.url);
    url.searchParams.set("shared_secret", TEST_OAUTH_SHARED_SECRET);
    const registration = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://chat.openai.com/aip/callback"] }),
    });
    expect(registration.status).toBe(400);
    await expect(registration.json()).resolves.toMatchObject({ error: "invalid_request" });
  });

  it("does not derive public OAuth issuer metadata from hostile Host headers", async () => {
    process.env.LLM_GATEWAY_OAUTH_ENABLED = "1";
    gateway = await startGateway();

    const response = await httpGetWithHost(
      new URL("/.well-known/oauth-authorization-server", gateway.url),
      "evil.example"
    );
    expect(response.status).toBe(503);
    expect(response.body).not.toContain("evil.example");
  });

  it("does not redirect OAuth authorization errors to unregistered redirect URIs", async () => {
    process.env.LLM_GATEWAY_OAUTH_ENABLED = "1";
    process.env.LLM_GATEWAY_PUBLIC_URL = "https://gateway.example.test/mcp";
    gateway = await startGateway();

    const authorizeUrl = new URL("/oauth/authorize", gateway.url);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", "unknown-client");
    authorizeUrl.searchParams.set("redirect_uri", "https://attacker.example/callback");
    const authorize = await fetch(authorizeUrl, { redirect: "manual" });

    expect(authorize.status).toBe(400);
    expect(authorize.headers.get("location")).toBeNull();
    await expect(authorize.json()).resolves.toMatchObject({ error: "invalid_request" });
  });

  it("exchanges an OAuth authorization code for a scoped token accepted by MCP", async () => {
    process.env.LLM_GATEWAY_OAUTH_ENABLED = "1";
    process.env.LLM_GATEWAY_PUBLIC_URL = "https://gateway.example.test/mcp";
    process.env.LLM_GATEWAY_OAUTH_REGISTRATION_SECRET = TEST_OAUTH_SHARED_SECRET;
    gateway = await startGateway();

    const registration = await fetch(new URL("/oauth/register", gateway.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shared_secret: TEST_OAUTH_SHARED_SECRET,
        redirect_uris: ["https://chat.openai.com/aip/callback"],
      }),
    });
    expect(registration.status).toBe(201);
    const registrationBody = (await registration.json()) as {
      client_id: string;
      client_secret: string;
    };

    const authorizeUrl = new URL("/oauth/authorize", gateway.url);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", registrationBody.client_id);
    authorizeUrl.searchParams.set("redirect_uri", "https://chat.openai.com/aip/callback");
    authorizeUrl.searchParams.set("state", "state-123");
    authorizeUrl.searchParams.set("scope", "mcp");
    authorizeUrl.searchParams.set("code_challenge", pkceChallenge("unit-test-verifier"));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    const authorize = await fetch(authorizeUrl, { redirect: "manual" });
    expect(authorize.status).toBe(302);
    const location = authorize.headers.get("location");
    expect(location).toBeDefined();
    const redirect = new URL(location!);
    expect(redirect.origin + redirect.pathname).toBe("https://chat.openai.com/aip/callback");
    expect(redirect.searchParams.get("state")).toBe("state-123");
    const code = redirect.searchParams.get("code");
    expect(code).toBeDefined();

    const tokenResponse = await fetch(new URL("/oauth/token", gateway.url), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        client_id: registrationBody.client_id,
        client_secret: registrationBody.client_secret,
        redirect_uri: "https://chat.openai.com/aip/callback",
        code_verifier: "unit-test-verifier",
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const tokenBody = (await tokenResponse.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
    };
    expect(tokenBody).toMatchObject({
      token_type: "Bearer",
      expires_in: 3600,
      scope: "mcp",
    });
    expect(tokenBody.access_token).toMatch(/^oauth_/);
    expect(tokenBody.access_token).not.toBe(TEST_TOKEN);

    const mcpResponse = await fetch(
      gateway.url,
      withAuth(tokenBody.access_token, {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "oauth-test", version: "0.0.1" },
          },
        }),
      })
    );
    expect(mcpResponse.status).toBe(200);
  });

  it("rejects OAuth authorization scopes not granted to the client", async () => {
    process.env.LLM_GATEWAY_OAUTH_ENABLED = "1";
    process.env.LLM_GATEWAY_PUBLIC_URL = "https://gateway.example.test/mcp";
    process.env.LLM_GATEWAY_OAUTH_REGISTRATION_SECRET = TEST_OAUTH_SHARED_SECRET;
    gateway = await startGateway();

    const registration = await fetch(new URL("/oauth/register", gateway.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shared_secret: TEST_OAUTH_SHARED_SECRET,
        redirect_uris: ["https://chat.openai.com/aip/callback"],
      }),
    });
    const registrationBody = (await registration.json()) as {
      client_id: string;
      client_secret: string;
    };

    const authorizeUrl = new URL("/oauth/authorize", gateway.url);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", registrationBody.client_id);
    authorizeUrl.searchParams.set("redirect_uri", "https://chat.openai.com/aip/callback");
    authorizeUrl.searchParams.set("scope", "mcp workspace:admin");
    authorizeUrl.searchParams.set("code_challenge", pkceChallenge("unit-test-verifier"));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    const authorize = await fetch(authorizeUrl, { redirect: "manual" });

    expect(authorize.status).toBe(302);
    const redirect = new URL(authorize.headers.get("location")!);
    expect(redirect.searchParams.get("error")).toBe("invalid_scope");
    expect(redirect.searchParams.get("code")).toBeNull();
  });

  it("rejects OAuth token exchange with a wrong client secret", async () => {
    process.env.LLM_GATEWAY_OAUTH_ENABLED = "1";
    process.env.LLM_GATEWAY_PUBLIC_URL = "https://gateway.example.test/mcp";
    process.env.LLM_GATEWAY_OAUTH_REGISTRATION_SECRET = TEST_OAUTH_SHARED_SECRET;
    gateway = await startGateway();

    const registration = await fetch(new URL("/oauth/register", gateway.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shared_secret: TEST_OAUTH_SHARED_SECRET,
        redirect_uris: ["https://chat.openai.com/aip/callback"],
      }),
    });
    const registrationBody = (await registration.json()) as { client_id: string };

    const authorizeUrl = new URL("/oauth/authorize", gateway.url);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", registrationBody.client_id);
    authorizeUrl.searchParams.set("redirect_uri", "https://chat.openai.com/aip/callback");
    authorizeUrl.searchParams.set("code_challenge", pkceChallenge("unit-test-verifier"));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    const authorize = await fetch(authorizeUrl, { redirect: "manual" });
    const code = new URL(authorize.headers.get("location")!).searchParams.get("code");

    const tokenResponse = await fetch(new URL("/oauth/token", gateway.url), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        client_id: registrationBody.client_id,
        client_secret: "bad",
        redirect_uri: "https://chat.openai.com/aip/callback",
      }),
    });
    expect(tokenResponse.status).toBe(400);
    await expect(tokenResponse.json()).resolves.toMatchObject({ error: "invalid_grant" });
  });

  it("rejects requests with an incorrect bearer token", async () => {
    gateway = await startGateway();
    const response = await fetch(gateway.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("Unauthorized");
  });

  it("serves configured no-auth connector paths while keeping /mcp protected", async () => {
    process.env.LLM_GATEWAY_NO_AUTH_PATHS = "/chatgpt/unit-test/mcp";
    gateway = await startGateway();

    const protectedResponse = await fetch(gateway.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(protectedResponse.status).toBe(401);

    const chatGPTUrl = new URL("/chatgpt/unit-test/mcp", gateway.url).toString();
    const connectorResponse = await fetch(chatGPTUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "chatgpt-test", version: "0.0.1" },
        },
      }),
    });
    expect(connectorResponse.status).toBe(200);
  });

  it("marks bearer HTTP tool-call request contexts with transport=http", async () => {
    gateway = await startGateway();
    const transport = new StreamableHTTPClientTransport(new URL(gateway.url), {
      requestInit: { headers: { authorization: `Bearer ${TEST_TOKEN}` } },
    });
    const client = new Client({ name: "context-test-client", version: "0.0.1" }, {});

    try {
      await client.connect(transport);
      const callResult = await client.callTool({
        name: "echo",
        arguments: { value: "context" },
      });
      const structured = callResult.structuredContent as {
        requestContext?: { transport?: string; authKind?: string; authScopes?: string[] };
      };
      expect(structured.requestContext).toMatchObject({
        transport: "http",
        authKind: "gateway_bearer",
        authScopes: [],
      });
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it("adopts a trusted front-door principal under the static bearer when the seam is on (F14)", async () => {
    process.env.LLM_GATEWAY_TRUSTED_PRINCIPAL_HEADER = "x-gateway-principal";
    gateway = await startGateway();
    const transport = new StreamableHTTPClientTransport(new URL(gateway.url), {
      requestInit: {
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          "x-gateway-principal": "user-alice@example.com",
        },
      },
    });
    const client = new Client({ name: "principal-on-test", version: "0.0.1" }, {});
    try {
      await client.connect(transport);
      const callResult = await client.callTool({ name: "echo", arguments: { value: "ctx" } });
      const structured = callResult.structuredContent as {
        requestContext?: { authKind?: string; authPrincipal?: string };
      };
      expect(structured.requestContext).toMatchObject({
        authKind: "gateway_bearer",
        authPrincipal: "user-alice@example.com",
      });
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it("ignores a forwarded principal header when the seam is off (F14)", async () => {
    // No LLM_GATEWAY_TRUSTED_PRINCIPAL_HEADER configured.
    gateway = await startGateway();
    const transport = new StreamableHTTPClientTransport(new URL(gateway.url), {
      requestInit: {
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          "x-gateway-principal": "spoofed-identity",
        },
      },
    });
    const client = new Client({ name: "principal-off-test", version: "0.0.1" }, {});
    try {
      await client.connect(transport);
      const callResult = await client.callTool({ name: "echo", arguments: { value: "ctx" } });
      const structured = callResult.structuredContent as {
        requestContext?: { authPrincipal?: string };
      };
      expect(structured.requestContext?.authPrincipal).toBeUndefined();
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it("marks auth-disabled HTTP tool-call request contexts with transport=http", async () => {
    process.env.LLM_GATEWAY_AUTH_DISABLED = "1";
    delete process.env.LLM_GATEWAY_AUTH_TOKEN;
    gateway = await startGateway();
    const transport = new StreamableHTTPClientTransport(new URL(gateway.url));
    const client = new Client({ name: "disabled-auth-context-test", version: "0.0.1" }, {});

    try {
      await client.connect(transport);
      const callResult = await client.callTool({
        name: "echo",
        arguments: { value: "context" },
      });
      const structured = callResult.structuredContent as {
        requestContext?: { transport?: string; authKind?: string; authScopes?: string[] };
      };
      expect(structured.requestContext).toMatchObject({
        transport: "http",
        authKind: "disabled",
        authScopes: [],
      });
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it("marks configured no-auth connector request contexts with transport=http", async () => {
    process.env.LLM_GATEWAY_NO_AUTH_PATHS = "/chatgpt/unit-test/mcp";
    gateway = await startGateway();
    const transport = new StreamableHTTPClientTransport(
      new URL("/chatgpt/unit-test/mcp", gateway.url)
    );
    const client = new Client({ name: "no-auth-context-test", version: "0.0.1" }, {});

    try {
      await client.connect(transport);
      const callResult = await client.callTool({
        name: "echo",
        arguments: { value: "context" },
      });
      const structured = callResult.structuredContent as {
        requestContext?: { transport?: string; authKind?: string; authScopes?: string[] };
      };
      expect(structured.requestContext).toMatchObject({
        transport: "http",
        authScopes: [],
      });
      expect(structured.requestContext?.authKind).toBeUndefined();
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it("returns 503 when HTTP transport is started without LLM_GATEWAY_AUTH_TOKEN", async () => {
    delete process.env.LLM_GATEWAY_AUTH_TOKEN;
    gateway = await startGateway();
    const response = await fetch(gateway.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer anything" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).toBe(503);
  });

  it("serves /healthz without auth and reports the live session count", async () => {
    gateway = await startGateway();
    const healthUrl = new URL("/healthz", gateway.url).toString();
    const response = await fetch(healthUrl);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; sessions: number };
    expect(body.ok).toBe(true);
    expect(body.sessions).toBe(0);
  });

  it("returns 404 for unknown paths on the gateway host", async () => {
    gateway = await startGateway();
    const otherUrl = new URL("/not-an-endpoint", gateway.url).toString();
    const response = await fetch(otherUrl, withAuth(TEST_TOKEN));
    expect(response.status).toBe(404);
  });

  it("rejects a non-initialize POST without a session id", async () => {
    gateway = await startGateway();
    const response = await fetch(
      gateway.url,
      withAuth(TEST_TOKEN, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toMatch(/initialize/i);
  });

  it("completes initialize → tools/list → tools/call via the real MCP client over HTTP", async () => {
    gateway = await startGateway();
    const transport = new StreamableHTTPClientTransport(new URL(gateway.url), {
      requestInit: { headers: { authorization: `Bearer ${TEST_TOKEN}` } },
    });
    const client = new Client({ name: "u20-test-client", version: "0.0.1" }, {});

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map(t => t.name)).toContain("echo");
      expect(gateway.sessionCount()).toBe(1);

      const callResult = await client.callTool({
        name: "echo",
        arguments: { value: "hello-mcp" },
      });
      const contentArray = (callResult.content ?? []) as Array<{ type: string; text?: string }>;
      const firstContent = contentArray[0];
      expect(firstContent?.type).toBe("text");
      expect(firstContent?.text).toBe("echo:hello-mcp");
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it("closes active transports and clears sessions on shutdown", async () => {
    gateway = await startGateway();
    const transport = new StreamableHTTPClientTransport(new URL(gateway.url), {
      requestInit: { headers: { authorization: `Bearer ${TEST_TOKEN}` } },
    });
    const client = new Client({ name: "u20-shutdown-client", version: "0.0.1" }, {});
    await client.connect(transport);
    expect(gateway.sessionCount()).toBe(1);

    await gateway.close();
    expect(gateway.sessionCount()).toBe(0);
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    // Prevent afterEach from double-closing.
    gateway = null;
  });

  it("rejects DELETE requests that do not include the mcp-session-id header", async () => {
    gateway = await startGateway();
    const response = await fetch(gateway.url, withAuth(TEST_TOKEN, { method: "DELETE" }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toMatch(/mcp-session-id/);
  });

  it("rejects PUT (an unsupported method) with allow headers", async () => {
    gateway = await startGateway();
    const response = await fetch(gateway.url, withAuth(TEST_TOKEN, { method: "PUT", body: "{}" }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toContain("POST");
    // Allow header negotiation makes it safe for clients to discover supported verbs.
  });

  it("returns 404 for a POST that references an unknown mcp-session-id", async () => {
    gateway = await startGateway();
    const response = await fetch(
      gateway.url,
      withAuth(TEST_TOKEN, {
        method: "POST",
        headers: { "mcp-session-id": "deadbeef-not-a-real-session" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
    );
    expect(response.status).toBe(404);
  });

  it("parses a successful initialize response into a JSON-RPC payload", async () => {
    gateway = await startGateway();
    const response = await fetch(
      gateway.url,
      withAuth(TEST_TOKEN, {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "fetch-test", version: "0.0.1" },
          },
        }),
      })
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    const message = parseSseOrJson(text);
    expect(message.jsonrpc).toBe("2.0");
    expect(message.result).toBeDefined();
    expect(message.result.serverInfo).toBeDefined();
  });
});
