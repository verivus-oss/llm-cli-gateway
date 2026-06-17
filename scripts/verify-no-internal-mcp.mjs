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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Case-sensitive. `\bexa\b` therefore does not match `EXA_API_KEY` (uppercase)
// or `example`/`exact` (word boundaries); each name's command form is matched
// literally.
const PATTERNS = [
  /\bsqry\b/,
  /sqry-mcp/,
  /\bexa\b/,
  /exa-mcp-server/,
  /\bref_tools\b/,
  /ref-tools-mcp/,
  /\btrstr\b/,
  /trstr-mcp/,
  /\bagent_browser\b/,
  /agent-browser/,
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
    content.split(/\r?\n/).forEach((line, index) => {
      for (const pattern of PATTERNS) {
        if (pattern.test(line)) {
          findings.push(`${rel}:${index + 1}: matches ${pattern} :: ${line.trim().slice(0, 160)}`);
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

  console.log(
    `verify-no-internal-mcp: clean — no internal MCP names in the packed tarball (${tgzName}).`
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
