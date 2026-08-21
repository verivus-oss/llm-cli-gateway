#!/usr/bin/env node
/**
 * provider:surfaces:check is the DRY ratchet for the provider registry.
 *
 * Scans src/ (TypeScript) and the repository's .sql files, and FAILS on
 * forbidden hand-maintained provider surfaces:
 *
 *   (1) literal provider-name arrays  (shared_provider_registry_design
 *       .forbidden_patterns.literal_provider_arrays), i.e. an array literal that
 *       spells out claude, codex, gemini, grok, mistral (optionally devin,
 *       cursor) instead of deriving from CLI_TYPES / the registry.
 *   (2) manual per-provider resource dispatch blocks of the form
 *       `uri === "sessions://<name>"` or `uri === "models://<name>"`.
 *   (3) hand-spelled literal resource URIs, i.e. a double-quoted
 *       `"sessions://<name>"` / `"models://<name>"` string (the
 *       `server.registerResource(...)` form). These must be built from a
 *       provider id via the surface generator, never spelled out per provider.
 *   (4) hand-written Personal Agent Config Kit request-TOOL lists, e.g.
 *       "use claude_request or codex_request". Derive from
 *       `describeKitRequestTools()` instead.
 *   (5) two-way provider-label ternaries, e.g.
 *       `provider === "claude" ? "Claude" : "Codex"`, which mislabel every
 *       provider outside the pair. Use `getKitProviderLabel()` instead.
 *   (7) enumerated provider lists in SQL, e.g. a
 *       `CHECK (cli IN ('claude', 'codex', ...))` constraint in a migration.
 *
 * (7) exists because the scan used to stop at `.ts` and therefore could not see
 * a `.sql` file at all. Four hand-written provider lists sat in `migrations/`
 * through two provider admissions, wrong in BOTH directions: missing `devin`
 * and `cursor`, and carrying `grok-api`, which is an API provider id and not a
 * CliType. The gate built to forbid hand-maintained provider lists had a blind
 * spot exactly where four of them lived.
 *
 * (4) and (5) exist because the Kit provider set grew from two to three and the
 * stale two-provider forms survived in `index.ts`, reachable by no test: those
 * messages are redacted by `safePersonalKitErrorMessage` before any caller can
 * observe them, so a static gate is the only thing that can catch them.
 *
 * ALWAYS_ALLOWLIST names the sanctioned places these tokens may appear: the
 * enum source, the registry, the surface generator, generated snapshots, and
 * anything under __tests__.
 *
 * LEGACY_ALLOWLIST names files that still contain a pre-registry surface that a
 * LATER phase migrates. Each entry is tagged with the phase that removes it and
 * the specific pattern kind it is allowed to contain, so a NEW violation of a
 * different kind (or in a different file) still fails. When a later phase
 * migrates a file, delete its LEGACY_ALLOWLIST entry.
 *
 * The check PASSES on the current tree, FAILS on any new violation, and is
 * wired into `npm run check`. No em dash (U+2014) anywhere.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const srcRoot = join(repoRoot, "src");

const PROVIDER_NAME = "claude|codex|gemini|grok|mistral|devin|cursor";

/** Pattern (1): a literal provider-name array spelling out the CLI providers. */
const LITERAL_PROVIDER_ARRAY = /"claude"\s*,\s*"codex"\s*,\s*"gemini"\s*,\s*"grok"\s*,\s*"mistral"/;

/** Pattern (2): a manual `uri === "sessions://<name>"` / `models://<name>`. */
const MANUAL_RESOURCE_BLOCK = new RegExp(
  `uri\\s*===\\s*"(?:sessions|models)://(?:${PROVIDER_NAME})"`
);

/**
 * Pattern (3): a hand-spelled double-quoted literal resource URI, e.g.
 * `"sessions://claude"` / `"models://grok"` (the registerResource form). The
 * closing double quote must immediately follow the provider name, so it never
 * matches `"sessions://all"`, a template string `` `sessions://${...}` ``, or
 * any other scheme/name.
 */
const LITERAL_RESOURCE_URI = new RegExp(`"(?:sessions|models)://(?:${PROVIDER_NAME})"`);

/**
 * Pattern (4): a hand-written Kit REQUEST-TOOL list, e.g.
 * "use claude_request or codex_request". Kit provider support is declared once
 * in provider-definitions.ts; any message that redirects a caller to the Kit
 * surface must derive its tool list from `describeKitRequestTools()`, or it goes
 * stale the moment a provider is admitted. This is not hypothetical: the
 * claude/codex-only forms of exactly these two strings survived the mistral Kit
 * admission and were caught only by cross-LLM review, because the messages are
 * redacted before any caller (and therefore any test) can observe them.
 *
 * Separator-independent by construction: an earlier draft keyed on the word
 * "or" and was trivially evaded by "and", by a comma list, and by a slash (I
 * verified all three evasions before settling on this form). The signal is
 * instead TWO DIFFERENT provider prefixes on one line. A same-provider pair
 * ("claude_request" + "claude_request_async") is that provider's own tool
 * surface and is legitimate; a cross-provider pair is a hand-written roster.
 */
const REQUEST_TOOL_TOKEN = new RegExp(`\\b(${PROVIDER_NAME})_request(?:_async)?\\b`, "g");

/**
 * Window size for the roster scan. A single-line scan was defeated by splitting
 * the roster across array elements joined at runtime (cross-LLM review):
 *
 *   const list = [
 *     "In Kit mode, use claude_request",
 *     "or codex_request.",
 *   ].join(" ");
 *
 * Three lines covers that shape. Verified to add ZERO false positives on the
 * current tree: no legitimate site mentions two different providers' request
 * tools within three lines of each other.
 */
const ROSTER_WINDOW_LINES = 3;

function findCrossProviderToolList(content) {
  const hits = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const providers = new Set();
    for (const line of lines.slice(i, i + ROSTER_WINDOW_LINES)) {
      for (const m of line.matchAll(REQUEST_TOOL_TOKEN)) providers.add(m[1]);
    }
    if (providers.size >= 2) {
      hits.push({ snippet: lines[i].trim().slice(0, 120), line: i + 1 });
      // Skip past this window so one roster is reported once, not N times.
      i += ROSTER_WINDOW_LINES - 1;
    }
  }
  return hits;
}

/** Every match of a plain regex, with 1-based line numbers. */
function findAllRegex(content, regex) {
  const hits = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(regex);
    if (m) hits.push({ snippet: m[0].slice(0, 120), line: i + 1 });
  }
  return hits;
}

/**
 * Pattern (5): a two-way provider ternary that yields a provider LABEL, e.g.
 * `provider === "claude" ? "Claude" : "Codex"`. This silently mislabels every
 * provider outside the pair. Use `getKitProviderLabel(provider)`.
 *
 * Deliberately loose about orthography, because cross-LLM review defeated a
 * stricter first draft three ways: a single-quoted ternary, a different
 * left-hand side (`cli === ...`), and a NEGATED comparison
 * (`provider !== "claude" ? "Codex" : "Claude"`, which has the same bug with
 * the arms swapped), then a fourth: a PARENTHESISED condition,
 * `(provider === "claude") ? "Claude" : "Codex"`, which is ordinary TS style
 * and appears in this tree; and a fifth, a BACKTICK-quoted provider name,
 * `` provider === `claude` ? "Claude" : "Codex" ``. So: optional grouping
 * parens, any identifier, either equality operator, and all three quote styles.
 * The `[A-Z]` guard on both arms keeps it to LABELS, so an ordinary value
 * ternary (`provider === "claude" ? "stream-json" : "json"`) is untouched.
 */
const QUOTE = "['\"`]";
const PROVIDER_LABEL_TERNARY = new RegExp(
  `\\(?\\s*\\w+\\s*[!=]==\\s*(${QUOTE})(?:${PROVIDER_NAME})\\1\\s*\\)?\\s*\\?\\s*(${QUOTE})[A-Z]\\w*\\2\\s*:\\s*(${QUOTE})[A-Z]\\w*\\3`
);

/**
 * A pattern is either a `regex` or a `find(content)` returning a match-like
 * `{ 0: snippet, index }`, for signals a single regex cannot express (pattern 4
 * needs to compare provider prefixes across one line).
 */
/**
 * Pattern 6: a pipe-separated provider run inside PROSE, e.g. a `.describe()`
 * string reading "Provider type (claude|codex|gemini|grok|mistral)".
 *
 * Added after four such strings shipped to site/tools.fixture.json listing six
 * providers while the Zod enum in the SAME schema object accepted eight. The
 * array patterns above could not see it: the names were not a quoted array, they
 * were words in a sentence. Prose is a provider surface too, because it is
 * published to the website and shown to every MCP client.
 *
 * Three or more piped provider names is the signal; two could be a legitimate
 * either/or in a sentence about a specific pair.
 */
const PIPED_PROVIDER_PROSE = new RegExp(
  `(?:${PROVIDER_NAME})(?:\\s*\\|\\s*(?:${PROVIDER_NAME}|grok-api|[a-z]+-api)){2,}`
);

/**
 * Pattern (7): an enumerated provider list in SQL, single-quoted because that
 * is SQL's string literal. Three or more names in a comma-separated run, the
 * same threshold pattern (6) uses and for the same reason: two can be a
 * legitimate pair, three is a roster.
 *
 * `grok-api` is included in the alternation deliberately. The lists this
 * catches carry it, and a detector that could not see the wrong name would miss
 * half of what makes them wrong.
 */
const SQL_ENUMERATED_PROVIDER_LIST = new RegExp(
  `'(?:${PROVIDER_NAME}|grok-api)'(?:\\s*,\\s*'(?:${PROVIDER_NAME}|grok-api)'){2,}`
);

export function findSqlEnumeratedProviderLists(content) {
  return findAllRegex(content, SQL_ENUMERATED_PROVIDER_LIST);
}

const SQL_PATTERNS = [
  { kind: "sql-enumerated-provider-list", regex: SQL_ENUMERATED_PROVIDER_LIST },
  { kind: "piped-provider-prose", regex: PIPED_PROVIDER_PROSE },
];

/**
 * SQL provider lists that are FROZEN rather than fixed, with the exact number
 * of occurrences each file is allowed to contain.
 *
 * These cannot be corrected in place and cannot be generated from CLI_TYPES,
 * and the reason is mechanical rather than a preference. Every migration file's
 * SHA-256 is recorded in `POSTGRES_IMMUTABLE_MIGRATION_SHA256` and re-verified
 * against every database that already applied it (`assertRecordedMigrationChecksum`
 * in src/migrate.ts refuses to run migrations on a checksum mismatch), so
 * editing one byte of an applied migration bricks migration for every existing
 * installation. A file generated from CLI_TYPES would change its checksum
 * whenever a provider is admitted, which is the same failure on a timer.
 *
 * They also do not need correcting. Migration 005 DROPS both enumerated
 * constraints and replaces them with a format guard, because API provider ids
 * are arbitrary and a closed enum was the wrong shape; 006 uses that guard from
 * the start. What keeps the head state honest is therefore not this text, it is
 * the pair of tests in src/__tests__/migration-pg.test.ts ("session provider
 * domain"), which apply the real migrations to a real database and assert that
 * every PROVIDER_TYPES value is admitted, and show the pre-005 schema rejecting
 * the ones 001 never listed. Admitting an eighth provider extends that
 * assertion by itself, with no list to retype.
 *
 * Pinned in BOTH directions. A fifth occurrence in one of these files fails,
 * and so does a disappearing one, which would mean a published migration had
 * been edited.
 */
const FROZEN_SQL_PROVIDER_LISTS = {
  "migrations/001_initial_schema.sql": 2,
  "migrations/003_provider_type_sessions.sql": 2,
  // The one in 005 is the comment recording the set that 005 removes.
  "migrations/005_provider_type_open_api_names.sql": 1,
};

// ---------------------------------------------------------------------------
// CENSUS RATCHET: hand-authored provider data.
//
// The other patterns in this file are per-file regexes. This one cannot be,
// because a new hand-authored table would live in the SAME file as the
// grandfathered one (src/provider-codegen.ts), so a file allowlist would admit
// it. What is being ratcheted is the SET of hand-authored artefacts, repo-wide.
//
// WHY THIS EXISTS, which is the part that matters:
//
//   When an existing mechanism and a stated principle disagree, the mechanism
//   wins, because a mechanism tells you what to type next and a principle does
//   not. `pass-through` was documented when the rebaseliner's red test said
//   "delete the parameter", and the red test won: capability was removed from
//   customers three times. The pass-through POLICY had just been written when a
//   half-finished migration in the tree (grok on a generation table, six
//   providers not) said "complete this pattern", and the pattern won: a
//   CURSOR_FLAG_GENERATION table was written with a green parity gate before
//   the contradiction surfaced.
//
//   The rule has now been written twice and lost twice. So it stops being prose
//   and becomes a mechanism: authoring one of these fails the build, and the
//   failure says what to do instead.
//
// The set must be updated in BOTH directions. An addition is the defect this
// guards. A deletion must also update the set, or the removed name stays
// grandfathered and re-adding it later passes silently.
// ---------------------------------------------------------------------------

const HAND_AUTHORED_PROVIDER_DATA = [
  {
    kind: "hand-authored-provider-facts",
    find: findHandAuthoredProviderFacts,
    grandfathered: new Set(),
    guidance:
      "A binding row said what the BINARY accepts. Its `values` or `arity` is a fact about the customer's installed CLI, and typing one here pins it to the author's machine. Bindings name GATEWAY data only: the request parameter, the emit rule, the description. Facts come from the resolved surface (src/provider-surface.ts), which deriveZodShapeFromGeneration already reads. See docs/plans/typed-parameter-derivation.dag.toml (t1).",
  },
  {
    kind: "provider-argv-builder",
    regex: /export function (prepare[A-Z][A-Za-z]*Request)\b/g,
    grandfathered: new Set([
      // The seven CLI argv builders, ~1400 lines, all deleted by n3.
      "prepareClaudeRequest",
      "prepareCodexRequest",
      "prepareGeminiRequest",
      "prepareGrokRequest",
      "prepareMistralRequest",
      "prepareDevinRequest",
      "prepareCursorRequest",
      // Not CLI argv builders. Kept in the census anyway so the set is an exact
      // inventory rather than a judgement call at each edit.
      "prepareApiRequest",
      "prepareCodexForkRequest",
    ]),
    guidance:
      "A per-provider argv function can only emit what a human typed at build time. Route argv through the generic builder fed by discovery. See docs/plans/gateway-passthrough-policy.dag.toml (n3).",
  },
];

/**
 * Binding rows that state a fact about the BINARY rather than about us.
 *
 * The rule this replaces forbade any `*_FLAG_GENERATION` const BY NAME. That was
 * aimed slightly wrong: a binding row cannot carry a value set in the first
 * place (`FlagGenerationMeta` has no `values` field, and provider-codegen.ts
 * says the enum is read from the contract and never duplicated), and since d4c
 * that read goes through the resolved surface. So the old gate forbade a SHAPE
 * that was already incapable of the SIN, and the only way to convert a second
 * provider looked like defeating the gate. Two people tried, one day apart.
 *
 * What must stay forbidden is the sin itself: a row that declares what the
 * customer's CLI accepts. Detected by locating each `flag: "..."` and scanning
 * its own object literal, so a `values` on an unrelated object is not a hit.
 */
export function findHandAuthoredProviderFacts(content) {
  const hits = [];
  for (const match of content.matchAll(/\bflag:\s*"(-{1,2}[^"]+)"/g)) {
    const open = content.lastIndexOf("{", match.index);
    if (open === -1) continue;
    let depth = 0;
    let close = open;
    for (let i = open; i < content.length; i++) {
      if (content[i] === "{") depth++;
      else if (content[i] === "}") {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    const row = content.slice(open, close + 1);
    // A KEY POSITION, not the word and not merely a line start. The first
    // version matched "Known values:" inside a description string, which is
    // prose telling a caller what the binary publishes and is what the policy
    // asks a description to do. The second required a line start and so missed
    // an inline `{ flag: "--x", values: [...] }` on one line. A key follows `{`
    // or `,`; prose follows a word.
    for (const fact of ["values", "arity"]) {
      if (new RegExp(`(^|[{,])\\s*${fact}:`, "m").test(row))
        hits.push(`${match[1]} declares ${fact}`);
    }
  }
  return hits;
}

function censusHandAuthoredProviderData(files) {
  const problems = [];
  for (const entry of HAND_AUTHORED_PROVIDER_DATA) {
    const found = new Map();
    for (const { relPath, content } of files) {
      if (relPath.includes("__tests__")) continue;
      if (entry.find) {
        for (const name of entry.find(content)) found.set(name, relPath);
      } else {
        for (const m of content.matchAll(entry.regex)) found.set(m[1], relPath);
      }
    }
    for (const [name, relPath] of found) {
      if (!entry.grandfathered.has(name)) {
        problems.push({
          kind: entry.kind,
          direction: "added",
          name,
          relPath,
          guidance: entry.guidance,
        });
      }
    }
    for (const name of entry.grandfathered) {
      if (!found.has(name)) {
        problems.push({
          kind: entry.kind,
          direction: "removed",
          name,
          relPath: "(gone)",
          guidance:
            "Deleted, which is the goal. Remove it from `grandfathered` in this script so the ratchet tightens; leaving it there would let the name be re-added later without failing.",
        });
      }
    }
  }
  return problems;
}

const PATTERNS = [
  { kind: "literal-provider-array", regex: LITERAL_PROVIDER_ARRAY },
  { kind: "piped-provider-prose", regex: PIPED_PROVIDER_PROSE },
  { kind: "manual-resource-block", regex: MANUAL_RESOURCE_BLOCK },
  { kind: "literal-resource-uri", regex: LITERAL_RESOURCE_URI },
  { kind: "cross-provider-tool-list", find: findCrossProviderToolList },
  { kind: "provider-label-ternary", regex: PROVIDER_LABEL_TERNARY },
];

/**
 * Files where these tokens are sanctioned (the source of truth itself, plus
 * tests and generated snapshots). Paths are repo-relative and posix-style.
 */
const ALWAYS_ALLOWLIST = new Set([
  "src/provider-definitions.ts",
  "src/provider-types.ts",
  "src/provider-surface-generator.ts",
]);

/**
 * Not-yet-migrated surfaces. Each file lists the pattern kind(s) it is allowed
 * to still contain and the phase that drains it.
 */
const LEGACY_ALLOWLIST = {
  // Phase 4 Part A drained the last spelled-out provider array from index.ts:
  // the approval_list `cli` filter now derives from CLI_TYPE_ENUM (z.enum(CLI_TYPES)),
  // so index.ts no longer needs a literal-provider-array allowance.
};

function isAlwaysAllowed(relPath) {
  if (ALWAYS_ALLOWLIST.has(relPath)) return true;
  if (relPath.includes("__tests__")) return true;
  if (relPath.endsWith(".snap")) return true;
  return false;
}

function walk(dir, extension = ".ts", ignored = new Set()) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (ignored.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full, extension, ignored));
    } else if (entry.endsWith(extension)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Directories with no authored SQL in them. `dist` and `installer/dist` are
 * build output, the rest are caches and dependencies. Skipping them is what
 * makes a whole-repository walk for `.sql` cheap enough to run in the gate.
 */
const SQL_SCAN_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".sqry",
  ".sqry-cache",
  ".worktrees",
  "coverage",
  "dist",
  "node_modules",
]);

/**
 * A fixture root for the gate's own tests, which need to add a NEW violating
 * file rather than remove an existing one (the ADD-form negative control the
 * design's section 3.5 requires). Scanning a temporary directory keeps that
 * test from writing into the repository it is checking.
 *
 * In fixture mode the TypeScript scan and the hand-authored census are skipped:
 * both are calibrated against the real tree, so running them against a fixture
 * would report the whole grandfathered set as missing.
 */
const sqlFixtureArg = process.argv.find(arg => arg.startsWith("--sql-fixture="));
const sqlFixtureRoot = sqlFixtureArg ? resolve(sqlFixtureArg.slice("--sql-fixture=".length)) : null;

const newViolations = [];
const legacyHits = [];
// Every scanned file, for the repo-wide census below. Collected BEFORE the
// per-file allowlist skip, because a hand-authored generation table living in an
// always-allowed file must still be counted.
const scannedFiles = [];

/**
 * Frozen-file occurrence counts actually seen, for the both-directions check.
 *
 * Exported because a gate that scanned nothing also exits 0, and this is what a
 * test can read to prove the .sql walk reached the migrations at all.
 */
export const frozenSqlCounts = new Map();

const sqlScanRoot = sqlFixtureRoot ?? repoRoot;
for (const absPath of walk(sqlScanRoot, ".sql", SQL_SCAN_IGNORED_DIRECTORIES)) {
  const relPath = relative(sqlScanRoot, absPath).split("\\").join("/");
  const content = readFileSync(absPath, "utf8");
  const frozenLimit = sqlFixtureRoot ? undefined : FROZEN_SQL_PROVIDER_LISTS[relPath];

  for (const { kind, regex } of SQL_PATTERNS) {
    const hits = findAllRegex(content, regex);
    if (kind === "sql-enumerated-provider-list" && frozenLimit !== undefined) {
      frozenSqlCounts.set(relPath, hits.length);
      continue;
    }
    for (const hit of hits) {
      newViolations.push({ relPath, kind, line: hit.line, snippet: hit.snippet });
    }
  }
}

for (const absPath of sqlFixtureRoot ? [] : walk(srcRoot)) {
  const relPath = relative(repoRoot, absPath).split("\\").join("/");
  scannedFiles.push({ relPath, content: readFileSync(absPath, "utf8") });
  if (isAlwaysAllowed(relPath)) continue;

  const content = readFileSync(absPath, "utf8");
  const legacy = LEGACY_ALLOWLIST[relPath];

  for (const { kind, regex, find } of PATTERNS) {
    // Report EVERY hit, not just the first. Two sibling violations in one file
    // (e.g. the sync and async LCR guards) must both be named, or fixing the
    // reported one makes the check look clean while the other survives.
    const hits = find ? find(content) : findAllRegex(content, regex);
    for (const hit of hits) {
      const record = { relPath, kind, line: hit.line, snippet: hit.snippet };
      if (legacy && legacy.allowedKinds.includes(kind)) {
        legacyHits.push({ ...record, phase: legacy.phase });
      } else {
        newViolations.push(record);
      }
    }
  }
}

function log(msg) {
  process.stderr.write(`${msg}\n`);
}

log("provider:surfaces:check");
log(
  `  scanned: ${sqlFixtureRoot ? `${sqlFixtureRoot} (.sql fixture only)` : `${srcRoot}, ${sqlScanRoot}/**/*.sql`}`
);

/**
 * The frozen SQL lists, checked in both directions.
 *
 * "Missing" is not a pass. A frozen file whose count fell is a published
 * migration that has been edited, which breaks the checksum every database that
 * applied it verifies against.
 */
export function compareFrozenSqlCounts(actualCounts) {
  const problems = [];
  for (const [relPath, expected] of Object.entries(FROZEN_SQL_PROVIDER_LISTS)) {
    const actual = actualCounts.get(relPath);
    if (actual === expected) continue;
    problems.push(
      actual === undefined
        ? `${relPath}: file not found, or it no longer contains the ${expected} frozen list(s)`
        : `${relPath}: ${actual} enumerated provider list(s), expected exactly ${expected}`
    );
  }
  return problems;
}

function frozenSqlProblems() {
  return sqlFixtureRoot ? [] : compareFrozenSqlCounts(frozenSqlCounts);
}

if (legacyHits.length > 0) {
  log("");
  log("  known legacy surfaces (allowlisted, drained by a later phase):");
  for (const hit of legacyHits) {
    log(`    ${hit.relPath}:${hit.line} [${hit.kind}] drained by ${hit.phase}`);
  }
}

// Importing this file must not run the check: the test suite imports the
// detector, and a top-level process.exit takes the runner down with it. The
// same defect was fixed in generate-provider-seed.mjs earlier the same day.
function main() {
  const frozenProblems = frozenSqlProblems();
  if (frozenProblems.length > 0) {
    log("");
    log("  FAIL: a frozen SQL provider list changed:");
    for (const problem of frozenProblems) log(`    ${problem}`);
    log("");
    log("  These lists are frozen because every migration's SHA-256 is verified");
    log("  against databases that already applied it. If a migration file was");
    log("  edited, revert it and write a NEW migration; if one was added or");
    log("  removed, update FROZEN_SQL_PROVIDER_LISTS in this script.");
    process.exit(1);
  }

  // Skipped in fixture mode: the census is a repo-wide SET, so an empty scan
  // reports every grandfathered name as deleted and the gate would exit 1 for a
  // reason that has nothing to do with what the fixture is testing.
  const censusProblems = sqlFixtureRoot ? [] : censusHandAuthoredProviderData(scannedFiles);
  if (censusProblems.length > 0) {
    log("");
    log("  FAIL: hand-authored provider data (the flag set belongs to the customer's binary):");
    for (const c of censusProblems) {
      const verb = c.direction === "added" ? "NEW" : "GONE (update the set)";
      log(`    ${verb} [${c.kind}] ${c.name}  ${c.relPath}`);
      log(`      ${c.guidance}`);
    }
    log("");
    log("  A hand-authored list of a provider's flags is wrong on any machine that");
    log("  differs from the author's, which is every customer machine. Discovery");
    log("  produces this data; the generic builder consumes it.");
    process.exit(1);
  }

  if (newViolations.length > 0) {
    log("");
    log("  FAIL: new provider-surface violations (add to the registry, not here):");
    for (const v of newViolations) {
      log(`    ${v.relPath}:${v.line} [${v.kind}] ${v.snippet}`);
    }
    log("");
    log("  Every provider surface must derive from src/provider-definitions.ts");
    log("  (or a projection in src/provider-surface-generator.ts). If this is a");
    log("  not-yet-migrated legacy surface, add it to LEGACY_ALLOWLIST with the");
    log("  phase that removes it.");
    if (newViolations.some(v => v.kind === "sql-enumerated-provider-list")) {
      log("");
      log("  A migration cannot import CLI_TYPES, so a provider enum written into");
      log("  SQL goes stale the moment a provider is admitted and cannot be edited");
      log("  afterwards. Constrain the FORMAT of the identifier instead, as");
      log("  migration 005 does, and assert the domain in a test derived from the");
      log('  enum (src/__tests__/migration-pg.test.ts, "session provider domain").');
    }
    process.exit(1);
  }

  log("");
  log("  OK: no new hand-maintained provider surfaces.");
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
