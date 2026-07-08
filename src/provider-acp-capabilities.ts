/**
 * provider-acp capability projection (phase-5 Deliverable B).
 *
 * Projects, per provider, the Agent Client Protocol (ACP) capability record that
 * backs the `provider-acp://<provider>` MCP resource. The record is DERIVED, not
 * hand-maintained:
 *
 *   - The native entrypoint, probe argv, agent-type variants, and evidence come
 *     from the single source of truth (`provider-definitions.ts`).
 *   - The negotiated capability detail (protocolVersion, agentInfo, auth/prompt/
 *     mcp/session capabilities) and the DERIVED supported-session-method set come
 *     from the discovered `initialize` capability set when one is available
 *     (memo-only; a resource read NEVER spawns). When no discovered set exists
 *     the record degrades to a static fallback: entrypoint facts plus the
 *     baseline methods, with `source: "static-fallback"`.
 *   - The host-service policy is the deny-by-default gateway posture, reflecting
 *     the operator's [acp] config gates.
 *
 * Anti-masquerade: a non-native provider (claude/codex/gemini) yields a record
 * that explicitly reports `native: false`, a null entrypoint, and no supported
 * methods. There is no adapter-as-native masquerade.
 *
 * Redaction: only capability/method names, the bare executable + argv (never a
 * path), and curated evidence are surfaced. Discovered agentInfo strings are run
 * through the ACP message redactor defensively, so no local path/token/email
 * from provider output can leak through the resource.
 */

import { redactAcpMessage } from "./acp/errors.js";
import {
  BASELINE_ACP_METHODS,
  deriveAcpMethodAvailability,
  type InitializeResponse,
} from "./acp/types.js";
import type { AcpConfig } from "./config.js";
import { getProviderDefinition } from "./provider-definitions.js";
import type { ParsedAcpInitialize } from "./provider-capability-discovery.js";
import type { CliType } from "./session-manager.js";

/** The deny-by-default gateway host-service posture for ACP. */
export interface AcpHostServicePolicy {
  /** Filesystem read host service (deny-by-default; not yet enabled). */
  readonly filesystemRead: "deny-by-default";
  /** Whether fs write host service may be approved (operator config gate). */
  readonly filesystemWriteAllowed: boolean;
  /** Whether terminal host service may be approved (operator config gate). */
  readonly terminalAllowed: boolean;
  /** Whether state-mutating ACP admin ops may be invoked (operator config gate). */
  readonly mutatingSessionOpsAllowed: boolean;
  /** Permission callbacks always route through the ApprovalManager. */
  readonly permissionRouting: "approval-manager";
  /** Unknown/uncategorized tool-call kinds are denied by default. */
  readonly unknownToolKind: "deny-by-default";
}

/** Negotiated ACP initialize detail, present only when discovered. */
export interface ProviderAcpInitializeDetail {
  /** "discovered" = from a live/cached initialize probe; "static-fallback" otherwise. */
  readonly source: "discovered" | "static-fallback";
  readonly degraded: boolean;
  readonly protocolVersion: number | string | null;
  readonly agentInfo: { readonly name?: string; readonly version?: string } | null;
  readonly authMethods: readonly string[];
  readonly promptCapabilities: readonly string[];
  readonly mcpCapabilities: readonly string[];
  readonly sessionCapabilities: readonly string[];
  /** ACP methods advertised but NOT known to the spec (discovered-unmapped). */
  readonly extensionMethods: readonly string[];
}

/** The full per-provider ACP capability record backing `provider-acp://<id>`. */
export interface ProviderAcpCapabilityRecord {
  readonly schemaVersion: "provider-acp-capability.v1";
  readonly provider: CliType;
  readonly displayName: string;
  /** True only when the provider declares a native ACP entrypoint. */
  readonly native: boolean;
  /** Human label of the native entrypoint (e.g. "grok agent stdio"), or null. */
  readonly nativeEntrypoint: string | null;
  /** Native entrypoint executable + argv, or null for non-native providers. */
  readonly entrypoint: { readonly command: string; readonly args: readonly string[] } | null;
  /** Safe (non-live) probe argv variants confirming the entrypoint exists. */
  readonly probeArgv: readonly (readonly string[])[];
  /** Selectable native agent variants (Devin `--agent-type`); empty otherwise. */
  readonly agentTypes: readonly { readonly id: string; readonly description: string }[];
  /** Curated evidence (no secrets). */
  readonly evidence: string;
  /** Negotiated initialize detail, or null when the provider is non-native. */
  readonly initialize: ProviderAcpInitializeDetail | null;
  /** DERIVED set of ACP session methods usable at runtime. */
  readonly supportedSessionMethods: readonly string[];
  /** Deny-by-default host-service policy. */
  readonly hostServicePolicy: AcpHostServicePolicy;
}

/**
 * Derive the supported ACP session methods from a discovered `initialize`
 * capability set. The discovered nested `agentCapabilities` is reprojected into
 * the runtime's `InitializeResponse` shape and run through the SAME
 * `deriveAcpMethodAvailability` the live client uses, so the resource reflects
 * exactly what the runtime would enable (baseline methods always present;
 * optional methods added only when the agent advertised the matching nested
 * capability). An explicit vendor spec-method list, when advertised, is
 * authoritative too. Pure.
 */
export function deriveSupportedMethodsFromDiscovered(
  parsed: ParsedAcpInitialize
): readonly string[] {
  const init: InitializeResponse = {
    // deriveAcpMethodAvailability ignores protocolVersion; coerce to a number
    // to satisfy the runtime shape (a string/absent version yields 0).
    protocolVersion: typeof parsed.protocolVersion === "number" ? parsed.protocolVersion : 0,
    agentCapabilities: parsed.agentCapabilities ?? undefined,
    authMethods: parsed.authMethods.map(id => ({ id })),
  };
  const methods = new Set<string>(deriveAcpMethodAvailability(init));
  // Explicit vendor method list (when advertised) is authoritative too.
  for (const method of parsed.knownMethods) {
    methods.add(method);
  }
  return [...methods].sort();
}

/** Options for building a provider-acp capability record. */
export interface BuildProviderAcpRecordOptions {
  /**
   * The discovered `initialize` capability set for this provider, if any (from
   * the capability resolver memo). When omitted/null the record degrades to a
   * static fallback (entrypoint facts + baseline methods). NEVER spawns here.
   */
  readonly discovered?: ParsedAcpInitialize | null;
  /** True when the discovered set was degraded (provenance for the reader). */
  readonly discoveredDegraded?: boolean;
  /** Resolved ACP config; drives the host-service policy gates. */
  readonly acpConfig?: AcpConfig | null;
}

function hostServicePolicy(config: AcpConfig | null | undefined): AcpHostServicePolicy {
  return {
    filesystemRead: "deny-by-default",
    filesystemWriteAllowed: config?.allowWriteHostServices ?? false,
    terminalAllowed: config?.allowTerminalHostServices ?? false,
    mutatingSessionOpsAllowed: config?.allowMutatingSessionOps ?? false,
    permissionRouting: "approval-manager",
    unknownToolKind: "deny-by-default",
  };
}

/**
 * Build the ACP capability record for one provider. Pure and I/O-free: it reads
 * the provider definition and, if supplied, an already-resolved discovered
 * capability set. Non-native providers get an explicit `native: false` record.
 */
export function buildProviderAcpCapabilityRecord(
  provider: CliType,
  options: BuildProviderAcpRecordOptions = {}
): ProviderAcpCapabilityRecord {
  const def = getProviderDefinition(provider);
  const acp = def.acp;
  const native = acp.classification === "native";
  const policy = hostServicePolicy(options.acpConfig);

  if (!native) {
    // Anti-masquerade: no native entrypoint, no adapter-as-native surface.
    return {
      schemaVersion: "provider-acp-capability.v1",
      provider,
      displayName: def.displayName,
      native: false,
      nativeEntrypoint: null,
      entrypoint: null,
      probeArgv: [],
      agentTypes: [],
      evidence: acp.evidence,
      initialize: null,
      supportedSessionMethods: [],
      hostServicePolicy: policy,
    };
  }

  const discovered = options.discovered ?? null;
  const initialize: ProviderAcpInitializeDetail = discovered
    ? {
        source: "discovered",
        degraded: options.discoveredDegraded ?? false,
        protocolVersion: discovered.protocolVersion,
        agentInfo: discovered.agentInfo
          ? {
              ...(discovered.agentInfo.name !== undefined
                ? { name: redactAcpMessage(discovered.agentInfo.name) }
                : {}),
              ...(discovered.agentInfo.version !== undefined
                ? { version: redactAcpMessage(discovered.agentInfo.version) }
                : {}),
            }
          : null,
        authMethods: discovered.authMethods,
        promptCapabilities: discovered.promptCapabilities,
        mcpCapabilities: discovered.mcpCapabilities,
        sessionCapabilities: discovered.sessionCapabilities,
        extensionMethods: discovered.extensionMethods,
      }
    : {
        source: "static-fallback",
        degraded: false,
        protocolVersion: null,
        agentInfo: null,
        authMethods: [],
        promptCapabilities: [],
        mcpCapabilities: [],
        sessionCapabilities: [],
        extensionMethods: [],
      };

  const supportedSessionMethods = discovered
    ? deriveSupportedMethodsFromDiscovered(discovered)
    : [...BASELINE_ACP_METHODS].sort();

  return {
    schemaVersion: "provider-acp-capability.v1",
    provider,
    displayName: def.displayName,
    native: true,
    nativeEntrypoint: acp.nativeEntrypoint,
    entrypoint: acp.entrypoint
      ? { command: acp.entrypoint.command, args: [...acp.entrypoint.args] }
      : null,
    probeArgv: acp.probeArgv.map(argv => [...argv]),
    agentTypes: acp.agentTypes
      ? acp.agentTypes.map(t => ({ id: t.id, description: t.description }))
      : [],
    evidence: acp.evidence,
    initialize,
    supportedSessionMethods,
    hostServicePolicy: policy,
  };
}
