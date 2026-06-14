import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { resolveTrustedPrincipal, trustedPrincipalHeaderName, type AuthResult } from "../auth.js";

function reqWith(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

const gatewayBearer: AuthResult = { ok: true, kind: "gateway_bearer", scopes: [] };
const oauth: AuthResult = { ok: true, kind: "oauth", scopes: ["mcp"], clientId: "client-1" };
const disabled: AuthResult = { ok: true, kind: "disabled", scopes: [] };

function env(header?: string): NodeJS.ProcessEnv {
  return (header ? { LLM_GATEWAY_TRUSTED_PRINCIPAL_HEADER: header } : {}) as NodeJS.ProcessEnv;
}

describe("trusted-principal-header seam (F14)", () => {
  it("is disabled unless the operator names the header", () => {
    expect(trustedPrincipalHeaderName(env())).toBeNull();
    expect(
      resolveTrustedPrincipal(reqWith({ "x-gateway-principal": "alice" }), gatewayBearer, env())
    ).toBeUndefined();
  });

  it("adopts the header value under the static gateway bearer when enabled", () => {
    expect(
      resolveTrustedPrincipal(
        reqWith({ "x-gateway-principal": "alice@example.com" }),
        gatewayBearer,
        env("x-gateway-principal")
      )
    ).toBe("alice@example.com");
  });

  it("does NOT trust the header for non-gateway-bearer callers (oauth, disabled)", () => {
    // A remote OAuth client (or auth-disabled request) is not the trusted upstream
    // proxy, so its forwarded principal header must be ignored.
    expect(
      resolveTrustedPrincipal(
        reqWith({ "x-gateway-principal": "spoofed" }),
        oauth,
        env("x-gateway-principal")
      )
    ).toBeUndefined();
    expect(
      resolveTrustedPrincipal(
        reqWith({ "x-gateway-principal": "spoofed" }),
        disabled,
        env("x-gateway-principal")
      )
    ).toBeUndefined();
  });

  it("rejects malformed / oversized principal values", () => {
    const badValues = ["has space", "semi;colon", "ang<le>", "x".repeat(257), ""];
    for (const bad of badValues) {
      expect(
        resolveTrustedPrincipal(
          reqWith({ "x-gateway-principal": bad }),
          gatewayBearer,
          env("x-gateway-principal")
        )
      ).toBeUndefined();
    }
  });

  it("returns undefined when the header is absent even with the seam enabled", () => {
    expect(
      resolveTrustedPrincipal(reqWith({}), gatewayBearer, env("x-gateway-principal"))
    ).toBeUndefined();
  });
});
