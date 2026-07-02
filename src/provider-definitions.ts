/**
 * Provider definition registry: the single source of truth for every CLI
 * provider surface.
 *
 * This module owns provider IDENTITY and DISCOVERY STRATEGY for every member of
 * {@link CLI_TYPES}. It consolidates the per-provider facts that were previously
 * scattered across `src/acp/provider-registry.ts`, `src/upstream-contracts.ts`
 * (`ACP_ENTRYPOINT_CONTRACTS` + `upstreamMetadata`), `src/provider-tool-
 * capabilities.ts`, `src/resources.ts`, and `src/model-registry.ts` into one
 * typed object per provider.
 *
 * Non-negotiable DRY rule (see the plan's `shared_provider_registry_design`):
 * no gateway surface may keep its own provider list, capability matrix, or
 * resource matrix. Surfaces must import this registry (or a projection from
 * `provider-surface-generator.ts`). The `provider:surfaces:check` gate and the
 * compile-time `satisfies Record<CliType, ProviderDefinition>` below enforce it.
 *
 * Data-only: nothing here spawns a process, runs a subcommand, or performs I/O.
 * Runtime capability discovery (probing the installed executable) is phase-1b.
 * Every value below is grounded in installed `--help`/`--version` evidence
 * captured on 2026-07-01 and the plan's `[providers.*]` sections; no capability
 * is invented.
 *
 * IMPORTANT (import direction): this module imports ONLY from
 * `./provider-types.js`. Downstream modules (`session-manager.ts`,
 * `provider-tool-capabilities.ts`, `upstream-contracts.ts`, and later phases)
 * import FROM here. Never add an import that would create a cycle.
 */

import { CLI_TYPES, type CliType } from "./provider-types.js";

// Re-export the enum source so downstream surfaces can reference provider
// identity through the registry rather than reaching for their own copy.
export { CLI_TYPES, type CliType };

/** A provider id is a CLI provider key. */
export type ProviderId = CliType;

/** Request transport family for a provider request tool. Only "cli" today. */
export type RequestTransport = "cli";

/**
 * Native-vs-none ACP classification. Deliberately binary: an adapter-mediated or
 * absent provider is `"none"`, never `"native"`. No adapter may masquerade as a
 * native ACP entrypoint (plan `native_acp_requirements`).
 */
export type AcpClassification = "native" | "none";

/** Safety class of a declared provider admin subcommand family. */
export type AdminSafetyClass = "read-only" | "mutating-gated";

/**
 * How a declared admin family is actually reached on the installed CLI. This
 * exists to keep the registry HONEST: not every admin surface is an invokable
 * subcommand. Some are top-level flags, and some are read-only projections of a
 * provider config file (there is no CLI command to invoke at all).
 *  - `cli-subcommand`: a real invokable subcommand (e.g. `claude mcp`).
 *  - `cli-flag`: a top-level flag, not a subcommand (e.g. `vibe --setup`).
 *  - `config-projection`: a read-only projection of provider config/state (e.g.
 *    reading VIBE_HOME/config.toml); NOT an invokable command.
 */
export type AdminSurfaceKind = "cli-subcommand" | "cli-flag" | "config-projection";

/**
 * How the gateway discovers the provider's model catalog:
 *  - `native-command`: the CLI has a read-only model listing command (argv set).
 *  - `config-inspection`: models come from a provider config file.
 *  - `env-inspection`: models come from provider environment variables.
 *  - `static-catalog`: the CLI owns selection internally; the gateway keeps a
 *    curated alias/id catalog as an accurate fallback.
 */
export type ModelDiscoveryStrategy =
  "native-command" | "config-inspection" | "env-inspection" | "static-catalog";

/** What scope of new work a provider definition is subject to. */
export type CapabilityScope = "full" | "maintain-only";

/** A safe, read-only probe expressed as an argv array (never a shell string). */
export interface ProviderProbe {
  /** Full argument vector. No shell metacharacters are ever interpolated. */
  readonly argv: readonly string[];
  /** What surface this probe yields. */
  readonly purpose: "version" | "root-help" | "subcommand-help" | "model-catalog";
  /** Executable override; defaults to the provider's primary executable. */
  readonly executable?: string;
}

/**
 * How the native model-listing stdout (when a command exists) is parsed into a
 * catalog. A CLOSED union: the model-discovery module dispatches on it with an
 * exhaustive `assertNever` switch, so adding a provider whose native output needs
 * a new dialect fails the build until a parser is written.
 *  - `codex-debug-json`: `codex debug models` JSON (`{models:[{slug,...}]}`).
 *  - `grok-models-text`: `grok models` text (`Default model: X` + `* id (default)`).
 *  - `agy-models-text`: `agy models` text (one account model label per line).
 *  - `config-or-env`: no native listing; models come from config/env (mistral, devin).
 *  - `curated-catalog`: the CLI owns selection; the gateway keeps a curated
 *    alias/id catalog as an accurate fallback (claude, cursor).
 */
export type ModelCatalogParseFormat =
  "codex-debug-json" | "grok-models-text" | "agy-models-text" | "config-or-env" | "curated-catalog";

/**
 * What the gateway relies on when no live catalog command is available.
 *  - `live-catalog-primary`: the native command is the authoritative live catalog.
 *  - `config-active-model`: env/config active model is the source of truth (mistral).
 *  - `cli-owned-surface-only`: the CLI owns selection; surface `--model` controls,
 *    never a hardcoded account-specific list (devin).
 *  - `curated-static-catalog`: curated aliases/ids/effort/fallback chains (claude, cursor).
 */
export type ModelFallbackPolicy =
  | "live-catalog-primary"
  | "config-active-model"
  | "cli-owned-surface-only"
  | "curated-static-catalog";

/**
 * A read-only config/env source of model facts. Documentation + inspection order
 * only; it names env vars / config fields, never a secret value.
 */
export interface ProviderModelConfigSource {
  readonly kind: "env" | "config-file";
  /** env var names (kind `env`) or inspected config fields (kind `config-file`). */
  readonly keys: readonly string[];
  /** home-relative config path for kind `config-file`; omitted for `env`. */
  readonly path?: string;
  readonly note: string;
}

/**
 * Structured, evidence-grounded model facts a provider exposes. Every value
 * traces to installed `--help`/`--version` or a docs URL in `docs.primary`.
 */
export interface ProviderModelFacts {
  /** Effort/reasoning levels the CLI accepts (empty when none are exposed). */
  readonly effortLevels: readonly string[];
  /** True when the CLI accepts an automatic fallback-model chain. */
  readonly supportsFallbackModelChain: boolean;
  /** Model aliases the CLI documents in help (alias -> latest of a family). */
  readonly aliases: readonly string[];
  /** Agent/permission profiles that stand in for model selection (vibe --agent). */
  readonly agentProfiles: readonly string[];
}

/** Model-discovery strategy plus its (safe, read-only) command evidence. */
export interface ProviderModelDiscovery {
  readonly strategy: ModelDiscoveryStrategy;
  /** argv for `native-command`; empty for other strategies. */
  readonly argv: readonly string[];
  /** Parse dialect for native-command stdout (or the no-native placeholder). */
  readonly parse: ModelCatalogParseFormat;
  /** What the gateway falls back to when there is no live catalog. */
  readonly fallbackPolicy: ModelFallbackPolicy;
  /** Read-only config/env sources of model facts (names only, never values). */
  readonly configSources: readonly ProviderModelConfigSource[];
  /** Structured, evidence-grounded model facts (effort, aliases, profiles). */
  readonly facts: ProviderModelFacts;
  /** Grounding evidence (docs/help). Contains no secrets. */
  readonly evidence: string;
}

/** Session continuity/discovery flags a provider CLI accepts. */
export interface ProviderSessionContinuity {
  readonly continue: boolean;
  readonly resume: boolean;
  readonly fork: boolean;
  readonly sessionIdSelection: boolean;
  /** Continuity flag tokens (documentation/evidence, not an argv allowlist). */
  readonly flags: readonly string[];
  readonly evidence: string;
}

/** The provider's discovery strategy: how the gateway learns what it can do. */
export interface ProviderDiscovery {
  readonly version: ProviderProbe;
  readonly rootHelp: ProviderProbe;
  readonly subcommandHelp: readonly ProviderProbe[];
  readonly modelDiscovery: ProviderModelDiscovery;
  readonly sessionContinuity: ProviderSessionContinuity;
}

/** A declared provider admin family with a safety class and surface kind. */
export interface ProviderAdminFamily {
  /** Family key (e.g. "mcp", "auth", "plugin", "doctor"). */
  readonly family: string;
  readonly safety: AdminSafetyClass;
  /**
   * How the family is reached. Optional; when omitted it defaults to
   * `"cli-subcommand"` (the common case, a real invokable subcommand). It is set
   * explicitly only where the surface is NOT an invokable subcommand, so the
   * registry never claims a subcommand the installed help does not advertise.
   */
  readonly kind?: AdminSurfaceKind;
  /** Grounding note from installed help / the plan's `must_cover_admin_subcommands`. */
  readonly evidence: string;
}

/** The surface kind of an admin family, defaulting to `cli-subcommand`. */
export function adminSurfaceKind(family: ProviderAdminFamily): AdminSurfaceKind {
  return family.kind ?? "cli-subcommand";
}

/** A provider ACP entrypoint expressed as executable + argv, or null. */
export interface ProviderAcpEntrypoint {
  readonly command: string;
  readonly args: readonly string[];
}

/** A selectable native ACP agent variant (e.g. Devin `--agent-type review`). */
export interface ProviderAcpAgentType {
  readonly id: string;
  readonly description: string;
}

/**
 * Devin's native ACP agent-type values (`devin acp --agent-type <type>`). Single
 * source of truth for both the request-schema enum and the provider-acp
 * capability projection.
 */
export const DEVIN_ACP_AGENT_TYPES = ["summarizer", "review"] as const;
export type DevinAcpAgentType = (typeof DEVIN_ACP_AGENT_TYPES)[number];

/** Native ACP metadata for a provider. */
export interface ProviderAcpMetadata {
  readonly classification: AcpClassification;
  /** Human label of the native entrypoint (e.g. "grok agent stdio"), or null. */
  readonly nativeEntrypoint: string | null;
  /** Native entrypoint executable + argv, or null when classification is none. */
  readonly entrypoint: ProviderAcpEntrypoint | null;
  /**
   * Safe, non-live probe argv variants that confirm the entrypoint exists
   * WITHOUT starting the live ACP server. Distinct from `entrypoint.args` by
   * construction (each ends in `--help`/`--version`). Empty for `none`.
   */
  readonly probeArgv: readonly (readonly string[])[];
  /**
   * Selectable native ACP agent variants advertised by the entrypoint (Devin
   * `--agent-type`). Omitted/empty for providers with a single default agent.
   */
  readonly agentTypes?: readonly ProviderAcpAgentType[];
  /** Evidence / caveat carried into capability reports (no secrets). */
  readonly evidence: string;
}

/** Safety controls the provider request surface accepts. */
export interface ProviderSafetyModes {
  readonly sandbox: boolean;
  readonly permissionMode: boolean;
  readonly approvalMode: boolean;
  readonly trust: boolean;
  /** Safety flag tokens (evidence, not an argv allowlist). */
  readonly flags: readonly string[];
}

/** Whether a provider exposes models:// and sessions:// resources. */
export interface ProviderResourcePolicy {
  readonly exposesModelsResource: boolean;
  readonly exposesSessionsResource: boolean;
}

/** Linkage to the upstream contract / help checksum baseline (phase-0). */
export interface ProviderUpstreamLinkage {
  /** Installed target version this definition was captured against. */
  readonly targetVersion: string;
  /**
   * Help-fixture filename referenced by the phase-0 checksum baseline
   * (`help/checksums.txt`). `null` for maintain-only providers with no captured
   * fixture yet (cursor).
   */
  readonly helpChecksumRef: string | null;
}

/** The request-tool surface a provider produces. */
export interface ProviderRequestSurface {
  readonly sync: boolean;
  readonly async: boolean;
  readonly transport: RequestTransport;
  /** Whether the provider can also be routed over native ACP. */
  readonly acpCapable: boolean;
  /** Sync request tool name (snake_case), e.g. "claude_request". */
  readonly syncToolName: string;
  /** Async request tool name (snake_case), e.g. "claude_request_async". */
  readonly asyncToolName: string;
}

/**
 * The single per-provider source of truth. Every field group here must carry
 * enough to drive request schemas, resources, model/session discovery,
 * capabilities, admin surfaces, upstream contracts, native ACP routing, and
 * docs in later phases.
 */
export interface ProviderDefinition {
  readonly id: ProviderId;
  /** Canonical human-facing name (plan `[providers.*].display_name`). */
  readonly displayName: string;
  /** Short session label, e.g. "Claude Session" (owned here, used by sessions). */
  readonly sessionLabel: string;
  /**
   * Emoji icon prefixed to this provider's resource titles (sessions:// and
   * models://). One icon per provider, used for BOTH resource types, so the
   * title surface stays consistent (no per-resource-type divergence).
   */
  readonly icon: string;
  /** Every executable the provider ships (first is the primary). */
  readonly executables: readonly string[];
  /** Convenience: `executables[0]`. */
  readonly primaryExecutable: string;
  readonly requestSurface: ProviderRequestSurface;
  readonly docs: { readonly primary: readonly string[] };
  readonly discovery: ProviderDiscovery;
  readonly adminSubcommands: readonly ProviderAdminFamily[];
  readonly acp: ProviderAcpMetadata;
  readonly safetyModes: ProviderSafetyModes;
  readonly outputFormats: readonly string[];
  readonly streamingFormats: readonly string[];
  readonly resourcePolicy: ProviderResourcePolicy;
  readonly upstreamContract: ProviderUpstreamLinkage;
  /** `maintain-only` = out of scope for NEW capability (cursor), kept complete. */
  readonly capabilityScope: CapabilityScope;
}

// ---------------------------------------------------------------------------
// The registry. `satisfies Record<CliType, ProviderDefinition>` is the primary
// compile-time invariant: adding a member to CLI_TYPES without a definition, or
// a definition missing a required field, fails `npm run build`.
// ---------------------------------------------------------------------------

const PROVIDER_DEFINITIONS = {
  claude: {
    id: "claude",
    displayName: "Anthropic Claude Code",
    sessionLabel: "Claude Session",
    icon: "🤖",
    executables: ["claude"],
    primaryExecutable: "claude",
    requestSurface: {
      sync: true,
      async: true,
      transport: "cli",
      acpCapable: false,
      syncToolName: "claude_request",
      asyncToolName: "claude_request_async",
    },
    docs: { primary: ["https://code.claude.com/docs/en/cli-reference"] },
    discovery: {
      version: { argv: ["--version"], purpose: "version" },
      rootHelp: { argv: ["--help"], purpose: "root-help" },
      subcommandHelp: [
        { argv: ["mcp", "--help"], purpose: "subcommand-help" },
        { argv: ["plugin", "--help"], purpose: "subcommand-help" },
        { argv: ["doctor", "--help"], purpose: "subcommand-help" },
      ],
      modelDiscovery: {
        strategy: "static-catalog",
        argv: [],
        parse: "curated-catalog",
        fallbackPolicy: "curated-static-catalog",
        configSources: [
          {
            kind: "env",
            keys: ["CLAUDE_DEFAULT_MODEL", "CLAUDE_MODELS", "CLAUDE_MODEL_ALIASES"],
            note: "Gateway env overrides for the Claude default model, extra models, and aliases.",
          },
          {
            kind: "config-file",
            path: ".claude/settings.json",
            keys: ["model", "model.name"],
            note: "Claude settings.json / settings.local.json default model.",
          },
        ],
        facts: {
          // claude --help: `--effort <level>` enumerates (low, medium, high, xhigh, max).
          effortLevels: ["low", "medium", "high", "xhigh", "max"],
          // claude --help: `--fallback-model <model>` accepts a comma-separated chain.
          supportsFallbackModelChain: true,
          // claude --help: aliases 'fable', 'opus', 'sonnet' (plus full ids like 'claude-fable-5').
          aliases: ["fable", "opus", "sonnet"],
          agentProfiles: [],
        },
        evidence:
          "Claude Code has no read-only model-listing command; aliases ('fable'/'opus'/'sonnet') and full ids ('claude-fable-5'), --effort levels (low/medium/high/xhigh/max), and --fallback-model comma-separated chains come from claude --help and the CLI reference, curated as an accurate catalog.",
      },
      sessionContinuity: {
        continue: true,
        resume: true,
        fork: true,
        sessionIdSelection: true,
        flags: ["--continue", "--session-id", "--resume", "--fork-session"],
        evidence: "claude --help: --continue, --session-id, --resume, --fork-session.",
      },
    },
    adminSubcommands: [
      { family: "auth", safety: "mutating-gated", evidence: "claude auth login/logout/status" },
      { family: "agents", safety: "mutating-gated", evidence: "claude agents" },
      {
        family: "mcp",
        safety: "mutating-gated",
        evidence: "claude mcp add/list/get/remove/login/logout/enable/disable",
      },
      { family: "plugin", safety: "mutating-gated", evidence: "claude plugin and plugins" },
      { family: "project", safety: "mutating-gated", evidence: "claude project purge" },
      { family: "doctor", safety: "read-only", evidence: "claude doctor" },
      { family: "update", safety: "mutating-gated", evidence: "claude update/upgrade" },
      { family: "install", safety: "mutating-gated", evidence: "claude install" },
      { family: "setup-token", safety: "mutating-gated", evidence: "claude setup-token" },
      { family: "ultrareview", safety: "read-only", evidence: "claude ultrareview" },
    ],
    acp: {
      classification: "none",
      nativeEntrypoint: null,
      entrypoint: null,
      probeArgv: [],
      evidence:
        "No native Claude Code ACP subcommand or flag in installed help (claude 2.1.198) or the official CLI reference. Coverage is CLI-first; ACP reporting says no native entrypoint is advertised.",
    },
    safetyModes: {
      sandbox: false,
      permissionMode: true,
      approvalMode: false,
      trust: false,
      flags: ["--permission-mode", "--dangerously-skip-permissions"],
    },
    outputFormats: ["text", "json", "stream-json"],
    streamingFormats: ["stream-json"],
    resourcePolicy: { exposesModelsResource: true, exposesSessionsResource: true },
    upstreamContract: { targetVersion: "Claude Code 2.1.198", helpChecksumRef: "claude--help.txt" },
    capabilityScope: "full",
  },
  codex: {
    id: "codex",
    displayName: "OpenAI Codex CLI",
    sessionLabel: "Codex Session",
    icon: "💻",
    executables: ["codex"],
    primaryExecutable: "codex",
    requestSurface: {
      sync: true,
      async: true,
      transport: "cli",
      acpCapable: false,
      syncToolName: "codex_request",
      asyncToolName: "codex_request_async",
    },
    docs: {
      primary: [
        "https://developers.openai.com/codex/cli",
        "https://developers.openai.com/codex/cli/reference",
      ],
    },
    discovery: {
      version: { argv: ["--version"], purpose: "version" },
      rootHelp: { argv: ["--help"], purpose: "root-help" },
      subcommandHelp: [
        { argv: ["exec", "--help"], purpose: "subcommand-help" },
        { argv: ["exec", "resume", "--help"], purpose: "subcommand-help" },
        { argv: ["mcp", "--help"], purpose: "subcommand-help" },
        { argv: ["doctor", "--help"], purpose: "subcommand-help" },
      ],
      modelDiscovery: {
        strategy: "native-command",
        argv: ["debug", "models"],
        parse: "codex-debug-json",
        fallbackPolicy: "live-catalog-primary",
        configSources: [
          {
            kind: "config-file",
            path: ".codex/config.toml",
            keys: ["model", "profiles.*.model", "notice.model_migrations"],
            note: "Codex config default model, profile model overrides, and migration targets.",
          },
          {
            kind: "env",
            keys: ["CODEX_DEFAULT_MODEL", "CODEX_MODELS"],
            note: "Gateway env overrides for the Codex default model and extra models.",
          },
        ],
        facts: {
          // codex debug models JSON supported_reasoning_levels: low/medium/high/xhigh.
          effortLevels: ["low", "medium", "high", "xhigh"],
          supportsFallbackModelChain: false,
          aliases: [],
          agentProfiles: [],
        },
        evidence:
          "codex debug models renders the raw model catalog as JSON ({models:[{slug,display_name,visibility,supported_in_api,supported_reasoning_levels}]}); visibility list vs hide distinguishes the live catalog, and the model-registry bundled fallback stays the offline/bundled catalog.",
      },
      sessionContinuity: {
        continue: false,
        resume: true,
        fork: true,
        sessionIdSelection: true,
        flags: ["exec resume", "exec resume --last", "fork", "--all"],
        evidence:
          "codex exec resume <UUID>/--last and codex fork; resume requires a real Codex UUID from ~/.codex/sessions/ (gw-* ids are rejected).",
      },
    },
    adminSubcommands: [
      { family: "login", safety: "mutating-gated", evidence: "codex login/logout/status" },
      {
        family: "mcp",
        safety: "mutating-gated",
        evidence: "codex mcp list/get/add/remove/login/logout",
      },
      {
        family: "plugin",
        safety: "mutating-gated",
        evidence: "codex plugin list/add/remove and marketplace",
      },
      { family: "doctor", safety: "read-only", evidence: "codex doctor" },
      { family: "features", safety: "mutating-gated", evidence: "codex features" },
      { family: "sandbox", safety: "mutating-gated", evidence: "codex sandbox" },
      { family: "debug", safety: "read-only", evidence: "codex debug models" },
      { family: "cloud", safety: "mutating-gated", evidence: "codex cloud list/exec" },
      { family: "apply", safety: "mutating-gated", evidence: "codex apply" },
      {
        family: "session",
        safety: "mutating-gated",
        evidence: "codex resume/fork/archive/delete/unarchive",
      },
      { family: "completion", safety: "read-only", evidence: "codex completion" },
      { family: "update", safety: "mutating-gated", evidence: "codex update" },
      {
        family: "app-server",
        safety: "mutating-gated",
        evidence: "codex app-server / mcp-server (Codex transports, not native ACP)",
      },
    ],
    acp: {
      classification: "none",
      nativeEntrypoint: null,
      entrypoint: null,
      probeArgv: [],
      evidence:
        "codex-cli 0.142.4 advertises mcp-server and app-server transports, not a native ACP agent entrypoint. Third-party adapters exist but are documentation only and are never treated as native gateway ACP.",
    },
    safetyModes: {
      sandbox: true,
      permissionMode: false,
      approvalMode: true,
      trust: true,
      flags: [
        "--sandbox",
        "--ask-for-approval",
        "--dangerously-bypass-approvals-and-sandbox",
        "--dangerously-bypass-hook-trust",
      ],
    },
    outputFormats: ["text", "json"],
    streamingFormats: ["jsonl"],
    resourcePolicy: { exposesModelsResource: true, exposesSessionsResource: true },
    upstreamContract: {
      targetVersion: "codex-cli 0.142.4",
      helpChecksumRef: "codex-exec--help.txt",
    },
    capabilityScope: "full",
  },
  gemini: {
    id: "gemini",
    displayName: "Google Antigravity CLI",
    sessionLabel: "Gemini Session",
    icon: "✨",
    executables: ["agy"],
    primaryExecutable: "agy",
    requestSurface: {
      sync: true,
      async: true,
      transport: "cli",
      acpCapable: false,
      syncToolName: "gemini_request",
      asyncToolName: "gemini_request_async",
    },
    docs: {
      primary: [
        "https://antigravity.google/docs/cli-overview",
        "https://antigravity.google/docs/cli-using",
        "https://antigravity.google/docs/cli/plugins",
        "https://antigravity.google/docs/cli-features",
      ],
    },
    discovery: {
      version: { argv: ["--version"], purpose: "version" },
      rootHelp: { argv: ["--help"], purpose: "root-help" },
      subcommandHelp: [
        { argv: ["models", "--help"], purpose: "subcommand-help" },
        { argv: ["plugin", "--help"], purpose: "subcommand-help" },
      ],
      modelDiscovery: {
        strategy: "native-command",
        argv: ["models"],
        parse: "agy-models-text",
        fallbackPolicy: "live-catalog-primary",
        configSources: [
          {
            kind: "config-file",
            path: ".gemini/settings.json",
            keys: ["model", "model.name", "selectedModel", "defaultModel"],
            note: "Antigravity settings.json default/selected model.",
          },
          {
            kind: "env",
            keys: ["GEMINI_DEFAULT_MODEL", "GEMINI_MODELS"],
            note: "Gateway env overrides for the Gemini default model and extra models.",
          },
        ],
        facts: {
          effortLevels: [],
          supportsFallbackModelChain: false,
          aliases: ["flash", "pro"],
          agentProfiles: [],
        },
        evidence:
          "agy models is the primary account-aware model discovery command (agy --help lists it); it prints one account model label per line (e.g. 'Gemini 3.5 Flash (Medium)').",
      },
      sessionContinuity: {
        continue: true,
        resume: true,
        fork: false,
        sessionIdSelection: true,
        flags: ["--continue", "--conversation", "--project"],
        evidence:
          "agy --help: --continue (most recent), --conversation <ID> (resume), --project/--new-project continuity.",
      },
    },
    adminSubcommands: [
      { family: "models", safety: "read-only", evidence: "agy models" },
      {
        family: "plugin",
        safety: "mutating-gated",
        evidence: "agy plugin list/install/uninstall/enable/disable; plugins alias",
      },
      { family: "changelog", safety: "read-only", evidence: "agy changelog" },
      { family: "install", safety: "mutating-gated", evidence: "agy install" },
      { family: "update", safety: "mutating-gated", evidence: "agy update" },
    ],
    acp: {
      classification: "none",
      nativeEntrypoint: null,
      entrypoint: null,
      probeArgv: [],
      evidence:
        "agy 1.0.14 has no ACP flag or subcommand in installed help or the Antigravity CLI docs. Legacy Gemini CLI ACP evidence does not transfer. No native entrypoint advertised.",
    },
    safetyModes: {
      sandbox: true,
      permissionMode: false,
      approvalMode: true,
      trust: false,
      flags: ["--sandbox", "--dangerously-skip-permissions"],
    },
    outputFormats: ["text"],
    streamingFormats: [],
    resourcePolicy: { exposesModelsResource: true, exposesSessionsResource: true },
    upstreamContract: { targetVersion: "agy 1.0.14", helpChecksumRef: "agy--help.txt" },
    capabilityScope: "full",
  },
  grok: {
    id: "grok",
    displayName: "xAI Grok Build",
    sessionLabel: "Grok Session",
    icon: "⚡",
    executables: ["grok"],
    primaryExecutable: "grok",
    requestSurface: {
      sync: true,
      async: true,
      transport: "cli",
      acpCapable: true,
      syncToolName: "grok_request",
      asyncToolName: "grok_request_async",
    },
    docs: {
      primary: [
        "https://docs.x.ai/build/overview",
        "https://x.ai/build/changelog",
        "https://docs.x.ai/developers/models",
      ],
    },
    discovery: {
      version: { argv: ["--version"], purpose: "version" },
      rootHelp: { argv: ["--help"], purpose: "root-help" },
      subcommandHelp: [
        { argv: ["agent", "--help"], purpose: "subcommand-help" },
        { argv: ["mcp", "--help"], purpose: "subcommand-help" },
        { argv: ["sessions", "--help"], purpose: "subcommand-help" },
      ],
      modelDiscovery: {
        strategy: "native-command",
        argv: ["models"],
        parse: "grok-models-text",
        fallbackPolicy: "live-catalog-primary",
        configSources: [
          {
            kind: "config-file",
            path: ".grok/config.toml",
            keys: ["models.default", "models", "ui.fork_secondary_model"],
            note: "Grok config.toml configured default ([models].default) and custom model facts.",
          },
          {
            kind: "env",
            keys: ["GROK_DEFAULT_MODEL", "GROK_MODELS"],
            note: "Gateway env overrides for the Grok default model and extra models.",
          },
        ],
        facts: {
          // grok --help: `--effort <LEVEL>` [possible values: low, medium, high, xhigh, max].
          effortLevels: ["low", "medium", "high", "xhigh", "max"],
          supportsFallbackModelChain: false,
          aliases: [],
          agentProfiles: [],
        },
        evidence:
          "grok models lists the CLI-local catalog ('Default model: X' then '* id (default)'/'- id' lines); ~/.grok/config.toml [models].default and custom model facts are additional. Native Grok Build API models are catalogued separately.",
      },
      sessionContinuity: {
        continue: true,
        resume: true,
        fork: true,
        sessionIdSelection: true,
        flags: ["--continue", "--resume", "--fork-session", "--session-id"],
        evidence: "grok --help: --resume/--continue/--fork-session/--session-id.",
      },
    },
    adminSubcommands: [
      { family: "models", safety: "read-only", evidence: "grok models" },
      { family: "inspect", safety: "read-only", evidence: "grok inspect" },
      { family: "mcp", safety: "mutating-gated", evidence: "grok mcp" },
      { family: "plugin", safety: "mutating-gated", evidence: "grok plugin" },
      {
        family: "sessions",
        safety: "mutating-gated",
        evidence: "grok sessions; grok export/import",
      },
      { family: "worktree", safety: "mutating-gated", evidence: "grok worktree" },
      { family: "dashboard", safety: "mutating-gated", evidence: "grok dashboard" },
      { family: "leader", safety: "mutating-gated", evidence: "grok leader" },
      { family: "memory", safety: "mutating-gated", evidence: "grok memory" },
      { family: "trace", safety: "read-only", evidence: "grok trace" },
      { family: "setup", safety: "mutating-gated", evidence: "grok setup" },
      { family: "auth", safety: "mutating-gated", evidence: "grok login/logout" },
      { family: "update", safety: "mutating-gated", evidence: "grok update" },
    ],
    acp: {
      classification: "native",
      nativeEntrypoint: "grok agent stdio",
      entrypoint: { command: "grok", args: ["agent", "stdio"] },
      probeArgv: [["agent", "stdio", "--help"]],
      evidence:
        "Official xAI docs: Grok Build runs via TUI, headless scripts, or ACP in other apps. Installed help advertises `grok agent stdio`. `grok agent stdio --help` is the safe probe; bare `grok agent stdio` starts the live server and is never probed.",
    },
    safetyModes: {
      sandbox: true,
      permissionMode: true,
      approvalMode: true,
      trust: false,
      flags: ["--sandbox", "--permission-mode", "--always-approve", "--allow", "--deny"],
    },
    outputFormats: ["text", "json"],
    streamingFormats: ["json"],
    resourcePolicy: { exposesModelsResource: true, exposesSessionsResource: true },
    upstreamContract: {
      targetVersion: "grok 0.2.77 (44e77bec3a)",
      helpChecksumRef: "grok--help.txt",
    },
    capabilityScope: "full",
  },
  mistral: {
    id: "mistral",
    displayName: "Mistral Vibe",
    sessionLabel: "Mistral Session",
    icon: "🌬",
    executables: ["vibe", "vibe-acp"],
    primaryExecutable: "vibe",
    requestSurface: {
      sync: true,
      async: true,
      transport: "cli",
      acpCapable: true,
      syncToolName: "mistral_request",
      asyncToolName: "mistral_request_async",
    },
    docs: { primary: ["https://github.com/mistralai/mistral-vibe"] },
    discovery: {
      version: { argv: ["--version"], purpose: "version" },
      rootHelp: { argv: ["--help"], purpose: "root-help" },
      subcommandHelp: [{ argv: ["--help"], purpose: "subcommand-help", executable: "vibe-acp" }],
      modelDiscovery: {
        strategy: "config-inspection",
        argv: [],
        parse: "config-or-env",
        fallbackPolicy: "config-active-model",
        configSources: [
          {
            kind: "env",
            keys: ["VIBE_ACTIVE_MODEL", "MISTRAL_DEFAULT_MODEL", "VIBE_MODELS"],
            note: "Vibe active model via env; there is NO --model flag (VIBE_* overrides config).",
          },
          {
            kind: "config-file",
            path: ".vibe/config.toml",
            keys: ["active_model", "default_agent", "models"],
            note: "Vibe config.toml active_model, default_agent, and custom models.",
          },
        ],
        facts: {
          effortLevels: [],
          supportsFallbackModelChain: false,
          aliases: [],
          // vibe --help: --agent NAME (builtin: default, plan, accept-edits, auto-approve,
          // or custom from ~/.vibe/agents/NAME.toml).
          agentProfiles: ["default", "plan", "accept-edits", "auto-approve", "custom"],
        },
        evidence:
          "Vibe has NO --model flag; the active model is selected via VIBE_ACTIVE_MODEL and config.toml active_model. default_agent plus --agent profiles (default, plan, accept-edits, auto-approve, or custom from ~/.vibe/agents/NAME.toml) are the vibe --help agent-profile facts.",
      },
      sessionContinuity: {
        continue: true,
        resume: true,
        fork: false,
        sessionIdSelection: true,
        flags: ["--continue", "--resume"],
        evidence: "vibe --help: --continue/--resume.",
      },
    },
    adminSubcommands: [
      // The ONLY real vibe CLI admin surface is two top-level FLAGS (vibe --help
      // advertises no subcommands). --setup writes an API key; --check-upgrade
      // "Check for a Vibe update now, prompt to install it, and exit" mutates.
      {
        family: "setup",
        safety: "mutating-gated",
        kind: "cli-flag",
        evidence: "vibe --help: --setup (Setup API key and exit).",
      },
      {
        family: "check-upgrade",
        safety: "mutating-gated",
        kind: "cli-flag",
        evidence:
          "vibe --help: --check-upgrade (Check for a Vibe update now, prompt to install it, and exit); mutating.",
      },
      // The following are READ-ONLY config projections (reading VIBE_HOME state),
      // NOT invokable `vibe <cmd>` subcommands. vibe --help advertises no such
      // subcommands, so representing them as commands would be invented.
      {
        family: "config",
        safety: "read-only",
        kind: "config-projection",
        evidence: "Projection of VIBE_HOME/config.toml (vibe --help env: VIBE_HOME, VIBE_*).",
      },
      {
        family: "mcp",
        safety: "read-only",
        kind: "config-projection",
        evidence: "Projection of MCP server config from VIBE_HOME config; no vibe mcp subcommand.",
      },
      {
        family: "skills",
        safety: "read-only",
        kind: "config-projection",
        evidence: "Projection of discovered skills from VIBE_HOME; no vibe skills subcommand.",
      },
      {
        family: "agents",
        safety: "read-only",
        kind: "config-projection",
        evidence:
          "Projection of agent profiles (~/.vibe/agents/*.toml, per --agent help); no vibe agents subcommand.",
      },
    ],
    acp: {
      classification: "native",
      nativeEntrypoint: "vibe-acp",
      entrypoint: { command: "vibe-acp", args: [] },
      probeArgv: [["--version"], ["--help"]],
      evidence:
        "Mistral Vibe README: ACP-capable editors/IDEs can use Vibe. Installed `vibe-acp --help` advertises ACP mode. Probes are `vibe-acp --version`/`--help`; bare `vibe-acp` starts the live server and is never probed.",
    },
    safetyModes: {
      sandbox: false,
      permissionMode: false,
      approvalMode: true,
      trust: true,
      flags: ["--auto-approve", "--yolo", "--trust"],
    },
    outputFormats: ["text", "json"],
    streamingFormats: [],
    resourcePolicy: { exposesModelsResource: true, exposesSessionsResource: true },
    upstreamContract: { targetVersion: "vibe 2.18.3", helpChecksumRef: "vibe--help.txt" },
    capabilityScope: "full",
  },
  devin: {
    id: "devin",
    displayName: "Cognition Devin CLI",
    sessionLabel: "Devin Session",
    icon: "🔷",
    executables: ["devin"],
    primaryExecutable: "devin",
    requestSurface: {
      sync: true,
      async: true,
      transport: "cli",
      acpCapable: true,
      syncToolName: "devin_request",
      asyncToolName: "devin_request_async",
    },
    docs: { primary: ["https://docs.devin.ai/cli/reference/commands"] },
    discovery: {
      version: { argv: ["--version"], purpose: "version" },
      rootHelp: { argv: ["--help"], purpose: "root-help" },
      subcommandHelp: [
        { argv: ["acp", "--help"], purpose: "subcommand-help" },
        { argv: ["mcp", "--help"], purpose: "subcommand-help" },
      ],
      modelDiscovery: {
        strategy: "config-inspection",
        argv: [],
        parse: "config-or-env",
        fallbackPolicy: "cli-owned-surface-only",
        configSources: [
          {
            kind: "env",
            keys: ["DEVIN_MODEL"],
            note: "devin --help: --model <MODEL> reads [env: DEVIN_MODEL]. Account decides availability.",
          },
        ],
        facts: {
          effortLevels: [],
          supportsFallbackModelChain: false,
          // devin --help --model examples ('opus', 'codex'); documented convenience aliases only.
          aliases: ["opus", "codex"],
          agentProfiles: [],
        },
        evidence:
          "Devin exposes --model <MODEL> (e.g. 'claude-sonnet-4', 'claude-opus-4.6', 'opus', 'codex'; [env: DEVIN_MODEL]); the CLI owns model selection and the account decides available models, so no static account-specific list is hardcoded.",
      },
      sessionContinuity: {
        continue: true,
        resume: true,
        fork: false,
        sessionIdSelection: true,
        flags: ["--continue", "--resume"],
        evidence: "devin --help / docs: --continue and --resume <id>.",
      },
    },
    adminSubcommands: [
      { family: "auth", safety: "mutating-gated", evidence: "devin auth login/logout/status" },
      {
        family: "mcp",
        safety: "mutating-gated",
        evidence: "devin mcp add/list/get/remove/login/logout/enable/disable",
      },
      { family: "rules", safety: "read-only", evidence: "devin rules list/show/paths" },
      { family: "skills", safety: "read-only", evidence: "devin skills list/show/paths" },
      {
        family: "plugins",
        safety: "mutating-gated",
        evidence: "devin plugins install/list/info/update/remove",
      },
      {
        family: "cloud",
        safety: "mutating-gated",
        evidence: "devin cloud environment/sandbox/build",
      },
      { family: "list", safety: "read-only", evidence: "devin list/ls (JSON and CSV)" },
      { family: "update", safety: "mutating-gated", evidence: "devin update" },
      { family: "version", safety: "read-only", evidence: "devin version" },
      { family: "sandbox", safety: "mutating-gated", evidence: "devin sandbox setup" },
      { family: "setup", safety: "mutating-gated", evidence: "devin setup; devin shell setup" },
    ],
    acp: {
      classification: "native",
      nativeEntrypoint: "devin acp",
      entrypoint: { command: "devin", args: ["acp"] },
      probeArgv: [["acp", "--help"]],
      agentTypes: [
        {
          id: "summarizer",
          description:
            "Summarizer agent with no tools; outputs the full summary as text (persisted by a PostAgentIteration cog).",
        },
        {
          id: "review",
          description:
            "Code-review agent with read-only + shell tools; reviews diffs for correctness, style, security, performance, and completeness.",
        },
      ],
      evidence:
        "Official Devin docs advertise `devin acp` as an ACP stdio server; installed `devin acp --help` confirms it with --agent-type summarizer/review options. `devin acp --help` is the safe probe; bare `devin acp` starts the live server and is never probed.",
    },
    safetyModes: {
      sandbox: true,
      permissionMode: true,
      approvalMode: false,
      trust: true,
      flags: ["--sandbox", "--permission-mode", "--respect-workspace-trust"],
    },
    outputFormats: ["text", "json"],
    streamingFormats: [],
    resourcePolicy: { exposesModelsResource: true, exposesSessionsResource: true },
    upstreamContract: {
      targetVersion: "devin 2026.8.18 (16737566)",
      helpChecksumRef: "devin--help.txt",
    },
    capabilityScope: "full",
  },
  cursor: {
    id: "cursor",
    displayName: "Cursor Agent CLI",
    sessionLabel: "Cursor Session",
    icon: "🖱",
    executables: ["cursor-agent"],
    primaryExecutable: "cursor-agent",
    requestSurface: {
      sync: true,
      async: true,
      transport: "cli",
      acpCapable: true,
      syncToolName: "cursor_request",
      asyncToolName: "cursor_request_async",
    },
    docs: { primary: ["https://docs.cursor.com/en/cli/overview"] },
    discovery: {
      version: { argv: ["--version"], purpose: "version" },
      rootHelp: { argv: ["--help"], purpose: "root-help" },
      subcommandHelp: [{ argv: ["acp", "--help"], purpose: "subcommand-help" }],
      modelDiscovery: {
        strategy: "static-catalog",
        argv: [],
        parse: "curated-catalog",
        fallbackPolicy: "curated-static-catalog",
        configSources: [],
        facts: {
          effortLevels: [],
          supportsFallbackModelChain: false,
          aliases: [],
          agentProfiles: [],
        },
        evidence:
          "Cursor is maintain-only in this initiative; the CLI owns model selection and the gateway keeps a curated catalog. No new model-discovery capability is added here.",
      },
      sessionContinuity: {
        continue: true,
        resume: true,
        fork: false,
        sessionIdSelection: true,
        // Matches the grounded cursor contract (upstream-contracts.ts): both
        // --resume [chatId] and --continue are advertised in cursor-agent --help.
        flags: ["--resume", "--continue"],
        evidence:
          "cursor-agent --help: --resume [chatId] (Resume a specific Cursor chat/session) and --continue (Continue the latest Cursor chat).",
      },
    },
    adminSubcommands: [
      {
        family: "version",
        safety: "read-only",
        kind: "cli-flag",
        evidence: "cursor-agent --help: -v, --version (maintain-only).",
      },
    ],
    acp: {
      classification: "native",
      nativeEntrypoint: "cursor-agent acp",
      entrypoint: { command: "cursor-agent", args: ["acp"] },
      probeArgv: [["acp", "--help"]],
      evidence:
        "Native ACP entrypoint `cursor-agent acp` (stdio JSON-RPC). Captured `cursor-agent acp --help` (help/cursor-agent-acp--help.txt) confirms: 'Start the Cursor Agent as an ACP (Agent Client Protocol) server'. Maintain-only in this initiative; kept complete so shared generation covers cursor.",
    },
    // Grounded in cursor-agent --help (help/cursor-agent--help.txt) and the
    // existing cursor contract in upstream-contracts.ts: sandbox IS supported via
    // --sandbox enabled|disabled; there is NO --permission-mode. Execution mode
    // is --mode plan|ask; approval controls are --force/--yolo and --auto-review;
    // workspace trust is --trust.
    safetyModes: {
      sandbox: true,
      permissionMode: false,
      approvalMode: true,
      trust: true,
      flags: ["--mode", "--force", "--auto-review", "--sandbox", "--trust"],
    },
    outputFormats: ["text", "json", "stream-json"],
    streamingFormats: ["stream-json"],
    resourcePolicy: { exposesModelsResource: true, exposesSessionsResource: true },
    upstreamContract: {
      targetVersion: "cursor-agent 2026.06.29-2ad2186",
      helpChecksumRef: "cursor-agent--help.txt",
    },
    capabilityScope: "maintain-only",
  },
} satisfies Record<CliType, ProviderDefinition>;

/** The frozen registry, keyed by CliType. */
export const PROVIDER_DEFINITIONS_BY_ID: Readonly<Record<CliType, ProviderDefinition>> =
  Object.freeze(PROVIDER_DEFINITIONS);

/** Every provider definition, in CLI_TYPES order. */
export function getAllProviderDefinitions(): readonly ProviderDefinition[] {
  return CLI_TYPES.map(id => PROVIDER_DEFINITIONS_BY_ID[id]);
}

/** The provider definition for a CliType. */
export function getProviderDefinition(id: CliType): ProviderDefinition {
  return PROVIDER_DEFINITIONS_BY_ID[id];
}

/** All provider ids, in CLI_TYPES order. The registry's canonical provider list. */
export function listProviderIds(): readonly CliType[] {
  return CLI_TYPES;
}

/** Canonical display name for a provider. */
export function getProviderDisplayName(id: CliType): string {
  return PROVIDER_DEFINITIONS_BY_ID[id].displayName;
}

/** Short session label for a provider (e.g. "Claude Session"). */
export function getProviderSessionLabel(id: CliType): string {
  return PROVIDER_DEFINITIONS_BY_ID[id].sessionLabel;
}
