#!/usr/bin/env node
/**
 * The transcript schema is declared in THREE places. This gate makes them agree.
 *
 *   1. `SQL_SCHEMA`    in src/flight-recorder.ts    (SQLite, plus later ALTERs)
 *   2. `SQL_BOOTSTRAP` in src/flight-recorder-pg.ts (PostgreSQL, run at startup)
 *   3. migrations/022_flight_recorder_transcripts.sql
 *
 * A dynamic control already compares 2 and 3 properly: flight-recorder-pg.test.ts
 * applies the migration into a mirror schema, runs the bootstrap into another,
 * and diffs information_schema including type, nullability and default. It is
 * the better check and this gate does not replace it.
 *
 * It does not RUN, though. vitest.config.ts excludes *-pg.test.ts unless
 * PG_TESTS=1, and `npm run check` runs `npm test`, not `test:pg`, because
 * test:pg needs a Postgres container. So the control guarding two of the three
 * declarations is switched off in the gate everyone actually runs, and the
 * third declaration, SQLite, is compared to nothing at all by anything.
 *
 * That gap is not theoretical. A migration of 12,031 rows was written against a
 * column list taken from PRAGMA at runtime; had SQLite carried a column the
 * PostgreSQL side lacked, the copy would have dropped it silently, the row
 * counts would still have matched, and a body hash would still have passed.
 *
 * This gate is static: it parses the three declarations and compares COLUMN
 * NAMES per table, plus declared TYPES between the two PostgreSQL ones. It needs
 * no database, so it runs in `npm run check` on every machine.
 *
 * SQLite types are deliberately NOT compared to PostgreSQL types. The two
 * engines disagree on purpose and the conversions are listed in
 * DECLARED_TYPE_DIVERGENCE below, so a NEW divergence has to be added here
 * consciously rather than discovered during a migration.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TABLES = ["requests", "gateway_metadata"];

/**
 * SQLite stores these differently from PostgreSQL BY DESIGN, and the migration
 * converts them. Listed so the divergence is a decision on the record rather
 * than a surprise: anything NOT here must match.
 */
const DECLARED_TYPE_DIVERGENCE = {
  optimization_applied: "sqlite INTEGER 0/1 -> postgres BOOLEAN",
  routed: "sqlite INTEGER 0/1 -> postgres BOOLEAN",
  cost_usd: "sqlite REAL -> postgres DOUBLE PRECISION (both IEEE-754 binary64)",
  route_est_cost_usd: "sqlite REAL -> postgres DOUBLE PRECISION",
};

/** Column names and declared types from a CREATE TABLE body, in file order. */
function parseCreateTable(sql, table) {
  const re = new RegExp(`CREATE TABLE(?:\\s+IF NOT EXISTS)?\\s+${table}\\s*\\(`, "i");
  const m = re.exec(sql);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (i < sql.length && depth > 0) {
    if (sql[i] === "(") depth += 1;
    else if (sql[i] === ")") depth -= 1;
    i += 1;
  }
  const body = sql.slice(start, i - 1);

  const cols = new Map();
  let parenDepth = 0;
  let current = "";
  const flush = () => {
    const line = current.trim().replace(/--.*$/gm, "").trim();
    current = "";
    if (!line) return;
    // Table constraints, not columns.
    if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(line)) return;
    const name = line.split(/\s+/)[0].replace(/["`]/g, "");
    if (!/^[a-z_][a-z0-9_]*$/i.test(name)) return;
    const rest = line.slice(line.indexOf(name) + name.length).trim();
    const type = (rest.match(/^[A-Za-z ]+(\([^)]*\))?/) || [""])[0].trim().toUpperCase();
    cols.set(name, type);
  };
  for (const ch of body) {
    if (ch === "(") parenDepth += 1;
    if (ch === ")") parenDepth -= 1;
    if (ch === "," && parenDepth === 0) flush();
    else current += ch;
  }
  flush();
  return cols;
}

/** Columns a later ALTER adds, which a CREATE TABLE block alone will not show. */
function parseAlterAdds(sql, table) {
  const out = new Map();
  const re = new RegExp(
    `ALTER TABLE\\s+${table}\\s+ADD COLUMN(?:\\s+IF NOT EXISTS)?\\s+([a-z_][a-z0-9_]*)\\s+([A-Za-z ]+(\\([^)]*\\))?)`,
    "gi"
  );
  let m;
  while ((m = re.exec(sql)) !== null) out.set(m[1], m[2].trim().toUpperCase());
  return out;
}

function declarationsFrom(text, label) {
  const per = {};
  for (const table of TABLES) {
    const created = parseCreateTable(text, table);
    if (!created) {
      per[table] = null;
      continue;
    }
    for (const [name, type] of parseAlterAdds(text, table)) created.set(name, type);
    per[table] = created;
  }
  return { label, per };
}

const sources = [
  declarationsFrom(
    readFileSync(join(ROOT, "src/flight-recorder.ts"), "utf8"),
    "sqlite (flight-recorder.ts)"
  ),
  declarationsFrom(
    readFileSync(join(ROOT, "src/flight-recorder-pg.ts"), "utf8"),
    "postgres bootstrap (flight-recorder-pg.ts)"
  ),
  declarationsFrom(
    readFileSync(join(ROOT, "migrations/022_flight_recorder_transcripts.sql"), "utf8"),
    "postgres migration (022)"
  ),
];

const failures = [];
for (const s of sources) {
  for (const table of TABLES) {
    if (!s.per[table])
      failures.push(`${s.label}: no CREATE TABLE for ${table}; this gate cannot see it`);
  }
}

if (failures.length === 0) {
  for (const table of TABLES) {
    const [a, b, c] = sources.map(s => s.per[table]);
    const names = s => [...s.keys()].sort();
    // NAME parity across all three, including SQLite. This is the half nothing
    // covered, and the half the migration depended on.
    for (const [x, y] of [
      [sources[0], sources[1]],
      [sources[1], sources[2]],
    ]) {
      const nx = names(x.per[table]);
      const ny = names(y.per[table]);
      const onlyX = nx.filter(n => !ny.includes(n));
      const onlyY = ny.filter(n => !nx.includes(n));
      if (onlyX.length || onlyY.length) {
        failures.push(
          `${table}: ${x.label} and ${y.label} disagree.\n` +
            `      only in ${x.label}: ${onlyX.join(", ") || "none"}\n` +
            `      only in ${y.label}: ${onlyY.join(", ") || "none"}`
        );
      }
    }
    // TYPE parity between the two PostgreSQL declarations. SQLite is excluded
    // deliberately: see DECLARED_TYPE_DIVERGENCE.
    for (const name of b.keys()) {
      if (!c.has(name)) continue;
      if (b.get(name) !== c.get(name)) {
        failures.push(
          `${table}.${name}: bootstrap declares ${b.get(name)}, migration 022 declares ${c.get(name)}`
        );
      }
    }
    // A divergence entry that no longer describes anything is stale bookkeeping.
    for (const name of Object.keys(DECLARED_TYPE_DIVERGENCE)) {
      if (!a.has(name) || !b.has(name)) continue;
      if (a.get(name) === b.get(name)) {
        failures.push(
          `${table}.${name}: listed in DECLARED_TYPE_DIVERGENCE but both engines now declare ${a.get(name)}. Remove the entry.`
        );
      }
    }
  }
}

console.log("transcript:schema:parity:check");
if (failures.length > 0) {
  console.error("\n  FAIL");
  for (const f of failures) console.error(`    ${f}`);
  console.error(
    "\n  The transcript schema is declared in three places and they must agree on\n" +
      "  column names. A column present in one and not another is how a migration\n" +
      "  drops data while every row count still matches.\n"
  );
  process.exit(1);
}
const counts = TABLES.map(t => `${t} ${sources[0].per[t].size}`).join(", ");
console.log(
  `  OK: 3 declarations agree on column names (${counts}); the two Postgres ones agree on types.`
);
