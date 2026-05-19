import type { IncomingMessage, ServerResponse } from "node:http";

export interface AuthConfig {
  required: boolean;
  tokenConfigured: boolean;
  source: "env" | "disabled";
}

export interface AuthResult {
  ok: boolean;
  status?: number;
  message?: string;
}

const AUTH_SCHEME = "Bearer ";

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const token = env.LLM_GATEWAY_AUTH_TOKEN;
  const disabled = env.LLM_GATEWAY_AUTH_DISABLED === "1";
  return {
    required: !disabled,
    tokenConfigured: Boolean(token),
    source: disabled ? "disabled" : "env",
  };
}

export function getRequiredBearerToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const config = loadAuthConfig(env);
  if (!config.required) return null;
  return env.LLM_GATEWAY_AUTH_TOKEN || null;
}

export function authorizeBearerRequest(
  req: IncomingMessage,
  token: string | null = getRequiredBearerToken()
): AuthResult {
  if (!loadAuthConfig().required) {
    return { ok: true };
  }
  if (!token) {
    return {
      ok: false,
      status: 503,
      message: "HTTP transport requires LLM_GATEWAY_AUTH_TOKEN",
    };
  }

  const header = req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !value.startsWith(AUTH_SCHEME)) {
    return { ok: false, status: 401, message: "Unauthorized" };
  }

  const supplied = value.slice(AUTH_SCHEME.length);
  if (supplied !== token) {
    return { ok: false, status: 401, message: "Unauthorized" };
  }

  return { ok: true };
}

export function writeAuthFailure(res: ServerResponse, result: AuthResult): void {
  const status = result.status ?? 401;
  res.writeHead(status, {
    "content-type": "application/json",
    "www-authenticate": 'Bearer realm="llm-cli-gateway"',
  });
  res.end(JSON.stringify({ error: result.message || "Unauthorized" }));
}
