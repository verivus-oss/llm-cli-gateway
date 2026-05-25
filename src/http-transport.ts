import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { authorizeBearerRequest, getRequiredBearerToken, writeAuthFailure } from "./auth.js";
import type { GatewayServerDeps } from "./index.js";

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

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("error", reject);
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function methodNotAllowed(res: ServerResponse): void {
  res.writeHead(405, { allow: "GET, POST, DELETE", "content-type": "application/json" });
  res.end(JSON.stringify({ error: "Method not allowed" }));
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: message }));
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

export async function startHttpGateway(options: HttpTransportOptions): Promise<HttpGatewayHandle> {
  const host = options.host ?? process.env.LLM_GATEWAY_HTTP_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.LLM_GATEWAY_HTTP_PORT ?? 3333);
  const path = options.path ?? process.env.LLM_GATEWAY_HTTP_PATH ?? "/mcp";
  const noAuthPaths = parseNoAuthPaths(process.env.LLM_GATEWAY_NO_AUTH_PATHS, path);
  const logger = options.logger ?? noopLogger;
  const sessions = new Map<string, SessionEntry>();
  const token = getRequiredBearerToken();

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
      if (url.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
        return;
      }
      const noAuthPath = noAuthPaths.has(url.pathname);
      if (url.pathname !== path && !noAuthPath) {
        jsonError(res, 404, "Not found");
        return;
      }

      if (!noAuthPath) {
        const auth = authorizeBearerRequest(req, token);
        if (!auth.ok) {
          writeAuthFailure(res, auth);
          return;
        }
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
        await entry.transport.handleRequest(req, res, body);
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
      await entry.transport.handleRequest(req, res, body);
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
