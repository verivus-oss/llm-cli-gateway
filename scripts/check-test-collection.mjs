#!/usr/bin/env node
/**
 * Every tracked test file must collect.
 *
 * `npm test` excludes `*-pg` and integration suites unless PG_TESTS or
 * INTEGRATION_TESTS is set, because they need a live database. Nothing else
 * covered them either: `npm run build` typechecks tsconfig.build.json, which
 * excludes tests, and eslint ignores `**` + `/*.test.ts`. So those files were
 * verified by nothing, and a sweep that repaired every other suite left
 * migration-pg.test.ts holding an await inside a Promise.all that serialised the
 * two migrate processes whose race is the only thing the test exists to check.
 *
 * Collection needs no database, so this runs the excluded suites through
 * `vitest list` and compares the collected set against `git ls-files`. A set,
 * not a count: a count only works as a control if something compares it, and a
 * suite already red for other reasons hides a total that quietly dropped by 64.
 *
 * NOT `--filesOnly`. That globs filenames and exits 0 on a file that cannot be
 * parsed, so the first version of this gate passed in both states. Full
 * collection transforms every file, which is the property being asserted.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_PATHSPECS = [
  "src/__tests__/*.test.ts",
  "src/__tests__/**/*.test.ts",
  "scripts/*.test.mjs",
];

const sorted = set => [...set].sort();

const tracked = new Set(
  execFileSync("git", ["ls-files", "--", ...TEST_PATHSPECS], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
);

let listing;
try {
  listing = execFileSync("npx", ["vitest", "list"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, PG_TESTS: "1", INTEGRATION_TESTS: "1", CI: "1" },
  });
} catch (error) {
  // A file that cannot be transformed makes vitest exit non-zero. That is the
  // defect, not a tool failure, so report its output rather than a stack trace.
  console.error("test:collection\n\n  FAIL: vitest could not collect the suite.\n");
  console.error(String(error.stdout ?? "") + String(error.stderr ?? ""));
  process.exit(1);
}

// Each line is `path > suite > test`; the file is everything before the first
// separator, and a file with no tests still had to transform to say so.
const collected = new Set(
  listing
    .split("\n")
    .map(line => line.split(" > ")[0].trim())
    .filter(line => /\.test\.(ts|mjs)$/.test(line))
);

const missing = sorted(tracked).filter(f => !collected.has(f));
const extra = sorted(collected).filter(f => !tracked.has(f));

console.log("test:collection");
if (missing.length === 0 && extra.length === 0) {
  console.log(`  OK: ${tracked.size} tracked test files, all collected.`);
  process.exit(0);
}
console.error("\n  FAIL");
for (const f of missing) {
  console.error(`    ${f}: TRACKED but not collected (transform error, or excluded by config)`);
}
for (const f of extra) {
  console.error(`    ${f}: collected but NOT TRACKED (commit it, or stop matching it)`);
}
process.exit(1);
