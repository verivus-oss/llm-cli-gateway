/**
 * Provider capability discovery (phase-1b, runtime self-discovery contract).
 *
 * Orchestrates discovery per provider by EXECUTING the provider definition's
 * declared probes (version, root help, subcommand help, model catalog, ACP
 * initialize) through an INJECTABLE probe runner. The gateway learns what the
 * INSTALLED provider can do from its executable output, not from hardcoded
 * version-specific capabilities.
 *
 * Dependency injection is the seam that makes surfaces reproject with zero
 * source edits: the default runner spawns the real process with NO shell
 * interpolation (via the repo executor helpers); tests inject a fake runner that
 * returns canned help/version/ACP-initialize strings. Changing only the fake
 * output changes the discovered set, which changes every projection derived from
 * it (cache key, schema, ACP method availability).
 *
 * Import direction: this module imports provider-definitions, provider-help-
 * parser, upstream-contracts (drift only), and the executor helpers. It must NOT
 * import provider-capability-cache or provider-schema-builder (those import the
 * types from here) to keep the module graph acyclic.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InitializeResponseSchema, type AgentCapabilities } from "./acp/types.js";
import { envWithExtendedPath, getExtendedPath, resolveCommandForSpawn } from "./executor.js";
import { type Logger, noopLogger } from "./logger.js";
import {
  getAllProviderDefinitions,
  type CliType,
  type ProviderDefinition,
  type ProviderProbe,
} from "./provider-definitions.js";
import {
  checksumText,
  parseHelpText,
  type DiscoveredUnmapped,
  type ParsedHelp,
} from "./provider-help-parser.js";
import {
  computeDiscoveryContractDrift,
  type DiscoveryContractDrift,
} from "./upstream-contracts.js";

/** The raw result of running a single probe. */
export interface ProbeResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/**
 * The injection seam. Given an executable name and an argv array (never a shell
 * string), resolve a {@link ProbeResult}. Implementations MUST NOT interpolate a
 * shell. Tests supply a fake that returns canned output keyed by exe+argv.
 */
export type ProbeRunner = (exe: string, argv: readonly string[]) => Promise<ProbeResult>;

/** Parsed model-catalog probe result. */
export interface DiscoveredModelCatalog {
  readonly strategy: string;
  readonly argv: readonly string[];
  /** Raw stdout when a native model-listing command ran; null otherwise. */
  readonly raw: string | null;
  readonly checksum: string;
  readonly evidence: string;
}

/** ACP methods known to the Agent Client Protocol spec (schema-known). */
export const KNOWN_ACP_METHODS: readonly string[] = [
  "initialize",
  "authenticate",
  "session/new",
  "session/load",
  "session/resume",
  "session/list",
  "session/prompt",
  "session/cancel",
  "session/close",
  "session/delete",
  "session/update",
  "session/set_mode",
  "session/set_config_option",
  "session/request_permission",
  "fs/read_text_file",
  "fs/write_text_file",
  "terminal/create",
  "terminal/output",
  "terminal/release",
];

/** Parsed ACP `initialize` response capability surface. */
export interface ParsedAcpInitialize {
  readonly protocolVersion: number | string | null;
  readonly agentInfo: { readonly name?: string; readonly version?: string } | null;
  readonly authMethods: readonly string[];
  readonly promptCapabilities: readonly string[];
  readonly mcpCapabilities: readonly string[];
  readonly sessionCapabilities: readonly string[];
  /**
   * The parsed, spec-shaped nested agent capability bag (agentCapabilities), or
   * null when the agent advertised none. This is the SAME shape the runtime
   * negotiates via `InitializeResponseSchema`, so method availability is derived
   * from it with `deriveAcpMethodAvailability` (not from a divergent top-level
   * shape).
   */
  readonly agentCapabilities: AgentCapabilities | null;
  /** Advertised methods that are known to the ACP spec (enabled via generic client). */
  readonly knownMethods: readonly string[];
  /** Advertised methods NOT in the ACP spec (surfaced as discovered-unmapped). */
  readonly extensionMethods: readonly string[];
  readonly checksum: string;
}

/** The normalized discovered capability surface for one provider. */
export interface DiscoveredCapabilitySet {
  readonly providerId: CliType;
  readonly executable: string;
  /** Absolute path of the resolved executable (a cache key field). */
  readonly executablePath: string;
  readonly version: string;
  readonly rootHelp: ParsedHelp;
  /** Parsed subcommand help keyed by the probe's argv (with optional exe prefix). */
  readonly subcommandHelp: Readonly<Record<string, ParsedHelp>>;
  readonly modelCatalog: DiscoveredModelCatalog;
  /** Parsed ACP initialize response, or null for non-ACP / no-initialize providers. */
  readonly acpInitialize: ParsedAcpInitialize | null;
  readonly checksums: {
    readonly version: string;
    readonly rootHelp: string;
    readonly subcommandHelp: Readonly<Record<string, string>>;
    readonly modelCatalog: string;
    readonly acpInitialize: string | null;
  };
  /** Human-readable evidence of what was probed (no secrets). */
  readonly sourceEvidence: readonly string[];
  /** Everything discovered but not confidently mapped, with checksums + reasons. */
  readonly discoveredUnmapped: readonly DiscoveredUnmapped[];
  /** Discovery outcome. Visible to cli_versions / provider_tool_capabilities / logs. */
  readonly status: "ok" | "degraded" | "error";
  /** Present when status is degraded/error. */
  readonly degradedReason?: string;
  readonly gatewayVersion: string;
  readonly discoveredAt: string;
}

/** Options common to the discovery entrypoints. */
export interface DiscoveryOptions {
  readonly runner?: ProbeRunner;
  readonly gatewayVersion?: string;
  readonly resolveExecutablePath?: (exe: string) => string;
  readonly logger?: Logger;
}

let cachedGatewayVersion: string | undefined;

/** Read the gateway package version (best-effort; "unknown" on failure). */
export function gatewayVersion(): string {
  if (cachedGatewayVersion !== undefined) return cachedGatewayVersion;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "..", "package.json"), join(here, "..", "..", "package.json")];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: string };
      if (parsed.version) {
        cachedGatewayVersion = parsed.version;
        return cachedGatewayVersion;
      }
    } catch {
      // try next
    }
  }
  cachedGatewayVersion = "unknown";
  return cachedGatewayVersion;
}

/**
 * Default executable-path resolver: scan the extended PATH for the executable.
 * Returns the absolute path when found, else the bare exe name (still a stable,
 * non-secret cache-key component).
 */
export function resolveExecutableAbsolutePath(exe: string): string {
  const extendedPath = getExtendedPath();
  const resolved = resolveCommandForSpawn(exe, [], { envPath: extendedPath });
  if (resolved.command !== exe) return resolved.command;
  // Non-Windows: resolveCommandForSpawn returns the bare command. Probe PATH.
  const result = spawnSync(process.platform === "win32" ? "where" : "command", ["-v", exe], {
    encoding: "utf8",
    timeout: 3000,
    windowsHide: true,
    shell: process.platform !== "win32", // `command -v` needs a shell; read-only lookup, fixed argv
  });
  const out = (result.stdout ?? "").split(/\r?\n/).find(line => line.trim().length > 0);
  return out?.trim() || exe;
}

/**
 * The default probe runner. Spawns the real executable with a fixed argv array
 * and NO shell interpolation, mirroring the read-only spawn pattern used by
 * {@link probeInstalledAcpEntrypoint}. Non-zero exit is returned (not thrown):
 * many `--help`/`--version` surfaces exit non-zero yet still emit parseable
 * text. A genuine spawn failure (ENOENT etc.) throws so the orchestrator can
 * degrade that provider.
 */
export function createDefaultProbeRunner(timeoutMs = 5000): ProbeRunner {
  return async (exe, argv) => {
    const extendedPath = getExtendedPath();
    const env = envWithExtendedPath(process.env, extendedPath);
    const resolved = resolveCommandForSpawn(exe, [...argv], { envPath: extendedPath });
    const result = spawnSync(resolved.command, resolved.args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env,
      windowsHide: true,
      windowsVerbatimArguments: resolved.windowsVerbatimArguments,
    });
    if (result.error) throw result.error;
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      code: result.status ?? 0,
    };
  };
}

/** The shared default runner. */
export const defaultProbeRunner: ProbeRunner = createDefaultProbeRunner();

function probeExecutable(def: ProviderDefinition, probe: ProviderProbe): string {
  return probe.executable ?? def.primaryExecutable;
}

/** A stable key for a subcommand-help probe: `[exe ]arg arg`. */
function subcommandProbeKey(def: ProviderDefinition, probe: ProviderProbe): string {
  const exe = probeExecutable(def, probe);
  const prefix = exe === def.primaryExecutable ? "" : `${exe} `;
  return `${prefix}${probe.argv.join(" ")}`;
}

/**
 * Outcome of parsing an ACP `initialize` response from probe stdout.
 *  - `none`:    not a JSON-RPC response at all (e.g. `--help` text). NORMAL for
 *               the real probe runner; the provider simply advertised no
 *               initialize response. Does not degrade discovery.
 *  - `ok`:      a valid initialize response was parsed.
 *  - `invalid`: the output LOOKS like JSON but is malformed / fails validation.
 *               Surfaced by discovery as a degraded status, never a crash.
 */
export type AcpInitializeParse =
  | { readonly kind: "none" }
  | { readonly kind: "ok"; readonly value: ParsedAcpInitialize }
  | { readonly kind: "invalid"; readonly reason: string };

/**
 * Convert a nested capability bag (e.g. `agentCapabilities.promptCapabilities`
 * or `.sessionCapabilities`) into the list of present capability tokens. A token
 * is "present" when its value is neither `false`, `null`, nor `undefined`
 * (booleans that are true, or sub-capability objects). The reserved `_meta` key
 * is never surfaced as a capability token.
 */
function presentCapabilityTokens(bag: Record<string, unknown> | undefined | null): string[] {
  if (!bag || typeof bag !== "object") return [];
  return Object.entries(bag)
    .filter(([key]) => key !== "_meta")
    .filter(([, value]) => value !== false && value !== null && value !== undefined)
    .map(([key]) => key);
}

/**
 * Convert the top-level `authMethods` array (per the ACP spec, an array of
 * `{ id?, name?, ... }`) into display tokens, preferring `id` then `name`.
 */
function authMethodTokens(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(entry => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry === "object") {
        const record = entry as { id?: unknown; name?: unknown };
        if (typeof record.id === "string") return record.id;
        if (typeof record.name === "string") return record.name;
      }
      return null;
    })
    .filter((entry): entry is string => typeof entry === "string");
}

/**
 * Convert a possibly-array-or-string vendor "methods" list into strings. Only
 * used for the OPTIONAL vendor-advertised explicit method list (a passthrough
 * extra); capability derivation itself comes from the typed nested bags.
 */
function methodListToStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(entry =>
      typeof entry === "string"
        ? entry
        : entry &&
            typeof entry === "object" &&
            typeof (entry as { name?: unknown }).name === "string"
          ? (entry as { name: string }).name
          : null
    )
    .filter((entry): entry is string => typeof entry === "string");
}

/**
 * Parse an ACP `initialize` JSON-RPC response from probe stdout. See
 * {@link AcpInitializeParse} for the tri-state contract.
 *
 * Parsing uses the SAME `InitializeResponseSchema` the live runtime negotiates,
 * so capabilities are read from the spec-shaped nested `agentCapabilities`
 * (`agentCapabilities.{promptCapabilities,mcpCapabilities,sessionCapabilities,
 * loadSession}`) plus the top-level `authMethods`, not a divergent top-level
 * capability shape. Vendor extras (an explicit `methods`/`availableMethods`
 * list, unknown keys) survive via passthrough and are surfaced as
 * discovered-unmapped rather than dropped.
 */
export function parseAcpInitialize(text: string): AcpInitializeParse {
  const trimmed = text.trim();
  // Not JSON-ish at all -> the provider advertised no initialize response.
  if (trimmed.length === 0 || !(trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return { kind: "none" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "invalid", reason: "ACP initialize output is not valid JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid", reason: "ACP initialize output is not a JSON object" };
  }

  // Accept a bare initialize result OR a JSON-RPC envelope { result: ... }.
  const root = parsed as Record<string, unknown>;
  const candidate =
    root.result !== undefined && typeof root.result === "object" && root.result !== null
      ? (root.result as Record<string, unknown>)
      : root;

  const validated = InitializeResponseSchema.safeParse(candidate);
  if (!validated.success) {
    return {
      kind: "invalid",
      reason: `ACP initialize response failed validation: ${validated.error.message}`,
    };
  }
  const result = validated.data;
  const caps = result.agentCapabilities ?? null;

  const agentInfo = result.agentInfo
    ? {
        ...(typeof result.agentInfo.name === "string" ? { name: result.agentInfo.name } : {}),
        ...(typeof result.agentInfo.version === "string"
          ? { version: result.agentInfo.version }
          : {}),
      }
    : null;

  // Optional vendor-advertised explicit method list survives via passthrough.
  const advertisedMethods = methodListToStrings(
    (candidate as { methods?: unknown }).methods ??
      (candidate as { availableMethods?: unknown }).availableMethods
  );
  const knownMethods = advertisedMethods.filter(method => KNOWN_ACP_METHODS.includes(method));
  const extensionMethods = advertisedMethods.filter(method => !KNOWN_ACP_METHODS.includes(method));

  const protocolVersion =
    typeof result.protocolVersion === "number" ? result.protocolVersion : null;

  const sessionTokens = presentCapabilityTokens(
    caps?.sessionCapabilities as Record<string, unknown> | undefined
  );
  if (caps?.loadSession === true) sessionTokens.push("load");

  return {
    kind: "ok",
    value: {
      protocolVersion,
      agentInfo,
      authMethods: authMethodTokens(result.authMethods),
      promptCapabilities: presentCapabilityTokens(
        caps?.promptCapabilities as Record<string, unknown> | undefined
      ),
      mcpCapabilities: presentCapabilityTokens(
        caps?.mcpCapabilities as Record<string, unknown> | undefined
      ),
      sessionCapabilities: sessionTokens,
      agentCapabilities: caps,
      knownMethods,
      extensionMethods,
      checksum: checksumText(trimmed),
    },
  };
}

const EMPTY_HELP: ParsedHelp = {
  flags: [],
  subcommands: [],
  discoveredUnmapped: [],
  checksum: checksumText(""),
};

/**
 * Discover the capability surface of ONE provider by executing its declared
 * probes through `runner`. Never throws for a single failed probe: it records
 * evidence and degrades. A total failure (version probe unavailable) yields a
 * minimal `error` set so the caller can fall back to a valid cached set.
 */
export async function discoverProviderCapabilities(
  def: ProviderDefinition,
  options: DiscoveryOptions = {}
): Promise<DiscoveredCapabilitySet> {
  const runner = options.runner ?? defaultProbeRunner;
  const resolvePath = options.resolveExecutablePath ?? resolveExecutableAbsolutePath;
  const version = options.gatewayVersion ?? gatewayVersion();
  const logger = options.logger ?? noopLogger;

  const evidence: string[] = [];
  const unmapped: DiscoveredUnmapped[] = [];
  const discoveredAt = new Date().toISOString();

  let executablePath: string;
  try {
    executablePath = resolvePath(def.primaryExecutable);
  } catch {
    executablePath = def.primaryExecutable;
  }

  // ---- version probe (identity; failure => error set) -------------------
  let versionString: string;
  try {
    const result = await runner(def.primaryExecutable, def.discovery.version.argv);
    versionString = (result.stdout || result.stderr).split(/\r?\n/)[0]?.trim() ?? "";
    evidence.push(`version: ${def.primaryExecutable} ${def.discovery.version.argv.join(" ")}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.debug(`capability discovery: ${def.id} version probe failed`, { reason });
    return {
      providerId: def.id,
      executable: def.primaryExecutable,
      executablePath,
      version: "",
      rootHelp: EMPTY_HELP,
      subcommandHelp: {},
      modelCatalog: {
        strategy: def.discovery.modelDiscovery.strategy,
        argv: def.discovery.modelDiscovery.argv,
        raw: null,
        checksum: checksumText(def.discovery.modelDiscovery.evidence),
        evidence: def.discovery.modelDiscovery.evidence,
      },
      acpInitialize: null,
      checksums: {
        version: checksumText(""),
        rootHelp: EMPTY_HELP.checksum,
        subcommandHelp: {},
        modelCatalog: checksumText(def.discovery.modelDiscovery.evidence),
        acpInitialize: null,
      },
      sourceEvidence: evidence,
      discoveredUnmapped: unmapped,
      status: "error",
      degradedReason: `version probe failed: ${reason}`,
      gatewayVersion: version,
      discoveredAt,
    };
  }

  let degraded = false;
  let degradedReason: string | undefined;

  // ---- root help --------------------------------------------------------
  let rootHelp = EMPTY_HELP;
  try {
    const result = await runner(def.primaryExecutable, def.discovery.rootHelp.argv);
    rootHelp = parseHelpText(result.stdout || result.stderr);
    unmapped.push(...rootHelp.discoveredUnmapped);
    evidence.push(`root-help: ${def.primaryExecutable} ${def.discovery.rootHelp.argv.join(" ")}`);
  } catch (err) {
    degraded = true;
    degradedReason = `root help probe failed: ${err instanceof Error ? err.message : String(err)}`;
    logger.debug(`capability discovery: ${def.id} root help probe failed`, { degradedReason });
  }

  // ---- subcommand help --------------------------------------------------
  const subcommandHelp: Record<string, ParsedHelp> = {};
  const subcommandChecksums: Record<string, string> = {};
  for (const probe of def.discovery.subcommandHelp) {
    const key = subcommandProbeKey(def, probe);
    const exe = probeExecutable(def, probe);
    try {
      const result = await runner(exe, probe.argv);
      const parsed = parseHelpText(result.stdout || result.stderr);
      subcommandHelp[key] = parsed;
      subcommandChecksums[key] = parsed.checksum;
      unmapped.push(...parsed.discoveredUnmapped);
      evidence.push(`subcommand-help: ${exe} ${probe.argv.join(" ")}`);
    } catch (err) {
      degraded = true;
      degradedReason = `subcommand help probe failed (${key}): ${err instanceof Error ? err.message : String(err)}`;
      logger.debug(`capability discovery: ${def.id} subcommand help probe failed`, {
        key,
        degradedReason,
      });
    }
  }

  // ---- model catalog ----------------------------------------------------
  const md = def.discovery.modelDiscovery;
  let modelRaw: string | null = null;
  let modelChecksum = checksumText(md.evidence);
  if (md.strategy === "native-command" && md.argv.length > 0) {
    try {
      const result = await runner(def.primaryExecutable, md.argv);
      // SECURITY/correctness: only treat output as a catalog when the command
      // SUCCEEDED (exit 0) AND emitted non-empty stdout. A non-zero exit or
      // stdout-empty/stderr-only result is NOT a model catalog: it is typically
      // an auth/account error whose stderr (an email/account id) would otherwise
      // be parsed into "models". Record it as degraded evidence; leave modelRaw
      // null so the parser never sees it.
      const stdout = result.stdout ?? "";
      if (result.code === 0 && stdout.trim().length > 0) {
        modelRaw = stdout;
        modelChecksum = checksumText(modelRaw);
        evidence.push(`model-catalog: ${def.primaryExecutable} ${md.argv.join(" ")}`);
      } else {
        degraded = true;
        const why = stdout.trim().length === 0 ? "empty stdout" : "stderr-only output";
        degradedReason = `model catalog probe unusable (exit ${result.code}, ${why}); not treated as a catalog`;
        evidence.push(
          `model-catalog: ${def.primaryExecutable} ${md.argv.join(" ")} (exit ${result.code}; ignored)`
        );
        logger.debug(`capability discovery: ${def.id} model catalog probe unusable`, {
          degradedReason,
        });
      }
    } catch (err) {
      degraded = true;
      degradedReason = `model catalog probe failed: ${err instanceof Error ? err.message : String(err)}`;
      logger.debug(`capability discovery: ${def.id} model catalog probe failed`, {
        degradedReason,
      });
    }
  } else {
    evidence.push(`model-catalog: ${md.strategy} (no read-only listing command)`);
  }
  const modelCatalog: DiscoveredModelCatalog = {
    strategy: md.strategy,
    argv: md.argv,
    raw: modelRaw,
    checksum: modelChecksum,
    evidence: md.evidence,
  };

  // ---- ACP initialize ---------------------------------------------------
  let acpInitialize: ParsedAcpInitialize | null = null;
  let acpChecksum: string | null = null;
  if (def.acp.classification === "native" && def.acp.probeArgv.length > 0) {
    const acpProbe = def.acp.probeArgv[0];
    const exe = def.acp.entrypoint?.command ?? def.primaryExecutable;
    try {
      const result = await runner(exe, acpProbe);
      const parsed = parseAcpInitialize(result.stdout || result.stderr);
      if (parsed.kind === "ok") {
        acpInitialize = parsed.value;
        acpChecksum = parsed.value.checksum;
        evidence.push(`acp-initialize: ${exe} ${acpProbe.join(" ")}`);
        for (const method of parsed.value.extensionMethods) {
          unmapped.push({
            kind: "acp-method",
            raw: method,
            checksum: checksumText(method),
            reason:
              "ACP method advertised by initialize is not known to the ACP spec and has no extension-namespace normalizer",
          });
        }
      } else if (parsed.kind === "invalid") {
        // JSON-ish but malformed initialize response: surface as degraded, not a
        // crash and not a silently-dropped capability.
        degraded = true;
        degradedReason = `acp initialize invalid: ${parsed.reason}`;
        evidence.push(`acp-probe: ${exe} ${acpProbe.join(" ")} (invalid initialize response)`);
        logger.debug(`capability discovery: ${def.id} acp initialize invalid`, { degradedReason });
      } else {
        evidence.push(`acp-probe: ${exe} ${acpProbe.join(" ")} (no initialize response)`);
      }
    } catch (err) {
      degraded = true;
      degradedReason = `acp probe failed: ${err instanceof Error ? err.message : String(err)}`;
      logger.debug(`capability discovery: ${def.id} acp probe failed`, { degradedReason });
    }
  }

  return {
    providerId: def.id,
    executable: def.primaryExecutable,
    executablePath,
    version: versionString,
    rootHelp,
    subcommandHelp,
    modelCatalog,
    acpInitialize,
    checksums: {
      version: checksumText(versionString),
      rootHelp: rootHelp.checksum,
      subcommandHelp: subcommandChecksums,
      modelCatalog: modelChecksum,
      acpInitialize: acpChecksum,
    },
    sourceEvidence: evidence,
    discoveredUnmapped: unmapped,
    status: degraded ? "degraded" : "ok",
    ...(degraded ? { degradedReason } : {}),
    gatewayVersion: version,
    discoveredAt,
  };
}

/**
 * Discover every provider definition. Async and per-provider fault-isolated: a
 * failure discovering one provider never rejects the whole map, so startup
 * discovery can never block or crash the MCP server.
 */
export async function discoverAllProviders(
  options: DiscoveryOptions = {}
): Promise<Map<CliType, DiscoveredCapabilitySet>> {
  const out = new Map<CliType, DiscoveredCapabilitySet>();
  const results = await Promise.all(
    getAllProviderDefinitions().map(async def => {
      try {
        return await discoverProviderCapabilities(def, options);
      } catch (err) {
        // Defensive: discoverProviderCapabilities is already fault-isolated, but
        // never let a surprise reject the whole batch.
        const reason = err instanceof Error ? err.message : String(err);
        const version = options.gatewayVersion ?? gatewayVersion();
        const set: DiscoveredCapabilitySet = {
          providerId: def.id,
          executable: def.primaryExecutable,
          executablePath: def.primaryExecutable,
          version: "",
          rootHelp: EMPTY_HELP,
          subcommandHelp: {},
          modelCatalog: {
            strategy: def.discovery.modelDiscovery.strategy,
            argv: def.discovery.modelDiscovery.argv,
            raw: null,
            checksum: checksumText(def.discovery.modelDiscovery.evidence),
            evidence: def.discovery.modelDiscovery.evidence,
          },
          acpInitialize: null,
          checksums: {
            version: checksumText(""),
            rootHelp: EMPTY_HELP.checksum,
            subcommandHelp: {},
            modelCatalog: checksumText(def.discovery.modelDiscovery.evidence),
            acpInitialize: null,
          },
          sourceEvidence: [],
          discoveredUnmapped: [],
          status: "error",
          degradedReason: `discovery threw: ${reason}`,
          gatewayVersion: version,
          discoveredAt: new Date().toISOString(),
        };
        return set;
      }
    })
  );
  for (const set of results) out.set(set.providerId, set);
  return out;
}

/** All ACP methods the gateway can enable through the generic client for a set. */
export function acpMethodAvailability(set: DiscoveredCapabilitySet): {
  readonly acpAvailable: boolean;
  readonly knownMethods: readonly string[];
  readonly extensionMethods: readonly string[];
} {
  if (!set.acpInitialize) {
    return { acpAvailable: false, knownMethods: [], extensionMethods: [] };
  }
  return {
    acpAvailable: true,
    knownMethods: set.acpInitialize.knownMethods,
    extensionMethods: set.acpInitialize.extensionMethods,
  };
}

/**
 * Compute installed-vs-contract drift as a discovery event. Delegates the
 * comparison to {@link computeDiscoveryContractDrift} in upstream-contracts.ts
 * (the checked-in guardrail) so the offline `upstream:contracts` gate is
 * unaffected.
 */
export function discoveryContractDrift(set: DiscoveredCapabilitySet): DiscoveryContractDrift {
  const discoveredFlagNames = new Set<string>();
  for (const flag of set.rootHelp.flags) {
    discoveredFlagNames.add(flag.name);
    for (const alias of flag.aliases) discoveredFlagNames.add(alias);
  }
  return computeDiscoveryContractDrift(set.providerId, {
    version: set.version,
    discoveredFlagNames: [...discoveredFlagNames],
    discoveredUnmappedCount: set.discoveredUnmapped.length,
    status: set.status,
  });
}
