#!/usr/bin/env node
// Release gate: pack the package exactly as it ships and hard-fail if any
// internal MCP server name or host command appears in ANY shipped file. This is
// the non-bypassable enforcement of the v5 plan's §2 goal — it scans the real
// tarball bytes, after the strip step (scripts/strip-internal-mcp.mjs) has run,
// so it reflects what consumers actually receive (not the working source tree).
//
// `npm pack --ignore-scripts` is used so no `prepack`/`prepare` hook can rebuild
// (and un-strip) dist mid-verify. This repo defines no such hook today; the flag
// is defense-in-depth.
//
// Token list (case-sensitive, word-boundaried) covers every internal name as a
// BARE token AND its host-command form, so a leak of any single name fails the
// gate — not just the obviously-unique ones. agent_browser/agent-browser are
// included for forward-compatibility (that server is gated WIP, not yet in the
// committed registry); guarding its tokens now costs nothing and prevents a
// future leak.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PACKED_INTERNAL_MCP_ALIASES,
  findInternalMcpAliases,
} from "./internal-mcp-alias-policy.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
if (args.some(arg => arg !== "--allow-unstripped-dist")) {
  throw new Error("Usage: node scripts/verify-no-internal-mcp.mjs [--allow-unstripped-dist]");
}
const allowUnstrippedDist = args.includes("--allow-unstripped-dist");

// Case-sensitive. Alias tokens therefore do not match `EXA_API_KEY` (uppercase)
// or `example`/`exact`; canonical `mcp__alias__tool` names are deliberately
// included because underscores delimit MCP server aliases.
const PATTERNS = [/sqry-mcp/, /exa-mcp-server/, /ref-tools-mcp/, /trstr-mcp/, /agent-browser/];

// Host-internal leak guard for shipped skills. Only caller-facing skills are
// listed in package.json `files`; operator/maintainer skills (provider-* contract
// guides, gateway-restart-surfaces) reference host paths/services and the source
// tree and must NEVER ship. If one is accidentally added to `files`, these
// patterns fail the gate. Scoped to .agents/skills/ tarball entries so compiled
// dist code is not falsely flagged. Case-insensitive.
const SKILL_HOST_INTERNAL_PATTERNS = [
  /\/opt\/nodejs/i,
  /systemd|systemctl|journalctl/i,
  /\/srv\/repos/i,
  // Gateway-internal source identifiers that only the maintainer/contract skills
  // reference. Deliberately NOT a generic `src/*.ts` match: caller-facing skills
  // legitimately use example prompts like "review src/auth.ts".
  /src\/upstream-contracts/i,
  /\bUPSTREAM_CLI_CONTRACTS\b/,
  /\bvalidateUpstreamCliArgs\b/,
  /kasselman/i,
  /\.service\b/i,
  /127\.0\.0\.1:\d/,
];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

const workDir = mkdtempSync(join(tmpdir(), "verify-no-internal-mcp-"));
try {
  // Pack into the temp dir; `npm pack` prints the tarball filename on stdout.
  const tgzName = execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--silent", "--pack-destination", workDir],
    { cwd: ROOT, encoding: "utf8" }
  )
    .trim()
    .split("\n")
    .pop()
    .trim();
  const tgzPath = join(workDir, tgzName);

  const extractDir = join(workDir, "extract");
  execFileSync("mkdir", ["-p", extractDir]);
  execFileSync("tar", ["-xzf", tgzPath, "-C", extractDir]);

  // npm tarballs root every entry under `package/`.
  const packageRoot = join(extractDir, "package");
  statSync(packageRoot); // throws if the tarball layout is unexpected

  const findings = [];
  for (const file of walk(packageRoot)) {
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue; // unreadable/binary — none expected in this package
    }
    const rel = relative(extractDir, file);
    const pathParts = rel.split(/[/\\]/);
    const isShippedSkill = /[/\\]\.agents[/\\]skills[/\\]/.test(rel);
    const isDist = pathParts.includes("dist");
    content.split(/\r?\n/).forEach((line, index) => {
      if (!allowUnstrippedDist || !isDist) {
        for (const alias of findInternalMcpAliases(line, PACKED_INTERNAL_MCP_ALIASES)) {
          findings.push(
            `${rel}:${index + 1}: matches internal MCP alias ${alias} :: ${line.trim().slice(0, 160)}`
          );
        }
        for (const pattern of PATTERNS) {
          if (pattern.test(line)) {
            findings.push(
              `${rel}:${index + 1}: matches ${pattern} :: ${line.trim().slice(0, 160)}`
            );
          }
        }
      }
      if (isShippedSkill) {
        for (const pattern of SKILL_HOST_INTERNAL_PATTERNS) {
          if (pattern.test(line)) {
            findings.push(
              `${rel}:${index + 1}: shipped skill leaks host-internal token ${pattern} :: ${line.trim().slice(0, 160)}`
            );
          }
        }
      }
    });
  }

  if (findings.length > 0) {
    console.error(
      "verify-no-internal-mcp: internal MCP name(s) found in the packed tarball " +
        "(strip step did not run or a name leaked into a non-stripped shipped file):"
    );
    for (const finding of findings) {
      console.error(`  ${finding}`);
    }
    process.exit(1);
  }

  const scope = allowUnstrippedDist ? " outside unstripped dist" : "";
  console.log(`verify-no-internal-mcp: clean${scope} in the packed tarball (${tgzName}).`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
