import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashSecret, isSecretHash, verifySecret } from "../oauth.js";
import { loadRemoteOAuthConfig } from "../config.js";

const ORIGINAL_ENV = { ...process.env };

describe("remote OAuth config and secrets", () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "oauth-config-test-"));
    configPath = join(tempDir, "config.toml");
    process.env = { ...ORIGINAL_ENV, LLM_GATEWAY_CONFIG: configPath };
    delete process.env.LLM_GATEWAY_OAUTH_ENABLED;
    delete process.env.LLM_GATEWAY_OAUTH_REGISTRATION_SECRET;
    delete process.env.LLM_GATEWAY_OAUTH_SHARED_SECRET;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("hashes and verifies secrets without storing plaintext", () => {
    const encoded = hashSecret("copy-once-secret");
    expect(isSecretHash(encoded)).toBe(true);
    expect(encoded).not.toContain("copy-once-secret");
    expect(verifySecret("copy-once-secret", encoded)).toBe(true);
    expect(verifySecret("wrong", encoded)).toBe(false);
  });

  it("loads static confidential clients from hash-only config", () => {
    const secretHash = hashSecret("client-secret");
    writeFileSync(
      configPath,
      [
        "[http.oauth]",
        "enabled = true",
        'registration_policy = "static_clients"',
        "",
        "[[http.oauth.clients]]",
        'client_id = "chatgpt"',
        `client_secret_hash = "${secretHash}"`,
        'allowed_redirect_uris = ["https://chat.openai.com/aip/callback"]',
        'scopes = ["mcp"]',
        "",
      ].join("\n")
    );

    const config = loadRemoteOAuthConfig();
    expect(config.enabled).toBe(true);
    expect(config.registrationPolicy).toBe("static_clients");
    expect(config.clients).toHaveLength(1);
    expect(config.clients[0]?.clientSecretHash).toBe(secretHash);
  });

  it("disables OAuth when require_consent is set without a consent secret (F14b)", () => {
    writeFileSync(
      configPath,
      ["[http.oauth]", "enabled = true", "require_consent = true", ""].join("\n")
    );
    expect(loadRemoteOAuthConfig().enabled).toBe(false);
  });

  it("loads the consent gate with a valid consent_secret_hash (F14b)", () => {
    const consentHash = hashSecret("approve-me");
    writeFileSync(
      configPath,
      [
        "[http.oauth]",
        "enabled = true",
        "require_consent = true",
        `consent_secret_hash = "${consentHash}"`,
        "",
      ].join("\n")
    );
    const config = loadRemoteOAuthConfig();
    expect(config.enabled).toBe(true);
    expect(config.requireConsent).toBe(true);
    expect(config.consentSecretHash).toBe(consentHash);
  });

  it("disables OAuth when a persisted client secret is plaintext", () => {
    writeFileSync(
      configPath,
      [
        "[http.oauth]",
        "enabled = true",
        "",
        "[[http.oauth.clients]]",
        'client_id = "chatgpt"',
        'client_secret_hash = "plaintext-secret"',
        'allowed_redirect_uris = ["https://chat.openai.com/aip/callback"]',
        "",
      ].join("\n")
    );

    const config = loadRemoteOAuthConfig();
    expect(config.enabled).toBe(false);
    expect(config.clients).toEqual([]);
  });

  it("disables OAuth when public clients are disabled and a static client has no secret hash", () => {
    writeFileSync(
      configPath,
      [
        "[http.oauth]",
        "enabled = true",
        "allow_public_clients = false",
        "",
        "[[http.oauth.clients]]",
        'client_id = "chatgpt"',
        'allowed_redirect_uris = ["https://chat.openai.com/aip/callback"]',
        "",
      ].join("\n")
    );

    const config = loadRemoteOAuthConfig();
    expect(config.enabled).toBe(false);
    expect(config.clients).toEqual([]);
  });

  it("converts legacy env shared secret to an in-memory hash only", () => {
    process.env.LLM_GATEWAY_OAUTH_ENABLED = "1";
    process.env.LLM_GATEWAY_OAUTH_SHARED_SECRET = "legacy-shared-secret";
    const config = loadRemoteOAuthConfig();
    expect(config.enabled).toBe(true);
    expect(config.registrationPolicy).toBe("shared_secret");
    expect(config.sharedSecret?.secretHash).toBeTruthy();
    expect(config.sharedSecret?.secretHash).not.toContain("legacy-shared-secret");
  });
});
