import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import path from "path";
import { parse as parseToml } from "smol-toml";
import { CLAUDE_MCP_SERVER_NAMES } from "./claude-mcp-config.js";
import { getAvailableCliInfo, type CliInfo } from "./model-registry.js";
import { CLI_TYPES, type CliType } from "./session-manager.js";
import { isXaiProviderEnabled, loadProvidersConfig } from "./config.js";

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

export type ProviderCapabilityId = CliType | "grok_api";
export type ProviderKind = "cli" | "api";
export type UnsupportedInputBehavior =
  | "reject"
  | "ignored"
  | "not_supported"
  | "approval_tracking_only"
  | "deprecated";
export type ProviderToolConfidence = "high" | "medium" | "low";
export type ProviderToolExtractionReason =
  | "exact-tool-section"
  | "known-tool-name"
  | "backtick-heuristic"
  | "low-confidence";

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
   * static phase-0 capability metadata; runtime routing stays disabled until a
   * later rollout phase explicitly enables it behind config gates.
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
  | "native_candidate"
  | "adapter_mediated_deferred"
  | "absent_watchlist";

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
  /** Per-provider frozen classification. */
  providers: Readonly<Record<ProviderCapabilityId, AcpProviderContract>>;
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
      summary: "Mistral Vibe exposes native ACP via vibe-acp; first runtime pilot candidate.",
    },
    grok: {
      classification: "native_candidate",
      summary:
        "xAI Grok CLI exposes native ACP via grok agent stdio; second runtime pilot candidate.",
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
      summary: "Google Antigravity agy 1.0.7 has no ACP surface; watchlist item only.",
    },
    grok_api: {
      classification: "absent_watchlist",
      summary: "Grok API is an HTTP provider with no ACP process transport; watchlist item only.",
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
 * Static, phase-0 ACP capability metadata per provider. Sourced from the ACP
 * extension provider_matrix. `runtimeEnabled` is false for every provider here:
 * ACP runtime routing is gated off until a later rollout phase enables it.
 * Entrypoints are stored only as executable + argv arrays (no shell strings).
 */
const ACP_CAPABILITIES: Record<ProviderCapabilityId, ProviderAcpCapability> = {
  mistral: {
    status: "native_smoke_passed",
    mediation: "native",
    targetVersion: "vibe 2.14.1",
    entrypoint: { command: "vibe-acp", args: [] },
    runtimeEnabled: false,
    smokeSupported: true,
    smokeStatus: "passed",
    caveats: [
      "Native ACP via the provider-scoped vibe-acp executable; first runtime pilot.",
      "Runtime routing stays disabled until ACP is enabled in gateway config.",
    ],
    docs: ACP_DOCS_REFERENCE,
  },
  grok: {
    status: "native_smoke_passed",
    mediation: "native",
    targetVersion: "grok 0.2.50 (cadf94855)",
    entrypoint: { command: "grok", args: ["agent", "stdio"] },
    runtimeEnabled: false,
    smokeSupported: true,
    smokeStatus: "passed",
    caveats: [
      "Native ACP via grok agent stdio; second runtime pilot.",
      "Credential lookup is owned by the installed CLI; empty-env smoke is not expected to pass.",
      "Runtime routing stays disabled until ACP is enabled in gateway config.",
    ],
    docs: ACP_DOCS_REFERENCE,
  },
  codex: {
    status: "adapter_mediated_deferred",
    mediation: "adapter_mediated",
    targetVersion: "codex-cli 0.139.0",
    entrypoint: null,
    runtimeEnabled: false,
    smokeSupported: false,
    smokeStatus: "unsupported",
    caveats: [
      "No native ACP entrypoint at the target version; ACP would be adapter-mediated.",
      "Adapter support requires a separate threat model and is never labelled native gateway ACP support.",
    ],
    docs: ACP_DOCS_REFERENCE,
  },
  claude: {
    status: "adapter_mediated_deferred",
    mediation: "adapter_mediated",
    targetVersion: "claude 2.1.175",
    entrypoint: null,
    runtimeEnabled: false,
    smokeSupported: false,
    smokeStatus: "unsupported",
    caveats: [
      "No native Claude Code CLI ACP entrypoint at the target version; ACP would be adapter-mediated.",
      "Adapter ownership, permission bridging, and install story must be specified before runtime support.",
    ],
    docs: ACP_DOCS_REFERENCE,
  },
  gemini: {
    status: "absent_watchlist",
    mediation: "none",
    targetVersion: "agy 1.0.7",
    entrypoint: null,
    runtimeEnabled: false,
    smokeSupported: false,
    smokeStatus: "unsupported",
    caveats: [
      "Antigravity agy 1.0.7 has no ACP flag or subcommand.",
      "Legacy Gemini CLI ACP evidence does not transfer to agy; kept on the upstream drift watchlist.",
    ],
    docs: ACP_DOCS_REFERENCE,
  },
  grok_api: {
    status: "not_applicable",
    mediation: "none",
    targetVersion: "xAI Responses API",
    entrypoint: null,
    runtimeEnabled: false,
    smokeSupported: false,
    smokeStatus: "unsupported",
    caveats: ["ACP is a CLI-stdio transport; the HTTP API provider has no ACP surface."],
    docs: ACP_DOCS_REFERENCE,
  },
};

function cloneAcpCapability(acp: ProviderAcpCapability): ProviderAcpCapability {
  return {
    ...acp,
    entrypoint: acp.entrypoint
      ? { command: acp.entrypoint.command, args: [...acp.entrypoint.args] }
      : null,
    caveats: [...acp.caveats],
  };
}

const PROVIDER_CAPABILITY_IDS = [...CLI_TYPES, "grok_api"] as const;

const KNOWN_PROVIDER_TOOLS: Partial<Record<ProviderCapabilityId, readonly string[]>> = {
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

const TOOL_CONTROLS: Record<ProviderCapabilityId, ProviderCapabilityStaticDefinition> = {
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
          "Gateway can generate a Claude MCP config for selected gateway-known MCP servers.",
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
        behavior: "Passes Claude permission-mode values through to the CLI.",
      },
      approvalStrategy: {
        supported: true,
        requestField: "approvalStrategy",
        behavior: "Gateway approval strategy controls MCP-managed permission gating.",
      },
      approvalPolicy: {
        supported: true,
        requestField: "approvalPolicy",
        behavior: "Gateway approval policy tunes MCP-managed review strictness.",
      },
      strictMcpConfig: {
        supported: true,
        requestField: "strictMcpConfig",
        behavior: "Restricts Claude to the generated MCP config when mcpServers is used.",
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
        behavior: "Gateway resolves additional directories, workspace aliases, and worktrees.",
      },
      session: {
        supported: true,
        requestField:
          "continueSession/sessionId/forkSession/noSessionPersistence/settings/settingSources",
        behavior: "Supports Claude session continuation, forks, ephemeral runs, and settings.",
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
          "Accepted for approval tracking only; Codex manages its own MCP configuration outside the gateway.",
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
        behavior: "Passes Codex approval prompting policy through to the CLI.",
      },
      bypassApprovalsAndSandbox: {
        supported: true,
        requestField: "dangerouslyBypassApprovalsAndSandbox",
        behavior: "Explicit high-risk Codex bypass control.",
      },
      profileAndConfig: {
        supported: true,
        requestField: "profile/configOverrides/ignoreUserConfig/ignoreRules",
        behavior: "Passes Codex profile and config override controls.",
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
        behavior: "approval_tracking_only",
        details: "Accepted only for gateway approval tracking; Codex owns MCP configuration.",
      },
    ],
  },
  gemini: {
    providerKind: "cli",
    gatewayRequestTools: ["gemini_request", "gemini_request_async"],
    summary:
      "Antigravity/Gemini owns its runtime tool catalog; this gateway rejects non-empty tool allow-list and MCP-server inputs for that CLI.",
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
        behavior: "Non-empty values are rejected; Antigravity CLI manages tool access itself.",
      },
      nativeSkills: {
        supported: true,
        behavior:
          "Gateway discovers local Gemini skills from ~/.gemini/skills for capability reporting.",
      },
      approvalMode: {
        supported: true,
        requestField: "approvalMode/yolo",
        behavior: "Passes Antigravity approval mode when supported by the gateway path.",
      },
      sandbox: {
        supported: true,
        requestField: "sandbox",
        cliFlag: "-s",
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
        behavior: "reject",
        details: "Non-empty mcpServers values are rejected for the current Antigravity path.",
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
          "Accepted for approval tracking only; Grok manages its own MCP configuration via grok mcp.",
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
        requestField: "permissionMode/approvalStrategy/approvalPolicy",
        behavior: "Combines Grok CLI permission mode with gateway approval controls.",
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
          "Surfaces Grok prompt-file, JSON prompt, single-run, verbatim, and rules controls.",
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
        behavior: "approval_tracking_only",
        details: "Accepted only for gateway approval tracking; Grok owns MCP configuration.",
      },
    ],
  },
  mistral: {
    providerKind: "cli",
    gatewayRequestTools: ["mistral_request", "mistral_request_async"],
    summary:
      "Mistral Vibe owns its runtime tool catalog; the gateway can pass Vibe enabled-tool controls and reports local skills if present.",
    controls: {
      allowlist: {
        supported: true,
        requestField: "allowedTools",
        cliFlag: "--enabled-tools",
        behavior: "Each entry is emitted as a separate Vibe enabled-tool flag.",
      },
      denylist: {
        supported: false,
        requestField: "disallowedTools",
        behavior: "Accepted for caller parity but ignored because Vibe has no deny-list flag.",
      },
      mcpServers: {
        supported: false,
        requestField: "mcpServers",
        behavior:
          "Accepted for approval tracking only; Vibe manages its own MCP configuration via vibe mcp.",
      },
      nativeSkills: {
        supported: true,
        behavior:
          "Gateway discovers local Vibe skills from ~/.vibe/skills when that directory exists.",
      },
      permissionMode: {
        supported: true,
        requestField: "permissionMode",
        behavior: "Passes Vibe agent modes such as plan, auto-approve, chat, explore, and lean.",
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
      enabledToolAllowlist: true,
      trustControl: true,
    }),
    unsupportedInputs: [
      {
        input: "disallowedTools",
        behavior: "ignored",
        details: "Accepted for caller parity but ignored because Vibe has no deny-list flag.",
      },
      {
        input: "mcpServers",
        behavior: "approval_tracking_only",
        details: "Accepted only for gateway approval tracking; Vibe owns MCP configuration.",
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
};

let capabilityCache = new Map<string, { loadedAt: number; value: ProviderToolCapabilities }>();

export function getProviderToolCapabilities(
  queryOrCli: ProviderCapabilityQuery | ProviderCapabilityId = {}
): ProviderToolCapabilitiesMap {
  const query = normalizeQuery(queryOrCli);
  const providers = query.cli ? [query.cli] : PROVIDER_CAPABILITY_IDS;
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
  const cached = capabilityCache.get(cacheKey);
  if (!query.refresh && cached && Date.now() - cached.loadedAt < CAPABILITY_CACHE_TTL_MS) {
    return cached.value;
  }
  const value = buildOneProviderToolCapabilities(cli, query);
  capabilityCache.set(cacheKey, { loadedAt: Date.now(), value });
  return value;
}

export function clearProviderToolCapabilitiesCache(): void {
  capabilityCache = new Map();
}

export function providerCapabilityIds(): readonly ProviderCapabilityId[] {
  return PROVIDER_CAPABILITY_IDS;
}

function buildOneProviderToolCapabilities(
  cli: ProviderCapabilityId,
  query: NormalizedProviderCapabilityQuery
): ProviderToolCapabilities {
  const warnings: string[] = [];
  const definition = TOOL_CONTROLS[cli];
  const discoveredSkills =
    query.includeSkills && cli !== "grok_api" ? discoverSkills(cli, warnings, query) : [];
  const discoveredProviderTools = query.includeProviderTools
    ? extractProviderTools(cli, discoveredSkills)
    : [];
  const features = { ...definition.features };
  const gatewayRequestTools =
    cli === "grok_api" && !isXaiProviderEnabled(loadProvidersConfig())
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
    modelInfo: getModelInfo(cli, query.refresh),
    summary: definition.summary,
    acpContract: { ...ACP_CONTRACT.providers[cli] },
    acp: cloneAcpCapability(ACP_CAPABILITIES[cli]),
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
  });
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

function getModelInfo(cli: ProviderCapabilityId, refresh: boolean): CliInfo | GrokApiModelInfo {
  if (cli !== "grok_api") {
    return getAvailableCliInfo(refresh)[cli];
  }

  const providers = loadProvidersConfig();
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
  cli: ProviderCapabilityId,
  query: NormalizedProviderCapabilityQuery,
  discoveredSkills: ProviderSkillCapability[]
): ProviderConfigSurface[] {
  if (cli === "grok_api") {
    const providers = loadProvidersConfig();
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
  }
  return surfaces;
}

function extractProviderTools(
  cli: ProviderCapabilityId,
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
  cli: ProviderCapabilityId,
  toolName: string,
  reason: ProviderToolExtractionReason | undefined
): ProviderToolConfidence {
  if (isKnownProviderTool(cli, toolName)) return "high";
  if (reason === "exact-tool-section") return "medium";
  if (reason === "backtick-heuristic") return "medium";
  return "low";
}

function isKnownProviderTool(cli: ProviderCapabilityId, toolName: string): boolean {
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

function extractDeclaredTools(cli: ProviderCapabilityId, content: string): ExtractedDeclaredTools {
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
  cli: ProviderCapabilityId,
  identifier: string,
  reason: ProviderToolExtractionReason
): void {
  if (!isPlausibleToolIdentifier(cli, identifier)) return;
  const existing = tools.get(identifier);
  if (existing === "known-tool-name" || existing === "exact-tool-section") return;
  if (existing === "backtick-heuristic" && reason === "low-confidence") return;
  tools.set(identifier, reason);
}

function isPlausibleToolIdentifier(cli: ProviderCapabilityId, identifier: string): boolean {
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
