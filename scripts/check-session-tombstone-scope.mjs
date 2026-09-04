#!/usr/bin/env node
/**
 * Every PostgreSQL statement that reads or mutates a session ROW must exclude
 * worktree-cleanup tombstones.
 *
 * A tombstone is a DELETED session whose row survives only so the host owning
 * its git worktree can retry the filesystem removal. The file store enforces
 * that with a predicate at each read; the PostgreSQL store enforces it by
 * splicing `sessionNotTombstonedSql()` into the statement. Miss one statement
 * and a deleted session becomes gettable, listable or resumable again, which
 * is a worse defect than the gap the tombstone closes.
 *
 * The governed set is DERIVED from the file rather than listed here: every
 * string literal naming the `sessions` table is in scope. Two kinds leave it.
 * A statement whose only reference is `INSERT INTO sessions` creates a row and
 * cannot select a tombstone, so it is exempt by shape, computed not declared.
 * Anything else needs a `tombstone-scope: exempt` marker in the comment
 * directly above it, which puts the reason at the site instead of in a list
 * that drifts away from the code it governs.
 *
 * The exempt COUNT is asserted by this script's test. An exemption is a
 * deliberate act, so adding one costs a test edit; growing the list silently
 * is the failure this shape exists to prevent.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const GOVERNED_FILE = "src/session-manager-pg.ts";

/** The `sessions` table, never `active_sessions` or `kit_active_sessions`. */
const SESSION_TABLE = /\b(FROM|UPDATE|INTO|JOIN)\s+sessions\b/i;
const SESSION_ROW_READ = /\b(FROM|UPDATE|JOIN)\s+sessions\b/i;
const PREDICATE = "sessionNotTombstonedSql(";
/** The shared statement builder the deletion paths go through. */
const DELETE_OR_STAGE = "deleteOrStageSessionsSql";
const EXEMPT_MARKER = "tombstone-scope: exempt";
/** `  if (` and friends match the member shape; they are not method names. */
const CONTROL_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "function"]);

/** How far above a statement its exemption may be written. */
const MARKER_LOOKBACK = 16;

const STRING_LITERAL = /`(?:[^`\\]|\\[\s\S])*`|"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'/g;

/**
 * Blank comments while preserving line count, so prose ABOUT a statement is
 * never mistaken for one. Backticked identifiers are ordinary in this tree's
 * comments, and without this every such phrase reads as a template literal.
 */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, block => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, lead) => lead);
}

/** Every statement naming the `sessions` table, with its enclosing method. */
export function sessionStatements(source) {
  const lines = source.split("\n");
  const blanked = stripComments(source);
  const statements = [];
  for (const match of blanked.matchAll(STRING_LITERAL)) {
    if (!SESSION_TABLE.test(match[0])) continue;
    const line = blanked.slice(0, match.index).split("\n").length;
    let method = "<module>";
    for (let i = line - 1; i >= 0; i--) {
      const declaration = /^ {2}(?:private |readonly )?(?:async )?([a-zA-Z_]\w*)\s*[(<]/.exec(
        lines[i]
      );
      if (declaration && !CONTROL_KEYWORDS.has(declaration[1])) {
        method = declaration[1];
        break;
      }
    }
    const preceding = lines.slice(Math.max(0, line - 1 - MARKER_LOOKBACK), line - 1).join("\n");
    statements.push({
      method,
      line,
      sql: match[0],
      scoped: match[0].includes(PREDICATE),
      insertOnly: !SESSION_ROW_READ.test(match[0]),
      exempted: preceding.includes(EXEMPT_MARKER),
    });
  }
  return statements;
}

/**
 * Every method whose session-row access is fenced, by either mechanism: the
 * spliced predicate, or the shared delete-or-stage builder whose callers are
 * checked at runtime. Exported so the behaviour suite derives its coverage set
 * from the same read of the module that this gate does, rather than from a
 * second hand-written list that can disagree with it.
 */
export function guardedMethods(source) {
  const methods = new Set(
    sessionStatements(source)
      .filter(statement => statement.scoped)
      .map(statement => statement.method)
  );
  const lines = stripComments(source).split("\n");
  lines.forEach((line, index) => {
    // Calls only. The declaration line names the builder too, and scanning up
    // from it lands on whatever member happens to precede the function.
    if (!line.includes(`${DELETE_OR_STAGE}(`) || line.includes(`function ${DELETE_OR_STAGE}`)) {
      return;
    }
    for (let i = index; i >= 0; i--) {
      const declaration = /^ {2}(?:private |readonly )?(?:async )?([a-zA-Z_]\w*)\s*[(<]/.exec(
        lines[i]
      );
      if (declaration && !CONTROL_KEYWORDS.has(declaration[1])) {
        methods.add(declaration[1]);
        break;
      }
    }
  });
  return [...methods].sort();
}

export function violations(statements) {
  return statements
    .filter(s => !s.insertOnly && !s.scoped && !s.exempted)
    .map(
      s =>
        `${GOVERNED_FILE}: ${s.method} reads or mutates a session row without ` +
        `${PREDICATE}) and without a "${EXEMPT_MARKER}" reason`
    );
}

function main() {
  const source = readFileSync(join(ROOT, GOVERNED_FILE), "utf8");
  const statements = sessionStatements(source);
  const failures = violations(statements);
  if (failures.length > 0) {
    console.error("session tombstone scope FAILED:\n");
    for (const failure of failures) console.error(`  ${failure}`);
    console.error(
      "\nSee docs/plans/postgres-worktree-cleanup-durability.dag.toml, " +
        "step hide-tombstones-from-reads."
    );
    process.exit(1);
  }
  const inserts = statements.filter(s => s.insertOnly).length;
  const exempt = statements.filter(s => !s.insertOnly && s.exempted).length;
  console.log(
    `session tombstone scope: ${statements.length} statements name sessions; ` +
      `${statements.length - inserts - exempt} carry the predicate, ` +
      `${inserts} insert a new row, ${exempt} are exempt with a stated reason.`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
