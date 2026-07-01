//──────────────────────────────────────────────────────────────────────────────
// Copy-safe remote connector setup packet.
//
// Emits the exact fields an operator pastes into a remote connector UI (ChatGPT,
// Claude web, Grok web) plus a human summary, without ever printing secret
// material. It reuses the doctor `remote_http_oauth` readiness projection so its
// stage/URLs/next_actions are byte-identical to `doctor --json`.
//
// SECURITY: the default packet is copy-safe. It never contains gateway bearer
// tokens, OAuth access tokens, stored client secrets, secret hashes,
// consent/shared secrets, tunnel tokens, or provider credentials. The deprecated
// no-auth connector URL (a bearer-bypass, credential-equivalent value) is
// omitted unless the operator explicitly opts in with a legacy flag, and even
// then it is clearly labelled deprecated.
//──────────────────────────────────────────────────────────────────────────────

import {
  gatherRemoteHttpOAuthReadiness,
  type RemoteHttpOAuthReadiness,
} from "./doctor.js";
import { diagnoseRemoteOAuthConfig } from "./config.js";
import type { RemoteOAuthConfig } from "./auth.js";
import { joinBaseAndPath, resolveConfiguredRemoteOrigin } from "./remote-url.js";

/** Fixed warning shown on every packet: never paste secrets into a chat. */
export const CONNECTOR_SETUP_SECRET_WARNING =
  "Never paste gateway bearer tokens, OAuth client secrets, OAuth access tokens, consent/shared secrets, tunnel tokens, or provider credentials into a remote chat transcript. Only the fields in this packet are safe to paste into a connector UI.";

export interface ConnectorSetupOptions {
  /** Which client id the packet targets (shown as connector.client_id). */
  clientId?: string;
  /** Opt-in: include the deprecated no-auth connector URL (bearer bypass). */
  includeLegacyNoAuth?: boolean;
}

export interface ConnectorSetupPacket {
  ok: boolean;
  schema: "remote-connector-setup.v1";
  ready: boolean;
  stage: RemoteHttpOAuthReadiness["stage"];
  auth_mode: RemoteHttpOAuthReadiness["auth_mode"];
  connector: {
    mcp_url: string | null;
    authorization_url: string | null;
    token_url: string | null;
    client_id: string | null;
    /** True when a confidential client secret must be pasted from a copy-once command. */
    client_secret_required: boolean;
    /** Where to obtain the copy-once secret; never the secret itself. */
    client_secret_source: string | null;
  };
  workspace: RemoteHttpOAuthReadiness["workspace"];
  next_actions: string[];
  warnings: string[];
  /**
   * Present only when the operator opted in with the legacy flag. The URL
   * bypasses authentication and must not be shared; it is deprecated.
   */
  legacy_no_auth?: {
    deprecated: true;
    connector_url: string | null;
    note: string;
  };
}

/**
 * Pure builder for the connector setup packet. Kept side-effect-free so it is
 * directly unit-testable and shares one code path with the CLI command.
 */
export function buildConnectorSetupPacket(input: {
  readiness: RemoteHttpOAuthReadiness;
  oauth: RemoteOAuthConfig;
  options?: ConnectorSetupOptions;
  /** Real (unredacted) no-auth connector URL, only when legacy opt-in is set. */
  legacyNoAuthUrl?: string | null;
}): ConnectorSetupPacket {
  const { readiness, oauth } = input;
  const options = input.options ?? {};

  // Resolve the target client id: an explicit --client-id wins; otherwise the
  // first configured client (if any). Never invents a secret.
  const configuredClientId = oauth.clients[0]?.clientId ?? null;
  const clientId = options.clientId ?? configuredClientId;

  // A confidential client requires a copy-once secret pasted by the operator.
  const clientSecretRequired = oauth.enabled && !oauth.allowPublicClients;
  const clientSecretSource = clientSecretRequired
    ? "Run `llm-cli-gateway oauth client add <client-id> --redirect-uri <connector-callback> --print-once` (or `oauth client rotate <client-id> --print-once`) and paste the printed secret once into the connector UI."
    : null;

  const packet: ConnectorSetupPacket = {
    ok: true,
    schema: "remote-connector-setup.v1",
    ready: readiness.ready,
    stage: readiness.stage,
    auth_mode: readiness.auth_mode,
    connector: {
      mcp_url: readiness.mcp_url,
      authorization_url: readiness.oauth.authorization_url,
      token_url: readiness.oauth.token_url,
      client_id: clientId,
      client_secret_required: clientSecretRequired,
      client_secret_source: clientSecretSource,
    },
    workspace: readiness.workspace,
    next_actions: readiness.next_actions,
    warnings: [CONNECTOR_SETUP_SECRET_WARNING],
  };

  if (options.includeLegacyNoAuth) {
    packet.legacy_no_auth = {
      deprecated: true,
      connector_url: input.legacyNoAuthUrl ?? null,
      note: "Deprecated no-auth connector URL. It bypasses authentication; prefer OAuth. Do not share this URL.",
    };
  }

  return packet;
}

/**
 * Compute the deprecated no-auth connector URL from the environment. Returns
 * null when no no-auth path or public URL is configured. The URL is a
 * bearer-bypass value, so it is only ever produced for the explicit legacy
 * opt-in path.
 */
export function legacyNoAuthConnectorUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const noAuthPath = (env.LLM_GATEWAY_NO_AUTH_PATHS || "")
    .split(/[,;\s]+/)
    .map(value => value.trim())
    .find(value => value.startsWith("/") && !value.includes("?") && !value.includes("#"));
  if (!noAuthPath) return null;
  const baseOrigin = resolveConfiguredRemoteOrigin({ publicUrl: env.LLM_GATEWAY_PUBLIC_URL ?? null });
  if (!baseOrigin) return null;
  return joinBaseAndPath(baseOrigin, noAuthPath);
}

/** Gather live readiness + OAuth config and build the packet for the CLI. */
export function gatherConnectorSetupPacket(
  options: ConnectorSetupOptions = {},
  env: NodeJS.ProcessEnv = process.env
): ConnectorSetupPacket {
  const readiness = gatherRemoteHttpOAuthReadiness(env);
  const oauth = diagnoseRemoteOAuthConfig(undefined, env).config;
  const legacyNoAuthUrl = options.includeLegacyNoAuth ? legacyNoAuthConnectorUrl(env) : null;
  return buildConnectorSetupPacket({ readiness, oauth, options, legacyNoAuthUrl });
}

/**
 * Render a concise, secret-free human summary of the packet for stderr. The
 * machine-readable JSON is what goes to stdout; this is operator-facing text.
 */
export function renderConnectorSetupSummary(packet: ConnectorSetupPacket): string {
  const lines: string[] = [];
  lines.push(`Remote connector readiness: ${packet.stage}${packet.ready ? " (ready)" : ""}`);
  lines.push(`Authentication mode: ${packet.auth_mode}`);
  if (packet.connector.mcp_url) lines.push(`MCP URL:            ${packet.connector.mcp_url}`);
  if (packet.connector.authorization_url)
    lines.push(`Authorization URL:  ${packet.connector.authorization_url}`);
  if (packet.connector.token_url) lines.push(`Token URL:          ${packet.connector.token_url}`);
  if (packet.connector.client_id) lines.push(`Client ID:          ${packet.connector.client_id}`);
  if (packet.connector.client_secret_required && packet.connector.client_secret_source) {
    lines.push(`Client secret:      ${packet.connector.client_secret_source}`);
  }
  lines.push(
    `Workspace:          ${
      packet.workspace.ready
        ? `ready (default: ${packet.workspace.default ?? "none, pass a registered alias"})`
        : "not ready"
    }`
  );
  if (packet.next_actions.length > 0) {
    lines.push("Next actions:");
    for (const action of packet.next_actions) lines.push(`  - ${action}`);
  }
  lines.push(packet.warnings[0] ?? CONNECTOR_SETUP_SECRET_WARNING);
  return lines.join("\n");
}
