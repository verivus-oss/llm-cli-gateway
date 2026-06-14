import { AsyncLocalStorage } from "node:async_hooks";

export interface GatewayRequestContext {
  transport?: "stdio" | "http";
  authKind?: "disabled" | "gateway_bearer" | "oauth";
  authScopes: string[];
  authClientId?: string;
  /**
   * F14: the authenticated caller identity used as the ownership principal
   * (consumed by F3 per-principal isolation). For OAuth callers this is the
   * client id; behind a trusted front door (the trusted-principal-header seam)
   * it is the user identity the proxy asserted. Undefined for the shared static
   * bearer / disabled auth, where there is no distinct principal.
   */
  authPrincipal?: string;
}

const requestContext = new AsyncLocalStorage<GatewayRequestContext>();

/**
 * F3: resolve the ownership principal for the current request, used to stamp
 * (and later enforce) ownership on sessions / jobs / persisted requests.
 *
 * - No context (stdio / local CLI) → `"local"`: a single trusted user owns all
 *   local state.
 * - HTTP with a resolved `authPrincipal` (an OAuth client id, or the identity a
 *   trusted front door asserted via the F14 seam) → that principal.
 * - HTTP under the shared static bearer with no distinct principal →
 *   `"gateway-bearer"` (one shared identity — the static token is not
 *   multi-tenant; documented, not "fixed").
 *
 * Always returns a non-empty string so new rows are stamped; legacy rows
 * predating the owner column keep NULL.
 */
export function resolveOwnerPrincipal(ctx: GatewayRequestContext | undefined): string {
  if (!ctx) return "local";
  if (ctx.authPrincipal) return ctx.authPrincipal;
  if (ctx.authKind === "gateway_bearer") return "gateway-bearer";
  return "local";
}

/**
 * F3b: ownership access decision. A caller may access a row iff it owns the row,
 * or the row is legacy-unowned (`null`/absent owner) AND the caller is the local
 * principal. Legacy-unowned rows are therefore visible only to local/stdio — a
 * remote OAuth client never sees pre-isolation rows it did not create. In the
 * default single-user local deployment every row is `"local"`-owned or
 * legacy-`null` and the caller is `"local"`, so nothing is hidden (no behaviour
 * change); isolation only takes effect once distinct remote principals exist.
 */
export function principalCanAccess(rowOwner: string | null | undefined, caller: string): boolean {
  if (rowOwner === caller) return true;
  if ((rowOwner === null || rowOwner === undefined) && caller === "local") return true;
  return false;
}

export function runWithRequestContext<T>(
  context: GatewayRequestContext,
  callback: () => T | Promise<T>
): T | Promise<T> {
  return requestContext.run(context, callback);
}

export function getRequestContext(): GatewayRequestContext | undefined {
  return requestContext.getStore();
}
