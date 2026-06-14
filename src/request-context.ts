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

export function runWithRequestContext<T>(
  context: GatewayRequestContext,
  callback: () => T | Promise<T>
): T | Promise<T> {
  return requestContext.run(context, callback);
}

export function getRequestContext(): GatewayRequestContext | undefined {
  return requestContext.getStore();
}
