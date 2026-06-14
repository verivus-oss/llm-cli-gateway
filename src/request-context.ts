import { AsyncLocalStorage } from "node:async_hooks";

export interface GatewayRequestContext {
  transport?: "stdio" | "http";
  authKind?: "disabled" | "gateway_bearer" | "oauth";
  authScopes: string[];
  authClientId?: string;
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
