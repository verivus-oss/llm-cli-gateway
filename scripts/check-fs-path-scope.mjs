#!/usr/bin/env node
/**
 * Keeps the two provenance classes in `scripts/fs-path-scope.mjs` honest.
 *
 * `security/detect-non-literal-fs-filename` is off for most of the tree, which
 * is only defensible if the exclusion is a DECISION per module rather than a
 * default nobody revisits. This runs the rule with it forced on everywhere and
 * requires every module that reports it to be classified: either the caller can
 * influence the path (rule stays on) or it cannot (rule is off, and the entry
 * records that claim).
 *
 * The set is derived from the tree, not typed out, so a new module that reaches
 * the filesystem with a computed path fails here until someone says which class
 * it is in. That is the inversion the exclusion list needs: the second edit to
 * a list of exceptions should be a check that the list still covers the tree.
 */
import { ESLint } from "eslint";
import securityPlugin from "eslint-plugin-security";
import { relative } from "node:path";
import { CALLER_INFLUENCED_FS_MODULES, GATEWAY_OWNED_FS_MODULES } from "./fs-path-scope.mjs";

const RULE = "security/detect-non-literal-fs-filename";
const ROOT = process.cwd();
const TARGETS = ["src", "scripts", "site/js", ".github/scripts", "docs/plans"];

const eslint = new ESLint({
  overrideConfig: [
    {
      files: ["**/*.{ts,js,mjs,cjs}"],
      plugins: { security: securityPlugin },
      rules: { [RULE]: "warn" },
    },
  ],
  ignorePatterns: ["src/__tests__/**"],
});

const results = await eslint.lintFiles(TARGETS);

const reporting = new Set();
let total = 0;
for (const result of results) {
  const hits = result.messages.filter(message => message.ruleId === RULE).length;
  if (hits === 0) continue;
  total += hits;
  reporting.add(relative(ROOT, result.filePath));
}

// `scripts/` is a developer running tooling against their own checkout: no
// caller, no boundary, nothing for this rule to be a proxy for. Declared here
// rather than in the module lists because it is a property of the directory.
const UNGOVERNED_PREFIXES = ["scripts/", "site/js/", ".github/scripts/", "docs/plans/"];
const governed = [...reporting]
  .filter(file => !UNGOVERNED_PREFIXES.some(prefix => file.startsWith(prefix)))
  .sort();

const classified = new Set([...CALLER_INFLUENCED_FS_MODULES, ...GATEWAY_OWNED_FS_MODULES]);
const unclassified = governed.filter(file => !classified.has(file));
const stale = [...classified].filter(file => !governed.includes(file)).sort();

console.log("fs:path:scope:check");
console.log(
  `  ${reporting.size} file(s) report ${RULE} with it forced on; ` +
    `${governed.length} of them are under src/ and governed here.`
);
console.log(
  `  ${CALLER_INFLUENCED_FS_MODULES.length} caller-influenced, ` +
    `${GATEWAY_OWNED_FS_MODULES.length} gateway-owned, ${total} findings in total.`
);

const failures = [];
if (governed.length === 0) {
  failures.push(
    "no governed file reported the rule; the check compared nothing and would pass vacuously"
  );
}
for (const file of unclassified) {
  failures.push(`${file} reaches the filesystem with a computed path and is in neither class`);
}
for (const file of stale) {
  failures.push(`${file} is classified but no longer reports the rule; remove it`);
}

if (failures.length > 0) {
  console.error("\n  FAIL");
  for (const failure of failures) console.error(`    ${failure}`);
  console.error(
    "\n  Classify it in scripts/fs-path-scope.mjs: CALLER_INFLUENCED_FS_MODULES when a\n" +
      "  tool parameter can reach the path, GATEWAY_OWNED_FS_MODULES when only the\n" +
      "  operator or the gateway itself chooses it."
  );
  process.exit(1);
}
console.log("  OK: every module reaching the filesystem with a computed path is classified.");
