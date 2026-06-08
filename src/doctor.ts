import { existsSync, readFileSync } from "node:fs";
import { homedir, platform, arch, release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAuthConfig } from "./auth.js";
import {
  createEndpointExposureReport,
  redactDiagnosticUrl,
  type EndpointExposureReport,
} from "./endpoint-exposure.js";
import {
  listProviderRuntimeStatuses,
  type ProviderLoginStatus,
  type ProviderRuntimeStatus,
} from "./provider-status.js";
import { CLAUDE_MCP_SERVER_NAMES } from "./claude-mcp-config.js";
import type { FlightRecorderQuery } from "./flight-recorder.js";
import {
  loadCacheAwarenessConfig,
  loadRemoteOAuthConfig,
  type CacheAwarenessConfig,
} from "./config.js";
import { loadWorkspaceRegistry } from "./workspace-registry.js";
import { computeGlobalCacheStats } from "./cache-stats.js";
import { FlightRecorder, resolveFlightRecorderDbPath } from "./flight-recorder.js";
import { buildUpstreamContractReport } from "./upstream-contracts.js";

export type CliType = "claude" | "codex" | "gemini" | "grok" | "mistral";

/**
 * Slice 3 cross-cutting: doctor report block summarising the gateway's
 * cache-awareness posture. Always PRESENT in the report (zeroed when the
 * flight recorder has no rows for the last 24h).
 *
 * `enabled_features` is an empty array (NOT omitted) when all flags are
 * off so callers can distinguish "configured but dormant" from
 * "cache_awareness block missing".
 */
export interface CacheAwarenessReport {
  enabled_features: Array<"anthropic_cache_control" | "ttl_warnings">;
  last_24h: {
    hit_rate: number;
    total_hits: number;
    total_requests: number;
    estimated_savings_usd: number;
  };
  per_cli: Partial<
    Record<
      CliType,
      {
        hit_rate: number;
        total_hits: number;
        total_cache_read_tokens: number;
      }
    >
  >;
}

export interface VibeSessionLoggingStatus {
  config_path: string;
  config_present: boolean;
  session_logging_enabled: boolean;
  note: string;
}

export interface GeminiConfigStatus {
  /** Presence of a project-local `GEMINI.md` in the gateway's cwd. */
  project_gemini_md_present: boolean;
  project_gemini_md_path: string;
  /** Presence of `~/.gemini/GEMINI.md`. */
  user_gemini_md_present: boolean;
  user_gemini_md_path: string;
  /** Presence and contents of `~/.gemini/settings.json` `mcpServers` block. */
  settings_json_present: boolean;
  settings_json_path: string;
  mcp_servers_registered: string[];
  /** Per-server reconciliation against the gateway's `--allowed-mcp-server-names` whitelist. */
  mcp_reconciliation: {
    whitelisted: string[];
    missing_from_settings: string[];
  };
  next_actions: string[];
}

/**
 * Probe ~/.vibe/config.toml to see whether session_logging is enabled. Current
 * Mistral Vibe defaults session logging to enabled; an explicit
 * `[session_logging] enabled = false` disables `--continue` / `--resume`.
 * The probe is read-only: the gateway never mutates this file.
 */
export function checkVibeSessionLogging(home = homedir()): VibeSessionLoggingStatus {
  const configPath = join(home, ".vibe", "config.toml");
  if (!existsSync(configPath)) {
    return {
      config_path: configPath,
      config_present: false,
      session_logging_enabled: true,
      note: "~/.vibe/config.toml not found; current Vibe defaults session_logging.enabled to true. If resume fails, create ~/.vibe/config.toml with [session_logging]\\nenabled = true.",
    };
  }
  try {
    const text = readFileSync(configPath, "utf8");
    const enabled = parseVibeSessionLoggingEnabled(text);
    if (enabled !== false) {
      return {
        config_path: configPath,
        config_present: true,
        session_logging_enabled: true,
        note:
          enabled === true
            ? "session_logging.enabled is true; --continue/--resume will work for mistral_request."
            : "session_logging.enabled is not set; current Vibe defaults it to true.",
      };
    }
    return {
      config_path: configPath,
      config_present: true,
      session_logging_enabled: false,
      note: "[session_logging] enabled = false. Edit ~/.vibe/config.toml so the [session_logging] block sets enabled = true before using mistral_request --resume / --continue.",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      config_path: configPath,
      config_present: true,
      session_logging_enabled: false,
      note: `Could not parse ~/.vibe/config.toml: ${message}. Verify the file is valid TOML.`,
    };
  }
}

/**
 * Tiny TOML probe focused on `[session_logging] enabled = ...`. Avoids pulling
 * in the full `toml` parser when only one boolean is needed.
 */
function parseVibeSessionLoggingEnabled(text: string): boolean | undefined {
  const lines = text.split(/\r?\n/);
  let inSection = false;
  for (let raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[\s*([A-Za-z0-9_.-]+)\s*\]$/);
    if (sectionMatch) {
      inSection = sectionMatch[1] === "session_logging";
      continue;
    }
    if (inSection) {
      const kv = line.match(/^enabled\s*=\s*(.+)$/);
      if (kv) {
        const value = kv[1].trim().toLowerCase();
        if (value === "true") return true;
        if (value === "false") return false;
        return undefined;
      }
    } else {
      // Allow dotted form: session_logging.enabled = true
      const dotted = line.match(/^session_logging\.enabled\s*=\s*(.+)$/);
      if (dotted) {
        const value = dotted[1].trim().toLowerCase();
        if (value === "true") return true;
        if (value === "false") return false;
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * U27: Probe Gemini's project/user config locations.
 *
 * - `./GEMINI.md` (gateway cwd) and `~/.gemini/GEMINI.md` are documented
 *   "context" surfaces. Missing both means Gemini has no project-specific
 *   guidance.
 * - `~/.gemini/settings.json` defines registered MCP servers (`mcpServers`
 *   block). The gateway tracks its own whitelist (`CLAUDE_MCP_SERVER_NAMES`)
 *   and surfaces a reconciliation warning for each whitelisted server not
 *   present in settings.json so callers don't ship requests for unregistered
 *   servers.
 */
export function checkGeminiConfig(
  cwd: string = process.cwd(),
  home: string = homedir(),
  whitelist: readonly string[] = CLAUDE_MCP_SERVER_NAMES
): GeminiConfigStatus {
  const projectGeminiMd = join(cwd, "GEMINI.md");
  const userGeminiMd = join(home, ".gemini", "GEMINI.md");
  const settingsPath = join(home, ".gemini", "settings.json");

  const projectGeminiMdPresent = existsSync(projectGeminiMd);
  const userGeminiMdPresent = existsSync(userGeminiMd);
  const settingsPresent = existsSync(settingsPath);

  let mcpServersRegistered: string[] = [];
  if (settingsPresent) {
    try {
      const raw = readFileSync(settingsPath, "utf8");
      const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
      if (parsed && typeof parsed.mcpServers === "object" && parsed.mcpServers) {
        mcpServersRegistered = Object.keys(parsed.mcpServers);
      }
    } catch {
      // Best-effort: leave list empty so the next_action surfaces the gap.
    }
  }

  const missingFromSettings = whitelist.filter(name => !mcpServersRegistered.includes(name));

  const nextActions: string[] = [];
  if (!projectGeminiMdPresent && !userGeminiMdPresent) {
    nextActions.push(
      `Create ${projectGeminiMd} to give Gemini project-specific context (or ${userGeminiMd} for a user-wide default).`
    );
  }
  if (!settingsPresent) {
    nextActions.push(
      `Create ${settingsPath} to register MCP servers (mcpServers block). Run \`gemini mcp add <name>\` for each gateway-whitelisted server.`
    );
  }
  for (const name of missingFromSettings) {
    nextActions.push(
      `MCP server \`${name}\` is whitelisted by the gateway but not registered in ${settingsPath}. Run \`gemini mcp add ${name}\` to register it.`
    );
  }

  return {
    project_gemini_md_present: projectGeminiMdPresent,
    project_gemini_md_path: projectGeminiMd,
    user_gemini_md_present: userGeminiMdPresent,
    user_gemini_md_path: userGeminiMd,
    settings_json_present: settingsPresent,
    settings_json_path: settingsPath,
    mcp_servers_registered: mcpServersRegistered,
    mcp_reconciliation: {
      whitelisted: [...whitelist],
      missing_from_settings: missingFromSettings,
    },
    next_actions: nextActions,
  };
}

export interface DoctorReport {
  schema_version: "1.0";
  ok: boolean;
  generated_at: string;
  system: {
    os: NodeJS.Platform;
    arch: string;
    release: string;
    node_version: string;
  };
  gateway: {
    name: string;
    version: string;
  };
  transport: {
    default: "stdio" | "http";
    http: {
      enabled: boolean;
      host: string;
      port: number;
      path: string;
      public_url_configured: boolean;
      public_url: string | null;
      chatgpt_connector_url: string | null;
    };
  };
  auth: {
    required: boolean;
    token_configured: boolean;
    source: string;
    oauth: {
      enabled: boolean;
      registration_policy: string;
      clients_configured: number;
      shared_secret_enabled: boolean;
      pkce_required: boolean;
      issuer: string | null;
    };
  };
  workspaces: {
    enabled: boolean;
    default: string | null;
    repo_count: number;
    allowed_root_count: number;
    gateway_app_dir_is_workspace: boolean;
  };
  providers: Record<
    "claude" | "codex" | "gemini" | "grok" | "mistral",
    {
      cli_available: boolean;
      version: string | null;
      login_status: ProviderLoginStatus;
      version_command: string[];
      login_check: {
        method: "cli" | "credential_store" | "not_checked";
        command: string[] | null;
        credential_store: "present" | "not_found" | "not_checked";
        detail: string;
      };
      install_guidance: {
        summary: string;
        commands: string[];
        documentation_url?: string;
      };
      login_guidance: {
        summary: string;
        commands: string[];
        credential_handling: string;
      };
    }
  >;
  endpoint_exposure: EndpointExposureReport;
  client_config: {
    claude_desktop_config_present: boolean;
    codex_config_present: boolean;
    gemini_settings_present: boolean;
    gemini_config: GeminiConfigStatus;
    vibe_session_logging: VibeSessionLoggingStatus;
  };
  cache_awareness: CacheAwarenessReport;
  upstream: {
    note: string;
    recommendation: string;
    how_to_check: string;
    /** Whether the expensive installed binary probe was performed (requires --probe-upstream). */
    probed: boolean;
    /** Cheap installed versions (always present when CLIs are detected). */
    installed_versions: Partial<Record<CliType, string | null>>;
    /** Lightweight declared contracts (always present, no spawning). */
    contracts: ReturnType<typeof import("./upstream-contracts.js").buildUpstreamContractReport>;
    /** Full probed report only when --probe-upstream was used. */
    probe_report?: ReturnType<typeof import("./upstream-contracts.js").buildUpstreamContractReport>;
  };
  next_actions: string[];
}

function packageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "..", "package.json"), join(here, "..", "..", "package.json")];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: string };
      return parsed.version || "unknown";
    } catch {
      // Try next candidate.
    }
  }
  return "unknown";
}

function clientConfigStatus(home = homedir()): DoctorReport["client_config"] {
  return {
    claude_desktop_config_present:
      existsSync(join(home, "Library/Application Support/Claude/claude_desktop_config.json")) ||
      existsSync(join(home, ".config", "Claude", "claude_desktop_config.json")),
    codex_config_present: existsSync(join(home, ".codex", "config.toml")),
    gemini_settings_present:
      existsSync(join(home, ".gemini", "settings.json")) ||
      existsSync(join(home, ".config", "gemini", "settings.json")),
    gemini_config: checkGeminiConfig(process.cwd(), home),
    vibe_session_logging: checkVibeSessionLogging(home),
  };
}

function defaultTransport(env: NodeJS.ProcessEnv): "stdio" | "http" {
  if (env.LLM_GATEWAY_TRANSPORT === "http" || env.MCP_TRANSPORT === "http") return "http";
  return "stdio";
}

function chatGPTConnectorUrl(env: NodeJS.ProcessEnv, rawPublicUrl: string | null): string | null {
  const path = (env.LLM_GATEWAY_NO_AUTH_PATHS || "")
    .split(/[,;\s]+/)
    .map(value => value.trim())
    .find(value => value.startsWith("/") && !value.includes("?") && !value.includes("#"));
  if (!rawPublicUrl || !path) return null;
  return "<redacted>";
}

export interface CreateDoctorReportOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * Optional read access to the flight recorder. Drives the
   * cache_awareness.last_24h and per_cli aggregates. When absent, those
   * blocks report zeroed aggregates (still PRESENT in the report).
   */
  flightRecorder?: FlightRecorderQuery;
  /**
   * Optional CacheAwarenessConfig. Drives `enabled_features`. When
   * absent, `enabled_features` is empty (all behaviour considered off).
   */
  cacheAwareness?: CacheAwarenessConfig;
  /**
   * When true, perform the (potentially slow) installed CLI --help probe
   * for upstream contract drift detection. This is opt-in because it
   * spawns the real provider CLIs.
   */
  probeUpstream?: boolean;
}

/**
 * Build the cache_awareness block. ALWAYS present in the report; fields
 * are zeroed when the flight recorder is missing or empty.
 */
function buildCacheAwarenessReport(opts: CreateDoctorReportOptions): CacheAwarenessReport {
  const enabled: CacheAwarenessReport["enabled_features"] = [];
  if (opts.cacheAwareness?.emitAnthropicCacheControl) {
    enabled.push("anthropic_cache_control");
  }
  if (opts.cacheAwareness?.warnOnTtlExpiry) {
    enabled.push("ttl_warnings");
  }

  if (!opts.flightRecorder) {
    return {
      enabled_features: enabled,
      last_24h: {
        hit_rate: 0,
        total_hits: 0,
        total_requests: 0,
        estimated_savings_usd: 0,
      },
      per_cli: {},
    };
  }

  let stats;
  try {
    stats = computeGlobalCacheStats(opts.flightRecorder, { lastNHours: 24 });
  } catch {
    return {
      enabled_features: enabled,
      last_24h: {
        hit_rate: 0,
        total_hits: 0,
        total_requests: 0,
        estimated_savings_usd: 0,
      },
      per_cli: {},
    };
  }

  const perCli: CacheAwarenessReport["per_cli"] = {};
  for (const entry of stats.perCli) {
    perCli[entry.cli] = {
      hit_rate: entry.hitRate,
      total_hits: entry.hitCount,
      total_cache_read_tokens: entry.totalCacheReadTokens,
    };
  }

  return {
    enabled_features: enabled,
    last_24h: {
      hit_rate: stats.hitRate,
      total_hits: stats.totalHits,
      total_requests: stats.totalRequests,
      estimated_savings_usd: stats.estimatedSavingsUsd,
    },
    per_cli: perCli,
  };
}

export function createDoctorReport(
  envOrOptions: NodeJS.ProcessEnv | CreateDoctorReportOptions = process.env
): DoctorReport {
  // Preserve back-compat: previous signature accepted a bare `env` object.
  const opts: CreateDoctorReportOptions = isCreateDoctorReportOptions(envOrOptions)
    ? envOrOptions
    : { env: envOrOptions };
  const env: NodeJS.ProcessEnv = opts.env ?? process.env;
  const auth = loadAuthConfig(env);
  const oauth = loadRemoteOAuthConfig(undefined, env);
  const workspaceRegistry = loadWorkspaceRegistry();
  const transport = defaultTransport(env);
  const rawPublicUrl = env.LLM_GATEWAY_PUBLIC_URL || null;
  const publicUrl = redactDiagnosticUrl(rawPublicUrl);
  const endpointExposure = createEndpointExposureReport(env, publicUrl);
  const providerStatuses = listProviderRuntimeStatuses();
  const installedVersions: Partial<Record<CliType, string | null>> = {};
  for (const [name, status] of Object.entries(providerStatuses)) {
    installedVersions[name as CliType] = status.version;
  }

  const lightweightContracts = buildUpstreamContractReport({ probeInstalled: false });
  const probeReport = opts.probeUpstream
    ? buildUpstreamContractReport({ probeInstalled: true })
    : undefined;

  const upstream: DoctorReport["upstream"] = {
    note: "The gateway declares strict contracts for what flags, output modes, permission modes, and session/resume behaviour each provider CLI is expected to support.",
    recommendation:
      "After upgrading any provider CLI (especially fast-moving vendor binaries like grok), run the installed binary probe to detect drift between what the gateway expects and what your installed CLI actually advertises.",
    how_to_check: "llm-cli-gateway contracts --json --probe-installed   (or with --cli=grok etc.)",
    probed: !!opts.probeUpstream,
    installed_versions: installedVersions,
    contracts: lightweightContracts,
  };
  if (probeReport) {
    upstream.probe_report = probeReport;
  }

  const report: DoctorReport = {
    schema_version: "1.0",
    ok: true,
    generated_at: new Date().toISOString(),
    system: {
      os: platform(),
      arch: arch(),
      release: release(),
      node_version: process.version,
    },
    gateway: {
      name: "llm-cli-gateway",
      version: packageVersion(),
    },
    transport: {
      default: transport,
      http: {
        enabled: transport === "http",
        host: env.LLM_GATEWAY_HTTP_HOST || "127.0.0.1",
        port: Number(env.LLM_GATEWAY_HTTP_PORT || 3333),
        path: env.LLM_GATEWAY_HTTP_PATH || "/mcp",
        public_url_configured: Boolean(publicUrl),
        public_url: publicUrl,
        chatgpt_connector_url: chatGPTConnectorUrl(env, rawPublicUrl),
      },
    },
    auth: {
      required: auth.required,
      token_configured: auth.tokenConfigured,
      source: auth.source,
      oauth: {
        enabled: oauth.enabled,
        registration_policy: oauth.registrationPolicy,
        clients_configured: oauth.clients.length,
        shared_secret_enabled: Boolean(oauth.sharedSecret?.enabled),
        pkce_required: oauth.requirePkce,
        issuer:
          oauth.issuer === "auto"
            ? publicUrl
            : redactDiagnosticUrl(oauth.issuer === "auto" ? null : oauth.issuer),
      },
    },
    workspaces: {
      enabled: workspaceRegistry.enabled,
      default: workspaceRegistry.defaultAlias,
      repo_count: workspaceRegistry.repos.length,
      allowed_root_count: workspaceRegistry.allowedRoots.length,
      gateway_app_dir_is_workspace: workspaceRegistry.repos.some(
        repo => repo.path === join(homedir(), ".llm-cli-gateway")
      ),
    },
    providers: {
      claude: doctorProviderStatus(providerStatuses.claude),
      codex: doctorProviderStatus(providerStatuses.codex),
      gemini: doctorProviderStatus(providerStatuses.gemini),
      grok: doctorProviderStatus(providerStatuses.grok),
      mistral: doctorProviderStatus(providerStatuses.mistral),
    },
    endpoint_exposure: endpointExposure,
    client_config: clientConfigStatus(),
    cache_awareness: buildCacheAwarenessReport(opts),
    upstream,
    next_actions: [],
  };

  if (transport === "http" && auth.required && !auth.tokenConfigured) {
    report.ok = false;
    report.next_actions.push("Set LLM_GATEWAY_AUTH_TOKEN before starting HTTP transport.");
  }
  report.next_actions.push(...endpointExposure.next_actions);
  for (const [name, provider] of Object.entries(report.providers)) {
    if (!provider.cli_available) {
      report.next_actions.push(provider.install_guidance.summary);
    } else if (provider.login_status !== "authenticated") {
      report.next_actions.push(`${name}: ${provider.login_guidance.summary}`);
    }
  }
  // Mistral-specific: surface the session_logging toggle BEFORE a --continue/--resume
  // request fails opaquely. The check is read-only; the gateway never mutates the file.
  const vibeStatus = report.client_config.vibe_session_logging;
  if (report.providers.mistral.cli_available && !vibeStatus.session_logging_enabled) {
    report.next_actions.push(`mistral: ${vibeStatus.note}`);
  }
  // U27: surface Gemini config gaps (missing GEMINI.md, missing settings.json,
  // MCP-server whitelist drift) only when Gemini CLI is actually installed.
  if (report.providers.gemini.cli_available) {
    for (const action of report.client_config.gemini_config.next_actions) {
      report.next_actions.push(`gemini: ${action}`);
    }
  }
  if (report.next_actions.length === 0) {
    report.next_actions.push(
      "Run a client setup guide and verify with doctor --json after each step."
    );
  }

  // Upstream drift detection recommendation — surfaced for habitual use after provider upgrades.
  const hasAnyCli = Object.values(report.providers).some(p => p.cli_available);
  if (hasAnyCli) {
    if (report.upstream.probed) {
      report.next_actions.push(
        "Upstream probe was run (see upstream.probe_report for installed vs declared drift)."
      );
    } else {
      report.next_actions.push(
        "After upgrading provider CLIs, check for contract drift: " +
          report.upstream.how_to_check +
          "  (add --probe-upstream to this doctor command for one-shot probing)"
      );
    }
  }

  return report;
}

export function printDoctorJson(opts: { probeUpstream?: boolean } = {}): void {
  // Load cache-awareness config + open the flight recorder so the doctor
  // command can populate cache_awareness.last_24h. Both are best-effort —
  // failures degrade to the zeroed block (buildCacheAwarenessReport
  // handles missing deps).
  let cacheAwareness: CacheAwarenessConfig | undefined;
  let flightRecorder: FlightRecorder | undefined;
  try {
    cacheAwareness = loadCacheAwarenessConfig();
  } catch {
    // ignore
  }
  try {
    const dbPath = resolveFlightRecorderDbPath();
    if (dbPath) flightRecorder = new FlightRecorder(dbPath);
  } catch {
    // ignore
  }
  const report = createDoctorReport({
    env: process.env,
    cacheAwareness,
    flightRecorder,
    probeUpstream: opts.probeUpstream,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (flightRecorder) {
    try {
      flightRecorder.close();
    } catch {
      // best effort
    }
  }
}

function isCreateDoctorReportOptions(
  value: NodeJS.ProcessEnv | CreateDoctorReportOptions
): value is CreateDoctorReportOptions {
  // CreateDoctorReportOptions carries either `env` (an object) or
  // `flightRecorder` (an object). A NodeJS.ProcessEnv is a flat
  // Record<string, string|undefined> — even if a shell happens to export
  // `env=production` or `flightRecorder=...`, the value at that key is a
  // STRING, not an object, so the typeof checks here cannot collide.
  if (value === null || typeof value !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(value, "flightRecorder")) {
    const candidate = (value as { flightRecorder?: unknown }).flightRecorder;
    return candidate === undefined || typeof candidate === "object";
  }
  if (Object.prototype.hasOwnProperty.call(value, "env")) {
    const candidate = (value as { env?: unknown }).env;
    return candidate === undefined || typeof candidate === "object";
  }
  return false;
}

function doctorProviderStatus(
  provider: ProviderRuntimeStatus
): DoctorReport["providers"]["claude"] {
  return {
    cli_available: provider.installed,
    version: provider.version,
    login_status: provider.loginStatus,
    version_command: provider.versionCommand,
    login_check: {
      method: provider.loginCheck.method,
      command: provider.loginCheck.command,
      credential_store: provider.loginCheck.credentialStore,
      detail: provider.loginCheck.detail,
    },
    install_guidance: {
      summary: provider.guidance.install.summary,
      commands: provider.guidance.install.commands,
      documentation_url: provider.guidance.install.documentationUrl,
    },
    login_guidance: {
      summary: provider.guidance.login.summary,
      commands: provider.guidance.login.commands,
      credential_handling: provider.guidance.login.credentialHandling,
    },
  };
}
