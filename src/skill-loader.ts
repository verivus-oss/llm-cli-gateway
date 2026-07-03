import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import path from "path";
import { z } from "zod/v3";
import type { Logger } from "./logger.js";
import { logWarn, noopLogger } from "./logger.js";

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

const SkillPackManifestSchema = z
  .object({
    name: z.string().regex(SKILL_NAME_PATTERN),
    version: z.string().min(1),
    skills: z
      .array(
        z
          .object({
            name: z.string().regex(SKILL_NAME_PATTERN),
            sha256: z.string().regex(/^[a-f0-9]{64}$/i),
          })
          .strict()
      )
      .default([]),
  })
  .strict();

export interface SkillEntry {
  name: string;
  content: string;
  description: string;
  source: "bundled" | "external";
  path: string;
  pack: {
    name: string;
    version: string;
    manifestPath: string;
    verified: boolean;
  } | null;
}

export interface LoadGatewaySkillsOptions {
  bundledSkillsDir: string;
  configuredPaths?: string[];
  envSkillsPath?: string | undefined;
  userSkillsDir?: string;
  logger?: Logger;
}

interface SkillRoot {
  path: string;
  source: "bundled" | "external";
  label: string;
}

type SkillPackManifest = z.infer<typeof SkillPackManifestSchema>;

export function defaultUserSkillsDir(): string {
  return path.join(homedir(), ".llm-cli-gateway", "skills");
}

export function parseSkillPathList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(path.delimiter)
    .map(part => part.trim())
    .filter(Boolean);
}

export function loadGatewaySkills(options: LoadGatewaySkillsOptions): SkillEntry[] {
  const logger = options.logger ?? noopLogger;
  const roots: SkillRoot[] = [
    { path: options.bundledSkillsDir, source: "bundled", label: "bundled" },
    ...normalizeExternalRoots(options.configuredPaths ?? [], "configured"),
    ...normalizeExternalRoots(parseSkillPathList(options.envSkillsPath), "LLM_GATEWAY_SKILLS_PATH"),
  ];

  const userSkillsDir = options.userSkillsDir ?? defaultUserSkillsDir();
  if (existsSync(userSkillsDir)) {
    roots.push({ path: userSkillsDir, source: "external", label: "user" });
  }

  const byName = new Map<string, SkillEntry>();
  for (const root of roots) {
    for (const skill of readSkillRoot(root, logger)) {
      const prior = byName.get(skill.name);
      if (prior) {
        logWarn(
          logger,
          `Skill '${skill.name}' from ${skill.path} overrides ${prior.source} skill at ${prior.path}`
        );
      }
      byName.set(skill.name, skill);
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeExternalRoots(paths: string[], label: string): SkillRoot[] {
  return paths.map(p => ({
    path: expandHome(p),
    source: "external" as const,
    label,
  }));
}

function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? path.join(homedir(), p.slice(2)) : p;
}

function readSkillRoot(root: SkillRoot, logger: Logger): SkillEntry[] {
  if (!existsSync(root.path)) {
    if (root.source === "external") {
      logWarn(logger, `Configured skill path does not exist; skipping: ${root.path}`);
    }
    return [];
  }

  let stat;
  try {
    stat = statSync(root.path);
  } catch (err) {
    logWarn(logger, `Cannot stat skill path; skipping: ${root.path}`, err);
    return [];
  }
  if (!stat.isDirectory()) {
    logWarn(logger, `Skill path is not a directory; skipping: ${root.path}`);
    return [];
  }

  const manifest = readManifest(root, logger);
  if (manifest === "invalid") return [];

  if (existsSync(path.join(root.path, "SKILL.md"))) {
    const skill = readSkillDir(root.path, root, manifest, logger);
    return skill ? [skill] : [];
  }

  let entries;
  try {
    entries = readdirSync(root.path, { withFileTypes: true });
  } catch (err) {
    logWarn(logger, `Cannot read skill path; skipping: ${root.path}`, err);
    return [];
  }

  const skills: SkillEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skill = readSkillDir(path.join(root.path, entry.name), root, manifest, logger);
    if (skill) skills.push(skill);
  }

  if (manifest && manifest.skills.length > 0) {
    const loaded = new Set(skills.map(skill => skill.name));
    for (const expected of manifest.skills) {
      if (!loaded.has(expected.name)) {
        logWarn(
          logger,
          `Skill pack '${manifest.name}' declares '${expected.name}', but no verified SKILL.md was loaded`
        );
      }
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function readManifest(root: SkillRoot, logger: Logger): SkillPackManifest | "invalid" | null {
  const manifestPath = path.join(root.path, "skill-pack.json");
  if (!existsSync(manifestPath)) return null;

  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    return SkillPackManifestSchema.parse(raw);
  } catch (err) {
    logWarn(logger, `Invalid skill-pack.json at ${manifestPath}; skipping skill pack`, err);
    return "invalid";
  }
}

function readSkillDir(
  skillDir: string,
  root: SkillRoot,
  manifest: SkillPackManifest | null,
  logger: Logger
): SkillEntry | null {
  const skillPath = path.join(skillDir, "SKILL.md");
  if (!existsSync(skillPath)) return null;

  let content: string;
  try {
    content = readFileSync(skillPath, "utf8");
  } catch (err) {
    logWarn(logger, `Cannot read skill file; skipping: ${skillPath}`, err);
    return null;
  }

  const frontmatter = parseSkillFrontmatter(content);
  const dirName = path.basename(skillDir);
  const name = frontmatter.name || dirName;
  if (!SKILL_NAME_PATTERN.test(name)) {
    logWarn(logger, `Invalid skill name '${name}' in ${skillPath}; skipping`);
    return null;
  }
  if (frontmatter.name && frontmatter.name !== dirName) {
    logWarn(
      logger,
      `Skill frontmatter name '${frontmatter.name}' does not match directory '${dirName}'; skipping ${skillPath}`
    );
    return null;
  }

  const packInfo = verifyManifestEntry(name, content, skillPath, root, manifest, logger);
  if (packInfo === "skip") return null;

  return {
    name,
    content,
    description: frontmatter.description || name,
    source: root.source,
    path: skillPath,
    pack: packInfo,
  };
}

function verifyManifestEntry(
  name: string,
  content: string,
  skillPath: string,
  root: SkillRoot,
  manifest: SkillPackManifest | null,
  logger: Logger
): SkillEntry["pack"] | "skip" {
  if (!manifest) return null;

  const expected = manifest.skills.find(skill => skill.name === name);
  if (!expected) {
    logWarn(
      logger,
      `Skill pack '${manifest.name}' does not list '${name}' in skill-pack.json; skipping ${skillPath}`
    );
    return "skip";
  }

  const actual = createHash("sha256").update(content, "utf8").digest("hex");
  if (actual.toLowerCase() !== expected.sha256.toLowerCase()) {
    logWarn(
      logger,
      `Skill pack '${manifest.name}' hash mismatch for '${name}'; skipping ${skillPath}`
    );
    return "skip";
  }

  return {
    name: manifest.name,
    version: manifest.version,
    manifestPath: path.join(root.path, "skill-pack.json"),
    verified: true,
  };
}

function parseSkillFrontmatter(content: string): {
  name: string | null;
  description: string | null;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { name: null, description: null };

  return {
    name: scalarFrontmatterValue(match[1], "name"),
    description: scalarFrontmatterValue(match[1], "description"),
  };
}

function scalarFrontmatterValue(frontmatter: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = frontmatter.match(new RegExp(`^${escapedKey}:\\s*(.+?)\\s*$`, "m"));
  if (!match) return null;
  return match[1].replace(/^["']|["']$/g, "").trim();
}
