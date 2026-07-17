import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNeutralExecutionWorkspace } from "../neutral-workspace.js";

const originalCwd = process.cwd();
const originalTempEnv = {
  TMPDIR: process.env.TMPDIR,
  TMP: process.env.TMP,
  TEMP: process.env.TEMP,
};
const testRoots: string[] = [];

const CONTEXT_BEARING_ANCESTOR_MARKERS = [
  ".git",
  "AGENTS.md",
  "AGENTS.override.md",
  "Agents.md",
  "AGENT.md",
  "CLAUDE.md",
  "Claude.md",
  "CLAUDE.local.md",
  ".claude/CLAUDE.md",
  ".claude/rules",
  ".cursor/rules",
  ".cursorrules",
  "GEMINI.md",
  ".vibe/config.toml",
] as const;

const SYMLINKED_TEMP_ROOT_CONTEXT_MARKERS = [
  "GEMINI.md",
  ".cursor/rules",
  ".cursorrules",
  ".vibe/config.toml",
] as const;

function hasMarkerAncestor(directory: string): boolean {
  let current = realpathSync(directory);
  const root = parse(current).root;
  for (;;) {
    for (const marker of CONTEXT_BEARING_ANCESTOR_MARKERS) {
      if (existsSync(join(current, marker))) return true;
    }
    if (current === root) return false;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Fixtures must sit on an ancestor chain that is already clean, otherwise the
 * relocation these tests assert happens because of the ambient chain rather
 * than the marker under test and every case passes vacuously. A host whose
 * TMPDIR itself sits under a checkout is the common way that happens.
 */
function cleanBaseRoot(): string {
  const candidates = [tmpdir(), "/var/tmp", "/tmp", "/dev/shm"];
  for (const candidate of candidates) {
    try {
      if (!hasMarkerAncestor(candidate)) return candidate;
    } catch {
      // Candidate is absent or unreadable on this platform; try the next.
    }
  }
  throw new Error(`No context-free base directory for fixtures; tried ${candidates.join(", ")}`);
}

function setTempRoot(directory: string): void {
  process.env.TMPDIR = directory;
  process.env.TMP = directory;
  process.env.TEMP = directory;
}

function createContextMarker(root: string, marker: string): void {
  const markerPath = join(root, marker);
  if (marker === ".claude/rules" || marker === ".cursor/rules") {
    mkdirSync(markerPath, { recursive: true });
    return;
  }
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, marker === ".git" ? "gitdir: elsewhere\n" : "context\n");
}

afterEach(() => {
  process.chdir(originalCwd);
  for (const [key, value] of Object.entries(originalTempEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of testRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("neutral execution workspace", () => {
  it("creates a private gateway-owned directory and cleans it idempotently", () => {
    const workspace = createNeutralExecutionWorkspace();
    try {
      expect(workspace.cwd).not.toBe(process.cwd());
      expect(basename(workspace.cwd)).toMatch(/^llm-cli-gateway-neutral-/);
      const stat = statSync(workspace.cwd);
      expect(stat.isDirectory()).toBe(true);
      if (process.platform !== "win32") {
        expect(stat.mode & 0o777).toBe(0o700);
        if (typeof process.getuid === "function") expect(stat.uid).toBe(process.getuid());
      }
      expect(existsSync(`${workspace.cwd}/AGENTS.md`)).toBe(false);
      expect(existsSync(`${workspace.cwd}/CLAUDE.md`)).toBe(false);
      expect(existsSync(`${workspace.cwd}/GEMINI.md`)).toBe(false);
    } finally {
      workspace.cleanup();
      workspace.cleanup();
    }
    expect(existsSync(workspace.cwd)).toBe(false);
  });

  it("allocates a different workspace for each unscoped process", () => {
    const first = createNeutralExecutionWorkspace();
    const second = createNeutralExecutionWorkspace();
    try {
      expect(first.cwd).not.toBe(second.cwd);
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });

  it.each(CONTEXT_BEARING_ANCESTOR_MARKERS)(
    "relocates away from a custom temp root beneath an ancestor containing %s",
    marker => {
      const root = mkdtempSync(join(cleanBaseRoot(), "gateway-neutral-ancestor-"));
      testRoots.push(root);
      const contextRoot = join(root, "checkout");
      const gatewayCwd = join(contextRoot, "nested", "gateway");
      const customTemp = join(contextRoot, "runtime", "tmp");
      mkdirSync(gatewayCwd, { recursive: true });
      mkdirSync(customTemp, { recursive: true });
      createContextMarker(contextRoot, marker);
      process.chdir(gatewayCwd);
      setTempRoot(customTemp);

      const workspace = createNeutralExecutionWorkspace();
      try {
        const fromContext = relative(contextRoot, workspace.cwd);
        expect(fromContext.startsWith("..")).toBe(true);
        expect(isAbsolute(fromContext)).toBe(false);
      } finally {
        workspace.cleanup();
      }
    }
  );

  it.each([".claude/settings.json", "GROK.md"] as const)(
    "keeps a custom temp root beneath %s, which no provider discovers by ancestor walk",
    marker => {
      const root = mkdtempSync(join(cleanBaseRoot(), "gateway-neutral-excluded-"));
      testRoots.push(root);
      const contextRoot = join(root, "home");
      const customTemp = join(contextRoot, "tmp");
      mkdirSync(customTemp, { recursive: true });
      createContextMarker(contextRoot, marker);
      setTempRoot(customTemp);

      const workspace = createNeutralExecutionWorkspace();
      try {
        // User-scope settings load regardless of cwd and Grok resolves
        // GROK.md only under a .git root, so relocating buys no isolation.
        const fromTemp = relative(customTemp, workspace.cwd);
        expect(fromTemp.startsWith("..")).toBe(false);
        expect(isAbsolute(fromTemp)).toBe(false);
      } finally {
        workspace.cleanup();
      }
    }
  );

  it.each(SYMLINKED_TEMP_ROOT_CONTEXT_MARKERS)(
    "relocates a symlinked custom temp root beneath %s context",
    marker => {
      const root = mkdtempSync(join(cleanBaseRoot(), "gateway-neutral-symlink-"));
      testRoots.push(root);
      const contextRoot = join(root, "instruction-scope");
      const actualTemp = join(contextRoot, "tmp");
      const tempLink = join(root, "temp-link");
      mkdirSync(actualTemp, { recursive: true });
      createContextMarker(contextRoot, marker);
      symlinkSync(actualTemp, tempLink, process.platform === "win32" ? "junction" : "dir");
      setTempRoot(tempLink);

      const workspace = createNeutralExecutionWorkspace();
      try {
        const fromContext = relative(contextRoot, workspace.cwd);
        expect(fromContext.startsWith("..")).toBe(true);
        expect(isAbsolute(fromContext)).toBe(false);
      } finally {
        workspace.cleanup();
      }
    }
  );
});
