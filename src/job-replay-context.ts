import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  type Dirent,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { JobCwdRecord } from "./job-cwd-scope.js";

export type InstructionDigestStatus = "captured" | "too_large" | "unreadable";

export interface JobInstructionDigest {
  /** Absolute logical path the provider discovers. Symlink targets stay private. */
  path: string;
  /** Digest of the effective bytes, or null when the file could not be read safely. */
  sha256: string | null;
  /** Bytes present in the source file when stat succeeded. */
  sourceBytes: number | null;
  /** Bytes the provider could consume from this file under the measured cap. */
  effectiveBytes: number;
  /** Provider cap applied to this file, or null when no provider cap is known. */
  effectiveLimitBytes: number | null;
  truncated: boolean;
  status: InstructionDigestStatus;
}

export interface JobReplayContext {
  version: 1;
  instructionFiles: JobInstructionDigest[];
  /** Commit checked out under cwd at admission, or null outside a Git work tree. */
  repositoryHead: string | null;
}

const HASH_READ_CEILING_BYTES = 1024 * 1024;
const CODEX_PROJECT_DOC_MAX_BYTES = 32 * 1024;
const MAX_ANCESTORS = 64;
const MAX_RULE_FILES = 256;
const MAX_RULE_DIRECTORIES = 512;
const MAX_RULE_ENTRIES = 4096;
const MAX_REPLAY_PATH_CHARS = 32 * 1024;
const MAX_REPLAY_CONTEXT_CHARS = 10 * 1024 * 1024;

interface InstructionSource {
  path: string;
  effectiveLimitBytes: number | null;
}

function existingRegularFile(candidate: string): boolean {
  try {
    // stat follows an instruction-file symlink, which matches what the provider reads.
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function instructionRuleFiles(directory: string): string[] {
  const files: string[] = [];
  const pending = [directory];
  let directories = 0;
  let entriesSeen = 0;
  while (
    pending.length > 0 &&
    files.length < MAX_RULE_FILES &&
    directories < MAX_RULE_DIRECTORIES &&
    entriesSeen < MAX_RULE_ENTRIES
  ) {
    const current = pending.shift()!;
    directories += 1;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      entriesSeen += 1;
      if (files.length >= MAX_RULE_FILES || entriesSeen > MAX_RULE_ENTRIES) break;
      const candidate = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && pending.length + directories < MAX_RULE_DIRECTORIES) {
        pending.push(candidate);
      } else if (entry.isFile()) files.push(candidate);
    }
  }
  return files;
}

function ancestorsFromRoot(cwd: string): string[] {
  const reversed: string[] = [];
  let current = resolve(cwd);
  const root = parse(current).root;
  for (let count = 0; count < MAX_ANCESTORS; count += 1) {
    reversed.push(current);
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return reversed.reverse();
}

function repositoryRoot(cwd: string): string | null {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    timeout: 1000,
    windowsHide: true,
  });
  const root = result.status === 0 ? result.stdout.trim() : "";
  return root && isAbsolute(root) ? resolve(root) : null;
}

function repositoryHead(cwd: string): string | null {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 1000,
    windowsHide: true,
  });
  const head = result.status === 0 ? result.stdout.trim() : "";
  return /^[0-9a-f]{40,64}$/i.test(head) ? head.toLowerCase() : null;
}

function addFile(
  sources: InstructionSource[],
  seen: Set<string>,
  candidate: string,
  effectiveLimitBytes: number | null
): void {
  const absolute = resolve(candidate);
  if (seen.has(absolute) || !existingRegularFile(absolute)) return;
  seen.add(absolute);
  sources.push({ path: absolute, effectiveLimitBytes });
}

function addRules(
  sources: InstructionSource[],
  seen: Set<string>,
  candidate: string,
  effectiveLimitBytes: number | null
): void {
  if (!existsSync(candidate)) return;
  try {
    // Rule directories themselves may not be symlinks. Individual file
    // symlinks are also skipped by instructionRuleFiles.
    const info = lstatSync(candidate);
    if (!info.isDirectory() || info.isSymbolicLink()) return;
  } catch {
    return;
  }
  for (const file of instructionRuleFiles(candidate)) {
    addFile(sources, seen, file, effectiveLimitBytes);
  }
}

function discoverInstructionSources(
  provider: string,
  cwd: string | undefined,
  home: string
): InstructionSource[] {
  const sources: InstructionSource[] = [];
  const seen = new Set<string>();
  const globalByProvider: Record<string, string[]> = {
    claude: [join(home, ".claude", "CLAUDE.md")],
    codex: [join(home, ".codex", "AGENTS.md")],
    gemini: [join(home, ".gemini", "GEMINI.md")],
    grok: [join(home, ".grok", "AGENTS.md")],
    mistral: [join(home, ".vibe", "AGENTS.md")],
    devin: [join(home, ".devin", "AGENTS.md")],
    cursor: [join(home, ".cursor", "AGENTS.md")],
  };
  const providerLimit = provider === "codex" ? CODEX_PROJECT_DOC_MAX_BYTES : null;
  for (const file of globalByProvider[provider] ?? []) addFile(sources, seen, file, providerLimit);
  if (!cwd) return sources;

  const root = repositoryRoot(cwd);
  const allAncestors = ancestorsFromRoot(cwd);
  const ancestors = root
    ? allAncestors.filter(candidate => {
        const fromRoot = relative(root, candidate);
        return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
      })
    : allAncestors;

  if (provider === "claude") {
    for (const directory of ancestors) {
      addFile(sources, seen, join(directory, "CLAUDE.md"), null);
      addFile(sources, seen, join(directory, "CLAUDE.local.md"), null);
      addFile(sources, seen, join(directory, ".claude", "CLAUDE.md"), null);
      addRules(sources, seen, join(directory, ".claude", "rules"), null);
    }
  } else if (provider === "codex") {
    for (const directory of ancestors) {
      const override = join(directory, "AGENTS.override.md");
      if (existingRegularFile(override)) addFile(sources, seen, override, providerLimit);
      else addFile(sources, seen, join(directory, "AGENTS.md"), providerLimit);
    }
  } else if (provider === "gemini") {
    for (const directory of ancestors) addFile(sources, seen, join(directory, "GEMINI.md"), null);
  } else if (provider === "grok") {
    if (root) addFile(sources, seen, join(root, "GROK.md"), null);
  } else if (provider === "mistral" || provider === "devin") {
    for (const directory of ancestors) {
      addFile(sources, seen, join(directory, "AGENTS.md"), null);
      addFile(sources, seen, join(directory, ".agents", "AGENTS.md"), null);
    }
  } else if (provider === "cursor") {
    for (const directory of ancestors) {
      addFile(sources, seen, join(directory, ".cursorrules"), null);
      addFile(sources, seen, join(directory, "AGENTS.md"), null);
      addRules(sources, seen, join(directory, ".cursor", "rules"), null);
    }
  }
  return sources;
}

function digestSource(
  source: InstructionSource,
  remainingProviderBytes: number | null
): JobInstructionDigest {
  let fd: number | null = null;
  try {
    fd = openSync(source.path, "r");
    const info = fstatSync(fd);
    const sourceBytes = info.size;
    const effectiveLimit =
      remainingProviderBytes === null
        ? source.effectiveLimitBytes
        : source.effectiveLimitBytes === null
          ? remainingProviderBytes
          : Math.min(source.effectiveLimitBytes, remainingProviderBytes);
    const effectiveBytes = Math.min(sourceBytes, effectiveLimit ?? sourceBytes);
    if (!info.isFile() || effectiveBytes > HASH_READ_CEILING_BYTES) {
      return {
        path: source.path,
        sha256: null,
        sourceBytes,
        effectiveBytes,
        effectiveLimitBytes: source.effectiveLimitBytes,
        truncated: effectiveBytes < sourceBytes,
        status: "too_large",
      };
    }
    const bytes = Buffer.alloc(effectiveBytes);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    const stableBytes = offset === bytes.length ? bytes : bytes.subarray(0, offset);
    return {
      path: source.path,
      sha256: createHash("sha256").update(stableBytes).digest("hex"),
      sourceBytes,
      effectiveBytes: stableBytes.length,
      effectiveLimitBytes: source.effectiveLimitBytes,
      truncated: stableBytes.length < sourceBytes,
      status: "captured",
    };
  } catch {
    return {
      path: source.path,
      sha256: null,
      sourceBytes: null,
      effectiveBytes: 0,
      effectiveLimitBytes: source.effectiveLimitBytes,
      truncated: false,
      status: "unreadable",
    };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Capture bounded replay evidence at admission. The record contains no
 * instruction bodies. Kit jobs return null because their private paths and
 * compiled context follow the same durable-withholding rule as Kit argv.
 */
export function captureJobReplayContext(
  provider: string,
  cwd: JobCwdRecord,
  kitExecutionPresent: boolean,
  options: { home?: string } = {}
): JobReplayContext | null {
  if (kitExecutionPresent) return null;
  const effectiveCwd = cwd.scope === "neutral" ? undefined : (cwd.path ?? undefined);
  const sources = discoverInstructionSources(provider, effectiveCwd, options.home ?? homedir());
  let remainingProviderBytes = provider === "codex" ? CODEX_PROJECT_DOC_MAX_BYTES : null;
  const instructionFiles = sources.map(source => {
    const digest = digestSource(source, remainingProviderBytes);
    if (remainingProviderBytes !== null) {
      remainingProviderBytes = Math.max(0, remainingProviderBytes - digest.effectiveBytes);
    }
    return digest;
  });
  return {
    version: 1,
    instructionFiles,
    repositoryHead: effectiveCwd ? repositoryHead(effectiveCwd) : null,
  };
}

export function parseJobReplayContext(value: unknown): JobReplayContext | null {
  // The producer admits up to 256 real filesystem paths. A 256 KiB reader
  // ceiling was smaller than that valid producer envelope, so a record could
  // exist in memory and disappear after restart. The bound now covers 256
  // maximum Windows long paths plus the fixed digest metadata.
  if (typeof value !== "string" || value.length > MAX_REPLAY_CONTEXT_CHARS) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Partial<JobReplayContext>;
    if (
      record.version !== 1 ||
      !Array.isArray(record.instructionFiles) ||
      record.instructionFiles.length > MAX_RULE_FILES
    ) {
      return null;
    }
    if (
      record.repositoryHead !== null &&
      (typeof record.repositoryHead !== "string" || record.repositoryHead.length > 256)
    ) {
      return null;
    }
    const instructionFiles = record.instructionFiles.filter(
      (entry): entry is JobInstructionDigest => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
        const item = entry as Partial<JobInstructionDigest>;
        return (
          typeof item.path === "string" &&
          item.path.length <= MAX_REPLAY_PATH_CHARS &&
          isAbsolute(item.path) &&
          (typeof item.sha256 === "string" || item.sha256 === null) &&
          (typeof item.sourceBytes === "number" || item.sourceBytes === null) &&
          typeof item.effectiveBytes === "number" &&
          (typeof item.effectiveLimitBytes === "number" || item.effectiveLimitBytes === null) &&
          typeof item.truncated === "boolean" &&
          ["captured", "too_large", "unreadable"].includes(item.status ?? "")
        );
      }
    );
    if (instructionFiles.length !== record.instructionFiles.length) return null;
    return {
      version: 1,
      instructionFiles: instructionFiles.map(entry => ({ ...entry })),
      repositoryHead: record.repositoryHead ?? null,
    };
  } catch {
    return null;
  }
}
