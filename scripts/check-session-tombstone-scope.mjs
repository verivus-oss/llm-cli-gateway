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
export function productionSources(directory = join(ROOT, "src"), out = []) {
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
const TABLE_REFERENCE = String.raw`\(?(?:ONLY )?(?:(?:"?[A-Za-z_]\w*"?)\.)?"?sessions"?\b`;

/**
 * `TABLE sessions` is a complete statement in PostgreSQL and is exactly
 * `SELECT * FROM sessions`. A reviewer read a tombstone back with it while this
 * gate printed a clean census, because the keyword list had no entry for a form
 * that names no FROM. The lookbehind keeps `CREATE TABLE`, `ALTER TABLE` and
 * `DROP TABLE`, which are schema statements rather than row reads, out of it.
 */
const BARE_TABLE_READ =
  String.raw`(?<!\b(?:CREATE|ALTER|DROP|TEMPORARY|UNLOGGED) )TABLE ` + TABLE_REFERENCE;

/**
 * Statements that read or destroy rows while naming no FROM, UPDATE or JOIN.
 * `COPY sessions TO STDOUT` reads every row, `TRUNCATE sessions` removes them
 * all, `MERGE INTO sessions` writes them. A reviewer walked through the first
 * of these while this gate printed a clean census.
 */
const OTHER_ROW_STATEMENTS = String.raw`\b(COPY|TRUNCATE|MERGE INTO) ` + TABLE_REFERENCE;

/**
 * A comma join names the table with no keyword in front of it.
 * `FROM other o, sessions s` is an inner join and reads session rows, and a
 * reviewer walked through it while this gate printed a clean census. The
 * keyword still has to appear somewhere before the comma, so ordinary prose
 * containing ", sessions" is not swept in.
 */
const COMMA_JOINED_TABLE = String.raw`\b(FROM|UPDATE|JOIN|USING) [^;]*?, *` + TABLE_REFERENCE;

const SESSION_TABLE = new RegExp(
  String.raw`\b(FROM|UPDATE|INTO|JOIN|USING) ` +
    TABLE_REFERENCE +
    "|" +
    BARE_TABLE_READ +
    "|" +
    OTHER_ROW_STATEMENTS +
    "|" +
    COMMA_JOINED_TABLE,
  "i"
);
const SESSION_ROW_READ = new RegExp(
  String.raw`\b(FROM|UPDATE|JOIN|USING) ` +
    TABLE_REFERENCE +
    "|" +
    BARE_TABLE_READ +
    "|" +
    OTHER_ROW_STATEMENTS +
    "|" +
    COMMA_JOINED_TABLE,
  "i"
);

/**
 * An upsert is not an insert.
 *
 * `INSERT INTO sessions ... ON CONFLICT (id) DO UPDATE SET ...` writes rows
 * that are ALREADY THERE, tombstones included, and the insert exemption exists
 * only because a statement that can only ever add a new row cannot read or
 * change one. A reviewer changed a tombstone's description through this form
 * while the gate classified it `insertOnly` and printed a clean census.
 * `DO NOTHING` stays an insert, because it writes nothing it did not create.
 */
const UPSERT = /\bON CONFLICT\b[\s\S]*?\bDO UPDATE\b/i;

/**
 * A table name assembled at runtime. `FROM ${table}` is unreadable to any
 * static gate, so it is refused outright rather than analysed: this module has
 * no legitimate reason to compute a table name.
 */
const INTERPOLATED_TABLE = /\b(FROM|UPDATE|INTO|JOIN|USING|TABLE) (?:ONLY )?\$\{/i;

/**
 * Is this literal SQL at all? Ordinary prose and non-SQL templates say "from
 * ${x}" too, and without this the interpolated-table rule fired on a dozen
 * template strings in modules that touch no database.
 */
const SQL_SHAPE =
  /\b(SELECT |INSERT INTO |UPDATE |DELETE FROM |CREATE |ALTER TABLE |DROP (TABLE|VIEW) |TABLE [A-Za-z_"]|COPY |TRUNCATE |MERGE INTO |WITH [A-Za-z_]\w* AS \()/i;

/**
 * A literal that ENDS on the keyword introducing a table name has handed the
 * table to whatever is concatenated next, and no scanner over single literals
 * can follow it. Refused rather than analysed, for the same reason as an
 * interpolated table name: a reviewer read a session row through
 * `"SELECT id FROM " + "sessions WHERE id = $1"` while this gate printed a
 * clean census.
 */
const SPLIT_TABLE_REFERENCE = /(?<!\bFOR )\b(FROM|UPDATE|INTO|JOIN|USING|TABLE) *$/i;

/**
 * SQL assembled by concatenation, in any shape.
 *
 * The end-of-literal rule above catches a split at the keyword boundary and
 * misses one INSIDE the identifier: `"SELECT id FROM sess" + "ions WHERE ..."`
 * is valid once joined and invisible to a scanner reading one literal at a
 * time. Rather than chase the split point, a SQL literal adjacent to a `+` is
 * refused outright. Statements in these modules are single literals.
 */
/**
 * Does the text around this literal assemble a statement about `sessions`?
 *
 * Both split-reference rules need this. SQL_SHAPE is deliberately loose and
 * matches English prose containing "update" or "copy", and the SQL-comment
 * strip can truncate such prose so it ENDS on a keyword: the note "via 'grok
 * update --version <target>'" became "...grok update " and read as a dangling
 * table reference. Requiring the neighbourhood to name the table removes that
 * whole class without weakening either rule.
 *
 * The concatenation joint is closed before looking, which is what finds a split
 * INSIDE the identifier: `"... FROM sess" + "ions ..."` becomes
 * `... FROM sessions ...`. `\bsessions\b` still does not match inside
 * `active_sessions`, because the underscore is a word character.
 */
function assemblesSessionsStatement(body, start, end) {
  const window = body.slice(Math.max(0, start - 200), end + 200);
  return /\bsessions\b/i.test(window.replace(/["'`]\s*\+\s*["'`]/g, ""));
}

/** A SQL literal sitting next to a `+`. Statements here are single literals. */
function isConcatenated(body, start, end) {
  return (
    /\+\s*$/.test(body.slice(Math.max(0, start - 40), start)) ||
    /^\s*\+/.test(body.slice(end, end + 40))
  );
}

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
    // Whitespace is NORMALISED before matching. These literals wrap, and a
    // pattern that spelled the gaps as a single space matched or missed on the
    // fill width rather than on the statement.
    // SQL comments removed, then whitespace normalised, in that order. These
    // literals wrap, so a pattern spelling the gaps as one space matched on
    // fill width rather than on the statement; and `FROM--x` before a newline
    // and the table name is a valid read no keyword-then-space pattern sees.
    const sql = match[0]
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/--[^\n]*/g, " ")
      .replace(/\s+/g, " ");
    const literalEnd = match.index + match[0].length;
    const concatenated = isConcatenated(blanked, match.index, literalEnd);
    // SQL_SHAPE keeps prose out by asking for a VERB, and a statement whose
    // verb was split across the `+` has no verb in either half: a reviewer read
    // a tombstone through `"SELEC" + "T id, cli FROM sessions WHERE id = $1"`
    // while this test threw both literals away before any concatenation rule
    // could see them. A concatenated literal that names the session table is
    // examined whatever shape the fragment is in.
    if (!SQL_SHAPE.test(sql) && !(concatenated && SESSION_TABLE.test(sql))) continue;
    const interpolatedTable = INTERPOLATED_TABLE.test(sql);
    const splitTable =
      (SPLIT_TABLE_REFERENCE.test(sql.slice(0, -1)) || concatenated) &&
      assemblesSessionsStatement(blanked, match.index, literalEnd);
    if (!SESSION_TABLE.test(sql) && !interpolatedTable && !splitTable) continue;
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
      sql,
      interpolatedTable,
      splitTable,
      scoped: SPLICED_PREDICATE.test(sql),
      insertOnly:
        !interpolatedTable && !splitTable && !SESSION_ROW_READ.test(sql) && !UPSERT.test(sql),
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
    if (s.splitTable) {
      return [
        `${file}: ${s.method} assembles a session statement from more than one ` +
          `string literal; keep the statement in one literal`,
      ];
    }
    if (s.insertOnly || s.scoped || s.exempted) return [];
    return [
      `${file}: ${s.method} reads or mutates a session row without ` +
        `${PREDICATE}) spliced as a bare interpolation, and without a ` +
        `"${EXEMPT_MARKER}" reason`,
    ];
  });
}

/**
 * Scan the tree and return what was actually read.
 *
 * `main` used to discover the files and print the count itself, so narrowing
 * the scan while still printing the discovered total left the census looking
 * complete and the unit suite green: a reviewer scanned ONE file and the gate
 * reported 158. The scan is a value now, and the suite asserts the files in it
 * against `productionSources()` directly, so there is no number left to print
 * that the scan did not produce.
 */
export function scan() {
  const files = productionSources();
  const perFile = files.map(file => ({
    file: relative(ROOT, file),
    statements: sessionStatements(readFileSync(file, "utf8")),
  }));
  return { files: perFile.map(entry => entry.file), perFile };
}

function main() {
  const { files, perFile } = scan();
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
  const exempt = statements.filter(s => !s.insertOnly && s.exempted).length;
  const scoped = statements.length - inserts - exempt;
  console.log(
    `session tombstone scope: ${files.length} production modules scanned; ` +
      `${statements.length} statements name sessions; ` +
      `${scoped} carry the predicate, ${inserts} insert a new row, ` +
      `${exempt} are exempt with a stated reason.`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
