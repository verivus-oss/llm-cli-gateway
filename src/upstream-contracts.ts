import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
// Provider identity (CliType, and the CLI provider list this file keys its
// Record<CliType, ...> contracts by) comes from the provider definition
// registry, not a hand-maintained list here. See src/provider-definitions.ts.
import { getProviderDefinition, type CliType } from "./provider-definitions.js";
import { envWithExtendedPath, getExtendedPath, resolveCommandForSpawn } from "./executor.js";

/**
 * `optional` (slice κ): consumes the next token as the flag's value
 * ONLY if that token does not start with `-`. Used for Claude's
 * `-p`/`--print`, which is a no-arg switch in claude-code 2.x but
 * also doubles as the legacy `-p <prompt>` positional shorthand that
 * the gateway has emitted since v0.x.
 */
export type CliFlagArity = "none" | "one" | "optional" | "variadic";

export interface CliFlagContract {
  arity: CliFlagArity;
  values?: readonly string[];
  pattern?: RegExp;
  description: string;
  /**
   * The flag is real and accepted by the installed binary but deliberately
   * absent from its --help output, so the installed-binary probe must not
   * report it under `missingFlags`. If the flag later reappears in the help
   * text the probe emits a warning so the stale marker gets removed.
   */
  hiddenFromHelp?: boolean;
}

/**
 * Pure upstream-tracking metadata for a provider CLI.
 *
 * IMPORTANT — non-duplication invariant: nothing here encodes mechanical
 * behaviour. Flags, output modes, session/resume rules, permission modes,
 * forbidden flags, env contracts, and positional limits live ONLY in the
 * surrounding {@link CliContract} and are validated ONLY by
 * {@link validateUpstreamCliArgs} / {@link validateUpstreamCliEnv}. The fields
 * below are descriptive pointers used by the upstream changelog scanner
 * (`scripts/upstream-scan.mjs`) and surfaced in the contract report — they
 * never drive argv/env enforcement.
 *
 * `docs/upstream/provider-sources.dag.toml` mirrors `sourceUrls` and
 * `watchCategories` for the scanner's offline scan plan; a unit test
 * (`upstream-sources.test.ts`) asserts the TOML stays in sync with these
 * fields so the two cannot drift. The TypeScript values here are authoritative;
 * the TOML is scanner input only and is never consulted for contract
 * enforcement.
 */
export interface CliUpstreamMetadata {
  /** Canonical changelog / release-notes URLs the scanner retrieves with --live. */
  sourceUrls: readonly string[];
  /** Distribution package identifier (npm package name, PyPI project, …). */
  packageName?: string;
  /** Source repository URL, when distinct from the changelog source. */
  repo?: string;
  /** Human-facing install / getting-started docs. */
  installDocsUrl?: string;
  /** Distribution channel the gateway expects the CLI to ship through. */
  releaseChannel?: "npm" | "pypi" | "github-release" | "vendor";
  /**
   * Contract surfaces worth watching in upstream release notes (e.g. "flags",
   * "output-formats", "session-resume"). Descriptive labels for the scanner and
   * report ONLY — never a validation input.
   */
  watchCategories: readonly string[];
}

export interface CliContract {
  cli: CliType;
  executable: string;
  upstream: string;
  helpArgs: string[][];
  flags: Record<string, CliFlagContract>;
  subcommands?: Record<string, CliSubcommandContract>;
  env?: Record<string, CliFlagContract>;
  mcpTools: readonly string[];
  mcpParameters: readonly string[];
  conformanceFixtures: readonly CliContractFixture[];
  command?: {
    requiredFirstArg: string;
    optionalSecondArg?: string;
  };
  maxPositionals: number;
  resumeMaxPositionals?: number;
  resumeOnlyFlags?: readonly string[];
  resumeForbiddenFlags?: readonly string[];
  /**
   * Long flags the installed binary advertises in --help that the gateway
   * deliberately does NOT emit. These must NOT be added to `flags` — that
   * record is the argv allowlist enforced by {@link validateUpstreamCliArgs},
   * and declaring upstream-only flags there would loosen it. Listing them here
   * instead lets the installed-binary probe filter known surface out of
   * `extraFlags`, so a genuinely new upstream flag stands out as drift. Stale
   * entries (no longer in the help text) are reported as probe warnings.
   */
  acknowledgedUpstreamFlags?: readonly string[];
  /** Non-mechanical upstream-tracking metadata. See {@link CliUpstreamMetadata}. */
  upstreamMetadata?: CliUpstreamMetadata;
}

export interface CliContractFixture {
  id: string;
  description: string;
  args: readonly string[];
  env?: Record<string, string>;
  expect: "pass" | "fail";
}

export type CliSubcommandRisk =
  | "read_only"
  | "writes_local_config"
  | "auth"
  | "network"
  | "starts_server"
  | "updates_binary"
  | "destructive"
  | "executes_agent";

export type CliSubcommandExposure =
  "tracked_only" | "mcp_readonly" | "mcp_requires_approval" | "not_exposed";

export type CliSubcommandTier = "catalog" | "inspect" | "execute_candidate" | "diagnostic";

export type CliSubcommandTokenCost = "tiny" | "small" | "medium" | "large";

export interface CliSubcommandContract {
  commandPath: readonly string[];
  helpArgs: readonly string[][];
  flags: Record<string, CliFlagContract>;
  maxPositionals: number;
  acknowledgedUpstreamFlags?: readonly string[];
  aliases?: readonly string[];
  children?: Record<string, CliSubcommandContract>;
  risk: CliSubcommandRisk;
  exposure: CliSubcommandExposure;
  tier: CliSubcommandTier;
  tokenCost: CliSubcommandTokenCost;
  summary: string;
  conformanceFixtures: readonly CliContractFixture[];
  /**
   * The subcommand's `--help` probe legitimately exits non-zero on the
   * installed binary (e.g. it uses Go's `flag` package, which prints "Usage of
   * <cmd>:" to stderr and exits 2 for `--help`). When true, a non-zero exit
   * status from the help probe is NOT reported as a drift warning. A genuine
   * spawn failure (`result.error`) still marks the subcommand unavailable.
   */
  helpProbeExitTolerant?: boolean;
}

export interface ContractViolation {
  cli: CliType;
  arg?: string;
  index?: number;
  message: string;
}

export interface ContractValidationResult {
  ok: boolean;
  violations: ContractViolation[];
}

export interface SubcommandContractValidationResult extends ContractValidationResult {
  commandPath: readonly string[];
  risk?: CliSubcommandRisk;
  exposure?: CliSubcommandExposure;
  tier?: CliSubcommandTier;
}

export interface ProviderSubcommandCatalogRow {
  provider: CliType;
  commandPath: readonly string[];
  aliases: readonly string[];
  tier: CliSubcommandTier;
  risk: CliSubcommandRisk;
  exposure: CliSubcommandExposure;
  tokenCost: CliSubcommandTokenCost;
  summary: string;
  driftStatus: "unknown" | "clean" | "drift";
  resourceUri: string;
}

export interface ProviderSubcommandCompactCatalog {
  schemaVersion: "provider-subcommands-catalog.v1";
  columns: readonly [
    "provider",
    "commandPath",
    "aliases",
    "tier",
    "risk",
    "exposure",
    "tokenCost",
    "summary",
    "driftStatus",
    "resourceUri",
  ];
  rows: readonly (readonly string[])[];
}

// ---------------------------------------------------------------------------
// ACP (Agent Client Protocol) upstream entrypoint tracking.
//
// This is deliberately a SEPARATE surface from the request argv allowlists
// above (`UPSTREAM_CLI_CONTRACTS[*].flags` / `.subcommands`). ACP entrypoints
// are NOT request-tool commands; tracking them here must never widen what
// `validateUpstreamCliArgs` / `validateUpstreamCliSubcommandArgs` accept. The
// probes are read-only `--version` / `--help` checks only — never the live ACP
// process (`vibe-acp` with no args, `grok agent stdio`), which would start a
// server. Drift is reported under its own report key so ACP entrypoint changes
// are visible independently of request-tool command drift.
// ---------------------------------------------------------------------------

/**
 * Native: the provider CLI ships a first-class ACP process entrypoint at the
 * target version. Adapter-mediated: ACP exists only via a separately-owned
 * adapter and is deferred (NOT native gateway support). Absent: no ACP surface
 * at the target version; kept on the upstream drift watchlist.
 */
export type AcpEntrypointStatus = "native" | "adapter_mediated_deferred" | "absent_watchlist";

export interface AcpEntrypointContract {
  /** Canonical CliType this ACP entrypoint belongs to. */
  cli: CliType;
  /** Human label for the provider's ACP surface. */
  displayName: string;
  /** Native vs adapter-mediated vs absent classification at the target version. */
  status: AcpEntrypointStatus;
  /**
   * Executable invoked for the ACP process when status is native. For
   * adapter/absent providers this is the executable that was probed for the
   * absence/adapter evidence (e.g. the CLI itself), never a fabricated command.
   */
  executable: string;
  /**
   * argv (array only — never a shell string) that launches the provider ACP
   * process. Empty for adapter/absent providers that have no native entrypoint.
   * This is documentation/probe metadata; it is NOT an argv allowlist.
   */
  entrypointArgs: readonly string[];
  /** Target provider version this ACP evidence was captured against. */
  targetVersion: string;
  /**
   * Safe, read-only probe argv variants to confirm the ACP entrypoint exists
   * without starting the live ACP process. Each entry is a full argv array
   * (e.g. `["--version"]`, `["agent", "stdio", "--help"]`). Empty when there is
   * no safe non-server probe (adapter/absent providers).
   */
  probeArgs: readonly (readonly string[])[];
  /**
   * For adapter-mediated providers: separately-owned adapter candidates. These
   * are documentation only and are never treated as native gateway ACP support.
   */
  adapterCandidates?: readonly string[];
  /** Evidence / caveat note carried into the contract report (no secrets). */
  evidence: string;
  /** Agent-facing docs reference for the ACP transport decision. */
  docsRef: string;
}

/**
 * ACP entrypoint contracts for every provider CLI. Mirrors the provider matrix
 * in docs/plans/first-class-acp-gateway-extension.dag.toml. Data-only: nothing
 * here executes a subcommand. Probes run ONLY through
 * {@link probeInstalledAcpEntrypoint}, which restricts itself to the read-only
 * `probeArgs` declared here.
 */
export const ACP_ENTRYPOINT_CONTRACTS: Record<CliType, AcpEntrypointContract> = {
  mistral: {
    cli: "mistral",
    displayName: "Mistral Vibe",
    status: "native",
    executable: "vibe-acp",
    entrypointArgs: [],
    targetVersion: "vibe 2.18.3",
    probeArgs: [["--version"], ["--help"]],
    // phase-5/8: replace limited-support label with discovered capability fact
    evidence:
      "Native ACP executable vibe-acp; manual initialize + session/new smoke passed. First runtime pilot.",
    docsRef: "docs/plans/first-class-acp-gateway-extension.dag.toml#provider_matrix.mistral",
  },
  grok: {
    cli: "grok",
    displayName: "xAI Grok CLI",
    status: "native",
    executable: "grok",
    entrypointArgs: ["agent", "stdio"],
    targetVersion: "grok 0.2.77 (44e77bec3a)",
    // `grok agent stdio --help` is a safe help probe; bare `grok agent stdio`
    // starts the live ACP server and is intentionally NOT probed here.
    probeArgs: [["agent", "stdio", "--help"]],
    // phase-5/8: replace limited-support label with discovered capability fact
    evidence:
      "Native ACP via `grok agent stdio`; initialize + session/new smoke passed with isolated leader socket. Second runtime pilot. Entrypoint re-probed clean at 0.2.77.",
    docsRef: "docs/plans/first-class-acp-gateway-extension.dag.toml#provider_matrix.grok",
  },
  codex: {
    cli: "codex",
    displayName: "OpenAI Codex CLI",
    // phase-5/8: replace limited-support label with discovered capability fact
    status: "adapter_mediated_deferred",
    executable: "codex",
    entrypointArgs: [],
    targetVersion: "codex-cli 0.142.4",
    probeArgs: [],
    adapterCandidates: ["zed-industries/codex-acp", "agentclientprotocol/codex-acp"],
    evidence:
      "No native ACP entrypoint at codex-cli 0.142.4. Adapter evidence tracked as documentation only; not native gateway ACP support.",
    docsRef: "docs/plans/first-class-acp-gateway-extension.dag.toml#provider_matrix.codex",
  },
  claude: {
    cli: "claude",
    displayName: "Anthropic Claude Code",
    // phase-5/8: replace limited-support label with discovered capability fact
    status: "adapter_mediated_deferred",
    executable: "claude",
    entrypointArgs: [],
    targetVersion: "claude 2.1.198",
    probeArgs: [],
    adapterCandidates: ["Claude Agent SDK ACP adapter"],
    evidence:
      "No native Claude Code CLI ACP entrypoint at claude 2.1.198. Adapter ownership/permission bridging unresolved; deferred.",
    docsRef: "docs/plans/first-class-acp-gateway-extension.dag.toml#provider_matrix.claude",
  },
  gemini: {
    cli: "gemini",
    displayName: "Google Antigravity",
    // phase-5/8: replace limited-support label with discovered capability fact
    status: "absent_watchlist",
    executable: "agy",
    entrypointArgs: [],
    targetVersion: "agy 1.0.14",
    probeArgs: [],
    evidence:
      "agy 1.0.14 has no ACP flag or subcommand. Legacy Gemini CLI ACP evidence does not transfer. Watchlist item.",
    docsRef: "docs/plans/first-class-acp-gateway-extension.dag.toml#provider_matrix.gemini",
  },
  devin: {
    cli: "devin",
    displayName: "Cognition Devin CLI",
    status: "native",
    executable: "devin",
    entrypointArgs: ["acp"],
    targetVersion: "devin 2026.8.18 (16737566)",
    // `devin --version` is the safe probe; bare `devin acp` starts the live ACP
    // server over stdio and is intentionally NOT probed here.
    probeArgs: [["--version"]],
    // phase-5/8: replace limited-support label with discovered capability fact
    evidence:
      'Native ACP entrypoint `devin acp` (stdio JSON-RPC). Slice D1 manual initialize + session/new smoke passed (protocolVersion 1, agent "Affogato", session created). Third native runtime pilot; routing stays config-gated.',
    docsRef: "docs/plans/first-class-acp-gateway-extension.dag.toml#provider_matrix.devin",
  },
  cursor: {
    cli: "cursor",
    displayName: "Cursor Agent CLI",
    status: "native",
    executable: "cursor-agent",
    entrypointArgs: ["acp"],
    targetVersion: "cursor-agent 2026.06.29-2ad2186",
    probeArgs: [["acp", "--help"]],
    // phase-5/8: replace limited-support label with discovered capability fact
    evidence:
      "Native hidden ACP entrypoint `cursor-agent acp` (stdio JSON-RPC). `cursor-agent acp --help` was verified locally; manual initialize + session/new smoke passed locally (protocolVersion 1, session created; no agentInfo returned). Runtime routing stays config-gated.",
    docsRef: "docs/plans/first-class-acp-gateway-extension.dag.toml#provider_matrix.cursor",
  },
};

const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions",
] as const;

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

function scFlag(name: string, arity: CliFlagArity = "optional"): [string, CliFlagContract] {
  return [
    name,
    {
      arity,
      description: `Subcommand-local ${name} option tracked for help-surface drift only`,
    },
  ];
}

function scFlags(
  flags: readonly string[],
  arityOverrides: Record<string, CliFlagArity> = {}
): Record<string, CliFlagContract> {
  return Object.fromEntries(flags.map(flag => scFlag(flag, arityOverrides[flag] ?? "optional")));
}

function subcommand(
  commandPath: readonly string[],
  summary: string,
  risk: CliSubcommandRisk,
  flags: readonly string[] = [],
  options: {
    aliases?: readonly string[];
    children?: Record<string, CliSubcommandContract>;
    tier?: CliSubcommandTier;
    tokenCost?: CliSubcommandTokenCost;
    maxPositionals?: number;
    exposure?: CliSubcommandExposure;
    flagArities?: Record<string, CliFlagArity>;
    fixtures?: readonly CliContractFixture[];
    acknowledgedUpstreamFlags?: readonly string[];
    helpProbeExitTolerant?: boolean;
  } = {}
): CliSubcommandContract {
  return {
    commandPath,
    helpArgs: [["--help"]],
    flags: scFlags(flags, options.flagArities),
    maxPositionals: options.maxPositionals ?? 0,
    aliases: options.aliases ?? [],
    children: options.children ?? {},
    risk,
    exposure: options.exposure ?? "tracked_only",
    tier: options.tier ?? "catalog",
    tokenCost: options.tokenCost ?? "small",
    summary,
    conformanceFixtures: options.fixtures ?? [],
    acknowledgedUpstreamFlags: options.acknowledgedUpstreamFlags ?? [],
    ...(options.helpProbeExitTolerant ? { helpProbeExitTolerant: true } : {}),
  };
}

function acknowledgeSubcommandFlags<T extends Record<string, CliSubcommandContract>>(
  subcommands: T,
  flags: readonly string[]
): T {
  return Object.fromEntries(
    Object.entries(subcommands).map(([name, contract]) => [
      name,
      {
        ...contract,
        acknowledgedUpstreamFlags: Array.from(
          new Set([...(contract.acknowledgedUpstreamFlags ?? []), ...flags])
        ),
        children: acknowledgeSubcommandFlags(contract.children ?? {}, flags),
      },
    ])
  ) as unknown as T;
}

const GROK_DEBUG_HELP_FLAGS = ["--debug", "--debug-file"] as const;

export const UPSTREAM_CLI_CONTRACTS: Record<CliType, CliContract> = {
  claude: {
    cli: "claude",
    executable: "claude",
    upstream: "Claude Code CLI",
    upstreamMetadata: {
      sourceUrls: ["https://code.claude.com/docs/en/changelog.md"],
      packageName: "@anthropic-ai/claude-code",
      installDocsUrl: "https://code.claude.com/docs/en/overview",
      releaseChannel: "npm",
      watchCategories: ["flags", "output-formats", "permission-modes", "session-resume", "models"],
    },
    helpArgs: [["--help"]],
    subcommands: {
      doctor: subcommand(["doctor"], "Run Claude Code diagnostic checks.", "read_only", [], {
        tier: "diagnostic",
      }),
      mcp: subcommand(["mcp"], "Manage Claude MCP server configuration.", "writes_local_config"),
      plugin: subcommand(["plugin"], "Manage Claude plugins.", "writes_local_config", [], {
        aliases: ["plugins"],
      }),
      plugins: subcommand(
        ["plugins"],
        "Alias for Claude plugin management.",
        "writes_local_config",
        [],
        {
          aliases: ["plugin"],
        }
      ),
      agents: subcommand(
        ["agents"],
        "Inspect and manage Claude agent definitions.",
        "writes_local_config",
        [
          "--add-dir",
          "--agent",
          "--all",
          "--allow-dangerously-skip-permissions",
          "--cwd",
          "--dangerously-skip-permissions",
          "--effort",
          "--json",
          "--mcp-config",
          "--model",
          "--permission-mode",
          "--plugin-dir",
          "--setting-sources",
          "--settings",
          "--strict-mcp-config",
        ],
        { tier: "inspect", flagArities: { "--json": "none", "--strict-mcp-config": "none" } }
      ),
      auth: subcommand(["auth"], "Manage Claude authentication state.", "auth", [], {
        exposure: "not_exposed",
      }),
      project: subcommand(
        ["project"],
        "Manage Claude project configuration.",
        "writes_local_config"
      ),
      update: subcommand(["update"], "Update the Claude Code binary.", "updates_binary", [], {
        exposure: "not_exposed",
      }),
      upgrade: subcommand(
        ["upgrade"],
        "Alias for updating the Claude Code binary.",
        "updates_binary",
        [],
        {
          exposure: "not_exposed",
        }
      ),
      install: subcommand(
        ["install"],
        "Install Claude Code shell integrations.",
        "writes_local_config",
        ["--force"],
        {
          exposure: "not_exposed",
          flagArities: { "--force": "none" },
        }
      ),
      "auto-mode": subcommand(
        ["auto-mode"],
        "Configure Claude auto-mode behavior.",
        "writes_local_config"
      ),
      ultrareview: subcommand(
        ["ultrareview"],
        "Run Claude ultrareview diagnostics.",
        "executes_agent",
        ["--json", "--timeout"],
        {
          tier: "diagnostic",
          tokenCost: "medium",
          flagArities: { "--json": "none" },
        }
      ),
      "setup-token": subcommand(
        ["setup-token"],
        "Configure Claude setup token authentication.",
        "auth",
        [],
        {
          exposure: "not_exposed",
        }
      ),
    },
    maxPositionals: 0,
    mcpTools: ["claude_request", "claude_request_async"],
    mcpParameters: [
      "prompt",
      "model",
      "outputFormat",
      "sessionId",
      "continueSession",
      "createNewSession",
      "allowedTools",
      "disallowedTools",
      "dangerouslySkipPermissions",
      "permissionMode",
      "agent",
      "agents",
      "forkSession",
      "systemPrompt",
      "appendSystemPrompt",
      "maxBudgetUsd",
      "maxTurns",
      "effort",
      "excludeDynamicSystemPromptSections",
      "fallbackModel",
      "jsonSchema",
      // Phase 4 slice ζ
      "addDir",
      // Claude 2.x session / settings / tools surface
      "noSessionPersistence",
      "settingSources",
      "settings",
      "tools",
      "approvalStrategy",
      "mcpServers",
      "strictMcpConfig",
    ],
    flags: {
      "-p": {
        arity: "optional",
        description:
          "Print/non-interactive mode. Legacy gateway emission used `-p <prompt>` (consumed as positional in claude's grammar); slice κ emits `-p` standalone followed by `--input-format stream-json` so the prompt flows in on stdin.",
      },
      "--model": { arity: "one", description: "Model selector" },
      "--input-format": {
        arity: "one",
        values: ["text", "stream-json"],
        description:
          "Slice κ: realtime JSON stdin payload. `stream-json` enables Anthropic cache_control breakpoints from caller-supplied content blocks.",
      },
      "--output-format": {
        arity: "one",
        values: ["json", "stream-json"],
        description: "Machine-readable output format",
      },
      "--include-partial-messages": {
        arity: "none",
        description: "Include partial messages in stream-json output",
      },
      "--verbose": {
        arity: "none",
        description:
          "Claude CLI 2.x: required alongside --print + --output-format=stream-json; affects stderr only, stream-json stdout shape unchanged",
      },
      "--allowed-tools": { arity: "variadic", description: "Allowed tool names/patterns" },
      "--disallowed-tools": { arity: "variadic", description: "Disallowed tool names/patterns" },
      "--permission-mode": {
        arity: "one",
        values: PERMISSION_MODES,
        description: "Claude permission mode",
      },
      "--mcp-config": { arity: "one", description: "MCP config path" },
      "--strict-mcp-config": { arity: "none", description: "Restrict to MCP config" },
      "--agent": { arity: "one", description: "Named sub-agent" },
      "--agents": { arity: "one", description: "Inline agent definitions JSON" },
      "--fork-session": { arity: "none", description: "Fork current session" },
      "--system-prompt": { arity: "one", description: "Replacement system prompt" },
      "--append-system-prompt": { arity: "one", description: "Appended system prompt" },
      "--max-budget-usd": {
        arity: "one",
        pattern: /^[0-9]+(?:\.[0-9]+)?$/,
        description: "Budget cap in USD",
      },
      // NOTE: claude 2.x hides --max-turns from the `--help` body, but it is a
      // real, accepted flag — verified on 2.1.167 with an actual run:
      // `claude -p --max-turns 1` succeeds while `claude -p --not-a-flag`
      // fails with "error: unknown option". (The older `--max-turns N --help`
      // parse check no longer discriminates: as of 2.1.167, `--help` succeeds
      // even with unknown flags present.) `hiddenFromHelp` keeps the probe
      // from reporting this known help-text gap as missing-flag drift.
      "--max-turns": {
        arity: "one",
        pattern: /^[1-9][0-9]*$/,
        description: "Turn cap",
        hiddenFromHelp: true,
      },
      "--effort": { arity: "one", values: EFFORT_LEVELS, description: "Reasoning effort" },
      "--exclude-dynamic-system-prompt-sections": {
        arity: "none",
        description: "Trim dynamic system prompt sections",
      },
      "--fallback-model": {
        arity: "one",
        description: "Auto-fallback model when default is overloaded (Claude --print only)",
      },
      "--json-schema": {
        arity: "one",
        description: "JSON Schema literal constraining structured output",
      },
      "--add-dir": {
        arity: "one",
        description: "Additional workspace directory (Phase 4 slice ζ; repeat once per directory)",
      },
      "--continue": { arity: "none", description: "Continue active session" },
      "--session-id": { arity: "one", description: "Session id" },
      // Claude 2.x session / settings / tools surface
      "--no-session-persistence": {
        arity: "none",
        description: "Do not persist the session to disk (ephemeral; mirrors Codex --ephemeral)",
      },
      "--setting-sources": {
        arity: "one",
        description: "Comma-separated setting sources to load (user|project|local)",
      },
      "--settings": {
        arity: "one",
        description: "Settings JSON file path or literal (can define hooks/permissions/model)",
      },
      "--tools": {
        arity: "variadic",
        description: 'Restrict the available built-in tool set ("" disables all)',
      },
      // Phase 4 Part A: headless-safe modifiers emitted by
      // prepareClaudeHighImpactFlags. Each is a genuinely-emitted argv token and
      // therefore MUST live in this allowlist (not merely acknowledged), else
      // assertUpstreamCliArgs throws on a real request.
      "--include-hook-events": {
        arity: "none",
        description: "Emit hook lifecycle events into the stream-json output",
      },
      "--replay-user-messages": {
        arity: "none",
        description: "Replay user messages back on stdout in stream-json mode",
      },
      "--system-prompt-file": {
        arity: "one",
        description: "Replacement system prompt read from a file path",
      },
      "--append-system-prompt-file": {
        arity: "one",
        description: "Appended system prompt read from a file path",
      },
      "--name": { arity: "one", description: "Session name label" },
      "--plugin-dir": {
        arity: "one",
        description: "Additional plugin directory (repeat once per directory)",
      },
      "--plugin-url": {
        arity: "one",
        description: "Additional plugin URL (repeat once per URL)",
      },
      "--safe-mode": {
        arity: "none",
        description: "Start with all customizations disabled (troubleshooting)",
      },
      "--bare": {
        arity: "none",
        description:
          "Minimal mode: skip hooks, LSP, plugin sync, attribution, auto-memory, keychain, CLAUDE.md discovery",
      },
      "--debug": {
        arity: "optional",
        description: "Enable debug mode with an optional category filter (e.g. api,hooks)",
      },
      "--debug-file": {
        arity: "one",
        description: "Write debug logs to a specific file path (implies debug mode)",
      },
    },
    // Claude Code 2.1.198 --help surface the gateway deliberately does not
    // emit. Long-form aliases of declared short flags (--print for -p),
    // interactive/IDE-only switches, background-agent launchers, and flags
    // superseded by gateway parameters (--dangerously-skip-permissions maps to
    // --permission-mode bypassPermissions via request-helpers). Probe-
    // acknowledgement only, never an argv allowlist.
    acknowledgedUpstreamFlags: [
      "--allow-dangerously-skip-permissions",
      "--allowed", // alias of --allowed-tools
      "--ax-screen-reader",
      "--background", // 2.1.198: start the session as a background agent
      "--betas",
      "--bg", // 2.1.198: short form of --background
      "--brief",
      "--chrome",
      "--dangerously-skip-permissions",
      "--disable-slash-commands",
      "--disallowed", // alias of --disallowed-tools
      "--file",
      "--from-pr",
      "--ide",
      "--no-chrome",
      "--print", // long form of declared -p
      "--prompt-suggestions",
      "--remote-control",
      "--remote-control-session-name-prefix",
      "--resume", // interactive resume; gateway uses --continue/--session-id
      "--tmux",
      "--version",
      "--worktree",
    ],
    env: {},
    conformanceFixtures: [
      {
        id: "claude-minimal",
        description: "Minimal prompt request",
        args: ["-p", "hello"],
        expect: "pass",
      },
      {
        id: "claude-unsupported-flag",
        description: "Unsupported flag is rejected before spawn",
        args: ["-p", "hello", "--not-a-claude-flag"],
        expect: "fail",
      },
      {
        // Phase 4 slice η: --fallback-model wired through prepareClaudeRequest.
        id: "claude-fallback-model",
        description: "Phase 4 slice η: --fallback-model accepted",
        args: ["-p", "hello", "--fallback-model", "claude-haiku-4-5-20251001"],
        expect: "pass",
      },
      {
        // Phase 4 slice η: --json-schema accepts an inline JSON Schema literal
        // (per `claude --help` example), not a path. Codex parity for
        // structured-output validation in one slice.
        id: "claude-json-schema",
        description: "Phase 4 slice η: --json-schema accepts inline JSON literal",
        args: [
          "-p",
          "hello",
          "--output-format",
          "json",
          "--json-schema",
          '{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}',
        ],
        expect: "pass",
      },
      {
        // Phase 4 slice ζ: --add-dir wired through prepareClaudeHighImpactFlags.
        // Repeated once per directory; each instance has arity:"one".
        id: "claude-add-dir",
        description: "Phase 4 slice ζ: repeated --add-dir is accepted",
        args: ["-p", "hello", "--add-dir", "/tmp/a", "--add-dir", "/tmp/b"],
        expect: "pass",
      },
      {
        id: "claude-session-settings-tools",
        description:
          "Claude 2.x: --no-session-persistence, --setting-sources, --settings, and --tools (variadic) are accepted",
        args: [
          "-p",
          "hello",
          "--no-session-persistence",
          "--setting-sources",
          "project,local",
          "--settings",
          "{}",
          "--tools",
          "Read",
          "Edit",
        ],
        expect: "pass",
      },
      {
        // Phase 4 Part A: headless-safe modifiers emitted by
        // prepareClaudeHighImpactFlags. Pins that each genuinely-emitted flag
        // is accepted by the argv allowlist (guards the BLOCKER 1 class: a flag
        // left only in acknowledgedUpstreamFlags would fail this fixture).
        id: "claude-part-a-high-impact-flags",
        description: "Phase 4 Part A: all wired headless-safe modifier flags accepted together",
        args: [
          "-p",
          "hello",
          "--include-hook-events",
          "--replay-user-messages",
          "--system-prompt-file",
          "/tmp/sys.txt",
          "--append-system-prompt-file",
          "/tmp/append.txt",
          "--name",
          "my-session",
          "--plugin-dir",
          "/tmp/plugA",
          "--plugin-url",
          "https://example.com/a.zip",
          "--safe-mode",
          "--bare",
          "--debug",
          "api,hooks",
          "--debug-file",
          "/tmp/debug.log",
        ],
        expect: "pass",
      },
      {
        // Claude CLI 2.x: stream-json requires --verbose alongside --print.
        // The gateway emits all three together; this fixture pins the combo
        // so a future removal of --verbose breaks loudly here instead of
        // silently at runtime against the upstream CLI.
        id: "claude-stream-json-requires-verbose",
        description:
          "Claude CLI 2.x: --output-format stream-json + --include-partial-messages + --verbose accepted together",
        args: [
          "-p",
          "hello",
          "--output-format",
          "stream-json",
          "--include-partial-messages",
          "--verbose",
        ],
        expect: "pass",
      },
      {
        // Slice κ: when caller marks promptParts with cache_control, the
        // gateway emits `-p` as a standalone flag and pipes the JSON
        // content-blocks payload over stdin via `--input-format
        // stream-json`. The fixture pins the exact argv combination so
        // a future regression (re-emitting a positional prompt, dropping
        // `--input-format`, etc.) trips loudly here.
        id: "claude-input-format-stream-json",
        description:
          "Slice κ: `-p` standalone + --input-format stream-json + --output-format stream-json + --include-partial-messages + --verbose",
        args: [
          "-p",
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--include-partial-messages",
          "--verbose",
        ],
        expect: "pass",
      },
      {
        id: "claude-background-acknowledged-not-emitted",
        description:
          "Claude 2.1.198 advertises --bg/--background (background agent), but the gateway acknowledges them without emitting; caller argv is rejected",
        args: ["-p", "hello", "--background"],
        expect: "fail",
      },
    ],
  },
  codex: {
    cli: "codex",
    executable: "codex",
    upstream: "OpenAI Codex CLI",
    upstreamMetadata: {
      sourceUrls: [
        "https://github.com/openai/codex/releases",
        "https://developers.openai.com/codex/changelog",
      ],
      packageName: "@openai/codex",
      repo: "https://github.com/openai/codex",
      installDocsUrl: "https://developers.openai.com/codex/cli",
      releaseChannel: "npm",
      watchCategories: [
        "flags",
        "sandbox-modes",
        "approval-modes",
        "session-resume",
        "output-schema",
      ],
    },
    helpArgs: [
      ["exec", "--help"],
      ["exec", "resume", "--help"],
    ],
    subcommands: {
      exec: subcommand(
        ["exec"],
        "Run Codex in non-interactive execution mode.",
        "executes_agent",
        [
          "--add-dir",
          "--cd",
          "--color",
          "--config",
          "--dangerously-bypass-approvals-and-sandbox",
          "--dangerously-bypass-hook-trust",
          "--disable",
          "--enable",
          "--ephemeral",
          "--ignore-rules",
          "--ignore-user-config",
          "--image",
          "--json",
          "--local-provider",
          "--model",
          "--oss",
          "--output-last-message",
          "--output-schema",
          "--profile",
          "--sandbox",
          "--skip-git-repo-check",
          "--strict-config",
          "--version",
        ],
        {
          children: {
            resume: subcommand(
              ["exec", "resume"],
              "Resume Codex sessions from the interactive CLI.",
              "executes_agent",
              [
                "--all",
                "--config",
                "--dangerously-bypass-approvals-and-sandbox",
                "--dangerously-bypass-hook-trust",
                "--disable",
                "--enable",
                "--ephemeral",
                "--ignore-rules",
                "--ignore-user-config",
                "--image",
                "--json",
                "--last",
                "--model",
                "--output-last-message",
                "--output-schema",
                "--skip-git-repo-check",
                "--strict-config",
              ]
            ),
            review: subcommand(
              ["exec", "review"],
              "Run Codex code review workflows.",
              "executes_agent",
              [
                "--base",
                "--commit",
                "--config",
                "--dangerously-bypass-approvals-and-sandbox",
                "--dangerously-bypass-hook-trust",
                "--disable",
                "--enable",
                "--ephemeral",
                "--ignore-rules",
                "--ignore-user-config",
                "--json",
                "--model",
                "--output-last-message",
                "--output-schema",
                "--skip-git-repo-check",
                "--strict-config",
                "--title",
                "--uncommitted",
              ]
            ),
          },
        }
      ),
      review: subcommand(["review"], "Run Codex code review workflows.", "executes_agent", [
        "--base",
        "--commit",
        "--config",
        "--disable",
        "--enable",
        "--strict-config",
        "--title",
        "--uncommitted",
      ]),
      login: subcommand(
        ["login"],
        "Authenticate Codex CLI.",
        "auth",
        [
          "--config",
          "--device-auth",
          "--disable",
          "--enable",
          "--with-access-token",
          "--with-api-key",
        ],
        { exposure: "not_exposed" }
      ),
      logout: subcommand(
        ["logout"],
        "Clear Codex authentication state.",
        "auth",
        ["--config", "--disable", "--enable"],
        { exposure: "not_exposed" }
      ),
      mcp: subcommand(["mcp"], "Manage Codex MCP configuration.", "writes_local_config", [
        "--config",
        "--disable",
        "--enable",
      ]),
      plugin: subcommand(["plugin"], "Manage Codex plugins.", "writes_local_config", [
        "--config",
        "--disable",
        "--enable",
      ]),
      "mcp-server": subcommand(
        ["mcp-server"],
        "Start Codex MCP server mode.",
        "starts_server",
        ["--config", "--disable", "--enable", "--strict-config"],
        { exposure: "not_exposed" }
      ),
      "app-server": subcommand(
        ["app-server"],
        "Start Codex app server mode.",
        "starts_server",
        [
          "--analytics-default-enabled",
          "--config",
          "--disable",
          "--enable",
          "--listen",
          "--stdio",
          "--strict-config",
          "--ws-audience",
          "--ws-auth",
          "--ws-issuer",
          "--ws-max-clock-skew-seconds",
          "--ws-shared-secret-file",
          "--ws-token-file",
          "--ws-token-sha256",
        ],
        { exposure: "not_exposed" }
      ),
      "remote-control": subcommand(
        ["remote-control"],
        "Inspect or manage Codex remote control state.",
        "network",
        ["--config", "--disable", "--enable", "--json"]
      ),
      completion: subcommand(
        ["completion"],
        "Generate Codex shell completions.",
        "read_only",
        ["--config", "--disable", "--enable"],
        { tier: "inspect" }
      ),
      update: subcommand(
        ["update"],
        "Update the Codex CLI binary.",
        "updates_binary",
        ["--config", "--disable", "--enable"],
        { exposure: "not_exposed" }
      ),
      doctor: subcommand(
        ["doctor"],
        "Run Codex diagnostic checks.",
        "read_only",
        [
          "--all",
          "--ascii",
          "--config",
          "--disable",
          "--enable",
          "--json",
          "--no-color",
          "--summary",
        ],
        { tier: "diagnostic" }
      ),
      sandbox: subcommand(
        ["sandbox"],
        "Run or inspect Codex sandbox behavior.",
        "executes_agent",
        [
          "--cd",
          "--config",
          "--disable",
          "--enable",
          "--include-managed-config",
          "--permissions-profile",
          "--profile",
        ],
        { exposure: "not_exposed" }
      ),
      debug: subcommand(
        ["debug"],
        "Run Codex debugging utilities.",
        "read_only",
        ["--config", "--disable", "--enable"],
        { tier: "diagnostic" }
      ),
      apply: subcommand(
        ["apply"],
        "Apply a Codex patch to the workspace.",
        "destructive",
        ["--config", "--disable", "--enable"],
        { exposure: "not_exposed" }
      ),
      archive: subcommand(
        ["archive"],
        "Archive Codex session state.",
        "writes_local_config",
        [
          "--add-dir",
          "--cd",
          "--config",
          "--dangerously-bypass-approvals-and-sandbox",
          "--dangerously-bypass-hook-trust",
          "--disable",
          "--enable",
          "--image",
          "--local-provider",
          "--model",
          "--oss",
          "--profile",
          "--remote",
          "--remote-auth-token-env",
          "--sandbox",
          "--strict-config",
        ],
        { exposure: "not_exposed" }
      ),
      unarchive: subcommand(
        ["unarchive"],
        "Restore archived Codex session state.",
        "writes_local_config",
        [
          "--add-dir",
          "--cd",
          "--config",
          "--dangerously-bypass-approvals-and-sandbox",
          "--dangerously-bypass-hook-trust",
          "--disable",
          "--enable",
          "--image",
          "--local-provider",
          "--model",
          "--oss",
          "--profile",
          "--remote",
          "--remote-auth-token-env",
          "--sandbox",
          "--strict-config",
        ],
        { exposure: "not_exposed" }
      ),
      fork: subcommand(["fork"], "Fork a Codex session.", "executes_agent", [
        "--add-dir",
        "--all",
        "--ask-for-approval",
        "--cd",
        "--config",
        "--dangerously-bypass-approvals-and-sandbox",
        "--dangerously-bypass-hook-trust",
        "--disable",
        "--enable",
        "--image",
        "--last",
        "--local-provider",
        "--model",
        "--no-alt-screen",
        "--oss",
        "--profile",
        "--remote",
        "--remote-auth-token-env",
        "--sandbox",
        "--search",
        "--strict-config",
        "--version",
      ]),
      cloud: subcommand(["cloud"], "Inspect or manage Codex cloud features.", "network", [
        "--config",
        "--disable",
        "--enable",
        "--version",
      ]),
      "exec-server": subcommand(
        ["exec-server"],
        "Start Codex exec server mode.",
        "starts_server",
        [
          "--config",
          "--disable",
          "--enable",
          "--environment-id",
          "--listen",
          "--name",
          "--remote",
          "--strict-config",
          "--use-agent-identity-auth",
        ],
        { exposure: "not_exposed" }
      ),
      features: subcommand(
        ["features"],
        "Inspect or configure Codex feature flags.",
        "writes_local_config",
        ["--config", "--disable", "--enable"]
      ),
    },
    command: { requiredFirstArg: "exec", optionalSecondArg: "resume" },
    maxPositionals: 1,
    resumeMaxPositionals: 2,
    mcpTools: ["codex_request", "codex_request_async"],
    mcpParameters: [
      "prompt",
      "model",
      "fullAuto",
      "sandboxMode",
      "askForApproval",
      "useLegacyFullAutoFlag",
      "dangerouslyBypassApprovalsAndSandbox",
      "approvalStrategy",
      "mcpServers",
      "sessionId",
      "resumeLatest",
      "createNewSession",
      "outputFormat",
      "outputSchema",
      "search",
      "profile",
      "configOverrides",
      "ephemeral",
      "images",
      "ignoreUserConfig",
      "ignoreRules",
      // Phase 4 slice ζ
      "workingDir",
      "addDir",
    ],
    resumeOnlyFlags: ["--last", "--all"],
    // Phase 4 slice α (v1.8.0) verified that `codex exec resume` accepts
    // `--output-schema` and `-c` (codex-cli 0.133.0 `exec resume --help`),
    // so they're no longer forbidden. Current resume help does not accept
    // session-profile or working-directory policy flags.
    resumeForbiddenFlags: ["--sandbox", "-C", "--cd", "--add-dir", "--profile"],
    flags: {
      "--last": { arity: "none", description: "Resume latest session" },
      "--model": { arity: "one", description: "Model selector" },
      "--sandbox": {
        arity: "one",
        values: ["read-only", "workspace-write", "danger-full-access"],
        description: "Sandbox policy",
      },
      "--dangerously-bypass-approvals-and-sandbox": {
        arity: "none",
        description: "Disable approvals and sandbox",
      },
      "--json": { arity: "none", description: "JSONL event stream" },
      "--skip-git-repo-check": { arity: "none", description: "Allow non-git cwd" },
      "--output-schema": { arity: "one", description: "Structured output JSON schema path" },
      "--profile": { arity: "one", description: "Config profile" },
      "-c": {
        arity: "one",
        pattern: /^[a-zA-Z0-9._]+=([^\r\n]*)$/,
        description: "Config override key=value",
      },
      "--config": {
        arity: "one",
        pattern: /^[a-zA-Z0-9._]+=([^\r\n]*)$/,
        description: "Config override key=value",
      },
      "--enable": { arity: "one", description: "Enable a Codex feature flag" },
      "--disable": { arity: "one", description: "Disable a Codex feature flag" },
      "--strict-config": {
        arity: "none",
        description: "Reject unrecognized config.toml fields",
      },
      "--ephemeral": { arity: "none", description: "Do not persist session" },
      "-i": { arity: "one", description: "Image path" },
      "--image": { arity: "one", description: "Image path" },
      "--ignore-user-config": { arity: "none", description: "Ignore user config" },
      "--ignore-rules": { arity: "none", description: "Ignore rule files" },
      "--oss": { arity: "none", description: "Use open-source provider" },
      "--local-provider": {
        arity: "one",
        values: ["lmstudio", "ollama"],
        description: "Local open-source provider",
      },
      "--color": {
        arity: "one",
        values: ["always", "never", "auto"],
        description: "Output color mode",
      },
      "--output-last-message": {
        arity: "one",
        description: "Write the final agent message to a file",
      },
      "--dangerously-bypass-hook-trust": {
        arity: "none",
        description: "Run enabled hooks without persisted hook trust",
      },
      "--version": { arity: "none", description: "Print version" },
      "--all": {
        arity: "none",
        description: "Resume picker: show all sessions without cwd filtering",
      },
      // The gateway emits the short form `-C`, and the advisory contract also
      // tracks the long `--cd` alias advertised by current Codex exec help.
      "-C": {
        arity: "one",
        description: "Working root for the session (Phase 4 slice ζ; new sessions only)",
      },
      "--cd": {
        arity: "one",
        description: "Working root for the session",
      },
      "--add-dir": {
        arity: "one",
        description:
          "Additional writable workspace directory (Phase 4 slice ζ; repeat once per directory; new sessions only)",
      },
    },
    env: {},
    conformanceFixtures: [
      {
        id: "codex-minimal",
        description: "Minimal exec prompt",
        args: ["exec", "--skip-git-repo-check", "hello"],
        expect: "pass",
      },
      {
        id: "codex-invalid-sandbox",
        description: "Unsupported sandbox enum is rejected",
        args: ["exec", "--sandbox", "workspace", "hello"],
        expect: "fail",
      },
      {
        id: "codex-ask-for-approval-unsupported",
        description: "Current Codex CLI no longer accepts --ask-for-approval",
        args: ["exec", "--ask-for-approval", "never", "hello"],
        expect: "fail",
      },
      {
        id: "codex-full-auto-unsupported",
        description: "Current Codex CLI no longer accepts --full-auto",
        args: ["exec", "--full-auto", "hello"],
        expect: "fail",
      },
      {
        // Phase 4 slice α: --output-schema IS accepted on resume per
        // codex-cli 0.133.0; this fixture pins the new behaviour so future
        // contract changes can't silently regress.
        id: "codex-resume-output-schema",
        description: "Phase 4 slice α: --output-schema accepted on resume (codex-cli 0.133.0)",
        args: ["exec", "resume", "--output-schema", "/tmp/schema.json", "session-id", "hello"],
        expect: "pass",
      },
      {
        id: "codex-resume-config-override",
        description: "Phase 4 slice α: -c key=value accepted on resume",
        args: ["exec", "resume", "-c", "model.foo=bar", "session-id", "hello"],
        expect: "pass",
      },
      {
        id: "codex-search-unsupported",
        description: "Current Codex exec no longer accepts --search",
        args: ["exec", "--search", "hello"],
        expect: "fail",
      },
      {
        id: "codex-working-dir",
        description: "Phase 4 slice ζ: -C <DIR> accepted on a new session",
        args: ["exec", "--skip-git-repo-check", "-C", "/tmp/work", "hello"],
        expect: "pass",
      },
      {
        id: "codex-add-dir",
        description: "Phase 4 slice ζ: repeated --add-dir accepted on a new session",
        args: [
          "exec",
          "--skip-git-repo-check",
          "--add-dir",
          "/tmp/a",
          "--add-dir",
          "/tmp/b",
          "hello",
        ],
        expect: "pass",
      },
      {
        id: "codex-current-exec-help-surface",
        description:
          "Current Codex exec advertises additional config, output, provider, and safety flags",
        args: [
          "exec",
          "--config",
          "features.foo=true",
          "--enable",
          "foo",
          "--disable",
          "bar",
          "--strict-config",
          "--image",
          "/tmp/a.png",
          "--oss",
          "--local-provider",
          "ollama",
          "--color",
          "auto",
          "--cd",
          "/tmp/work",
          "--output-last-message",
          "/tmp/out.txt",
          "--dangerously-bypass-hook-trust",
          "--version",
          "hello",
        ],
        expect: "pass",
      },
      {
        id: "codex-current-resume-help-surface",
        description: "Current Codex resume advertises --all for disabling cwd filtering",
        args: ["exec", "resume", "--all", "session-id", "hello"],
        expect: "pass",
      },
    ],
  },
  gemini: {
    cli: "gemini",
    executable: "agy",
    upstream: "Google Antigravity CLI",
    upstreamMetadata: {
      sourceUrls: [
        "https://antigravity.google/docs/cli-overview",
        "https://github.com/google-antigravity/antigravity-cli/releases",
      ],
      repo: "https://github.com/google-antigravity/antigravity-cli",
      installDocsUrl: "https://antigravity.google/docs/cli-getting-started",
      releaseChannel: "vendor",
      watchCategories: ["flags", "permissions", "session-resume", "subcommands"],
    },
    helpArgs: [["--help"]],
    subcommands: {
      changelog: subcommand(
        ["changelog"],
        "Show Antigravity CLI changelog and release notes.",
        "read_only",
        [],
        { tokenCost: "small" }
      ),
      install: subcommand(
        ["install"],
        "Configure Antigravity CLI environment paths and shell settings.",
        "writes_local_config",
        ["--dir", "--skip-aliases", "--skip-path"],
        {
          flagArities: { "--dir": "one", "--skip-aliases": "none", "--skip-path": "none" },
        }
      ),
      models: subcommand(["models"], "List available Antigravity models.", "read_only", [], {
        exposure: "mcp_readonly",
        tokenCost: "small",
      }),
      plugin: subcommand(["plugin"], "Manage Antigravity plugins.", "writes_local_config", [], {
        aliases: ["plugins"],
      }),
      plugins: subcommand(
        ["plugins"],
        "Alias for Antigravity plugin management.",
        "writes_local_config",
        [],
        {
          aliases: ["plugin"],
        }
      ),
      update: subcommand(
        ["update"],
        "Update Antigravity CLI to the current release.",
        "writes_local_config",
        [],
        // `agy update` uses Go's flag package: `agy update --help` prints
        // "Usage of update:" to stderr and exits 2 (no parseable flag list).
        // Tolerate the non-zero help-probe exit so it is not reported as drift.
        { tokenCost: "small", helpProbeExitTolerant: true }
      ),
    },
    maxPositionals: 1,
    mcpTools: ["gemini_request", "gemini_request_async"],
    mcpParameters: [
      "prompt",
      "model",
      "sessionId",
      "resumeLatest",
      "createNewSession",
      "approvalMode",
      "approvalStrategy",
      "mcpServers",
      "allowedTools",
      "includeDirs",
      "outputFormat",
      "sandbox",
      "policyFiles",
      "adminPolicyFiles",
      "attachments",
      // Phase 4 slice γ
      "skipTrust",
      // Auto-approve-all ergonomic alias (equivalent to approvalMode "yolo")
      "yolo",
      // Antigravity 1.0.14 wired project-selection flags
      "project",
      "newProject",
      "printTimeout",
    ],
    flags: {
      "--print": { arity: "none", description: "Run a single prompt non-interactively" },
      "-p": { arity: "none", description: "Short alias for --print" },
      "--prompt": { arity: "none", description: "Alias for --print" },
      "--model": { arity: "one", description: "Model selector" },
      "--add-dir": { arity: "one", description: "Additional workspace directory" },
      "--sandbox": { arity: "none", description: "Run with terminal sandbox restrictions" },
      "--dangerously-skip-permissions": {
        arity: "none",
        description: "Auto-approve all tool permission requests without prompting",
      },
      "--conversation": { arity: "one", description: "Resume a previous conversation by ID" },
      "--continue": { arity: "none", description: "Continue the most recent conversation" },
      "-c": { arity: "none", description: "Short alias for --continue" },
      // Antigravity 1.0.14: project selection for the CLI session (now wired).
      "--project": { arity: "one", description: "Antigravity project ID for this session" },
      "--new-project": {
        arity: "none",
        description: "Create a new Antigravity project for this session",
      },
      "--print-timeout": {
        arity: "one",
        description: "Print-mode wait timeout as a Go duration string (e.g. 5m0s)",
      },
    },
    // Antigravity CLI long flags the gateway deliberately does not emit, as
    // advertised by `agy --help` on 1.0.14. Probe acknowledgements only, never
    // an argv allowlist. (`-i` is a short alias of --prompt-interactive and
    // `--version` is a top-level command not listed in --help; neither is
    // parsed by the long-flag probe, so both were dropped to keep the probe
    // quiet.) `--project` / `--new-project` / `--print-timeout` graduated to the
    // flags allowlist.
    acknowledgedUpstreamFlags: ["--log-file", "--prompt-interactive"],
    env: {},
    conformanceFixtures: [
      {
        id: "gemini-minimal",
        description: "Minimal Antigravity print-mode prompt request",
        args: ["--print", "hello"],
        expect: "pass",
      },
      {
        id: "gemini-unsupported-flag",
        description: "Unsupported flag is rejected before spawn",
        args: ["--print", "hello", "--not-a-gemini-flag"],
        expect: "fail",
      },
      {
        id: "gemini-antigravity-workspace-flags",
        description: "Antigravity workspace and sandbox flags are accepted",
        args: ["--print", "hello", "--add-dir", "/tmp", "--sandbox"],
        expect: "pass",
      },
      {
        id: "gemini-yolo",
        description: "Antigravity permission bypass is accepted",
        args: ["--print", "hello", "--dangerously-skip-permissions"],
        expect: "pass",
      },
      {
        id: "gemini-conversation",
        description: "Antigravity conversation resume is accepted",
        args: ["--print", "hello", "--conversation", "user-session"],
        expect: "pass",
      },
      {
        id: "gemini-legacy-output-format-rejected",
        description: "Legacy Gemini JSON output flag is rejected",
        args: ["--print", "hello", "-o", "json"],
        expect: "fail",
      },
      {
        id: "gemini-project-wired",
        description: "Antigravity 1.0.14: --project <ID> is wired",
        args: ["--print", "hello", "--project", "proj-123"],
        expect: "pass",
      },
      {
        id: "gemini-new-project-wired",
        description: "Antigravity 1.0.14: --new-project is wired",
        args: ["--print", "hello", "--new-project"],
        expect: "pass",
      },
      {
        id: "gemini-print-timeout-wired",
        description: "Antigravity --print-timeout <DURATION> is wired",
        args: ["--print", "hello", "--print-timeout", "30s"],
        expect: "pass",
      },
    ],
  },
  grok: {
    cli: "grok",
    executable: "grok",
    upstream: "xAI Grok CLI",
    upstreamMetadata: {
      sourceUrls: ["https://docs.x.ai/developers/release-notes.md"],
      installDocsUrl: "https://docs.x.ai/build/overview",
      releaseChannel: "vendor",
      watchCategories: ["flags", "permission-modes", "session-resume", "sandbox", "output-formats"],
    },
    helpArgs: [["--help"]],
    subcommands: acknowledgeSubcommandFlags(
      {
        agent: subcommand(
          ["agent"],
          "Run Grok agent service helpers.",
          "executes_agent",
          [
            "--agent-profile",
            "--always-approve",
            "--cli-chat-proxy-base-url",
            "--grok-ws-origin",
            "--grok-ws-url",
            "--leader",
            "--leader-socket",
            "--model",
            "--no-leader",
            "--reasoning-effort",
            "--reauth",
            "--xai-api-base-url",
          ],
          {
            // Grok 0.2.38: expanded agent subcommand surface (profile, reauth, grok-ws-*,
            // leader/no-leader controls, xai-api-base etc.). Tracked explicitly for
            // help-surface drift detection in subcommand catalog (probe-installed).
            children: {
              stdio: subcommand(
                ["agent", "stdio"],
                "Run Grok agent stdio mode.",
                "starts_server",
                ["--leader-socket"],
                { exposure: "not_exposed" }
              ),
              headless: subcommand(
                ["agent", "headless"],
                "Run Grok headless agent mode.",
                "executes_agent",
                ["--grok-ws-origin", "--grok-ws-url", "--leader-socket"]
              ),
              serve: subcommand(
                ["agent", "serve"],
                "Start Grok agent server mode.",
                "starts_server",
                [
                  "--bind",
                  "--grok-ws-origin",
                  "--grok-ws-url",
                  "--leader-socket",
                  "--remote",
                  "--secret",
                ],
                { exposure: "not_exposed" }
              ),
              leader: subcommand(
                ["agent", "leader"],
                "Start Grok agent leader mode.",
                "starts_server",
                [
                  "--grok-ws-origin",
                  "--grok-ws-url",
                  "--leader-socket",
                  "--no-auto-update",
                  "--no-exit-on-disconnect",
                  "--relay-on-demand",
                ],
                { exposure: "not_exposed" }
              ),
            },
          }
        ),
        completions: subcommand(
          ["completions"],
          "Generate Grok shell completions.",
          "read_only",
          ["--leader-socket"],
          { tier: "inspect" }
        ),
        dashboard: subcommand(
          ["dashboard"],
          "Open the Agent Dashboard view at startup.",
          "read_only",
          ["--leader-socket"],
          {
            tier: "inspect",
            fixtures: [
              {
                id: "grok-dashboard",
                description: "grok dashboard subcommand (leader socket passthrough)",
                args: ["--leader-socket", "/tmp/dash.sock"],
                expect: "pass",
              },
            ],
          }
        ),
        export: subcommand(
          ["export"],
          "Export Grok session data.",
          "read_only",
          ["--clipboard", "--leader-socket"],
          { tier: "inspect" }
        ),
        import: subcommand(["import"], "Import Grok session data.", "writes_local_config", [
          "--json",
          "--leader-socket",
          "--list",
        ]),
        inspect: subcommand(
          ["inspect"],
          "Inspect Grok local state.",
          "read_only",
          ["--json", "--leader-socket"],
          { tier: "inspect" }
        ),
        leader: subcommand(
          ["leader"],
          "Manage Grok leader process.",
          "starts_server",
          ["--leader-socket"],
          {
            exposure: "not_exposed",
          }
        ),
        login: subcommand(
          ["login"],
          "Authenticate Grok CLI.",
          "auth",
          ["--device-auth", "--leader-socket", "--oauth"],
          { exposure: "not_exposed" }
        ),
        logout: subcommand(
          ["logout"],
          "Clear Grok authentication state.",
          "auth",
          ["--leader-socket"],
          {
            exposure: "not_exposed",
          }
        ),
        mcp: subcommand(["mcp"], "Manage Grok MCP configuration.", "writes_local_config", [
          "--leader-socket",
        ]),
        memory: subcommand(["memory"], "Manage Grok memory state.", "writes_local_config", [
          "--leader-socket",
        ]),
        models: subcommand(
          ["models"],
          "Inspect Grok model catalog.",
          "network",
          ["--leader-socket"],
          {
            tier: "diagnostic",
          }
        ),
        plugin: subcommand(["plugin"], "Manage Grok plugins.", "writes_local_config", [
          "--leader-socket",
        ]),
        sessions: subcommand(
          ["sessions"],
          "Inspect Grok sessions.",
          "read_only",
          ["--leader-socket"],
          {
            tier: "inspect",
          }
        ),
        setup: subcommand(
          ["setup"],
          "Configure Grok CLI local setup.",
          "writes_local_config",
          ["--leader-socket"],
          { exposure: "not_exposed" }
        ),
        ssh: subcommand(["ssh"], "Manage Grok SSH integration.", "network", ["--leader-socket"], {
          // Grok 0.2.77: `grok ssh --help` inherits the full global agent flag
          // surface (it launches an agent session over SSH). The gateway never
          // emits `grok ssh`, so acknowledge the inherited flags to keep the
          // subcommand drift probe quiet without widening any argv allowlist.
          // (--debug / --debug-file are merged in via GROK_DEBUG_HELP_FLAGS.)
          acknowledgedUpstreamFlags: [
            "--agent",
            "--agents",
            "--allow",
            "--always-approve",
            "--best-of-n",
            "--check",
            "--continue",
            "--cwd",
            "--deny",
            "--disable-web-search",
            "--disallowed-tools",
            "--effort",
            "--experimental-memory",
            "--fork-session",
            "--json-schema",
            "--max-turns",
            "--model",
            "--no-alt-screen",
            "--no-memory",
            "--no-plan",
            "--no-subagents",
            "--oauth",
            "--output-format",
            "--permission-mode",
            "--prompt-file",
            "--prompt-json",
            "--reasoning-effort",
            "--restore-code",
            "--resume",
            "--rules",
            "--sandbox",
            "--session-id",
            "--single",
            "--system-prompt-override",
            "--tools",
            "--verbatim",
            "--version",
            "--worktree",
            "--worktree-ref",
          ],
        }),
        trace: subcommand(
          ["trace"],
          "Inspect Grok trace data.",
          "read_only",
          ["--json", "--leader-socket", "--local", "--output"],
          { tier: "diagnostic" }
        ),
        update: subcommand(
          ["update"],
          "Update the Grok CLI binary.",
          "updates_binary",
          [
            "--alpha",
            "--check",
            "--force-reinstall",
            "--json",
            "--leader-socket",
            "--stable",
            "--version",
          ],
          { exposure: "not_exposed" }
        ),
        version: subcommand(
          ["version"],
          "Print Grok version information.",
          "read_only",
          ["--json", "--leader-socket"],
          { tier: "diagnostic" }
        ),
        worktree: subcommand(
          ["worktree"],
          "Manage Grok worktree sessions.",
          "writes_local_config",
          ["--leader-socket"]
        ),
      },
      GROK_DEBUG_HELP_FLAGS
    ),
    maxPositionals: 0,
    // Grok 0.2.77: `--fork-session`, `--json-schema`, and `--worktree-ref` are
    // now wired through the request path (see flags + prepareGrokRequest), so
    // they live in the argv allowlist, not here. `--session-id` is advertised
    // but intentionally NOT wired: the gateway owns grok session-id lifecycle
    // (it generates and tracks IDs), so letting a caller inject a specific
    // new-conversation UUID would collide with that tracking and with the
    // cross-principal session-isolation guarantees. Acknowledge-only.
    acknowledgedUpstreamFlags: [...GROK_DEBUG_HELP_FLAGS, "--session-id"],
    mcpTools: ["grok_request", "grok_request_async"],
    mcpParameters: [
      "prompt",
      "model",
      "outputFormat",
      "sessionId",
      "resumeLatest",
      "createNewSession",
      "alwaysApprove",
      "permissionMode",
      "effort",
      "reasoningEffort",
      "approvalStrategy",
      "mcpServers",
      "allowedTools",
      "disallowedTools",
      // Phase 4 slice δ
      "maxTurns",
      // Phase 4 slice ζ
      "workingDir",
      // Phase 4 slice θ — Grok HIGH parity
      "sandbox",
      "rules",
      "systemPromptOverride",
      "allow",
      "deny",
      // Grok 0.2.x context/compaction controls
      "compactionMode",
      "compactionDetail",
      // Grok 0.2.x headless controls (advertised on `grok --help`)
      "agent",
      "bestOfN",
      "check",
      "disableWebSearch",
      "todoGate",
      "verbatim",
      // Grok 0.2.x help-surface flags (contract fixtures in grok-current-help-surface)
      "agents",
      "promptFile",
      "promptJson",
      "single",
      "experimentalMemory",
      "noAltScreen",
      "noMemory",
      "noPlan",
      "noSubagents",
      "oauth",
      "restoreCode",
      "leaderSocket",
      "nativeWorktree",
      // Grok 0.2.77 wired parity flags
      "worktreeRef",
      "forkSession",
      "jsonSchema",
    ],
    flags: {
      "-p": { arity: "one", description: "Prompt text" },
      "--model": { arity: "one", description: "Model selector" },
      "--output-format": {
        arity: "one",
        values: ["plain", "json", "streaming-json"],
        description: "Output format",
      },
      "--always-approve": { arity: "none", description: "Approve tool use automatically" },
      "--permission-mode": {
        arity: "one",
        values: PERMISSION_MODES,
        description: "Permission mode",
      },
      "--effort": { arity: "one", values: EFFORT_LEVELS, description: "Reasoning effort" },
      "--reasoning-effort": { arity: "one", description: "Reasoning effort override" },
      "--tools": { arity: "one", description: "Comma-separated allowed tools" },
      "--disallowed-tools": {
        arity: "one",
        description: "Comma-separated disallowed tools",
      },
      "--resume": {
        arity: "optional",
        description: "Resume session by ID, or most recent when omitted",
      },
      "--continue": { arity: "none", description: "Continue latest session" },
      "--max-turns": {
        arity: "one",
        pattern: /^[1-9][0-9]*$/,
        description: "Agent-loop iteration cap (Phase 4 slice δ)",
      },
      "--cwd": {
        arity: "one",
        description: "Working directory for the invocation (Phase 4 slice ζ)",
      },
      // Phase 4 slice θ — Grok HIGH parity. `--sandbox` is freeform per
      // `grok --help` on 0.1.210 (no `[possible values: …]` list, unlike
      // --effort / --permission-mode / --output-format), so we register
      // it without a `values` constraint.
      "--sandbox": {
        arity: "one",
        description:
          "Sandbox profile for filesystem + network access (Phase 4 slice θ; freeform passthrough; env: GROK_SANDBOX)",
      },
      "--rules": {
        arity: "one",
        description:
          "Extra rules appended to the system prompt; supports `@file` prefix (Phase 4 slice θ)",
      },
      "--system-prompt-override": {
        arity: "one",
        description: "Replace the agent's system prompt entirely (Phase 4 slice θ)",
      },
      "--allow": {
        arity: "one",
        description:
          "Permission allow rule (Phase 4 slice θ; repeat once per rule per `grok --help`)",
      },
      "--deny": {
        arity: "one",
        description:
          "Permission deny rule (Phase 4 slice θ; repeat once per rule per `grok --help`)",
      },
      "--agent": { arity: "one", description: "Agent name or definition file path" },
      "--agents": { arity: "one", description: "Inline subagent definitions JSON" },
      "--best-of-n": {
        arity: "one",
        pattern: /^[1-9][0-9]*$/,
        description: "Run the task N ways in parallel and pick the best",
      },
      "--check": { arity: "none", description: "Append a self-verification loop" },
      "--disable-web-search": {
        arity: "none",
        description: "Disable web search and remote retrieval tools",
      },
      "--experimental-memory": { arity: "none", description: "Enable cross-session memory" },
      "--no-alt-screen": { arity: "none", description: "Run inline without alt screen" },
      "--no-memory": { arity: "none", description: "Disable cross-session memory" },
      "--no-plan": { arity: "none", description: "Disable plan mode" },
      "--no-subagents": { arity: "none", description: "Disable subagent spawning" },
      "--oauth": { arity: "none", description: "Use OAuth during authentication" },
      "--prompt-file": { arity: "one", description: "Single-turn prompt from a file" },
      "--prompt-json": { arity: "one", description: "Single-turn prompt JSON blocks" },
      "--restore-code": {
        arity: "none",
        description: "Check out the original session commit when resuming",
      },
      // Grok 0.2.32: custom leader socket path for isolated leader processes
      // (default ~/.grok/leader.sock; propagated via GROK_LEADER_SOCKET).
      "--leader-socket": {
        arity: "one",
        description: "Custom leader socket path (isolated leader, Grok 0.2.32+)",
      },
      "--single": { arity: "one", description: "Single-turn prompt" },
      "--todo-gate": {
        arity: "none",
        description:
          "Enable runtime turn-end TodoGate (accepted at 0.2.60+ but hidden from --help)",
        hiddenFromHelp: true,
      },
      "--verbatim": { arity: "none", description: "Send prompt exactly as given" },
      "--version": { arity: "none", description: "Print version" },
      "--worktree": {
        arity: "optional",
        description: "Start the session in a new git worktree, optionally named",
      },
      // Grok 0.2.77: branch/tag/commit to base the worktree on (with --worktree;
      // defaults to current HEAD). Gateway emits it only alongside nativeWorktree.
      "--worktree-ref": {
        arity: "one",
        description: "Git ref to base the worktree on (requires --worktree)",
      },
      // Grok 0.2.77: when resuming, create a new session ID instead of reusing
      // the original (mirrors Claude --fork-session).
      "--fork-session": {
        arity: "none",
        description: "Fork the resumed session into a new session ID",
      },
      // Grok 0.2.77: constrain output to a JSON Schema (implies --output-format
      // json). Mirrors Claude/Codex structured-output parity.
      "--json-schema": {
        arity: "one",
        description: "JSON Schema literal constraining structured output (implies json output)",
      },
      // Grok 0.2.x context/compaction controls (both enum, env-backed).
      // As of 0.2.60 these are accepted by the runtime but omitted from --help
      // output; mark hiddenFromHelp so the installed probe does not flag drift.
      "--compaction-mode": {
        arity: "one",
        values: ["summary", "transcript", "segments"],
        description:
          "Compaction mode (default summary; sets GROK_COMPACTION_MODE). `segments` persists per-segment markdown.",
        hiddenFromHelp: true,
      },
      "--compaction-detail": {
        arity: "one",
        values: ["none", "minimal", "balanced", "verbose"],
        description:
          "Segment verbatim detail (default verbose; sets GROK_COMPACTION_DETAIL). Only affects `--compaction-mode segments`.",
        hiddenFromHelp: true,
      },
    },
    env: {},
    conformanceFixtures: [
      {
        id: "grok-minimal",
        description: "Minimal prompt request",
        args: ["-p", "hello"],
        expect: "pass",
      },
      {
        id: "grok-unsupported-flag",
        description: "Unsupported flag is rejected before spawn",
        args: ["-p", "hello", "--not-a-grok-flag"],
        expect: "fail",
      },
      {
        id: "grok-max-turns",
        description: "Phase 4 slice δ: --max-turns N is accepted",
        args: ["-p", "hello", "--max-turns", "5"],
        expect: "pass",
      },
      {
        id: "grok-max-turns-invalid-zero",
        description: "Phase 4 slice δ: --max-turns 0 is rejected by contract pattern",
        args: ["-p", "hello", "--max-turns", "0"],
        expect: "fail",
      },
      {
        id: "grok-working-dir",
        description: "Phase 4 slice ζ: --cwd <DIR> is accepted",
        args: ["-p", "hello", "--cwd", "/tmp/work"],
        expect: "pass",
      },
      {
        id: "grok-sandbox",
        description: "Phase 4 slice θ: --sandbox <PROFILE> accepted (freeform)",
        args: ["-p", "hello", "--sandbox", "workspace-write"],
        expect: "pass",
      },
      {
        id: "grok-rules",
        description: "Phase 4 slice θ: --rules <RULES> accepted (@file prefix preserved)",
        args: ["-p", "hello", "--rules", "@./rules.md"],
        expect: "pass",
      },
      {
        id: "grok-system-prompt-override",
        description: "Phase 4 slice θ: --system-prompt-override <PROMPT> accepted",
        args: ["-p", "hello", "--system-prompt-override", "You are a tester"],
        expect: "pass",
      },
      {
        id: "grok-allow-repeated",
        description: "Phase 4 slice θ: repeated --allow <RULE> accepted",
        args: ["-p", "hello", "--allow", "bash", "--allow", "edit"],
        expect: "pass",
      },
      {
        id: "grok-deny-repeated",
        description: "Phase 4 slice θ: repeated --deny <RULE> accepted",
        args: ["-p", "hello", "--deny", "write", "--deny", "kill"],
        expect: "pass",
      },
      {
        id: "grok-current-help-surface",
        description:
          "Current Grok Build help advertises agent, prompt, memory, web, and worktree flags",
        args: [
          "-p",
          "hello",
          "--agent",
          "reviewer",
          "--agents",
          "{}",
          "--best-of-n",
          "2",
          "--check",
          "--disable-web-search",
          "--experimental-memory",
          "--no-alt-screen",
          "--no-memory",
          "--no-plan",
          "--no-subagents",
          "--oauth",
          "--prompt-file",
          "/tmp/prompt.md",
          "--prompt-json",
          "[]",
          "--restore-code",
          "--leader-socket",
          "/tmp/leader.sock",
          "--single",
          "single prompt",
          "--todo-gate",
          "--verbatim",
          "--version",
          "--worktree",
          "--compaction-mode",
          "summary",
          "--compaction-detail",
          "balanced",
        ],
        expect: "pass",
      },
      {
        id: "grok-compaction",
        description:
          "Grok 0.2.x: --compaction-mode and --compaction-detail accepted with valid enum values",
        args: ["-p", "hello", "--compaction-mode", "segments", "--compaction-detail", "balanced"],
        expect: "pass",
      },
      {
        id: "grok-compaction-mode-invalid",
        description: "Grok --compaction-mode rejects a value outside the contract enum",
        args: ["-p", "hello", "--compaction-mode", "aggressive"],
        expect: "fail",
      },
      {
        id: "grok-resume-bare",
        description: "Grok --resume without session ID is accepted (optional arity)",
        args: ["-p", "hello", "--resume"],
        expect: "pass",
      },
      {
        id: "grok-headless-controls",
        description:
          "Grok 0.2.x headless flags: agent, best-of-n, check, disable-web-search, todo-gate, verbatim",
        args: [
          "-p",
          "hello",
          "--agent",
          "reviewer",
          "--best-of-n",
          "3",
          "--check",
          "--disable-web-search",
          "--todo-gate",
          "--verbatim",
        ],
        expect: "pass",
      },
      {
        id: "grok-leader-socket",
        description: "Grok 0.2.32: --leader-socket <PATH> is accepted",
        args: ["-p", "hello", "--leader-socket", "/home/user/.grok/leader-branch.sock"],
        expect: "pass",
      },
      {
        id: "grok-leader-socket-missing-value",
        description: "Grok 0.2.32: --leader-socket without a path is rejected (arity one)",
        args: ["-p", "hello", "--leader-socket"],
        expect: "fail",
      },
      {
        id: "grok-0.2.38-agent-surface",
        description:
          "Grok 0.2.38: top-level --agent + --leader-socket co-occurrence accepted (dated example using flags current at 0.2.38; the agent subcommand expansion flags e.g. --agent-profile/--reauth/--grok-ws-* are listed in the subcommand contract declaration for --probe-installed drift tracking and are not part of this primary-path fixture's argv)",
        args: ["-p", "hello", "--agent", "reviewer", "--leader-socket", "/tmp/leader.sock"],
        expect: "pass",
      },
      {
        id: "grok-json-schema-wired",
        description:
          "Grok 0.2.77: --json-schema <SCHEMA> is wired (structured output, implies json)",
        args: [
          "-p",
          "hello",
          "--json-schema",
          '{"type":"object","properties":{"name":{"type":"string"}}}',
        ],
        expect: "pass",
      },
      {
        id: "grok-fork-session-wired",
        description: "Grok 0.2.77: --fork-session is wired (fork resumed session into a new ID)",
        args: ["-p", "hello", "--resume", "sess-1", "--fork-session"],
        expect: "pass",
      },
      {
        id: "grok-worktree-ref-wired",
        description: "Grok 0.2.77: --worktree-ref <REF> is wired (with --worktree)",
        args: ["-p", "hello", "--worktree", "--worktree-ref", "main"],
        expect: "pass",
      },
      {
        id: "grok-session-id-acknowledged-not-emitted",
        description:
          "Grok 0.2.77 advertises --session-id, but the gateway owns session-id lifecycle and does not emit it; caller argv is rejected",
        args: ["-p", "hello", "--session-id", "11111111-1111-1111-1111-111111111111"],
        expect: "fail",
      },
    ],
  },
  mistral: {
    cli: "mistral",
    executable: "vibe",
    upstream: "Mistral Vibe CLI",
    upstreamMetadata: {
      sourceUrls: ["https://api.github.com/repos/mistralai/mistral-vibe/releases/latest"],
      packageName: "mistral-vibe",
      repo: "https://github.com/mistralai/mistral-vibe",
      installDocsUrl: "https://github.com/mistralai/mistral-vibe#installation",
      releaseChannel: "pypi",
      watchCategories: ["flags", "agent-modes", "session-logging", "output-formats", "env-model"],
    },
    helpArgs: [["--help"]],
    subcommands: {},
    maxPositionals: 0,
    mcpTools: ["mistral_request", "mistral_request_async"],
    mcpParameters: [
      "prompt",
      "model",
      "outputFormat",
      "sessionId",
      "resumeLatest",
      "createNewSession",
      "permissionMode",
      "approvalStrategy",
      "mcpServers",
      "allowedTools",
      "disallowedTools",
      // Phase 4 slice γ
      "trust",
      // Phase 4 slice δ
      "maxTurns",
      "maxPrice",
      "maxTokens",
      // Phase 4 slice ζ
      "workingDir",
      "addDir",
    ],
    flags: {
      "-p": { arity: "one", description: "Prompt text (programmatic mode)" },
      "--prompt": {
        arity: "optional",
        description: "Programmatic prompt (long form of -p; TEXT optional per vibe --help)",
      },
      "-v": { arity: "none", description: "Print version (short)" },
      "--version": { arity: "none", description: "Print version" },
      "--setup": { arity: "none", description: "Setup API key and exit" },
      "--output": {
        arity: "one",
        values: ["text", "json", "streaming"],
        description: "Output format",
      },
      "--agent": {
        arity: "one",
        // No fixed value set: Vibe resolves `--agent <name>` against its own
        // registry (builtins default/plan/accept-edits/auto-approve, install-gated
        // builtins like `lean`, and custom agents from ~/.vibe/agents). Pinning a
        // closed list here would reject valid install-gated/custom agents.
        description: "Agent/permission mode (builtin, install-gated, or custom agent name)",
      },
      // NOTE: vibe has no reasoning-effort surface. `--effort` / `--reasoning-effort`
      // were declared speculatively (mirroring Grok) in the provider-modernisation
      // commit but were never accepted by the CLI: vibe 2.x argparse hard-rejects them
      // ("error: unrecognized arguments: --effort"), failing the whole request before
      // any model call. Removed from the contract, builder, and request schema; the
      // mistral-effort-rejected / mistral-reasoning-effort-rejected fixtures lock it in.
      "--enabled-tools": { arity: "one", description: "Enabled tool" },
      "--resume": {
        arity: "optional",
        description: "Resume session by ID, or interactive picker when omitted",
      },
      "--continue": { arity: "none", description: "Continue latest session" },
      "--trust": {
        arity: "none",
        description: "Trust cwd for this invocation only (Phase 4 slice γ)",
      },
      "--max-turns": {
        arity: "one",
        pattern: /^[1-9][0-9]*$/,
        description: "Agent-loop iteration cap (Phase 4 slice δ, programmatic mode only)",
      },
      "--max-price": {
        arity: "one",
        // Decimal-only: matches the MAX_PRICE_SCHEMA min(1e-6) lower bound
        // that keeps String(N) in decimal form (no scientific notation).
        pattern: /^(0|[1-9][0-9]*)(\.[0-9]+)?$/,
        description: "Cumulative cost cap in USD (Phase 4 slice δ, programmatic mode only)",
      },
      "--max-tokens": {
        arity: "one",
        pattern: /^[1-9][0-9]*$/,
        description: "Cumulative prompt + completion token cap (Vibe 2.x programmatic mode)",
      },
      "--workdir": {
        arity: "one",
        description: "Working directory for the invocation (Phase 4 slice ζ)",
      },
      "--add-dir": {
        arity: "one",
        description:
          "Additional writable workspace directory (Phase 4 slice ζ; repeat once per directory)",
      },
    },
    // These exist in Vibe's help but are not gateway request-time surfaces.
    // `--auto-approve` / `--yolo` are shortcuts for `--agent auto-approve`, and
    // `--check-upgrade` prompts for a binary update. Keep them acknowledged but
    // absent from the argv allowlist so drift detection stays quiet while
    // validateUpstreamCliArgs still rejects them as caller argv.
    acknowledgedUpstreamFlags: ["--auto-approve", "--check-upgrade", "--yolo"],
    env: {
      VIBE_ACTIVE_MODEL: {
        arity: "one",
        pattern: /^[^\s\u0000-\u001f\u007f]+$/,
        description: "Active model selector; Vibe uses env instead of a --model flag",
      },
    },
    conformanceFixtures: [
      {
        id: "mistral-minimal",
        description: "Minimal prompt request with env-selected model",
        args: ["-p", "hello", "--agent", "auto-approve"],
        env: { VIBE_ACTIVE_MODEL: "mistral-medium-3.5" },
        expect: "pass",
      },
      {
        id: "mistral-unsupported-env",
        description: "Unsupported env var is rejected before spawn",
        args: ["-p", "hello"],
        env: { CODEX_MODEL: "gpt-5.5" },
        expect: "fail",
      },
      {
        id: "mistral-trust",
        description: "Phase 4 slice γ: --trust is accepted",
        args: ["-p", "hello", "--agent", "auto-approve", "--trust"],
        env: { VIBE_ACTIVE_MODEL: "mistral-medium-3.5" },
        expect: "pass",
      },
      {
        id: "mistral-max-turns-and-price",
        description: "Phase 4 slice δ: --max-turns + --max-price are accepted together",
        args: ["-p", "hello", "--agent", "auto-approve", "--max-turns", "3", "--max-price", "0.01"],
        env: { VIBE_ACTIVE_MODEL: "mistral-medium-3.5" },
        expect: "pass",
      },
      {
        id: "mistral-output-streaming-and-max-tokens",
        description: "Vibe 2.x: --output streaming and --max-tokens are accepted",
        args: [
          "-p",
          "hello",
          "--agent",
          "auto-approve",
          "--output",
          "streaming",
          "--max-tokens",
          "1000",
        ],
        env: { VIBE_ACTIVE_MODEL: "mistral-medium-3.5" },
        expect: "pass",
      },
      {
        id: "mistral-max-price-scientific-notation",
        description:
          "Phase 4 slice δ: scientific-notation --max-price is rejected by contract pattern (matches MAX_PRICE_SCHEMA bounds)",
        args: ["-p", "hello", "--agent", "auto-approve", "--max-price", "1e-7"],
        env: { VIBE_ACTIVE_MODEL: "mistral-medium-3.5" },
        expect: "fail",
      },
      {
        id: "mistral-working-dir",
        description: "Phase 4 slice ζ: --workdir <DIR> is accepted",
        args: ["-p", "hello", "--agent", "auto-approve", "--workdir", "/tmp/work"],
        env: { VIBE_ACTIVE_MODEL: "mistral-medium-3.5" },
        expect: "pass",
      },
      {
        id: "mistral-add-dir",
        description: "Phase 4 slice ζ: repeated --add-dir is accepted",
        args: [
          "-p",
          "hello",
          "--agent",
          "auto-approve",
          "--add-dir",
          "/tmp/a",
          "--add-dir",
          "/tmp/b",
        ],
        env: { VIBE_ACTIVE_MODEL: "mistral-medium-3.5" },
        expect: "pass",
      },
      {
        id: "mistral-effort-rejected",
        description:
          "vibe 2.x advertises no reasoning-effort surface: a raw --effort arg is rejected by the contract (mirrors the CLI's own 'unrecognized arguments' failure)",
        args: ["-p", "hello", "--agent", "auto-approve", "--effort", "high"],
        env: { VIBE_ACTIVE_MODEL: "mistral-medium-3.5" },
        expect: "fail",
      },
      {
        id: "mistral-reasoning-effort-rejected",
        description: "vibe 2.x: a raw --reasoning-effort arg is rejected by the contract",
        args: ["-p", "hello", "--agent", "auto-approve", "--reasoning-effort", "medium"],
        env: { VIBE_ACTIVE_MODEL: "mistral-medium-3.5" },
        expect: "fail",
      },
      {
        id: "mistral-current-help-surface",
        description:
          "Vibe 2.18.3 request-time help surface: --prompt, -v, --version, --setup accepted",
        args: ["--prompt", "hello", "--agent", "auto-approve", "-v", "--version", "--setup"],
        env: { VIBE_ACTIVE_MODEL: "mistral-medium-3.5" },
        expect: "pass",
      },
      {
        id: "mistral-yolo-shortcut-rejected",
        description:
          "Vibe 2.18.3 advertises --yolo as a shortcut, but the gateway keeps using explicit --agent auto-approve",
        args: ["-p", "hello", "--yolo"],
        env: { VIBE_ACTIVE_MODEL: "mistral-medium-3.5" },
        expect: "fail",
      },
      {
        id: "mistral-check-upgrade-rejected",
        description:
          "Vibe 2.18.3 advertises --check-upgrade, but gateway request validation rejects update-prompt flags",
        args: ["--check-upgrade"],
        env: { VIBE_ACTIVE_MODEL: "mistral-medium-3.5" },
        expect: "fail",
      },
      {
        id: "mistral-resume-bare",
        description: "Vibe --resume without session ID is accepted (optional arity)",
        args: ["-p", "hello", "--agent", "auto-approve", "--resume"],
        env: { VIBE_ACTIVE_MODEL: "mistral-medium-3.5" },
        expect: "pass",
      },
    ],
  },
  devin: {
    cli: "devin",
    executable: "devin",
    upstream: "Cognition Devin CLI",
    upstreamMetadata: {
      sourceUrls: ["https://cli.devin.ai/docs/reference/commands", "https://docs.devin.ai/cli"],
      packageName: "devin",
      installDocsUrl: "https://docs.devin.ai/cli",
      releaseChannel: "vendor",
      watchCategories: ["flags", "subcommands", "permission-modes", "acp-entrypoint"],
    },
    helpArgs: [["--help"]],
    subcommands: {},
    maxPositionals: 0,
    mcpTools: ["devin_request", "devin_request_async"],
    mcpParameters: [
      "prompt",
      "model",
      "permissionMode",
      "sessionId",
      "resumeLatest",
      "createNewSession",
      "promptFile",
      "config",
      "sandbox",
      "exportSession",
      "respectWorkspaceTrust",
      "agentConfig",
    ],
    // The gateway emits headless print-mode argv only, and only the flags below.
    // `-p` always carries the prompt (arity one); session continuity uses the
    // shared --resume/--continue surface (resolveGrokSessionArgs).
    flags: {
      "-p": {
        arity: "one",
        description: "Print response and exit (non-interactive); prompt value",
      },
      "--model": { arity: "one", description: "AI model for this session" },
      "--permission-mode": {
        arity: "one",
        // Verified against devin 2026.7.23 (3bd47f77): `auto`, `smart`, `dangerous`.
        values: ["auto", "smart", "dangerous"],
        description:
          "Permission mode (auto = read-only auto-approve; smart = additionally auto-runs safe actions per fast model; dangerous = approve all)",
      },
      "--prompt-file": { arity: "one", description: "Load the initial prompt from a file" },
      "--config": { arity: "one", description: "Config file path" },
      "--sandbox": { arity: "none", description: "Run the session in a sandbox" },
      "--export": {
        arity: "optional",
        description: "Export the session (optional output path; bare flag uses the default)",
      },
      "--respect-workspace-trust": {
        arity: "optional",
        values: ["true", "false"],
        description:
          "Respect workspace trust (defaults true for interactive, false for print mode)",
      },
      "--agent-config": { arity: "one", description: "Agent config file path" },
      "--resume": { arity: "one", description: "Resume a specific session by ID" },
      "--continue": { arity: "none", description: "Resume the most recent session in cwd" },
    },
    // Devin flags the gateway deliberately does not emit (or are for interactive/cloud use).
    // Probe acknowledgement only. (--config/--sandbox/--export/--respect-workspace-trust/
    // --agent-config graduated to the flags allowlist as wired request fields.)
    acknowledgedUpstreamFlags: ["--print", "--version"],
    env: {},
    conformanceFixtures: [
      {
        id: "devin-minimal",
        description: "Minimal print-mode prompt request",
        args: ["-p", "hello"],
        expect: "pass",
      },
      {
        id: "devin-unsupported-flag",
        description: "Unsupported flag is rejected before spawn",
        args: ["-p", "hello", "--not-a-devin-flag"],
        expect: "fail",
      },
      {
        id: "devin-model",
        description: "--model is accepted",
        args: ["-p", "hello", "--model", "opus"],
        expect: "pass",
      },
      {
        id: "devin-permission-mode",
        description: "Valid --permission-mode 'dangerous' accepted",
        args: ["-p", "hello", "--permission-mode", "dangerous"],
        expect: "pass",
      },
      {
        id: "devin-permission-mode-auto",
        description: "Valid --permission-mode 'auto' accepted",
        args: ["-p", "hello", "--permission-mode", "auto"],
        expect: "pass",
      },
      {
        id: "devin-permission-mode-smart",
        description: "Valid --permission-mode 'smart' accepted",
        args: ["-p", "hello", "--permission-mode", "smart"],
        expect: "pass",
      },
      {
        id: "devin-permission-mode-invalid",
        description: "Invalid --permission-mode value rejected by contract",
        args: ["-p", "hello", "--permission-mode", "ludicrous"],
        expect: "fail",
      },
      {
        id: "devin-prompt-file",
        description: "--prompt-file is accepted",
        args: ["-p", "hello", "--prompt-file", "/tmp/prompt.txt"],
        expect: "pass",
      },
      {
        id: "devin-resume",
        description: "Resume by session id accepted",
        args: ["-p", "hello", "--resume", "abc12345"],
        expect: "pass",
      },
      {
        id: "devin-config",
        description: "--config path is accepted",
        args: ["-p", "hello", "--config", "/tmp/devin.toml"],
        expect: "pass",
      },
      {
        id: "devin-sandbox",
        description: "--sandbox (bare flag) is accepted",
        args: ["-p", "hello", "--sandbox"],
        expect: "pass",
      },
      {
        id: "devin-export-bare",
        description: "--export as a bare flag (no path) is accepted",
        args: ["-p", "hello", "--export"],
        expect: "pass",
      },
      {
        id: "devin-export-path",
        description: "--export with an output path is accepted",
        args: ["-p", "hello", "--export", "/tmp/session.json"],
        expect: "pass",
      },
      {
        id: "devin-respect-workspace-trust",
        description: "--respect-workspace-trust with an explicit boolean is accepted",
        args: ["-p", "hello", "--respect-workspace-trust", "true"],
        expect: "pass",
      },
      {
        id: "devin-respect-workspace-trust-invalid",
        description: "--respect-workspace-trust with a non-boolean value is rejected",
        args: ["-p", "hello", "--respect-workspace-trust", "maybe"],
        expect: "fail",
      },
      {
        id: "devin-agent-config",
        description: "--agent-config path is accepted",
        args: ["-p", "hello", "--agent-config", "/tmp/agent.toml"],
        expect: "pass",
      },
    ],
  },
  cursor: {
    cli: "cursor",
    executable: "cursor-agent",
    upstream: "Cursor Agent CLI",
    upstreamMetadata: {
      sourceUrls: [
        "https://cursor.com/cli",
        "https://cursor.com/docs/cli/acp",
        "https://cursor.com/docs/cli/reference/parameters",
      ],
      packageName: "cursor-agent",
      installDocsUrl: "https://cursor.com/cli",
      releaseChannel: "vendor",
      watchCategories: [
        "flags",
        "subcommands",
        "session-resume",
        "execution-modes",
        "acp-entrypoint",
      ],
    },
    helpArgs: [["--help"]],
    subcommands: {},
    maxPositionals: 1,
    mcpTools: ["cursor_request", "cursor_request_async"],
    mcpParameters: [
      "prompt",
      "model",
      "mode",
      "outputFormat",
      "force",
      "autoReview",
      "sandbox",
      "trust",
      "workspace",
      "addDir",
      "sessionId",
      "resumeLatest",
      "createNewSession",
    ],
    flags: {
      "--print": {
        arity: "none",
        description: "Print responses to console for scripts/non-interactive use",
      },
      "--output-format": {
        arity: "one",
        values: ["text", "json", "stream-json"],
        description: "Output format for --print mode",
      },
      "--model": { arity: "one", description: "Model to use for the session" },
      "--mode": {
        arity: "one",
        values: ["plan", "ask"],
        description: "Execution mode (plan or ask)",
      },
      "--force": { arity: "none", description: "Force allow commands unless denied" },
      "--auto-review": { arity: "none", description: "Use Cursor Smart Auto-review" },
      "--sandbox": {
        arity: "one",
        values: ["enabled", "disabled"],
        description: "Enable or disable Cursor sandbox mode",
      },
      "--trust": { arity: "none", description: "Trust workspace in headless mode" },
      "--workspace": { arity: "one", description: "Workspace directory or saved workspace" },
      "--add-dir": { arity: "one", description: "Additional workspace root directory" },
      "--resume": { arity: "one", description: "Resume a specific Cursor chat/session" },
      "--continue": { arity: "none", description: "Continue the latest Cursor chat" },
    },
    acknowledgedUpstreamFlags: [
      "--api-key",
      "--header",
      "-H",
      "-p",
      "--plan",
      "--yolo",
      "--approve-mcps",
      "--plugin-dir",
      "--worktree",
      "-w",
      "--worktree-base",
      "--skip-worktree-setup",
      "--stream-partial-output",
      "--list-models",
      "--version",
      "-v",
      "--help",
      "-h",
    ],
    env: {
      CURSOR_API_KEY: {
        arity: "one",
        description: "Cursor Agent API key for headless authentication",
      },
    },
    conformanceFixtures: [
      {
        id: "cursor-minimal",
        description: "Minimal print-mode prompt request",
        args: ["--print", "hello"],
        expect: "pass",
      },
      {
        id: "cursor-output-format",
        description: "--output-format json is accepted",
        args: ["--print", "--output-format", "json", "hello"],
        expect: "pass",
      },
      {
        id: "cursor-mode",
        description: "--mode plan is accepted",
        args: ["--print", "--mode", "plan", "hello"],
        expect: "pass",
      },
      {
        id: "cursor-high-impact-controls",
        description:
          "Model, force, auto-review, sandbox, trust, and workspace controls are accepted",
        args: [
          "--print",
          "--model",
          "gpt-5",
          "--force",
          "--auto-review",
          "--sandbox",
          "enabled",
          "--trust",
          "--workspace",
          "/tmp/workspace",
          "hello",
        ],
        expect: "pass",
      },
      {
        id: "cursor-mode-invalid",
        description: "Invalid --mode is rejected",
        args: ["--print", "--mode", "dangerous", "hello"],
        expect: "fail",
      },
      {
        id: "cursor-resume",
        description: "Resume by chat id accepted",
        args: ["--print", "--resume", "chat-123", "hello"],
        expect: "pass",
      },
      {
        id: "cursor-add-dir",
        description: "Repeatable --add-dir is accepted",
        args: ["--print", "--add-dir", "/tmp/extra", "hello"],
        expect: "pass",
      },
      {
        id: "cursor-unsupported-flag",
        description: "Unsupported flag is rejected before spawn",
        args: ["--print", "--not-a-cursor-flag", "hello"],
        expect: "fail",
      },
    ],
  },
};

export function validateUpstreamCliArgs(
  cli: CliType,
  args: readonly string[]
): ContractValidationResult {
  const contract = UPSTREAM_CLI_CONTRACTS[cli];
  const violations: ContractViolation[] = [];
  let i = 0;
  let resumeContext = false;
  const positionals: string[] = [];

  if (contract.command) {
    if (args[0] !== contract.command.requiredFirstArg) {
      violations.push({
        cli,
        arg: args[0],
        index: 0,
        message: `${cli} argv must start with "${contract.command.requiredFirstArg}"`,
      });
      return { ok: false, violations };
    }
    i = 1;
    if (args[i] === contract.command.optionalSecondArg) {
      resumeContext = true;
      i += 1;
    }
  }

  for (; i < args.length; i++) {
    const arg = args[i];
    const flag = contract.flags[arg];
    if (!flag) {
      if (arg.startsWith("-")) {
        violations.push({
          cli,
          arg,
          index: i,
          message: `Unsupported ${cli} CLI flag "${arg}" for bundled upstream contract`,
        });
      } else {
        positionals.push(arg);
      }
      continue;
    }

    if (resumeContext && contract.resumeForbiddenFlags?.includes(arg)) {
      violations.push({
        cli,
        arg,
        index: i,
        message: `${cli} flag "${arg}" is not accepted by the resume command contract`,
      });
    }
    if (!resumeContext && contract.resumeOnlyFlags?.includes(arg)) {
      violations.push({
        cli,
        arg,
        index: i,
        message: `${cli} flag "${arg}" is only valid with the resume command contract`,
      });
    }

    if (flag.arity === "none") {
      continue;
    }

    if (flag.arity === "one") {
      const value = args[i + 1];
      if (value === undefined) {
        violations.push({
          cli,
          arg,
          index: i,
          message: `${cli} flag "${arg}" requires one value`,
        });
        continue;
      }
      validateFlagValue(cli, arg, flag, value, i + 1, violations);
      i += 1;
      continue;
    }

    if (flag.arity === "optional") {
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith("-")) {
        validateFlagValue(cli, arg, flag, value, i + 1, violations);
        i += 1;
      }
      continue;
    }

    let consumed = 0;
    while (i + 1 < args.length && !args[i + 1].startsWith("-")) {
      validateFlagValue(cli, arg, flag, args[i + 1], i + 1, violations);
      i += 1;
      consumed += 1;
    }
    if (consumed === 0) {
      violations.push({
        cli,
        arg,
        index: i,
        message: `${cli} flag "${arg}" requires at least one value`,
      });
    }
  }

  const maxPositionals =
    resumeContext && contract.resumeMaxPositionals !== undefined
      ? contract.resumeMaxPositionals
      : contract.maxPositionals;
  if (positionals.length > maxPositionals) {
    violations.push({
      cli,
      message: `${cli} argv has ${positionals.length} positional values; upstream contract allows ${maxPositionals}`,
    });
  }

  return { ok: violations.length === 0, violations };
}

export function assertUpstreamCliArgs(cli: CliType, args: readonly string[]): void {
  const result = validateUpstreamCliArgs(cli, args);
  if (!result.ok) {
    const details = result.violations.map(v => v.message).join("; ");
    throw new Error(`Upstream ${cli} CLI contract violation: ${details}`);
  }
}

function subcommandKey(commandPath: readonly string[]): string {
  return commandPath.join(" ");
}

function subcommandResourceUri(cli: CliType, commandPath: readonly string[]): string {
  return `provider-subcommands://${cli}/${commandPath.map(encodeURIComponent).join("/")}`;
}

export function flattenCliSubcommands(
  subcommands: Record<string, CliSubcommandContract> | undefined
): CliSubcommandContract[] {
  const flattened: CliSubcommandContract[] = [];
  const visit = (node: CliSubcommandContract): void => {
    flattened.push(node);
    for (const child of Object.values(node.children ?? {})) visit(child);
  };
  for (const node of Object.values(subcommands ?? {})) visit(node);
  return flattened.sort((a, b) =>
    subcommandKey(a.commandPath).localeCompare(subcommandKey(b.commandPath))
  );
}

export function getCliSubcommandContract(
  cli: CliType,
  commandPath: readonly string[]
): CliSubcommandContract | null {
  const wanted = subcommandKey(commandPath);
  return (
    flattenCliSubcommands(UPSTREAM_CLI_CONTRACTS[cli].subcommands).find(
      contract => subcommandKey(contract.commandPath) === wanted
    ) ?? null
  );
}

function serializeFlagContract(flag: CliFlagContract): Record<string, unknown> {
  return {
    arity: flag.arity,
    values: flag.values ?? null,
    pattern: flag.pattern?.source ?? null,
    description: flag.description,
    hiddenFromHelp: flag.hiddenFromHelp ?? false,
  };
}

export function serializeCliSubcommandContract(
  cli: CliType,
  contract: CliSubcommandContract
): Record<string, unknown> {
  return {
    provider: cli,
    commandPath: contract.commandPath,
    helpArgs: contract.helpArgs,
    flags: Object.fromEntries(
      Object.entries(contract.flags).map(([name, flag]) => [name, serializeFlagContract(flag)])
    ),
    maxPositionals: contract.maxPositionals,
    aliases: contract.aliases ?? [],
    children: Object.values(contract.children ?? {}).map(child => ({
      commandPath: child.commandPath,
      summary: child.summary,
      resourceUri: subcommandResourceUri(cli, child.commandPath),
    })),
    risk: contract.risk,
    exposure: contract.exposure,
    tier: contract.tier,
    tokenCost: contract.tokenCost,
    summary: contract.summary,
    conformanceFixtures: contract.conformanceFixtures.map(fixture => ({
      id: fixture.id,
      description: fixture.description,
      expect: fixture.expect,
    })),
    resourceUri: subcommandResourceUri(cli, contract.commandPath),
  };
}

export function listProviderSubcommands(
  options: {
    provider?: CliType;
    tier?: CliSubcommandTier;
    risk?: CliSubcommandRisk;
    exposure?: CliSubcommandExposure;
    commandPathPrefix?: readonly string[];
  } = {}
): ProviderSubcommandCatalogRow[] {
  const providers = options.provider
    ? [options.provider]
    : (Object.keys(UPSTREAM_CLI_CONTRACTS) as CliType[]);
  const prefix = options.commandPathPrefix ?? [];
  const rows: ProviderSubcommandCatalogRow[] = [];
  for (const provider of providers) {
    for (const contract of flattenCliSubcommands(UPSTREAM_CLI_CONTRACTS[provider].subcommands)) {
      if (options.tier && contract.tier !== options.tier) continue;
      if (options.risk && contract.risk !== options.risk) continue;
      if (options.exposure && contract.exposure !== options.exposure) continue;
      if (
        prefix.length > 0 &&
        !prefix.every((part, index) => contract.commandPath[index] === part)
      ) {
        continue;
      }
      rows.push({
        provider,
        commandPath: contract.commandPath,
        aliases: contract.aliases ?? [],
        tier: contract.tier,
        risk: contract.risk,
        exposure: contract.exposure,
        tokenCost: contract.tokenCost,
        summary:
          contract.summary.length > 48
            ? `${contract.summary.slice(0, 45).trimEnd()}...`
            : contract.summary,
        driftStatus: "unknown",
        resourceUri: subcommandResourceUri(provider, contract.commandPath),
      });
    }
  }
  return rows.sort((a, b) =>
    `${a.provider}:${subcommandKey(a.commandPath)}`.localeCompare(
      `${b.provider}:${subcommandKey(b.commandPath)}`
    )
  );
}

export function buildProviderSubcommandsCompactCatalog(
  options: Parameters<typeof listProviderSubcommands>[0] = {}
): ProviderSubcommandCompactCatalog {
  return {
    schemaVersion: "provider-subcommands-catalog.v1",
    columns: [
      "provider",
      "commandPath",
      "aliases",
      "tier",
      "risk",
      "exposure",
      "tokenCost",
      "summary",
      "driftStatus",
      "resourceUri",
    ],
    rows: listProviderSubcommands(options).map(row => [
      row.provider,
      row.commandPath.join(" "),
      row.aliases.join(","),
      row.tier,
      row.risk,
      row.exposure,
      row.tokenCost,
      row.summary,
      row.driftStatus,
      row.resourceUri,
    ]),
  };
}

export function validateUpstreamCliSubcommandArgs(
  cli: CliType,
  commandPath: readonly string[],
  args: readonly string[]
): SubcommandContractValidationResult {
  const contract = getCliSubcommandContract(cli, commandPath);
  const violations: ContractViolation[] = [];
  if (!contract) {
    violations.push({
      cli,
      message: `${cli} subcommand "${subcommandKey(commandPath)}" is not declared in the upstream subcommand contract`,
    });
    return { ok: false, violations, commandPath };
  }

  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const flag = contract.flags[arg];
    if (!flag) {
      if (arg.startsWith("-")) {
        violations.push({
          cli,
          arg,
          index: i,
          message: `Unsupported ${cli} subcommand flag "${arg}" for ${subcommandKey(commandPath)}`,
        });
      } else {
        positionals.push(arg);
      }
      continue;
    }

    if (flag.arity === "none") continue;

    if (flag.arity === "one") {
      const value = args[i + 1];
      if (value === undefined) {
        violations.push({
          cli,
          arg,
          index: i,
          message: `${cli} subcommand flag "${arg}" requires one value`,
        });
        continue;
      }
      validateFlagValue(cli, arg, flag, value, i + 1, violations);
      i += 1;
      continue;
    }

    if (flag.arity === "optional") {
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith("-")) {
        validateFlagValue(cli, arg, flag, value, i + 1, violations);
        i += 1;
      }
      continue;
    }

    let consumed = 0;
    while (i + 1 < args.length && !args[i + 1].startsWith("-")) {
      validateFlagValue(cli, arg, flag, args[i + 1], i + 1, violations);
      i += 1;
      consumed += 1;
    }
    if (consumed === 0) {
      violations.push({
        cli,
        arg,
        index: i,
        message: `${cli} subcommand flag "${arg}" requires at least one value`,
      });
    }
  }

  if (positionals.length > contract.maxPositionals) {
    violations.push({
      cli,
      message: `${cli} subcommand "${subcommandKey(commandPath)}" has ${positionals.length} positional values; upstream subcommand contract allows ${contract.maxPositionals}`,
    });
  }

  return {
    ok: violations.length === 0,
    violations,
    commandPath,
    risk: contract.risk,
    exposure: contract.exposure,
    tier: contract.tier,
  };
}

export function validateUpstreamCliEnv(
  cli: CliType,
  env: Record<string, string> | undefined
): ContractValidationResult {
  if (!env || Object.keys(env).length === 0) return { ok: true, violations: [] };
  const contract = UPSTREAM_CLI_CONTRACTS[cli];
  const violations: ContractViolation[] = [];
  for (const [key, value] of Object.entries(env)) {
    const envContract = contract.env?.[key];
    if (!envContract) {
      violations.push({
        cli,
        arg: key,
        message: `Unsupported ${cli} CLI environment variable "${key}" for bundled upstream contract`,
      });
      continue;
    }
    validateFlagValue(cli, key, envContract, value, undefined, violations);
  }
  return { ok: violations.length === 0, violations };
}

export function assertUpstreamCliEnv(cli: CliType, env: Record<string, string> | undefined): void {
  const result = validateUpstreamCliEnv(cli, env);
  if (!result.ok) {
    const details = result.violations.map(v => v.message).join("; ");
    throw new Error(`Upstream ${cli} CLI environment contract violation: ${details}`);
  }
}

function validateFlagValue(
  cli: CliType,
  arg: string,
  flag: CliFlagContract,
  value: string,
  index: number | undefined,
  violations: ContractViolation[]
): void {
  if (flag.values && !flag.values.includes(value)) {
    violations.push({
      cli,
      arg: value,
      ...(index === undefined ? {} : { index }),
      message: `${cli} flag "${arg}" does not accept value "${value}"`,
    });
  }
  if (flag.pattern && !flag.pattern.test(value)) {
    violations.push({
      cli,
      arg: value,
      ...(index === undefined ? {} : { index }),
      message: `${cli} flag "${arg}" value "${value}" does not match required shape`,
    });
  }
}

/**
 * Best-effort, advisory-only extraction of long-form flags from raw --help text.
 * Returns a sorted array of unique `--foo-bar` style flags discovered in the output.
 *
 * Heuristics:
 * - Matches common option declaration lines emitted by clap, yargs, commander, custom TUIs, etc.
 * - Lowercases for stable comparison against our contract keys.
 * - Intentionally conservative: ignores obvious noise (URLs, prose in descriptions).
 *
 * This powers the bidirectional drift detector (extra flags the installed binary
 * advertises that our contract does not yet allow). It is NEVER used for argv
 * validation — only for the upstream scanner and `upstream_contracts` probe reports.
 */
export function extractDiscoveredFlags(helpText: string): readonly string[] {
  const discovered = new Set<string>();
  // Long flags: --foo, --foo-bar, --foo_bar (some CLIs normalize _ to - in display).
  // Only inspect option declaration lines so prose such as
  // "(Claude Code: --allowedTools)" does not create false drift.
  const longRe = /--([a-z0-9][a-z0-9_-]{1,}[a-z0-9]?)/g;
  for (const line of helpText.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("-")) continue;
    const declaration = trimmed.split(/\s{2,}/, 1)[0] ?? "";
    for (const match of declaration.matchAll(longRe)) {
      const name = `--${match[1].toLowerCase().replace(/_/g, "-")}`;
      if (name === "--help") continue;
      // Skip wrapped help fragments: a line-broken "--auto-\n approve" yields a
      // trailing-dash token (`--auto-`) that is not a real flag.
      if (name.endsWith("-")) continue;
      discovered.add(name);
    }
  }
  return Array.from(discovered).sort();
}

export interface FlagDriftResult {
  /** Contract flags absent from the installed binary's help (excluding `hiddenFromHelp` flags). */
  missingFlags: string[];
  /** Discovered flags neither declared in the contract nor acknowledged as upstream-only. */
  extraFlags: readonly string[];
  /** Discovered flags filtered from `extraFlags` via `acknowledgedUpstreamFlags`. */
  acknowledgedExtraFlags: readonly string[];
  /** Stale-marker diagnostics (hiddenFromHelp flag reappeared, acknowledged flag vanished). */
  warnings: string[];
}

/**
 * Pure drift computation between a declared contract and the flag surface
 * scraped from an installed binary's help output. Split out from
 * {@link probeInstalledCliContract} so the hidden/acknowledged semantics are
 * unit-testable without spawning real CLIs.
 */
export function computeFlagDrift(
  contract: CliContract,
  helpText: string,
  discoveredFlags: readonly string[]
): FlagDriftResult {
  const warnings: string[] = [];

  const missingFlags: string[] = [];
  for (const [flag, spec] of Object.entries(contract.flags)) {
    const inHelp = helpText.includes(flag);
    if (spec.hiddenFromHelp) {
      if (inHelp) {
        warnings.push(
          `${flag} is marked hiddenFromHelp but now appears in ${contract.executable} help output; remove the hiddenFromHelp marker from the contract`
        );
      }
      continue;
    }
    if (!inHelp) missingFlags.push(flag);
  }

  const contractFlagSet = new Set(Object.keys(contract.flags));
  const acknowledged = new Set(contract.acknowledgedUpstreamFlags ?? []);
  const extraFlags: string[] = [];
  const acknowledgedExtraFlags: string[] = [];
  for (const flag of discoveredFlags) {
    if (contractFlagSet.has(flag)) continue;
    if (acknowledged.has(flag)) {
      acknowledgedExtraFlags.push(flag);
    } else {
      extraFlags.push(flag);
    }
  }

  const discoveredSet = new Set(discoveredFlags);
  for (const flag of acknowledged) {
    if (!discoveredSet.has(flag)) {
      warnings.push(
        `acknowledged upstream flag ${flag} no longer appears in ${contract.executable} help output; remove it from acknowledgedUpstreamFlags`
      );
    }
  }

  return { missingFlags, extraFlags, acknowledgedExtraFlags, warnings };
}

export function computeSubcommandFlagDrift(
  contract: CliSubcommandContract,
  executable: string,
  helpText: string,
  discoveredFlags: readonly string[]
): FlagDriftResult {
  const warnings: string[] = [];

  const missingFlags: string[] = [];
  for (const [flag, spec] of Object.entries(contract.flags)) {
    const inHelp = helpText.includes(flag);
    if (spec.hiddenFromHelp) {
      if (inHelp) {
        warnings.push(
          `${subcommandKey(contract.commandPath)} ${flag} is marked hiddenFromHelp but now appears in ${executable} help output; remove the hiddenFromHelp marker from the subcommand contract`
        );
      }
      continue;
    }
    if (!inHelp) missingFlags.push(flag);
  }

  const contractFlagSet = new Set(Object.keys(contract.flags));
  const acknowledged = new Set(contract.acknowledgedUpstreamFlags ?? []);
  const extraFlags: string[] = [];
  const acknowledgedExtraFlags: string[] = [];
  for (const flag of discoveredFlags) {
    if (contractFlagSet.has(flag)) continue;
    if (acknowledged.has(flag)) {
      acknowledgedExtraFlags.push(flag);
    } else {
      extraFlags.push(flag);
    }
  }

  const discoveredSet = new Set(discoveredFlags);
  for (const flag of acknowledged) {
    if (!discoveredSet.has(flag)) {
      warnings.push(
        `acknowledged upstream subcommand flag ${flag} no longer appears in ${executable} ${subcommandKey(contract.commandPath)} help output; remove it from acknowledgedUpstreamFlags`
      );
    }
  }

  return { missingFlags, extraFlags, acknowledgedExtraFlags, warnings };
}

export interface InstalledCliSubcommandProbe {
  commandPath: readonly string[];
  checkedHelpCommands: string[][];
  available: boolean;
  missingFlags: string[];
  extraFlags: readonly string[];
  acknowledgedExtraFlags: readonly string[];
  discoveredFlags: readonly string[];
  helpHash?: string;
  probedAt: string;
  warnings: string[];
  risk: CliSubcommandRisk;
  exposure: CliSubcommandExposure;
  tier: CliSubcommandTier;
  summary: string;
}

export interface InstalledCliContractProbe {
  cli: CliType;
  executable: string;
  resolvedCommand?: string;
  resolvedArgs?: string[];
  available: boolean;
  checkedHelpCommands: string[][];
  missingFlags: string[];
  /** Flags present in the installed binary's --help but absent from the declared contract. */
  extraFlags: readonly string[];
  /** Installed-binary flags acknowledged as upstream-only (filtered from extraFlags). */
  acknowledgedExtraFlags: readonly string[];
  /** Sorted list of long flags discovered in the help text (for snapshot diffing). */
  discoveredFlags: readonly string[];
  /** Stable hash of the concatenated help output (detects subtle text changes even if flag set is stable). */
  helpHash?: string;
  /** Best-effort version string scraped from the help/version output (if present). */
  versionHint?: string;
  /** Declared subcommand help surfaces probed via `<executable> ...commandPath --help`. */
  subcommands: Record<string, InstalledCliSubcommandProbe>;
  /** ISO timestamp when this probe was performed. */
  probedAt: string;
  warnings: string[];
}

export function probeInstalledCliContract(
  cli: CliType,
  timeoutMs = 5_000
): InstalledCliContractProbe {
  const contract = UPSTREAM_CLI_CONTRACTS[cli];
  const outputs: string[] = [];
  const warnings: string[] = [];
  let resolvedCommand: string | undefined;
  let resolvedArgs: string[] | undefined;

  for (const helpArgs of contract.helpArgs) {
    const extendedPath = getExtendedPath();
    const env = envWithExtendedPath(process.env, extendedPath);
    const resolved = resolveCommandForSpawn(contract.executable, helpArgs, {
      envPath: extendedPath,
    });
    resolvedCommand ??= resolved.command;
    resolvedArgs ??= resolved.args;
    const result = spawnSync(resolved.command, resolved.args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env,
      windowsHide: true,
      windowsVerbatimArguments: resolved.windowsVerbatimArguments,
    });
    if (result.error) {
      return {
        cli,
        executable: contract.executable,
        resolvedCommand: resolved.command,
        resolvedArgs: resolved.args,
        available: false,
        checkedHelpCommands: contract.helpArgs,
        missingFlags: [],
        extraFlags: [],
        acknowledgedExtraFlags: [],
        discoveredFlags: [],
        helpHash: undefined,
        versionHint: undefined,
        subcommands: {},
        probedAt: new Date().toISOString(),
        warnings: [result.error.message],
      };
    }
    outputs.push(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    if (result.status !== 0) {
      warnings.push(
        `${contract.executable} ${helpArgs.join(" ")} exited with status ${result.status}`
      );
    }
  }

  const helpText = outputs.join("\n");
  const discoveredFlags = extractDiscoveredFlags(helpText);
  const drift = computeFlagDrift(contract, helpText, discoveredFlags);
  warnings.push(...drift.warnings);

  // Cheap version hint: first line that looks like a version banner
  const versionMatch = helpText.match(/^\s*(?:[A-Za-z][\w .-]+)?v?\d+\.\d+\S*/m);
  const versionHint = versionMatch ? versionMatch[0].trim().slice(0, 80) : undefined;

  const helpHash = createHash("sha256").update(helpText).digest("hex");
  const subcommands = probeInstalledCliSubcommands(cli, timeoutMs);

  return {
    cli,
    executable: contract.executable,
    resolvedCommand,
    resolvedArgs,
    available: true,
    checkedHelpCommands: contract.helpArgs,
    missingFlags: drift.missingFlags,
    extraFlags: drift.extraFlags,
    acknowledgedExtraFlags: drift.acknowledgedExtraFlags,
    discoveredFlags,
    helpHash,
    versionHint,
    subcommands,
    probedAt: new Date().toISOString(),
    warnings,
  };
}

function probeInstalledCliSubcommands(
  cli: CliType,
  timeoutMs: number
): Record<string, InstalledCliSubcommandProbe> {
  const contract = UPSTREAM_CLI_CONTRACTS[cli];
  const probes: Record<string, InstalledCliSubcommandProbe> = {};
  for (const sub of flattenCliSubcommands(contract.subcommands)) {
    const outputs: string[] = [];
    const warnings: string[] = [];
    let available = true;
    const checkedHelpCommands = sub.helpArgs.map(helpArgs => [...sub.commandPath, ...helpArgs]);

    for (const helpArgs of sub.helpArgs) {
      const args = [...sub.commandPath, ...helpArgs];
      const extendedPath = getExtendedPath();
      const env = envWithExtendedPath(process.env, extendedPath);
      const resolved = resolveCommandForSpawn(contract.executable, args, {
        envPath: extendedPath,
      });
      const result = spawnSync(resolved.command, resolved.args, {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        env,
        windowsHide: true,
        windowsVerbatimArguments: resolved.windowsVerbatimArguments,
      });
      if (result.error) {
        available = false;
        warnings.push(result.error.message);
        break;
      }
      outputs.push(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
      if (result.status !== 0 && !sub.helpProbeExitTolerant) {
        warnings.push(
          `${contract.executable} ${args.join(" ")} exited with status ${result.status}`
        );
      }
    }

    const helpText = outputs.join("\n");
    const discoveredFlags = available ? extractDiscoveredFlags(helpText) : [];
    const drift = available
      ? computeSubcommandFlagDrift(sub, contract.executable, helpText, discoveredFlags)
      : { missingFlags: [], extraFlags: [], acknowledgedExtraFlags: [], warnings: [] };
    warnings.push(...drift.warnings);
    probes[subcommandKey(sub.commandPath)] = {
      commandPath: sub.commandPath,
      checkedHelpCommands,
      available,
      missingFlags: drift.missingFlags,
      extraFlags: drift.extraFlags,
      acknowledgedExtraFlags: drift.acknowledgedExtraFlags,
      discoveredFlags,
      helpHash: available ? createHash("sha256").update(helpText).digest("hex") : undefined,
      probedAt: new Date().toISOString(),
      warnings,
      risk: sub.risk,
      exposure: sub.exposure,
      tier: sub.tier,
      summary: sub.summary,
    };
  }
  return probes;
}

/**
 * Outcome of a read-only ACP entrypoint probe for one provider. Reported under
 * a SEPARATE report key from request-tool command drift so an ACP entrypoint
 * change (e.g. `vibe-acp` disappearing, `grok agent stdio --help` failing, or
 * a previously-absent provider sprouting an ACP surface) is visible on its own.
 */
export interface InstalledAcpEntrypointProbe {
  cli: CliType;
  status: AcpEntrypointStatus;
  executable: string;
  entrypointArgs: readonly string[];
  targetVersion: string;
  /** Full argv arrays that were probed (read-only `--version` / `--help` only). */
  checkedProbeCommands: readonly (readonly string[])[];
  /**
   * Native providers: true when at least one read-only probe resolved and ran.
   * Adapter/absent providers have no native probe, so this is null (not a
   * failure — there is nothing to probe).
   */
  available: boolean | null;
  /**
   * Native-provider entrypoint drift signal: true when the entrypoint is
   * declared native but NO declared probe succeeded on this machine (binary
   * missing or probe failing). Always false for non-native providers and for
   * native providers whose probe ran. Distinct from request-tool drift.
   */
  entrypointDrift: boolean;
  warnings: string[];
  probedAt: string;
}

/**
 * Read-only probe of a provider's ACP entrypoint. Only ever runs the declared
 * `probeArgs` (`--version` / `--help` variants); never the bare live ACP
 * process. Adapter-mediated and absent providers are reported without spawning
 * anything (there is no safe native probe to run).
 */
export function probeInstalledAcpEntrypoint(
  cli: CliType,
  timeoutMs = 5_000
): InstalledAcpEntrypointProbe {
  const contract = ACP_ENTRYPOINT_CONTRACTS[cli];
  const warnings: string[] = [];
  const checkedProbeCommands = contract.probeArgs.map(args => [...args]);

  // Adapter-mediated / absent providers: no native entrypoint to probe.
  if (contract.status !== "native" || contract.probeArgs.length === 0) {
    return {
      cli,
      status: contract.status,
      executable: contract.executable,
      entrypointArgs: contract.entrypointArgs,
      targetVersion: contract.targetVersion,
      checkedProbeCommands,
      available: null,
      entrypointDrift: false,
      warnings,
      probedAt: new Date().toISOString(),
    };
  }

  let anyProbeSucceeded = false;
  for (const probeArgs of contract.probeArgs) {
    const extendedPath = getExtendedPath();
    const env = envWithExtendedPath(process.env, extendedPath);
    const resolved = resolveCommandForSpawn(contract.executable, [...probeArgs], {
      envPath: extendedPath,
    });
    const result = spawnSync(resolved.command, resolved.args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env,
      windowsHide: true,
      windowsVerbatimArguments: resolved.windowsVerbatimArguments,
    });
    if (result.error) {
      warnings.push(
        `${contract.executable} ${probeArgs.join(" ")} unavailable: ${result.error.message}`
      );
      continue;
    }
    anyProbeSucceeded = true;
    if (result.status !== 0) {
      warnings.push(
        `${contract.executable} ${probeArgs.join(" ")} exited with status ${result.status}`
      );
    }
  }

  return {
    cli,
    status: contract.status,
    executable: contract.executable,
    entrypointArgs: contract.entrypointArgs,
    targetVersion: contract.targetVersion,
    checkedProbeCommands,
    available: anyProbeSucceeded,
    entrypointDrift: !anyProbeSucceeded,
    warnings,
    probedAt: new Date().toISOString(),
  };
}

/**
 * Serialize an ACP entrypoint contract into the upstream contract report. Pure
 * metadata; carries no secrets, paths, or raw probe output.
 */
function serializeAcpEntrypointContract(contract: AcpEntrypointContract): Record<string, unknown> {
  return {
    status: contract.status,
    native: contract.status === "native",
    executable: contract.executable,
    entrypointArgs: contract.entrypointArgs,
    targetVersion: contract.targetVersion,
    probeArgs: contract.probeArgs.map(args => [...args]),
    adapterCandidates: contract.adapterCandidates ?? [],
    evidence: contract.evidence,
    docsRef: contract.docsRef,
  };
}

export function buildUpstreamContractReport(
  options: {
    cli?: CliType;
    probeInstalled?: boolean;
  } = {}
): Record<string, unknown> {
  const selected = options.cli ? [options.cli] : (Object.keys(UPSTREAM_CLI_CONTRACTS) as CliType[]);
  const contracts = Object.fromEntries(
    selected.map(cli => {
      const contract = UPSTREAM_CLI_CONTRACTS[cli];
      return [
        cli,
        {
          executable: contract.executable,
          upstream: contract.upstream,
          // Pure metadata pointers (changelog URLs, package name, watch
          // categories). Enriched from the CliContract — the single source of
          // truth — so report consumers and the scanner read the same values.
          upstreamMetadata: contract.upstreamMetadata
            ? {
                sourceUrls: contract.upstreamMetadata.sourceUrls,
                packageName: contract.upstreamMetadata.packageName ?? null,
                repo: contract.upstreamMetadata.repo ?? null,
                installDocsUrl: contract.upstreamMetadata.installDocsUrl ?? null,
                releaseChannel: contract.upstreamMetadata.releaseChannel ?? null,
                watchCategories: contract.upstreamMetadata.watchCategories,
              }
            : null,
          command: contract.command ?? null,
          helpArgs: contract.helpArgs,
          mcpTools: contract.mcpTools,
          mcpParameters: contract.mcpParameters,
          flags: Object.fromEntries(
            Object.entries(contract.flags).map(([name, flag]) => [
              name,
              serializeFlagContract(flag),
            ])
          ),
          subcommandCount: flattenCliSubcommands(contract.subcommands).length,
          subcommandsCatalog: buildProviderSubcommandsCompactCatalog({ provider: cli }),
          env: Object.fromEntries(
            Object.entries(contract.env ?? {}).map(([name, envContract]) => [
              name,
              {
                values: envContract.values ?? null,
                pattern: envContract.pattern?.source ?? null,
                description: envContract.description,
              },
            ])
          ),
          maxPositionals: contract.maxPositionals,
          resumeMaxPositionals: contract.resumeMaxPositionals ?? null,
          resumeOnlyFlags: contract.resumeOnlyFlags ?? [],
          resumeForbiddenFlags: contract.resumeForbiddenFlags ?? [],
          conformanceFixtures: contract.conformanceFixtures.map(fixture => ({
            id: fixture.id,
            description: fixture.description,
            expect: fixture.expect,
          })),
          // ACP entrypoint metadata is tracked SEPARATELY from the request argv
          // allowlist (flags/subcommands) above. It never widens what the
          // request validators accept.
          acpEntrypoint: serializeAcpEntrypointContract(ACP_ENTRYPOINT_CONTRACTS[cli]),
        },
      ];
    })
  );

  return {
    schemaVersion: "upstream-cli-contracts.v1",
    generatedAt: new Date().toISOString(),
    contracts,
    installedProbe: options.probeInstalled
      ? Object.fromEntries(selected.map(cli => [cli, probeInstalledCliContract(cli)]))
      : null,
    // ACP entrypoint drift is surfaced under its own key, distinct from the
    // request-tool `installedProbe` above, so ACP changes never masquerade as
    // request-tool command drift (or vice versa).
    acpInstalledProbe: options.probeInstalled
      ? Object.fromEntries(selected.map(cli => [cli, probeInstalledAcpEntrypoint(cli)]))
      : null,
  };
}

// ---------------------------------------------------------------------------
// Runtime discovery <-> checked-in contract drift (phase-1b).
//
// The checked-in `UPSTREAM_CLI_CONTRACTS` is a guardrail/regression fixture, not
// the only source of truth for installed capability. Phase-1b's runtime
// discovery (src/provider-capability-discovery.ts) compares what the INSTALLED
// binary advertises against this contract and reports a mismatch as a DISCOVERY
// EVENT via {@link computeDiscoveryContractDrift}. This is a PURE comparator: it
// spawns nothing and does not touch the offline `upstream:contracts` gate or the
// argv validators, so wiring discovery in cannot loosen or break either.
// ---------------------------------------------------------------------------

/** Installed-vs-contract drift, expressed as a discovery event. */
export interface DiscoveryContractDrift {
  cli: CliType;
  /** Version string discovered from the installed binary. */
  version: string;
  /** Target version the checked-in contract was captured against. */
  contractTargetVersion: string;
  versionMatchesContract: boolean;
  /** Contract flags (non-hidden) absent from the discovered help surface. */
  missingContractFlags: string[];
  /** Discovered flags neither in the contract nor acknowledged as upstream-only. */
  newDiscoveredFlags: string[];
  discoveredUnmappedCount: number;
  status: "clean" | "drift" | "degraded";
}

function extractVersionNumber(text: string): string | null {
  return /\d+(?:\.\d+)+/.exec(text)?.[0] ?? null;
}

/**
 * Compare a discovered capability surface (flag names + version) against the
 * checked-in contract for a provider. Pure; no spawning. Consumed by
 * `provider-capability-discovery.ts` so an installed-vs-contract mismatch is
 * surfaced as a discovery event in cli_versions / provider_tool_capabilities /
 * upstream_contracts / logs.
 */
export function computeDiscoveryContractDrift(
  cli: CliType,
  discovered: {
    version: string;
    discoveredFlagNames: readonly string[];
    discoveredUnmappedCount: number;
    status: "ok" | "degraded" | "error";
  }
): DiscoveryContractDrift {
  const contract = UPSTREAM_CLI_CONTRACTS[cli];
  const contractTargetVersion = getProviderDefinition(cli).upstreamContract.targetVersion;

  const discoveredSet = new Set(discovered.discoveredFlagNames);
  const contractFlagSet = new Set(Object.keys(contract.flags));
  const acknowledged = new Set(contract.acknowledgedUpstreamFlags ?? []);

  const missingContractFlags: string[] = [];
  for (const [flag, spec] of Object.entries(contract.flags)) {
    if (spec.hiddenFromHelp) continue;
    if (!discoveredSet.has(flag)) missingContractFlags.push(flag);
  }

  const ignored = new Set(["--help", "-h", "--version", "-V"]);
  const newDiscoveredFlags: string[] = [];
  for (const flag of discovered.discoveredFlagNames) {
    if (contractFlagSet.has(flag)) continue;
    if (acknowledged.has(flag)) continue;
    if (ignored.has(flag)) continue;
    newDiscoveredFlags.push(flag);
  }

  const discoveredNumber = extractVersionNumber(discovered.version);
  const contractNumber = extractVersionNumber(contractTargetVersion);
  const versionMatchesContract =
    discoveredNumber !== null && contractNumber !== null && discoveredNumber === contractNumber;

  let status: DiscoveryContractDrift["status"];
  if (discovered.status !== "ok") {
    status = "degraded";
  } else if (missingContractFlags.length > 0 || newDiscoveredFlags.length > 0) {
    status = "drift";
  } else {
    status = "clean";
  }

  return {
    cli,
    version: discovered.version,
    contractTargetVersion,
    versionMatchesContract,
    missingContractFlags,
    newDiscoveredFlags,
    discoveredUnmappedCount: discovered.discoveredUnmappedCount,
    status,
  };
}
