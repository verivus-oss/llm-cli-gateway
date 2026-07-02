import {
  ISessionManager,
  callerIsRemote,
  remoteSafeSession,
  type Session,
} from "./session-manager.js";
import { CLI_TYPES, PROVIDER_TYPES, type CliType, type ProviderType } from "./session-manager.js";
import { getRequestContext, principalCanAccess, resolveOwnerPrincipal } from "./request-context.js";
import { PerformanceMetrics } from "./metrics.js";
import { getAvailableCliInfo } from "./model-registry.js";
import { FlightRecorderQuery } from "./flight-recorder.js";
import {
  computeGlobalCacheStats,
  computePrefixCacheStats,
  computeSessionCacheStats,
  computeTtlRemaining,
  type GlobalCacheStats,
  type PrefixCacheStats,
  type SessionCacheStats,
} from "./cache-stats.js";
import {
  enabledApiProviders,
  type ApiProviderRuntime,
  type CacheAwarenessConfig,
  type ProvidersConfig,
} from "./config.js";
import { apiContinuityForKind } from "./api-provider.js";
import { apiProviderCatalogEntry } from "./api-request.js";
import {
  buildProviderSubcommandsCompactCatalog,
  getCliSubcommandContract,
  serializeCliSubcommandContract,
} from "./upstream-contracts.js";
import {
  getOneProviderToolCapabilities,
  getProviderToolCapabilities,
  knownProviderCapabilityIds,
  providerCapabilityIds,
  type ProviderCapabilityId,
} from "./provider-tool-capabilities.js";
import {
  generateProviderAcpDescriptors,
  generateResourceDescriptors,
  parseModelsResourceUri,
  parseProviderAcpResourceUri,
  parseSessionsResourceUri,
} from "./provider-surface-generator.js";
import { getProviderDefinition } from "./provider-definitions.js";
import { buildProviderAcpCapabilityRecord } from "./provider-acp-capabilities.js";
import type { AcpConfig } from "./config.js";
import {
  buildProviderDiscoveredView,
  peekProviderCapabilitySet,
  type ProviderDiscoveredView,
  type ResolvedProviderCapability,
} from "./provider-capability-resolver.js";

export interface ResourceDefinition {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  annotations?: {
    audience?: ("user" | "assistant")[];
    priority?: number;
    lastModified?: string;
  };
}

export interface ResourceContents {
  uri: string;
  mimeType: string;
  text: string;
}

export class ResourceProvider {
  constructor(
    private sessionManager: ISessionManager,
    private performanceMetrics: PerformanceMetrics,
    // Optional read access to the flight recorder. Used by cache-state
    // resources (slice 2). Falls back to a stub returning [] when not
    // injected so existing call sites continue to work without changes.
    private flightRecorder: FlightRecorderQuery = { queryRequests: () => [] },
    // Slice 3: optional cache-awareness config. When present, drives the
    // TTL policy applied to ttlRemainingMs on session-scoped reads.
    // When absent, the default Anthropic 5-min TTL applies (matches the
    // 1.x default of `[cache_awareness].anthropic_ttl_seconds = 300`).
    private cacheAwareness: CacheAwarenessConfig | null = null,
    // Slice 6: resolved API-provider config. When present, enabled
    // [providers.<name>] (kind:"api") providers gain `models://<name>` and (for
    // continuity-tracked kinds) `sessions://<name>` resources. Null/absent keeps
    // the resource set byte-identical to the CLI-only surface.
    private providers: ProvidersConfig | null = null,
    // Phase-3: memo-only capability peek used to enrich models://<cli> with the
    // live/cached discovered listing. Defaults to the process-lifetime resolver
    // memo (never spawns on the read path); tests inject a fake that returns a
    // canned resolution so unit tests never spawn real CLIs.
    private capabilityPeek: (
      id: CliType
    ) => ResolvedProviderCapability | null = peekProviderCapabilitySet,
    // Phase-5: resolved ACP config. Drives the host-service policy surfaced in
    // provider-acp://<provider> records. Null keeps the deny-by-default posture.
    private acpConfig: AcpConfig | null = null
  ) {}

  /** Read-only flight-recorder accessor for cache-state resource readers. */
  getFlightRecorderQuery(): FlightRecorderQuery {
    return this.flightRecorder;
  }

  /** Slice 6: the enabled generic API providers (empty when none/unconfigured). */
  private apiRuntimes(): ApiProviderRuntime[] {
    return this.providers ? enabledApiProviders(this.providers) : [];
  }

  /** Slice 6: enabled API providers whose kind supports multi-turn continuity. */
  private continuityTrackedApiRuntimes(): ApiProviderRuntime[] {
    return this.apiRuntimes().filter(rt => apiContinuityForKind(rt.kind) !== "none");
  }

  /** Capability ids backed by this resource provider's resolved provider config. */
  private providerCapabilityIds(): readonly ProviderCapabilityId[] {
    return this.providers ? providerCapabilityIds(this.providers) : knownProviderCapabilityIds();
  }

  /**
   * cache-state://global — aggregates across the entire flight recorder.
   * Optionally restrict to a recent window via `lastNHours`. Returns
   * tokens/hashes/aggregates ONLY — no prompt text fields. The redaction is
   * structural: the response shape (GlobalCacheStats) has no `prompt`,
   * `response`, `system`, or `task` field by construction.
   */
  readCacheStateGlobal(opts: { lastNHours?: number } = {}): GlobalCacheStats {
    return computeGlobalCacheStats(this.flightRecorder, opts);
  }

  /**
   * cache-state://session/{sessionId} — per-session aggregates. Returns
   * empty defaults when the session has no rows. Token/hash fields only.
   *
   * Slice 3: populates `ttlRemainingMs` by applying the configured TTL
   * policy. Null for non-claude sessions or when the gateway has no
   * cache-awareness config loaded (defaults to 5-min policy).
   */
  readCacheStateSession(sessionId: string): SessionCacheStats {
    const stats = computeSessionCacheStats(this.flightRecorder, sessionId);
    const ttlSeconds = this.cacheAwareness?.anthropicTtlSeconds ?? 300;
    stats.ttlRemainingMs = computeTtlRemaining(stats, stats.cli, {
      anthropicTtlSeconds: ttlSeconds,
    });
    return stats;
  }

  /**
   * cache-state://prefix/{hash} — per-stable-prefix-hash aggregates.
   * Returns empty defaults for unknown hashes. Token/hash fields only.
   */
  readCacheStateForPrefix(stablePrefixHash: string): PrefixCacheStats {
    return computePrefixCacheStats(this.flightRecorder, stablePrefixHash);
  }

  // List all available resources
  listResources(): ResourceDefinition[] {
    return [
      {
        uri: "sessions://all",
        name: "All Sessions",
        title: "📋 All Sessions",
        description: "List of all conversation sessions across all CLIs",
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"],
          priority: 0.7,
          lastModified: new Date().toISOString(),
        },
      },
      // Per-provider sessions:// resources, generated from the provider
      // definition registry (via generateResourceDescriptors). Every CLI
      // provider that exposes a sessions resource gets one row, including devin
      // and cursor. No provider name is hand-spelled here.
      ...generateResourceDescriptors()
        .filter(descriptor => descriptor.exposesSessionsResource)
        .map(descriptor => ({
          uri: descriptor.sessionsUri,
          name: `${descriptor.sessionLabel}s`,
          title: `${descriptor.icon} ${descriptor.sessionLabel}s`,
          description: `List of ${descriptor.displayName} conversation sessions`,
          mimeType: "application/json",
          annotations: {
            audience: ["user", "assistant"] as ("user" | "assistant")[],
            priority: 0.6,
          },
        })),
      // Slice 6: sessions:// for enabled API providers whose kind is
      // continuity-tracked. Empty (byte-identical) when no API providers are
      // enabled or none of their kinds support continuity.
      ...this.continuityTrackedApiRuntimes().map(rt => ({
        uri: `sessions://${rt.name}`,
        name: `${rt.name} Sessions`,
        title: `${rt.name} Sessions`,
        description: `List of ${rt.name} API provider conversation sessions`,
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"] as ("user" | "assistant")[],
          priority: 0.6,
        },
      })),
      // Per-provider models:// resources, generated from the provider
      // definition registry (via generateResourceDescriptors). Every CLI
      // provider that exposes a models resource gets one row, including devin
      // and cursor. No provider name is hand-spelled here.
      ...generateResourceDescriptors()
        .filter(descriptor => descriptor.exposesModelsResource)
        .map(descriptor => ({
          uri: descriptor.modelsUri,
          name: `${descriptor.displayName} Models`,
          title: `${descriptor.icon} ${descriptor.displayName} Models & Capabilities`,
          description: `Available ${descriptor.displayName} models and their capabilities`,
          mimeType: "application/json",
          annotations: {
            audience: ["user", "assistant"] as ("user" | "assistant")[],
            priority: 0.8,
          },
        })),
      // Slice 6: models:// for every enabled API provider. Empty
      // (byte-identical) when no API providers are enabled.
      ...this.apiRuntimes().map(rt => ({
        uri: `models://${rt.name}`,
        name: `${rt.name} Models`,
        title: `${rt.name} Models & Capabilities`,
        description: `Configured ${rt.name} API provider model catalog`,
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"] as ("user" | "assistant")[],
          priority: 0.8,
        },
      })),
      {
        uri: "metrics://performance",
        name: "Performance Metrics",
        title: "📈 Performance Metrics",
        description: "Request counts, response times, and success/failure rates",
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"],
          priority: 0.9,
        },
      },
      {
        uri: "provider-subcommands://catalog",
        name: "Provider Subcommands Catalog",
        title: "Provider Subcommands Catalog",
        description: "Compact read-only catalog of declared provider CLI subcommands",
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"],
          priority: 0.7,
        },
      },
      {
        uri: "provider-tools://catalog",
        name: "Provider Tool Capabilities Catalog",
        title: "Provider Tool Capabilities Catalog",
        description: "Read-only catalog of gateway tool controls and discovered provider skills",
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"],
          priority: 0.8,
        },
      },
      ...this.providerCapabilityIds().map(cli => ({
        uri: `provider-tools://${cli}`,
        name: `${cli} Tool Capabilities`,
        title: `${cli} Tool Capabilities`,
        description: `Gateway tool controls and discovered local skills for ${cli}`,
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"] as ("user" | "assistant")[],
          priority: 0.8,
        },
      })),
      // Per-provider provider-acp:// resources for every NATIVE-ACP provider,
      // generated from the provider definition registry (no hand-spelled names).
      // Non-native providers (claude/codex/gemini) are intentionally not listed
      // here, but their non-native record is still readable via readResource.
      ...generateProviderAcpDescriptors().map(descriptor => ({
        uri: descriptor.acpUri,
        name: `${descriptor.displayName} ACP Capabilities`,
        title: `${descriptor.icon} ${descriptor.displayName} ACP Capabilities`,
        description: `Native ACP entrypoint, negotiated capabilities, supported session methods, and host-service policy for ${descriptor.displayName}`,
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"] as ("user" | "assistant")[],
          priority: 0.7,
        },
      })),
    ];
  }

  /**
   * F3b: restrict a session list to the rows the current request's principal may
   * access (legacy-unowned rows are visible to the local principal only). The
   * `sessions://*` resources are served on the same multi-transport server as the
   * tools, so an unfiltered list would let a remote principal enumerate another
   * principal's session ids and metadata.
   */
  private ownedSessions(sessions: Session[]): Session[] {
    const caller = resolveOwnerPrincipal(getRequestContext());
    const owned = sessions.filter(s => principalCanAccess(s.ownerPrincipal, caller));
    // Remote callers must not learn local absolute paths via session metadata
    // (worktreePath/workspaceRoot); redact them for the remote-facing resources.
    return callerIsRemote() ? owned.map(remoteSafeSession) : owned;
  }

  /** F3b: the active-session id for a provider, or null if the caller may not see it. */
  private async ownedActiveId(provider: ProviderType): Promise<string | null> {
    const active = await Promise.resolve(this.sessionManager.getActiveSession(provider));
    if (!active) return null;
    const caller = resolveOwnerPrincipal(getRequestContext());
    return principalCanAccess(active.ownerPrincipal, caller) ? active.id : null;
  }

  // Read a specific resource by URI
  async readResource(uri: string): Promise<ResourceContents | null> {
    // Session resources
    if (uri === "sessions://all") {
      const sessions = this.ownedSessions(await this.sessionManager.listSessions());
      const activeSessions = Object.fromEntries(
        await Promise.all(
          PROVIDER_TYPES.map(async provider => [provider, await this.ownedActiveId(provider)])
        )
      ) as Record<ProviderType, string | null>;
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(
          {
            total: sessions.length,
            sessions: sessions.map(s => ({
              id: s.id,
              cli: s.cli,
              description: s.description,
              createdAt: s.createdAt,
              lastUsedAt: s.lastUsedAt,
            })),
            activeSessions,
          },
          null,
          2
        ),
      };
    }

    // Per-provider sessions://<cli> resource, dispatched generically from the
    // provider definition registry (parseSessionsResourceUri). Owner-scoping is
    // preserved: ownedSessions/ownedActiveId filter to the caller's principal.
    // Placed before the API-provider handler so a config-guarded name collision
    // resolves to the CLI, mirroring the models:// ordering.
    const sessionProvider = parseSessionsResourceUri(uri);
    if (sessionProvider) {
      const sessions = this.ownedSessions(await this.sessionManager.listSessions(sessionProvider));
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(
          {
            cli: sessionProvider,
            total: sessions.length,
            sessions,
            activeSession: await this.ownedActiveId(sessionProvider),
          },
          null,
          2
        ),
      };
    }

    // Per-provider models://<cli> resource, dispatched generically from the
    // provider definition registry (parseModelsResourceUri). getAvailableCliInfo
    // is keyed by CliType, so every provider (including devin and cursor) reads
    // its own catalog with no hand-spelled provider name.
    const modelProvider = parseModelsResourceUri(uri);
    if (modelProvider) {
      const cliInfo = getAvailableCliInfo();
      // Additive phase-3 enrichment: keep the static registry entry as the base
      // (nothing regresses) and attach the discovered live/cached listing under
      // `discovered` with an explicit source marker + degraded flag. Discovery is
      // a memo-only peek here, so a read never spawns or hangs; when nothing is
      // resolvable the view degrades to source "static-fallback" (null listing).
      const discovered: ProviderDiscoveredView = buildProviderDiscoveredView(
        getProviderDefinition(modelProvider),
        cliInfo[modelProvider],
        this.capabilityPeek
      );
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({ ...cliInfo[modelProvider], discovered }, null, 2),
      };
    }

    // Slice 6: models://<api-provider> returns the catalog projection of an
    // enabled generic API provider (apiProviderCatalogEntry strips the resolved
    // key). Placed after the static CLI handlers so a config-guarded name
    // collision resolves to the CLI.
    if (uri.startsWith("models://")) {
      const runtime = this.apiRuntimes().find(rt => `models://${rt.name}` === uri);
      if (runtime) {
        return {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(apiProviderCatalogEntry(runtime), null, 2),
        };
      }
    }

    // Slice 6: sessions://<api-provider> uses the same owner-filtered shape as
    // the CLI session resources, only for continuity-tracked API kinds.
    if (uri.startsWith("sessions://")) {
      const runtime = this.continuityTrackedApiRuntimes().find(
        rt => `sessions://${rt.name}` === uri
      );
      if (runtime) {
        const sessions = this.ownedSessions(await this.sessionManager.listSessions(runtime.name));
        return {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              cli: runtime.name,
              total: sessions.length,
              sessions,
              activeSession: await this.ownedActiveId(runtime.name),
            },
            null,
            2
          ),
        };
      }
    }

    if (uri === "metrics://performance") {
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(this.performanceMetrics.snapshot(), null, 2),
      };
    }

    if (uri === "provider-subcommands://catalog" || uri === "provider_subcommands://catalog") {
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(buildProviderSubcommandsCompactCatalog()),
      };
    }

    if (uri === "provider-tools://catalog" || uri === "provider_tools://catalog") {
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(
          getProviderToolCapabilities({
            providersConfig: this.providers ?? undefined,
            acpConfig: this.acpConfig ?? undefined,
          }),
          null,
          2
        ),
      };
    }

    const providerToolsResource = parseProviderToolsUri(uri, this.providerCapabilityIds());
    if (providerToolsResource) {
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(
          getOneProviderToolCapabilities(providerToolsResource.provider, {
            providersConfig: this.providers ?? undefined,
            acpConfig: this.acpConfig ?? undefined,
          }),
          null,
          2
        ),
      };
    }

    // Per-provider provider-acp://<cli> resource. Resolves for ANY provider id
    // (native or non-native) so a non-native record explicitly states "no native
    // ACP entrypoint". The discovered initialize capability set comes from the
    // memo-only capability peek (a read NEVER spawns); absent -> static fallback.
    const acpProvider = parseProviderAcpResourceUri(uri);
    if (acpProvider) {
      const resolved = this.capabilityPeek(acpProvider);
      const record = buildProviderAcpCapabilityRecord(acpProvider, {
        discovered: resolved?.set.acpInitialize ?? null,
        discoveredDegraded: resolved?.degraded ?? false,
        acpConfig: this.acpConfig,
      });
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(record, null, 2),
      };
    }

    const subcommandResource = parseProviderSubcommandUri(uri);
    if (subcommandResource) {
      const contract = getCliSubcommandContract(
        subcommandResource.provider,
        subcommandResource.commandPath
      );
      if (!contract) return null;
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(
          {
            schemaVersion: "provider-subcommand-contract.v1",
            contract: serializeCliSubcommandContract(subcommandResource.provider, contract),
          },
          null,
          2
        ),
      };
    }

    return null;
  }
}

function parseProviderSubcommandUri(
  uri: string
): { provider: CliType; commandPath: string[] } | null {
  const prefix = uri.startsWith("provider-subcommands://")
    ? "provider-subcommands://"
    : uri.startsWith("provider_subcommands://")
      ? "provider_subcommands://"
      : null;
  if (!prefix || uri === `${prefix}catalog`) return null;
  const rest = uri.slice(prefix.length);
  const [providerRaw, ...pathParts] = rest.split("/");
  if (!CLI_TYPES.includes(providerRaw as CliType) || pathParts.length === 0) return null;
  return {
    provider: providerRaw as CliType,
    commandPath: pathParts.map(part => decodeURIComponent(part)).filter(Boolean),
  };
}

function parseProviderToolsUri(
  uri: string,
  providerIds: readonly ProviderCapabilityId[]
): { provider: ProviderCapabilityId } | null {
  const prefix = uri.startsWith("provider-tools://")
    ? "provider-tools://"
    : uri.startsWith("provider_tools://")
      ? "provider_tools://"
      : null;
  if (!prefix || uri === `${prefix}catalog`) return null;
  const provider = uri.slice(prefix.length);
  // Only known capability ids back a `provider-tools://<id>` resource; an
  // arbitrary (Slice 0.5) API id is a valid ProviderCapabilityId but has no
  // resource until it is registered, so reject anything outside the known set.
  if (!(providerIds as readonly string[]).includes(provider)) return null;
  return { provider: provider as ProviderCapabilityId };
}
