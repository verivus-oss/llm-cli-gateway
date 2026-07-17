import { createHash, randomUUID } from "crypto";
import {
  accessSync,
  closeSync,
  chmodSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "path";
import { parse as parseToml } from "smol-toml";
import type { ClaudeServerDef } from "./mcp-registry.js";
import { INTERNAL_MCP_REGISTRY } from "./mcp-registry.js";

// The internal MCP names + their host commands/env rules live solely in
// `mcp-registry.ts` (the single release-strip target). This module owns the
// generic config-generation orchestration; it never hardcodes a server name.
export { CLAUDE_MCP_SERVER_NAMES } from "./mcp-registry.js";

// Server names are open strings for legacy Claude configuration: the registry
// resolves gateway-known names, and unknown names may fall back to Codex config
// (or be reported `missing`). MCP-managed requests are checked at the request
// boundary and use registry definitions only.
export type ClaudeMcpServerName = string;

interface CodexServerDef {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ClaudeMcpConfigResult {
  path: string;
  enabled: ClaudeMcpServerName[];
  missing: ClaudeMcpServerName[];
  /** SHA-256 of the exact serialized config used for safe dedup identity. */
  fingerprint: string;
  /**
   * Directory scope captured while this request artifact was created. A
   * durable job must persist this exact value, never a later scope lookup.
   */
  artifactScope?: string;
  /** Remove this request-scoped config after its child process terminates. */
  cleanup?: () => void;
}

export interface ClaudeMcpConfigOptions {
  /**
   * Legacy Claude requests may use a local Codex MCP definition as a fallback
   * or override. Managed approval must leave this false so its allowlist names
   * also bind to gateway-owned commands, arguments, and environment only. In
   * that mode, only registry entries explicitly marked `managedEligible` can
   * be enabled: dynamic `npx` and ambient-PATH definitions remain legacy-only.
   */
  allowCodexConfigOverrides?: boolean;
}

const ARTIFACT_SCOPE_FILENAME = ".artifact-scope-id";
const ARTIFACT_SCOPE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEGACY_CLAUDE_MCP_ARTIFACT_BASENAME =
  /^request\.[1-9]\d*\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;
const CLAUDE_MCP_ARTIFACT_DIRECTORY_BASENAME =
  /^request\.[1-9]\d*\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLAUDE_MCP_ARTIFACT_FILENAME = "config.json";
const CLAUDE_MCP_TEMPORARY_ARTIFACT_FILENAME = ".config.tmp";
const CLAUDE_MCP_ARTIFACT_SCOPE_V2_PREFIX = "v2";

export type ClaudeMcpArtifactRemovalResult =
  "removed" | "absent" | "scope_changed" | "unsafe" | "failed";

/**
 * Read-only proof result for the explicit operator recovery path. `verified_absent`
 * is returned only after the generated path and captured scope have both been
 * proven, then the final config entry is observed missing from that same scope.
 */
export type ClaudeMcpArtifactAbsenceProofResult =
  "verified_absent" | "present" | "scope_changed" | "unsafe" | "failed";

interface ClaudeMcpArtifactPathParts {
  kind: "legacy" | "scoped";
  artifactDirectoryName?: string;
  fileName: string;
}

interface OpenClaudeMcpArtifactDirectory {
  rootFd: number;
  artifactFd: number;
  scope: string;
  close: () => void;
}

class UnsafeClaudeMcpArtifactError extends Error {}

function claudeMcpArtifactDirectory(): string {
  return join(homedir(), ".llm-cli-gateway", "claude-mcp");
}

function parseClaudeMcpArtifactPath(
  artifactPath: string,
  temporary = false
): ClaudeMcpArtifactPathParts | null {
  const artifactDir = resolve(claudeMcpArtifactDirectory());
  if (!isAbsolute(artifactPath) || resolve(artifactPath) !== artifactPath) return null;

  const fileName = basename(artifactPath);
  const parentDirectory = dirname(artifactPath);
  if (
    !temporary &&
    parentDirectory === artifactDir &&
    LEGACY_CLAUDE_MCP_ARTIFACT_BASENAME.test(fileName)
  ) {
    return { kind: "legacy", fileName };
  }

  const artifactDirectoryName = basename(parentDirectory);
  const expectedFileName = temporary
    ? CLAUDE_MCP_TEMPORARY_ARTIFACT_FILENAME
    : CLAUDE_MCP_ARTIFACT_FILENAME;
  if (
    dirname(parentDirectory) !== artifactDir ||
    !CLAUDE_MCP_ARTIFACT_DIRECTORY_BASENAME.test(artifactDirectoryName) ||
    fileName !== expectedFileName
  ) {
    return null;
  }
  return { kind: "scoped", artifactDirectoryName, fileName };
}

/**
 * True only for a final request config created by buildClaudeMcpConfig. Durable
 * rows are recovery input, never authority to delete arbitrary paths.
 */
export function isClaudeMcpArtifactPath(artifactPath: string): boolean {
  return parseClaudeMcpArtifactPath(artifactPath) !== null;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function ensurePrivateDirectory(directory: string, label: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory`);
  }
  chmodSync(directory, 0o700);
}

function readPrivateDirectoryScope(directory: string, label: string): string {
  const scopePath = join(directory, ARTIFACT_SCOPE_FILENAME);
  for (let attempt = 0; attempt < 3; attempt++) {
    const directoryStat = lstatSync(directory, { bigint: true });
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new UnsafeClaudeMcpArtifactError(`${label} must be a non-symlink directory`);
    }
    const scopeStat = lstatSync(scopePath);
    if (!scopeStat.isFile() || scopeStat.isSymbolicLink()) {
      throw new UnsafeClaudeMcpArtifactError(`${label} scope marker must be a regular file`);
    }
    const scopeId = readFileSync(scopePath, "utf8").trim();
    if (!ARTIFACT_SCOPE_ID.test(scopeId)) {
      throw new UnsafeClaudeMcpArtifactError(`${label} scope marker is invalid`);
    }
    const confirmedDirectoryStat = lstatSync(directory, { bigint: true });
    const confirmedScopeStat = lstatSync(scopePath);
    if (
      !confirmedDirectoryStat.isDirectory() ||
      confirmedDirectoryStat.isSymbolicLink() ||
      confirmedDirectoryStat.dev !== directoryStat.dev ||
      confirmedDirectoryStat.ino !== directoryStat.ino ||
      !confirmedScopeStat.isFile() ||
      confirmedScopeStat.isSymbolicLink() ||
      confirmedScopeStat.dev !== scopeStat.dev ||
      confirmedScopeStat.ino !== scopeStat.ino
    ) {
      continue;
    }
    return `${scopeId}:${directoryStat.dev}:${directoryStat.ino}`;
  }
  throw new Error(`${label} scope marker changed concurrently`);
}

function ensurePrivateDirectoryScope(directory: string, label: string): string {
  for (let attempt = 0; attempt < 3; attempt++) {
    ensurePrivateDirectory(directory, label);
    try {
      const scope = readPrivateDirectoryScope(directory, label);
      chmodSync(join(directory, ARTIFACT_SCOPE_FILENAME), 0o600);
      return scope;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }

    const scopePath = join(directory, ARTIFACT_SCOPE_FILENAME);
    let fd: number | undefined;
    try {
      fd = openSync(scopePath, "wx", 0o600);
      writeFileSync(fd, `${randomUUID()}\n`, "utf8");
      fsyncSync(fd);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw new Error(
          `Failed to create ${label} scope marker: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error }
        );
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  throw new Error(`${label} scope marker changed concurrently`);
}

function composeScopedArtifactScope(
  rootScope: string,
  artifactDirectoryName: string,
  artifactDirectoryScope: string
): string {
  return `${CLAUDE_MCP_ARTIFACT_SCOPE_V2_PREFIX}:${rootScope}:${artifactDirectoryName}:${artifactDirectoryScope}`;
}

/**
 * Return a durable identity for this installation's Claude request-artifact
 * directory. The random marker separates independent installations that share
 * a hostname, while the directory device/inode binding detects copied homes or
 * isolated filesystem namespaces that happen to preserve the marker.
 *
 * The marker is intentionally not a credential. It is only a cleanup-scope
 * fence, and is created with the same private permissions as request configs.
 */
export function getClaudeMcpArtifactScope(): string {
  const configDir = claudeMcpArtifactDirectory();
  return ensurePrivateDirectoryScope(configDir, "Claude MCP artifact directory");
}

/**
 * Return the exact durable cleanup scope for one generated request path. New
 * artifacts include a private per-request directory identity in addition to
 * the installation scope. Legacy flat artifacts retain their existing root
 * scope so old durable rows remain safely reclaimable.
 */
export function getClaudeMcpArtifactScopeForPath(artifactPath: string): string {
  const parts = parseClaudeMcpArtifactPath(artifactPath);
  if (!parts) {
    throw new Error("Claude MCP artifact path is not gateway-generated");
  }
  const rootScope = getClaudeMcpArtifactScope();
  if (parts.kind === "legacy") return rootScope;
  const artifactDirectoryScope = readPrivateDirectoryScope(
    dirname(artifactPath),
    "Claude MCP request artifact directory"
  );
  return composeScopedArtifactScope(
    rootScope,
    parts.artifactDirectoryName!,
    artifactDirectoryScope
  );
}

function createClaudeMcpArtifactDirectory(): {
  directory: string;
  scope: string;
} {
  const rootDirectory = claudeMcpArtifactDirectory();
  const rootScope = getClaudeMcpArtifactScope();
  for (let attempt = 0; attempt < 3; attempt++) {
    const artifactDirectoryName = `request.${process.pid}.${randomUUID()}`;
    const directory = join(rootDirectory, artifactDirectoryName);
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) === "EEXIST") continue;
      throw error;
    }
    const artifactDirectoryScope = ensurePrivateDirectoryScope(
      directory,
      "Claude MCP request artifact directory"
    );
    return {
      directory,
      scope: composeScopedArtifactScope(rootScope, artifactDirectoryName, artifactDirectoryScope),
    };
  }
  throw new Error("Failed to create a unique Claude MCP request artifact directory");
}

function supportsDescriptorAnchoredCleanup(): boolean {
  if (process.platform !== "linux") return false;
  try {
    return lstatSync("/proc/self/fd").isDirectory();
  } catch {
    return false;
  }
}

function descriptorPath(fd: number): string {
  const path = `/proc/self/fd/${fd}`;
  accessSync(path, constants.F_OK);
  return path;
}

function openDescriptorDirectory(directory: string): number {
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const fd = openSync(directory, flags);
  try {
    if (!fstatSync(fd).isDirectory()) {
      throw new UnsafeClaudeMcpArtifactError("Claude MCP artifact component is not a directory");
    }
    descriptorPath(fd);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function readDescriptorDirectoryScope(fd: number, label: string): string {
  if (!fstatSync(fd, { bigint: true }).isDirectory()) {
    throw new UnsafeClaudeMcpArtifactError(`${label} is not a directory`);
  }
  const markerPath = join(descriptorPath(fd), ARTIFACT_SCOPE_FILENAME);
  let markerFd: number | undefined;
  try {
    markerFd = openSync(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(markerFd).isFile()) {
      throw new UnsafeClaudeMcpArtifactError(`${label} scope marker is not a regular file`);
    }
    const scopeId = readFileSync(markerFd, "utf8").trim();
    if (!ARTIFACT_SCOPE_ID.test(scopeId)) {
      throw new UnsafeClaudeMcpArtifactError(`${label} scope marker is invalid`);
    }
    const stat = fstatSync(fd, { bigint: true });
    return `${scopeId}:${stat.dev}:${stat.ino}`;
  } finally {
    if (markerFd !== undefined) closeSync(markerFd);
  }
}

function openClaudeMcpArtifactDirectory(
  parts: ClaudeMcpArtifactPathParts
): OpenClaudeMcpArtifactDirectory {
  const fds: number[] = [];
  try {
    const homeFd = openDescriptorDirectory(realpathSync(homedir()));
    fds.push(homeFd);
    const gatewayFd = openDescriptorDirectory(join(descriptorPath(homeFd), ".llm-cli-gateway"));
    fds.push(gatewayFd);
    const rootFd = openDescriptorDirectory(join(descriptorPath(gatewayFd), "claude-mcp"));
    fds.push(rootFd);
    const rootScope = readDescriptorDirectoryScope(rootFd, "Claude MCP artifact directory");

    if (parts.kind === "legacy") {
      return {
        rootFd,
        artifactFd: rootFd,
        scope: rootScope,
        close: () => {
          for (const fd of [...fds].reverse()) closeSync(fd);
        },
      };
    }

    const artifactFd = openDescriptorDirectory(
      join(descriptorPath(rootFd), parts.artifactDirectoryName!)
    );
    fds.push(artifactFd);
    const artifactScope = readDescriptorDirectoryScope(
      artifactFd,
      "Claude MCP request artifact directory"
    );
    return {
      rootFd,
      artifactFd,
      scope: composeScopedArtifactScope(rootScope, parts.artifactDirectoryName!, artifactScope),
      close: () => {
        for (const fd of [...fds].reverse()) closeSync(fd);
      },
    };
  } catch (error) {
    for (const fd of [...fds].reverse()) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original descriptor/open error.
      }
    }
    throw error;
  }
}

function assertReadOnlyNonSymlinkDirectory(directory: string, label: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new UnsafeClaudeMcpArtifactError(`${label} must be a non-symlink directory`);
  }
}

/**
 * Read a captured scope without creating, chmodding, or otherwise repairing
 * any filesystem entry. This is the pathname fallback used where Node cannot
 * expose a descriptor-pinned unlink bridge. It deliberately relies on the
 * documented dedicated-UID, non-hostile-same-UID boundary.
 */
function readPathnameArtifactScope(
  artifactPath: string,
  parts: ClaudeMcpArtifactPathParts
): string {
  const realHome = realpathSync(homedir());
  assertReadOnlyNonSymlinkDirectory(realHome, "Claude MCP home directory");
  const gatewayDirectory = join(realHome, ".llm-cli-gateway");
  assertReadOnlyNonSymlinkDirectory(gatewayDirectory, "Claude MCP gateway directory");

  const rootDirectory = claudeMcpArtifactDirectory();
  const expectedRootDirectory = join(realHome, ".llm-cli-gateway", "claude-mcp");
  if (realpathSync(rootDirectory) !== expectedRootDirectory) {
    throw new UnsafeClaudeMcpArtifactError(
      "Claude MCP artifact directory escaped the gateway home"
    );
  }
  assertReadOnlyNonSymlinkDirectory(rootDirectory, "Claude MCP artifact directory");
  const rootScope = readPrivateDirectoryScope(rootDirectory, "Claude MCP artifact directory");
  if (parts.kind === "legacy") return rootScope;

  const artifactDirectory = dirname(artifactPath);
  const expectedArtifactDirectory = join(expectedRootDirectory, parts.artifactDirectoryName!);
  if (realpathSync(artifactDirectory) !== expectedArtifactDirectory) {
    throw new UnsafeClaudeMcpArtifactError(
      "Claude MCP request artifact directory escaped the gateway artifact root"
    );
  }
  assertReadOnlyNonSymlinkDirectory(artifactDirectory, "Claude MCP request artifact directory");
  const artifactScope = readPrivateDirectoryScope(
    artifactDirectory,
    "Claude MCP request artifact directory"
  );
  return composeScopedArtifactScope(rootScope, parts.artifactDirectoryName!, artifactScope);
}

function removePathnameClaudeMcpArtifact(
  artifactPath: string,
  expectedScope: string,
  parts: ClaudeMcpArtifactPathParts
): ClaudeMcpArtifactRemovalResult {
  try {
    let observedScope: string;
    try {
      observedScope = readPathnameArtifactScope(artifactPath, parts);
    } catch (error) {
      if (error instanceof UnsafeClaudeMcpArtifactError) return "unsafe";
      // Only a missing final config is an `absent` result. A missing scope
      // marker or directory cannot authorize cleanup and stays retention-pinned.
      if (errorCode(error) === "ENOENT") return "unsafe";
      throw error;
    }
    if (observedScope !== expectedScope) {
      return "scope_changed";
    }
    let stat;
    try {
      stat = lstatSync(artifactPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return "absent";
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) return "unsafe";

    unlinkSync(artifactPath);
    try {
      if (readPathnameArtifactScope(artifactPath, parts) !== expectedScope) {
        return "scope_changed";
      }
    } catch {
      // The exact artifact was removed, but a post-unlink scope change must
      // remain unacknowledged rather than being treated as a successful retry.
      return "scope_changed";
    }
    return "removed";
  } catch (error) {
    if (error instanceof UnsafeClaudeMcpArtifactError) return "unsafe";
    if (errorCode(error) === "ELOOP" || errorCode(error) === "ENOTDIR") return "unsafe";
    if (errorCode(error) === "ENOENT") return "absent";
    return "failed";
  }
}

/**
 * Prove that one exact, gateway-generated final artifact is absent without
 * creating, repairing, or deleting any filesystem entry. This is deliberately
 * separate from ordinary cleanup: automatic reconciliation retains an absent
 * artifact pin, while an explicit local operator recovery may use this proof
 * before its durable compare-and-set acknowledgement.
 */
export function proveClaudeMcpArtifactAbsent(
  artifactPath: string,
  expectedScope?: string
): ClaudeMcpArtifactAbsenceProofResult {
  const parts = parseClaudeMcpArtifactPath(artifactPath);
  if (!parts || !expectedScope) return "unsafe";

  if (!supportsDescriptorAnchoredCleanup()) {
    try {
      const observedScope = readPathnameArtifactScope(artifactPath, parts);
      if (observedScope !== expectedScope) return "scope_changed";
      try {
        const stat = lstatSync(artifactPath);
        return stat.isFile() && !stat.isSymbolicLink() ? "present" : "unsafe";
      } catch (error) {
        if (errorCode(error) === "ENOENT") return "verified_absent";
        throw error;
      }
    } catch (error) {
      if (error instanceof UnsafeClaudeMcpArtifactError) return "unsafe";
      if (errorCode(error) === "ELOOP" || errorCode(error) === "ENOTDIR") return "unsafe";
      // A missing scope marker or directory is not proof that a final config
      // was safely removed. It must stay pinned rather than becoming an ENOENT
      // acknowledgement.
      if (errorCode(error) === "ENOENT") return "unsafe";
      return "failed";
    }
  }

  let artifact: OpenClaudeMcpArtifactDirectory | undefined;
  try {
    artifact = openClaudeMcpArtifactDirectory(parts);
    if (artifact.scope !== expectedScope) return "scope_changed";
    try {
      const stat = lstatSync(join(descriptorPath(artifact.artifactFd), parts.fileName));
      return stat.isFile() && !stat.isSymbolicLink() ? "present" : "unsafe";
    } catch (error) {
      if (errorCode(error) === "ENOENT") return "verified_absent";
      throw error;
    }
  } catch (error) {
    if (error instanceof UnsafeClaudeMcpArtifactError) return "unsafe";
    if (errorCode(error) === "ELOOP" || errorCode(error) === "ENOTDIR") return "unsafe";
    // Unlike removeClaudeMcpArtifact, an operator acknowledgement cannot treat
    // an open failure as absence. It has not proven the captured namespace.
    if (errorCode(error) === "ENOENT") return "unsafe";
    return "failed";
  } finally {
    artifact?.close();
  }
}

/**
 * Remove a generated request artifact without following directory or final
 * component symlinks. The same guard is used by the config closure and durable
 * job cleanup so a generic callback cannot weaken the manager's provenance
 * checks. An absent path is deliberately not acknowledgement-worthy.
 */
function removeClaudeMcpArtifactMatching(
  artifactPath: string,
  expectedScope: string | undefined,
  temporary = false
): ClaudeMcpArtifactRemovalResult {
  const parts = parseClaudeMcpArtifactPath(artifactPath, temporary);
  if (!parts || !expectedScope) return "unsafe";
  if (!supportsDescriptorAnchoredCleanup()) {
    return removePathnameClaudeMcpArtifact(artifactPath, expectedScope, parts);
  }
  let artifact: OpenClaudeMcpArtifactDirectory | undefined;
  try {
    artifact = openClaudeMcpArtifactDirectory(parts);
    if (artifact.scope !== expectedScope) {
      return "scope_changed";
    }

    let stat;
    try {
      stat = lstatSync(join(descriptorPath(artifact.artifactFd), parts.fileName));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return "absent";
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) return "unsafe";

    // This pathname is rooted at an already-opened, O_NOFOLLOW directory
    // descriptor. If another process replaces the visible Claude MCP root in
    // the validation-to-unlink window, Linux resolves this through the original
    // directory object instead of the replacement pathname.
    unlinkSync(join(descriptorPath(artifact.artifactFd), parts.fileName));
    return "removed";
  } catch (error) {
    if (error instanceof UnsafeClaudeMcpArtifactError) return "unsafe";
    if (errorCode(error) === "ELOOP" || errorCode(error) === "ENOTDIR") return "unsafe";
    if (errorCode(error) === "ENOENT") return "absent";
    return "failed";
  } finally {
    artifact?.close();
  }
}

/**
 * Safely remove a final request config. Callers must pass the captured scope;
 * cleanup proves it immediately before unlinking the regular file. Linux uses
 * an already-opened directory object for that unlink, so a later pathname
 * replacement cannot retarget the deletion.
 */
export function removeClaudeMcpArtifact(
  artifactPath: string,
  expectedScope?: string
): ClaudeMcpArtifactRemovalResult {
  return removeClaudeMcpArtifactMatching(artifactPath, expectedScope);
}

function removeClaudeMcpTemporaryArtifact(
  artifactPath: string,
  expectedScope: string
): ClaudeMcpArtifactRemovalResult {
  return removeClaudeMcpArtifactMatching(artifactPath, expectedScope, true);
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length === value.length ? strings : undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      record[key] = String(entry);
    }
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

function readCodexServerConfig(server: ClaudeMcpServerName): CodexServerDef {
  const codexConfigPath = join(homedir(), ".codex", "config.toml");
  if (!existsSync(codexConfigPath)) {
    return {};
  }

  try {
    const content = readFileSync(codexConfigPath, "utf-8");
    const parsed = parseToml(content) as Record<string, unknown>;
    const mcpServers = parsed.mcp_servers;
    if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
      return {};
    }

    const serverConfig = (mcpServers as Record<string, unknown>)[server];
    if (!serverConfig || typeof serverConfig !== "object" || Array.isArray(serverConfig)) {
      return {};
    }

    const obj = serverConfig as Record<string, unknown>;
    const command = typeof obj.command === "string" ? obj.command : undefined;
    const args = asStringArray(obj.args);
    const env = asStringRecord(obj.env);

    return {
      command,
      args,
      env,
    };
  } catch {
    return {};
  }
}

// Generic PATH probe (no server names): true when `command` is an executable
// absolute/relative path, or resolves on PATH for a bare command name.
function commandExists(command: string): boolean {
  if (command.includes("/") || command.includes("\\")) {
    try {
      accessSync(command, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  const pathEnv = process.env.PATH || "";
  const extensions =
    process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";") : [""];

  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      try {
        accessSync(join(dir, `${command}${ext}`), constants.X_OK);
        return true;
      } catch {
        // Continue checking PATH candidates.
      }
    }
  }
  return false;
}

// Generic resolver: merge Codex-config overrides over the registry default,
// forward/require the registry's env vars, gate PATH-only servers on the binary
// being installed, and report `missing` (null) when a required credential or
// command is absent or an unknown name has no Codex fallback. All server-specific
// knowledge comes from `INTERNAL_MCP_REGISTRY`; this function hardcodes no name.
function toClaudeServerDef(
  server: ClaudeMcpServerName,
  allowCodexConfigOverrides: boolean
): ClaudeServerDef | null {
  const entry = INTERNAL_MCP_REGISTRY[server];
  if (!allowCodexConfigOverrides && !entry?.managedEligible) {
    // mcp_managed must never turn a registry name into a network install,
    // ambient PATH lookup, or user-owned Codex override. Entries opt in only
    // when their gateway-owned default is suitable for that strict boundary.
    return null;
  }
  const codexDef = allowCodexConfigOverrides ? readCodexServerConfig(server) : {};
  const fallback: Partial<ClaudeServerDef> = entry ? entry.defaultDef() : {};

  const command = codexDef.command || fallback.command;
  if (!command) {
    // Unknown server with no Codex config and no registry fallback → missing.
    return null;
  }
  const args = codexDef.args || fallback.args || [];

  const env: Record<string, string> = {};
  if (codexDef.env) {
    Object.assign(env, codexDef.env);
  }

  if (entry) {
    for (const key of entry.forwardEnv ?? []) {
      const value = process.env[key];
      if (value) {
        env[key] = value;
      }
    }
    // Required credentials may come from Codex config env or process.env;
    // absence marks the server `missing` rather than enabling it credential-less.
    for (const key of entry.requireEnv ?? []) {
      if (!env[key]) {
        return null;
      }
    }
    // PATH-gated server with no Codex-supplied command: require the binary on
    // PATH (the registry default has no npx fallback), else report `missing`.
    if (entry.requireCommandOnPath && !codexDef.command && !commandExists(command)) {
      return null;
    }
  }

  return {
    command,
    args,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

export function buildClaudeMcpConfig(
  servers: ClaudeMcpServerName[],
  { allowCodexConfigOverrides = true }: ClaudeMcpConfigOptions = {}
): ClaudeMcpConfigResult {
  const uniqueServers = [...new Set(servers)];
  const enabled: ClaudeMcpServerName[] = [];
  const missing: ClaudeMcpServerName[] = [];
  const mcpServers: Record<string, ClaudeServerDef> = {};

  for (const server of uniqueServers) {
    const def = toClaudeServerDef(server, allowCodexConfigOverrides);
    if (!def) {
      missing.push(server);
      continue;
    }
    mcpServers[server] = def;
    enabled.push(server);
  }

  // Claude reads this config asynchronously after launch. Every request gets
  // a private directory as well as a unique file, so independent jobs cannot
  // share a cleanup authority or replace each other's approved allowlist.
  const artifact = createClaudeMcpArtifactDirectory();
  const configPath = join(artifact.directory, CLAUDE_MCP_ARTIFACT_FILENAME);
  const tempPath = join(artifact.directory, CLAUDE_MCP_TEMPORARY_ARTIFACT_FILENAME);
  // Capture this before creating the request file. The manager receives this
  // value with the path and rejects durable admission if the installation or
  // this request directory changes before the job row can be written.
  const artifactScope = artifact.scope;
  const serializedConfig = JSON.stringify({ mcpServers }, null, 2);
  const fingerprint = createHash("sha256").update(serializedConfig).digest("hex");
  let configWritten = false;
  try {
    writeFileSync(tempPath, serializedConfig, {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
    const fd = openSync(tempPath, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tempPath, configPath);
    configWritten = true;
    chmodSync(configPath, 0o600);
    if (getClaudeMcpArtifactScopeForPath(configPath) !== artifactScope) {
      throw new Error("Claude MCP request artifact directory changed while writing request config");
    }
  } catch (error) {
    try {
      if (configWritten) {
        removeClaudeMcpArtifact(configPath, artifactScope);
      } else {
        removeClaudeMcpTemporaryArtifact(tempPath, artifactScope);
      }
    } catch {
      // The write failure below is the actionable error. Do not obscure it
      // with best-effort cleanup of a partially-created artifact.
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to write Claude MCP config: ${message}`, { cause: error });
  }

  let cleaned = false;
  return {
    path: configPath,
    enabled,
    missing,
    fingerprint,
    artifactScope,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      removeClaudeMcpArtifact(configPath, artifactScope);
    },
  };
}
