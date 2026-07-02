/**
 * ACP provider registry (data-only).
 *
 * Owns provider Agent Client Protocol (ACP) entrypoint metadata: native versus
 * adapter-mediated status, target-version labels, declared entrypoints, and the
 * runtime-gate defaults that downstream transport code reads before it routes a
 * single prompt.
 *
 * This module is intentionally side-effect free. It MUST NOT spawn provider
 * processes or run provider subcommands. The only place provider executables may
 * be probed is the smoke harness or the upstream-contract tooling, both of which
 * own their own explicit, read-only probes. Honoring the
 * `no_arbitrary_subcommand_execution` / `no_shell_eval_for_entrypoints`
 * security invariants starts here: entrypoints are stored as an executable plus
 * an argv array, never as a shell string.
 */

import { getProviderDefinition } from "../provider-definitions.js";
import type { CliType } from "../session-manager.js";

/**
 * ACP support classification for a provider at its target version.
 *
 *  - `native_smoke_passed`: provider ships a native ACP entrypoint and a manual
 *    read-only initialize + session/new smoke passed locally. A native runtime
 *    pilot candidate. Smoke success is not, by itself, runtime support.
 *  - `adapter_mediated_deferred`: no native ACP entrypoint at the target
 *    version; only third-party adapters exist. Tracked but never labelled as
 *    native gateway ACP support, and not shipped as runtime support.
 *  - `absent_watchlist`: no ACP surface at the target version. Kept on the
 *    upstream drift watchlist only.
 */
export type AcpProviderStatus =
  | "native_smoke_passed"
  // Native ACP entrypoint exists but the read-only smoke has not been run yet
  // (e.g. Devin `devin acp`, registered in Slice D0; smoke + pilot in D1).
  | "native_candidate"
  | "adapter_mediated_deferred"
  | "absent_watchlist";

/**
 * Whether ACP support, if any, is delivered by the provider's own native
 * entrypoint or only by an external adapter.
 */
export type AcpSupportKind = "native" | "adapter_mediated" | "none";

/**
 * A provider ACP entrypoint expressed as an executable plus argv array.
 *
 * Never a shell string. The presence of this shape (rather than a `string`) is
 * the structural guarantee for `no_shell_eval_for_entrypoints`.
 */
export interface AcpEntrypoint {
  /** Executable name resolved on PATH. */
  readonly command: string;
  /** Fixed argument vector. No shell metacharacters are ever interpolated. */
  readonly args: readonly string[];
}

/**
 * Static ACP metadata for a single provider. Data only.
 */
export interface AcpProviderRegistryEntry {
  /** Gateway provider key. */
  readonly provider: CliType;
  /** Human-facing display name. */
  readonly displayName: string;
  /** ACP support classification at the target version. */
  readonly status: AcpProviderStatus;
  /** Native vs adapter-mediated vs none. */
  readonly supportKind: AcpSupportKind;
  /** Provider version label this metadata was validated against. */
  readonly targetVersion: string;
  /**
   * Native ACP entrypoint, or `null` when the provider has no native ACP
   * surface at the target version. A non-null entrypoint never implies a shell
   * string: it is always executable + argv.
   */
  readonly entrypoint: AcpEntrypoint | null;
  /**
   * Default for the per-provider runtime gate. Always `false` in this slice:
   * runtime routing must be explicitly enabled in config. Read-only smoke and
   * capability metadata never depend on this being true.
   */
  readonly runtimeEnabledDefault: boolean;
  /** Whether this provider is a planned runtime pilot in this slice. */
  readonly shipRuntimePilot: boolean;
  /**
   * Pilot ordering. Lower non-zero numbers ship earlier; `0` means not a
   * pilot.
   */
  readonly runtimePriority: number;
  /** Adapter project references, documentation only. */
  readonly adapterCandidates: readonly string[];
  /** Short human-facing caveat string. Contains no secrets or local paths. */
  readonly caveat: string;
}

/**
 * Source a provider's native ACP entrypoint from the single source of truth
 * (`provider-definitions.ts`), frozen as an {@link AcpEntrypoint}. Returns null
 * when the provider has no native entrypoint. This is the DRY dedupe: the
 * registry NEVER re-spells the executable/argv; it derives them from the
 * definition so a change there flows through automatically.
 */
function acpEntrypointFromDefinition(provider: CliType): AcpEntrypoint | null {
  const entry = getProviderDefinition(provider).acp.entrypoint;
  if (!entry) {
    return null;
  }
  return Object.freeze({ command: entry.command, args: Object.freeze([...entry.args]) });
}

/**
 * The frozen ACP provider registry. Keyed by gateway provider type.
 *
 * Note: the `gemini` key targets Google Antigravity `agy`, which has no ACP
 * surface at its target version. Legacy Gemini-CLI ACP evidence does not
 * transfer and must not promote `gemini` above `absent_watchlist` here.
 */
const ACP_PROVIDER_REGISTRY: Readonly<Record<CliType, AcpProviderRegistryEntry>> = Object.freeze({
  mistral: Object.freeze({
    provider: "mistral",
    displayName: "Mistral Vibe",
    status: "native_smoke_passed",
    supportKind: "native",
    targetVersion: "vibe 2.18.3",
    entrypoint: acpEntrypointFromDefinition("mistral"),
    runtimeEnabledDefault: false,
    shipRuntimePilot: true,
    runtimePriority: 1,
    adapterCandidates: Object.freeze([]),
    // phase-5/8: replace limited-support label with discovered capability fact
    caveat:
      "Native ACP entrypoint vibe-acp. Manual initialize and session/new smoke passed. First native runtime pilot; runtime routing stays config-gated.",
  }),
  grok: Object.freeze({
    provider: "grok",
    displayName: "xAI Grok CLI",
    status: "native_smoke_passed",
    supportKind: "native",
    targetVersion: "grok 0.2.77 (44e77bec3a)",
    entrypoint: acpEntrypointFromDefinition("grok"),
    runtimeEnabledDefault: false,
    shipRuntimePilot: true,
    runtimePriority: 2,
    adapterCandidates: Object.freeze([]),
    // phase-5/8: replace limited-support label with discovered capability fact
    caveat:
      "Native ACP entrypoint grok agent stdio. Manual smoke passed with the installed CLI managing credentials; empty-env smoke is expected to fail. Second native runtime pilot; runtime routing stays config-gated.",
  }),
  codex: Object.freeze({
    provider: "codex",
    displayName: "OpenAI Codex CLI",
    // phase-5/8: replace limited-support label with discovered capability fact
    status: "adapter_mediated_deferred",
    supportKind: "adapter_mediated",
    targetVersion: "codex-cli 0.142.4",
    entrypoint: acpEntrypointFromDefinition("codex"),
    runtimeEnabledDefault: false,
    shipRuntimePilot: false,
    runtimePriority: 0,
    adapterCandidates: Object.freeze(["zed-industries/codex-acp", "agentclientprotocol/codex-acp"]),
    caveat:
      "No native ACP entrypoint at the target version. Adapter-mediated only; tracked but not shipped as native gateway ACP support.",
  }),
  claude: Object.freeze({
    provider: "claude",
    displayName: "Anthropic Claude Code",
    // phase-5/8: replace limited-support label with discovered capability fact
    status: "adapter_mediated_deferred",
    supportKind: "adapter_mediated",
    targetVersion: "claude 2.1.198",
    entrypoint: acpEntrypointFromDefinition("claude"),
    runtimeEnabledDefault: false,
    shipRuntimePilot: false,
    runtimePriority: 0,
    adapterCandidates: Object.freeze(["Claude Agent SDK ACP adapter"]),
    caveat:
      "No native Claude Code CLI ACP entrypoint at the target version. Adapter-mediated only; adapter ownership, permission bridging, and install story unresolved.",
  }),
  gemini: Object.freeze({
    provider: "gemini",
    displayName: "Google Antigravity",
    // phase-5/8: replace limited-support label with discovered capability fact
    status: "absent_watchlist",
    supportKind: "none",
    targetVersion: "agy 1.0.14",
    entrypoint: acpEntrypointFromDefinition("gemini"),
    runtimeEnabledDefault: false,
    shipRuntimePilot: false,
    runtimePriority: 0,
    adapterCandidates: Object.freeze([]),
    caveat:
      "No ACP flag or subcommand at the target version. Legacy Gemini CLI ACP evidence does not transfer to Antigravity agy. Watchlist only.",
  }),
  devin: Object.freeze({
    provider: "devin",
    displayName: "Cognition Devin CLI",
    status: "native_smoke_passed",
    supportKind: "native",
    targetVersion: "devin 2026.8.18 (16737566)",
    entrypoint: acpEntrypointFromDefinition("devin"),
    runtimeEnabledDefault: false,
    // Slice D1: manual initialize + session/new smoke passed against the
    // installed CLI (protocolVersion 1, agent "Affogato", session created).
    shipRuntimePilot: true,
    runtimePriority: 3,
    adapterCandidates: Object.freeze([]),
    // phase-5/8: replace limited-support label with discovered capability fact
    caveat:
      "Native ACP entrypoint `devin acp` (stdio JSON-RPC). Manual initialize + session/new smoke passed with the installed CLI managing credentials (`devin auth login`; WINDSURF_API_KEY for empty-env); empty-env smoke is expected to fail. Third native runtime pilot; runtime routing stays config-gated.",
  }),
  cursor: Object.freeze({
    provider: "cursor",
    displayName: "Cursor Agent CLI",
    status: "native_smoke_passed",
    supportKind: "native",
    targetVersion: "cursor-agent 2026.06.29-2ad2186",
    entrypoint: acpEntrypointFromDefinition("cursor"),
    runtimeEnabledDefault: false,
    shipRuntimePilot: true,
    runtimePriority: 4,
    adapterCandidates: Object.freeze([]),
    // phase-5/8: replace limited-support label with discovered capability fact
    caveat:
      "Native ACP entrypoint `cursor-agent acp` (stdio JSON-RPC) is available as a hidden advanced command. Manual initialize + session/new smoke passed locally (protocolVersion 1, session created; no agentInfo returned). Fourth native runtime pilot; runtime routing stays config-gated.",
  }),
});

/**
 * Return the full ACP provider registry. Data only; performs no I/O and runs no
 * provider subcommands.
 */
export function getAcpProviderRegistry(): Readonly<Record<CliType, AcpProviderRegistryEntry>> {
  return ACP_PROVIDER_REGISTRY;
}

/**
 * Return the static ACP metadata for a single provider.
 */
export function getAcpProviderEntry(provider: CliType): AcpProviderRegistryEntry {
  return ACP_PROVIDER_REGISTRY[provider];
}

/**
 * Whether a provider has a native ACP entrypoint at its target version.
 *
 * Adapter-mediated and absent providers return `false`. This is a static
 * classification check; it never probes the installed CLI.
 */
export function providerHasNativeAcp(provider: CliType): boolean {
  return ACP_PROVIDER_REGISTRY[provider].supportKind === "native";
}

/**
 * The native runtime-pilot providers in ship order (priority ascending).
 *
 * Only providers with `shipRuntimePilot === true` are included. Runtime
 * routing for each still requires explicit config gates; pilot membership here
 * is a planning fact, not an enablement.
 */
export function getRuntimePilotProviders(): readonly CliType[] {
  return Object.values(ACP_PROVIDER_REGISTRY)
    .filter(entry => entry.shipRuntimePilot)
    .sort((a, b) => a.runtimePriority - b.runtimePriority)
    .map(entry => entry.provider);
}
