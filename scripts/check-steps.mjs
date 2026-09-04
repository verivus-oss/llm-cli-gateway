/**
 * The release gate, as DATA rather than as a shell chain.
 *
 * It was 22 steps joined by `&&` in a package.json string. That shape has one
 * failure mode and this repo hit it: `security:audit` sat at 21 of 22 and could
 * never pass on a developer tree, so `verify:no-internal-mcp:check` never ran at
 * all, and nothing said so. Fail-fast means ONE broken step can hide every step
 * after it, and a 1,200-character JSON string cannot carry a comment saying why
 * the order is what it is.
 *
 * Declared here so each step can say what it needs and what it costs:
 *
 *   needs   steps that must PASS first. A step whose dependency failed is
 *           reported SKIPPED, never passed: not running is not the same as
 *           being fine.
 *   heavy   runs alone. Measured on this host: two concurrent full suites turn
 *           an UNMUTATED tree red (3 to 4 failures), four turn it redder. The
 *           parallelism below is for the cheap single-process checks only.
 *   mutates what it writes, so a reader can see why it cannot run beside
 *           anything else.
 */

/** @typedef {{name: string, script: string, needs?: string[], heavy?: boolean, mutates?: string, why?: string}} Step */

/** @type {Step[]} */
export const STEPS = [
  // Everything that reads dist/ needs this, and `site:generate:check` reads
  // dist rather than src, so without the build it passes against stale output.
  { name: "build", script: "build", mutates: "dist/" },

  // Cheap, single-process, read-only. These are the ones worth running at once.
  { name: "lint", script: "lint" },
  { name: "fs:path:scope:check", script: "fs:path:scope:check" },
  { name: "format:check", script: "format:check" },
  { name: "provider:surfaces:check", script: "provider:surfaces:check" },
  { name: "storage:port:check", script: "storage:port:check" },
  { name: "session:tombstone:scope:check", script: "session:tombstone:scope:check" },
  { name: "transcript:schema:parity:check", script: "transcript:schema:parity:check" },
  { name: "promise:conditions:check", script: "promise:conditions:check" },
  { name: "capability:floor:check", script: "capability:floor:check" },
  { name: "seed:check", script: "seed:check" },
  { name: "dag:launch-surface:check", script: "dag:launch-surface:check" },
  { name: "plans:density:check", script: "plans:density:check" },
  { name: "plans:citations:check", script: "plans:citations:check" },
  // Offline contract check. Provider DRIFT against installed binaries is
  // `upstream:drift`, which this gate deliberately does not run.
  { name: "upstream:contracts", script: "upstream:contracts" },
  { name: "site:version:check", script: "site:version:check" },
  { name: "site:generate:check", script: "site:generate:check", needs: ["build"] },
  { name: "site:validate", script: "site:validate" },
  { name: "interface:floor:check", script: "interface:floor:check" },
  { name: "surface:invariance:check", script: "surface:invariance:check" },
  { name: "test:collection:check", script: "test:collection:check" },
  // Found by the coverage ratchet below: it existed and NOTHING ran it, not the
  // gate, not the audit, not CI. 72ms, offline, and it was already passing.
  { name: "supply-chain:baseline:check", script: "supply-chain:baseline:check" },

  {
    name: "test",
    script: "test",
    needs: ["build"],
    heavy: true,
    why: "the full vitest suite imports generated dist artifacts",
  },
  {
    name: "security:audit",
    script: "security:audit",
    needs: ["build"],
    heavy: true,
    mutates: "npm-shrinkwrap.json, and packs a tarball",
  },
  {
    name: "verify:no-internal-mcp:check",
    script: "verify:no-internal-mcp:check",
    needs: ["build"],
  },
];

/**
 * package.json scripts that look like gate candidates but are deliberately out.
 *
 * An EXCLUSION LIST rather than a hand-kept inclusion list, because the check in
 * check.test.mjs derives the candidate set from package.json: a new `*:check`
 * script is in the gate or it is named here with a reason, and adding one
 * without doing either fails. An inclusion list would just silently stay short.
 */
export const NOT_IN_GATE = {
  "pack:check":
    "the same scripts/verify-packed-dist.mjs that security:audit already runs, against the tarball it packs",
  "supply-chain:scan:check":
    "the same scripts/supply-chain/dep-drift-scan.mjs --frozen that security:audit already runs",
};
