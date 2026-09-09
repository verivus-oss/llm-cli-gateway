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
 * Empty as of 2026-09-09, and that is the anticipated end state, not a dropped
 * guard. This list held one entry: @hono/node-server, pinned to 2.0.11 by
 * package.json#overrides for GHSA-frvp-7c67-39w9 (serve-static path traversal on
 * Windows via encoded backslash, affected `< 2.0.5`, patched 2.0.5). While
 * @modelcontextprotocol/sdk declared @hono/node-server as `^1.19.9` alone, the
 * 2.0.11 pin sat outside that range and npm reported it `invalid` in every
 * consumer tree, so this gate asserted that reviewed `invalid` marker was
 * present (a security pin that silently stopped shipping is the failure it
 * catches).
 *
 * The SDK has since broadened its declaration to `^1.19.9 || ^2.0.5`. 2.0.11
 * satisfies that `^2.0.5` alternative, so npm now resolves it as VALID and emits
 * no downstream `invalid` marker; the tree goes clean for this dependency. That
 * is exactly the EXIT CONDITION the prior revision of this comment named (the
 * mechanism differed: the SDK widened its own range rather than the advisory
 * mirror being corrected), so there is no `invalid` marker for this list to
 * require. The override remains, pinning the exact reviewed and tested 2.0.11,
 * and the shipped shrinkwrap pins that into consumers.
 *
 * The SDK range does NOT guarantee safety on its own: the `^1.19.9` alternative
 * still admits vulnerable 1.19.x (< 1.19.15, GHSA-frvp), and `^2.0.5` admits
 * 2.0.5-2.0.9 (GHSA-9mqv, patched 2.0.10). What used to prove the pin reached
 * consumers was its `invalid` marker; with that marker gone, REVIEWED_CONSUMER_
 * VERSIONS below replaces it with a POSITIVE assertion that the consumer's
 * @hono/node-server actually is the reviewed patched pin, so a tree that
 * resolved it to a vulnerable version (or dropped it) is rejected rather than
 * read as clean. The tripwire also still fails on any UNEXPECTED `invalid`
 * marker, so a new unreviewed override cannot enter the shipped closure silently.
 */
export const EXPECTED_TREE_PROBLEMS = [];

/**
 * Packages whose exact resolved version this gate asserts in the consumer tree,
 * because their reviewed security pin no longer surfaces as an `invalid` marker.
 * @hono/node-server: pinned to 2.0.11 (GHSA-frvp fixed 2.0.5, GHSA-9mqv fixed
 * 2.0.10; 2.0.11 clears both). The SDK admits vulnerable 1.19.x and 2.0.5-2.0.9,
 * so "not flagged invalid" is not sufficient: require the reviewed version.
 */
export const REVIEWED_CONSUMER_VERSIONS = {
  "@hono/node-server": "2.0.11",
};

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
 * The published package whose consumer install this gate verifies. A tree that
 * does not contain it is degenerate or the wrong input. While
 * EXPECTED_TREE_PROBLEMS held the @hono/node-server pin, an empty or malformed
 * tree failed by having that pin `missing`; now that the list is empty, assert
 * the subject's presence explicitly so the gate still fails closed on `{}`,
 * `[]`, or any tree that is not actually this package's consumer install.
 */
export const SUBJECT_PACKAGE = "llm-cli-gateway";

/** True when the subject package appears anywhere in the dependency tree. */
export function treeContainsSubject(tree, subject = SUBJECT_PACKAGE) {
  let found = false;
  (function walk(node) {
    if (found || !node || typeof node !== "object") return;
    if (node.name === subject) {
      found = true;
      return;
    }
    for (const [name, dep] of Object.entries(node.dependencies ?? {})) {
      if (name === subject) {
        found = true;
        return;
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

  // Fail closed on a degenerate or wrong tree: if the package this gate exists to
  // verify is not present, there is nothing to have classified, so never pass.
  if (!treeContainsSubject(tree)) {
    otherProblems.push(
      `consumer tree does not contain ${SUBJECT_PACKAGE} (degenerate or wrong input)`
    );
  }

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

/** Collect every resolved version of `name` anywhere in the tree. */
export function collectPackageVersions(tree, name) {
  const versions = new Set();
  (function walk(node) {
    if (!node || typeof node !== "object") return;
    for (const [depName, dep] of Object.entries(node.dependencies ?? {})) {
      if (depName === name && dep && typeof dep.version === "string") versions.add(dep.version);
      walk(dep);
    }
  })(tree);
  return [...versions];
}

/**
 * Assert every REVIEWED_CONSUMER_VERSIONS package resolves to its reviewed pin
 * in the consumer tree. Returns operator-facing problem strings; empty is clean.
 * This is the positive replacement for the retired `invalid`-marker proof: it
 * rejects a pin that is absent, or that drifted to an unreviewed (and possibly
 * vulnerable) version, neither of which npm reports as `invalid` now that the
 * SDK range admits the 2.x line.
 *
 * @param {object} tree Parsed `npm ls --all --json` output.
 * @param {Record<string,string>} reviewed Package -> exact reviewed version.
 * @returns {string[]}
 */
export function reviewedVersionProblems(tree, reviewed = REVIEWED_CONSUMER_VERSIONS) {
  const problems = [];
  for (const [name, wanted] of Object.entries(reviewed)) {
    const versions = collectPackageVersions(tree, name);
    if (versions.length === 0) {
      problems.push(`${name} is absent: reviewed pin ${wanted} did not reach the consumer`);
      continue;
    }
    for (const v of versions.filter(found => found !== wanted)) {
      problems.push(
        `${name}@${v} is not the reviewed pin ${wanted}: the pin did not reach the consumer or drifted to an unreviewed version`
      );
    }
  }
  return problems;
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
  const versionProblems = reviewedVersionProblems(tree);
  const { errors, info } = formatConsumerTreeReport(result);
  for (const line of errors) console.error(line);
  if (versionProblems.length > 0) {
    console.error("Reviewed consumer pin did not reach the tree at its exact version:");
    for (const p of versionProblems) console.error(`  ${p}`);
  }
  const ok = result.ok && versionProblems.length === 0;
  if (ok) for (const line of info) console.log(line);
  if (ok) console.log(OK_MARKER);
  process.exit(ok ? 0 : 1);
}
