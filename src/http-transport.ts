import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { authorizeBearerRequest, getRequiredBearerToken, writeAuthFailure } from "./auth.js";
import type { GatewayServerDeps } from "./index.js";
import { loadRemoteOAuthConfig } from "./config.js";
import { OAuthServer, oauthBaseUrlFromRequest } from "./oauth.js";
import { runWithRequestContext, type GatewayRequestContext } from "./request-context.js";

export interface HttpTransportOptions {
  host?: string;
  port?: number;
  path?: string;
  deps?: GatewayServerDeps;
  createGatewayServer: (deps?: GatewayServerDeps) => McpServer;
  logger?: {
    info: (...args: any[]) => void;
    error: (...args: any[]) => void;
    debug: (...args: any[]) => void;
  };
}

export interface HttpGatewayHandle {
  server: Server;
  url: string;
  close: () => Promise<void>;
  sessionCount: () => number;
}

interface SessionEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

const noopLogger = {
  info: (..._args: any[]) => {},
  error: (..._args: any[]) => {},
  debug: (..._args: any[]) => {},
};

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("error", reject);
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve("");
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readRawBody(req);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw error;
  }
}

function methodNotAllowed(res: ServerResponse): void {
  res.writeHead(405, { allow: "GET, POST, DELETE", "content-type": "application/json" });
  res.end(JSON.stringify({ error: "Method not allowed" }));
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function parseNoAuthPaths(raw: string | undefined, protectedPath: string): Set<string> {
  const paths = new Set<string>();
  for (const value of (raw ?? "").split(/[,;\s]+/)) {
    const path = value.trim();
    if (
      path &&
      path.startsWith("/") &&
      path !== protectedPath &&
      !path.includes("?") &&
      !path.includes("#") &&
      !path.includes("..")
    ) {
      paths.add(path);
    }
  }
  return paths;
}

function isLocalHost(host: string): boolean {
  const hostname = host.split(":")[0]?.toLowerCase() ?? "";
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function requestBaseUrl(req: IncomingMessage): string {
  const configured = process.env.LLM_GATEWAY_PUBLIC_URL;
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // Fall through to request-derived origin.
    }
  }
  const host = firstHeader(req.headers.host) ?? "127.0.0.1:3333";
  const forwardedProto = firstHeader(req.headers["x-forwarded-proto"]);
  const proto =
    forwardedProto ??
    (host.startsWith("127.0.0.1") || host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export async function startHttpGateway(options: HttpTransportOptions): Promise<HttpGatewayHandle> {
  const host = options.host ?? process.env.LLM_GATEWAY_HTTP_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.LLM_GATEWAY_HTTP_PORT ?? 3333);
  const path = options.path ?? process.env.LLM_GATEWAY_HTTP_PATH ?? "/mcp";
  const noAuthPaths = parseNoAuthPaths(process.env.LLM_GATEWAY_NO_AUTH_PATHS, path);
  const logger = options.logger ?? noopLogger;
  const sessions = new Map<string, SessionEntry>();
  const token = getRequiredBearerToken();
  const oauthConfig = loadRemoteOAuthConfig(logger);
  const oauthServer = oauthConfig.enabled
    ? new OAuthServer({ protectedPath: path, config: oauthConfig, logger })
    : null;

  async function closeSession(sessionId: string): Promise<void> {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    sessions.delete(sessionId);
    await entry.transport
      .close()
      .catch(error => logger.error("HTTP transport close failed", error));
    await entry.server.close().catch(error => logger.error("HTTP MCP server close failed", error));
  }

  async function createSession(): Promise<SessionEntry> {
    const gatewayServer = options.createGatewayServer(options.deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: sessionId => {
        sessions.set(sessionId, { server: gatewayServer, transport });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
    };
    transport.onerror = error => logger.error("HTTP MCP transport error", error);
    await gatewayServer.connect(transport);
    return { server: gatewayServer, transport };
  }

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
      const baseUrl = requestBaseUrl(req);
      const oauthOrigin = oauthServer ? oauthBaseUrlFromRequest(req, oauthConfig) : null;
      const effectiveOAuthBaseUrl = oauthOrigin ?? baseUrl;
      const resourceMetadataUrl =
        oauthServer && oauthOrigin ? oauthServer.resourceMetadataUrl(oauthOrigin) : undefined;

      if (url.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
        return;
      }

      if (oauthServer) {
        if (oauthServer.isOAuthPath(url.pathname) && !oauthOrigin) {
          jsonError(
            res,
            503,
            "LLM_GATEWAY_PUBLIC_URL is required for public OAuth issuer metadata"
          );
          return;
        }

        if (
          await oauthServer.handle({
            req,
            res,
            url,
            baseUrl: effectiveOAuthBaseUrl,
          })
        ) {
          return;
        }
      }

      const noAuthPath = noAuthPaths.has(url.pathname);
      if (url.pathname !== path && !noAuthPath) {
        jsonError(res, 404, "Not found");
        return;
      }

      let requestContext: GatewayRequestContext = { authScopes: [] };
      if (!noAuthPath) {
        const auth = authorizeBearerRequest(req, token);
        if (!auth.ok) {
          writeAuthFailure(res, auth, resourceMetadataUrl ? { resourceMetadataUrl } : {});
          return;
        }
        requestContext = {
          authKind: auth.kind,
          authScopes: auth.scopes ?? [],
          authClientId: auth.clientId,
        };
      }

      if (req.method !== "GET" && req.method !== "POST" && req.method !== "DELETE") {
        methodNotAllowed(res);
        return;
      }

      const sessionId = req.headers["mcp-session-id"];
      const normalizedSessionId = Array.isArray(sessionId) ? sessionId[0] : sessionId;

      if (req.method === "DELETE") {
        if (!normalizedSessionId) {
          jsonError(res, 400, "Missing mcp-session-id");
          return;
        }
        await closeSession(normalizedSessionId);
        res.writeHead(204);
        res.end();
        return;
      }

      if (normalizedSessionId) {
        const entry = sessions.get(normalizedSessionId);
        if (!entry) {
          jsonError(res, 404, "Unknown MCP session");
          return;
        }
        const body = req.method === "POST" ? await readBody(req) : undefined;
        await runWithRequestContext(requestContext, () =>
          entry.transport.handleRequest(req, res, body)
        );
        return;
      }

      if (req.method !== "POST") {
        if (req.method === "GET") {
          methodNotAllowed(res);
          return;
        }
        jsonError(res, 400, "Missing mcp-session-id");
        return;
      }

      const body = await readBody(req);
      if (!isInitializeRequest(body)) {
        jsonError(res, 400, "First request must be initialize");
        return;
      }

      const entry = await createSession();
      await runWithRequestContext(requestContext, () =>
        entry.transport.handleRequest(req, res, body)
      );
    } catch (error) {
      logger.error("HTTP transport request failed", error);
      if (!res.headersSent) {
        jsonError(res, 500, "Internal server error");
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${host}:${actualPort}${path}`;
  logger.info(`HTTP MCP transport listening at ${url}`);
  if (noAuthPaths.size > 0) {
    logger.info(`HTTP MCP transport also serving ${noAuthPaths.size} no-auth connector path(s)`);
  }

  return {
    server: httpServer,
    url,
    close: async () => {
      await Promise.all([...sessions.keys()].map(closeSession));
      await new Promise<void>((resolve, reject) => {
        httpServer.close(error => (error ? reject(error) : resolve()));
      });
    },
    sessionCount: () => sessions.size,
  };
}
