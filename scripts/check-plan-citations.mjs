#!/usr/bin/env node
/**
 * Every evidence file a plan cites must exist HERE.
 *
 * `docs/evidence` is gitignored and host-local by design: it holds measurements
 * and reasoning history that must never reach the public mirror. The cost of
 * that design is that a track working in its own git worktree writes evidence
 * nobody else can see, and the plan file then cites a path that resolves on
 * exactly one checkout.
 *
 * That happened three times in one programme. The DAG cited
 * storage-s5-design, storage-s7 and storage-s8; all three existed only inside
 * the worktree that wrote them. Three separate tracks reported being unable to
 * read a document the map told them to read, and the coordinator went on citing
 * a section number out of it in briefs, having never checked it was reachable.
 *
 * A citation nobody can follow is worse than no citation: it reads as evidence.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLANS = join(ROOT, "docs", "plans");

// Same scan set as the density ratchet: tracked plus untracked-not-ignored, so
// a plan being written is checked before it is committed rather than after.
const planFiles = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "--", "docs/plans/*.dag.toml"],
  { cwd: ROOT, encoding: "utf8" }
)
  .split("\n")
  .filter(Boolean)
  .map(p => p.slice("docs/plans/".length))
  .filter(f => existsSync(join(PLANS, f)))
  .sort();

// ONLY explicit docs/evidence/ paths. An earlier draft of this gate matched any
// bare *.md name and fired on 55 pre-existing prose references (SKILL.md,
// PRODUCT_CONTRACT.md, connect-*.md, and template placeholders like
// YYYY-MM-DD-grok.md). It was red before the defect, red during it and red
// after: a gate that cannot tell the three apart is not a control, which is the
// finding this programme has recorded more than any other.
//
// The defect being closed is narrow and deserves a narrow gate: a plan states
// `docs/evidence/<name>` and <name> is not there.
const CITATION = /docs\/evidence\/([A-Za-z0-9][A-Za-z0-9._-]*\.md)/g;

const evidenceDir = join(ROOT, "docs", "evidence");
const present = new Set(existsSync(evidenceDir) ? readdirSync(evidenceDir) : []);

const missing = [];
for (const file of planFiles) {
  const text = readFileSync(join(PLANS, file), "utf8");
  const seen = new Set();
  for (const [, name] of text.matchAll(CITATION)) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (present.has(name)) continue;
    missing.push(`${file}: cites docs/evidence/${name}, which is not on this host`);
  }
}

console.log("plan:citations:check");
if (missing.length > 0) {
  console.error("\n  FAIL");
  for (const m of missing) console.error(`    ${m}`);
  console.error(
    "\n  Evidence written inside a git worktree is invisible everywhere else.\n" +
      "  Copy it into the main checkout's docs/evidence/, or drop the citation.\n"
  );
  process.exit(1);
}
console.log(`  OK: ${planFiles.length} plan files, every cited evidence file resolves.`);
