import { describe, expect, it } from "vitest";
import { resolveOwnerPrincipal, principalCanAccess } from "../request-context.js";

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

describe("principalCanAccess (F3b)", () => {
  it("grants access to a row the caller owns", () => {
    expect(principalCanAccess("alice", "alice")).toBe(true);
    expect(principalCanAccess("gateway-bearer", "gateway-bearer")).toBe(true);
  });

  it("denies a remote principal access to another principal's row", () => {
    expect(principalCanAccess("alice", "bob")).toBe(false);
    expect(principalCanAccess("alice", "gateway-bearer")).toBe(false);
  });

  it("shows legacy-unowned (null/undefined) rows only to the local principal", () => {
    expect(principalCanAccess(null, "local")).toBe(true);
    expect(principalCanAccess(undefined, "local")).toBe(true);
    expect(principalCanAccess(null, "alice")).toBe(false);
    expect(principalCanAccess(undefined, "gateway-bearer")).toBe(false);
  });

  it("does not let the local caller see another principal's owned rows", () => {
    expect(principalCanAccess("alice", "local")).toBe(false);
  });
});
