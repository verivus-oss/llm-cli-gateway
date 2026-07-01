import { describe, it, expect } from "vitest";
import {
  buildConnectorSetupPacket,
  legacyNoAuthConnectorUrl,
  renderConnectorSetupSummary,
  CONNECTOR_SETUP_SECRET_WARNING,
} from "../connector-setup.js";
import type { RemoteHttpOAuthReadiness } from "../doctor.js";
import type { RemoteOAuthConfig } from "../auth.js";

const BASE = "https://gw.example.trycloudflare.com";

function readyReadiness(
  overrides: Partial<RemoteHttpOAuthReadiness> = {}
): RemoteHttpOAuthReadiness {
  return {
    ready: true,
    stage: "ready",
    public_url: BASE,
    mcp_url: `${BASE}/mcp`,
    auth_mode: "oauth",
    oauth: {
      enabled: true,
      issuer: BASE,
      authorization_url: `${BASE}/oauth/authorize`,
      token_url: `${BASE}/oauth/token`,
      registration_policy: "static_clients",
      clients_configured: 1,
      consent_required: false,
    },
    workspace: { ready: true, default: "gateway", aliases: ["gateway"] },
    next_actions: ["Remote connector is ready."],
    ...overrides,
  };
}

function oauthCfg(overrides: Partial<RemoteOAuthConfig> = {}): RemoteOAuthConfig {
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
    clients: [
      {
        clientId: "chatgpt",
        clientSecretHash: "scrypt:N=32768,r=8,p=1:c2FsdA:aGFzaA",
        allowedRedirectUris: ["https://chatgpt.com/connector/callback"],
        scopes: ["mcp"],
      },
    ],
    sharedSecret: null,
    sources: { configFile: null, envOverrides: [] },
    ...overrides,
  };
}

describe("connector setup packet", () => {
  it("includes MCP URL, authorization URL, token URL, auth mode, client id, and workspace guidance", () => {
    const packet = buildConnectorSetupPacket({ readiness: readyReadiness(), oauth: oauthCfg() });
    expect(packet.schema).toBe("remote-connector-setup.v1");
    expect(packet.auth_mode).toBe("oauth");
    expect(packet.connector.mcp_url).toBe(`${BASE}/mcp`);
    expect(packet.connector.authorization_url).toBe(`${BASE}/oauth/authorize`);
    expect(packet.connector.token_url).toBe(`${BASE}/oauth/token`);
    expect(packet.connector.client_id).toBe("chatgpt");
    expect(packet.connector.client_secret_required).toBe(true);
    expect(packet.connector.client_secret_source).toMatch(/oauth client add|rotate/);
    expect(packet.workspace).toEqual({ ready: true, default: "gateway", aliases: ["gateway"] });
  });

  it("omits gateway bearer token, OAuth access token, stored client secret, secret hash, consent and tunnel secrets", () => {
    const packet = buildConnectorSetupPacket({
      readiness: readyReadiness(),
      oauth: oauthCfg({
        consentSecretHash: "scrypt:N=32768,r=8,p=1:c2FsdA:c29tZWhhc2g",
        sharedSecret: {
          enabled: true,
          secretHash: "scrypt:N=32768,r=8,p=1:c2FsdA:c2hhcmVk",
          promptLabel: "x",
        },
      }),
    });
    const blob = JSON.stringify(packet);
    expect(blob).not.toMatch(/scrypt:/);
    expect(blob).not.toMatch(/client_secret"\s*:/);
    expect(blob).not.toMatch(/Bearer\s/);
    expect(blob).not.toMatch(/oauth_[A-Za-z0-9_-]{20,}/);
    // The fixed warning is always present.
    expect(packet.warnings).toContain(CONNECTOR_SETUP_SECRET_WARNING);
  });

  it("marks client_secret_required false for public clients", () => {
    const packet = buildConnectorSetupPacket({
      readiness: readyReadiness(),
      oauth: oauthCfg({ allowPublicClients: true }),
    });
    expect(packet.connector.client_secret_required).toBe(false);
    expect(packet.connector.client_secret_source).toBeNull();
  });

  it("honours an explicit --client-id even before the client is created", () => {
    const packet = buildConnectorSetupPacket({
      readiness: readyReadiness(),
      oauth: oauthCfg({ clients: [] }),
      options: { clientId: "grok-web" },
    });
    expect(packet.connector.client_id).toBe("grok-web");
  });

  it("omits the legacy no-auth connector URL unless the legacy flag is provided", () => {
    const withoutFlag = buildConnectorSetupPacket({
      readiness: readyReadiness(),
      oauth: oauthCfg(),
      legacyNoAuthUrl: `${BASE}/chatgpt/abc/mcp`,
    });
    expect(withoutFlag.legacy_no_auth).toBeUndefined();

    const withFlag = buildConnectorSetupPacket({
      readiness: readyReadiness(),
      oauth: oauthCfg(),
      options: { includeLegacyNoAuth: true },
      legacyNoAuthUrl: `${BASE}/chatgpt/abc/mcp`,
    });
    expect(withFlag.legacy_no_auth?.deprecated).toBe(true);
    expect(withFlag.legacy_no_auth?.connector_url).toBe(`${BASE}/chatgpt/abc/mcp`);
    expect(withFlag.legacy_no_auth?.note.toLowerCase()).toContain("deprecated");
  });

  it("carries the readiness stage and next_actions verbatim (single source of truth)", () => {
    const readiness = readyReadiness({
      stage: "missing_oauth_client",
      ready: false,
      next_actions: ["do X"],
    });
    const packet = buildConnectorSetupPacket({ readiness, oauth: oauthCfg({ clients: [] }) });
    expect(packet.stage).toBe("missing_oauth_client");
    expect(packet.ready).toBe(false);
    expect(packet.next_actions).toEqual(["do X"]);
  });

  it("renders a secret-free human summary", () => {
    const summary = renderConnectorSetupSummary(
      buildConnectorSetupPacket({ readiness: readyReadiness(), oauth: oauthCfg() })
    );
    expect(summary).toContain("MCP URL");
    expect(summary).toContain(`${BASE}/oauth/authorize`);
    expect(summary).not.toMatch(/scrypt:|Bearer\s/);
  });
});

describe("legacyNoAuthConnectorUrl", () => {
  it("returns null without a no-auth path or public URL", () => {
    expect(legacyNoAuthConnectorUrl({})).toBeNull();
    expect(legacyNoAuthConnectorUrl({ LLM_GATEWAY_PUBLIC_URL: BASE })).toBeNull();
    expect(legacyNoAuthConnectorUrl({ LLM_GATEWAY_NO_AUTH_PATHS: "/x/mcp" })).toBeNull();
  });

  it("joins the public origin and the no-auth path", () => {
    expect(
      legacyNoAuthConnectorUrl({
        LLM_GATEWAY_PUBLIC_URL: `${BASE}/mcp`,
        LLM_GATEWAY_NO_AUTH_PATHS: "/chatgpt/abc/mcp",
      })
    ).toBe(`${BASE}/chatgpt/abc/mcp`);
  });
});
