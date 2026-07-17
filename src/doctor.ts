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
  getApiProviderStatus,
  listProviderRuntimeStatuses,
  type ProviderLoginStatus,
  type ProviderRuntimeStatus,
} from "./provider-status.js";
import {
  getApiProviderLoginGuidance,
  type ApiProviderLoginGuidance,
} from "./provider-login-guidance.js";
import { CLAUDE_MCP_SERVER_NAMES } from "./claude-mcp-config.js";
import type { FlightRecorderQuery } from "./flight-recorder.js";
import {
  defaultLeastCostConfig,
  diagnoseRemoteOAuthConfig,
  enabledApiProviders,
  loadCacheAwarenessConfig,
  loadLeastCostConfig,
  loadPersistenceConfig,
  loadProvidersConfig,
  type CacheAwarenessConfig,
  type LeastCostConfig,
  type PersistenceConfig,
  type ProvidersConfig,
  type RemoteOAuthConfigDiagnostics,
} from "./config.js";
import { telemetryTierFor, type TelemetryTier } from "./lcr-telemetry.js";
import { API_CATALOG_AS_OF, PRICING_AS_OF, getModelCost, modelIdToFamily } from "./pricing.js";
import { computeLcrPriorsFromDb } from "./lcr-priors.js";
import { getCliInfo } from "./model-registry.js";
import type { Confidence, PriceSource, QualityTier } from "./least-cost-types.js";
import type { AuthConfig } from "./auth.js";
import {
  loadWorkspaceRegistry,
  remoteSafeWorkspaceSummary,
  type RemoteSafeWorkspaceSummary,
} from "./workspace-registry.js";
import { buildRemoteConnectorUrls, resolveConfiguredRemoteOrigin } from "./remote-url.js";
import { computeGlobalCacheStats } from "./cache-stats.js";
import { FlightRecorder, resolveFlightRecorderDbPath } from "./flight-recorder.js";
import {
  buildUpstreamContractReport,
  type InstalledCliContractProbe,
} from "./upstream-contracts.js";
import {
  getProviderToolCapabilities,
  knownProviderCapabilityIds,
  type ProviderCapabilityId,
  type ProviderKind,
} from "./provider-tool-capabilities.js";
import {
  loadPersonalConfigSettings,
  PersonalConfigManager,
  PERSONAL_CONFIG_SYNC_ERROR_WITHHELD,
  type PersonalConfigStatus,
} from "./personal-config.js";
import { CLI_TYPES, type CliType } from "./session-manager.js";

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

export interface ProviderCapabilitySummaryReport {
  schema_version: "provider-tool-capabilities.v2";
  tool: "provider_tool_capabilities";
  resources: {
    catalog: "provider-tools://catalog";
    providers: Record<ProviderCapabilityId, string>;
  };
  cache_ttl_ms: number;
  providers: Record<
    ProviderCapabilityId,
    {
      provider_kind: ProviderKind;
      cli_available: boolean;
      gateway_request_tools: string[];
      supported_features: string[];
      unsupported_inputs: string[];
      config_surface_count: number;
      discovered_skill_count: number;
      discovered_provider_tool_count: number;
      warnings: string[];
    }
  >;
}

/**
 * Slice 6: per-API-provider health entry. Reports key presence + endpoint
 * shape; never the key value. `reachable` stays null unless the opt-in
 * `--probe-api-providers` reachability probe ran.
 */
export interface ApiProviderHealthEntry {
  name: string;
  kind: "openai-compatible" | "anthropic" | "xai-responses";
  base_url: string;
  default_model: string;
  models: string[] | null;
  /** The env var the key is read from, or null for a keyless-local provider. */
  api_key_env: string | null;
  /** Whether the configured key env var resolves to a non-empty value. */
  api_key_present: boolean;
  /** null = not probed; true/false = opt-in reachability probe result. */
  reachable: boolean | null;
  /** Set only when a reachability probe ran and failed. */
  reachability_error?: string;
  /** How to obtain/configure the key for this provider (no secret material). */
  login_guidance: ApiProviderLoginGuidance;
}

export interface ApiProviderHealthReport {
  enabled_count: number;
  providers: Record<string, ApiProviderHealthEntry>;
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
  for (const raw of lines) {
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

/**
 * LCR phase_3 (DAG step `doctor-eligibility`, `[observability].doctor`):
 * economics-only eligibility summary for least-cost routing. Prompt-free and
 * secret-free by construction: it carries only model names, resolved pricing
 * families, price provenance, capability tiers, telemetry tiers, price-table
 * staleness, and anonymized (content-type, family) calibration buckets. No raw
 * prompts, no secrets, no base_url userinfo, no principal.
 *
 * ALWAYS present in the report. When `[least_cost].enabled` is false the block
 * is compact: `enabled:false` plus `pricing` (so operators still see staleness)
 * and empty `providers` / `untieredModels` / `calibrationQuality` arrays. The
 * block never spawns a CLI; per-candidate eligibility (priced / tiered /
 * telemetry) needs no provider process.
 */
export interface LeastCostCandidateReport {
  /** CLI-brand model id / alias from the model registry (getCliInfo). */
  model: string;
  /** Resolved pricing family (modelIdToFamily), CLI-agnostic. */
  family: string;
  /** True when getModelCost resolved a price (source !== "unknown"). */
  priced: boolean;
  /** Price provenance: "table", "api-catalog", or "unknown". */
  priceSource: PriceSource;
  /** Capability tier from LeastCostConfig.tiers[`provider:family`], or null (UNTIERED). */
  tier: QualityTier | null;
}

export interface LeastCostProviderReport {
  provider: CliType;
  /** Per-provider telemetry tier T1-T4 (telemetryTierFor). */
  telemetryTier: TelemetryTier;
  candidates: LeastCostCandidateReport[];
}

/** One anonymized (content-type, family) calibration bucket (spec 4.2 enh 5). */
export interface LeastCostCalibrationBucketReport {
  /** Bucket key `"<content-type>:<family>"`. */
  bucket: string;
  /** Learned input-token calibration factor `k = median(actual/base)`. */
  k: number;
  samples: number;
  /** Advisory confidence label derived from calibration quality. */
  confidence: Confidence;
}

export interface LeastCostReport {
  enabled: boolean;
  pricing: {
    /** CLI family price table timestamp (PRICING_AS_OF). */
    tableAsOf: string;
    /** Published API-catalog refresh timestamp (API_CATALOG_AS_OF). */
    apiCatalogAsOf: string;
    /** Whole days since the NEWER of the two asOf dates vs the doctor run date (>= 0). */
    staleDays: number;
  };
  /** Per-CLI-provider eligibility candidates. Empty when routing is disabled. */
  providers: LeastCostProviderReport[];
  /** `"<provider>:<model>"` for every candidate whose tier is null. */
  untieredModels: string[];
  /** Per-bucket calibration quality. Empty when disabled / no learning data. */
  calibrationQuality: LeastCostCalibrationBucketReport[];
}

/**
 * Read-only Personal Agent Config Kit readiness. This is intentionally a
 * narrow projection: it never includes baseline paths, configuration source
 * paths, remote URLs, or raw synchronization diagnostics.
 *
 * `durable_async_configured` describes resolved configuration only. It does
 * not claim that a running gateway currently has a healthy durable store.
 */
export interface PersonalConfigReadinessReport {
  enabled: boolean;
  configuration_valid: boolean;
  ready: boolean;
  /** Whether Claude Kit's isolated --bare mode has its required API credential. */
  claude_bare_auth_configured: boolean;
  baseline_present: boolean;
  current_release_id: string | null;
  last_success_at: string | null;
  stale: boolean;
  last_sync_error: string | null;
  durable_async_configured: boolean;
}

export interface PersonalConfigReadinessInput {
  enabled: boolean;
  configurationValid?: boolean;
  /** Secret-free presence signal for ANTHROPIC_API_KEY in the gateway process. */
  claudeBareAuthConfigured?: boolean;
  status?: Pick<
    PersonalConfigStatus,
    "baselinePresent" | "currentReleaseId" | "lastSuccessAt" | "stale" | "lastSyncError"
  >;
  persistence?: Pick<PersistenceConfig, "backend" | "asyncJobsEnabled"> | null;
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
    CliType,
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
  /**
   * Stable readiness projection for the preferred remote connector path
   * (public HTTPS URL + /mcp + OAuth + registered/default workspace). Combines
   * endpoint-exposure, OAuth config, OAuth metadata URLs, client registration,
   * and workspace readiness into an ordered decision tree so an operator or
   * setup assistant sees the single next blocking action. Contains no secrets.
   */
  remote_http_oauth: RemoteHttpOAuthReadiness;
  client_config: {
    claude_desktop_config_present: boolean;
    codex_config_present: boolean;
    gemini_settings_present: boolean;
    gemini_config: GeminiConfigStatus;
    vibe_session_logging: VibeSessionLoggingStatus;
  };
  cache_awareness: CacheAwarenessReport;
  provider_capabilities: ProviderCapabilitySummaryReport;
  /**
   * LCR phase_3: least-cost-routing eligibility summary (pricing staleness,
   * per-provider telemetry tier, per-candidate priced/tier, untiered models,
   * calibration quality). ALWAYS present; compact when routing is disabled.
   * Economics-only and secret-free (see {@link LeastCostReport}).
   */
  least_cost: LeastCostReport;
  /**
   * Secret-free local readiness for the optional Personal Agent Config Kit.
   * Always present, including when the Kit is disabled.
   */
  personal_config: PersonalConfigReadinessReport;
  /**
   * Slice 6: health of enabled generic `[providers.<name>]` (kind:"api")
   * providers. OMITTED entirely when none are enabled, so a CLI-only gateway's
   * report is byte-identical to before. `reachable` is null unless the doctor
   * was run with `--probe-api-providers` (the reachability probe is opt-in and
   * off by default; a normal run spends no network or tokens).
   */
  api_providers?: ApiProviderHealthReport;
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

/**
 * Stable, ordered readiness stages for the remote HTTP + OAuth connector path.
 * The order encodes the decision tree: the first failing gate is the reported
 * stage, so the operator always sees the single next blocking action. These
 * values are a stable contract consumed by the setup UI, setup assistants, the
 * installer, docs, and tests; do not renumber or rename them.
 */
export type RemoteHttpOAuthStage =
  | "not_started"
  | "missing_public_url"
  | "endpoint_unreachable"
  | "oauth_disabled"
  | "unsafe_oauth_config"
  | "missing_oauth_client"
  | "missing_workspace"
  | "ready";

export const REMOTE_HTTP_OAUTH_STAGES: readonly RemoteHttpOAuthStage[] = [
  "not_started",
  "missing_public_url",
  "endpoint_unreachable",
  "oauth_disabled",
  "unsafe_oauth_config",
  "missing_oauth_client",
  "missing_workspace",
  "ready",
] as const;

export interface RemoteHttpOAuthReadiness {
  ready: boolean;
  stage: RemoteHttpOAuthStage;
  /** Redacted public URL (LLM_GATEWAY_PUBLIC_URL), or null when unset. */
  public_url: string | null;
  /** Full MCP endpoint URL a connector talks to, or null when no public URL. */
  mcp_url: string | null;
  /** Effective authentication mode a remote connector would use. */
  auth_mode: "oauth" | "bearer_token" | "none";
  oauth: {
    enabled: boolean;
    /** OAuth issuer origin (redacted), or null when OAuth is off / no URL. */
    issuer: string | null;
    authorization_url: string | null;
    token_url: string | null;
    registration_policy: string;
    clients_configured: number;
    consent_required: boolean;
  };
  workspace: {
    ready: boolean;
    default: string | null;
    aliases: string[];
  };
  /** Deterministic, secret-free next actions for the current stage. */
  next_actions: string[];
}

/**
 * Inputs for the pure readiness builder. Kept normalized (no fs/env access) so
 * the decision tree is directly unit-testable and so both doctor and the
 * connector setup command feed it identical data.
 */
export interface RemoteHttpOAuthReadinessInput {
  oauthDiag: Pick<RemoteOAuthConfigDiagnostics, "status" | "config" | "issues">;
  workspace: RemoteSafeWorkspaceSummary;
  auth: AuthConfig;
  transport: "stdio" | "http";
  /** Redacted public URL. */
  publicUrl: string | null;
  endpoint: EndpointExposureReport;
  mcpPath: string;
}

/**
 * Pure decision tree for remote HTTP + OAuth readiness. All URL construction is
 * delegated to remote-url.ts so doctor, the setup packet, the setup UI, and the
 * runtime metadata endpoints cannot drift. Never emits secret material.
 */
export function buildRemoteHttpOAuthReadiness(
  input: RemoteHttpOAuthReadinessInput
): RemoteHttpOAuthReadiness {
  const { config: oauth, status, issues } = input.oauthDiag;
  const e = input.endpoint;

  const baseOrigin = resolveConfiguredRemoteOrigin({
    issuer: oauth.issuer === "auto" ? null : redactDiagnosticUrl(oauth.issuer),
    publicUrl: input.publicUrl,
  });
  const urls = buildRemoteConnectorUrls({
    baseOrigin,
    mcpPath: input.mcpPath,
    oauthEnabled: oauth.enabled,
  });

  // A usable public endpoint means a configured, HTTPS, publicly-routed URL.
  const hasValidPublicHttpsUrl =
    e.public_url_configured &&
    e.https_configured &&
    (e.mode === "tunnel" || e.mode === "byo_reverse_proxy");
  const oauthNotEnabled = status === "absent" || status === "disabled";
  const oauthUnsafeForRemote =
    status === "malformed" ||
    (oauth.enabled && (oauth.allowPublicClients || oauth.registrationPolicy === "open_dev"));

  let stage: RemoteHttpOAuthStage;
  if (!e.public_url_configured && input.transport !== "http" && status === "absent") {
    stage = "not_started";
  } else if (!hasValidPublicHttpsUrl) {
    stage = "missing_public_url";
  } else if (e.reachable_from_web === "unreachable") {
    stage = "endpoint_unreachable";
  } else if (oauthNotEnabled) {
    stage = "oauth_disabled";
  } else if (oauthUnsafeForRemote) {
    stage = "unsafe_oauth_config";
  } else if (oauth.registrationPolicy === "static_clients" && oauth.clients.length === 0) {
    stage = "missing_oauth_client";
  } else if (!input.workspace.ready) {
    stage = "missing_workspace";
  } else {
    stage = "ready";
  }

  const authMode: RemoteHttpOAuthReadiness["auth_mode"] = oauth.enabled
    ? "oauth"
    : input.auth.required && input.auth.tokenConfigured
      ? "bearer_token"
      : "none";

  return {
    ready: stage === "ready",
    stage,
    public_url: input.publicUrl,
    mcp_url: urls.mcpUrl,
    auth_mode: authMode,
    oauth: {
      enabled: oauth.enabled,
      issuer: urls.issuer,
      authorization_url: urls.authorizationUrl,
      token_url: urls.tokenUrl,
      registration_policy: oauth.registrationPolicy,
      clients_configured: oauth.clients.length,
      consent_required: oauth.requireConsent,
    },
    workspace: {
      ready: input.workspace.ready,
      default: input.workspace.default,
      aliases: input.workspace.aliases,
    },
    next_actions: remoteReadinessNextActions(stage, {
      oauth,
      status,
      issues,
      workspace: input.workspace,
      endpointReachability: e.reachable_from_web,
    }),
  };
}

/**
 * Deterministic, secret-free next actions keyed by readiness stage. Commands use
 * angle-bracket placeholders (never real values) and never echo secrets.
 */
function remoteReadinessNextActions(
  stage: RemoteHttpOAuthStage,
  ctx: {
    oauth: RemoteOAuthConfigDiagnostics["config"];
    status: RemoteOAuthConfigDiagnostics["status"];
    issues: string[];
    workspace: RemoteSafeWorkspaceSummary;
    endpointReachability: EndpointExposureReport["reachable_from_web"];
  }
): string[] {
  switch (stage) {
    case "not_started":
      return [
        "Remote HTTP + OAuth setup has not started. Start an HTTPS tunnel or reverse proxy and set LLM_GATEWAY_PUBLIC_URL to the public https URL.",
        "Then register an OAuth client: llm-cli-gateway oauth client add <client-id> --redirect-uri <connector-callback> --print-once",
      ];
    case "missing_public_url":
      return [
        "Set LLM_GATEWAY_PUBLIC_URL to a public https URL (tunnel or reverse proxy), not localhost or a LAN address.",
        "Re-run: llm-cli-gateway doctor --json",
      ];
    case "endpoint_unreachable":
      return [
        "The public MCP URL is configured but not reachable from the web. Fix tunnel/reverse-proxy routing, then re-run: llm-cli-gateway doctor --json",
      ];
    case "oauth_disabled":
      return [
        "OAuth is the recommended remote connector authentication mode. Enable it by registering a client: llm-cli-gateway oauth client add <client-id> --redirect-uri <connector-callback> --print-once",
      ];
    case "unsafe_oauth_config": {
      const reasons: string[] = [];
      if (ctx.status === "malformed") {
        reasons.push(
          ...(ctx.issues.length
            ? ctx.issues
            : ["The [http.oauth] config is invalid; fix it and re-run doctor --json."])
        );
      } else {
        if (ctx.oauth.allowPublicClients) {
          reasons.push(
            "OAuth allow_public_clients is enabled on a public endpoint. Use confidential clients: registration_policy=static_clients with a client secret."
          );
        }
        if (ctx.oauth.registrationPolicy === "open_dev") {
          reasons.push(
            "OAuth registration_policy=open_dev is unsafe on a public endpoint. Switch to static_clients with confidential client secrets."
          );
        }
      }
      reasons.push("Re-run: llm-cli-gateway doctor --json");
      return reasons;
    }
    case "missing_oauth_client":
      return [
        "OAuth is enabled but no client is registered. Add one: llm-cli-gateway oauth client add <client-id> --redirect-uri <connector-callback> --print-once",
      ];
    case "missing_workspace":
      return [
        "No workspace is available for remote provider execution. Register a repo and set it as the default: add a [[workspaces.repos]] entry with [workspaces].default in ~/.llm-cli-gateway/config.toml, or run `llm-cli-gateway workspace add <alias> <absolute-repo-path> --default` when an allowed root is configured.",
        "Remote clients then select the workspace by alias; local absolute paths are never accepted from remote clients.",
      ];
    case "ready": {
      const readyActions = [
        ctx.workspace.default
          ? `Remote connector is ready. Remote provider calls use the default workspace "${ctx.workspace.default}" unless a registered alias is supplied.`
          : "Remote connector is ready. Remote provider calls must supply a registered workspace alias; set a default with `llm-cli-gateway workspace add <alias> <path> --default` to make one implicit.",
        "Paste only copy-safe connector fields (MCP URL, authorization URL, token URL, client id) into the remote connector UI.",
      ];
      // "ready" means configuration is complete. Reachability is an opt-in probe;
      // when it has not run, say so rather than implying the endpoint was verified.
      if (ctx.endpointReachability === "not_checked") {
        readyActions.push(
          "Config is complete but public reachability was not verified. Set LLM_GATEWAY_VERIFY_PUBLIC_URL=1 and re-run doctor --json to confirm the public URL is reachable from the web."
        );
      }
      return readyActions;
    }
    default:
      return [];
  }
}

/**
 * Assemble readiness inputs from the live environment/config and run the pure
 * builder. Reused by the connector setup command so its readiness/next_actions
 * are byte-identical to doctor's.
 */
export function gatherRemoteHttpOAuthReadiness(
  env: NodeJS.ProcessEnv = process.env
): RemoteHttpOAuthReadiness {
  const oauthDiag = diagnoseRemoteOAuthConfig(undefined, env);
  const workspace = remoteSafeWorkspaceSummary(loadWorkspaceRegistry());
  const auth = loadAuthConfig(env);
  const transport = defaultTransport(env);
  const publicUrl = redactDiagnosticUrl(env.LLM_GATEWAY_PUBLIC_URL || null);
  const endpoint = createEndpointExposureReport(env, publicUrl);
  const mcpPath = env.LLM_GATEWAY_HTTP_PATH || "/mcp";
  return buildRemoteHttpOAuthReadiness({
    oauthDiag,
    workspace,
    auth,
    transport,
    publicUrl,
    endpoint,
    mcpPath,
  });
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
  /**
   * Slice 6: resolved API-provider config. When present and at least one
   * provider is enabled, the report gains the `api_providers` block. When
   * absent, the block is omitted (byte-identical CLI-only report).
   */
  providersConfig?: ProvidersConfig;
  /**
   * Slice 6: precomputed reachability results keyed by provider name, supplied
   * by `printDoctorJson` only when the opt-in `--probe-api-providers` flag is
   * set. `createDoctorReport` itself never opens a socket: when this is absent,
   * every entry's `reachable` is null.
   */
  apiReachability?: Record<string, { reachable: boolean; error?: string }>;
  /**
   * LCR phase_3: resolved least-cost-routing config. Drives the `least_cost`
   * block (enabled flag, tier map, priors scope, catalog-price preference). When
   * absent, the all-off `defaultLeastCostConfig()` is used, so the block is still
   * present in its compact disabled form.
   */
  leastCost?: LeastCostConfig;
  /**
   * Optional precomputed, redacted Personal Agent Config Kit readiness for an
   * embedded caller. Normal doctor invocations compute it from local state.
   */
  personalConfigReadiness?: PersonalConfigReadinessReport;
}

const PERSONAL_CONFIG_RELEASE_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

function redactedReleaseId(value: string | null | undefined): string | null {
  return value && PERSONAL_CONFIG_RELEASE_ID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function redactedTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

/**
 * Build the report-safe readiness view from already-resolved local state.
 * Untrusted status strings are normalized or withheld before they can reach
 * the doctor JSON surface.
 */
export function buildPersonalConfigReadinessReport(
  input: PersonalConfigReadinessInput
): PersonalConfigReadinessReport {
  const configurationValid = input.configurationValid ?? true;
  const status = input.enabled && configurationValid ? input.status : undefined;
  const claudeBareAuthConfigured =
    input.enabled && configurationValid && input.claudeBareAuthConfigured === true;
  const durableAsyncConfigured =
    input.enabled &&
    configurationValid &&
    input.persistence !== null &&
    input.persistence !== undefined &&
    (input.persistence.backend === "sqlite" || input.persistence.backend === "postgres") &&
    input.persistence.asyncJobsEnabled;
  const baselinePresent = status?.baselinePresent === true;
  const currentReleaseId = redactedReleaseId(status?.currentReleaseId);
  const lastSuccessAt = redactedTimestamp(status?.lastSuccessAt);
  const stale = status?.stale === true;

  return {
    enabled: input.enabled,
    configuration_valid: configurationValid,
    ready:
      !input.enabled ||
      (configurationValid &&
        baselinePresent &&
        currentReleaseId !== null &&
        !stale &&
        durableAsyncConfigured &&
        claudeBareAuthConfigured),
    claude_bare_auth_configured: claudeBareAuthConfigured,
    baseline_present: baselinePresent,
    current_release_id: currentReleaseId,
    last_success_at: lastSuccessAt,
    stale,
    last_sync_error: status?.lastSyncError ? PERSONAL_CONFIG_SYNC_ERROR_WITHHELD : null,
    durable_async_configured: durableAsyncConfigured,
  };
}

function loadPersonalConfigReadinessReport(
  env: NodeJS.ProcessEnv = process.env
): PersonalConfigReadinessReport {
  try {
    const { settings } = loadPersonalConfigSettings();
    if (!settings.enabled) {
      return buildPersonalConfigReadinessReport({ enabled: false });
    }

    const status = new PersonalConfigManager(settings).status();
    let persistence: Pick<PersistenceConfig, "backend" | "asyncJobsEnabled"> | null = null;
    try {
      const resolved = loadPersistenceConfig();
      persistence = {
        backend: resolved.backend,
        asyncJobsEnabled: resolved.asyncJobsEnabled,
      };
    } catch {
      // A durable backend cannot be asserted when its configuration is invalid.
    }

    return buildPersonalConfigReadinessReport({
      enabled: true,
      status,
      persistence,
      claudeBareAuthConfigured: Boolean(env.ANTHROPIC_API_KEY?.trim()),
    });
  } catch {
    // Do not expose parsing, filesystem, or Git diagnostics through doctor.
    // Treat an unreadable Kit configuration as enabled and not ready so a
    // malformed config cannot silently appear as a disabled Kit.
    return buildPersonalConfigReadinessReport({ enabled: true, configurationValid: false });
  }
}

/**
 * Slice 6: build the api_providers health block from the resolved providers
 * config. Returns undefined when no API providers are enabled so the caller can
 * OMIT the key entirely (dormant byte-identical). Reads only key presence + the
 * env var name; never the key value. Reachability is whatever the caller
 * precomputed (null when the opt-in probe did not run).
 */
function buildApiProviderHealthReport(
  opts: CreateDoctorReportOptions,
  env: NodeJS.ProcessEnv
): ApiProviderHealthReport | undefined {
  const config = opts.providersConfig;
  if (!config) return undefined;
  const providers: Record<string, ApiProviderHealthEntry> = {};
  // Delegate the status projection to provider-status and the credential
  // guidance to provider-login-guidance, so doctor stays a thin consumer.
  for (const providerConfig of Object.values(config.providers)) {
    const status = getApiProviderStatus(providerConfig, env);
    if (!status.enabled) continue;
    const probe = opts.apiReachability?.[status.provider];
    providers[status.provider] = {
      name: status.provider,
      kind: status.kind,
      base_url: status.baseUrl,
      default_model: status.defaultModel,
      models: status.models,
      api_key_env: status.apiKeyEnv,
      api_key_present: status.apiKeyPresent,
      reachable: probe ? probe.reachable : null,
      ...(probe?.error ? { reachability_error: probe.error } : {}),
      login_guidance: getApiProviderLoginGuidance(providerConfig),
    };
  }
  const names = Object.keys(providers);
  if (names.length === 0) return undefined;
  return { enabled_count: names.length, providers };
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

const MS_PER_DAY = 86_400_000;

/**
 * Whole days since the NEWER (more recent) of the two price-table `asOf` dates
 * relative to the doctor run date. Clamped to >= 0 so a future asOf (clock skew)
 * reads as fresh rather than negative. Reuses the report's own run timestamp.
 */
function computePricingStaleDays(runIso: string): number {
  const run = Date.parse(runIso);
  const table = Date.parse(PRICING_AS_OF);
  const catalog = Date.parse(API_CATALOG_AS_OF);
  const newer = Math.max(table, catalog);
  if (!Number.isFinite(run) || !Number.isFinite(newer)) return 0;
  const days = Math.floor((run - newer) / MS_PER_DAY);
  return days > 0 ? days : 0;
}

/**
 * LCR phase_3: build the economics-only `least_cost` eligibility block. Pure over
 * the model registry (getCliInfo), pricing (getModelCost/modelIdToFamily), the
 * per-provider telemetry tiers, and the resolved LeastCostConfig; the only I/O is
 * an optional read-only flight-recorder scan for calibration quality. Never
 * spawns a CLI. Compact when routing is disabled.
 */
function buildLeastCostReport(
  cfg: LeastCostConfig,
  generatedAt: string,
  flightRecorder?: FlightRecorderQuery
): LeastCostReport {
  const pricing = {
    tableAsOf: PRICING_AS_OF,
    apiCatalogAsOf: API_CATALOG_AS_OF,
    staleDays: computePricingStaleDays(generatedAt),
  };

  // Disabled: emit the compact form. pricing still surfaces staleness so an
  // operator sees drift even with routing off; the eligibility arrays are empty.
  if (!cfg.enabled) {
    return { enabled: false, pricing, providers: [], untieredModels: [], calibrationQuality: [] };
  }

  // Resolved tier map keyed `provider:family`. A Map keeps the lookup off the
  // dynamic-object-index sink for the arbitrary-string tier keys.
  const tierMap = new Map<string, QualityTier>(Object.entries(cfg.tiers));
  const cliInfo = getCliInfo();
  const providers: LeastCostProviderReport[] = [];
  const untieredModels: string[] = [];

  for (const provider of CLI_TYPES) {
    const candidates: LeastCostCandidateReport[] = Object.keys(cliInfo[provider].models).map(
      model => {
        const family = modelIdToFamily(model);
        const cost = getModelCost(provider, model, { preferCatalog: cfg.preferCatalogPrice });
        const tier = tierMap.get(`${provider}:${family}`) ?? null;
        if (tier === null) {
          untieredModels.push(`${provider}:${model}`);
        }
        return {
          model,
          family,
          priced: cost.source !== "unknown",
          priceSource: cost.source,
          tier,
        };
      }
    );
    providers.push({
      provider,
      telemetryTier: telemetryTierFor(provider),
      candidates,
    });
  }

  // Calibration quality from the flight recorder, scoped by priors_scope. Empty
  // when there is no recorder, learning is off, or the scan finds no data. The
  // priors shape is anonymized model-level (content-type:family), never per
  // principal, so no caller identity can leak here.
  const calibrationQuality: LeastCostCalibrationBucketReport[] = [];
  if (flightRecorder && cfg.priorsScope !== "off") {
    try {
      const priors = computeLcrPriorsFromDb(flightRecorder, { priorsScope: cfg.priorsScope });
      for (const [bucket, entry] of priors.calibration) {
        calibrationQuality.push({
          bucket,
          k: entry.k,
          samples: entry.samples,
          confidence: entry.confidence,
        });
      }
    } catch {
      // Best-effort: leave calibrationQuality empty on any read failure.
    }
  }

  return { enabled: true, pricing, providers, untieredModels, calibrationQuality };
}

function buildProviderCapabilitySummary(
  providerStatuses: Record<CliType, ProviderRuntimeStatus>
): ProviderCapabilitySummaryReport {
  const capabilities = getProviderToolCapabilities({
    includeSkills: true,
    includeProviderTools: true,
    includeUnsupported: true,
    includePaths: false,
  });
  const providers = Object.fromEntries(
    knownProviderCapabilityIds().map(provider => {
      const capability = capabilities[provider];
      if (!capability) {
        throw new Error(`Missing provider capability record for ${provider}`);
      }
      const cliAvailable =
        provider === "grok_api"
          ? capability.gatewayRequestTools.includes("grok_api_request")
          : providerStatuses[provider].installed;
      return [
        provider,
        {
          provider_kind: capability.providerKind,
          cli_available: cliAvailable,
          gateway_request_tools: capability.gatewayRequestTools,
          supported_features: Object.entries(capability.features)
            .filter(([, feature]) => feature.supported)
            .map(([name]) => name),
          unsupported_inputs: capability.unsupportedInputs.map(input => input.input),
          config_surface_count: capability.configSurfaces.length,
          discovered_skill_count: capability.discoveredSkills.length,
          discovered_provider_tool_count: capability.discoveredProviderTools.length,
          warnings: capability.warnings,
        },
      ];
    })
  ) as ProviderCapabilitySummaryReport["providers"];

  return {
    schema_version: "provider-tool-capabilities.v2",
    tool: "provider_tool_capabilities",
    resources: {
      catalog: "provider-tools://catalog",
      providers: Object.fromEntries(
        knownProviderCapabilityIds().map(provider => [provider, `provider-tools://${provider}`])
      ) as Record<ProviderCapabilityId, string>,
    },
    cache_ttl_ms: 60_000,
    providers,
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
  const oauthDiag = diagnoseRemoteOAuthConfig(undefined, env);
  const oauth = oauthDiag.config;
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

  const generatedAt = new Date().toISOString();
  const leastCostConfig = opts.leastCost ?? defaultLeastCostConfig();
  const personalConfigReadiness =
    opts.personalConfigReadiness ?? loadPersonalConfigReadinessReport(env);

  const report: DoctorReport = {
    schema_version: "1.0",
    ok: true,
    generated_at: generatedAt,
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
    providers: Object.fromEntries(
      CLI_TYPES.map(provider => [provider, doctorProviderStatus(providerStatuses[provider])])
    ) as DoctorReport["providers"],
    endpoint_exposure: endpointExposure,
    remote_http_oauth: buildRemoteHttpOAuthReadiness({
      oauthDiag,
      workspace: remoteSafeWorkspaceSummary(workspaceRegistry),
      auth,
      transport,
      publicUrl,
      endpoint: endpointExposure,
      mcpPath: env.LLM_GATEWAY_HTTP_PATH || "/mcp",
    }),
    client_config: clientConfigStatus(),
    cache_awareness: buildCacheAwarenessReport(opts),
    provider_capabilities: buildProviderCapabilitySummary(providerStatuses),
    least_cost: buildLeastCostReport(leastCostConfig, generatedAt, opts.flightRecorder),
    personal_config: personalConfigReadiness,
    upstream,
    next_actions: [],
  };

  // Slice 6: attach the api_providers block only when at least one API provider
  // is enabled, so a CLI-only gateway's report is byte-identical to before.
  const apiProviders = buildApiProviderHealthReport(opts, env);
  if (apiProviders) {
    report.api_providers = apiProviders;
  }

  if (transport === "http" && auth.required && !auth.tokenConfigured) {
    report.ok = false;
    report.next_actions.push("Set LLM_GATEWAY_AUTH_TOKEN before starting HTTP transport.");
  }
  if (report.personal_config.enabled && !report.personal_config.ready) {
    report.ok = false;
    if (!report.personal_config.configuration_valid) {
      report.next_actions.push(
        "Repair the local [personal_config] configuration, then run doctor --json again."
      );
    } else if (!report.personal_config.baseline_present) {
      report.next_actions.push(
        "Initialize the local Personal Agent Config baseline with config_init, then publish and config_sync."
      );
    } else if (!report.personal_config.current_release_id) {
      report.next_actions.push(
        "Run config_sync locally to activate a verified Personal Agent Config release."
      );
    } else if (report.personal_config.stale) {
      report.next_actions.push(
        "Run config_sync locally, or use the bounded local config_ack_stale workflow."
      );
    } else if (!report.personal_config.durable_async_configured) {
      report.next_actions.push(
        "Personal Agent Config Kit requires [persistence] backend = sqlite or postgres with async jobs enabled."
      );
    } else if (!report.personal_config.claude_bare_auth_configured) {
      report.next_actions.push(
        "Set ANTHROPIC_API_KEY in the gateway process environment before using Claude Personal Agent Config Kit requests."
      );
    }
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

  // F4: whenever the installed probe actually ran, a subcommand/help probe that
  // exited nonzero (help still parsed) or could not run leaves that CLI's
  // contract unverified. Surface ONE specific advisory so it is visible without
  // hand-scanning probe_report. Doctor stays advisory: report.ok is deliberately
  // NOT flipped (matches the scanner's opt-in --require-installed). Gated on the
  // probe having run, independent of hasAnyCli.
  if (report.upstream.probed) {
    const installedProbe =
      (probeReport?.installedProbe as
        Record<string, InstalledCliContractProbe> | null | undefined) ?? null;
    if (installedProbe) {
      const unverified = Object.entries(installedProbe)
        .filter(
          ([, probe]) =>
            probe.helpExitedNonzero || Object.values(probe.subcommands).some(sub => !sub.available)
        )
        .map(([cli]) => cli);
      if (unverified.length > 0) {
        report.next_actions.push(
          `re-probe ${unverified.join(", ")}: an installed help probe exited nonzero or could not run; its contract is unverified.`
        );
      }
    }
  }

  return report;
}

export async function printDoctorJson(
  opts: { probeUpstream?: boolean; probeApiProviders?: boolean } = {}
): Promise<void> {
  // Load cache-awareness config + open the flight recorder so the doctor
  // command can populate cache_awareness.last_24h. Both are best-effort:
  // failures degrade to the zeroed block (buildCacheAwarenessReport
  // handles missing deps).
  let cacheAwareness: CacheAwarenessConfig | undefined;
  let flightRecorder: FlightRecorder | undefined;
  let providersConfig: ProvidersConfig | undefined;
  let leastCost: LeastCostConfig | undefined;
  try {
    cacheAwareness = loadCacheAwarenessConfig();
  } catch {
    // ignore
  }
  try {
    leastCost = loadLeastCostConfig();
  } catch {
    // ignore
  }
  try {
    const dbPath = resolveFlightRecorderDbPath();
    if (dbPath) flightRecorder = new FlightRecorder(dbPath);
  } catch {
    // ignore
  }
  try {
    providersConfig = loadProvidersConfig();
  } catch {
    // ignore
  }
  // Slice 6: the reachability probe is opt-in. A normal `doctor --json` run
  // spends no network or tokens; only `--probe-api-providers` opens a socket.
  let apiReachability: Record<string, { reachable: boolean; error?: string }> | undefined;
  if (opts.probeApiProviders && providersConfig) {
    apiReachability = {};
    for (const runtime of enabledApiProviders(providersConfig)) {
      apiReachability[runtime.name] = await probeApiProviderReachability(runtime.baseUrl);
    }
  }
  const report = createDoctorReport({
    env: process.env,
    cacheAwareness,
    flightRecorder,
    probeUpstream: opts.probeUpstream,
    providersConfig,
    apiReachability,
    leastCost,
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

/**
 * Slice 6: opt-in reachability probe for an API-provider base URL. Issues a
 * bare GET and treats ANY HTTP response (including 401/404) as reachable: the
 * goal is connectivity, not auth or token spend. No request body, no API key,
 * no completion call. https for remote, http for loopback test endpoints.
 */
export async function probeApiProviderReachability(
  baseUrl: string,
  timeoutMs = 5_000
): Promise<{ reachable: boolean; error?: string }> {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { reachable: false, error: "invalid base_url" };
  }
  const transport =
    url.protocol === "http:" ? await import("node:http") : await import("node:https");
  return new Promise(resolve => {
    const request = transport.request(url, { method: "GET", timeout: timeoutMs }, response => {
      // Any status code means the endpoint answered: drain and resolve.
      response.resume();
      resolve({ reachable: true });
    });
    request.on("timeout", () => {
      request.destroy();
      resolve({ reachable: false, error: `timed out after ${timeoutMs}ms` });
    });
    request.on("error", err => {
      resolve({ reachable: false, error: err instanceof Error ? err.message : String(err) });
    });
    request.end();
  });
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
  if (Object.prototype.hasOwnProperty.call(value, "leastCost")) {
    // Same reasoning as flightRecorder: an options object may carry only
    // `leastCost` (a LeastCostConfig object). A stray env var `leastCost=...`
    // would be a STRING, so the typeof-object check cannot collide.
    const candidate = (value as { leastCost?: unknown }).leastCost;
    return candidate === undefined || typeof candidate === "object";
  }
  if (Object.prototype.hasOwnProperty.call(value, "personalConfigReadiness")) {
    const candidate = (value as { personalConfigReadiness?: unknown }).personalConfigReadiness;
    return candidate === undefined || (candidate !== null && typeof candidate === "object");
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
