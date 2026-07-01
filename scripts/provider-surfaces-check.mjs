#!/usr/bin/env node
/**
 * provider:surfaces:check is the DRY ratchet for the provider registry.
 *
 * Scans src/ and FAILS on forbidden hand-maintained provider surfaces:
 *
 *   (1) literal provider-name arrays  (shared_provider_registry_design
 *       .forbidden_patterns.literal_provider_arrays), i.e. an array literal that
 *       spells out claude, codex, gemini, grok, mistral (optionally devin,
 *       cursor) instead of deriving from CLI_TYPES / the registry.
 *   (2) manual per-provider resource dispatch blocks of the form
 *       `uri === "sessions://<name>"` or `uri === "models://<name>"`.
 *
 * ALWAYS_ALLOWLIST names the sanctioned places these tokens may appear: the
 * enum source, the registry, the surface generator, generated snapshots, and
 * anything under __tests__.
 *
 * LEGACY_ALLOWLIST names files that still contain a pre-registry surface that a
 * LATER phase migrates. Each entry is tagged with the phase that removes it and
 * the specific pattern kind it is allowed to contain, so a NEW violation of a
 * different kind (or in a different file) still fails. When a later phase
 * migrates a file, delete its LEGACY_ALLOWLIST entry.
 *
 * The check PASSES on the current tree, FAILS on any new violation, and is
 * wired into `npm run check`. No em dash (U+2014) anywhere.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const srcRoot = join(repoRoot, "src");

const PROVIDER_NAME = "claude|codex|gemini|grok|mistral|devin|cursor";

/** Pattern (1): a literal provider-name array spelling out the CLI providers. */
const LITERAL_PROVIDER_ARRAY =
  /"claude"\s*,\s*"codex"\s*,\s*"gemini"\s*,\s*"grok"\s*,\s*"mistral"/;

/** Pattern (2): a manual `uri === "sessions://<name>"` / `models://<name>`. */
const MANUAL_RESOURCE_BLOCK = new RegExp(
  `uri\\s*===\\s*"(?:sessions|models)://(?:${PROVIDER_NAME})"`
);

const PATTERNS = [
  { kind: "literal-provider-array", regex: LITERAL_PROVIDER_ARRAY },
  { kind: "manual-resource-block", regex: MANUAL_RESOURCE_BLOCK },
];

/**
 * Files where these tokens are sanctioned (the source of truth itself, plus
 * tests and generated snapshots). Paths are repo-relative and posix-style.
 */
const ALWAYS_ALLOWLIST = new Set([
  "src/provider-definitions.ts",
  "src/provider-types.ts",
  "src/provider-surface-generator.ts",
]);

/**
 * Not-yet-migrated surfaces. Each file lists the pattern kind(s) it is allowed
 * to still contain and the phase that drains it.
 */
const LEGACY_ALLOWLIST = {
  // resources.ts still dispatches models:// / sessions:// per provider by hand;
  // phase-2 replaces this with provider-definition driven registration.
  "src/resources.ts": { allowedKinds: ["manual-resource-block"], phase: "phase-2" },
  // index.ts still has per-provider request-tool wiring and an approval_list
  // cli filter that spells out the provider array; phase-4 migrates the request
  // surface to the generated descriptors.
  "src/index.ts": { allowedKinds: ["literal-provider-array"], phase: "phase-4" },
};

function isAlwaysAllowed(relPath) {
  if (ALWAYS_ALLOWLIST.has(relPath)) return true;
  if (relPath.includes("__tests__")) return true;
  if (relPath.endsWith(".snap")) return true;
  return false;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function lineNumberOf(content, index) {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

const newViolations = [];
const legacyHits = [];

for (const absPath of walk(srcRoot)) {
  const relPath = relative(repoRoot, absPath).split("\\").join("/");
  if (isAlwaysAllowed(relPath)) continue;

  const content = readFileSync(absPath, "utf8");
  const legacy = LEGACY_ALLOWLIST[relPath];

  for (const { kind, regex } of PATTERNS) {
    const match = content.match(regex);
    if (!match) continue;
    const line = lineNumberOf(content, match.index ?? 0);
    const record = { relPath, kind, line, snippet: match[0] };
    if (legacy && legacy.allowedKinds.includes(kind)) {
      legacyHits.push({ ...record, phase: legacy.phase });
    } else {
      newViolations.push(record);
    }
  }
}

function log(msg) {
  process.stderr.write(`${msg}\n`);
}

log("provider:surfaces:check");
log(`  scanned: ${srcRoot}`);

if (legacyHits.length > 0) {
  log("");
  log("  known legacy surfaces (allowlisted, drained by a later phase):");
  for (const hit of legacyHits) {
    log(`    ${hit.relPath}:${hit.line} [${hit.kind}] drained by ${hit.phase}`);
  }
}

if (newViolations.length > 0) {
  log("");
  log("  FAIL: new provider-surface violations (add to the registry, not here):");
  for (const v of newViolations) {
    log(`    ${v.relPath}:${v.line} [${v.kind}] ${v.snippet}`);
  }
  log("");
  log("  Every provider surface must derive from src/provider-definitions.ts");
  log("  (or a projection in src/provider-surface-generator.ts). If this is a");
  log("  not-yet-migrated legacy surface, add it to LEGACY_ALLOWLIST with the");
  log("  phase that removes it.");
  process.exit(1);
}

log("");
log("  OK: no new hand-maintained provider surfaces.");
process.exit(0);
