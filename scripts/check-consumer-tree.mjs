#!/usr/bin/env node
// Consumer dependency-tree tripwire for the registry-fidelity check.
//
// Why this is not a plain `npm ls` exit-0 check. `overrides` is a ROOT-ONLY
// field: npm applies ours when resolving, and the published shrinkwrap pins the
// result, but a consumer's npm re-validates the installed tree against each
// package's OWN declared ranges and knows nothing about why a version was
// chosen. A security override that lifts a transitive dependency past the range
// its parent declares therefore always reads as `invalid` downstream. That is a
// reporting artifact of the override mechanism, not tree corruption: the pinned
// version is exactly what we published and what the suite tests against.
//
// So this is a bidirectional tripwire rather than a tolerance, in the same
// discipline as the hono floor in release-security-audit.sh and
// REQUIRED_SOCKET_POLICY in dep-drift-scan.mjs. Every EXPECTED entry must be
// present (its absence means a security pin silently stopped shipping to
// consumers) and nothing outside the list may appear.
//
// Usage: node scripts/check-consumer-tree.mjs <npm-ls-json-file>
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Reviewed, expected-and-required consumer-tree problems.
 *
 * @hono/node-server: package.json#overrides pins 2.0.11 while
 * @modelcontextprotocol/sdk declares ^1.19.9. GHSA-frvp-7c67-39w9 (serve-static
 * path traversal on Windows via encoded backslash) declares `< 2.0.5` affected
 * in the GitHub Advisory Database that `npm audit` consumes, so no version
 * inside the SDK's declared major clears `npm audit --audit-level=moderate`,
 * and the override is the only way to ship a version that scanner accepts.
 *
 * Upstream (honojs/node-server GHSA-frvp-7c67-39w9) actually lists TWO patched
 * versions, 2.0.5 and 1.19.15; the GitHub Advisory Database mirror collapsed
 * that to `< 2.0.5` and dropped the 1.19.15 pair. 1.19.15 does carry the fix
 * (guard regex identical to 2.0.5/2.0.11). EXIT CONDITION: once the mirror is
 * corrected, both this override and this entry can be deleted, because npm
 * resolves ^1.19.9 to a patched 1.19.x by itself and the tree goes clean.
 */
export const EXPECTED_TREE_PROBLEMS = [
  {
    name: "@hono/node-server",
    version: "2.0.11",
    range: "^1.19.9",
    requiredBy: "@modelcontextprotocol/sdk",
    reason: "GHSA-frvp-7c67-39w9 security pin; see package.json#overrides",
  },
];

/**
 * Split npm's `invalid` string into the range and the package that demanded it.
 *
 * npm writes `"<range>" from <path-to-requiring-package>`, and that path is
 * position-dependent: in OUR repo the SDK sits at `node_modules/@modelcontext.../sdk`,
 * but a real consumer nests us, so it reads
 * `node_modules/llm-cli-gateway/node_modules/@modelcontextprotocol/sdk`.
 * Matching the raw string therefore breaks purely because of where a consumer
 * happens to place the package, which is not a fact worth gating a release on.
 * The load-bearing facts are WHICH package demanded WHICH range, so key on
 * those and let nesting depth vary.
 *
 * @param {string} invalid npm's `invalid` field.
 * @returns {{range: string, requiredBy: string}}
 */
export function parseInvalid(invalid) {
  const match = /^"([^"]*)"\s+from\s+(.+)$/.exec(invalid ?? "");
  if (!match) return { range: invalid ?? "", requiredBy: "" };
  const [, range, from] = match;
  // Last node_modules segment is the requiring package (scope included).
  const requiredBy = from.includes("node_modules/")
    ? from.slice(from.lastIndexOf("node_modules/") + "node_modules/".length)
    : from;
  return { range, requiredBy: requiredBy.replace(/\/+$/, "") };
}

const problemKey = entry => {
  const { range, requiredBy } = entry.range
    ? { range: entry.range, requiredBy: entry.requiredBy }
    : parseInvalid(entry.invalid);
  return `${entry.name}@${entry.version} needs-to-satisfy ${range} from ${requiredBy}`;
};

/**
 * Walk an `npm ls --all --json` tree and collect every node npm flagged as
 * out-of-range against its parent's declared dependency range.
 *
 * @param {object} tree Parsed `npm ls --all --json` output.
 * @returns {Array<{name: string, version: string, invalid: string}>}
 */
export function collectInvalidNodes(tree) {
  const found = [];
  const seen = new Set();
  (function walk(node) {
    if (!node || typeof node !== "object") return;
    for (const [name, dep] of Object.entries(node.dependencies ?? {})) {
      if (dep && typeof dep.invalid === "string") {
        const entry = { name, version: dep.version ?? "<none>", invalid: dep.invalid };
        const key = problemKey(entry);
        if (!seen.has(key)) {
          seen.add(key);
          found.push(entry);
        }
      }
      walk(dep);
    }
  })(tree);
  return found;
}

/**
 * Classify a consumer tree against the reviewed expectations.
 *
 * @param {object} tree Parsed `npm ls --all --json` output.
 * @param {Array<object>} expected Reviewed problem list.
 * @returns {{ok: boolean, found: Array, unexpected: Array, missing: Array, otherProblems: string[]}}
 */
export function classifyConsumerTree(tree, expected = EXPECTED_TREE_PROBLEMS) {
  const found = collectInvalidNodes(tree);

  // Any non-`invalid:` problem (missing, extraneous, peer conflict) is a real
  // tree defect and is never tolerated. `npm ls` renders an uninstalled
  // optional dependency as UNMET OPTIONAL DEPENDENCY in its tree output but
  // does not add it here, so an absent optional peer (pg) never reaches this.
  const otherProblems = (tree.problems ?? []).filter(p => !p.startsWith("invalid:"));

  const expectedKeys = new Set(expected.map(problemKey));
  const foundKeys = new Set(found.map(problemKey));

  const unexpected = found.filter(e => !expectedKeys.has(problemKey(e)));
  const missing = expected.filter(e => !foundKeys.has(problemKey(e)));

  return {
    ok: unexpected.length === 0 && missing.length === 0 && otherProblems.length === 0,
    found,
    unexpected,
    missing,
    otherProblems,
  };
}

/**
 * Render a classification as operator-facing lines.
 *
 * @param {ReturnType<typeof classifyConsumerTree>} result
 * @returns {{errors: string[], info: string[]}}
 */
export function formatConsumerTreeReport(result) {
  const errors = [];
  const info = [];

  if (result.otherProblems.length > 0) {
    errors.push("Consumer tree has non-invalid problems (missing/extraneous deps):");
    for (const p of result.otherProblems) errors.push(`  ${p}`);
  }
  if (result.unexpected.length > 0) {
    errors.push("Consumer tree has UNREVIEWED out-of-range packages:");
    for (const e of result.unexpected) {
      errors.push(`  ${e.name}@${e.version} does not satisfy ${e.invalid}`);
    }
    errors.push(
      "Each needs a deliberate review; add it to EXPECTED_TREE_PROBLEMS only with its justification."
    );
  }
  if (result.missing.length > 0) {
    errors.push("Reviewed security pin is NO LONGER reaching consumers:");
    for (const e of result.missing) {
      errors.push(
        `  expected ${e.name}@${e.version} pinned over "${e.range}" from ${e.requiredBy} (${e.reason})`
      );
    }
    errors.push(
      "Either the override was dropped or its version moved: re-check the advisory before editing the list."
    );
  }

  if (result.ok) {
    for (const e of result.found) {
      info.push(`    reviewed pin present: ${e.name}@${e.version} over ${e.invalid}`);
    }
    info.push(
      `    no unreviewed tree problems (${result.found.length} invalid, ${result.otherProblems.length} other).`
    );
  }

  return { errors, info };
}

/**
 * Emitted on stdout only after a tree has actually been classified and passed.
 * scripts/verify-registry-install.sh requires this marker rather than trusting
 * exit 0, so that ANY future way of skipping the body (see isDirectInvocation)
 * still fails the release instead of reading as success.
 */
export const OK_MARKER = "CONSUMER_TREE_CHECK_OK";

/**
 * True when this module is the process entry point rather than an import.
 *
 * Both sides are canonicalized with realpathSync before comparing. Two separate
 * fail-OPEN bugs have already been found in this one guard, and both were a
 * comparison of two spellings of the same file:
 *
 *   1. `file://${argv1}` vs `import.meta.url` differed on any URL-escaped
 *      character, so a path containing a space skipped the body entirely.
 *   2. `pathToFileURL(argv1)` preserves symlinks while Node canonicalizes
 *      `import.meta.url`, so invoking through a symlink (or /proc/self/cwd, or
 *      a repo checked out under a symlinked path, which bash's logical `pwd`
 *      in ROOT_DIR happily produces) skipped the body entirely.
 *
 * Both exited 0 having verified nothing. realpathSync resolves every spelling
 * to one physical path, which is why the comparison is made there and not on
 * URLs. The OK_MARKER contract above is the backstop if this is ever wrong
 * again.
 *
 * @param {string} metaUrl `import.meta.url` of the entry module.
 * @param {string|undefined} argv1 `process.argv[1]`.
 * @returns {boolean}
 */
export function isDirectInvocation(metaUrl, argv1) {
  if (!argv1) return false;
  try {
    return fs.realpathSync(fileURLToPath(metaUrl)) === fs.realpathSync(argv1);
  } catch {
    return false;
  }
}

// CLI entry: only when executed directly, so the test can import the pure parts.
if (isDirectInvocation(import.meta.url, process.argv[1])) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node scripts/check-consumer-tree.mjs <npm-ls-json-file>");
    process.exit(2);
  }
  const tree = JSON.parse(fs.readFileSync(file, "utf8"));
  const result = classifyConsumerTree(tree);
  const { errors, info } = formatConsumerTreeReport(result);
  for (const line of errors) console.error(line);
  for (const line of info) console.log(line);
  if (result.ok) console.log(OK_MARKER);
  process.exit(result.ok ? 0 : 1);
}
