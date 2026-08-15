#!/usr/bin/env node
// Verify docs/plans/validation-launch-surface.dag.toml against the actual code.
//
// A map with wrong coordinates is worse than no map: it is a control that
// cannot fail, in documentation form. Three stale COMMENTS in this same surface
// each survived a round of review by sounding careful, so this DAG is checked
// rather than trusted.
//
// Checks:
//   1. every node's file:line still declares the symbol it names
//   2. every invariant's caller count matches the source
//   3. every path named in a `flow` list still contains the field
//
// Exit 0 clean, 1 on drift. Run: node scripts/check-launch-surface-dag.mjs

import { readFileSync } from "node:fs";

const DAG = "docs/plans/validation-launch-surface.dag.toml";
const dag = readFileSync(DAG, "utf8");
const problems = [];

const fileCache = new Map();
const linesOf = path => {
  if (!fileCache.has(path)) fileCache.set(path, readFileSync(path, "utf8").split("\n"));
  return fileCache.get(path);
};

// ---- 1. node coordinates ---------------------------------------------------
const nodeBlocks = dag.split("[[node]]").slice(1);
let nodesChecked = 0;
for (const block of nodeBlocks) {
  const id = /id = "([^"]+)"/.exec(block)?.[1];
  const file = /file = "([^"]+)"/.exec(block)?.[1];
  const line = /line = (\d+)/.exec(block)?.[1];
  if (!id || !file || !line) continue;
  nodesChecked++;
  const symbol = id.split(".").slice(1).join(".");
  const lines = linesOf(file);
  const n = Number(line);
  if (n > lines.length) {
    problems.push(`${id}: ${file}:${n} is past end of file (${lines.length} lines)`);
    continue;
  }
  // Allow a small window: a declaration may be preceded by a decorator or
  // spread over a few lines, but it must be findable near the coordinate.
  const window = lines.slice(Math.max(0, n - 3), n + 2).join("\n");
  if (!window.includes(symbol)) {
    problems.push(`${id}: ${file}:${n} no longer declares "${symbol}" (found: ${lines[n - 1].trim().slice(0, 60)})`);
  }
}

// ---- 2. caller-count invariants -------------------------------------------
// Counted from source rather than from sqry, so this runs with no daemon and
// in CI. The orchestrator is one file, which is what makes this tractable.
const ORCH = "src/validation-orchestrator.ts";
const orchLines = linesOf(ORCH);
const callSitesOf = name =>
  orchLines.filter(raw => {
    const line = raw.trim();
    return (
      line.includes(`${name}(`) &&
      !line.startsWith("//") &&
      !line.startsWith("*") &&
      !line.startsWith("function ") &&
      !line.startsWith("async function ")
    );
  }).length;

const invariantBlocks = dag.split("[[invariant]]").slice(1);
let invariantsChecked = 0;
for (const block of invariantBlocks) {
  const symbol = /symbol = "([^"]+)"/.exec(block)?.[1];
  const callers = /callers = (\d+)/.exec(block)?.[1];
  if (!symbol || !callers) continue;
  invariantsChecked++;
  const actual = callSitesOf(symbol);
  if (actual !== Number(callers)) {
    problems.push(
      `invariant ${symbol}: DAG says ${callers} caller(s), source has ${actual}. ` +
        `If a new caller was added, route it through launchProviderSeat rather than updating this number.`
    );
  }
}

// ---- 3. declared data-flow paths -------------------------------------------
const flowBlock = /flow = \[([\s\S]*?)\]/.exec(dag)?.[1] ?? "";
const fieldId = /id = "field\.([^"]+)"/.exec(dag)?.[1];
let flowsChecked = 0;
for (const entry of flowBlock.split("\n")) {
  const m = /"([^"\s]+\.ts):(\d+)/.exec(entry);
  if (!m || !fieldId) continue;
  flowsChecked++;
  const [, file, lineNo] = m;
  const lines = linesOf(file);
  const n = Number(lineNo);
  const window = lines.slice(Math.max(0, n - 3), n + 2).join("\n");
  if (!window.includes(fieldId)) {
    problems.push(`flow ${file}:${n} no longer carries "${fieldId}"`);
  }
}

console.log(
  `checked ${nodesChecked} nodes, ${invariantsChecked} invariants, ${flowsChecked} flow hops`
);
if (problems.length === 0) {
  console.log("launch-surface DAG matches the code");
  process.exit(0);
}
console.error(`\nlaunch-surface DAG has drifted from the code:\n`);
for (const p of problems) console.error(`  - ${p}`);
console.error(
  `\nThe DAG is the map used to decide what a change affects. Fix the code or ` +
    `the map, but do not leave them disagreeing.`
);
process.exit(1);
