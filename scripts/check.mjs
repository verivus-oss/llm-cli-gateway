#!/usr/bin/env node
/**
 * `npm run check`, the release gate.
 *
 * Replaces a 22-step `&&` chain. The chain stopped at the first failure, so one
 * broken step hid every step after it, and this repo ran for months with
 * `security:audit` at 21 of 22 failing on every developer tree and
 * `verify:no-internal-mcp:check` therefore never running at all.
 *
 * Everything runs. Everything is reported. A step that could not run because
 * something it needs failed is SKIPPED, which is a third outcome and not a pass.
 *
 *   node scripts/check.mjs [--fail-fast] [--serial] [--only <name>]... [--list]
 *                          [--concurrency N]
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STEPS } from "./check-steps.mjs";
import { runSteps, summarise } from "./run-steps.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};
const only = argv.reduce((acc, a, i) => (argv[i - 1] === "--only" ? [...acc, a] : acc), []);

if (flag("list")) {
  for (const s of STEPS) {
    const notes = [s.heavy ? "heavy" : null, s.needs ? `needs ${s.needs.join(",")}` : null]
      .filter(Boolean)
      .join(", ");
    console.log(`${s.name}${notes ? `  (${notes})` : ""}`);
  }
  process.exit(0);
}

const selected = only.length > 0 ? STEPS.filter(s => only.includes(s.name)) : STEPS;
if (only.length > 0 && selected.length !== only.length) {
  const known = new Set(STEPS.map(s => s.name));
  console.error(`unknown step(s): ${only.filter(n => !known.has(n)).join(", ")}`);
  process.exit(2);
}

const execute = step =>
  new Promise(resolve => {
    const child = spawn("npm", ["run", step.script], {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", d => (output += d));
    child.stderr.on("data", d => (output += d));
    child.on("error", error => resolve({ code: 1, output: `${output}\n${error.message}` }));
    child.on("close", code => resolve({ code: code ?? 1, output }));
  });

const MARK = { pass: "PASS", fail: "FAIL", skipped: "SKIP" };
const seconds = ms => `${(ms / 1000).toFixed(1)}s`.padStart(6);

const started = Date.now();
const results = await runSteps(selected, execute, {
  concurrency: flag("serial") ? 1 : Number(value("concurrency", "4")),
  failFast: flag("fail-fast"),
  onResult: r =>
    console.log(
      `${MARK[r.status]} ${seconds(r.ms)}  ${r.name}${r.blockedBy ? `  (needs ${r.blockedBy})` : ""}`
    ),
});

const failed = results.filter(r => r.status === "fail");
for (const r of failed) {
  console.log(`\n${"=".repeat(72)}\nFAIL: ${r.name}  (exit ${r.code})\n${"=".repeat(72)}`);
  console.log(r.output.trimEnd());
}

const { pass, fail, skipped, total } = summarise(results);
console.log(
  `\ncheck: ${pass}/${total} passed, ${fail} failed, ${skipped} skipped in ${seconds(Date.now() - started).trim()}`
);
// Skipped counts against the gate. A step that did not run has not passed, and
// reporting the run green because nothing said otherwise is the exact failure
// this replaces.
if (fail > 0 || skipped > 0) {
  const names = results.filter(r => r.status !== "pass").map(r => `${r.status}:${r.name}`);
  console.error(`check FAILED: ${names.join(" ")}`);
  process.exit(1);
}
console.log("check passed.");
