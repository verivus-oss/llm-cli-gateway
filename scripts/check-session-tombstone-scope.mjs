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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const GOVERNED_FILE = "src/session-manager-pg.ts";

/**
 * Every production module, not just the one that happens to hold the session
 * SQL today. Confining the scan to `session-manager-pg.ts` made the gate's
 * census true of that file and silent about the rest of the tree, which is a
 * different claim from the one it prints.
 */
function productionSources(directory = join(ROOT, "src"), out = []) {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "__tests__") productionSources(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The `sessions` table, never `active_sessions` or `kit_active_sessions`.
 *
 * Every spelling PostgreSQL accepts, because the first version of this matched
 * only the bare identifier and two reviewers walked straight through it:
 * `FROM "sessions"`, `FROM public.sessions`, `FROM ONLY sessions` and
 * `UPDATE ONLY sessions` all read a session row and all scanned as clean while
 * the gate printed a complete-looking census.
 */
const TABLE_REFERENCE = String.raw`(?:ONLY\s+)?(?:(?:"?[A-Za-z_]\w*"?)\.)?"?sessions"?\b`;
const SESSION_TABLE = new RegExp(String.raw`\b(FROM|UPDATE|INTO|JOIN)\s+` + TABLE_REFERENCE, "i");
const SESSION_ROW_READ = new RegExp(String.raw`\b(FROM|UPDATE|JOIN)\s+` + TABLE_REFERENCE, "i");

/**
 * A table name assembled at runtime. `FROM ${table}` is unreadable to any
 * static gate, so it is refused outright rather than analysed: this module has
 * no legitimate reason to compute a table name.
 */
const INTERPOLATED_TABLE = /\b(FROM|UPDATE|INTO|JOIN)\s+(?:ONLY\s+)?\$\{/i;

/**
 * Is this literal SQL at all? Ordinary prose and non-SQL templates say "from
 * ${x}" too, and without this the interpolated-table rule fired on a dozen
 * template strings in modules that touch no database.
 */
const SQL_SHAPE =
  /\b(SELECT\s|INSERT\s+INTO\s|UPDATE\s|DELETE\s+FROM\s|CREATE\s|ALTER\s+TABLE\s|DROP\s+(TABLE|VIEW)\s|WITH\s+[A-Za-z_]\w*\s+AS\s*\()/i;

/** DDL. A view or table definition is not a caller-facing read of a row. */
const DDL_STATEMENT = /\b(CREATE|ALTER|DROP)\s+(OR\s+REPLACE\s+)?(VIEW|TABLE|INDEX|FUNCTION)\b/i;

const PREDICATE = "sessionNotTombstonedSql(";

/**
 * The predicate must be spliced as a BARE interpolation. `${sessionNotTombstonedSql()}`
 * counts; `${false ? sessionNotTombstonedSql() : ""}` does not, because a
 * substring test cannot tell a live splice from a dead branch and a reviewer
 * got an unguarded read past the gate that way.
 */
const SPLICED_PREDICATE = /\$\{\s*sessionNotTombstonedSql\([^)]*\)\s*\}/;
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
    if (!SQL_SHAPE.test(match[0])) continue;
    const interpolatedTable = INTERPOLATED_TABLE.test(match[0]);
    if (!SESSION_TABLE.test(match[0]) && !interpolatedTable) continue;
    const line = blanked.slice(0, match.index).split("\n").length;
    // A module-level helper resolves to its own name. Scanning only for
    // indented class members walked past the enclosing function and attributed
    // the statement to whatever member happened to sit above it, which put
    // `constructor` in the derived set.
    let method = "<module>";
    let topLevel = false;
    for (let i = line - 1; i >= 0; i--) {
      const topLevelDeclaration = /^(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_]\w*)/.exec(
        lines[i]
      );
      if (topLevelDeclaration) {
        method = topLevelDeclaration[1];
        topLevel = true;
        break;
      }
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
      topLevel,
      line,
      sql: match[0],
      interpolatedTable,
      ddl: DDL_STATEMENT.test(match[0]),
      scoped: SPLICED_PREDICATE.test(match[0]),
      insertOnly: !interpolatedTable && !SESSION_ROW_READ.test(match[0]),
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
  // Manager METHODS only. A module-level helper is exercised through its
  // callers, which are in this set, so listing it would ask the behaviour suite
  // to drive something that has no caller-facing surface of its own.
  const methods = new Set(
    sessionStatements(source)
      .filter(statement => statement.scoped && !statement.topLevel)
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

export function violations(statements, file = GOVERNED_FILE) {
  return statements.flatMap(s => {
    // Refused unconditionally: no exemption marker and no predicate can make a
    // computed table name readable to this gate.
    if (s.interpolatedTable) {
      return [`${file}: ${s.method} builds a table name at runtime; spell the table literally`];
    }
    if (s.ddl || s.insertOnly || s.scoped || s.exempted) return [];
    return [
      `${file}: ${s.method} reads or mutates a session row without ` +
        `${PREDICATE}) spliced as a bare interpolation, and without a ` +
        `"${EXEMPT_MARKER}" reason`,
    ];
  });
}

function main() {
  const files = productionSources();
  const perFile = files.map(file => ({
    file: relative(ROOT, file),
    statements: sessionStatements(readFileSync(file, "utf8")),
  }));
  const statements = perFile.flatMap(entry => entry.statements);
  const failures = perFile.flatMap(entry => violations(entry.statements, entry.file));
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
  const ddl = statements.filter(s => !s.insertOnly && s.ddl).length;
  const exempt = statements.filter(s => !s.insertOnly && !s.ddl && s.exempted).length;
  const scoped = statements.length - inserts - ddl - exempt;
  console.log(
    `session tombstone scope: ${files.length} production modules scanned; ` +
      `${statements.length} statements name sessions; ` +
      `${scoped} carry the predicate, ${inserts} insert a new row, ` +
      `${ddl} are DDL, ${exempt} are exempt with a stated reason.`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
