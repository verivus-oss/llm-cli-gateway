import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import path from "path";
import { parse as parseToml } from "smol-toml";
import { CLAUDE_MCP_SERVER_NAMES } from "./claude-mcp-config.js";
import { getAvailableCliInfo, type CliInfo } from "./model-registry.js";
// Provider identity (the CLI provider list + CliType) is imported from the
// provider definition registry, not owned here. See src/provider-definitions.ts.
import {
  CLI_TYPES,
  getProviderDefinition,
  PROVIDER_TARGET_VERSIONS,
  type CliType,
} from "./provider-definitions.js";
import {
  enabledApiProviders,
  isXaiProviderEnabled,
  loadProvidersConfig,
  type AcpConfig,
  type ApiProviderRuntime,
  type ProvidersConfig,
} from "./config.js";
import { apiContinuityForKind } from "./api-provider.js";

const MAX_SKILLS_PER_DIR = 100;
const MAX_SKILL_BYTES = 64 * 1024;
const MAX_CONFIG_BYTES = 128 * 1024;
const MAX_PROVIDER_TOOLS_PER_SKILL = 50;
const CAPABILITY_CACHE_TTL_MS = 60 * 1000;

export interface ProviderToolControl {
  name?: string;
  supported: boolean;
  requestField?: string;
  cliFlag?: string;
  behavior: string;
}

/**
 * Providers with static capability metadata baked into this module
 * (`TOOL_CONTROLS`, `ACP_RESIDUAL`, `ACP_CONTRACT.providers`). Closed on
 * purpose so those total maps stay exhaustive and capability tests can assert
 * the exact classification of each provider.
 */
export type KnownProviderCapabilityId = CliType | "grok_api";

/**
 * Slice 0.5 — provider-identity widening. A capability id is any known provider
 * OR an arbitrary `[providers.<name>]` (kind:"api") id. The `(string & {})`
 * member keeps the known literals in autocomplete while giving generic API
 * providers a type-level home in the capability/catalog surfaces. Lookups for an
 * id without static metadata are rejected at runtime (see
 * `buildOneProviderToolCapabilities`); no such id is registered yet (dormant).
 */
export type ProviderCapabilityId = KnownProviderCapabilityId | (string & {});
export type ProviderKind = "cli" | "api";
export type UnsupportedInputBehavior =
  "reject" | "ignored" | "not_supported" | "approval_tracking_only" | "deprecated";
export type ProviderToolConfidence = "high" | "medium" | "low";
export type ProviderToolExtractionReason =
  "exact-tool-section" | "known-tool-name" | "backtick-heuristic" | "low-confidence";

export interface ProviderSkillCapability {
  name: string;
  source: "user" | "bundled";
  path?: string;
  description?: string;
  declaredTools: string[];
  declaredToolReasons?: Partial<Record<string, ProviderToolExtractionReason>>;
}

export interface ProviderNativeToolCapability {
  name: string;
  source: string;
  skillName?: string;
  path?: string;
  confidence: ProviderToolConfidence;
  reason: ProviderToolExtractionReason;
}

export interface ProviderConfigSurface {
  name: string;
  kind: "file" | "directory" | "env" | "gateway" | "provider";
  present: boolean;
  path?: string;
  entries?: string[];
  details?: string;
}

export interface ProviderUnsupportedInput {
  input: string;
  behavior: UnsupportedInputBehavior;
  details: string;
}

export interface ProviderFeatureCapability {
  supported: boolean;
  details?: string;
  values?: string[];
}

/**
 * ACP = Agent Client Protocol (provider-side stdio JSON-RPC transport).
 * This is distinct from the Agent Communication Protocol, which is out of scope.
 * The status taxonomy is intentionally closed so capability tests can assert
 * the exact classification of each provider.
 */
export type ProviderAcpStatus =
  | "native_smoke_passed"
  | "native_candidate"
  | "adapter_mediated_deferred"
  | "absent_watchlist"
  | "not_applicable";

/**
 * How ACP support is (or would be) mediated for a provider. No adapter-backed
 * provider may ever be labelled `native`.
 */
export type ProviderAcpMediation = "native" | "adapter_mediated" | "none";

export type ProviderAcpSmokeStatus = "passed" | "not_run" | "unsupported";

export interface ProviderAcpCapability {
  /** Closed-taxonomy ACP status for this provider at the target version. */
  status: ProviderAcpStatus;
  /** Native vs adapter-mediated classification. Adapters are never `native`. */
  mediation: ProviderAcpMediation;
  /** Provider CLI version this ACP assessment was made against. */
  targetVersion: string;
  /**
   * ACP entrypoint as an executable plus argv array, or null when no native
   * ACP entrypoint exists at the target version. No shell strings are stored.
   */
  entrypoint: { command: string; args: string[] } | null;
  /**
   * Whether ACP runtime routing is currently enabled for this provider. This is
   * NOT a static fact: it is resolved from the operator's gateway `[acp]` config
   * at read time and mirrors the live runtime gate (`src/acp/runtime.ts`) exactly
   * (`[acp].enabled` AND the provider's `enabled` AND `runtime_enabled`). A
   * provider with no native ACP entrypoint is never runtime-enabled. When no
   * resolved config is available it defaults to the safe value (off) and a caveat
   * records that the value is the default rather than a config-confirmed state.
   */
  runtimeEnabled: boolean;
  /** Whether a read-only initialize + session/new smoke is supported. */
  smokeSupported: boolean;
  /** Result of the read-only ACP smoke harness for this provider. */
  smokeStatus: ProviderAcpSmokeStatus;
  /** Human-readable caveats for LLM agents reading capability resources. */
  caveats: string[];
  /** Documentation reference (path or plan id) for deeper ACP context. */
  docs: string;
}

export type ProviderFeatureMap = Record<string, ProviderFeatureCapability>;

export interface ProviderCapabilityControls {
  allowlist: ProviderToolControl;
  denylist: ProviderToolControl;
  mcpServers: ProviderToolControl;
  nativeSkills: ProviderToolControl;
  [name: string]: ProviderToolControl;
}

/**
 * Frozen ACP (Agent Client Protocol) classification for a provider.
 *
 * "ACP" here means Agent Client Protocol, the JSON-RPC protocol clients use to
 * talk to coding agents. It is NOT the agent-to-agent "Agent Communication
 * Protocol", which is explicitly out of scope for this slice.
 *
 * This is the frozen contract surface only: native versus adapter-mediated
 * versus absent classification plus the frozen non-goals. The richer runtime
 * ACP capability fields (status, entrypoint, protocolVersion, smokeStatus, ...)
 * are added by the later extend-provider-capability-metadata step and are
 * intentionally not declared here.
 */
export type AcpFrozenClassification =
  "native_candidate" | "adapter_mediated_deferred" | "absent_watchlist";

export interface AcpProviderContract {
  classification: AcpFrozenClassification;
  /** Human-facing one-line summary of the frozen classification. */
  summary: string;
}

export interface AcpContractMetadata {
  /** Always "Agent Client Protocol" — never "Agent Communication Protocol". */
  protocol: "Agent Client Protocol";
  /** The acronym meaning that is explicitly out of scope for this slice. */
  outOfScope: "Agent Communication Protocol";
  /** MCP stays the client-facing gateway protocol. */
  mcpFrontendRemains: true;
  /** ACP is used only as an internal provider transport in this slice. */
  acpIsInternalProviderTransport: true;
  /** Existing request tools keep CLI behavior by default. */
  defaultTransport: "cli";
  /** HostServices side effects are deny-by-default until the bridge ships. */
  hostServicesDenyByDefault: true;
  /** No new public tool exposes raw ACP JSON-RPC. */
  noRawAcpJsonRpcTool: true;
  /** Adapter-mediated support is never labeled as native gateway ACP support. */
  adapterSupportIsNotNative: true;
  /** Authoritative frozen-contract document. */
  contractDoc: "docs/acp-contract.md";
  /** Frozen non-goals for this slice. */
  nonGoals: readonly string[];
  /** Per-provider frozen classification (known providers only). */
  providers: Readonly<Record<KnownProviderCapabilityId, AcpProviderContract>>;
}

/**
 * Frozen ACP extension contract (Agent Client Protocol).
 *
 * Recorded here so provider capability metadata and the frozen-contract doc
 * (`docs/acp-contract.md`) cannot drift. This is data-only; reading it never
 * runs a provider subcommand.
 */
export const ACP_CONTRACT: AcpContractMetadata = {
  protocol: "Agent Client Protocol",
  outOfScope: "Agent Communication Protocol",
  mcpFrontendRemains: true,
  acpIsInternalProviderTransport: true,
  defaultTransport: "cli",
  hostServicesDenyByDefault: true,
  noRawAcpJsonRpcTool: true,
  adapterSupportIsNotNative: true,
  contractDoc: "docs/acp-contract.md",
  nonGoals: [
    "Replace the MCP server.",
    "Ship an outbound ACP server or frontend in this slice.",
    "Wrap every provider immediately.",
    "Run adapter-mediated providers by default.",
    "Grant write or terminal HostServices by default.",
    "Expose raw ACP JSON-RPC to agents.",
    "Implement any agent-to-agent Agent Communication Protocol layer.",
  ],
  providers: {
    mistral: {
      classification: "native_candidate",
      summary:
        "Mistral Vibe exposes native ACP via vibe-acp; runtime routing is live but config-gated.",
    },
    grok: {
      classification: "native_candidate",
      summary:
        "xAI Grok CLI exposes native ACP via grok agent stdio; runtime routing is live but config-gated.",
    },
    codex: {
      classification: "adapter_mediated_deferred",
      summary:
        "OpenAI Codex CLI has no native ACP entrypoint at the target version; adapter-mediated and deferred.",
    },
    claude: {
      classification: "adapter_mediated_deferred",
      summary:
        "Anthropic Claude Code has no native ACP entrypoint at the target version; adapter-mediated and deferred.",
    },
    gemini: {
      classification: "absent_watchlist",
      summary: `Google Antigravity ${PROVIDER_TARGET_VERSIONS.gemini} has no ACP surface; watchlist item only.`,
    },
    grok_api: {
      classification: "absent_watchlist",
      summary: "Grok API is an HTTP provider with no ACP process transport; watchlist item only.",
    },
    devin: {
      classification: "native_candidate",
      summary:
        "Cognition Devin CLI exposes a native ACP server via `devin acp` (stdio); Slice D1 initialize + session/new smoke passed (protocolVersion 1). Runtime routing is live but config-gated.",
    },
    cursor: {
      classification: "native_candidate",
      summary:
        "Cursor Agent CLI exposes a hidden native ACP stdio entrypoint via `cursor-agent acp`; initialize + session/new smoke passed locally (protocolVersion 1, session created).",
    },
  },
};

export interface ProviderToolCapabilities {
  schemaVersion: "provider-tool-capabilities.v2";
  generatedAt: string;
  cli: ProviderCapabilityId;
  providerKind: ProviderKind;
  gatewayRequestTools: string[];
  modelInfo: CliInfo | GrokApiModelInfo;
  summary: string;
  /**
   * Frozen ACP (Agent Client Protocol) classification for this provider.
   * Recorded by the freeze-contract step; richer runtime ACP fields are added
   * later by extend-provider-capability-metadata.
   */
  acpContract: AcpProviderContract;
  acp: ProviderAcpCapability;
  controls: ProviderCapabilityControls;
  features: ProviderFeatureMap;
  discoveredSkills: ProviderSkillCapability[];
  discoveredProviderTools: ProviderNativeToolCapability[];
  configSurfaces: ProviderConfigSurface[];
  unsupportedInputs: ProviderUnsupportedInput[];
  warnings: string[];
  metadata: {
    deprecatedFields?: Record<string, string>;
    cacheTtlMs: number;
  };
  /**
   * Back-compat for the initial v1 slice. Prefer gatewayRequestTools.
   */
  gatewayRequestTool: string;
}

export interface GrokApiModelInfo {
  description: string;
  models: Record<string, string>;
  defaultModel?: string;
  defaultModelSource?: string;
  warnings?: string[];
}

export interface ProviderCapabilityQuery {
  cli?: ProviderCapabilityId;
  includeSkills?: boolean;
  includeProviderTools?: boolean;
  includeUnsupported?: boolean;
  includePaths?: boolean;
  refresh?: boolean;
  /**
   * Resolved gateway provider config for this runtime. When omitted, capability
   * helpers load the default config for backwards compatibility.
   */
  providersConfig?: ProvidersConfig;
  /**
   * Resolved gateway ACP config for this runtime. Drives the config-derived
   * `acp.runtimeEnabled` for native providers. When omitted, `runtimeEnabled`
   * defaults to off (safe) and is labelled as the default in the caveats.
   */
  acpConfig?: AcpConfig;
}

export type ProviderToolCapabilitiesMap = Partial<
  Record<ProviderCapabilityId, ProviderToolCapabilities>
>;

interface SkillRoot {
  path: string;
  source: "user" | "bundled";
}

interface ExtractedDeclaredTools {
  tools: string[];
  reasons: Partial<Record<string, ProviderToolExtractionReason>>;
}

interface NormalizedProviderCapabilityQuery {
  cli?: ProviderCapabilityId;
  includeSkills: boolean;
  includeProviderTools: boolean;
  includeUnsupported: boolean;
  includePaths: boolean;
  refresh: boolean;
  providersConfig?: ProvidersConfig;
  acpConfig?: AcpConfig;
}

interface ProviderCapabilityStaticDefinition {
  providerKind: ProviderKind;
  gatewayRequestTools: string[];
  summary: string;
  controls: ProviderCapabilityControls;
  features: ProviderFeatureMap;
  unsupportedInputs: ProviderUnsupportedInput[];
}

const ACP_DOCS_REFERENCE = "docs/plans/first-class-acp-gateway-extension.dag.toml";

/**
 * Config-gated ACP runtime caveat. Native providers can route `transport:"acp"`
 * only when the operator turns on all three gates (mirrors src/acp/runtime.ts).
 */
const ACP_RUNTIME_GATE_CAVEAT =
  "Native ACP runtime routing is config-gated: it is live only when `[acp].enabled` " +
  "plus this provider's `enabled` and `runtime_enabled` are all set; otherwise " +
  'transport:"acp" requests fail closed and default requests use the CLI transport.';

/**
 * Per-provider ACP facts that are genuinely NOT modelled in the provider
 * registry: the read-only smoke assessment (`smokeSupported`/`smokeStatus`), the
 * closed-taxonomy `status`, and the human caveats. Everything else on the
 * emitted {@link ProviderAcpCapability} is DERIVED, not duplicated:
 *   - `entrypoint` + `targetVersion` come from `provider-definitions.ts`
 *     (`getProviderDefinition(id).acp` / `.upstreamContract`).
 *   - `mediation` is projected from the frozen {@link ACP_CONTRACT} classification.
 *   - `runtimeEnabled` is resolved from the gateway `[acp]` config at read time.
 *   - `docs` is the shared reference.
 * See {@link buildAcpCapability}.
 */
interface AcpResidualFacts {
  status: ProviderAcpStatus;
  smokeSupported: boolean;
  smokeStatus: ProviderAcpSmokeStatus;
  caveats: string[];
}

const ACP_RESIDUAL: Record<KnownProviderCapabilityId, AcpResidualFacts> = {
  mistral: {
    status: "native_smoke_passed",
    smokeSupported: true,
    smokeStatus: "passed",
    caveats: ["Native ACP via the provider-scoped vibe-acp executable.", ACP_RUNTIME_GATE_CAVEAT],
  },
  grok: {
    status: "native_smoke_passed",
    smokeSupported: true,
    smokeStatus: "passed",
    caveats: [
      "Native ACP via grok agent stdio.",
      "Credential lookup is owned by the installed CLI; empty-env smoke is not expected to pass.",
      ACP_RUNTIME_GATE_CAVEAT,
    ],
  },
  codex: {
    status: "adapter_mediated_deferred",
    smokeSupported: false,
    smokeStatus: "unsupported",
    caveats: [
      "No native ACP entrypoint at the target version; ACP would be adapter-mediated.",
      "Adapter support requires a separate threat model and is never labelled native gateway ACP support.",
    ],
  },
  claude: {
    status: "adapter_mediated_deferred",
    smokeSupported: false,
    smokeStatus: "unsupported",
    caveats: [
      "No native Claude Code CLI ACP entrypoint at the target version; ACP would be adapter-mediated.",
      "Adapter ownership, permission bridging, and install story must be specified before runtime support.",
    ],
  },
  gemini: {
    status: "absent_watchlist",
    smokeSupported: false,
    smokeStatus: "unsupported",
    caveats: [
      `Antigravity ${PROVIDER_TARGET_VERSIONS.gemini} has no ACP flag or subcommand.`,
      "Legacy Gemini CLI ACP evidence does not transfer to agy; kept on the upstream drift watchlist.",
    ],
  },
  grok_api: {
    status: "not_applicable",
    smokeSupported: false,
    smokeStatus: "unsupported",
    caveats: ["ACP is a CLI-stdio transport; the HTTP API provider has no ACP surface."],
  },
  devin: {
    status: "native_smoke_passed",
    smokeSupported: true,
    smokeStatus: "passed",
    caveats: [
      'Native ACP via `devin acp` (stdio JSON-RPC); Slice D1 initialize + session/new smoke passed (protocolVersion 1, agent "Affogato").',
      "Credentials come from `devin auth login` or WINDSURF_API_KEY; empty-env smoke is not expected to pass.",
      ACP_RUNTIME_GATE_CAVEAT,
    ],
  },
  cursor: {
    status: "native_smoke_passed",
    smokeSupported: true,
    smokeStatus: "passed",
    caveats: [
      "Native ACP via the companion-owned hidden `cursor-agent acp` stdio JSON-RPC entrypoint; manual initialize + session/new smoke passed locally (protocolVersion 1, session created; no agentInfo returned).",
      ACP_RUNTIME_GATE_CAVEAT,
    ],
  },
};

/**
 * Project the native/adapter/none mediation from the frozen ACP contract, the
 * single source for the three-way distinction (the provider registry's
 * classification is a binary native/none and cannot tell adapter-mediated apart
 * from absent). Adapter-backed providers are never `native`.
 */
function acpMediationFor(cli: KnownProviderCapabilityId): ProviderAcpMediation {
  switch (ACP_CONTRACT.providers[cli].classification) {
    case "native_candidate":
      return "native";
    case "adapter_mediated_deferred":
      return "adapter_mediated";
    case "absent_watchlist":
      return "none";
  }
}

/**
 * Source the ACP `entrypoint` and `targetVersion` from the provider registry so
 * they cannot drift from the single source of truth. `grok_api` is an HTTP API
 * provider (not a spawnable CLI in the registry), so its facts stay local.
 */
function acpRegistryFacts(cli: KnownProviderCapabilityId): {
  entrypoint: { command: string; args: string[] } | null;
  targetVersion: string;
} {
  if (cli === "grok_api") {
    return { entrypoint: null, targetVersion: "xAI Responses API" };
  }
  const def = getProviderDefinition(cli);
  return {
    entrypoint: def.acp.entrypoint
      ? { command: def.acp.entrypoint.command, args: [...def.acp.entrypoint.args] }
      : null,
    targetVersion: def.upstreamContract.targetVersion,
  };
}

/**
 * Resolve whether native ACP runtime routing is currently enabled for a provider
 * from the operator's gateway `[acp]` config. Mirrors the runtime gate in
 * `src/acp/runtime.ts` EXACTLY: live only when `[acp].enabled` AND the provider
 * block's `enabled` AND `runtime_enabled` are all set. A non-native provider is
 * never runtime-enabled (even if an operator adds a stray config block), and an
 * unavailable config yields the safe default (off).
 */
function resolveAcpRuntimeEnabled(
  cli: KnownProviderCapabilityId,
  mediation: ProviderAcpMediation,
  acpConfig: AcpConfig | null | undefined
): boolean {
  if (mediation !== "native") return false;
  if (!acpConfig?.enabled) return false;
  const providerConfig = acpConfig.providers[cli];
  return providerConfig?.enabled === true && providerConfig.runtimeEnabled === true;
}

/**
 * Build the ACP capability block for one provider. Deep-fresh (no shared arrays)
 * so callers cannot mutate cached state. `runtimeEnabled` reflects the resolved
 * gateway config; when no config was threaded in, native providers gain a caveat
 * marking the value as the safe default rather than a config-confirmed state.
 */
function buildAcpCapability(
  cli: KnownProviderCapabilityId,
  acpConfig: AcpConfig | null | undefined
): ProviderAcpCapability {
  const residual = ACP_RESIDUAL[cli];
  const mediation = acpMediationFor(cli);
  const { entrypoint, targetVersion } = acpRegistryFacts(cli);
  const runtimeEnabled = resolveAcpRuntimeEnabled(cli, mediation, acpConfig);
  const caveats = [...residual.caveats];
  if (mediation === "native" && (acpConfig === null || acpConfig === undefined)) {
    caveats.push(
      "runtimeEnabled shows the safe default (off): the resolved gateway [acp] config was not available to this capability read."
    );
  }
  return {
    status: residual.status,
    mediation,
    targetVersion,
    entrypoint,
    runtimeEnabled,
    smokeSupported: residual.smokeSupported,
    smokeStatus: residual.smokeStatus,
    caveats,
    docs: ACP_DOCS_REFERENCE,
  };
}

const PROVIDER_CAPABILITY_IDS: readonly KnownProviderCapabilityId[] = [
  ...CLI_TYPES,
  "grok_api",
] as const;

/**
 * Narrowing guard: true when `cli` has static capability metadata in this
 * module. An arbitrary `[providers.<name>]` (kind:"api") id widened in by Slice
 * 0.5 is a valid `ProviderCapabilityId` but has no static metadata yet, so
 * lookups reject it explicitly rather than indexing `undefined`.
 */
function isKnownProviderCapabilityId(cli: ProviderCapabilityId): cli is KnownProviderCapabilityId {
  return (PROVIDER_CAPABILITY_IDS as readonly string[]).includes(cli);
}

const KNOWN_PROVIDER_TOOLS: Partial<Record<KnownProviderCapabilityId, readonly string[]>> = {
  grok: [
    "image_gen",
    "image_edit",
    "image_to_video",
    "reference_to_video",
    "run_in_background",
    "wait_tasks",
    "get_task_output",
    "spawn_subagent",
    "run_terminal_cmd",
    "read_file",
    "search_replace",
    "todo_write",
  ],
};

const NOISE_TOOL_IDENTIFIERS = new Set([
  "api_key",
  "base_url",
  "config_path",
  "file_path",
  "max_results",
  "model_name",
  "output_format",
  "request_id",
  "session_id",
  "short_description",
]);

const UNISOLATED_MCP_MANAGED_UNAVAILABLE =
  "approvalStrategy:mcp_managed is unavailable because the current adapter cannot isolate ambient MCP configuration. Use approvalStrategy:legacy until an isolated, allowlisted launch path is available; approvalPolicy has no effect on this provider.";

const TOOL_CONTROLS: Record<KnownProviderCapabilityId, ProviderCapabilityStaticDefinition> = {
  claude: {
    providerKind: "cli",
    gatewayRequestTools: ["claude_request", "claude_request_async"],
    summary:
      "Claude Code owns its runtime tool catalog; the gateway can pass permission and built-in tool restrictions through to the CLI.",
    controls: {
      allowlist: {
        supported: true,
        requestField: "allowedTools",
        cliFlag: "--allowed-tools",
        behavior: "Each entry is passed through as a Claude permission allow rule.",
      },
      denylist: {
        supported: true,
        requestField: "disallowedTools",
        cliFlag: "--disallowed-tools",
        behavior: "Each entry is passed through as a Claude permission deny rule.",
      },
      mcpServers: {
        supported: true,
        requestField: "mcpServers",
        behavior:
          "Gateway generates a Claude MCP config for selected gateway-known MCP servers. Under mcp_managed, Claude uses only that generated config and only provisioned gateway-owned local definitions are eligible; dynamic npx, ambient-PATH, and Codex-config overrides remain legacy-only.",
      },
      nativeSkills: {
        supported: true,
        behavior:
          "Gateway discovers local Claude skills from ~/.claude/skills for capability reporting.",
      },
      tools: {
        supported: true,
        requestField: "tools",
        cliFlag: "--tools",
        behavior: "Restricts Claude's available built-in tool catalog.",
      },
      permissionMode: {
        supported: true,
        requestField: "permissionMode",
        cliFlag: "--permission-mode",
        behavior:
          "Legacy passes Claude permission modes through. Under mcp_managed, acceptEdits is the bounded default; bypassPermissions requires an explicit request, an approved gateway decision, and LLM_GATEWAY_APPROVAL_ALLOW_BYPASS=1.",
      },
      approvalStrategy: {
        supported: true,
        requestField: "approvalStrategy",
        behavior:
          "mcp_managed applies the gateway approval decision and forces strictMcpConfig=true, so Claude uses only the generated MCP config. Permission/configuration/plugin, instruction override, bare-mode, tool-selection, file-input/output, additional-directory/worktree, native-fork, and native-resume risks are denied unless the decision is approved and LLM_GATEWAY_APPROVAL_ALLOW_BYPASS=1.",
      },
      approvalPolicy: {
        supported: true,
        requestField: "approvalPolicy",
        behavior: "Gateway approval policy tunes MCP-managed review strictness.",
      },
      strictMcpConfig: {
        supported: true,
        requestField: "strictMcpConfig",
        behavior:
          "Legacy defaults strictMcpConfig to false. Under mcp_managed, the gateway forces it true and Claude uses only the generated MCP config; caller false cannot weaken that boundary.",
      },
      agents: {
        supported: true,
        requestField: "agent/agents",
        cliFlag: "--agent/--agents",
        behavior: "Passes single-agent or inline multi-agent definitions to Claude.",
      },
      structuredOutput: {
        supported: true,
        requestField: "outputFormat/jsonSchema",
        cliFlag: "--output-format/--json-schema",
        behavior: "Supports text, json, stream-json, and optional JSON schema.",
      },
      workspace: {
        supported: true,
        requestField: "addDir/workspace/worktree",
        behavior:
          "Gateway resolves additional directories, workspace aliases, and worktrees. Under mcp_managed, non-empty addDir and gateway worktree creation/reuse are approval-gated filesystem-scope expansions.",
      },
      session: {
        supported: true,
        requestField:
          "continueSession/sessionId/forkSession/noSessionPersistence/settings/settingSources",
        behavior:
          "Supports Claude session continuation, forks, ephemeral runs, and settings. Native continuation is approval-gated under mcp_managed because it can inherit provider state.",
      },
      loopAndBudget: {
        supported: true,
        requestField: "maxTurns/maxBudgetUsd/effort/fallbackModel",
        behavior: "Passes Claude loop, budget, effort, and fallback-model controls.",
      },
    },
    features: baseFeatures({
      nativeSkills: true,
      mcpServerConfiguration: true,
      subagentsOrAgents: true,
      structuredOutput: true,
      sessionContinuity: true,
      approvalAndSandboxControls: true,
      costAndLoopControls: true,
      workspaceAndWorktreeControls: true,
      toolAllowDenyControls: true,
    }),
    unsupportedInputs: [
      {
        input: "dangerouslySkipPermissions",
        behavior: "deprecated",
        details: "Accepted for compatibility; prefer permissionMode=bypassPermissions.",
      },
    ],
  },
  codex: {
    providerKind: "cli",
    gatewayRequestTools: ["codex_request", "codex_request_async", "codex_fork_session"],
    summary:
      "Codex owns its runtime tool catalog and MCP configuration; the gateway reports local skills and passes Codex execution controls.",
    controls: {
      allowlist: {
        supported: false,
        behavior: "codex_request has no allowedTools input; use Codex configuration/profiles.",
      },
      denylist: {
        supported: false,
        behavior: "codex_request has no disallowedTools input; use Codex configuration/profiles.",
      },
      mcpServers: {
        supported: false,
        requestField: "mcpServers",
        behavior:
          "Codex manages MCP configuration outside the gateway. Any caller-supplied list is descriptive metadata, not an enforceable allowlist.",
      },
      nativeSkills: {
        supported: true,
        behavior:
          "Gateway discovers local Codex skills from ~/.codex/skills for capability reporting.",
      },
      sandboxMode: {
        supported: true,
        requestField: "sandboxMode",
        cliFlag: "--sandbox",
        behavior: "Passes Codex sandbox mode through to the CLI.",
      },
      fullAuto: {
        supported: true,
        requestField: "fullAuto",
        behavior: "Gateway convenience mode for autonomous Codex execution.",
      },
      askForApproval: {
        supported: true,
        requestField: "askForApproval",
        cliFlag: "--ask-for-approval",
        behavior:
          "Deprecated compatibility input. Current Codex exec does not receive --ask-for-approval from the gateway.",
      },
      bypassApprovalsAndSandbox: {
        supported: true,
        requestField: "dangerouslyBypassApprovalsAndSandbox",
        behavior: "Explicit high-risk Codex bypass control.",
      },
      profileAndConfig: {
        supported: true,
        requestField: "profile/configOverrides/ignoreUserConfig/ignoreRules",
        behavior:
          "Local callers can pass Codex profile and config controls. Remote HTTP/OAuth callers cannot use configOverrides or its enable/disable feature-override equivalents; other host-path controls are separately rejected.",
      },
      structuredOutput: {
        supported: true,
        requestField: "outputFormat/outputSchema",
        behavior: "Supports Codex JSON output and output schema.",
      },
      images: {
        supported: true,
        requestField: "images",
        cliFlag: "-i",
        behavior: "Passes image attachment paths to Codex after existence checks.",
      },
      workspace: {
        supported: true,
        requestField: "workingDir/addDir/workspace/worktree",
        behavior: "Gateway resolves Codex working directories, writable dirs, and worktrees.",
      },
      session: {
        supported: true,
        requestField: "sessionId/resumeLatest/createNewSession/ephemeral",
        behavior: "Supports Codex resume/latest/new-session and ephemeral controls.",
      },
      approvalStrategy: {
        supported: false,
        requestField: "approvalStrategy/approvalPolicy",
        behavior: UNISOLATED_MCP_MANAGED_UNAVAILABLE,
      },
    },
    features: baseFeatures({
      nativeSkills: true,
      mcpServerConfiguration: true,
      multimodalInputs: true,
      structuredOutput: true,
      sessionContinuity: true,
      approvalAndSandboxControls: true,
      workspaceAndWorktreeControls: true,
    }),
    unsupportedInputs: [
      {
        input: "allowedTools",
        behavior: "not_supported",
        details: "codex_request has no gateway allowedTools input.",
      },
      {
        input: "disallowedTools",
        behavior: "not_supported",
        details: "codex_request has no gateway disallowedTools input.",
      },
      {
        input: "mcpServers",
        behavior: "ignored",
        details:
          "Codex owns MCP configuration; a caller list is not an enforceable gateway allowlist.",
      },
      {
        input: 'approvalStrategy:"mcp_managed"',
        behavior: "reject",
        details: UNISOLATED_MCP_MANAGED_UNAVAILABLE,
      },
    ],
  },
  gemini: {
    providerKind: "cli",
    gatewayRequestTools: ["gemini_request", "gemini_request_async"],
    summary:
      "Antigravity/Gemini owns its runtime tool catalog and MCP configuration; this gateway rejects non-empty tool allow-list inputs and does not claim to enforce a caller MCP allowlist.",
    controls: {
      allowlist: {
        supported: false,
        requestField: "allowedTools",
        behavior:
          "Non-empty values are rejected because agy has no non-interactive allowed-tools flag.",
      },
      denylist: {
        supported: false,
        behavior: "gemini_request has no disallowedTools input.",
      },
      mcpServers: {
        supported: false,
        requestField: "mcpServers",
        behavior:
          "Antigravity manages MCP configuration outside the gateway. Any caller-supplied list is descriptive metadata, not an enforceable allowlist.",
      },
      nativeSkills: {
        supported: true,
        behavior:
          "Gateway discovers local Gemini skills from ~/.gemini/skills for capability reporting.",
      },
      approvalMode: {
        supported: true,
        requestField: "approvalMode/yolo",
        behavior:
          "Legacy mode supports prompted default, --mode accept-edits, --mode plan, and full yolo.",
      },
      approvalStrategy: {
        supported: false,
        requestField: "approvalStrategy/approvalPolicy",
        behavior: UNISOLATED_MCP_MANAGED_UNAVAILABLE,
      },
      sandbox: {
        supported: true,
        requestField: "sandbox",
        cliFlag: "--sandbox",
        behavior: "Runs Gemini/Antigravity in sandbox mode.",
      },
      workspace: {
        supported: true,
        requestField: "includeDirs/workspace/worktree",
        behavior: "Gateway resolves include dirs, workspace aliases, and worktrees.",
      },
      session: {
        supported: true,
        requestField: "sessionId/resumeLatest/createNewSession",
        behavior: "Supports Gemini/Antigravity session continuation controls.",
      },
    },
    features: baseFeatures({
      nativeSkills: true,
      sessionContinuity: true,
      approvalAndSandboxControls: true,
      workspaceAndWorktreeControls: true,
    }),
    unsupportedInputs: [
      {
        input: "allowedTools",
        behavior: "reject",
        details: "Non-empty allowedTools values are rejected for the current Antigravity path.",
      },
      {
        input: "mcpServers",
        behavior: "ignored",
        details:
          "Antigravity owns MCP configuration; a caller list is not an enforceable gateway allowlist.",
      },
      {
        input: 'approvalStrategy:"mcp_managed"',
        behavior: "reject",
        details: UNISOLATED_MCP_MANAGED_UNAVAILABLE,
      },
      {
        input: "attachments",
        behavior: "reject",
        details: "Attachments are not supported by the current Antigravity request path.",
      },
      {
        input: "outputFormat=json/stream-json",
        behavior: "reject",
        details: "The current Antigravity print path accepts text output only.",
      },
      {
        input: "policyFiles/adminPolicyFiles/skipTrust",
        behavior: "not_supported",
        details: "Policy and trust-bypass files are not supported by this gateway path.",
      },
    ],
  },
  grok: {
    providerKind: "cli",
    gatewayRequestTools: ["grok_request", "grok_request_async"],
    summary:
      "Grok Build owns its runtime tool catalog; the gateway can pass Grok tool allow/deny controls and reports local Grok skills such as Imagine.",
    controls: {
      allowlist: {
        supported: true,
        requestField: "allowedTools",
        cliFlag: "--tools",
        behavior:
          "Non-empty entries are passed as a comma-separated Grok built-in tool allow-list.",
      },
      denylist: {
        supported: true,
        requestField: "disallowedTools",
        cliFlag: "--disallowed-tools",
        behavior: "Non-empty entries are passed as a comma-separated Grok built-in tool deny-list.",
      },
      mcpServers: {
        supported: false,
        requestField: "mcpServers",
        behavior:
          "Grok manages MCP configuration via grok mcp. Any caller-supplied list is descriptive metadata, not an enforceable allowlist.",
      },
      nativeSkills: {
        supported: true,
        behavior:
          "Gateway discovers local Grok skills from ~/.grok/skills and bundled Grok skills for capability reporting.",
      },
      allowAliases: {
        supported: true,
        requestField: "allow/deny",
        cliFlag: "--allow/--deny",
        behavior: "Passes Grok allow/deny aliases when provided by the request schema.",
      },
      alwaysApprove: {
        supported: true,
        requestField: "alwaysApprove",
        cliFlag: "--always-approve",
        behavior: "Asks Grok to auto-approve tool executions.",
      },
      permissionAndApproval: {
        supported: true,
        requestField: "permissionMode",
        behavior: "Passes Grok CLI permission mode through to the provider.",
      },
      approvalStrategy: {
        supported: false,
        requestField: "approvalStrategy/approvalPolicy",
        behavior: UNISOLATED_MCP_MANAGED_UNAVAILABLE,
      },
      agents: {
        supported: true,
        requestField: "agent/agents/bestOfN/check/todoGate/noSubagents",
        behavior: "Surfaces Grok agent, evaluation, and subagent controls.",
      },
      webSearch: {
        supported: true,
        requestField: "disableWebSearch",
        behavior: "Controls Grok web-search availability when supported by the CLI.",
      },
      memoryAndPlan: {
        supported: true,
        requestField: "experimentalMemory/noMemory/noPlan/noAltScreen",
        behavior: "Surfaces Grok memory, planning, and alternate-screen controls.",
      },
      promptControl: {
        supported: true,
        requestField: "promptFile/promptJson/single/verbatim/systemPromptOverride/rules",
        behavior:
          "Surfaces Grok prompt-file, JSON prompt, single-run, verbatim, system-prompt override, and rules controls.",
      },
      outputFormat: {
        supported: true,
        requestField: "outputFormat",
        behavior: "Supports Grok plain, json, and streaming-json output modes.",
      },
      workspace: {
        supported: true,
        requestField: "sandbox/workingDir/workspace/worktree/nativeWorktree",
        behavior:
          "Surfaces Grok sandbox, gateway workspace/worktree, and native worktree controls.",
      },
      session: {
        supported: true,
        requestField: "sessionId/resumeLatest/createNewSession/restoreCode/leaderSocket",
        behavior: "Surfaces Grok resume, new-session, restore-code, and leader-socket controls.",
      },
      loopAndCompaction: {
        supported: true,
        requestField: "maxTurns/effort/reasoningEffort/compactionMode/compactionDetail",
        behavior: "Surfaces Grok loop, effort, reasoning, and compaction controls.",
      },
    },
    features: baseFeatures({
      nativeSkills: true,
      providerNativeTools: true,
      subagentsOrAgents: true,
      webSearchOrRemoteRetrieval: true,
      memoryControls: true,
      sessionContinuity: true,
      approvalAndSandboxControls: true,
      costAndLoopControls: true,
      workspaceAndWorktreeControls: true,
      toolAllowDenyControls: true,
      webSearchControl: true,
      memoryControl: true,
      promptControl: true,
      compactionControls: true,
    }),
    unsupportedInputs: [
      {
        input: "mcpServers",
        behavior: "ignored",
        details:
          "Grok owns MCP configuration; a caller list is not an enforceable gateway allowlist.",
      },
      {
        input: 'approvalStrategy:"mcp_managed"',
        behavior: "reject",
        details: UNISOLATED_MCP_MANAGED_UNAVAILABLE,
      },
    ],
  },
  mistral: {
    providerKind: "cli",
    gatewayRequestTools: ["mistral_request", "mistral_request_async"],
    summary:
      "Mistral Vibe owns its runtime tool catalog; the gateway can pass Vibe enabled- and disabled-tool controls and reports local skills if present.",
    controls: {
      allowlist: {
        supported: true,
        requestField: "allowedTools",
        cliFlag: "--enabled-tools",
        behavior: "Each entry is emitted as a separate Vibe enabled-tool flag.",
      },
      denylist: {
        supported: true,
        requestField: "disallowedTools",
        cliFlag: "--disabled-tools",
        behavior: "Each entry is emitted as a separate Vibe disabled-tool flag.",
      },
      mcpServers: {
        supported: false,
        requestField: "mcpServers",
        behavior:
          "Vibe reads MCP configuration from VIBE_HOME config. Any caller-supplied list is descriptive metadata, not an enforceable allowlist.",
      },
      nativeSkills: {
        supported: true,
        behavior:
          "Gateway discovers local Vibe skills from ~/.vibe/skills when that directory exists.",
      },
      permissionMode: {
        supported: true,
        requestField: "permissionMode",
        behavior:
          "Legacy requests pass any Vibe --agent name through, including builtins like plan/auto-approve plus install-gated and custom agents.",
      },
      approvalStrategy: {
        supported: false,
        requestField: "approvalStrategy/approvalPolicy",
        behavior: UNISOLATED_MCP_MANAGED_UNAVAILABLE,
      },
      outputFormat: {
        supported: true,
        requestField: "outputFormat",
        behavior: "Supports text/plain, json, streaming, and stream-json aliases.",
      },
      trust: {
        supported: true,
        requestField: "trust",
        cliFlag: "--trust",
        behavior: "Passes Vibe trust mode for headless workspace runs.",
      },
      costAndLoop: {
        supported: true,
        requestField: "maxTurns/maxPrice/maxTokens",
        behavior: "Surfaces Vibe loop, price, and token limits.",
      },
      workspace: {
        supported: true,
        requestField: "workingDir/addDir/workspace/worktree",
        behavior: "Gateway resolves Vibe working dirs, add-dir entries, workspaces, and worktrees.",
      },
      session: {
        supported: true,
        requestField: "sessionId/resumeLatest/createNewSession",
        behavior: "Supports Vibe session resume/latest/new-session controls.",
      },
    },
    features: baseFeatures({
      nativeSkills: true,
      sessionContinuity: true,
      approvalAndSandboxControls: true,
      costAndLoopControls: true,
      workspaceAndWorktreeControls: true,
      toolAllowDenyControls: true,
      enabledToolAllowlist: true,
      trustControl: true,
    }),
    unsupportedInputs: [
      {
        input: "mcpServers",
        behavior: "ignored",
        details:
          "Vibe owns MCP configuration; a caller list is not an enforceable gateway allowlist.",
      },
      {
        input: 'approvalStrategy:"mcp_managed"',
        behavior: "reject",
        details: UNISOLATED_MCP_MANAGED_UNAVAILABLE,
      },
      {
        input: "effort/reasoningEffort",
        behavior: "not_supported",
        details: "No Vibe reasoning-effort control is currently passed through by the gateway.",
      },
    ],
  },
  grok_api: {
    providerKind: "api",
    gatewayRequestTools: ["grok_api_request"],
    summary:
      "Optional xAI Grok Responses API provider. This is distinct from Grok CLI/Build and does not expose local Grok skills or Imagine tools.",
    controls: {
      allowlist: {
        supported: false,
        behavior: "grok_api_request has no CLI tool allow-list input.",
      },
      denylist: {
        supported: false,
        behavior: "grok_api_request has no CLI tool deny-list input.",
      },
      mcpServers: {
        supported: false,
        behavior: "grok_api_request does not configure or expose MCP servers.",
      },
      nativeSkills: {
        supported: false,
        behavior: "API requests do not read local provider skills.",
      },
      reasoningEffort: {
        supported: true,
        requestField: "reasoningEffort",
        behavior: "Passed to the xAI Responses API reasoning.effort field.",
      },
      maxOutputTokens: {
        supported: true,
        requestField: "maxOutputTokens",
        behavior: "Passed to the xAI Responses API max_output_tokens field.",
      },
      sampling: {
        supported: true,
        requestField: "temperature/topP",
        behavior: "Sampling controls are passed through to the xAI Responses API.",
      },
      timeout: {
        supported: true,
        requestField: "timeoutMs",
        behavior: "Bounds the xAI API HTTP request timeout.",
      },
      session: {
        supported: true,
        requestField: "sessionId/createNewSession",
        behavior: "Gateway stores xAI previous_response_id in session metadata.",
      },
    },
    features: baseFeatures({
      apiProvider: true,
      structuredOutput: true,
      sessionContinuity: true,
      structuredTextResponses: true,
    }),
    unsupportedInputs: [
      {
        input: "localSkills",
        behavior: "not_supported",
        details: "grok_api_request does not inspect local Grok CLI skills.",
      },
      {
        input: "allowedTools/disallowedTools",
        behavior: "not_supported",
        details: "Tool allow/deny controls are CLI-only and are not routed to the xAI API.",
      },
      {
        input: "workspace/worktree",
        behavior: "not_supported",
        details: "The xAI API provider has no local workspace or worktree controls.",
      },
      {
        input: "Grok Imagine image generation",
        behavior: "not_supported",
        details:
          "Image generation/editing is not routed through grok_api_request in the current gateway.",
      },
    ],
  },
  devin: {
    providerKind: "cli",
    gatewayRequestTools: ["devin_request", "devin_request_async"],
    summary:
      "Cognition Devin CLI runs an agentic coding session; the gateway passes the prompt, model, permission mode, and session resume. Devin owns its own tools, MCP, skills, and rules, so the gateway does not claim to enforce a caller MCP allowlist.",
    controls: {
      allowlist: {
        supported: false,
        behavior:
          "Devin CLI has no per-request tool allow-list flag; tool gating is via permission modes.",
      },
      denylist: {
        supported: false,
        behavior: "Devin CLI has no per-request tool deny-list flag.",
      },
      mcpServers: {
        supported: false,
        behavior: "Devin manages its own MCP configuration via `devin mcp`.",
      },
      nativeSkills: {
        supported: false,
        behavior:
          "Devin manages its own skills (`devin skills`); the gateway does not discover them.",
      },
      permissionMode: {
        supported: true,
        requestField: "permissionMode",
        cliFlag: "--permission-mode",
        behavior:
          "Maps to Devin CLI --permission-mode: auto auto-approves read-only tools; accept-edits also auto-approves workspace edits; smart additionally auto-runs actions a fast model judges safe; dangerous auto-approves all.",
      },
      approvalStrategy: {
        supported: false,
        requestField: "approvalStrategy/approvalPolicy",
        behavior: UNISOLATED_MCP_MANAGED_UNAVAILABLE,
      },
      promptControl: {
        supported: true,
        requestField: "promptFile",
        cliFlag: "--prompt-file",
        behavior: "Loads the initial prompt from a file.",
      },
      session: {
        supported: true,
        requestField: "sessionId/resumeLatest/createNewSession",
        cliFlag: "--resume/--continue",
        behavior:
          "Resumes a Devin CLI session (--resume <id>) or the most recent in cwd (--continue).",
      },
    },
    features: baseFeatures({
      sessionContinuity: true,
      approvalAndSandboxControls: true,
      promptControl: true,
    }),
    unsupportedInputs: [
      {
        input: "mcpServers",
        behavior: "not_supported",
        details: "Devin owns MCP configuration via `devin mcp`.",
      },
      {
        input: 'approvalStrategy:"mcp_managed"',
        behavior: "reject",
        details: UNISOLATED_MCP_MANAGED_UNAVAILABLE,
      },
      {
        input: 'transport:"acp" with Devin CLI-only controls',
        behavior: "reject",
        details:
          "Devin ACP routing accepts prompt, model, gateway sessionId, and the validated agentType only. Remote calls use a registered default workspace when new and their recorded canonical workspace when resumed. Permission, sandbox, trust, file/export, native-continuation, optimization, compression, idle-timeout, and dedup controls are rejected instead of silently ignored.",
      },
    ],
  },
  cursor: {
    providerKind: "cli",
    gatewayRequestTools: ["cursor_request", "cursor_request_async"],
    summary:
      "Cursor Agent CLI runs a headless agentic coding/review session; the gateway passes prompt, model, mode, sandbox/trust controls, workspace roots, and session resume on the CLI transport, with ACP transport gated and fail-closed.",
    controls: {
      allowlist: {
        supported: false,
        behavior: "Cursor Agent exposes force/auto-review modes, not per-request allow lists.",
      },
      denylist: {
        supported: false,
        behavior: "Cursor Agent has no per-request deny-list flag on the tracked surface.",
      },
      mcpServers: {
        supported: false,
        behavior:
          "Cursor manages its own MCP configuration via `cursor-agent mcp`; the gateway does not mutate Cursor MCP config.",
      },
      nativeSkills: {
        supported: false,
        behavior:
          "Cursor owns rules/plugins; the gateway does not discover Cursor-native rules as skills.",
      },
      permissionMode: {
        supported: true,
        requestField: "mode/force/autoReview/sandbox/trust",
        cliFlag: "--mode/--force/--auto-review/--sandbox/--trust",
        behavior:
          "Cursor supports read-only plan/ask modes, Smart Auto-review, force/yolo, sandbox overrides, and workspace trust in headless mode.",
      },
      approvalStrategy: {
        supported: false,
        requestField: "approvalStrategy/approvalPolicy",
        behavior: UNISOLATED_MCP_MANAGED_UNAVAILABLE,
      },
      promptControl: {
        supported: true,
        requestField: "prompt",
        behavior: "Prompt is passed as the positional prompt to `cursor-agent --print`.",
      },
      session: {
        supported: true,
        requestField: "sessionId/resumeLatest/createNewSession",
        cliFlag: "--resume/--continue",
        behavior:
          "Resumes a Cursor chat/session (--resume <id>) or the most recent chat (--continue); gateway-created gw-* session ids are tracking ids and are not resumable Cursor chat ids.",
      },
      workspace: {
        supported: true,
        requestField: "workspace/addDir",
        cliFlag: "--workspace/--add-dir",
        behavior:
          "Sets the Cursor workspace and additional workspace roots; remote HTTP/OAuth callers must use registered workspace aliases/roots rather than raw paths.",
      },
    },
    features: baseFeatures({
      sessionContinuity: true,
      approvalAndSandboxControls: true,
      promptControl: true,
      workspaceControls: true,
    }),
    unsupportedInputs: [
      {
        input: "mcpServers",
        behavior: "not_supported",
        details:
          "Cursor owns MCP config via `cursor-agent mcp`; gateway request-time MCP server injection is not implemented.",
      },
      {
        input: 'approvalStrategy:"mcp_managed"',
        behavior: "reject",
        details: UNISOLATED_MCP_MANAGED_UNAVAILABLE,
      },
      {
        input: 'transport:"acp" with CLI-only options',
        behavior: "reject",
        details:
          "Cursor ACP routing accepts prompt/model/session inputs plus a registered workspace selection. mode, outputFormat, addDir, force, autoReview, sandbox, trust, native-continuation, prompt/response optimization or compression, idleTimeoutMs, and forceRefresh are rejected instead of silently ignored.",
      },
    ],
  },
};

/**
 * Simple TTL in-memory cache for provider capability discovery.
 * Promoted from ad-hoc Map for reuse (capability, and potentially models/config in future).
 * Keyed by (cli + normalized query shape). refresh=true bypasses.
 */
const CAPABILITY_CACHE = new Map<string, { loadedAt: number; value: ProviderToolCapabilities }>();

export function getProviderToolCapabilities(
  queryOrCli: ProviderCapabilityQuery | ProviderCapabilityId = {}
): ProviderToolCapabilitiesMap {
  const query = normalizeQuery(queryOrCli);
  const providers = query.cli ? [query.cli] : allProviderCapabilityIds(query.providersConfig);
  const entries = providers.map(provider => [
    provider,
    getOneProviderToolCapabilities(provider, query),
  ]);
  return Object.fromEntries(entries) as ProviderToolCapabilitiesMap;
}

export function getOneProviderToolCapabilities(
  cli: ProviderCapabilityId,
  queryOrCli: ProviderCapabilityQuery | ProviderCapabilityId = {}
): ProviderToolCapabilities {
  const query = normalizeQuery(typeof queryOrCli === "string" ? { cli: queryOrCli } : queryOrCli);
  const cacheKey = capabilityCacheKey(cli, query);
  const cached = CAPABILITY_CACHE.get(cacheKey);
  if (!query.refresh && cached && Date.now() - cached.loadedAt < CAPABILITY_CACHE_TTL_MS) {
    return cached.value;
  }
  const value = buildOneProviderToolCapabilities(cli, query);
  CAPABILITY_CACHE.set(cacheKey, { loadedAt: Date.now(), value });
  return value;
}

export function clearProviderToolCapabilitiesCache(): void {
  CAPABILITY_CACHE.clear();
}

/** For tests and advanced callers: inspect or seed the capability cache (use sparingly). */
export function _getCapabilityCacheForTest(): Map<
  string,
  { loadedAt: number; value: ProviderToolCapabilities }
> {
  return CAPABILITY_CACHE;
}

/**
 * Slice 6: the names of enabled generic `[providers.<name>]` (kind:"api")
 * providers, which gain capability metadata built on demand. Empty when none
 * are enabled, so the full capability surface stays byte-identical to the
 * CLI-only set when dormant.
 */
function providersConfigForQuery(query: NormalizedProviderCapabilityQuery): ProvidersConfig {
  return query.providersConfig ?? loadProvidersConfig();
}

function enabledApiCapabilityIds(providersConfig?: ProvidersConfig): string[] {
  return enabledApiProviders(providersConfig ?? loadProvidersConfig()).map(
    provider => provider.name
  );
}

/**
 * The complete set of capability ids: the static known providers plus any
 * enabled generic API providers (deduped, known providers first). Drives both
 * the unfiltered capability map and the `provider-tools://<id>` allowlist.
 */
function allProviderCapabilityIds(providersConfig?: ProvidersConfig): ProviderCapabilityId[] {
  return [
    ...new Set<ProviderCapabilityId>([
      ...PROVIDER_CAPABILITY_IDS,
      ...enabledApiCapabilityIds(providersConfig),
    ]),
  ];
}

export function providerCapabilityIds(
  providersConfig?: ProvidersConfig
): readonly ProviderCapabilityId[] {
  return allProviderCapabilityIds(providersConfig);
}

/**
 * The static known capability ids (the spawnable CLI providers plus grok_api), with
 * no dynamic generic API providers folded in. Callers that index CLI-keyed maps
 * (e.g. the doctor `provider_capabilities` summary) must use this, not the
 * widened `providerCapabilityIds()`.
 */
export function knownProviderCapabilityIds(): readonly KnownProviderCapabilityId[] {
  return PROVIDER_CAPABILITY_IDS;
}

function buildOneProviderToolCapabilities(
  cli: ProviderCapabilityId,
  query: NormalizedProviderCapabilityQuery
): ProviderToolCapabilities {
  const warnings: string[] = [];
  if (!isKnownProviderCapabilityId(cli)) {
    // Slice 6: a generic `[providers.<name>]` (kind:"api") id has no static
    // metadata; build it on demand from the enabled provider's runtime config.
    // A genuinely unknown / disabled id still has no metadata and is rejected.
    const runtime = enabledApiProviders(providersConfigForQuery(query)).find(
      provider => provider.name === cli
    );
    if (!runtime) {
      throw new Error(
        `No tool-capability metadata for provider "${cli}". ` +
          `Known providers: ${allProviderCapabilityIds(query.providersConfig).join(", ")}.`
      );
    }
    return buildApiProviderToolCapabilities(runtime, query);
  }
  const definition = TOOL_CONTROLS[cli];
  const discoveredSkills =
    query.includeSkills && cli !== "grok_api" ? discoverSkills(cli, warnings, query) : [];
  const discoveredProviderTools = query.includeProviderTools
    ? extractProviderTools(cli, discoveredSkills)
    : [];
  const features = { ...definition.features };
  const gatewayRequestTools =
    cli === "grok_api" && !isXaiProviderEnabled(providersConfigForQuery(query))
      ? []
      : [...definition.gatewayRequestTools];
  if (cli === "grok") {
    features.mediaGenerationOrEditing = {
      supported: discoveredProviderTools.some(tool =>
        ["image_gen", "image_edit", "image_to_video", "reference_to_video"].includes(tool.name)
      ),
      details: "True when Grok Imagine tools are discovered from local Grok skills.",
    };
  }
  return {
    schemaVersion: "provider-tool-capabilities.v2",
    generatedAt: new Date().toISOString(),
    cli,
    providerKind: definition.providerKind,
    gatewayRequestTools,
    gatewayRequestTool: gatewayRequestTools[0] ?? definition.gatewayRequestTools[0],
    modelInfo: getModelInfo(cli, query),
    summary: definition.summary,
    acpContract: { ...ACP_CONTRACT.providers[cli] },
    acp: buildAcpCapability(cli, query.acpConfig),
    controls: cloneControls(definition.controls),
    features,
    discoveredSkills,
    discoveredProviderTools,
    configSurfaces: discoverConfigSurfaces(cli, query, discoveredSkills),
    unsupportedInputs: query.includeUnsupported ? [...definition.unsupportedInputs] : [],
    warnings,
    metadata: {
      deprecatedFields: {
        gatewayRequestTool: "Use gatewayRequestTools instead.",
      },
      cacheTtlMs: CAPABILITY_CACHE_TTL_MS,
    },
  };
}

/**
 * Slice 6: build the controls/features metadata for a generic API provider
 * from its runtime kind. API providers support model selection, sampling,
 * max-output, timeout and (per-kind) reasoning + continuity; they never expose
 * tool allow/deny lists, MCP servers, local skills, or workspace/worktree
 * controls (those are CLI-only). xAI Responses forwards reasoning.effort; the
 * other kinds accept the schema field but ignore it.
 */
function apiProviderCapabilityDefinition(
  runtime: ApiProviderRuntime
): ProviderCapabilityStaticDefinition {
  const { name, kind } = runtime;
  const forwardsReasoning = kind === "xai-responses";
  const continuity = apiContinuityForKind(kind);
  const continuityTracked = continuity !== "none";
  return {
    providerKind: "api",
    gatewayRequestTools: [`api_${name}_request`],
    summary:
      `Generic ${kind} API provider "${name}" configured through [providers.${name}]. ` +
      "HTTP request tool only: no local CLI tools, skills, MCP servers, or workspaces.",
    controls: {
      allowlist: {
        supported: false,
        behavior: `api_${name}_request has no CLI tool allow-list input.`,
      },
      denylist: {
        supported: false,
        behavior: `api_${name}_request has no CLI tool deny-list input.`,
      },
      mcpServers: {
        supported: false,
        behavior: "API requests do not configure or expose MCP servers.",
      },
      nativeSkills: {
        supported: false,
        behavior: "API requests do not read local provider skills.",
      },
      reasoningEffort: forwardsReasoning
        ? {
            supported: true,
            requestField: "reasoningEffort",
            behavior: "Passed to the xAI Responses API reasoning.effort field.",
          }
        : {
            supported: false,
            requestField: "reasoningEffort",
            behavior: `Accepted by the schema but ignored by the ${kind} adapter.`,
          },
      maxOutputTokens: {
        supported: true,
        requestField: "maxOutputTokens",
        behavior: "Bounds the provider API max output tokens.",
      },
      sampling: {
        supported: true,
        requestField: "temperature/topP",
        behavior: "Sampling controls are passed through to the provider API.",
      },
      timeout: {
        supported: true,
        requestField: "timeoutMs",
        behavior: "Bounds the API HTTP request timeout.",
      },
      session: continuityTracked
        ? {
            supported: true,
            requestField: "sessionId/createNewSession",
            behavior:
              continuity === "server-side-id"
                ? "Gateway stores the provider continuation handle (previous_response_id) in session metadata."
                : "Gateway tracks the session (active/owner); stateless adapters resend prior context caller-side without storing conversation content.",
          }
        : {
            supported: false,
            requestField: "sessionId/createNewSession",
            behavior: "This provider kind does not support multi-turn continuity.",
          },
    },
    features: baseFeatures({
      apiProvider: true,
      structuredTextResponses: true,
      sessionContinuity: continuityTracked,
    }),
    unsupportedInputs: [
      {
        input: "localSkills",
        behavior: "not_supported",
        details: `api_${name}_request does not inspect local CLI skills.`,
      },
      {
        input: "allowedTools/disallowedTools",
        behavior: "not_supported",
        details: "Tool allow/deny controls are CLI-only and are not routed to the API.",
      },
      {
        input: "workspace/worktree",
        behavior: "not_supported",
        details: "API providers have no local workspace or worktree controls.",
      },
    ],
  };
}

/** Slice 6: discovery/model projection for a generic API provider. */
function apiProviderModelInfo(runtime: ApiProviderRuntime): GrokApiModelInfo {
  const list =
    runtime.models && runtime.models.length > 0 ? runtime.models : [runtime.defaultModel];
  const models: Record<string, string> = {};
  for (const model of list) {
    models[model] =
      model === runtime.defaultModel ? "Configured default model" : "Configured allowlisted model";
  }
  if (!(runtime.defaultModel in models)) {
    models[runtime.defaultModel] = "Configured default model (always permitted)";
  }
  return {
    description: `Generic ${runtime.kind} API provider configured through [providers.${runtime.name}].`,
    models,
    defaultModel: runtime.defaultModel,
    defaultModelSource: `[providers.${runtime.name}].default_model`,
  };
}

/**
 * Slice 6: config-surface projection for a generic API provider. Reports only
 * whether a key is resolved plus the configured env var name (never the value).
 */
function apiProviderConfigSurfaces(runtime: ApiProviderRuntime): ProviderConfigSurface[] {
  return [
    {
      name: `providers.${runtime.name}`,
      kind: "gateway",
      present: true,
      details: `Generic ${runtime.kind} API provider; secret key material is read only from the named environment variable at request time.`,
    },
    {
      name: "api_key_env",
      kind: "env",
      present: runtime.apiKey.length > 0,
      entries: runtime.apiKeyEnv ? [runtime.apiKeyEnv] : [],
      details:
        "Reports only the configured environment variable name and whether a key is resolved (keyless-local providers report false); never the value.",
    },
  ];
}

/**
 * Slice 6: assemble the full capability record for a generic API provider,
 * replacing the former unreachable defensive throw. ACP is not applicable to
 * an HTTP provider (no stdio process transport).
 */
function buildApiProviderToolCapabilities(
  runtime: ApiProviderRuntime,
  query: NormalizedProviderCapabilityQuery
): ProviderToolCapabilities {
  const definition = apiProviderCapabilityDefinition(runtime);
  return {
    schemaVersion: "provider-tool-capabilities.v2",
    generatedAt: new Date().toISOString(),
    cli: runtime.name,
    providerKind: "api",
    gatewayRequestTools: [...definition.gatewayRequestTools],
    gatewayRequestTool: definition.gatewayRequestTools[0],
    modelInfo: apiProviderModelInfo(runtime),
    summary: definition.summary,
    acpContract: {
      classification: "absent_watchlist",
      summary: `${runtime.name} is an HTTP API provider with no ACP process transport; watchlist item only.`,
    },
    acp: {
      status: "not_applicable",
      mediation: "none",
      targetVersion: `${runtime.kind} API`,
      entrypoint: null,
      runtimeEnabled: false,
      smokeSupported: false,
      smokeStatus: "unsupported",
      caveats: ["ACP is a CLI-stdio transport; the HTTP API provider has no ACP surface."],
      docs: ACP_DOCS_REFERENCE,
    },
    controls: cloneControls(definition.controls),
    features: { ...definition.features },
    discoveredSkills: [],
    discoveredProviderTools: [],
    configSurfaces: apiProviderConfigSurfaces(runtime),
    unsupportedInputs: query.includeUnsupported ? [...definition.unsupportedInputs] : [],
    warnings: [],
    metadata: {
      deprecatedFields: {
        gatewayRequestTool: "Use gatewayRequestTools instead.",
      },
      cacheTtlMs: CAPABILITY_CACHE_TTL_MS,
    },
  };
}

function discoverSkills(
  cli: CliType,
  warnings: string[],
  query: NormalizedProviderCapabilityQuery
): ProviderSkillCapability[] {
  const skills: ProviderSkillCapability[] = [];
  for (const root of skillRoots(cli)) {
    if (!existsSync(root.path)) continue;
    let entries;
    try {
      entries = readdirSync(root.path, { withFileTypes: true });
    } catch (error) {
      warnings.push(
        `Could not read skill directory ${formatPathForOutput(root.path, query)}: ${formatError(error)}`
      );
      continue;
    }

    for (const entry of entries.filter(item => item.isDirectory()).slice(0, MAX_SKILLS_PER_DIR)) {
      const skillPath = path.join(root.path, entry.name, "SKILL.md");
      if (!existsSync(skillPath)) continue;
      const parsed = readSkill(cli, skillPath, entry.name, root.source, warnings, query);
      if (parsed) skills.push(parsed);
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function skillRoots(cli: CliType): SkillRoot[] {
  const home = process.env.LLM_GATEWAY_TOOL_DISCOVERY_HOME || homedir();
  switch (cli) {
    case "claude":
      return [{ path: path.join(home, ".claude", "skills"), source: "user" }];
    case "codex":
      return [{ path: path.join(home, ".codex", "skills"), source: "user" }];
    case "gemini":
      return [{ path: path.join(home, ".gemini", "skills"), source: "user" }];
    case "grok":
      return [
        { path: path.join(home, ".grok", "skills"), source: "user" },
        { path: path.join(home, ".grok", "bundled", "skills"), source: "bundled" },
      ];
    case "mistral":
      return [{ path: path.join(home, ".vibe", "skills"), source: "user" }];
    case "devin":
      // Devin owns its skills via `devin skills`; the gateway does not discover
      // them (nativeSkills:false in TOOL_CONTROLS), so no roots are scanned.
      return [];
    case "cursor":
      // Cursor owns rules/plugins; the gateway does not discover them as
      // provider-native skills (nativeSkills:false in TOOL_CONTROLS).
      return [];
  }
}

function readSkill(
  cli: CliType,
  skillPath: string,
  fallbackName: string,
  source: "user" | "bundled",
  warnings: string[],
  query: NormalizedProviderCapabilityQuery
): ProviderSkillCapability | null {
  try {
    const stat = statSync(skillPath);
    if (!stat.isFile()) return null;
    const content = readFileSync(skillPath, "utf8").slice(0, MAX_SKILL_BYTES);
    const extractedTools = extractDeclaredTools(cli, content);
    return {
      name: extractFrontmatterValue(content, "name") ?? fallbackName,
      source,
      path: query.includePaths ? skillPath : undefined,
      description:
        extractFrontmatterValue(content, "description") ??
        extractFrontmatterValue(content, "metadata.short-description") ??
        extractFrontmatterValue(content, "short-description") ??
        extractFirstHeading(content),
      declaredTools: extractedTools.tools,
      declaredToolReasons: extractedTools.reasons,
    };
  } catch (error) {
    warnings.push(
      `Could not read skill ${formatPathForOutput(skillPath, query)}: ${formatError(error)}`
    );
    return null;
  }
}

function normalizeQuery(
  queryOrCli: ProviderCapabilityQuery | ProviderCapabilityId
): NormalizedProviderCapabilityQuery {
  const query = typeof queryOrCli === "string" ? { cli: queryOrCli } : queryOrCli;
  return {
    cli: query.cli,
    includeSkills: query.includeSkills ?? true,
    includeProviderTools: query.includeProviderTools ?? true,
    includeUnsupported: query.includeUnsupported ?? true,
    includePaths: query.includePaths ?? false,
    refresh: query.refresh ?? false,
    providersConfig: query.providersConfig,
    acpConfig: query.acpConfig,
  };
}

function capabilityCacheKey(
  cli: ProviderCapabilityId,
  query: NormalizedProviderCapabilityQuery
): string {
  return JSON.stringify({
    cli,
    includeSkills: query.includeSkills,
    includeProviderTools: query.includeProviderTools,
    includeUnsupported: query.includeUnsupported,
    includePaths: query.includePaths,
    providersConfig: query.providersConfig ? providerConfigCacheKey(query.providersConfig) : null,
    acpConfig: query.acpConfig ? acpConfigCacheKey(query.acpConfig) : null,
  });
}

/**
 * Cache fingerprint for the ACP config: only the gates that affect
 * `acp.runtimeEnabled` (global `enabled` plus each provider block's
 * `enabled`/`runtimeEnabled`), so a config change that flips runtime routing
 * invalidates the cached capability record.
 */
function acpConfigCacheKey(config: AcpConfig): unknown {
  return {
    enabled: config.enabled,
    providers: Object.fromEntries(
      Object.entries(config.providers)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, provider]) => [
          name,
          { enabled: provider.enabled, runtimeEnabled: provider.runtimeEnabled },
        ])
    ),
  };
}

function providerConfigCacheKey(config: ProvidersConfig): unknown {
  return {
    xai: config.xai
      ? {
          apiKeyEnv: config.xai.apiKeyEnv,
          baseUrl: config.xai.baseUrl,
          defaultModel: config.xai.defaultModel,
        }
      : null,
    providers: Object.fromEntries(
      Object.entries(config.providers ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, provider]) => [
          name,
          {
            kind: provider.kind,
            apiKeyEnv: provider.apiKeyEnv,
            baseUrl: provider.baseUrl,
            defaultModel: provider.defaultModel,
            models: provider.models ?? null,
            usageInclude: provider.usageInclude ?? null,
          },
        ])
    ),
  };
}

function baseFeatures(overrides: Record<string, boolean>): ProviderFeatureMap {
  const names = [
    "gatewayRequestTools",
    "modelDefaultsAndAliases",
    "toolAllowDenyControls",
    "mcpServerConfiguration",
    "nativeSkills",
    "providerNativeTools",
    "multimodalInputs",
    "mediaGenerationOrEditing",
    "structuredOutput",
    "subagentsOrAgents",
    "webSearchOrRemoteRetrieval",
    "memoryControls",
    "workspaceAndWorktreeControls",
    "sessionContinuity",
    "approvalAndSandboxControls",
    "costAndLoopControls",
    "unsupportedOrDegradedInputs",
    "apiProvider",
    "structuredTextResponses",
    "webSearchControl",
    "memoryControl",
    "promptControl",
    "compactionControls",
    "trustControl",
    "enabledToolAllowlist",
  ];
  return Object.fromEntries(
    names.map(name => [
      name,
      {
        supported:
          name === "gatewayRequestTools" ||
          name === "modelDefaultsAndAliases" ||
          name === "unsupportedOrDegradedInputs" ||
          Boolean(overrides[name]),
      },
    ])
  );
}

function cloneControls(controls: ProviderCapabilityControls): ProviderCapabilityControls {
  return Object.fromEntries(
    Object.entries(controls).map(([name, control]) => [name, { name, ...control }])
  ) as ProviderCapabilityControls;
}

function getModelInfo(
  cli: KnownProviderCapabilityId,
  query: NormalizedProviderCapabilityQuery
): CliInfo | GrokApiModelInfo {
  if (cli !== "grok_api") {
    return getAvailableCliInfo(query.refresh)[cli];
  }

  const providers = providersConfigForQuery(query);
  const enabled = isXaiProviderEnabled(providers);
  const defaultModel = providers.xai?.defaultModel;
  return {
    description:
      "xAI Grok Responses API provider configured through [providers.xai]; distinct from Grok CLI/Build.",
    models: defaultModel ? { [defaultModel]: "Configured xAI Responses API default model" } : {},
    defaultModel,
    defaultModelSource: defaultModel ? "[providers.xai].default_model" : undefined,
    warnings: enabled
      ? []
      : ["[providers.xai] is not enabled or the configured API-key environment variable is unset."],
  };
}

function discoverConfigSurfaces(
  cli: KnownProviderCapabilityId,
  query: NormalizedProviderCapabilityQuery,
  discoveredSkills: ProviderSkillCapability[]
): ProviderConfigSurface[] {
  if (cli === "grok_api") {
    const providers = providersConfigForQuery(query);
    return [
      {
        name: "providers.xai",
        kind: "gateway",
        present: providers.xai !== null,
        details: providers.xai
          ? "xAI API provider is configured; secret key material is read only from the named environment variable at request time."
          : "Add [providers.xai] to the gateway config and set the configured API-key environment variable to enable grok_api_request.",
      },
      {
        name: "xai_api_key_env",
        kind: "env",
        present: isXaiProviderEnabled(providers),
        entries: providers.xai ? [providers.xai.apiKeyEnv] : [],
        details:
          "Reports only the environment variable name and whether it is set; never the value.",
      },
    ];
  }
  const surfaces: ProviderConfigSurface[] = [];
  addSkillSurfaces(surfaces, cli, query, discoveredSkills);
  switch (cli) {
    case "claude":
      addFileSurface(
        surfaces,
        "claude_settings",
        providerHomePath(".claude", "settings.json"),
        query
      );
      addFileSurface(
        surfaces,
        "claude_local_settings",
        providerHomePath(".claude", "settings.local.json"),
        query
      );
      surfaces.push({
        name: "gateway_mcp_config_generation",
        kind: "gateway",
        present: true,
        entries: [...CLAUDE_MCP_SERVER_NAMES],
        details: "Gateway can generate a Claude MCP config for gateway-known MCP servers.",
      });
      break;
    case "codex":
      addCodexConfigSurfaces(surfaces, query);
      break;
    case "gemini":
      addFileSurface(
        surfaces,
        "gemini_settings",
        providerHomePath(".gemini", "settings.json"),
        query
      );
      addFileSurface(
        surfaces,
        "gemini_trusted_folders",
        providerHomePath(".gemini", "trusted_folders.json"),
        query
      );
      break;
    case "grok":
      addGrokConfigSurfaces(surfaces, query);
      break;
    case "mistral":
      addVibeConfigSurfaces(surfaces, query);
      break;
    case "devin":
      // Devin owns its own config (`devin mcp`, `devin skills`); the gateway
      // discovers no Devin config files (nativeSkills:false, mcpServers:false in
      // TOOL_CONTROLS), so there are no gateway-managed config surfaces to add.
      // Explicit no-op case (mirrors the skillRoots `devin` case) rather than a
      // silent fall-through.
      break;
  }
  return surfaces;
}

function extractProviderTools(
  cli: KnownProviderCapabilityId,
  skills: ProviderSkillCapability[]
): ProviderNativeToolCapability[] {
  if (cli === "grok_api") return [];
  const tools = new Map<string, ProviderNativeToolCapability>();
  for (const skill of skills) {
    for (const toolName of skill.declaredTools) {
      const existing = tools.get(toolName);
      if (existing) continue;
      tools.set(toolName, {
        name: toolName,
        source: skill.name === "imagine" && isKnownProviderTool(cli, toolName) ? "imagine" : cli,
        skillName: skill.name,
        path: skill.path,
        confidence: providerToolConfidence(cli, toolName, skill.declaredToolReasons?.[toolName]),
        reason: skill.declaredToolReasons?.[toolName] ?? "backtick-heuristic",
      });
    }
  }
  return [...tools.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function providerToolConfidence(
  cli: KnownProviderCapabilityId,
  toolName: string,
  reason: ProviderToolExtractionReason | undefined
): ProviderToolConfidence {
  if (isKnownProviderTool(cli, toolName)) return "high";
  if (reason === "exact-tool-section") return "medium";
  if (reason === "backtick-heuristic") return "medium";
  return "low";
}

function isKnownProviderTool(cli: KnownProviderCapabilityId, toolName: string): boolean {
  return KNOWN_PROVIDER_TOOLS[cli]?.includes(toolName) ?? false;
}

function formatPathForOutput(outputPath: string, query: NormalizedProviderCapabilityQuery): string {
  if (query.includePaths) return outputPath;
  return redactHomePath(outputPath);
}

function redactHomePath(outputPath: string): string {
  const home = process.env.LLM_GATEWAY_TOOL_DISCOVERY_HOME || homedir();
  const relative = path.relative(home, outputPath);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return path.join("~", relative);
  }
  return "<redacted-path>";
}

function providerHomePath(...parts: string[]): string {
  return path.join(process.env.LLM_GATEWAY_TOOL_DISCOVERY_HOME || homedir(), ...parts);
}

function addSkillSurfaces(
  surfaces: ProviderConfigSurface[],
  cli: CliType,
  query: NormalizedProviderCapabilityQuery,
  discoveredSkills: ProviderSkillCapability[]
): void {
  for (const root of skillRoots(cli)) {
    surfaces.push({
      name: `${cli}_${root.source}_skills`,
      kind: "directory",
      present: existsSync(root.path),
      path: query.includePaths ? root.path : undefined,
      details: `skills=${discoveredSkills.filter(skill => skill.source === root.source).length}`,
    });
  }
}

function addFileSurface(
  surfaces: ProviderConfigSurface[],
  name: string,
  filePath: string,
  query: NormalizedProviderCapabilityQuery,
  details?: string,
  entries?: string[]
): void {
  surfaces.push({
    name,
    kind: "file",
    present: existsSync(filePath),
    path: query.includePaths ? filePath : undefined,
    entries,
    details,
  });
}

function addCodexConfigSurfaces(
  surfaces: ProviderConfigSurface[],
  query: NormalizedProviderCapabilityQuery
): void {
  const configPath = providerHomePath(".codex", "config.toml");
  const parsed = parseConfigToml(configPath);
  addFileSurface(surfaces, "codex_config", configPath, query);
  surfaces.push({
    name: "codex_profiles",
    kind: "provider",
    present: parsed !== null && hasObjectKey(parsed, "profiles"),
    entries: objectKeysAt(parsed, "profiles"),
    details: "Profile names only; model values are sourced from modelInfo.",
  });
  surfaces.push({
    name: "codex_mcp_servers",
    kind: "provider",
    present: parsed !== null && hasObjectKey(parsed, "mcp_servers"),
    entries: objectKeysAt(parsed, "mcp_servers"),
    details: "MCP server names only; command/env values are redacted.",
  });
}

function addGrokConfigSurfaces(
  surfaces: ProviderConfigSurface[],
  query: NormalizedProviderCapabilityQuery
): void {
  const configPath = providerHomePath(".grok", "config.toml");
  const parsed = parseConfigToml(configPath);
  addFileSurface(surfaces, "grok_config", configPath, query);
  surfaces.push({
    name: "grok_mcp_servers",
    kind: "provider",
    present: parsed !== null && hasObjectKey(parsed, "mcp_servers"),
    entries: objectKeysAt(parsed, "mcp_servers"),
    details: "Grok-owned MCP server names only where safely discoverable.",
  });
  addDirectoryPresence(surfaces, "grok_docs", providerHomePath(".grok", "docs"), query);
  addDirectoryPresence(surfaces, "grok_help", providerHomePath(".grok", "help"), query);
}

function addVibeConfigSurfaces(
  surfaces: ProviderConfigSurface[],
  query: NormalizedProviderCapabilityQuery
): void {
  const configPath = providerHomePath(".vibe", "config.toml");
  const parsed = parseConfigToml(configPath);
  addFileSurface(surfaces, "vibe_config", configPath, query);
  surfaces.push({
    name: "vibe_session_logging",
    kind: "provider",
    present: parsed !== null && hasObjectKey(parsed, "session_logging"),
    details: booleanTomlValue(parsed, ["session_logging", "enabled"]),
  });
  surfaces.push({
    name: "vibe_trusted_folders",
    kind: "provider",
    present: parsed !== null && hasObjectKey(parsed, "trusted_folders"),
    details: parsed !== null && hasObjectKey(parsed, "trusted_folders") ? "present" : "missing",
  });
}

function addDirectoryPresence(
  surfaces: ProviderConfigSurface[],
  name: string,
  dirPath: string,
  query: NormalizedProviderCapabilityQuery
): void {
  surfaces.push({
    name,
    kind: "directory",
    present: existsSync(dirPath),
    path: query.includePaths ? dirPath : undefined,
  });
}

function parseConfigToml(configPath: string): Record<string, unknown> | null {
  if (!existsSync(configPath)) return null;
  try {
    const stat = statSync(configPath);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return null;
    return parseToml(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hasObjectKey(source: Record<string, unknown> | null, key: string): boolean {
  return !!source && typeof source[key] === "object" && source[key] !== null;
}

function objectKeysAt(source: Record<string, unknown> | null, key: string): string[] {
  if (!source || typeof source[key] !== "object" || source[key] === null) return [];
  return Object.keys(source[key] as Record<string, unknown>).sort();
}

function booleanTomlValue(source: Record<string, unknown> | null, pathParts: string[]): string {
  let current: unknown = source;
  for (const part of pathParts) {
    if (!current || typeof current !== "object") return "missing";
    current = (current as Record<string, unknown>)[part];
  }
  if (typeof current === "boolean") return current ? "enabled" : "disabled";
  return "present";
}

function extractFrontmatterValue(content: string, key: string): string | undefined {
  if (!content.startsWith("---")) return undefined;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return undefined;
  const frontmatter = content.slice(3, end);
  const lines = frontmatter.split(/\r?\n/);
  if (key.includes(".")) {
    return extractNestedFrontmatterValue(lines, key);
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = new RegExp(`^${escapeRegExp(key)}:\\s*(.*)$`).exec(line);
    if (!match) continue;
    const rawValue = match[1].trim();
    if (/^[>|][+-]?$/.test(rawValue)) {
      return extractBlockScalar(lines, index + 1, rawValue.startsWith(">"), indentationOf(line));
    }
    return rawValue.replace(/^["']|["']$/g, "").trim() || undefined;
  }
  return undefined;
}

function extractNestedFrontmatterValue(lines: string[], key: string): string | undefined {
  const [parent, child] = key.split(".", 2);
  for (let index = 0; index < lines.length; index += 1) {
    if (!new RegExp(`^${escapeRegExp(parent)}:\\s*$`).test(lines[index])) continue;
    for (let childIndex = index + 1; childIndex < lines.length; childIndex += 1) {
      const line = lines[childIndex];
      if (line.length > 0 && !/^\s/.test(line)) break;
      const match = new RegExp(`^\\s+${escapeRegExp(child)}:\\s*(.*)$`).exec(line);
      if (!match) continue;
      const rawValue = match[1].trim();
      if (/^[>|][+-]?$/.test(rawValue)) {
        return extractBlockScalar(
          lines,
          childIndex + 1,
          rawValue.startsWith(">"),
          indentationOf(line)
        );
      }
      return rawValue.replace(/^["']|["']$/g, "").trim() || undefined;
    }
  }
  return undefined;
}

function extractBlockScalar(
  lines: string[],
  startIndex: number,
  folded: boolean,
  parentIndent: number
): string | undefined {
  const block: string[] = [];
  for (let index = startIndex; index < lines.length; index += 1) {
    const blockLine = lines[index];
    if (blockLine.trim().length > 0 && indentationOf(blockLine) <= parentIndent) break;
    block.push(blockLine.trim());
  }
  return (
    block
      .filter(Boolean)
      .join(folded ? " " : "\n")
      .trim() || undefined
  );
}

function indentationOf(line: string): number {
  return line.match(/^\s*/)?.[0].length ?? 0;
}

function extractFirstHeading(content: string): string | undefined {
  const match = /^#\s+(.+)$/m.exec(content);
  return match?.[1]?.trim();
}

function extractDeclaredTools(
  cli: KnownProviderCapabilityId,
  content: string
): ExtractedDeclaredTools {
  const tools = new Map<string, ProviderToolExtractionReason>();
  for (const identifier of extractToolSectionIdentifiers(content)) {
    addToolHint(tools, cli, identifier, "exact-tool-section");
  }
  for (const knownTool of KNOWN_PROVIDER_TOOLS[cli] ?? []) {
    if (new RegExp(`\\b${escapeRegExp(knownTool)}\\b`).test(content)) {
      addToolHint(tools, cli, knownTool, "known-tool-name");
    }
  }
  const pattern = /`([A-Za-z][A-Za-z0-9_:-]{2,64})`/g;
  for (const match of content.matchAll(pattern)) {
    addToolHint(tools, cli, match[1], "backtick-heuristic");
  }
  const entries = [...tools.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, MAX_PROVIDER_TOOLS_PER_SKILL);
  return {
    tools: entries.map(([tool]) => tool),
    reasons: Object.fromEntries(entries),
  };
}

function extractToolSectionIdentifiers(content: string): string[] {
  const identifiers = new Set<string>();
  const sectionMatch =
    /^#{1,3}\s+(?:provider\s+tools|native\s+tools|available\s+tools|tools)\s*$/im.exec(content);
  if (!sectionMatch) return [];
  const sectionStart = sectionMatch.index + sectionMatch[0].length;
  const nextHeading = /^#{1,3}\s+/m.exec(content.slice(sectionStart));
  const section = content.slice(
    sectionStart,
    nextHeading ? sectionStart + nextHeading.index : undefined
  );
  const identifierPattern = /(?:`|^|\s|[-*])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?:`|$|\s|[:,.)])/gm;
  for (const match of section.matchAll(identifierPattern)) {
    identifiers.add(match[1]);
  }
  return [...identifiers];
}

function addToolHint(
  tools: Map<string, ProviderToolExtractionReason>,
  cli: KnownProviderCapabilityId,
  identifier: string,
  reason: ProviderToolExtractionReason
): void {
  if (!isPlausibleToolIdentifier(cli, identifier)) return;
  const existing = tools.get(identifier);
  if (existing === "known-tool-name" || existing === "exact-tool-section") return;
  if (existing === "backtick-heuristic" && reason === "low-confidence") return;
  tools.set(identifier, reason);
}

function isPlausibleToolIdentifier(cli: KnownProviderCapabilityId, identifier: string): boolean {
  if (isKnownProviderTool(cli, identifier)) return true;
  if (identifier.includes(":")) return false;
  if (NOISE_TOOL_IDENTIFIERS.has(identifier)) return false;
  return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(identifier);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
