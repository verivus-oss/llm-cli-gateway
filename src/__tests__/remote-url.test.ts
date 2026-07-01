import { describe, it, expect } from "vitest";
import {
  buildRemoteConnectorUrls,
  joinBaseAndPath,
  resolveConfiguredRemoteOrigin,
  toOrigin,
  OAUTH_AUTHORIZE_PATH,
  OAUTH_TOKEN_PATH,
  OAUTH_REGISTER_PATH,
  OAUTH_PROTECTED_RESOURCE_METADATA_PATH,
} from "../remote-url.js";
import { OAuthServer } from "../oauth.js";
import type { RemoteOAuthConfig } from "../auth.js";

const BASE = "https://gw.example.trycloudflare.com";

function oauthConfig(overrides: Partial<RemoteOAuthConfig> = {}): RemoteOAuthConfig {
  return {
    enabled: true,
    issuer: "auto",
    requirePkce: true,
    allowPlainPkce: false,
    registrationPolicy: "static_clients",
    allowPublicClients: false,
    tokenTtlSeconds: 3600,
    requireConsent: false,
    consentSecretHash: null,
    clients: [],
    sharedSecret: null,
    sources: { configFile: null, envOverrides: [] },
    ...overrides,
  };
}

describe("remote-url helpers", () => {
  it("joins base and path without duplicating or dropping the separator", () => {
    expect(joinBaseAndPath(BASE, "/mcp")).toBe(`${BASE}/mcp`);
    expect(joinBaseAndPath(`${BASE}/`, "/mcp")).toBe(`${BASE}/mcp`);
    expect(joinBaseAndPath(BASE, "mcp")).toBe(`${BASE}/mcp`);
  });

  it("toOrigin normalizes to scheme://host[:port] and rejects non-URLs", () => {
    expect(toOrigin(`${BASE}/mcp?x=1#frag`)).toBe(BASE);
    expect(toOrigin("not a url")).toBeNull();
    expect(toOrigin(null)).toBeNull();
  });

  it("resolveConfiguredRemoteOrigin prefers a concrete issuer over public URL", () => {
    expect(
      resolveConfiguredRemoteOrigin({ issuer: "https://issuer.example.com", publicUrl: BASE })
    ).toBe("https://issuer.example.com");
    // "auto" issuer is ignored in favour of the public URL.
    expect(resolveConfiguredRemoteOrigin({ issuer: "auto", publicUrl: BASE })).toBe(BASE);
    expect(resolveConfiguredRemoteOrigin({ issuer: null, publicUrl: null })).toBeNull();
  });

  it("returns all-null URLs when there is no base origin (never a partial URL)", () => {
    const urls = buildRemoteConnectorUrls({ baseOrigin: null, oauthEnabled: true });
    expect(urls.mcpUrl).toBeNull();
    expect(urls.authorizationUrl).toBeNull();
    expect(urls.protectedResourceMetadataUrl).toBeNull();
  });

  it("emits the MCP URL but null OAuth URLs when OAuth is disabled", () => {
    const urls = buildRemoteConnectorUrls({ baseOrigin: BASE, oauthEnabled: false });
    expect(urls.mcpUrl).toBe(`${BASE}/mcp`);
    expect(urls.issuer).toBeNull();
    expect(urls.authorizationUrl).toBeNull();
    expect(urls.tokenUrl).toBeNull();
  });

  it("preserves a custom MCP path", () => {
    const urls = buildRemoteConnectorUrls({
      baseOrigin: BASE,
      mcpPath: "/gateway",
      oauthEnabled: true,
    });
    expect(urls.mcpUrl).toBe(`${BASE}/gateway`);
  });

  it("builds the canonical OAuth endpoint URLs when OAuth is enabled", () => {
    const urls = buildRemoteConnectorUrls({ baseOrigin: BASE, oauthEnabled: true });
    expect(urls.issuer).toBe(BASE);
    expect(urls.authorizationUrl).toBe(`${BASE}${OAUTH_AUTHORIZE_PATH}`);
    expect(urls.tokenUrl).toBe(`${BASE}${OAUTH_TOKEN_PATH}`);
    expect(urls.registrationUrl).toBe(`${BASE}${OAUTH_REGISTER_PATH}`);
    expect(urls.protectedResourceMetadataUrl).toBe(
      `${BASE}${OAUTH_PROTECTED_RESOURCE_METADATA_PATH}`
    );
  });
});

describe("remote-url consistency with runtime OAuth metadata", () => {
  // The whole point of the shared helpers is that the setup surfaces cannot drift
  // from what the OAuth server actually serves. Assert byte-identical URLs.
  const server = new OAuthServer({ protectedPath: "/mcp", config: oauthConfig() });
  const urls = buildRemoteConnectorUrls({ baseOrigin: BASE, mcpPath: "/mcp", oauthEnabled: true });

  it("protected-resource metadata resource + authorization_servers match the helper", () => {
    const meta = (
      server as unknown as {
        protectedResourceMetadata: (b: string) => Record<string, unknown>;
      }
    ).protectedResourceMetadata(BASE);
    expect(meta.resource).toBe(urls.mcpUrl);
    expect(meta.authorization_servers).toEqual([urls.issuer]);
  });

  it("authorization-server metadata endpoints match the helper", () => {
    const meta = (
      server as unknown as {
        authorizationServerMetadata: (b: string) => Record<string, unknown>;
      }
    ).authorizationServerMetadata(BASE);
    expect(meta.issuer).toBe(urls.issuer);
    expect(meta.authorization_endpoint).toBe(urls.authorizationUrl);
    expect(meta.token_endpoint).toBe(urls.tokenUrl);
    expect(meta.registration_endpoint).toBe(urls.registrationUrl);
  });

  it("resourceMetadataUrl (used in WWW-Authenticate) matches the helper", () => {
    expect(server.resourceMetadataUrl(BASE)).toBe(urls.protectedResourceMetadataUrl);
  });
});
