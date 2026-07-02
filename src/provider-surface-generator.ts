/**
 * Provider surface generator.
 *
 * PROJECTIONS derived from the provider definition registry. Phase-1 CREATES
 * these generators (they return data). Later phases WIRE them into the live
 * gateway surfaces:
 *   - phase-2 consumes the resource projections (models://, sessions://)
 *   - phase-3 consumes the model-listing projection
 *   - phase-4 consumes the request-tool descriptors
 *   - phase-6 consumes the admin-tool descriptors
 *   - upstream-contract / docs projections feed reports and README tables
 *
 * Every generator returns exactly one row per provider in the supplied registry
 * (defaulting to the real registry), so a NEW provider definition flows through
 * every surface automatically. This is the mechanical half of the DRY rule: no
 * consumer spells out provider names; it maps a generator's rows.
 *
 * URIs like `models://<id>` / `sessions://<id>` are BUILT here from provider
 * ids, so this file is on the `provider:surfaces:check` allowlist (it is the
 * sanctioned place to construct them, not a hand-maintained per-provider block).
 */

import type { CliType } from "./provider-types.js";
import {
  adminSurfaceKind,
  getAllProviderDefinitions,
  type AdminSafetyClass,
  type AdminSurfaceKind,
  type ProviderDefinition,
} from "./provider-definitions.js";

/** Build the `models://<id>` resource URI for a provider. */
export function modelsResourceUri(id: CliType): string {
  return `models://${id}`;
}

/** Build the `sessions://<id>` resource URI for a provider. */
export function sessionsResourceUri(id: CliType): string {
  return `sessions://${id}`;
}

/** Build the `provider-acp://<id>` resource URI for a provider. */
export function providerAcpResourceUri(id: CliType): string {
  return `provider-acp://${id}`;
}

/** One request-tool descriptor per provider (carries both sync + async). */
export interface RequestToolDescriptor {
  readonly provider: CliType;
  readonly displayName: string;
  readonly syncToolName: string;
  readonly asyncToolName: string;
  readonly transport: string;
  readonly acpCapable: boolean;
}

/** Resource descriptor: the models:// and sessions:// URIs for a provider. */
export interface ResourceDescriptor {
  readonly provider: CliType;
  readonly displayName: string;
  /** Short session label (e.g. "Claude Session"); drives the sessions resource name. */
  readonly sessionLabel: string;
  /** Emoji icon prefixed to both the sessions:// and models:// resource titles. */
  readonly icon: string;
  readonly modelsUri: string;
  readonly sessionsUri: string;
  readonly exposesModelsResource: boolean;
  readonly exposesSessionsResource: boolean;
}

/** Model-listing row: how the gateway discovers this provider's models. */
export interface ModelListingRow {
  readonly provider: CliType;
  readonly displayName: string;
  readonly strategy: string;
  readonly discoveryArgv: readonly string[];
  readonly evidence: string;
}

/** Session-listing row: continuity metadata for a provider. */
export interface SessionListingRow {
  readonly provider: CliType;
  readonly sessionLabel: string;
  readonly resourceUri: string;
  readonly continue: boolean;
  readonly resume: boolean;
  readonly fork: boolean;
  readonly sessionIdSelection: boolean;
}

/** Provider capability row: request surface + safety + resource policy. */
export interface ProviderCapabilityRow {
  readonly provider: CliType;
  readonly displayName: string;
  readonly executables: readonly string[];
  readonly transport: string;
  readonly acpClassification: string;
  readonly sandbox: boolean;
  readonly permissionMode: boolean;
  readonly approvalMode: boolean;
  readonly trust: boolean;
  readonly outputFormats: readonly string[];
  readonly streamingFormats: readonly string[];
  readonly capabilityScope: string;
}

/** Admin tool descriptor: the declared admin families for a provider. */
export interface AdminToolDescriptor {
  readonly provider: CliType;
  readonly displayName: string;
  readonly families: readonly {
    readonly family: string;
    readonly safety: AdminSafetyClass;
    readonly kind: AdminSurfaceKind;
    readonly readOnly: boolean;
    /** True only for `cli-subcommand`; config projections/flags are not invokable subcommands. */
    readonly invokableSubcommand: boolean;
    readonly evidence: string;
  }[];
}

/** Upstream-contract report row for a provider. */
export interface UpstreamContractRow {
  readonly provider: CliType;
  readonly targetVersion: string;
  readonly helpChecksumRef: string | null;
  readonly acpClassification: string;
  readonly nativeEntrypoint: string | null;
}

/** Docs summary row for a provider. */
export interface DocsSummaryRow {
  readonly provider: CliType;
  readonly displayName: string;
  readonly primaryDocs: readonly string[];
  readonly capabilityScope: string;
}

/** All provider ids in registry order. */
export function generateProviderIdListing(
  defs: readonly ProviderDefinition[] = getAllProviderDefinitions()
): readonly CliType[] {
  return defs.map(def => def.id);
}

/** One sync+async request-tool descriptor per provider. */
export function generateRequestToolDescriptors(
  defs: readonly ProviderDefinition[] = getAllProviderDefinitions()
): readonly RequestToolDescriptor[] {
  return defs.map(def => ({
    provider: def.id,
    displayName: def.displayName,
    syncToolName: def.requestSurface.syncToolName,
    asyncToolName: def.requestSurface.asyncToolName,
    transport: def.requestSurface.transport,
    acpCapable: def.requestSurface.acpCapable,
  }));
}

/** One resource descriptor (models:// + sessions://) per provider. */
export function generateResourceDescriptors(
  defs: readonly ProviderDefinition[] = getAllProviderDefinitions()
): readonly ResourceDescriptor[] {
  return defs.map(def => ({
    provider: def.id,
    displayName: def.displayName,
    sessionLabel: def.sessionLabel,
    icon: def.icon,
    modelsUri: modelsResourceUri(def.id),
    sessionsUri: sessionsResourceUri(def.id),
    exposesModelsResource: def.resourcePolicy.exposesModelsResource,
    exposesSessionsResource: def.resourcePolicy.exposesSessionsResource,
  }));
}

/**
 * Resolve a `models://<id>` URI to its provider id, or null. Derives strictly
 * from the registry (honouring `exposesModelsResource`), so the resource layer
 * never hand-spells a provider name or a `uri === "models://<name>"` block.
 */
export function parseModelsResourceUri(
  uri: string,
  defs: readonly ProviderDefinition[] = getAllProviderDefinitions()
): CliType | null {
  for (const def of defs) {
    if (def.resourcePolicy.exposesModelsResource && modelsResourceUri(def.id) === uri) {
      return def.id;
    }
  }
  return null;
}

/**
 * Resolve a `sessions://<id>` URI to its provider id, or null. Derives strictly
 * from the registry (honouring `exposesSessionsResource`), so the resource layer
 * never hand-spells a provider name or a `uri === "sessions://<name>"` block.
 */
export function parseSessionsResourceUri(
  uri: string,
  defs: readonly ProviderDefinition[] = getAllProviderDefinitions()
): CliType | null {
  for (const def of defs) {
    if (def.resourcePolicy.exposesSessionsResource && sessionsResourceUri(def.id) === uri) {
      return def.id;
    }
  }
  return null;
}

/** Provider-ACP capability descriptor: the `provider-acp://<id>` surface row. */
export interface ProviderAcpDescriptor {
  readonly provider: CliType;
  readonly displayName: string;
  readonly icon: string;
  readonly acpUri: string;
  /** True when the provider declares a native ACP entrypoint in its definition. */
  readonly nativeAcp: boolean;
}

/**
 * One provider-acp capability descriptor for every NATIVE-ACP provider (those
 * whose definition declares `acp.classification === "native"`). The provider
 * list is derived from the registry, never hand-spelled.
 */
export function generateProviderAcpDescriptors(
  defs: readonly ProviderDefinition[] = getAllProviderDefinitions()
): readonly ProviderAcpDescriptor[] {
  return defs
    .filter(def => def.acp.classification === "native")
    .map(def => ({
      provider: def.id,
      displayName: def.displayName,
      icon: def.icon,
      acpUri: providerAcpResourceUri(def.id),
      nativeAcp: true,
    }));
}

/**
 * Resolve a `provider-acp://<id>` URI to its provider id, or null. Resolves for
 * ANY known provider id (native OR non-native) so a non-native record can be
 * read and explicitly state "no native ACP entrypoint" (anti-masquerade). The
 * provider id is derived strictly from the registry, never hand-spelled.
 */
export function parseProviderAcpResourceUri(
  uri: string,
  defs: readonly ProviderDefinition[] = getAllProviderDefinitions()
): CliType | null {
  for (const def of defs) {
    if (providerAcpResourceUri(def.id) === uri) {
      return def.id;
    }
  }
  return null;
}

/** One model-listing row per provider. */
export function generateModelListingRows(
  defs: readonly ProviderDefinition[] = getAllProviderDefinitions()
): readonly ModelListingRow[] {
  return defs.map(def => ({
    provider: def.id,
    displayName: def.displayName,
    strategy: def.discovery.modelDiscovery.strategy,
    discoveryArgv: def.discovery.modelDiscovery.argv,
    evidence: def.discovery.modelDiscovery.evidence,
  }));
}

/** One session-listing row per provider. */
export function generateSessionListingRows(
  defs: readonly ProviderDefinition[] = getAllProviderDefinitions()
): readonly SessionListingRow[] {
  return defs.map(def => ({
    provider: def.id,
    sessionLabel: def.sessionLabel,
    resourceUri: sessionsResourceUri(def.id),
    continue: def.discovery.sessionContinuity.continue,
    resume: def.discovery.sessionContinuity.resume,
    fork: def.discovery.sessionContinuity.fork,
    sessionIdSelection: def.discovery.sessionContinuity.sessionIdSelection,
  }));
}

/** One provider capability row per provider. */
export function generateProviderCapabilityRows(
  defs: readonly ProviderDefinition[] = getAllProviderDefinitions()
): readonly ProviderCapabilityRow[] {
  return defs.map(def => ({
    provider: def.id,
    displayName: def.displayName,
    executables: def.executables,
    transport: def.requestSurface.transport,
    acpClassification: def.acp.classification,
    sandbox: def.safetyModes.sandbox,
    permissionMode: def.safetyModes.permissionMode,
    approvalMode: def.safetyModes.approvalMode,
    trust: def.safetyModes.trust,
    outputFormats: def.outputFormats,
    streamingFormats: def.streamingFormats,
    capabilityScope: def.capabilityScope,
  }));
}

/** One admin-tool descriptor per provider. */
export function generateAdminToolDescriptors(
  defs: readonly ProviderDefinition[] = getAllProviderDefinitions()
): readonly AdminToolDescriptor[] {
  return defs.map(def => ({
    provider: def.id,
    displayName: def.displayName,
    families: def.adminSubcommands.map(family => {
      const kind = adminSurfaceKind(family);
      return {
        family: family.family,
        safety: family.safety,
        kind,
        readOnly: family.safety === "read-only",
        invokableSubcommand: kind === "cli-subcommand",
        evidence: family.evidence,
      };
    }),
  }));
}

/** One upstream-contract report row per provider. */
export function generateUpstreamContractRows(
  defs: readonly ProviderDefinition[] = getAllProviderDefinitions()
): readonly UpstreamContractRow[] {
  return defs.map(def => ({
    provider: def.id,
    targetVersion: def.upstreamContract.targetVersion,
    helpChecksumRef: def.upstreamContract.helpChecksumRef,
    acpClassification: def.acp.classification,
    nativeEntrypoint: def.acp.nativeEntrypoint,
  }));
}

/** One docs summary row per provider. */
export function generateDocsSummaryRows(
  defs: readonly ProviderDefinition[] = getAllProviderDefinitions()
): readonly DocsSummaryRow[] {
  return defs.map(def => ({
    provider: def.id,
    displayName: def.displayName,
    primaryDocs: def.docs.primary,
    capabilityScope: def.capabilityScope,
  }));
}
