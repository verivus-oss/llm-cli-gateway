import { describe, expect, it } from "vitest";
import { resolveOwnerPrincipal } from "../request-context.js";

describe("resolveOwnerPrincipal (F3)", () => {
  it("is 'local' with no context (stdio / local CLI)", () => {
    expect(resolveOwnerPrincipal(undefined)).toBe("local");
  });

  it("uses authPrincipal when present (OAuth client id / trusted front-door identity)", () => {
    expect(
      resolveOwnerPrincipal({
        transport: "http",
        authScopes: [],
        authPrincipal: "alice@example.com",
      })
    ).toBe("alice@example.com");
  });

  it("is 'gateway-bearer' for the shared static bearer with no distinct principal", () => {
    expect(
      resolveOwnerPrincipal({ transport: "http", authScopes: [], authKind: "gateway_bearer" })
    ).toBe("gateway-bearer");
  });

  it("is 'local' for disabled auth", () => {
    expect(resolveOwnerPrincipal({ transport: "http", authScopes: [], authKind: "disabled" })).toBe(
      "local"
    );
  });
});
