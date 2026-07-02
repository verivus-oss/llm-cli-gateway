//──────────────────────────────────────────────────────────────────────────────
// Centralized remote connector URL construction.
//
// Every user-facing remote-setup surface (doctor JSON, the copy-safe connector
// setup packet, the setup UI, the installer, the CLI `oauth client` output) and
// every runtime metadata endpoint (OAuth protected-resource metadata,
// authorization-server metadata, and the WWW-Authenticate `resource_metadata`
// challenge) must derive its URLs from the helpers here. Keeping the path
// suffixes and the base-origin resolution in one module is what prevents the
// diagnostics/setup surfaces from drifting away from what the running server
// actually serves.
//
// These helpers construct URLs only; they never read secrets and never emit
// anything but plain URL strings. Redaction of a base URL's userinfo is the
// caller's responsibility (see redactDiagnosticUrl in endpoint-exposure.ts) and
// is applied before handing a base origin to the diagnostic surfaces.
//──────────────────────────────────────────────────────────────────────────────

/** OAuth authorization endpoint path (relative to the base origin). */
export const OAUTH_AUTHORIZE_PATH = "/oauth/authorize";
/** OAuth token endpoint path. */
export const OAUTH_TOKEN_PATH = "/oauth/token";
/** OAuth dynamic client registration endpoint path. */
export const OAUTH_REGISTER_PATH = "/oauth/register";
/** RFC 9728 protected-resource metadata path. */
export const OAUTH_PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
/** RFC 8414 authorization-server metadata path. */
export const OAUTH_AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";
/** OpenID-Connect discovery path (served with the same body as RFC 8414 metadata). */
export const OPENID_CONFIGURATION_PATH = "/.well-known/openid-configuration";

/** Default MCP endpoint path when none is configured. */
export const DEFAULT_MCP_PATH = "/mcp";

/**
 * Join a base origin and an absolute path into a single URL, tolerating a
 * trailing slash on the base and a leading slash on the path so callers cannot
 * accidentally produce `//` or a missing separator. The base is expected to be
 * an origin (scheme://host[:port]); any path/query/hash on the base is dropped
 * so metadata URLs stay canonical.
 */
export function joinBaseAndPath(baseOrigin: string, path: string): string {
  const trimmedBase = baseOrigin.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${suffix}`;
}

/**
 * Normalize an arbitrary URL string to its origin (scheme://host[:port]),
 * returning null when the value is empty or not a parseable absolute URL. Used
 * so that a configured public URL or issuer with a stray path/query still
 * yields a clean origin for metadata construction.
 */
export function toOrigin(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl).origin;
  } catch {
    return null;
  }
}

/**
 * Resolve the base origin a remote connector should use, WITHOUT a live HTTP
 * request. Precedence matches the runtime request-based resolver in oauth.ts:
 *   1. A concrete (non-"auto") OAuth issuer, if configured.
 *   2. The configured public URL (LLM_GATEWAY_PUBLIC_URL).
 * Returns null when neither yields a usable origin: the signal that setup
 * cannot yet print issuer/authorize/token/mcp URLs (the missing_public_url
 * readiness stage).
 */
export function resolveConfiguredRemoteOrigin(opts: {
  issuer?: string | null;
  publicUrl?: string | null;
}): string | null {
  if (opts.issuer && opts.issuer !== "auto") {
    const fromIssuer = toOrigin(opts.issuer);
    if (fromIssuer) return fromIssuer;
  }
  return toOrigin(opts.publicUrl ?? null);
}

/**
 * The full set of remote connector URLs derived from a single base origin. All
 * fields are null when no base origin is known so callers never emit a partially
 * malformed URL. OAuth URLs are additionally null when OAuth is disabled.
 */
export interface RemoteConnectorUrls {
  /** The resolved base origin (scheme://host[:port]) or null. */
  baseOrigin: string | null;
  /** The MCP endpoint the connector talks to. */
  mcpUrl: string | null;
  /** OAuth issuer (equals baseOrigin when OAuth is enabled). */
  issuer: string | null;
  /** OAuth authorization endpoint. */
  authorizationUrl: string | null;
  /** OAuth token endpoint. */
  tokenUrl: string | null;
  /** OAuth dynamic client registration endpoint. */
  registrationUrl: string | null;
  /** RFC 9728 protected-resource metadata URL (matches WWW-Authenticate). */
  protectedResourceMetadataUrl: string | null;
  /** RFC 8414 authorization-server metadata URL. */
  authorizationServerMetadataUrl: string | null;
}

/**
 * Build every remote connector URL from one base origin + MCP path. When
 * `oauthEnabled` is false the OAuth-specific URLs are null (the connector would
 * use bearer/no-auth instead), but the MCP URL is still produced so bearer-token
 * clients can be pointed at the endpoint.
 */
export function buildRemoteConnectorUrls(opts: {
  baseOrigin: string | null;
  mcpPath?: string;
  oauthEnabled: boolean;
}): RemoteConnectorUrls {
  const base = opts.baseOrigin;
  const mcpPath = opts.mcpPath && opts.mcpPath.length > 0 ? opts.mcpPath : DEFAULT_MCP_PATH;
  if (!base) {
    return {
      baseOrigin: null,
      mcpUrl: null,
      issuer: null,
      authorizationUrl: null,
      tokenUrl: null,
      registrationUrl: null,
      protectedResourceMetadataUrl: null,
      authorizationServerMetadataUrl: null,
    };
  }
  const oauth = opts.oauthEnabled;
  return {
    baseOrigin: base,
    mcpUrl: joinBaseAndPath(base, mcpPath),
    issuer: oauth ? base : null,
    authorizationUrl: oauth ? joinBaseAndPath(base, OAUTH_AUTHORIZE_PATH) : null,
    tokenUrl: oauth ? joinBaseAndPath(base, OAUTH_TOKEN_PATH) : null,
    registrationUrl: oauth ? joinBaseAndPath(base, OAUTH_REGISTER_PATH) : null,
    protectedResourceMetadataUrl: oauth
      ? joinBaseAndPath(base, OAUTH_PROTECTED_RESOURCE_METADATA_PATH)
      : null,
    authorizationServerMetadataUrl: oauth
      ? joinBaseAndPath(base, OAUTH_AUTHORIZATION_SERVER_METADATA_PATH)
      : null,
  };
}
