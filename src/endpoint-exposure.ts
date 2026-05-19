import { spawnSync } from "node:child_process";

export type EndpointExposureMode = "local_only" | "lan" | "tunnel" | "byo_reverse_proxy" | "misconfigured";
export type EndpointReachability = "not_checked" | "reachable" | "unreachable";

export interface EndpointExposureReport {
  mode: EndpointExposureMode;
  local_url: string;
  public_url_configured: boolean;
  public_url: string | null;
  https_required_for_web: boolean;
  https_configured: boolean;
  web_clients_supported: boolean;
  tunnel_provider: string | null;
  reachable_from_web: EndpointReachability;
  verification: {
    method: "not_checked" | "http_head";
    checked_url: string | null;
    status_code: number | null;
    error: string | null;
  };
  next_actions: string[];
}

const TUNNEL_HOST_PATTERNS = [
  /cloudflare/i,
  /trycloudflare\.com$/i,
  /ngrok(?:-free)?\.app$/i,
  /ngrok\.io$/i,
  /ts\.net$/i,
  /tailscale/i,
];

export function createEndpointExposureReport(
  env: NodeJS.ProcessEnv,
  redactedPublicUrl: string | null
): EndpointExposureReport {
  const host = env.LLM_GATEWAY_HTTP_HOST || "127.0.0.1";
  const port = Number(env.LLM_GATEWAY_HTTP_PORT || 3333);
  const path = env.LLM_GATEWAY_HTTP_PATH || "/mcp";
  const localHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const localUrl = `http://${localHost}:${port}${path}`;
  const rawPublicUrl = env.LLM_GATEWAY_PUBLIC_URL || "";
  const tunnelProvider = env.LLM_GATEWAY_TUNNEL_PROVIDER || inferTunnelProvider(rawPublicUrl);
  const httpsConfigured = rawPublicUrl.startsWith("https://");
  const publicConfigured = Boolean(redactedPublicUrl);
  const mode = classifyEndpointMode({ host, rawPublicUrl, tunnelProvider, httpsConfigured });
  const verification = maybeVerifyEndpoint(env, rawPublicUrl, mode);
  const webClientsSupported =
    publicConfigured &&
    httpsConfigured &&
    mode !== "local_only" &&
    mode !== "lan" &&
    verification.reachable_from_web === "reachable";

  const nextActions: string[] = [];
  if (!publicConfigured) {
    nextActions.push("Keep using local stdio/CLI clients, or configure an HTTPS tunnel before web-client setup.");
  } else if (mode === "local_only" || mode === "lan") {
    nextActions.push(
      "Set LLM_GATEWAY_PUBLIC_URL to a public HTTPS tunnel or reverse-proxy URL, not localhost or a LAN address."
    );
  } else if (!httpsConfigured) {
    nextActions.push("Use an HTTPS public URL before configuring ChatGPT, Claude web, or Grok web connectors.");
  }
  if (publicConfigured && mode !== "local_only" && mode !== "lan") {
    if (verification.method === "not_checked") {
      nextActions.push("Set LLM_GATEWAY_VERIFY_PUBLIC_URL=1 to have doctor check public endpoint reachability.");
    } else if (verification.reachable_from_web === "unreachable") {
      nextActions.push("Fix tunnel/proxy routing until the public MCP URL is reachable, then rerun doctor --json.");
    }
  }

  return {
    mode,
    local_url: localUrl,
    public_url_configured: publicConfigured,
    public_url: redactedPublicUrl,
    https_required_for_web: true,
    https_configured: httpsConfigured,
    web_clients_supported: webClientsSupported,
    tunnel_provider: tunnelProvider || null,
    reachable_from_web: verification.reachable_from_web,
    verification: {
      method: verification.method,
      checked_url: verification.checked_url ? redactDiagnosticUrl(verification.checked_url) : null,
      status_code: verification.status_code,
      error: verification.error,
    },
    next_actions: nextActions,
  };
}

export function redactDiagnosticUrl(rawUrl: string | null): string | null {
  if (!rawUrl) return null;
  const sensitiveKeyPattern =
    /auth|bearer|token|secret|credential|password|authorization|signature|api[_-]?key|access[_-]?key|jwt|cookie|session/i;
  const redactSensitivePairs = (value: string): string =>
    value.replace(new RegExp(`((${sensitiveKeyPattern.source})=)[^&\\s#]+`, "gi"), "$1<redacted>");
  try {
    const url = new URL(rawUrl);
    if (url.username) url.username = "<redacted>";
    if (url.password) url.password = "<redacted>";
    for (const key of Array.from(url.searchParams.keys())) {
      if (sensitiveKeyPattern.test(key)) {
        url.searchParams.set(key, "<redacted>");
      }
    }
    url.hash = redactSensitivePairs(url.hash);
    return url.toString().replace(/%3Credacted%3E/gi, "<redacted>");
  } catch {
    return redactSensitivePairs(rawUrl.replace(/(https?:\/\/)[^/@]+@/gi, "$1<redacted>@"));
  }
}

function classifyEndpointMode(input: {
  host: string;
  rawPublicUrl: string;
  tunnelProvider: string;
  httpsConfigured: boolean;
}): EndpointExposureMode {
  if (!input.rawPublicUrl) {
    if (input.host === "0.0.0.0" || input.host === "::" || isLanHost(input.host)) return "lan";
    return "local_only";
  }
  const publicHost = publicUrlHost(input.rawPublicUrl);
  if (!publicHost) return "misconfigured";
  if (isLoopbackHost(publicHost)) return "local_only";
  if (isLanHost(publicHost)) return "lan";
  if (!input.httpsConfigured) return "misconfigured";
  if (input.tunnelProvider) return "tunnel";
  return "byo_reverse_proxy";
}

function inferTunnelProvider(rawUrl: string): string {
  if (!rawUrl) return "";
  try {
    const host = new URL(rawUrl).hostname;
    if (TUNNEL_HOST_PATTERNS.some(pattern => pattern.test(host))) return host;
  } catch {
    // Treat unparsable URLs as not classified.
  }
  return "";
}

function isLanHost(host: string): boolean {
  const normalized = normalizeHost(host);
  const mappedIpv4 = ipv4FromMappedIpv6(normalized);
  if (mappedIpv4) return isLanHost(mappedIpv4);
  return (
    /^10\./.test(normalized) ||
    /^192\.168\./.test(normalized) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized) ||
    /^f[cd][0-9a-f]{2}:/i.test(normalized) ||
    /^fe80:/i.test(normalized)
  );
}

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);
  const mappedIpv4 = ipv4FromMappedIpv6(normalized);
  if (mappedIpv4) return isLoopbackHost(mappedIpv4);
  return (
    normalized === "localhost" ||
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === "::1" ||
    /^127\./.test(normalized)
  );
}

function publicUrlHost(rawUrl: string): string | null {
  try {
    return normalizeHost(new URL(rawUrl).hostname);
  } catch {
    return null;
  }
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, "");
}

function ipv4FromMappedIpv6(host: string): string | null {
  const dotted = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (dotted) return dotted[1];
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hex) return null;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
  return `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`;
}

function maybeVerifyEndpoint(
  env: NodeJS.ProcessEnv,
  rawPublicUrl: string,
  mode: EndpointExposureMode
): {
  method: "not_checked" | "http_head";
  checked_url: string | null;
  status_code: number | null;
  error: string | null;
  reachable_from_web: EndpointReachability;
} {
  if (!rawPublicUrl || env.LLM_GATEWAY_VERIFY_PUBLIC_URL !== "1") {
    return {
      method: "not_checked",
      checked_url: rawPublicUrl || null,
      status_code: null,
      error: null,
      reachable_from_web: "not_checked",
    };
  }
  if (mode === "local_only" || mode === "lan") {
    return {
      method: "not_checked",
      checked_url: rawPublicUrl,
      status_code: null,
      error: "Public URL points to localhost or a private LAN address.",
      reachable_from_web: "unreachable",
    };
  }

  const result = verifyEndpointSync(rawPublicUrl, 3_000);
  return {
    method: "http_head",
    checked_url: rawPublicUrl,
    status_code: result.statusCode,
    error: result.error,
    reachable_from_web: result.ok ? "reachable" : "unreachable",
  };
}

function verifyEndpointSync(url: string, timeoutMs: number): { ok: boolean; statusCode: number | null; error: string | null } {
  const script = `
    const { request: http } = require("node:http");
    const { request: https } = require("node:https");
    const target = new URL(process.argv[1]);
    const timeout = Number(process.argv[2]);
    const requester = target.protocol === "https:" ? https : http;
    const req = requester(target, { method: "HEAD", timeout, headers: { accept: "application/json, text/event-stream" } }, res => {
      res.resume();
      const statusCode = res.statusCode || 0;
      const endpointFound = statusCode < 500 && statusCode !== 404;
      console.log(JSON.stringify({ ok: endpointFound, statusCode: res.statusCode, error: null }));
    });
    req.on("timeout", () => {
      req.destroy(new Error("Endpoint verification timed out."));
    });
    req.on("error", err => {
      console.log(JSON.stringify({ ok: false, statusCode: null, error: err.message }));
    });
    req.end();
  `;
  const result = spawnSync(process.execPath, ["-e", script, url, String(timeoutMs)], {
    encoding: "utf8",
    timeout: timeoutMs + 1_000,
  });
  if (result.error) {
    return {
      ok: false,
      statusCode: null,
      error: result.error.message,
    };
  }
  try {
    return JSON.parse(result.stdout.trim()) as { ok: boolean; statusCode: number | null; error: string | null };
  } catch {
    return { ok: false, statusCode: null, error: "Endpoint verification failed." };
  }
}
