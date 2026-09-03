#!/usr/bin/env node
/**
 * Can a reviewer's sqry graph see the code the reviewer is being asked to review?
 *
 * Round 27 asserted three times that the index was current at the reviewed
 * commit. It was not, and could not have been: the index lives per WORKSPACE
 * ROOT, the main checkout indexes `master`, and reviewers work in worktrees on a
 * branch. A symbol the branch introduces is absent from that graph however
 * freshly it was rebuilt. What was actually checked was daemon RESIDENCY, which
 * is a different question with a reassuring answer.
 *
 * So this does not ask whether the index is fresh. It asks the only question
 * that means anything: resolve a symbol that exists ONLY on this branch, in the
 * workspace root the reviewer will use, through the tool the reviewer will use.
 * The symbol is derived from the diff rather than passed in, because a symbol
 * chosen by hand is one more thing that can quietly stop being branch-only.
 *
 *   node scripts/verify-review-index.mjs [worktree] [--base <ref>]
 *
 * Exit 0 when the graph resolves it, 1 when it does not, 2 when the question
 * could not be asked at all. A failure is not "run sqry index": inside a
 * worktree that is `sqry update`, which refreshes `.sqry/analysis`, where
 * `sqry index --force` was measured leaving it untouched.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const baseAt = args.indexOf("--base");
const base = baseAt >= 0 ? args[baseAt + 1] : "master";
// `baseAt + 1` is 0 when `--base` is absent, which silently skipped the first
// positional argument and made every invocation resolve the CWD instead of the
// directory asked about. Both runs then reported on the same tree.
const positional = args.filter((a, i) => !a.startsWith("--") && !(baseAt >= 0 && i === baseAt + 1));
const root = resolve(positional[0] ?? ".");

// BOTH streams. `sqry query` writes its result banner to stderr, so a
// stdout-only read came back empty and every symbol looked missing.
const run = (cmd, argv, cwd = root) => {
  const result = spawnSync(cmd, argv, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${cmd} exited ${result.status}: ${result.stderr ?? ""}`);
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
};

function fail(code, message) {
  console.error(`verify-review-index: ${message}`);
  process.exit(code);
}

if (!existsSync(resolve(root, ".sqry", "graph"))) {
  fail(2, `${root} has no .sqry/graph. Run \`sqry index .\` inside it, not in the main checkout.`);
}

// Symbols this branch ADDS. An exported name is used because it is the shape a
// reviewer is asked to trace callers of, which is what the graph is for.
let added;
try {
  const diff = run("git", ["diff", `${base}...HEAD`, "--", "src/"]);
  added = [
    ...new Set([...diff.matchAll(/^\+export (?:async )?function (\w+)/gm)].map(match => match[1])),
  ];
} catch (error) {
  fail(2, `could not diff against ${base}: ${error instanceof Error ? error.message : error}`);
}

if (added.length === 0) {
  fail(
    2,
    `no exported function is added by ${base}...HEAD, so there is nothing branch-only to look for.`
  );
}

const head = run("git", ["rev-parse", "--short", "HEAD"]).trim();
const missing = [];
for (const symbol of added) {
  let out = "";
  try {
    out = run("sqry", ["query", symbol]);
  } catch (error) {
    fail(2, `\`sqry query ${symbol}\` failed: ${error instanceof Error ? error.message : error}`);
  }
  // A DEFINITION line, not merely a mention. sqry prints `... function NAME` for
  // a definition and `... import NAME` for a use, and it TRUNCATES the path for
  // display, so matching on the path cannot work; the workspace is pinned by
  // running sqry with `cwd` set to the root instead.
  const hits = out.split("\n").filter(line => new RegExp(`function ${symbol}$`).test(line.trim()));
  if (hits.length === 0) missing.push(symbol);
}

if (missing.length > 0) {
  fail(
    1,
    `${root} at ${head} does not resolve ${missing.length} of ${added.length} branch-only symbol(s): ` +
      `${missing.join(", ")}. The graph predates this branch. Run \`sqry update\` in THIS directory ` +
      `(not \`sqry index --force\`, which was measured leaving .sqry/analysis untouched), and do not ` +
      `ask a reviewer for structural evidence until this passes.`
  );
}

console.log(
  `verify-review-index: ${root} at ${head} resolves all ${added.length} branch-only symbol(s): ${added.join(", ")}`
);
