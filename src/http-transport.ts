import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  authorizeBearerRequest,
  getRequiredBearerToken,
  resolveTrustedPrincipal,
  writeAuthFailure,
} from "./auth.js";
import type { GatewayServerDeps } from "./index.js";
import { loadRemoteOAuthConfig, loadLimitsConfig, type HttpSessionLimitsConfig } from "./config.js";
import { OAuthServer, oauthBaseUrlFromRequest } from "./oauth.js";
import { runWithRequestContext, type GatewayRequestContext } from "./request-context.js";
import { readCappedRawBody, maxHttpBodyBytes } from "./request-limits.js";

export interface HttpTransportOptions {
  host?: string;
  port?: number;
  path?: string;
  deps?: GatewayServerDeps;
  createGatewayServer: (deps?: GatewayServerDeps) => McpServer;
  /**
   * Issue #130: HTTP session-lifecycle limits (max sessions, idle TTL, reaper
   * interval). When omitted they are loaded from ~/.llm-cli-gateway/config.toml
   * ([http] table). Tests pass explicit small values.
   */
  httpLimits?: HttpSessionLimitsConfig;
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
  /** Issue #130: prompt-free HTTP session metrics (current/max/oldestAgeMs/idleTtlMs/saturated). */
  sessionHealth: () => Record<string, unknown>;
}

interface SessionEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  sessionId?: string;
  /** Issue #130: epoch ms the session was created and last saw activity. */
  createdAt: number;
  lastActivityAt: number;
  /** Issue #130: number of requests currently executing on this session. */
  inFlight: number;
}

const noopLogger = {
  info: (..._args: any[]) => {},
  error: (..._args: any[]) => {},
  debug: (..._args: any[]) => {},
};

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readCappedRawBody(req, maxHttpBodyBytes());
  if (!raw) return undefined;
  return JSON.parse(raw);
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

function isLocalHost(host: string): boolean {
  const hostname = host.split(":")[0]?.toLowerCase() ?? "";
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\./.test(h);
}

/**
 * Whether the gateway is (or is about to be) reachable from off-host. A public
 * URL or tunnel provider means the loopback bind is fronted by something that
 * exposes it publicly, so a loopback bind alone is NOT proof of safety. Used to
 * fail closed on unsafe OAuth (public clients / open_dev) even when bound to
 * 127.0.0.1 behind a tunnel (F17 hardening).
 */
function isPubliclyExposed(env: NodeJS.ProcessEnv, host: string): boolean {
  if (!isLocalHost(host)) return true;
  if (env.LLM_GATEWAY_TUNNEL_PROVIDER && env.LLM_GATEWAY_TUNNEL_PROVIDER.trim().length > 0) {
    return true;
  }
  const publicUrl = env.LLM_GATEWAY_PUBLIC_URL;
  if (publicUrl && publicUrl.trim().length > 0) {
    try {
      if (!isLoopbackHostname(new URL(publicUrl).hostname)) return true;
    } catch {
      // Unparseable public URL: treat as not-exposed here; other diagnostics flag it.
    }
  }
  return false;
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
  let pendingInitializes = 0;
  // Issue #130: bounded HTTP session lifecycle. Defaults come from the [http]
  // config table unless the caller (tests) supplies explicit limits.
  const httpLimits = options.httpLimits ?? loadLimitsConfig(logger).http;
  const token = getRequiredBearerToken();
  const oauthConfig = loadRemoteOAuthConfig(logger);
  // F17: fail closed. A config that lets an unauthenticated party obtain a token
  // — public clients (no client secret) or open_dev dynamic registration — must
  // not be reachable from off-host. The actual listen address is the gate (the
  // Host header is not trusted; see registrationAllowedByPolicy). Bind to
  // loopback and front the gateway with an authenticating proxy, or use
  // registration_policy=static_clients with confidential client secrets.
  if (
    oauthConfig.enabled &&
    (oauthConfig.allowPublicClients || oauthConfig.registrationPolicy === "open_dev") &&
    isPubliclyExposed(process.env, host)
  ) {
    const exposure = !isLocalHost(host)
      ? `a non-loopback bind (host=${host})`
      : "a public URL / tunnel (LLM_GATEWAY_PUBLIC_URL or LLM_GATEWAY_TUNNEL_PROVIDER)";
    throw new Error(
      `Refusing to start: remote OAuth with ${
        oauthConfig.allowPublicClients ? "public clients" : "open_dev registration"
      } is exposed via ${exposure}. A loopback bind fronted by a public tunnel is still ` +
        `publicly reachable. Front the gateway with an authenticating proxy, or switch to ` +
        `registration_policy=static_clients with confidential client secrets.`
    );
  }
  const oauthServer = oauthConfig.enabled
    ? new OAuthServer({ protectedPath: path, config: oauthConfig, logger })
    : null;

  // Issue #130: close a session exactly once (idempotent via the sessions.get
  // guard) and tear down its transport + gateway server. Invoked from DELETE,
  // transport.onclose, the idle reaper, and gateway shutdown.
  async function closeSession(sessionId: string): Promise<void> {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    sessions.delete(sessionId);
    await entry.transport
      .close()
      .catch(error => logger.error("HTTP transport close failed", error));
    await entry.server.close().catch(error => logger.error("HTTP MCP server close failed", error));
  }

  function touchSessionComplete(entry: SessionEntry): void {
    entry.inFlight = Math.max(0, entry.inFlight - 1);
    entry.lastActivityAt = Date.now();
  }

  async function createSession(releaseInitializeReservation: () => void): Promise<SessionEntry> {
    const gatewayServer = options.createGatewayServer(options.deps);
    const onSessionInitialized = (sessionId: string): void => {
      const initializedAt = Date.now();
      releaseInitializeReservation();
      entry.sessionId = sessionId;
      entry.createdAt = initializedAt;
      entry.lastActivityAt = initializedAt;
      // The initialize request is already inside handleRequest when the SDK
      // exposes the session id. Count it as in-flight immediately so the idle
      // reaper cannot close a session that is still being initialized.
      entry.inFlight++;
      sessions.set(sessionId, entry);
    };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: onSessionInitialized,
    });
    const now = Date.now();
    const entry: SessionEntry = {
      server: gatewayServer,
      transport,
      createdAt: now,
      lastActivityAt: now,
      inFlight: 0,
    };
    transport.onclose = () => {
      if (transport.sessionId) {
        // Issue #130: onclose cleanup removes the session so the reaper never
        // touches a torn-down transport.
        sessions.delete(transport.sessionId);
      }
    };
    transport.onerror = error => logger.error("HTTP MCP transport error", error);
    await gatewayServer.connect(transport);
    return entry;
  }

  // Issue #130: reap sessions idle longer than the configured TTL. The reaper
  // does NOT depend on clients sending DELETE, and never closes a session with
  // an in-flight request (so long-running MCP calls are not reaped mid-flight).
  function reapIdleSessions(): void {
    const now = Date.now();
    for (const [sessionId, entry] of sessions) {
      if (entry.inFlight > 0) continue;
      if (now - entry.lastActivityAt < httpLimits.sessionIdleTtlMs) continue;
      logger.info(
        `Reaping idle HTTP MCP session (idle ${now - entry.lastActivityAt}ms >= ${httpLimits.sessionIdleTtlMs}ms)`
      );
      void closeSession(sessionId);
    }
  }

  const reaperTimer = setInterval(reapIdleSessions, httpLimits.sessionReaperIntervalMs);
  if (reaperTimer.unref) reaperTimer.unref();

  // Issue #130: prompt-free HTTP session metrics for /healthz.
  function sessionHealth(): Record<string, unknown> {
    const now = Date.now();
    let oldestAgeMs = 0;
    for (const entry of sessions.values()) {
      const age = now - entry.createdAt;
      if (age > oldestAgeMs) oldestAgeMs = age;
    }
    return {
      current: sessions.size,
      max: httpLimits.maxSessions,
      oldestAgeMs,
      idleTtlMs: httpLimits.sessionIdleTtlMs,
      reaperIntervalMs: httpLimits.sessionReaperIntervalMs,
      saturated: sessions.size + pendingInitializes >= httpLimits.maxSessions,
    };
  }

  // Issue #130: the full /healthz body. Job/limiter metrics are included when an
  // AsyncJobManager is attached (production + integration); parent-process
  // memory is always reported. Everything here is counts/ages/bytes only, never
  // prompt text, response content, tokens, or secrets.
  function healthPayload(): Record<string, unknown> {
    const manager = options.deps?.asyncJobManager;
    const mem = process.memoryUsage();
    const payload: Record<string, unknown> = {
      sessions: sessionHealth(),
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
      },
    };
    if (manager) {
      const limiter = manager.getLimiterSnapshot();
      const limits = manager.getConfiguredLimits();
      const durableAdmission = manager.getDurableAdmissionHealth();
      const persistence = options.deps?.persistence;
      const durablePersistenceConfigured =
        persistence !== undefined && persistence.backend !== "none" && persistence.asyncJobsEnabled;
      payload.jobs = {
        running: limiter.running,
        queued: limiter.queued,
        runningByProvider: limiter.runningByProvider,
        queuedByProvider: limiter.queuedByProvider,
        maxRunning: limiter.maxRunning,
        maxRunningPerProvider: limiter.maxRunningPerProvider,
        maxQueued: limiter.maxQueued,
        rejected: limiter.rejected,
        timedOut: limiter.timedOut,
        saturated: limiter.saturated,
        completedJobMemoryTtlMs: limits.completedJobMemoryTtlMs,
        maxJobOutputBytes: limits.maxJobOutputBytes,
        durableAdmission,
      };
      // `ok` remains a liveness signal. `ready` makes the degraded durable
      // state machine visible to callers without turning a recoverable async
      // admission outage into a misleading process-dead result. An explicitly
      // disabled backend remains ready; a configured backend whose store never
      // opened is not ready even though it has no attached manager store.
      payload.ready = durableAdmission.storeAttached
        ? durableAdmission.admitting
        : !durablePersistenceConfigured;
    }
    return payload;
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
        // Issue #130: prompt-free operational metrics (session caps/ages, job
        // limiter saturation, parent-process memory). No prompt text, response
        // content, tokens, session IDs, or secrets are included.
        res.end(JSON.stringify({ ok: true, ...healthPayload() }));
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

      let requestContext: GatewayRequestContext = { authScopes: [], transport: "http" };
      if (!noAuthPath) {
        const auth = authorizeBearerRequest(req, token);
        if (!auth.ok) {
          writeAuthFailure(res, auth, resourceMetadataUrl ? { resourceMetadataUrl } : {});
          return;
        }
        // F14: behind a trusted front door (static-bearer caller + opt-in header),
        // adopt the user identity the proxy asserted as the ownership principal;
        // otherwise the principal is the OAuth client id (undefined for the
        // shared static bearer / disabled auth).
        const trustedPrincipal = resolveTrustedPrincipal(req, auth);
        requestContext = {
          transport: "http",
          authKind: auth.kind,
          authScopes: auth.scopes ?? [],
          authClientId: auth.clientId,
          authPrincipal: trustedPrincipal ?? auth.clientId,
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
        // Issue #130: mark activity and hold an in-flight ref so the idle reaper
        // never closes a session with a request in progress; refresh activity on
        // completion too so a long call resets the idle clock.
        entry.lastActivityAt = Date.now();
        entry.inFlight++;
        try {
          await runWithRequestContext(requestContext, () =>
            entry.transport.handleRequest(req, res, body)
          );
        } finally {
          touchSessionComplete(entry);
        }
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

      // Issue #130: enforce the max-sessions cap BEFORE creating a new gateway
      // server/transport. A saturated gateway returns a retryable 429 with a
      // Retry-After hint and a structured, prompt-free error, so a client that
      // never sends DELETE cannot drive unbounded session-map growth.
      const capacityInUse = sessions.size + pendingInitializes;
      if (capacityInUse >= httpLimits.maxSessions) {
        res.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "5",
        });
        res.end(
          JSON.stringify({
            error: "Gateway at session capacity",
            code: "session_capacity",
            retryable: true,
            sessions: {
              current: sessions.size,
              pending: pendingInitializes,
              max: httpLimits.maxSessions,
            },
          })
        );
        logger.info(
          `Rejected new HTTP MCP session: at capacity (${capacityInUse}/${httpLimits.maxSessions})`
        );
        return;
      }

      pendingInitializes++;
      let reservationReleased = false;
      const releaseInitializeReservation = (): void => {
        if (reservationReleased) return;
        reservationReleased = true;
        pendingInitializes = Math.max(0, pendingInitializes - 1);
      };
      let entry: SessionEntry | undefined;
      try {
        const created = await createSession(releaseInitializeReservation);
        entry = created;
        await runWithRequestContext(requestContext, () =>
          created.transport.handleRequest(req, res, body)
        );
      } finally {
        releaseInitializeReservation();
        if (entry?.sessionId && sessions.get(entry.sessionId) === entry && entry.inFlight > 0) {
          touchSessionComplete(entry);
        }
      }
    } catch (error) {
      logger.error("HTTP transport request failed", error);
      if (!res.headersSent) {
        const statusCode = (error as { statusCode?: number } | null)?.statusCode;
        if (statusCode === 413) {
          jsonError(res, 413, "Payload too large");
        } else {
          jsonError(res, 500, "Internal server error");
        }
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
      // Issue #130: cancel the idle reaper on shutdown so no timer outlives the
      // gateway, then close every session exactly once.
      clearInterval(reaperTimer);
      await Promise.all([...sessions.keys()].map(closeSession));
      await new Promise<void>((resolve, reject) => {
        httpServer.close(error => (error ? reject(error) : resolve()));
      });
    },
    sessionCount: () => sessions.size,
    sessionHealth,
  };
}
