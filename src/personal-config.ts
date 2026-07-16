import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  constants as fsConstants,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { Logger } from "./logger.js";
import { noopLogger } from "./logger.js";
import { defaultGatewayConfigPath } from "./config.js";
import type { WorkspaceRepo } from "./workspace-registry.js";
import type { KitExecutionRef } from "./personal-config-types.js";

export const PERSONAL_CONFIG_COMPILER_VERSION = "1";
export const DEFAULT_PERSONAL_CONFIG_MAX_STALE_HOURS = 168;
export const MAX_REQUEST_INSTRUCTIONS_BYTES = 16 * 1024;
export const MAX_EFFECTIVE_CONTEXT_BYTES = 64 * 1024;
export const KIT_ABSOLUTE_WORKING_DIR_REQUIRED =
  "Personal Agent Config Kit workingDir must be absolute; pass an absolute workingDir or select a registered workspace alias";
const MAX_CONFIG_SOURCE_BYTES = 512 * 1024;
const MAX_RELEASE_FILE_COUNT = 256;
const MAX_RELEASE_TREE_BYTES = 4 * 1024 * 1024;
const MAX_RELEASE_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_KIT_TURNS_CAP = 10_000;
const MAX_KIT_BUDGET_USD_CAP = 10_000;
const MAX_KIT_MODEL_IDENTIFIER_LENGTH = 128;
const KIT_MODEL_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$/;
const KIT_PREFERENCE_KEYS = new Set([
  "model_default",
  "output_format_default",
  "max_turns_cap",
  "max_budget_usd_cap",
  "codex_sandbox_mode",
]);
const KIT_LAYER_CONFIG_KEYS = new Set(["instructions", "context", "preferences"]);
const KIT_CONTEXT_KEYS = new Set(["instructions"]);
const RELEASE_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const CLAUDE_ARTIFACT_REAP_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * Wall-clock budget for one Kit network Git invocation (clone, fetch, push).
 * Network Git runs through spawnSync, which blocks the whole gateway event loop
 * for every provider and principal while it holds the Kit lock, so a hung or
 * black-holed remote must not be able to freeze the process indefinitely. The
 * Kit baseline is a small bounded repository (see MAX_RELEASE_TREE_BYTES), so a
 * generous budget cannot plausibly cut a healthy operation short. Local Git
 * plumbing stays unbounded and is unaffected.
 *
 * This is a module constant rather than a [personal_config] key: the settings
 * loader validates by hand rather than through a shared schema, and every
 * network entry point already accepts PersonalConfigNetworkOptions.timeoutMs.
 */
export const PERSONAL_CONFIG_NETWORK_GIT_TIMEOUT_MS = 120_000;
/**
 * SIGTERM can be absorbed by a stuck transport helper, which would leave
 * spawnSync blocked exactly as before. Kill outright instead.
 */
const NETWORK_GIT_KILL_SIGNAL: NodeJS.Signals = "SIGKILL";

export type PersonalConfigErrorCode =
  | "kit_busy"
  | "kit_disabled"
  | "kit_context_conflict"
  | "kit_provider_unsupported"
  | "kit_context_too_large"
  | "kit_request_instructions_too_large"
  | "kit_overlay_outside_scope"
  | "kit_release_missing"
  | "kit_release_pruned"
  | "kit_sync_dirty"
  | "kit_sync_diverged"
  | "kit_stale"
  | "kit_invalid_baseline";

export class PersonalConfigError extends Error {
  readonly code: PersonalConfigErrorCode;

  constructor(code: PersonalConfigErrorCode, message: string) {
    super(message);
    this.name = "PersonalConfigError";
    this.code = code;
  }
}

export interface PersonalConfigSettings {
  enabled: boolean;
  baselinePath: string;
  maxStaleHours: number;
}

export interface PersonalConfigSources {
  configFile: string | null;
}

export interface LoadedPersonalConfig {
  settings: PersonalConfigSettings;
  sources: PersonalConfigSources;
}

export interface KitPathLayout {
  baselineDir: string;
  runtimeDir: string;
  localTomlPath: string;
  statePath: string;
  releasesDir: string;
  currentPointerPath: string;
  lockPath: string;
  artifactsDir: string;
}

export interface LocalMachineBinding {
  machineId: string;
  providers: Record<string, { available?: boolean; path?: string; disabled?: boolean }>;
}

export interface PersonalConfigState {
  currentReleaseId: string | null;
  lastSuccessAt: string | null;
  lastSyncError: string | null;
  staleAckUntil: string | null;
  /** Release whose active acknowledgement may suppress stale execution. */
  staleAckReleaseId: string | null;
  /** Most recently acknowledged release, retained for state-file compatibility. */
  staleAckUsedForReleaseId: string | null;
  /** Every release acknowledged since the most recent successful synchronization. */
  staleAckUsedForReleaseIds: string[];
  /** Whether the persisted acknowledgement history is complete enough to grant another one. */
  staleAckHistoryComplete: boolean;
}

export interface PersonalConfigReleaseManifest {
  version: 1;
  releaseId: string;
  baselineCommit: string;
  createdAt: string;
  verified: true;
  treeDigest: string;
}

export interface PersonalConfigRelease {
  id: string;
  root: string;
  manifest: PersonalConfigReleaseManifest;
}

export interface KitScope {
  cwd: string;
  scopeRoot: string | null;
  registeredWorkspaceAlias: string | null;
  repoHead: string | null;
  overlayPath: string | null;
}

export interface ResolvedKitContext {
  release: PersonalConfigRelease;
  scope: KitScope;
  text: string;
  contextDigest: string;
  configStamp: string;
  execution: KitExecutionRef;
  preferences: KitPreferences;
  provenance: Array<{ source: "bundled" | "personal" | "repository" | "request"; digest: string }>;
}

export interface KitPreferences {
  modelDefault?: string;
  /** Cross-provider response format preference. */
  outputFormatDefault?: "text" | "json";
  maxTurnsCap?: number;
  maxBudgetUsdCap?: number;
  /** Kit-owned Codex filesystem posture. Never permits danger-full-access. */
  codexSandboxMode?: "read-only" | "workspace-write";
}

export interface ClaudeContextArtifact {
  path: string;
  digest: string;
  /** Bind this private context file to its pre-reserved durable job id. */
  bindToJob: (jobId: string) => void;
  cleanup: () => void;
}

/**
 * `not_found` is a positive healthy-store answer, unlike `unavailable`.
 * Reaping may use it after grace because no durable provider job can still
 * consume the artifact.
 */
export type ClaudeArtifactJobState = "active" | "terminal" | "not_found" | "unavailable";

export interface ResolveKitScopeInput {
  cwd?: string;
  registeredWorkspaces?: ReadonlyArray<Pick<WorkspaceRepo, "alias" | "path">>;
  remote?: boolean;
  /**
   * Workspace alias the caller named on this request. It is an assertion about
   * this request's scope, so an alias that does not contain the canonical
   * working directory is a contradiction and fails closed.
   */
  requestedWorkspaceAlias?: string;
  /**
   * Configured default workspace alias. It is a fallback for callers that named
   * no workspace, not an assertion about this request, so a default that does
   * not contain the canonical working directory yields Git-root scope instead
   * of an error. Ignored when requestedWorkspaceAlias is present.
   */
  defaultWorkspaceAlias?: string;
}

export interface BuildKitContextInput {
  layout: KitPathLayout;
  machine: LocalMachineBinding;
  scope: KitScope;
  bundledInstructions?: string;
  requestInstructions?: string;
}

/**
 * Result surface of one bounded network Git spawn. It is deliberately a
 * structural subset of SpawnSyncReturns so the real spawnSync return value and
 * an injected test result share one shape.
 */
export interface PersonalConfigNetworkGitResult {
  stdout?: string | null;
  stderr?: string | null;
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
}

export type PersonalConfigNetworkGitSpawn = (
  args: readonly string[],
  options: { timeoutMs: number; killSignal: NodeJS.Signals }
) => PersonalConfigNetworkGitResult;

/**
 * Test seam for the bounded network Git spawns, following the established
 * ReviewScopeHooks / ReviewPromptHooks pattern. A timeout regression must be
 * provable without a real hanging remote, because the failure being guarded
 * against is precisely that the process never returns.
 */
export interface PersonalConfigGitHooks {
  spawnNetworkGit?: PersonalConfigNetworkGitSpawn;
}

export interface PersonalConfigNetworkOptions {
  /** Wall-clock budget for one network Git invocation. */
  timeoutMs?: number;
  hooks?: PersonalConfigGitHooks;
}

export interface SyncPersonalConfigOptions extends PersonalConfigNetworkOptions {
  branch?: string;
}

export interface PersonalConfigStatus {
  enabled: boolean;
  baselinePresent: boolean;
  currentReleaseId: string | null;
  lastSuccessAt: string | null;
  stale: boolean;
  staleAckUntil: string | null;
  lastSyncError: string | null;
}

/**
 * Stored Git failures can contain private remotes, credentials, and machine
 * paths. Status callers receive this stable marker instead of any persisted
 * diagnostic, including values written by older gateway versions.
 */
export const PERSONAL_CONFIG_SYNC_ERROR_WITHHELD =
  "upstream synchronization failed; retained the current verified release";

const PERSONAL_CONFIG_STATE_ERROR_WITHHELD = "Personal Agent Config state is unavailable";

function requireToml(): {
  parse(value: string): Record<string, unknown>;
  stringify(value: object): string;
} {
  const require = createRequire(import.meta.url);
  return require("smol-toml") as {
    parse(value: string): Record<string, unknown>;
    stringify(value: object): string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  return value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
}

function isUnder(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * Resolve the configured baseline to a private, non-symlinked descendant of
 * the current user's home directory. `config_init` normalizes permissions
 * recursively, so accepting `/`, the home directory itself, a traversal, or
 * a symlink escape here could change permissions outside the Kit boundary.
 */
function resolveSafePersonalBaselinePath(value: string): string {
  if (!value || value.split(/[\\/]+/u).includes("..")) {
    throw new PersonalConfigError(
      "kit_invalid_baseline",
      "[personal_config].baseline_path must be a non-home directory below the current user's home"
    );
  }

  const expanded = expandHome(value);
  if (!path.isAbsolute(expanded)) {
    throw new PersonalConfigError(
      "kit_invalid_baseline",
      "[personal_config].baseline_path must be an absolute path or begin with ~/"
    );
  }

  let canonicalHome: string;
  try {
    canonicalHome = realpathSync(path.resolve(homedir()));
  } catch {
    throw new PersonalConfigError(
      "kit_invalid_baseline",
      "Unable to resolve the current user's home directory for Personal Agent Config Kit"
    );
  }

  const configuredHome = path.resolve(homedir());
  const candidate = path.resolve(expanded);
  const relative = isUnder(configuredHome, candidate)
    ? path.relative(configuredHome, candidate)
    : isUnder(canonicalHome, candidate)
      ? path.relative(canonicalHome, candidate)
      : null;
  if (!relative) {
    throw new PersonalConfigError(
      "kit_invalid_baseline",
      "[personal_config].baseline_path must be a non-home directory below the current user's home"
    );
  }

  const resolved = path.resolve(canonicalHome, relative);
  if (!isUnder(canonicalHome, resolved) || resolved === canonicalHome) {
    throw new PersonalConfigError(
      "kit_invalid_baseline",
      "[personal_config].baseline_path must be a non-home directory below the current user's home"
    );
  }

  let current = canonicalHome;
  try {
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      if (!existsSync(current)) break;
      if (lstatSync(current).isSymbolicLink()) {
        throw new PersonalConfigError(
          "kit_invalid_baseline",
          "[personal_config].baseline_path may not traverse symbolic links"
        );
      }
    }
  } catch (error) {
    if (error instanceof PersonalConfigError) throw error;
    throw new PersonalConfigError(
      "kit_invalid_baseline",
      "Unable to verify [personal_config].baseline_path"
    );
  }
  return resolved;
}

/** Refuse a pre-existing symlink component before recursively changing modes. */
function assertNoSymbolicLinkPathComponent(root: string): void {
  const normalized = path.resolve(root);
  const parsed = path.parse(normalized);
  let current = parsed.root;
  try {
    for (const segment of path.relative(parsed.root, normalized).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      if (lstatSync(current).isSymbolicLink()) {
        throw new PersonalConfigError(
          "kit_invalid_baseline",
          "Baseline path may not traverse symbolic links"
        );
      }
    }
  } catch (error) {
    if (error instanceof PersonalConfigError) throw error;
    throw new PersonalConfigError("kit_invalid_baseline", "Unable to verify baseline path safety");
  }
}

function validPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isSafePersonalConfigRemoteHost(hostname: string): boolean {
  return hostname.length > 0 && !hostname.startsWith("-");
}

export function validatePersonalConfigRemote(remote: string): string {
  if (
    remote.length === 0 ||
    remote !== remote.trim() ||
    [...remote].some(character => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f || /\s/u.test(character);
    }) ||
    remote.includes("::") ||
    remote.includes("\\")
  ) {
    throw new PersonalConfigError(
      "kit_invalid_baseline",
      "Baseline remote must be a standard HTTPS, SSH, or SCP-style Git URL"
    );
  }
  try {
    const parsed = new URL(remote);
    const isUnauthenticatedHttps =
      parsed.protocol === "https:" && !parsed.username && !parsed.password;
    const isStandardSsh =
      parsed.protocol === "ssh:" &&
      !parsed.password &&
      (!parsed.username || /^[A-Za-z0-9._-]+$/.test(parsed.username));
    const hasNoQueryOrFragment = !parsed.search && !parsed.hash;
    if (
      (isUnauthenticatedHttps || isStandardSsh) &&
      hasNoQueryOrFragment &&
      isSafePersonalConfigRemoteHost(parsed.hostname)
    ) {
      return remote;
    }
  } catch {
    // A non-URL remote may still be the safe user@host:path SCP notation.
  }
  const scpRemote = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):[A-Za-z0-9._~/-]+$/.exec(remote);
  if (scpRemote && isSafePersonalConfigRemoteHost(scpRemote[2])) {
    return remote;
  }
  throw new PersonalConfigError(
    "kit_invalid_baseline",
    "Baseline remote must be a standard HTTPS, SSH, or SCP-style Git URL"
  );
}

function safeReadToml(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  const parsed = requireToml().parse(readFileSync(filePath, "utf8"));
  return isRecord(parsed) ? parsed : {};
}

function fsyncParent(directory: string): void {
  try {
    const fd = openSync(directory, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Directory fsync is unavailable on a few platforms. The file rename is
    // still atomic, and callers retain the last verified pointer on failure.
  }
}

export function atomicWriteFile(filePath: string, content: string, mode = 0o600): void {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  writeFileSync(tempPath, content, { encoding: "utf8", mode });
  const fd = openSync(tempPath, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tempPath, mode);
  renameSync(tempPath, filePath);
  chmodSync(filePath, mode);
  fsyncParent(directory);
}

function atomicWriteJson(filePath: string, value: unknown, mode = 0o600): void {
  atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export function defaultKitPathLayout(home = homedir()): KitPathLayout {
  const runtimeDir = path.join(home, ".llm-cli-gateway");
  return {
    baselineDir: path.join(home, ".agent-config"),
    runtimeDir,
    localTomlPath: path.join(runtimeDir, "local.toml"),
    statePath: path.join(runtimeDir, "personal-config-state.json"),
    releasesDir: path.join(runtimeDir, "personal-config", "releases"),
    currentPointerPath: path.join(runtimeDir, "personal-config", "current.json"),
    lockPath: path.join(runtimeDir, "personal-config", "lock"),
    artifactsDir: path.join(runtimeDir, "personal-config", "artifacts"),
  };
}

export function loadPersonalConfigSettings(
  configPath = defaultGatewayConfigPath(),
  logger: Logger = noopLogger
): LoadedPersonalConfig {
  if (!existsSync(configPath)) {
    return {
      settings: {
        enabled: false,
        baselinePath: defaultKitPathLayout().baselineDir,
        maxStaleHours: DEFAULT_PERSONAL_CONFIG_MAX_STALE_HOURS,
      },
      sources: { configFile: null },
    };
  }
  try {
    const parsed = safeReadToml(configPath);
    if (parsed.personal_config === undefined) {
      return {
        settings: {
          enabled: false,
          baselinePath: defaultKitPathLayout().baselineDir,
          maxStaleHours: DEFAULT_PERSONAL_CONFIG_MAX_STALE_HOURS,
        },
        sources: { configFile: configPath },
      };
    }
    if (!isRecord(parsed.personal_config)) {
      throw new PersonalConfigError(
        "kit_invalid_baseline",
        "[personal_config] must be a TOML table"
      );
    }
    const raw = parsed.personal_config;
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
      throw new PersonalConfigError(
        "kit_invalid_baseline",
        "[personal_config].enabled must be boolean"
      );
    }
    if (raw.baseline_path !== undefined && typeof raw.baseline_path !== "string") {
      throw new PersonalConfigError(
        "kit_invalid_baseline",
        "[personal_config].baseline_path must be a string"
      );
    }
    if (raw.max_stale_hours !== undefined && !validPositiveNumber(raw.max_stale_hours)) {
      throw new PersonalConfigError(
        "kit_invalid_baseline",
        "[personal_config].max_stale_hours must be a positive number"
      );
    }
    const enabled = raw.enabled === true;
    const configuredBaselinePath =
      typeof raw.baseline_path === "string" && raw.baseline_path.trim().length > 0
        ? raw.baseline_path.trim()
        : defaultKitPathLayout().baselineDir;
    const baselinePath = resolveSafePersonalBaselinePath(configuredBaselinePath);
    const maxStaleHours = validPositiveNumber(raw.max_stale_hours)
      ? raw.max_stale_hours
      : DEFAULT_PERSONAL_CONFIG_MAX_STALE_HOURS;
    return {
      settings: { enabled, baselinePath, maxStaleHours },
      sources: { configFile: configPath },
    };
  } catch (error) {
    logger.error("Failed to parse [personal_config]; refusing a legacy-mode downgrade", error);
    throw error instanceof PersonalConfigError
      ? error
      : new PersonalConfigError("kit_invalid_baseline", "Unable to parse [personal_config]");
  }
}

export function readLocalMachineBinding(layout: KitPathLayout): LocalMachineBinding | null {
  if (!existsSync(layout.localTomlPath)) return null;
  try {
    const parsed = safeReadToml(layout.localTomlPath);
    const machineId = parsed.machine_id;
    if (typeof machineId !== "string" || machineId.trim().length === 0) return null;
    const rawProviders = isRecord(parsed.providers) ? parsed.providers : {};
    const providers: LocalMachineBinding["providers"] = {};
    for (const [name, candidate] of Object.entries(rawProviders)) {
      if (!isRecord(candidate)) continue;
      const entry: { available?: boolean; path?: string; disabled?: boolean } = {};
      if (typeof candidate.available === "boolean") entry.available = candidate.available;
      if (typeof candidate.path === "string") entry.path = candidate.path;
      if (typeof candidate.disabled === "boolean") entry.disabled = candidate.disabled;
      providers[name] = entry;
    }
    return { machineId, providers };
  } catch {
    return null;
  }
}

export function ensureLocalMachineBinding(layout: KitPathLayout): LocalMachineBinding {
  const existing = readLocalMachineBinding(layout);
  if (existing) return existing;
  if (existsSync(layout.localTomlPath)) {
    throw new PersonalConfigError(
      "kit_invalid_baseline",
      "Local machine binding is malformed; repair local.toml instead of rotating the machine identity"
    );
  }
  const binding: LocalMachineBinding = { machineId: randomUUID(), providers: {} };
  writeLocalMachineBinding(layout, binding);
  return binding;
}

export function writeLocalMachineBinding(
  layout: KitPathLayout,
  binding: LocalMachineBinding
): void {
  if (!binding.machineId.trim()) {
    throw new PersonalConfigError(
      "kit_invalid_baseline",
      "Local machine binding requires machineId"
    );
  }
  const providers: Record<string, Record<string, string | boolean>> = {};
  for (const [name, details] of Object.entries(binding.providers)) {
    const next: Record<string, string | boolean> = {};
    if (details.available !== undefined) next.available = details.available;
    if (details.path !== undefined) next.path = details.path;
    if (details.disabled !== undefined) next.disabled = details.disabled;
    providers[name] = next;
  }
  const text = requireToml().stringify({ machine_id: binding.machineId, providers });
  atomicWriteFile(layout.localTomlPath, text, 0o600);
}

export function readPersonalConfigState(layout: KitPathLayout): PersonalConfigState {
  if (!existsSync(layout.statePath)) {
    return {
      currentReleaseId: null,
      lastSuccessAt: null,
      lastSyncError: null,
      staleAckUntil: null,
      staleAckReleaseId: null,
      staleAckUsedForReleaseId: null,
      staleAckUsedForReleaseIds: [],
      staleAckHistoryComplete: true,
    };
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(layout.statePath, "utf8"));
    if (!isRecord(parsed)) throw new Error("state is not an object");
    const stringOrNull = (value: unknown): string | null =>
      typeof value === "string" && value.length > 0 ? value : null;
    const legacyStaleAckUsedForReleaseId = stringOrNull(parsed.staleAckUsedForReleaseId);
    const storedStaleAckUsedForReleaseIds = parsed.staleAckUsedForReleaseIds;
    const hasStoredStaleAckUsedForReleaseIds = Array.isArray(storedStaleAckUsedForReleaseIds);
    const staleAckUsedForReleaseIds = Array.from(
      new Set(
        Array.isArray(storedStaleAckUsedForReleaseIds)
          ? storedStaleAckUsedForReleaseIds.filter(
              (value): value is string =>
                typeof value === "string" && RELEASE_ID_PATTERN.test(value)
            )
          : []
      )
    );
    if (
      legacyStaleAckUsedForReleaseId &&
      RELEASE_ID_PATTERN.test(legacyStaleAckUsedForReleaseId) &&
      !staleAckUsedForReleaseIds.includes(legacyStaleAckUsedForReleaseId)
    ) {
      staleAckUsedForReleaseIds.push(legacyStaleAckUsedForReleaseId);
    }
    const staleAckHistoryComplete =
      typeof parsed.staleAckHistoryComplete === "boolean"
        ? parsed.staleAckHistoryComplete && hasStoredStaleAckUsedForReleaseIds
        : hasStoredStaleAckUsedForReleaseIds || legacyStaleAckUsedForReleaseId === null;
    return {
      currentReleaseId: stringOrNull(parsed.currentReleaseId),
      lastSuccessAt: stringOrNull(parsed.lastSuccessAt),
      lastSyncError: stringOrNull(parsed.lastSyncError)
        ? PERSONAL_CONFIG_SYNC_ERROR_WITHHELD
        : null,
      staleAckUntil: stringOrNull(parsed.staleAckUntil),
      staleAckReleaseId: stringOrNull(parsed.staleAckReleaseId),
      staleAckUsedForReleaseId: legacyStaleAckUsedForReleaseId,
      staleAckUsedForReleaseIds,
      staleAckHistoryComplete,
    };
  } catch {
    return {
      currentReleaseId: null,
      lastSuccessAt: null,
      lastSyncError: PERSONAL_CONFIG_STATE_ERROR_WITHHELD,
      staleAckUntil: null,
      staleAckReleaseId: null,
      staleAckUsedForReleaseId: null,
      staleAckUsedForReleaseIds: [],
      staleAckHistoryComplete: false,
    };
  }
}

export function writePersonalConfigState(layout: KitPathLayout, state: PersonalConfigState): void {
  atomicWriteJson(layout.statePath, state, 0o600);
}

export function isKitStale(
  state: PersonalConfigState,
  maxStaleHours: number,
  now = Date.now(),
  activeReleaseId = state.currentReleaseId
): boolean {
  if (!state.lastSuccessAt) return true;
  const lastSuccessMs = Date.parse(state.lastSuccessAt);
  if (!Number.isFinite(lastSuccessMs)) return true;
  const ackMs = state.staleAckUntil ? Date.parse(state.staleAckUntil) : Number.NaN;
  if (
    activeReleaseId !== null &&
    state.staleAckReleaseId === activeReleaseId &&
    Number.isFinite(ackMs) &&
    ackMs > now
  ) {
    return false;
  }
  return now > lastSuccessMs + maxStaleHours * 60 * 60 * 1000;
}

export function acknowledgeKitStale(
  layout: KitPathLayout,
  maxStaleHours: number,
  now = Date.now()
): PersonalConfigState {
  return withKitLock(layout, () => {
    const state = readPersonalConfigState(layout);
    const activeReleaseId = getCurrentPersonalConfigRelease(layout)?.id ?? null;
    if (!activeReleaseId) {
      throw new PersonalConfigError(
        "kit_release_missing",
        "No verified release is active to acknowledge"
      );
    }
    if (!isKitStale(state, maxStaleHours, now, activeReleaseId)) return state;
    if (!state.staleAckHistoryComplete) {
      throw new PersonalConfigError(
        "kit_stale",
        "A prior stale acknowledgement has incomplete history; run config_sync successfully before executing again"
      );
    }
    if (state.staleAckUsedForReleaseIds.includes(activeReleaseId)) {
      throw new PersonalConfigError(
        "kit_stale",
        "The current release has already used its one 24-hour stale acknowledgement; run config_sync successfully before executing again"
      );
    }
    const staleAckUntil = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    const next: PersonalConfigState = {
      ...state,
      currentReleaseId: activeReleaseId,
      staleAckUntil,
      staleAckReleaseId: activeReleaseId,
      staleAckUsedForReleaseId: activeReleaseId,
      staleAckUsedForReleaseIds: [...state.staleAckUsedForReleaseIds, activeReleaseId],
      staleAckHistoryComplete: true,
    };
    writePersonalConfigState(layout, next);
    return next;
  });
}

export function assertKitFresh(layout: KitPathLayout, maxStaleHours: number): void {
  const state = readPersonalConfigState(layout);
  const activeReleaseId = getCurrentPersonalConfigRelease(layout)?.id ?? null;
  if (isKitStale(state, maxStaleHours, Date.now(), activeReleaseId)) {
    throw new PersonalConfigError(
      "kit_stale",
      "Personal Agent Config Kit baseline is stale. Run config_sync or acknowledge the current stale release for up to 24 hours."
    );
  }
}

interface KitLockOwner {
  token: string;
  pid: number;
  hostname: string;
}

function readKitLockOwner(lockPath: string): KitLockOwner | null {
  try {
    const value: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
    if (!isRecord(value)) return null;
    const token = value.token;
    const pid = value.pid;
    const ownerHostname = value.hostname;
    if (
      typeof token !== "string" ||
      typeof pid !== "number" ||
      !Number.isInteger(pid) ||
      pid <= 0 ||
      typeof ownerHostname !== "string"
    ) {
      return null;
    }
    return { token, pid, hostname: ownerHostname };
  } catch {
    return null;
  }
}

function isConfirmedDeadLocalKitLockOwner(owner: KitLockOwner): boolean {
  if (owner.hostname !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Put a fail-closed placeholder back if a lock was moved aside but cannot be
 * atomically restored. A malformed record intentionally has no reclaimable
 * owner, so a later caller cannot mistake this ambiguity for a dead process.
 */
function preserveAmbiguousKitLock(lockPath: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(lockPath, "wx", 0o600);
    writeFileSync(fd, '{"state":"ambiguous-recovery"}\n');
    fsyncSync(fd);
    fsyncParent(path.dirname(lockPath));
  } catch {
    // A concurrent owner won the name instead. Its lock remains authoritative.
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // The placeholder is already fail-closed even if close reports an error.
      }
    }
  }
}

/**
 * Restore a quarantined lock without replacing a new owner. `link` creates the
 * original name only when it is absent, unlike rename which could overwrite a
 * replacement lock. If hard links are unavailable, retain a malformed busy
 * sentinel rather than leaving the lock path open.
 */
function restoreQuarantinedKitLock(quarantinePath: string, lockPath: string): void {
  try {
    linkSync(quarantinePath, lockPath);
    try {
      unlinkSync(quarantinePath);
      fsyncParent(path.dirname(lockPath));
    } catch {
      // The restored original name remains a lock if its quarantine link stays.
    }
    return;
  } catch {
    if (!existsSync(lockPath)) preserveAmbiguousKitLock(lockPath);
  }
}

/**
 * Atomically move the current pathname to a private quarantine name before
 * inspecting its owner. A token check followed by unlink on the original path
 * has a TOCTOU gap: a replacement lock can arrive between the read and unlink.
 * Deleting only the moved quarantine entry cannot remove a replacement at the
 * authoritative lock pathname.
 */
function unlinkKitLockIfTokenMatches(lockPath: string, token: string): boolean {
  const quarantinePath = `${lockPath}.quarantine.${process.pid}.${randomUUID()}`;
  try {
    renameSync(lockPath, quarantinePath);
    fsyncParent(path.dirname(lockPath));
  } catch {
    return false;
  }

  try {
    if (readKitLockOwner(quarantinePath)?.token !== token) {
      restoreQuarantinedKitLock(quarantinePath, lockPath);
      return false;
    }
    try {
      unlinkSync(quarantinePath);
      fsyncParent(path.dirname(lockPath));
      return true;
    } finally {
      // If unlink failed, restore the known lock or leave a fail-closed sentinel.
      if (existsSync(quarantinePath)) restoreQuarantinedKitLock(quarantinePath, lockPath);
    }
  } catch {
    restoreQuarantinedKitLock(quarantinePath, lockPath);
    return false;
  }
}

/**
 * Recover only a same-host config lock whose recorded process is provably
 * absent. The companion recovery lock serializes cooperative recovery while
 * unlinkKitLockIfTokenMatches independently preserves a racing replacement.
 */
function reclaimConfirmedDeadKitLock(lockPath: string): boolean {
  const recoveryPath = `${lockPath}.recovery`;
  const acquireRecoveryLock = (): { fd: number; token: string } | null => {
    const token = randomUUID();
    try {
      return { fd: acquireKitLock(recoveryPath, token), token };
    } catch {
      return null;
    }
  };

  let recovery = acquireRecoveryLock();
  if (!recovery) {
    const staleRecoveryOwner = readKitLockOwner(recoveryPath);
    if (!staleRecoveryOwner || !isConfirmedDeadLocalKitLockOwner(staleRecoveryOwner)) return false;
    if (!unlinkKitLockIfTokenMatches(recoveryPath, staleRecoveryOwner.token)) return false;
    recovery = acquireRecoveryLock();
    if (!recovery) return false;
  }

  try {
    const owner = readKitLockOwner(lockPath);
    if (!owner || !isConfirmedDeadLocalKitLockOwner(owner)) return false;
    return unlinkKitLockIfTokenMatches(lockPath, owner.token);
  } finally {
    try {
      closeSync(recovery.fd);
    } finally {
      unlinkKitLockIfTokenMatches(recoveryPath, recovery.token);
    }
  }
}

function acquireKitLock(lockPath: string, token: string): number {
  const directory = path.dirname(lockPath);
  const temporaryPath = `${lockPath}.pending.${process.pid}.${randomUUID()}`;
  let fd: number | null = null;
  try {
    // Publish a fully written record with link(2), whose EEXIST behavior gives
    // us no-clobber lock admission. Opening lockPath directly creates an empty
    // entry before writeFileSync can fail, which permanently wedges recovery.
    fd = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(
      fd,
      JSON.stringify({
        token,
        pid: process.pid,
        hostname: hostname(),
        acquiredAt: new Date().toISOString(),
      })
    );
    fsyncSync(fd);
    linkSync(temporaryPath, lockPath);
    fsyncParent(directory);
    try {
      unlinkSync(temporaryPath);
      fsyncParent(directory);
    } catch {
      // The published lock remains valid. A unique private temporary link is
      // harmless if the filesystem refuses its best-effort cleanup.
    }
    return fd;
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the lock-acquisition failure.
      }
    }
    try {
      unlinkSync(temporaryPath);
      fsyncParent(directory);
    } catch {
      // The unpublished temporary path does not block future lock acquisition.
    }
    throw error;
  }
}

function withKitLock<T>(layout: KitPathLayout, action: () => T): T {
  mkdirSync(path.dirname(layout.lockPath), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  let fd: number;
  try {
    fd = acquireKitLock(layout.lockPath, token);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "EEXIST" &&
      reclaimConfirmedDeadKitLock(layout.lockPath)
    ) {
      try {
        fd = acquireKitLock(layout.lockPath, token);
      } catch {
        throw new PersonalConfigError(
          "kit_busy",
          "Another Personal Agent Config operation is already running or requires manual recovery"
        );
      }
    } else {
      // Do not age-break an unknown lock. A paused gateway may legitimately
      // hold it longer than a wall-clock threshold, and removing an unproven
      // holder could activate competing releases.
      throw new PersonalConfigError(
        "kit_busy",
        "Another Personal Agent Config operation is already running or requires manual recovery"
      );
    }
  }
  try {
    return action();
  } finally {
    try {
      closeSync(fd);
      unlinkKitLockIfTokenMatches(layout.lockPath, token);
    } catch {
      // The owner token prevents a late unlock from deleting another operation's lock.
    }
  }
}

interface GitResult {
  stdout: string;
  stderr: string;
  status: number | null;
  /** True only when a bounded network invocation exceeded its budget. */
  timedOut: boolean;
}

/**
 * Keep every Kit Git network operation on the two URL schemes accepted by
 * validatePersonalConfigRemote. Git applies url.*.insteadOf before selecting
 * a transport, so merely disabling the obviously unsafe schemes lets an
 * accepted HTTPS URL be rewritten to HTTP. The deny-by-default policy is
 * deliberately exported for its transport-regression test. Git accepts URL
 * rewrite and helper transports from configuration, so every Git invocation
 * that may reach the network receives this policy instead of relying on its
 * ambient configuration.
 */
export const SAFE_GIT_TRANSPORT_CONFIG = [
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  "-c",
  "protocol.ssh.allow=always",
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "protocol.file.allow=never",
  "-c",
  "protocol.git.allow=never",
];

function safeGitFailureMessage(args: readonly string[]): string {
  // Git diagnostics commonly include private remote URLs, usernames, tokens,
  // and local filesystem paths. This helper keeps those values out of typed
  // PersonalConfigError instances as a defense in depth measure.
  switch (args[0]) {
    case "init":
      return "Unable to initialize the baseline Git repository";
    case "status":
      return "Unable to inspect the baseline Git repository";
    case "branch":
      return "Unable to determine the baseline Git branch";
    case "rev-parse":
      return "Unable to read baseline Git metadata";
    case "fetch":
      return "Unable to contact the baseline Git upstream";
    case "merge":
      return "Unable to fast-forward the baseline Git branch";
    case "push":
      return "Unable to publish the baseline Git branch";
    default:
      return "Baseline Git operation failed";
  }
}

function safeGitTimeoutMessage(args: readonly string[]): string {
  // Same redaction posture as safeGitFailureMessage: a timeout must never name
  // the remote, its userinfo, or a local path.
  switch (args[0]) {
    case "clone":
      return "Timed out cloning the baseline Git repository";
    case "fetch":
      return "Timed out contacting the baseline Git upstream";
    case "push":
      return "Timed out publishing the baseline Git branch";
    default:
      return "Baseline Git network operation timed out";
  }
}

function runNetworkGit(
  argv: readonly string[],
  network: PersonalConfigNetworkOptions
): PersonalConfigNetworkGitResult {
  const timeoutMs = network.timeoutMs ?? PERSONAL_CONFIG_NETWORK_GIT_TIMEOUT_MS;
  const spawnNetworkGit = network.hooks?.spawnNetworkGit;
  if (spawnNetworkGit) {
    return spawnNetworkGit(argv, { timeoutMs, killSignal: NETWORK_GIT_KILL_SIGNAL });
  }
  return spawnSync("git", [...argv], {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: NETWORK_GIT_KILL_SIGNAL,
  });
}

/**
 * spawnSync reports an exceeded timeout as an ETIMEDOUT error. Treat a child
 * that died from exactly the configured kill signal without an exit status as
 * timed out too, so the fail-closed path cannot be skipped where the platform
 * surfaces only the kill.
 */
function networkGitTimedOut(result: PersonalConfigNetworkGitResult): boolean {
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") return true;
  return result.status === null && result.signal === NETWORK_GIT_KILL_SIGNAL;
}

/**
 * Pass `network` only for invocations that can reach the network. Local Git
 * plumbing deliberately keeps its unbounded behavior, so a slow but healthy
 * repository is never cut short by a transport budget.
 */
function git(
  cwd: string,
  args: string[],
  allowFailure = false,
  network?: PersonalConfigNetworkOptions
): GitResult {
  const argv = [...SAFE_GIT_TRANSPORT_CONFIG, "-C", cwd, ...args];
  const result: PersonalConfigNetworkGitResult = network
    ? runNetworkGit(argv, network)
    : spawnSync("git", argv, { encoding: "utf8" });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const timedOut = network !== undefined && networkGitTimedOut(result);
  if (timedOut && !allowFailure) {
    throw new PersonalConfigError("kit_invalid_baseline", safeGitTimeoutMessage(args));
  }
  if ((result.status ?? 1) !== 0 && !allowFailure) {
    throw new PersonalConfigError("kit_invalid_baseline", safeGitFailureMessage(args));
  }
  return { stdout, stderr, status: result.status, timedOut };
}

function configuredOriginUrls(directory: string, push: boolean): string[] {
  const result = git(
    directory,
    ["remote", "get-url", "--all", ...(push ? ["--push"] : []), "origin"],
    true
  );
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/u).filter(Boolean);
}

/**
 * A blank local Kit baseline may have gained its origin through ordinary Git
 * tooling. Validate the effective fetch and push URLs before any network Git
 * operation so that it cannot bypass config_init's remote policy.
 */
function assertSafeBaselineOrigin(directory: string): void {
  const fetchUrls = configuredOriginUrls(directory, false);
  const pushUrls = configuredOriginUrls(directory, true);
  if (fetchUrls.length === 0 || pushUrls.length === 0) {
    throw new PersonalConfigError(
      "kit_invalid_baseline",
      "Baseline requires an origin remote with standard HTTPS or SSH read and push URLs"
    );
  }
  for (const remote of [...fetchUrls, ...pushUrls]) validatePersonalConfigRemote(remote);
}

function isGitRepo(directory: string): boolean {
  if (!existsSync(directory)) return false;
  return git(directory, ["rev-parse", "--is-inside-work-tree"], true).status === 0;
}

function currentBranch(directory: string): string {
  const branch = git(directory, ["branch", "--show-current"]).stdout.trim();
  if (!branch)
    throw new PersonalConfigError("kit_invalid_baseline", "Baseline must be on a named Git branch");
  return branch;
}

function gitCommit(directory: string): string {
  const commit = git(directory, ["rev-parse", "HEAD"]).stdout.trim();
  if (!RELEASE_ID_PATTERN.test(commit)) {
    throw new PersonalConfigError(
      "kit_invalid_baseline",
      "Git returned an invalid baseline commit identifier"
    );
  }
  return commit;
}

function cleanGitTree(directory: string): void {
  if (git(directory, ["status", "--porcelain"]).stdout.trim()) {
    throw new PersonalConfigError(
      "kit_sync_dirty",
      "Personal Agent Config baseline has uncommitted changes"
    );
  }
}

function isReleaseId(value: string): boolean {
  return RELEASE_ID_PATTERN.test(value);
}

function releaseRootPath(layout: KitPathLayout, releaseId: string): string | null {
  if (!isReleaseId(releaseId)) return null;
  const root = path.resolve(layout.releasesDir, releaseId);
  if (!isUnder(path.resolve(layout.releasesDir), root)) return null;
  // A release that already exists is an execution input. Refuse a symlinked
  // directory even if its lexical name is contained by releasesDir, otherwise
  // a local pointer rewrite could make a verified manifest read arbitrary
  // content outside the Kit runtime root.
  if (existsSync(root)) {
    try {
      const stat = lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
      const canonicalReleases = realpathSync(layout.releasesDir);
      const canonicalRoot = realpathSync(root);
      if (!isUnder(canonicalReleases, canonicalRoot)) return null;
    } catch {
      return null;
    }
  }
  return root;
}

function releaseManifestPath(layout: KitPathLayout, releaseId: string): string | null {
  const root = releaseRootPath(layout, releaseId);
  return root ? path.join(root, "manifest.json") : null;
}

function writeCurrentReleasePointer(layout: KitPathLayout, releaseId: string): void {
  if (!isReleaseId(releaseId)) {
    throw new PersonalConfigError(
      "kit_invalid_baseline",
      "Refusing to activate an invalid release identifier"
    );
  }
  atomicWriteJson(layout.currentPointerPath, { releaseId }, 0o600);
}

export function getCurrentPersonalConfigRelease(
  layout: KitPathLayout
): PersonalConfigRelease | null {
  const state = readPersonalConfigState(layout);
  let pointerReleaseId: string | null = null;
  try {
    const pointer: unknown = JSON.parse(readFileSync(layout.currentPointerPath, "utf8"));
    if (
      isRecord(pointer) &&
      typeof pointer.releaseId === "string" &&
      isReleaseId(pointer.releaseId)
    ) {
      pointerReleaseId = pointer.releaseId;
    }
  } catch {
    // State is a compatibility fallback for a crash between release creation and
    // pointer write. A valid pointer always wins over stale state.
  }
  const releaseId =
    pointerReleaseId ??
    (state.currentReleaseId && isReleaseId(state.currentReleaseId) ? state.currentReleaseId : null);
  if (!releaseId) return null;
  const root = releaseRootPath(layout, releaseId);
  if (!root) return null;
  const manifestPath = releaseManifestPath(layout, releaseId);
  if (!manifestPath || !existsSync(root) || !existsSync(manifestPath)) return null;
  try {
    const manifestStat = lstatSync(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) return null;
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (
      !isRecord(manifest) ||
      manifest.verified !== true ||
      manifest.releaseId !== releaseId ||
      manifest.baselineCommit !== releaseId ||
      typeof manifest.treeDigest !== "string"
    ) {
      return null;
    }
    if (computeReleaseTreeDigest(root) !== manifest.treeDigest) return null;
    return {
      id: releaseId,
      root,
      manifest: {
        version: 1,
        releaseId,
        baselineCommit: String(manifest.baselineCommit),
        createdAt: String(manifest.createdAt),
        verified: true,
        treeDigest: manifest.treeDigest,
      },
    };
  } catch {
    return null;
  }
}

function listVerifiedReleaseFiles(root: string): string[] {
  const canonicalRoot = realpathSync(root);
  const files: string[] = [];
  let totalBytes = 0;
  const visit = (directory: string): void => {
    const directoryStat = lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new PersonalConfigError(
        "kit_invalid_baseline",
        "Release tree contains a non-directory path"
      );
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const relativePath = path.relative(canonicalRoot, candidate);
      if (!relativePath || !isUnder(canonicalRoot, candidate)) {
        throw new PersonalConfigError(
          "kit_invalid_baseline",
          "Release tree escapes its staging root"
        );
      }
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        throw new PersonalConfigError(
          "kit_invalid_baseline",
          `Release tree may not contain symbolic links: ${relativePath}`
        );
      }
      if (stat.isDirectory()) {
        visit(candidate);
        continue;
      }
      if (!stat.isFile()) {
        throw new PersonalConfigError(
          "kit_invalid_baseline",
          `Release tree contains a non-regular file: ${relativePath}`
        );
      }
      if (stat.size > MAX_CONFIG_SOURCE_BYTES) {
        throw new PersonalConfigError(
          "kit_invalid_baseline",
          `Release source exceeds ${MAX_CONFIG_SOURCE_BYTES} bytes: ${relativePath}`
        );
      }
      if (files.length >= MAX_RELEASE_FILE_COUNT) {
        throw new PersonalConfigError(
          "kit_invalid_baseline",
          `Release tree exceeds ${MAX_RELEASE_FILE_COUNT} regular files`
        );
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_RELEASE_TREE_BYTES) {
        throw new PersonalConfigError(
          "kit_invalid_baseline",
          `Release tree exceeds ${MAX_RELEASE_TREE_BYTES} bytes`
        );
      }
      files.push(relativePath.split(path.sep).join("/"));
    }
  };
  visit(canonicalRoot);
  return files.sort();
}

function computeReleaseTreeDigest(root: string): string {
  const hash = createHash("sha256");
  for (const relativePath of listVerifiedReleaseFiles(root)) {
    // The manifest is runtime metadata, not an input supplied by the Git tree.
    if (relativePath === "manifest.json") continue;
    const candidate = path.join(root, relativePath);
    hash.update(relativePath);
    hash.update("\0");
    hash.update(readFileSync(candidate));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function validateBaselineTree(root: string): void {
  for (const relativePath of listVerifiedReleaseFiles(root)) {
    const segments = relativePath.toLowerCase().split("/");
    const filename = segments.at(-1) ?? "";
    const hasSensitiveName = segments.some(
      segment =>
        segment === ".env" ||
        segment.startsWith(".env.") ||
        /(credential|secret|token)/.test(segment)
    );
    const hasKeyMaterialName =
      /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(filename) ||
      /\.(pem|p12|pfx|key|crt)$/i.test(filename);
    if (hasSensitiveName || hasKeyMaterialName) {
      throw new PersonalConfigError(
        "kit_invalid_baseline",
        `Baseline contains prohibited entry: ${relativePath}`
      );
    }
    if (relativePath === "manifest.json") {
      throw new PersonalConfigError(
        "kit_invalid_baseline",
        "Baseline may not supply the reserved manifest.json release metadata file"
      );
    }
  }
}

/**
 * Git preserves working-tree modes from the clone source. This baseline is
 * deliberately private local state, so normalize every existing directory and
 * regular file after initialization instead of relying on the user's umask.
 */
function hardenBaselinePermissions(root: string): void {
  assertNoSymbolicLinkPathComponent(root);
  const visit = (candidate: string): void => {
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      throw new PersonalConfigError(
        "kit_invalid_baseline",
        "Baseline may not contain symbolic links"
      );
    }
    if (stat.isDirectory()) {
      chmodSync(candidate, 0o700);
      for (const entry of readdirSync(candidate)) visit(path.join(candidate, entry));
      return;
    }
    if (stat.isFile()) {
      chmodSync(candidate, 0o600);
      return;
    }
    throw new PersonalConfigError(
      "kit_invalid_baseline",
      "Baseline contains a non-regular filesystem entry"
    );
  };
  visit(root);
}

function extractGitArchive(baselineDir: string, commit: string, stagingDir: string): void {
  const archive = spawnSync("git", ["-C", baselineDir, "archive", "--format=tar", commit], {
    encoding: "buffer",
    maxBuffer: MAX_RELEASE_ARCHIVE_BYTES,
  });
  if (archive.error || archive.status !== 0 || !archive.stdout) {
    throw new PersonalConfigError(
      "kit_invalid_baseline",
      "Unable to archive verified baseline commit"
    );
  }
  const extracted = spawnSync(
    "tar",
    ["--no-same-owner", "--no-same-permissions", "-x", "-C", stagingDir],
    {
      input: archive.stdout,
      encoding: "utf8",
    }
  );
  if (extracted.status !== 0) {
    throw new PersonalConfigError(
      "kit_invalid_baseline",
      "Unable to extract verified baseline commit"
    );
  }
}

function createRelease(
  layout: KitPathLayout,
  baselineDir: string,
  commit: string
): PersonalConfigRelease {
  if (!isReleaseId(commit)) {
    throw new PersonalConfigError("kit_invalid_baseline", "Release commit identifier is invalid");
  }
  const existing = getReleaseById(layout, commit);
  if (existing) return existing;
  mkdirSync(layout.releasesDir, { recursive: true, mode: 0o700 });
  const staging = path.join(
    layout.releasesDir,
    `.${commit}.${process.pid}.${randomUUID()}.staging`
  );
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    extractGitArchive(baselineDir, commit, staging);
    validateBaselineTree(staging);
    const treeDigest = computeReleaseTreeDigest(staging);
    const manifest: PersonalConfigReleaseManifest = {
      version: 1,
      releaseId: commit,
      baselineCommit: commit,
      createdAt: new Date().toISOString(),
      verified: true,
      treeDigest,
    };
    atomicWriteJson(path.join(staging, "manifest.json"), manifest, 0o600);
    const destination = path.join(layout.releasesDir, commit);
    renameSync(staging, destination);
    fsyncParent(layout.releasesDir);
    return { id: commit, root: destination, manifest };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function getReleaseById(layout: KitPathLayout, releaseId: string): PersonalConfigRelease | null {
  const root = releaseRootPath(layout, releaseId);
  if (!root) return null;
  const manifestPath = releaseManifestPath(layout, releaseId);
  if (!manifestPath || !existsSync(root) || !existsSync(manifestPath)) return null;
  try {
    const manifestStat = lstatSync(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) return null;
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (
      !isRecord(manifest) ||
      manifest.verified !== true ||
      manifest.releaseId !== releaseId ||
      manifest.baselineCommit !== releaseId ||
      typeof manifest.treeDigest !== "string" ||
      computeReleaseTreeDigest(root) !== manifest.treeDigest
    ) {
      return null;
    }
    return {
      id: releaseId,
      root,
      manifest: {
        version: 1,
        releaseId,
        baselineCommit: String(manifest.baselineCommit),
        createdAt: String(manifest.createdAt),
        verified: true,
        treeDigest: manifest.treeDigest,
      },
    };
  } catch {
    return null;
  }
}

export function initPersonalConfig(
  layout: KitPathLayout,
  remote?: string,
  options: PersonalConfigNetworkOptions = {}
): { baselineDir: string; initialized: boolean } {
  const validatedRemote = remote === undefined ? undefined : validatePersonalConfigRemote(remote);
  return withKitLock(layout, () => {
    if (existsSync(layout.baselineDir)) {
      if (!isGitRepo(layout.baselineDir)) {
        throw new PersonalConfigError(
          "kit_invalid_baseline",
          "Existing baseline path is not a Git repository"
        );
      }
      hardenBaselinePermissions(layout.baselineDir);
      ensureLocalMachineBinding(layout);
      return { baselineDir: layout.baselineDir, initialized: false };
    }
    mkdirSync(path.dirname(layout.baselineDir), { recursive: true, mode: 0o700 });
    if (validatedRemote) {
      const result = runNetworkGit(
        [...SAFE_GIT_TRANSPORT_CONFIG, "clone", "--", validatedRemote, layout.baselineDir],
        options
      );
      if (networkGitTimedOut(result)) {
        throw new PersonalConfigError("kit_invalid_baseline", safeGitTimeoutMessage(["clone"]));
      }
      if (result.status !== 0) {
        throw new PersonalConfigError("kit_invalid_baseline", "Unable to clone baseline");
      }
    } else {
      mkdirSync(layout.baselineDir, { recursive: true, mode: 0o700 });
      git(layout.baselineDir, ["init"]);
      atomicWriteFile(
        path.join(layout.baselineDir, "instructions.md"),
        "# Personal Agent Instructions\n\nAdd durable personal instructions here.\n",
        0o600
      );
    }
    hardenBaselinePermissions(layout.baselineDir);
    ensureLocalMachineBinding(layout);
    return { baselineDir: layout.baselineDir, initialized: true };
  });
}

export function publishPersonalConfig(
  layout: KitPathLayout,
  options: PersonalConfigNetworkOptions = {}
): void {
  withKitLock(layout, () => {
    if (!isGitRepo(layout.baselineDir)) {
      throw new PersonalConfigError(
        "kit_invalid_baseline",
        "Run config_init before config_publish"
      );
    }
    hardenBaselinePermissions(layout.baselineDir);
    cleanGitTree(layout.baselineDir);
    const branch = currentBranch(layout.baselineDir);
    const upstream = `origin/${branch}`;
    assertSafeBaselineOrigin(layout.baselineDir);
    git(layout.baselineDir, ["fetch", "origin"], false, options);
    const ancestor = git(
      layout.baselineDir,
      ["merge-base", "--is-ancestor", upstream, "HEAD"],
      true
    );
    if (ancestor.status !== 0) {
      throw new PersonalConfigError(
        "kit_sync_diverged",
        "Baseline branch is not a fast-forward publish candidate"
      );
    }
    git(layout.baselineDir, ["push", "origin", `HEAD:${branch}`], false, options);
  });
}

export function syncPersonalConfig(
  layout: KitPathLayout,
  settings: PersonalConfigSettings,
  options: SyncPersonalConfigOptions = {}
): PersonalConfigRelease {
  return withKitLock(layout, () => {
    if (!isGitRepo(layout.baselineDir)) {
      throw new PersonalConfigError("kit_invalid_baseline", "Run config_init before config_sync");
    }
    hardenBaselinePermissions(layout.baselineDir);
    cleanGitTree(layout.baselineDir);
    const branch = options.branch ?? currentBranch(layout.baselineDir);
    const upstream = `origin/${branch}`;
    assertSafeBaselineOrigin(layout.baselineDir);
    const upstreamSynchronization = git(layout.baselineDir, ["fetch", "origin"], true, options);
    if (upstreamSynchronization.timedOut || upstreamSynchronization.status !== 0) {
      const prior = readPersonalConfigState(layout);
      writePersonalConfigState(layout, {
        ...prior,
        // Git diagnostics can contain remote URLs, usernames, and local paths.
        // Keep a stable operator-safe state marker instead of persisting them.
        lastSyncError: PERSONAL_CONFIG_SYNC_ERROR_WITHHELD,
      });
      // A timed-out fetch is an unverified upstream exactly like a failed one:
      // it must not extend freshness or change the active release.
      throw new PersonalConfigError(
        "kit_stale",
        upstreamSynchronization.timedOut
          ? "Timed out verifying the baseline against its upstream; the current release remains active and its freshness was not extended"
          : "Unable to verify the baseline against its upstream; the current release remains active and its freshness was not extended"
      );
    }
    if (git(layout.baselineDir, ["rev-parse", "--verify", upstream], true).status !== 0) {
      throw new PersonalConfigError(
        "kit_sync_diverged",
        "Baseline upstream branch does not exist after synchronization"
      );
    }
    const localAncestor = git(
      layout.baselineDir,
      ["merge-base", "--is-ancestor", "HEAD", upstream],
      true
    );
    const upstreamAncestor = git(
      layout.baselineDir,
      ["merge-base", "--is-ancestor", upstream, "HEAD"],
      true
    );
    if (localAncestor.status === 0 && upstreamAncestor.status !== 0) {
      git(layout.baselineDir, ["merge", "--ff-only", upstream]);
    } else if (localAncestor.status !== 0 && upstreamAncestor.status === 0) {
      throw new PersonalConfigError(
        "kit_sync_diverged",
        "Baseline is ahead of its upstream; publish it explicitly before config_sync can activate a release"
      );
    } else if (localAncestor.status !== 0 && upstreamAncestor.status !== 0) {
      throw new PersonalConfigError(
        "kit_sync_diverged",
        "Baseline branch diverged from its upstream"
      );
    }
    const commit = gitCommit(layout.baselineDir);
    const release = createRelease(layout, layout.baselineDir, commit);
    writeCurrentReleasePointer(layout, release.id);
    writePersonalConfigState(layout, {
      currentReleaseId: release.id,
      lastSuccessAt: new Date().toISOString(),
      lastSyncError: null,
      staleAckUntil: null,
      staleAckReleaseId: null,
      staleAckUsedForReleaseId: null,
      staleAckUsedForReleaseIds: [],
      staleAckHistoryComplete: true,
    });
    return release;
  });
}

export function rollbackPersonalConfig(
  layout: KitPathLayout,
  releaseId: string
): PersonalConfigRelease {
  return withKitLock(layout, () => {
    const release = getReleaseById(layout, releaseId);
    if (!release) {
      throw new PersonalConfigError(
        "kit_release_missing",
        "Requested rollback release is not a verified retained release"
      );
    }
    writeCurrentReleasePointer(layout, release.id);
    const prior = readPersonalConfigState(layout);
    writePersonalConfigState(layout, {
      ...prior,
      currentReleaseId: release.id,
      // Rollback changes activation, not the last time an upstream baseline was
      // verified. It therefore cannot make a stale deployment look fresh.
      staleAckUntil: null,
      staleAckReleaseId: null,
    });
    return release;
  });
}

export function getPersonalConfigStatus(
  layout: KitPathLayout,
  settings: PersonalConfigSettings
): PersonalConfigStatus {
  const state = readPersonalConfigState(layout);
  const current = getCurrentPersonalConfigRelease(layout)?.id ?? null;
  return {
    enabled: settings.enabled,
    baselinePresent: isGitRepo(layout.baselineDir),
    currentReleaseId: current,
    lastSuccessAt: state.lastSuccessAt,
    stale: isKitStale(state, settings.maxStaleHours, Date.now(), current),
    staleAckUntil: state.staleAckUntil,
    lastSyncError: state.lastSyncError,
  };
}

function tryGitRoot(cwd: string): string | null {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const output = (result.stdout ?? "").trim();
  return output && existsSync(output) ? realpathSync(output) : null;
}

function tryGitHead(root: string | null): string | null {
  if (!root) return null;
  const result = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  return result.status === 0 ? (result.stdout ?? "").trim() || null : null;
}

/**
 * A workspace the caller named on this request that does not contain the
 * canonical working directory is a conflict, not a hint. Silently falling back
 * to Git-root scope here would compile a different repository's overlay,
 * release scope, and context stamp than the alias the caller selected.
 */
function selectRequestedKitWorkspace<Candidate extends { alias: string }>(
  candidates: readonly Candidate[],
  requestedAlias: string
): Candidate {
  const selected = candidates.find(candidate => candidate.alias === requestedAlias);
  if (!selected) {
    throw new PersonalConfigError(
      "kit_context_conflict",
      `Personal Agent Config Kit workspace "${requestedAlias}" does not contain the selected working directory`
    );
  }
  return selected;
}

/**
 * The configured default is a default, not an assertion the caller made about
 * this request. A caller that names an explicit working directory outside it
 * asked for that directory, so fall back to ordinary scope discovery (the
 * longest containing registered workspace, otherwise the Git top-level) rather
 * than failing a legitimate request in another checkout.
 */
function selectDefaultKitWorkspace<Candidate extends { alias: string }>(
  candidates: readonly Candidate[],
  defaultAlias: string | undefined
): Candidate | null {
  if (!defaultAlias) return candidates[0] ?? null;
  return candidates.find(candidate => candidate.alias === defaultAlias) ?? null;
}

export function resolveKitScope(input: ResolveKitScopeInput = {}): KitScope {
  const requestedCwd = input.cwd;
  if (!requestedCwd) {
    throw new PersonalConfigError(
      "kit_context_conflict",
      "Personal Agent Config Kit scope requires an explicit working directory"
    );
  }
  // Relative paths are resolved by Node against the gateway process cwd. Kit
  // scope must be independent of that launch directory, so reject before any
  // existence check, canonicalization, Git probe, or repository-overlay read.
  if (!path.isAbsolute(requestedCwd)) {
    throw new PersonalConfigError("kit_context_conflict", KIT_ABSOLUTE_WORKING_DIR_REQUIRED);
  }
  if (!existsSync(requestedCwd)) {
    throw new PersonalConfigError("kit_invalid_baseline", "Working directory does not exist");
  }
  const cwd = realpathSync(requestedCwd);
  const candidates = (input.registeredWorkspaces ?? [])
    .filter(workspace => existsSync(workspace.path))
    .map(workspace => ({ ...workspace, root: realpathSync(workspace.path) }))
    .filter(workspace => isUnder(workspace.root, cwd))
    .sort((left, right) => right.root.length - left.root.length);
  const selectedRegistered = input.requestedWorkspaceAlias
    ? selectRequestedKitWorkspace(candidates, input.requestedWorkspaceAlias)
    : selectDefaultKitWorkspace(candidates, input.defaultWorkspaceAlias);
  if (input.remote && !selectedRegistered) {
    throw new PersonalConfigError(
      "kit_invalid_baseline",
      "Remote Kit requests require a registered workspace containing the canonical working directory"
    );
  }
  const scopeRoot = selectedRegistered?.root ?? tryGitRoot(cwd);
  let overlayPath: string | null = null;
  if (scopeRoot) {
    const candidate = path.join(scopeRoot, ".agents", "gateway", "config.toml");
    if (existsSync(candidate)) {
      // Preserve the lexical, scope-rooted path. readBoundedRegularText opens
      // the final file with O_NOFOLLOW and validates its descriptor, so a
      // repository cannot redirect this read through a symlink after scope
      // selection.
      const resolved = path.resolve(candidate);
      if (!isUnder(scopeRoot, resolved)) {
        throw new PersonalConfigError(
          "kit_overlay_outside_scope",
          "Repository Kit overlay escapes the selected scope root"
        );
      }
      overlayPath = resolved;
    }
  }
  return {
    cwd,
    scopeRoot: scopeRoot ?? null,
    registeredWorkspaceAlias: selectedRegistered?.alias ?? null,
    repoHead: tryGitHead(scopeRoot ?? null),
    overlayPath,
  };
}

function openedFileDescriptorPath(fd: number): string | null {
  const descriptorRoots =
    process.platform === "linux"
      ? ["/proc/self/fd"]
      : process.platform === "darwin" || process.platform === "freebsd"
        ? ["/dev/fd"]
        : [];
  for (const descriptorRoot of descriptorRoots) {
    try {
      return realpathSync(path.join(descriptorRoot, String(fd)));
    } catch {
      // Try the next supported descriptor bridge.
    }
  }
  return null;
}

function assertOpenedFileIsWithinRoot(
  fd: number,
  canonicalRoot: string,
  label: string,
  requireDescriptorContainment: boolean
): void {
  const canonicalOpenedFile = openedFileDescriptorPath(fd);
  if (!canonicalOpenedFile) {
    if (!requireDescriptorContainment) return;
    throw new PersonalConfigError(
      "kit_invalid_baseline",
      `Unable to verify the opened ${label} within its configuration root`
    );
  }
  if (!isUnder(canonicalRoot, canonicalOpenedFile)) {
    throw new PersonalConfigError(
      "kit_invalid_baseline",
      `${label} escapes its allowed configuration root`
    );
  }
}

function readBoundedRegularText(
  root: string,
  candidate: string,
  label: string,
  requireDescriptorContainment = false
): string | null {
  const canonicalRoot = realpathSync(root);
  const resolvedCandidate = path.resolve(candidate);
  if (!isUnder(canonicalRoot, resolvedCandidate)) {
    throw new PersonalConfigError(
      "kit_invalid_baseline",
      `${label} escapes its allowed configuration root`
    );
  }
  let canonicalParent: string;
  try {
    // Resolve intermediate components before opening the leaf. O_NOFOLLOW
    // protects config.toml itself; this containment check also rejects an
    // `.agents` or `gateway` symlink that leads outside the selected scope.
    canonicalParent = realpathSync(path.dirname(resolvedCandidate));
  } catch {
    return null;
  }
  if (!isUnder(canonicalRoot, canonicalParent)) {
    throw new PersonalConfigError(
      "kit_invalid_baseline",
      `${label} escapes its allowed configuration root`
    );
  }
  const safeCandidate = path.join(canonicalParent, path.basename(resolvedCandidate));
  let fd: number;
  try {
    // O_NOFOLLOW closes the last-component lstat/read race. The opened
    // descriptor is checked below when a bridge is available. Repository
    // overlays require that proof, so a parent-directory symlink replacement
    // between realpathSync and openSync cannot redirect provider context.
    fd = openSync(safeCandidate, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") {
      throw new PersonalConfigError("kit_invalid_baseline", `${label} must not be a symbolic link`);
    }
    throw new PersonalConfigError("kit_invalid_baseline", `Unable to safely open ${label}`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new PersonalConfigError("kit_invalid_baseline", `${label} must be a regular file`);
    }
    assertOpenedFileIsWithinRoot(fd, canonicalRoot, label, requireDescriptorContainment);
    if (stat.size > MAX_CONFIG_SOURCE_BYTES) {
      throw new PersonalConfigError(
        "kit_invalid_baseline",
        `${label} exceeds ${MAX_CONFIG_SOURCE_BYTES} bytes`
      );
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function readTomlWithinRoot(
  root: string,
  candidate: string,
  label: string
): Record<string, unknown> {
  const text = readBoundedRegularText(root, candidate, label);
  if (text === null) return {};
  let parsed: unknown;
  try {
    parsed = requireToml().parse(text);
  } catch {
    throw new PersonalConfigError("kit_invalid_baseline", `${label} contains invalid TOML`);
  }
  if (!isRecord(parsed)) {
    throw new PersonalConfigError("kit_invalid_baseline", `${label} must contain a TOML table`);
  }
  return parsed;
}

function readFirstFile(root: string, names: string[]): string | null {
  for (const name of names) {
    const candidate = path.join(root, name);
    const text = readBoundedRegularText(root, candidate, name);
    if (text !== null) return text.trim();
  }
  return null;
}

function parsePreferences(candidate: unknown): KitPreferences {
  if (candidate === undefined) return {};
  if (!isRecord(candidate)) {
    throw new PersonalConfigError("kit_invalid_baseline", "preferences must be a TOML table");
  }
  if (Object.keys(candidate).some(key => !KIT_PREFERENCE_KEYS.has(key))) {
    throw new PersonalConfigError(
      "kit_invalid_baseline",
      "preferences contains an unsupported key"
    );
  }
  const preferences: KitPreferences = {};
  if (candidate.model_default !== undefined) {
    if (
      typeof candidate.model_default !== "string" ||
      candidate.model_default.length > MAX_KIT_MODEL_IDENTIFIER_LENGTH ||
      !KIT_MODEL_IDENTIFIER_PATTERN.test(candidate.model_default)
    ) {
      throw new PersonalConfigError(
        "kit_invalid_baseline",
        `model_default must be a printable model identifier no longer than ${MAX_KIT_MODEL_IDENTIFIER_LENGTH} characters`
      );
    }
    preferences.modelDefault = candidate.model_default;
  }
  if (candidate.output_format_default !== undefined) {
    if (candidate.output_format_default !== "text" && candidate.output_format_default !== "json") {
      throw new PersonalConfigError(
        "kit_invalid_baseline",
        "output_format_default must be text or json"
      );
    }
    preferences.outputFormatDefault = candidate.output_format_default;
  }
  if (candidate.max_turns_cap !== undefined) {
    if (
      !validPositiveNumber(candidate.max_turns_cap) ||
      !Number.isSafeInteger(candidate.max_turns_cap) ||
      candidate.max_turns_cap > MAX_KIT_TURNS_CAP
    ) {
      throw new PersonalConfigError(
        "kit_invalid_baseline",
        `max_turns_cap must be a safe positive integer no greater than ${MAX_KIT_TURNS_CAP}`
      );
    }
    preferences.maxTurnsCap = candidate.max_turns_cap;
  }
  if (candidate.max_budget_usd_cap !== undefined) {
    if (
      !validPositiveNumber(candidate.max_budget_usd_cap) ||
      candidate.max_budget_usd_cap > MAX_KIT_BUDGET_USD_CAP
    ) {
      throw new PersonalConfigError(
        "kit_invalid_baseline",
        `max_budget_usd_cap must be a finite positive number no greater than ${MAX_KIT_BUDGET_USD_CAP}`
      );
    }
    preferences.maxBudgetUsdCap = candidate.max_budget_usd_cap;
  }
  if (candidate.codex_sandbox_mode !== undefined) {
    if (
      candidate.codex_sandbox_mode !== "read-only" &&
      candidate.codex_sandbox_mode !== "workspace-write"
    ) {
      throw new PersonalConfigError(
        "kit_invalid_baseline",
        "codex_sandbox_mode must be read-only or workspace-write"
      );
    }
    preferences.codexSandboxMode = candidate.codex_sandbox_mode;
  }
  return preferences;
}

/**
 * `config.toml` and repository overlays are policy input, not extensible
 * application config. Reject misspelled tables and fields so a typo cannot
 * silently remove a restrictive preference and restore a permissive default.
 */
function parseLayerConfig(
  candidate: Record<string, unknown>,
  label: string
): { instructions: string | null; preferences: KitPreferences } {
  if (Object.keys(candidate).some(key => !KIT_LAYER_CONFIG_KEYS.has(key))) {
    throw new PersonalConfigError("kit_invalid_baseline", `${label} contains an unsupported key`);
  }
  if (candidate.instructions !== undefined && typeof candidate.instructions !== "string") {
    throw new PersonalConfigError("kit_invalid_baseline", `${label} instructions must be a string`);
  }
  let contextualInstructions: string | null = null;
  if (candidate.context !== undefined) {
    if (!isRecord(candidate.context)) {
      throw new PersonalConfigError(
        "kit_invalid_baseline",
        `${label} context must be a TOML table`
      );
    }
    if (Object.keys(candidate.context).some(key => !KIT_CONTEXT_KEYS.has(key))) {
      throw new PersonalConfigError(
        "kit_invalid_baseline",
        `${label} context contains an unsupported key`
      );
    }
    if (
      candidate.context.instructions !== undefined &&
      typeof candidate.context.instructions !== "string"
    ) {
      throw new PersonalConfigError(
        "kit_invalid_baseline",
        `${label} context instructions must be a string`
      );
    }
    contextualInstructions =
      typeof candidate.context.instructions === "string"
        ? candidate.context.instructions.trim()
        : null;
  }
  return {
    instructions:
      (typeof candidate.instructions === "string" ? candidate.instructions.trim() : null) ??
      contextualInstructions,
    preferences: parsePreferences(candidate.preferences),
  };
}

function parsePersonalPreferencesDocument(candidate: Record<string, unknown>): KitPreferences {
  if (Object.prototype.hasOwnProperty.call(candidate, "preferences")) {
    if (Object.keys(candidate).some(key => key !== "preferences")) {
      throw new PersonalConfigError(
        "kit_invalid_baseline",
        "preferences.toml contains an unsupported key"
      );
    }
    return parsePreferences(candidate.preferences);
  }
  return parsePreferences(candidate);
}

function mostRestrictiveCodexSandbox(
  left: KitPreferences["codexSandboxMode"],
  right: KitPreferences["codexSandboxMode"]
): KitPreferences["codexSandboxMode"] {
  if (left === "read-only" || right === "read-only") return "read-only";
  return left ?? right;
}

function mergePreferences(left: KitPreferences, right: KitPreferences): KitPreferences {
  // Repository overlays may choose a more specific default, but they must not
  // relax a personal execution ceiling. This keeps a checked-out repository
  // from escalating spend or agent-loop authority merely by adding an overlay.
  const next: KitPreferences = {
    ...left,
    ...(right.modelDefault ? { modelDefault: right.modelDefault } : {}),
    ...(right.outputFormatDefault ? { outputFormatDefault: right.outputFormatDefault } : {}),
  };
  const codexSandboxMode = mostRestrictiveCodexSandbox(
    left.codexSandboxMode,
    right.codexSandboxMode
  );
  if (codexSandboxMode) next.codexSandboxMode = codexSandboxMode;
  if (right.maxTurnsCap !== undefined) {
    next.maxTurnsCap =
      left.maxTurnsCap === undefined
        ? right.maxTurnsCap
        : Math.min(left.maxTurnsCap, right.maxTurnsCap);
  }
  if (right.maxBudgetUsdCap !== undefined) {
    next.maxBudgetUsdCap =
      left.maxBudgetUsdCap === undefined
        ? right.maxBudgetUsdCap
        : Math.min(left.maxBudgetUsdCap, right.maxBudgetUsdCap);
  }
  return next;
}

function readPersonalLayer(release: PersonalConfigRelease): {
  instructions: string | null;
  preferences: KitPreferences;
} {
  const preferencesFile = path.join(release.root, "preferences.toml");
  const preferenceConfig = readTomlWithinRoot(release.root, preferencesFile, "preferences.toml");
  const preferences = parsePersonalPreferencesDocument(preferenceConfig);
  const configPath = path.join(release.root, "config.toml");
  const config = readTomlWithinRoot(release.root, configPath, "config.toml");
  const parsedConfig = parseLayerConfig(config, "config.toml");
  const instructions =
    readFirstFile(release.root, ["instructions.md", "global.md"]) ?? parsedConfig.instructions;
  return {
    instructions,
    preferences: mergePreferences(preferences, parsedConfig.preferences),
  };
}

function readRepositoryLayer(
  overlayPath: string | null,
  scopeRoot: string | null
): {
  instructions: string | null;
  preferences: KitPreferences;
  configDigest: string | null;
} {
  if (!overlayPath || !scopeRoot)
    return { instructions: null, preferences: {}, configDigest: null };
  const text = readBoundedRegularText(scopeRoot, overlayPath, "repository Kit overlay", true);
  if (text === null) return { instructions: null, preferences: {}, configDigest: null };
  let parsed: unknown;
  try {
    parsed = requireToml().parse(text);
  } catch {
    throw new PersonalConfigError(
      "kit_invalid_baseline",
      "Repository Kit overlay contains invalid TOML"
    );
  }
  if (!isRecord(parsed)) {
    throw new PersonalConfigError(
      "kit_invalid_baseline",
      "Repository Kit overlay must contain a TOML table"
    );
  }
  const config = parseLayerConfig(parsed, "Repository Kit overlay");
  return {
    instructions: config.instructions,
    preferences: config.preferences,
    configDigest: sha256(text),
  };
}

function contextBlock(source: string, value: string): string {
  return `<kit-context source="${source}">\n${value}\n</kit-context>`;
}

export function buildKitContext(input: BuildKitContextInput): ResolvedKitContext {
  const release = getCurrentPersonalConfigRelease(input.layout);
  if (!release) {
    throw new PersonalConfigError(
      "kit_release_missing",
      "No verified Personal Agent Config release is active"
    );
  }
  const requestInstructions = input.requestInstructions?.trim() ?? "";
  if (byteLength(requestInstructions) > MAX_REQUEST_INSTRUCTIONS_BYTES) {
    throw new PersonalConfigError(
      "kit_request_instructions_too_large",
      `requestInstructions exceeds ${MAX_REQUEST_INSTRUCTIONS_BYTES} bytes`
    );
  }
  const personal = readPersonalLayer(release);
  const repository = readRepositoryLayer(input.scope.overlayPath, input.scope.scopeRoot);
  const rawBlocks: Array<{
    source: "bundled" | "personal" | "repository" | "request";
    text: string;
  }> = [];
  if (input.bundledInstructions?.trim())
    rawBlocks.push({ source: "bundled", text: input.bundledInstructions.trim() });
  if (personal.instructions) rawBlocks.push({ source: "personal", text: personal.instructions });
  if (repository.instructions)
    rawBlocks.push({ source: "repository", text: repository.instructions });
  if (requestInstructions) rawBlocks.push({ source: "request", text: requestInstructions });
  const text = rawBlocks.map(block => contextBlock(block.source, block.text)).join("\n\n");
  if (byteLength(text) > MAX_EFFECTIVE_CONTEXT_BYTES) {
    throw new PersonalConfigError(
      "kit_context_too_large",
      `Effective Kit context exceeds ${MAX_EFFECTIVE_CONTEXT_BYTES} bytes`
    );
  }
  const preferences = mergePreferences(personal.preferences, repository.preferences);
  // The execution identity covers every effective input, not only rendered
  // instructions. Preference and overlay changes must split session pins and
  // dedup even when their instruction text happens to stay identical.
  const contextDigest = sha256(
    JSON.stringify({
      instructions: text,
      preferences,
      repositoryConfigDigest: repository.configDigest,
      releaseTreeDigest: release.manifest.treeDigest,
      // The selected folder determines Codex's forced project root. It is
      // hashed, never persisted as a raw path, so sibling folders cannot share
      // a provider-native Kit continuation merely because they use one overlay.
      scopeCwd: input.scope.cwd,
    })
  );
  const provenance = rawBlocks.map(block => ({ source: block.source, digest: sha256(block.text) }));
  const configStamp = sha256(
    JSON.stringify({
      compilerVersion: PERSONAL_CONFIG_COMPILER_VERSION,
      baselineCommit: release.manifest.baselineCommit,
      releaseTreeDigest: release.manifest.treeDigest,
      sourceDigests: provenance,
      preferences,
      repositoryConfigDigest: repository.configDigest,
      scopeRoot: input.scope.scopeRoot,
      scopeCwd: input.scope.cwd,
      repoHead: input.scope.repoHead,
      machineId: input.machine.machineId,
      contextDigest,
    })
  );
  const execution: KitExecutionRef = {
    version: 1,
    releaseId: release.id,
    configStamp,
    scopeRoot: input.scope.scopeRoot,
    scopeHead: input.scope.repoHead,
    contextIdentity: contextDigest,
  };
  return {
    release,
    scope: input.scope,
    text,
    contextDigest,
    configStamp,
    execution,
    preferences,
    provenance,
  };
}

export function createClaudeContextArtifact(
  layout: KitPathLayout,
  context: ResolvedKitContext
): ClaudeContextArtifact {
  mkdirSync(layout.artifactsDir, { recursive: true, mode: 0o700 });
  reapClaudeContextArtifacts(layout, () => "unavailable");
  const artifactId = `${context.contextDigest}.${randomUUID()}`;
  const artifactPath = path.join(layout.artifactsDir, `${artifactId}.txt`);
  const ownerPath = path.join(layout.artifactsDir, `${artifactId}.owner.json`);
  atomicWriteFile(artifactPath, context.text, 0o600);
  const cleanup = (): void => {
    for (const candidate of [artifactPath, ownerPath]) {
      try {
        unlinkSync(candidate);
      } catch {
        // Artifact may already have been removed by terminal cleanup or GC.
      }
    }
  };
  return {
    path: artifactPath,
    digest: context.contextDigest,
    bindToJob: (jobId: string): void => {
      if (!/^[a-f0-9-]{16,128}$/i.test(jobId)) {
        throw new PersonalConfigError(
          "kit_invalid_baseline",
          "Invalid durable Kit artifact owner identifier"
        );
      }
      atomicWriteJson(
        ownerPath,
        {
          version: 1,
          jobId,
          artifact: path.basename(artifactPath),
          createdAt: new Date().toISOString(),
        },
        0o600
      );
    },
    cleanup,
  };
}

/**
 * Reap only artifacts whose lifecycle can be proved terminal. An unowned
 * artifact can only predate durable admission, so it is removed after a long
 * conservative grace period. A bound artifact is removed immediately only
 * after a terminal result, or after the same grace period when a healthy
 * durable store positively reports its owner job as absent. Unavailable and
 * active owner state is retained rather than risking deletion of a context
 * file still consumed by a live provider.
 */
export function reapClaudeContextArtifacts(
  layout: KitPathLayout,
  getJobState: (jobId: string) => ClaudeArtifactJobState,
  now = Date.now()
): number {
  if (!existsSync(layout.artifactsDir)) return 0;
  let removed = 0;
  for (const entry of readdirSync(layout.artifactsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".txt")) continue;
    const artifactPath = path.join(layout.artifactsDir, entry.name);
    let stat;
    try {
      stat = lstatSync(artifactPath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const ownerPath = artifactPath.replace(/\.txt$/, ".owner.json");
    const exceededGrace = now - stat.mtimeMs >= CLAUDE_ARTIFACT_REAP_AGE_MS;
    let shouldRemove = exceededGrace;
    if (existsSync(ownerPath)) {
      try {
        const owner: unknown = JSON.parse(readFileSync(ownerPath, "utf8"));
        const jobId = isRecord(owner) && typeof owner.jobId === "string" ? owner.jobId : null;
        const artifact =
          isRecord(owner) && typeof owner.artifact === "string" ? owner.artifact : null;
        if (!jobId || artifact !== entry.name) {
          shouldRemove = false;
        } else {
          const jobState = getJobState(jobId);
          shouldRemove = jobState === "terminal" || (jobState === "not_found" && exceededGrace);
        }
      } catch {
        // A malformed ownership record is ambiguous. Retain it for manual
        // recovery rather than deleting context belonging to an unknown job.
        shouldRemove = false;
      }
    }
    if (!shouldRemove) continue;
    try {
      unlinkSync(artifactPath);
      try {
        unlinkSync(ownerPath);
      } catch {
        // The primary artifact is gone. A later pass can remove the sidecar.
      }
      removed++;
    } catch {
      // Another terminal cleanup may have won the race.
    }
  }
  return removed;
}

function fieldIsPresent(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return value !== undefined && value !== null;
}

// Claude's public schema materializes `stream-json` by default. Kit handlers
// ignore outputFormat and derive it from the verified baseline, so it is not a
// conflicting caller override here.
const CLAUDE_KIT_CONFLICT_FIELDS = [
  "systemPrompt",
  "appendSystemPrompt",
  "systemPromptFile",
  "appendSystemPromptFile",
  "name",
  "settings",
  "settingSources",
  "tools",
  "agent",
  "agents",
  "forkSession",
  "noSessionPersistence",
  "allowedTools",
  "disallowedTools",
  "dangerouslySkipPermissions",
  "permissionMode",
  "approvalPolicy",
  "effort",
  "fallbackModel",
  "jsonSchema",
  "workingDir",
  "addDir",
  "excludeDynamicSystemPromptSections",
  "includeHookEvents",
  "replayUserMessages",
  "pluginDir",
  "pluginUrl",
  "mcpServers",
  "strictMcpConfig",
  "safeMode",
  "bare",
  "debug",
  "debugFile",
  "worktree",
  "continueSession",
] as const;

const CODEX_KIT_CONFLICT_FIELDS = [
  "configOverrides",
  "ignoreUserConfig",
  "ignoreRules",
  "ephemeral",
  "profile",
  "oss",
  "localProvider",
  "enable",
  "disable",
  "outputLastMessage",
  "mcpServers",
  "resumeLatest",
  "fullAuto",
  "sandboxMode",
  "askForApproval",
  "dangerouslyBypassApprovalsAndSandbox",
  "approvalPolicy",
  "outputSchema",
  "search",
  "images",
  "addDir",
  "strictConfig",
  "color",
  "dangerouslyBypassHookTrust",
  "worktree",
  "outputFormat",
] as const;

export function validateKitRequestSurface(
  provider: string,
  params: Record<string, unknown>,
  enabled: boolean
): void {
  if (!enabled) return;
  if (provider !== "claude" && provider !== "codex") {
    throw new PersonalConfigError(
      "kit_provider_unsupported",
      `Personal Agent Config Kit currently supports Claude and Codex only, not ${provider}`
    );
  }
  const fields = provider === "claude" ? CLAUDE_KIT_CONFLICT_FIELDS : CODEX_KIT_CONFLICT_FIELDS;
  const conflicts = fields.filter(field => fieldIsPresent(params[field]));
  // The normal schema default is `legacy`. A caller may not opt into the
  // gateway-managed mode here because it can select a different approval
  // posture than the personal baseline's provider defaults.
  if (params.approvalStrategy === "mcp_managed") conflicts.push("approvalStrategy" as never);
  const promptParts = params.promptParts;
  if (isRecord(promptParts)) {
    for (const field of ["system", "tools", "context", "cacheControl"]) {
      if (fieldIsPresent(promptParts[field])) conflicts.push(`promptParts.${field}` as never);
    }
  }
  if (conflicts.length > 0) {
    throw new PersonalConfigError(
      "kit_context_conflict",
      `Kit mode rejects provider instruction or configuration fields: ${conflicts.join(", ")}`
    );
  }
}

export function applyKitPreferences<T extends Record<string, unknown>>(
  params: T,
  preferences: KitPreferences
): T {
  const next: Record<string, unknown> = { ...params };
  if (next.model === undefined && preferences.modelDefault) next.model = preferences.modelDefault;
  if (next.outputFormat === undefined && preferences.outputFormatDefault) {
    next.outputFormat = preferences.outputFormatDefault;
  }
  if (typeof next.maxTurns === "number" && preferences.maxTurnsCap !== undefined) {
    next.maxTurns = Math.min(next.maxTurns, preferences.maxTurnsCap);
  } else if (next.maxTurns === undefined && preferences.maxTurnsCap !== undefined) {
    next.maxTurns = preferences.maxTurnsCap;
  }
  if (typeof next.maxBudgetUsd === "number" && preferences.maxBudgetUsdCap !== undefined) {
    next.maxBudgetUsd = Math.min(next.maxBudgetUsd, preferences.maxBudgetUsdCap);
  } else if (next.maxBudgetUsd === undefined && preferences.maxBudgetUsdCap !== undefined) {
    next.maxBudgetUsd = preferences.maxBudgetUsdCap;
  }
  return next as T;
}

/**
 * Codex Kit runs need a deliberate filesystem posture because callers cannot
 * select provider sandbox flags in Kit mode. The safe productive default is
 * workspace-write; a personal or repository layer may tighten it to read-only.
 */
export function resolveCodexKitSandboxMode(
  preferences: KitPreferences
): "read-only" | "workspace-write" {
  return preferences.codexSandboxMode ?? "workspace-write";
}

/** Resolve a validated baseline output format for Claude Kit execution. */
export function resolveClaudeKitOutputFormat(
  preferences: KitPreferences
): "text" | "json" | "stream-json" {
  return preferences.outputFormatDefault ?? "stream-json";
}

/** Resolve a validated baseline output format for Codex Kit execution. */
export function resolveCodexKitOutputFormat(preferences: KitPreferences): "text" | "json" {
  return preferences.outputFormatDefault ?? "text";
}

/**
 * Small orchestration facade used by MCP management tools and request handlers.
 * It owns no process-global state, so tests and multiple local gateway instances
 * can point at distinct layouts safely.
 */
export class PersonalConfigManager {
  readonly layout: KitPathLayout;
  readonly settings: PersonalConfigSettings;
  private readonly settingsManagedLayout: boolean;

  constructor(settings: PersonalConfigSettings, layout?: KitPathLayout) {
    this.settings = settings;
    this.settingsManagedLayout = layout === undefined;
    this.layout = layout ?? {
      ...defaultKitPathLayout(),
      baselineDir: settings.enabled
        ? resolveSafePersonalBaselinePath(settings.baselinePath)
        : settings.baselinePath,
    };
  }

  private assertSettingsManagedBaselinePath(): void {
    if (!this.settingsManagedLayout || !this.settings.enabled) return;
    if (resolveSafePersonalBaselinePath(this.settings.baselinePath) !== this.layout.baselineDir) {
      throw new PersonalConfigError(
        "kit_invalid_baseline",
        "Configured Personal Agent Config baseline path changed after startup"
      );
    }
  }

  init(remote?: string): { baselineDir: string; initialized: boolean } {
    this.assertSettingsManagedBaselinePath();
    return initPersonalConfig(this.layout, remote);
  }

  publish(): void {
    this.assertSettingsManagedBaselinePath();
    publishPersonalConfig(this.layout);
  }

  sync(options?: SyncPersonalConfigOptions): PersonalConfigRelease {
    this.assertSettingsManagedBaselinePath();
    return syncPersonalConfig(this.layout, this.settings, options);
  }

  rollback(releaseId: string): PersonalConfigRelease {
    this.assertSettingsManagedBaselinePath();
    return rollbackPersonalConfig(this.layout, releaseId);
  }

  acknowledgeStale(): PersonalConfigState {
    this.assertSettingsManagedBaselinePath();
    return acknowledgeKitStale(this.layout, this.settings.maxStaleHours);
  }

  status(): PersonalConfigStatus {
    this.assertSettingsManagedBaselinePath();
    return getPersonalConfigStatus(this.layout, this.settings);
  }

  buildContext(input: Omit<BuildKitContextInput, "layout">): ResolvedKitContext {
    this.assertSettingsManagedBaselinePath();
    return withKitLock(this.layout, () => {
      assertKitFresh(this.layout, this.settings.maxStaleHours);
      return buildKitContext({ ...input, layout: this.layout });
    });
  }

  /**
   * Read-only context compilation for diagnostics. It deliberately avoids the
   * execution lock so `explain_effective_config` neither creates a lock nor
   * waits on durable job admission. A second freshness/release check detects a
   * concurrent sync or rollback and asks the caller to retry the snapshot.
   */
  buildContextReadOnly(input: Omit<BuildKitContextInput, "layout">): ResolvedKitContext {
    this.assertSettingsManagedBaselinePath();
    assertKitFresh(this.layout, this.settings.maxStaleHours);
    const context = buildKitContext({ ...input, layout: this.layout });
    assertKitFresh(this.layout, this.settings.maxStaleHours);
    const current = getCurrentPersonalConfigRelease(this.layout);
    if (!current || current.id !== context.release.id) {
      throw new PersonalConfigError(
        "kit_busy",
        "Personal Agent Config release changed while preparing diagnostics; retry"
      );
    }
    return context;
  }

  /**
   * Recheck the activation/freshness generation immediately before a provider
   * invocation claims or starts work. A rollback/sync cannot make a request
   * run under a stale acknowledgement that belonged to a different release.
   */
  assertExecutionCurrent(execution: KitExecutionRef): void {
    this.assertSettingsManagedBaselinePath();
    withKitLock(this.layout, () => {
      assertKitFresh(this.layout, this.settings.maxStaleHours);
      const current = getCurrentPersonalConfigRelease(this.layout);
      if (!current || current.id !== execution.releaseId) {
        throw new PersonalConfigError(
          "kit_busy",
          "Personal Agent Config release changed during request preparation; retry with the current release"
        );
      }
    });
  }
}
