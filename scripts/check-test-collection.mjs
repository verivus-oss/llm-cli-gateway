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
 * vitest 5's `list` has TWO quirks this gate has to work around, and getting
 * only one of them right is how a regression slipped in:
 *   1. It does NOT expand the tests of a file whose every case lives under a
 *      conditional block describe (`describe.skipIf(...)` / `describe.runIf(...)`):
 *      such a file (cli-entrypoint.test.ts, job-progress-wire-capability.test.ts)
 *      transforms and runs yet lists zero `> suite > test` lines.
 *   2. It exits 0 EVEN ON AN UNPARSEABLE FILE (it prints an error to stderr and
 *      skips it). So `vitest list`'s exit code is NOT a transform guard, and
 *      neither is `--filesOnly` (which globs filenames and includes a broken
 *      file). Relying on either lets a tracked file with a syntax error pass.
 * Membership is therefore taken from the `> suite > test` output of the full
 * `vitest list`: a normal file appears there, so a file that is ABSENT is either
 * unparseable (the defect to catch) or one of the two known conditional-describe
 * files (legitimately zero-test). The latter are named in CONDITIONAL_ZERO_TEST
 * and excused; anything else absent fails. `--filesOnly` supplies the universe of
 * included files, used only to flag a collected-but-untracked extra.
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

const listEnv = { ...process.env, PG_TESTS: "1", INTEGRATION_TESTS: "1", CI: "1" };

// Files whose every test lives under a conditional block describe, so the full
// `vitest list` lists zero tests for them though they transform and run (see the
// header, quirk 1). They are excused from the membership check by exact path.
// Adding a new one is a deliberate, visible edit; a broken file is NOT on this
// list and so still fails.
const CONDITIONAL_ZERO_TEST = new Set([
  "src/__tests__/cli-entrypoint.test.ts",
  "src/__tests__/job-progress-wire-capability.test.ts",
]);

const runList = extraArgs =>
  execFileSync("npx", ["vitest", "list", ...extraArgs], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: listEnv,
  });

// Membership is the set of files that emitted at least one `> suite > test`
// line: a normal file appears, an unparseable one does not (quirk 2 means we
// cannot lean on the exit code). Files with a conditional-only describe also do
// not appear and are excused below.
const withTests = new Set(
  runList([])
    .split("\n")
    .map(line => line.split(" > ")[0].trim())
    .filter(line => /\.test\.(ts|mjs)$/.test(line))
);

// The universe of INCLUDED files (globs matched, includes even an unparseable
// file), used only to flag a collected-but-untracked extra.
const included = new Set(
  runList(["--filesOnly"])
    .split("\n")
    .map(line => line.trim())
    .filter(line => /\.test\.(ts|mjs)$/.test(line))
);

const collectable = new Set([...withTests, ...CONDITIONAL_ZERO_TEST]);
const missing = sorted(tracked).filter(f => !collectable.has(f));
const extra = sorted(included).filter(f => !tracked.has(f));
// Guard the allowlist itself: a stale entry (renamed/removed, or one that now
// lists tests normally and no longer needs excusing) must not hide silently.
const staleAllowlist = sorted(CONDITIONAL_ZERO_TEST).filter(
  f => !tracked.has(f) || withTests.has(f)
);

console.log("test:collection");
if (missing.length === 0 && extra.length === 0 && staleAllowlist.length === 0) {
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
for (const f of staleAllowlist) {
  console.error(
    `    ${f}: stale CONDITIONAL_ZERO_TEST entry (now lists tests or is not tracked; remove it)`
  );
}
process.exit(1);
