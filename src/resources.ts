import { ISessionManager, type Session } from "./session-manager.js";
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
import type { CacheAwarenessConfig } from "./config.js";
import {
  buildProviderSubcommandsCompactCatalog,
  getCliSubcommandContract,
  serializeCliSubcommandContract,
} from "./upstream-contracts.js";
import {
  getOneProviderToolCapabilities,
  getProviderToolCapabilities,
  providerCapabilityIds,
  type ProviderCapabilityId,
} from "./provider-tool-capabilities.js";

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
    private cacheAwareness: CacheAwarenessConfig | null = null
  ) {}

  /** Read-only flight-recorder accessor for cache-state resource readers. */
  getFlightRecorderQuery(): FlightRecorderQuery {
    return this.flightRecorder;
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
      {
        uri: "sessions://claude",
        name: "Claude Sessions",
        title: "🤖 Claude Sessions",
        description: "List of Claude conversation sessions",
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"],
          priority: 0.6,
        },
      },
      {
        uri: "sessions://codex",
        name: "Codex Sessions",
        title: "💻 Codex Sessions",
        description: "List of Codex conversation sessions",
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"],
          priority: 0.6,
        },
      },
      {
        uri: "sessions://gemini",
        name: "Gemini Sessions",
        title: "✨ Gemini Sessions",
        description: "List of Gemini conversation sessions",
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"],
          priority: 0.6,
        },
      },
      {
        uri: "sessions://grok",
        name: "Grok Sessions",
        title: "⚡ Grok Sessions",
        description: "List of Grok conversation sessions",
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"],
          priority: 0.6,
        },
      },
      {
        uri: "sessions://mistral",
        name: "Mistral Sessions",
        title: "🌬 Mistral Sessions",
        description: "List of Mistral Vibe conversation sessions",
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"],
          priority: 0.6,
        },
      },
      {
        uri: "models://claude",
        name: "Claude Models",
        title: "🧠 Claude Models & Capabilities",
        description: "Available Claude models and their capabilities",
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"],
          priority: 0.8,
        },
      },
      {
        uri: "models://codex",
        name: "Codex Models",
        title: "🔧 Codex Models & Capabilities",
        description: "Available Codex models and their capabilities",
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"],
          priority: 0.8,
        },
      },
      {
        uri: "models://gemini",
        name: "Gemini Models",
        title: "🌟 Gemini Models & Capabilities",
        description: "Available Gemini models and their capabilities",
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"],
          priority: 0.8,
        },
      },
      {
        uri: "models://grok",
        name: "Grok Models",
        title: "⚡ Grok Models & Capabilities",
        description: "Available Grok models and their capabilities",
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"],
          priority: 0.8,
        },
      },
      {
        uri: "models://mistral",
        name: "Mistral Models",
        title: "🌬 Mistral Models & Capabilities",
        description: "Available Mistral Vibe models and their capabilities",
        mimeType: "application/json",
        annotations: {
          audience: ["user", "assistant"],
          priority: 0.8,
        },
      },
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
      ...providerCapabilityIds().map(cli => ({
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
    return sessions.filter(s => principalCanAccess(s.ownerPrincipal, caller));
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

    if (uri === "sessions://claude") {
      const sessions = this.ownedSessions(await this.sessionManager.listSessions("claude"));
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(
          {
            cli: "claude",
            total: sessions.length,
            sessions,
            activeSession: await this.ownedActiveId("claude"),
          },
          null,
          2
        ),
      };
    }

    if (uri === "sessions://codex") {
      const sessions = this.ownedSessions(await this.sessionManager.listSessions("codex"));
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(
          {
            cli: "codex",
            total: sessions.length,
            sessions,
            activeSession: await this.ownedActiveId("codex"),
          },
          null,
          2
        ),
      };
    }

    if (uri === "sessions://gemini") {
      const sessions = this.ownedSessions(await this.sessionManager.listSessions("gemini"));
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(
          {
            cli: "gemini",
            total: sessions.length,
            sessions,
            activeSession: await this.ownedActiveId("gemini"),
          },
          null,
          2
        ),
      };
    }

    if (uri === "sessions://grok") {
      const sessions = this.ownedSessions(await this.sessionManager.listSessions("grok"));
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(
          {
            cli: "grok",
            total: sessions.length,
            sessions,
            activeSession: await this.ownedActiveId("grok"),
          },
          null,
          2
        ),
      };
    }

    if (uri === "sessions://mistral") {
      const sessions = this.ownedSessions(await this.sessionManager.listSessions("mistral"));
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(
          {
            cli: "mistral",
            total: sessions.length,
            sessions,
            activeSession: await this.ownedActiveId("mistral"),
          },
          null,
          2
        ),
      };
    }

    // Model capability resources
    if (uri === "models://claude") {
      const cliInfo = getAvailableCliInfo();
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(cliInfo.claude, null, 2),
      };
    }

    if (uri === "models://codex") {
      const cliInfo = getAvailableCliInfo();
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(cliInfo.codex, null, 2),
      };
    }

    if (uri === "models://gemini") {
      const cliInfo = getAvailableCliInfo();
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(cliInfo.gemini, null, 2),
      };
    }

    if (uri === "models://grok") {
      const cliInfo = getAvailableCliInfo();
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(cliInfo.grok, null, 2),
      };
    }

    if (uri === "models://mistral") {
      const cliInfo = getAvailableCliInfo();
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(cliInfo.mistral, null, 2),
      };
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
        text: JSON.stringify(getProviderToolCapabilities(), null, 2),
      };
    }

    const providerToolsResource = parseProviderToolsUri(uri);
    if (providerToolsResource) {
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(
          getOneProviderToolCapabilities(providerToolsResource.provider),
          null,
          2
        ),
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

function parseProviderToolsUri(uri: string): { provider: ProviderCapabilityId } | null {
  const prefix = uri.startsWith("provider-tools://")
    ? "provider-tools://"
    : uri.startsWith("provider_tools://")
      ? "provider_tools://"
      : null;
  if (!prefix || uri === `${prefix}catalog`) return null;
  const provider = uri.slice(prefix.length);
  if (!providerCapabilityIds().includes(provider as ProviderCapabilityId)) return null;
  return { provider: provider as ProviderCapabilityId };
}
