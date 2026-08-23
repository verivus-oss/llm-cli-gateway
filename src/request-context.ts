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

/**
 * The same ownership rule as `principalCanAccess`, expressed as a SQL fragment
 * so an enumerating reader can bound `LIMIT` to rows the caller may see.
 *
 * It lives here, one screen from the predicate, because a security rule with
 * two spellings in two files drifts silently. Callers MUST still pass every
 * returned row through `principalCanAccess`: this fragment is a prefilter, and
 * the predicate is the control. If the two ever disagree, the predicate drops
 * the extra rows, so the failure direction is "fewer rows", never "another
 * principal's rows".
 *
 * `column` names the owner column (e.g. `"r.owner_principal"`) and is
 * caller-supplied SQL, never user input. The caller principal binds as a
 * parameter, returned in `params`.
 */
export function principalScopeSql(
  column: string,
  caller: string
): { sql: string; params: string[] } {
  // Legacy-unowned (NULL) rows are visible to the local principal only, which
  // is the `rowOwner == null && caller === "local"` arm of the predicate.
  if (caller === "local") {
    return { sql: `(${column} = ? OR ${column} IS NULL)`, params: [caller] };
  }
  return { sql: `${column} = ?`, params: [caller] };
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

/**
 * Is the current request off-machine (HTTP/OAuth) rather than on-machine
 * (stdio)?
 *
 * One spelling, because this predicate gates security controls and was written
 * out longhand at eight separate call sites across four modules. A predicate
 * that must be retyped to be applied is a predicate that will eventually be
 * retyped wrong, and the failure is silent: the control simply stops firing for
 * the caller it was written for.
 *
 * `authKind === "oauth"` is checked alongside the transport because an OAuth
 * caller is remote regardless of how the context was stamped.
 */
export function isRemotePrincipal(ctx: GatewayRequestContext | undefined): boolean {
  return ctx?.transport === "http" || ctx?.authKind === "oauth";
}
