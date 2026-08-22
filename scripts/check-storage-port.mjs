#!/usr/bin/env node
/**
 * Structural ratchet for docs/plans/storage-unification.dag.toml.
 *
 * Three rules, all about the same defect: SQL escaping the storage layer.
 *
 * 1. SQL statements may appear ONLY in storage-owning modules. A module that
 *    embeds SQL is bound to one engine's dialect, so every such module is a
 *    place the Postgres port has to reach. Keeping the set closed is what makes
 *    the port a finite job.
 *
 * 2. `queryRequests` (the caller-supplies-the-SQL read method) may be called
 *    only from within the flight recorder itself. It used to be the read
 *    surface for seven production callers, each passing SQLite `?` placeholders
 *    PostgreSQL does not accept. s2 replaced those with named typed reads; this
 *    stops them growing back.
 *
 * 3. PRAGMA and VACUUM may appear only in those same modules. They are engine
 *    maintenance, they have no operation class, and s3sig requires them to be
 *    unreachable from the port's surface rather than translated onto it.
 *
 * Tests are exempt from all three by design: a test seeding or inspecting a
 * fixture database directly is not a caller of the port. The header used to
 * claim they were NOT exempt from rule 1; the code has always exempted them.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "src");

/** Modules whose job IS to own SQL for a storage engine. */
const SQL_OWNERS = new Set([
  "flight-recorder.ts",
  "flight-recorder-pg.ts",
  "job-store.ts",
  "postgres-job-store-ops.ts",
  "postgres-job-store-schema.ts",
  "session-manager-pg.ts",
  "sqlite-driver.ts",
  "migrate.ts",
  "db.ts",
  // The storage port's own drivers. They exist to own engine SQL, so they are
  // sanctioned by design here rather than passing because the shape detector
  // happens not to match transaction-control statements.
  "sqlite.ts",
  "postgres.ts",
]);

/** Only the recorder may use the caller-supplies-SQL read method. */
const QUERY_REQUESTS_OWNER = "flight-recorder.ts";

/**
 * Shapes that are SQL and not English. Requiring SELECT and FROM TOGETHER is
 * the important part: the first version matched `SELECT\s+\w` alone and flagged
 * the phrase "select a workspace" inside a user-facing error message.
 */
const SQL_SHAPES = [
  /\bSELECT\b[\s\S]{1,4000}?\bFROM\s+[a-z_"]/i,
  /\bINSERT\s+(INTO|OR)\s+[a-z_"]/i,
  /\bUPDATE\s+[a-z_"][\w"]*\s+SET\s+[a-z_"]/i,
  /\bDELETE\s+FROM\s+[a-z_"]/i,
  /\bCREATE\s+(TABLE|INDEX)\b/i,
  /\bALTER\s+TABLE\s+[a-z_"]/i,
];

/**
 * Engine maintenance, which is neither a read nor a write and has no operation
 * class. s3sig's constraint is that PRAGMA and VACUUM are UNREACHABLE from the
 * port's surface rather than translated onto it, and the surface half of that
 * is structural: no operation names them and none takes a statement. This is
 * the other half. Without it a new module can spell `PRAGMA journal_mode=WAL`
 * and bind itself to SQLite while every existing rule stays green.
 */
const MAINTENANCE_SHAPES = [/\bPRAGMA\s+[a-z_]/i, /\bVACUUM\b/i];

/** Template literals, which is where every SQL statement in this tree lives. */
const TEMPLATE_LITERAL = /`(?:[^`\\]|\\[\s\S])*`/g;

/**
 * Every string form, because PRAGMA is short enough to sit in a quoted string
 * and does. `db.prepare("PRAGMA table_info(requests)")` is the shape, and the
 * template-literal scan above cannot see it.
 */
const ANY_STRING_LITERAL =
  /`(?:[^`\\]|\\[\s\S])*`|"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'/g;

function matchingLiterals(body, pattern, shapes) {
  const found = [];
  for (const match of body.matchAll(pattern)) {
    if (shapes.some(shape => shape.test(match[0]))) {
      found.push(body.slice(0, match.index).split("\n").length);
    }
  }
  return found;
}

export function sqlLiterals(body) {
  return matchingLiterals(body, TEMPLATE_LITERAL, SQL_SHAPES);
}

export function maintenanceLiterals(body) {
  return matchingLiterals(body, ANY_STRING_LITERAL, MAINTENANCE_SHAPES);
}

/**
 * Blank out line and block comments so prose about SQL is not mistaken for SQL.
 *
 * Line COUNT must be preserved: deleting a block comment outright shifts every
 * subsequent line number, which sent the first version of this script pointing
 * at innocent code hundreds of lines away from anything it had matched.
 */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, block => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, lead) => lead);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/** The three rules over one file's already-comment-stripped body. */
export function violationsFor(rel, body) {
  const found = [];
  const base = rel.split("/").pop();
  const isTest = rel.includes("__tests__");

  // Tests are exempt from rules 1 and 3: seeding and inspecting a fixture
  // database is what a storage test IS, and the *-pg suites are engine-specific
  // on purpose. The port has to carry production code, not test scaffolding.
  if (!SQL_OWNERS.has(base) && !isTest) {
    for (const line of sqlLiterals(body)) {
      found.push(
        `${rel}:${line}: SQL outside a storage-owning module. ` +
          `Move it behind a named operation on the owning module's read/write surface.`
      );
    }
    for (const line of maintenanceLiterals(body)) {
      found.push(
        `${rel}:${line}: PRAGMA or VACUUM outside a storage-owning module. ` +
          `Engine maintenance has no operation class and no place on the port's surface; ` +
          `it belongs inside the driver that owns the engine.`
      );
    }
  }

  if (!isTest && base !== QUERY_REQUESTS_OWNER && /\bqueryRequests\s*[(<]/.test(body)) {
    found.push(
      `${rel}: calls queryRequests. That method takes caller-supplied SQL and cannot be ` +
        `ported to a second engine. Add a named typed read to FlightRecorderQuery instead.`
    );
  }
  return found;
}

function main() {
  const violations = [];
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file);
    violations.push(...violationsFor(rel, stripComments(readFileSync(file, "utf8"))));
  }

  if (violations.length > 0) {
    console.error("storage port ratchet FAILED:\n");
    for (const v of violations) console.error(`  ${v}`);
    console.error(
      `\n${violations.length} violation(s). See docs/plans/storage-unification.dag.toml s2.`
    );
    process.exit(1);
  }

  console.log(
    `storage port: SQL confined to ${SQL_OWNERS.size} storage modules; ` +
      `no PRAGMA or VACUUM outside them; ` +
      `no caller-supplied SQL outside ${QUERY_REQUESTS_OWNER}.`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
