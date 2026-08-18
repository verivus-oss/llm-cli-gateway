#!/usr/bin/env node
/**
 * Plan-density ratchet.
 *
 * docs/plans is 16,699 lines across 33 files, and one recent program put 1,799
 * lines there against 1,095 lines of src. A plan file is a map: it states the
 * work and links its evidence. Measurements, alternatives considered and
 * reasoning history go in docs/evidence/<topic>-<date>.md, which the
 * durable-state map already does.
 *
 * Fails in BOTH directions, like scripts/provider-surfaces-check.mjs: growth
 * past a file's recorded ceiling is the defect, and a deleted file must update
 * the baseline or its ceiling silently returns if the file is ever re-added.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLANS = join(ROOT, "docs", "plans");
const BASELINE = join(PLANS, ".density-baseline.json");
const NEW_FILE_CAP = 150;
const UPDATE = process.argv.includes("--update");

const lines = f => readFileSync(join(PLANS, f), "utf8").split("\n").length;
const current = Object.fromEntries(
  readdirSync(PLANS)
    .filter(f => f.endsWith(".dag.toml"))
    .sort()
    .map(f => [f, lines(f)])
);

if (UPDATE) {
  writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`plan density baseline updated: ${Object.keys(current).length} files`);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
} catch {
  console.error(`missing ${BASELINE}; run: npm run plans:density:update`);
  process.exit(1);
}

const failures = [];
const ratchetable = [];
for (const [file, n] of Object.entries(current)) {
  const ceiling = baseline[file];
  if (ceiling === undefined) {
    if (n > NEW_FILE_CAP) {
      failures.push(
        `${file}: NEW and ${n} lines, cap is ${NEW_FILE_CAP}. State the work, link the evidence.`
      );
    }
    continue;
  }
  if (n > ceiling) {
    failures.push(
      `${file}: ${n} lines, ceiling ${ceiling} (+${n - ceiling}). ` +
        `Put the detail in docs/evidence/ and link it from the node.`
    );
  } else if (n < ceiling) {
    ratchetable.push(`${file}: ${ceiling} -> ${n}`);
  }
}
for (const file of Object.keys(baseline)) {
  if (!(file in current)) failures.push(`${file}: GONE (run npm run plans:density:update)`);
}

console.log("plan:density:check");
if (ratchetable.length > 0) {
  console.log(`  ${ratchetable.length} file(s) can ratchet down; run npm run plans:density:update`);
  for (const r of ratchetable) console.log(`    ${r}`);
}
if (failures.length > 0) {
  console.error("\n  FAIL");
  for (const f of failures) console.error(`    ${f}`);
  process.exit(1);
}
console.log(`  OK: ${Object.keys(current).length} plan files, none above ceiling.`);
