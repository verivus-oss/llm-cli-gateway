/**
 * Compile-time and runtime exhaustiveness assertions for the provider registry.
 *
 * These are the DRY guardrails that make "adding a provider anywhere except the
 * provider definition" a build or test failure:
 *
 *  1. `PROVIDER_DEFINITIONS satisfies Record<CliType, ProviderDefinition>` in
 *     `provider-definitions.ts` fails `npm run build` if a CLI_TYPES member has
 *     no definition or a definition is missing a required field.
 *  2. {@link assertNever} lets capability/docs/resource switches over providers
 *     fail to COMPILE when a provider is added to CLI_TYPES without a case.
 *  3. {@link assertExhaustiveProviderCoverage} and
 *     {@link assertProviderProjectionsProducible} fail a TEST if a provider is
 *     added "bare" (present in CLI_TYPES / the registry but missing the fields
 *     every required projection needs).
 */

import { CLI_TYPES, type CliType } from "./provider-types.js";
import {
  adminSurfaceKind,
  getAllProviderDefinitions,
  getProviderDefinition,
  type ProviderDefinition,
} from "./provider-definitions.js";

/**
 * Exhaustiveness helper. Call in the `default` branch of a switch over a
 * provider union so that adding a provider without a matching case is a compile
 * error (`x` is no longer `never`). Also throws at runtime as a defensive net.
 */
export function assertNever(x: never, context = "provider"): never {
  throw new Error(`Unhandled ${context}: ${JSON.stringify(x)}`);
}

/**
 * Compile-time proof that every CLI_TYPES member is covered by an exhaustive
 * switch. This function is never meant to be called for its return value; its
 * body is the load-bearing exhaustiveness check. Adding a provider to CLI_TYPES
 * without extending this switch fails `npm run build` via {@link assertNever}.
 */
export function providerScopeLabel(id: CliType): string {
  switch (id) {
    case "claude":
    case "codex":
    case "gemini":
    case "grok":
    case "mistral":
    case "devin":
      return "full";
    case "cursor":
      return "maintain-only";
    default:
      return assertNever(id, "CliType");
  }
}

/** The projections every full-scope provider definition must be able to drive. */
export const REQUIRED_PROVIDER_PROJECTIONS = [
  "syncRequestTool",
  "asyncRequestTool",
  "modelsResource",
  "sessionsResource",
  "modelDiscovery",
  "sessionContinuity",
  "capabilityRow",
  "adminDescriptor",
  "upstreamContractRow",
  "docsSummary",
] as const;

export type RequiredProviderProjection = (typeof REQUIRED_PROVIDER_PROJECTIONS)[number];

/**
 * Runtime exhaustiveness: exactly one definition per CLI_TYPES member, no extras,
 * no duplicates, and `def.id` matches its key. Throws with a precise message.
 */
export function assertExhaustiveProviderCoverage(
  defs: readonly ProviderDefinition[] = getAllProviderDefinitions()
): void {
  const seen = new Map<string, number>();
  for (const def of defs) {
    seen.set(def.id, (seen.get(def.id) ?? 0) + 1);
  }
  const missing = CLI_TYPES.filter(id => !seen.has(id));
  if (missing.length > 0) {
    throw new Error(`Provider definitions missing for CLI_TYPES member(s): ${missing.join(", ")}`);
  }
  const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  if (duplicates.length > 0) {
    throw new Error(`Duplicate provider definition(s): ${duplicates.join(", ")}`);
  }
  const extra = [...seen.keys()].filter(id => !(CLI_TYPES as readonly string[]).includes(id));
  if (extra.length > 0) {
    throw new Error(`Provider definition(s) not in CLI_TYPES: ${extra.join(", ")}`);
  }
  for (const id of CLI_TYPES) {
    if (getProviderDefinition(id).id !== id) {
      throw new Error(`Provider definition key/id mismatch for ${id}`);
    }
  }
}

/**
 * Runtime proof that a single definition carries the fields every required
 * projection needs. This is what breaks a TEST when a provider is added "bare":
 * a definition missing request tool names, docs, an upstream contract version,
 * or resource policy fails here even if it type-checks with placeholder values.
 * Returns the set of projections the definition can produce.
 */
export function assertProviderProjectionsProducible(
  def: ProviderDefinition
): ReadonlySet<RequiredProviderProjection> {
  const producible = new Set<RequiredProviderProjection>();
  const fail = (projection: RequiredProviderProjection, reason: string): never => {
    throw new Error(`Provider "${def.id}" cannot produce ${projection}: ${reason}`);
  };

  if (!def.requestSurface.sync || !def.requestSurface.syncToolName.endsWith("_request")) {
    fail("syncRequestTool", "requestSurface.sync must be true with a *_request tool name");
  }
  producible.add("syncRequestTool");

  if (!def.requestSurface.async || !def.requestSurface.asyncToolName.endsWith("_request_async")) {
    fail("asyncRequestTool", "requestSurface.async must be true with a *_request_async tool name");
  }
  producible.add("asyncRequestTool");

  if (!def.resourcePolicy.exposesModelsResource) {
    fail("modelsResource", "resourcePolicy.exposesModelsResource must be true");
  }
  producible.add("modelsResource");

  if (!def.resourcePolicy.exposesSessionsResource) {
    fail("sessionsResource", "resourcePolicy.exposesSessionsResource must be true");
  }
  producible.add("sessionsResource");

  const md = def.discovery.modelDiscovery;
  if (md.evidence.trim().length === 0) {
    fail("modelDiscovery", "modelDiscovery.evidence is required");
  }
  if (md.strategy === "native-command") {
    if (md.argv.length === 0) {
      fail("modelDiscovery", "native-command strategy requires a non-empty argv");
    }
    if (md.parse === "config-or-env" || md.parse === "curated-catalog") {
      fail("modelDiscovery", "native-command strategy requires a native parse dialect");
    }
  } else if (md.argv.length !== 0) {
    fail("modelDiscovery", "non-native strategy must have an empty argv");
  }
  producible.add("modelDiscovery");

  if (def.discovery.sessionContinuity.flags.length === 0) {
    fail("sessionContinuity", "at least one continuity flag is required");
  }
  producible.add("sessionContinuity");

  if (def.displayName.trim().length === 0 || def.executables.length === 0) {
    fail("capabilityRow", "displayName and at least one executable are required");
  }
  if (def.primaryExecutable !== def.executables[0]) {
    fail("capabilityRow", "primaryExecutable must equal executables[0]");
  }
  producible.add("capabilityRow");

  if (!Array.isArray(def.adminSubcommands)) {
    fail("adminDescriptor", "adminSubcommands must be an array");
  }
  // Honesty guard: a config-projection is a read-only view of provider state,
  // not an invokable command, so it must never be marked mutating.
  for (const family of def.adminSubcommands) {
    if (adminSurfaceKind(family) === "config-projection" && family.safety !== "read-only") {
      fail("adminDescriptor", `config-projection family "${family.family}" must be read-only`);
    }
  }
  producible.add("adminDescriptor");

  if (def.upstreamContract.targetVersion.trim().length === 0) {
    fail("upstreamContractRow", "upstreamContract.targetVersion is required");
  }
  producible.add("upstreamContractRow");

  if (def.docs.primary.length === 0) {
    fail("docsSummary", "at least one primary docs URL is required");
  }
  producible.add("docsSummary");

  // ACP integrity: no adapter-as-native masquerading, and native providers must
  // carry a non-live probe distinct from the live entrypoint argv.
  if (def.acp.classification === "native") {
    if (def.acp.entrypoint === null || def.acp.nativeEntrypoint === null) {
      fail("capabilityRow", "native ACP classification requires a non-null entrypoint");
    }
    if (def.acp.probeArgv.length === 0) {
      fail("capabilityRow", "native ACP provider must declare a safe (non-live) probe argv");
    }
    const liveArgs = (def.acp.entrypoint?.args ?? []).join(" ");
    for (const probe of def.acp.probeArgv) {
      if (probe.join(" ") === liveArgs) {
        fail("capabilityRow", "ACP probe argv must differ from the live entrypoint argv");
      }
    }
  } else {
    if (def.acp.entrypoint !== null || def.acp.nativeEntrypoint !== null) {
      fail("capabilityRow", "non-native ACP classification must have a null entrypoint");
    }
  }

  return producible;
}

/**
 * Assert the full registry: exhaustive coverage plus producible projections for
 * every definition. Throws on the first gap. Used by the assertions test as the
 * "build/test fails on a bare provider" gate.
 */
export function assertRegistryIntegrity(
  defs: readonly ProviderDefinition[] = getAllProviderDefinitions()
): void {
  assertExhaustiveProviderCoverage(defs);
  for (const def of defs) {
    assertProviderProjectionsProducible(def);
  }
}
