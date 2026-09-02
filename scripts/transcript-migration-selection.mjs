/**
 * Which migrations construct the flight recorder's schema.
 *
 * Both readers of this question used to spell the same predicate, "every file
 * numbered 022 or higher", and both were wrong in the same way: the number says
 * when a migration was written, not what it touches. The static parity gate
 * survived that because it filters by table while parsing, so a migration for
 * another subsystem contributed nothing. The dynamic mirror in
 * flight-recorder-pg.test.ts EXECUTES the text it selects, into a schema that
 * holds the recorder's tables and nothing else, so the first migration written
 * against `jobs` failed there with `relation "jobs" does not exist`.
 *
 * The predicate below asks what a file targets instead of when it was written.
 * A later recorder migration is still picked up with nobody remembering to add
 * it, which is the property the version filter was reaching for; a migration
 * for another subsystem is now excluded on its content.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The tables the flight recorder owns. This is the list, not a sample: a
 * migration naming anything outside it is another subsystem's, and a new
 * recorder-owned table (transcript-cutover.design.md reserves one under
 * migration 025) has to join here before its migration reaches the mirror.
 */
export const RECORDER_TABLES = ["requests", "gateway_metadata"];

/**
 * The ledger every migration writes its own receipt into. It belongs to the
 * runner rather than to any subsystem, so it never decides ownership.
 */
const LEDGER_TABLE = "schema_migrations";

const TRANSCRIPT_ERA = 22;

const TABLE_TARGET =
  /\b(?:CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE|CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+CONCURRENTLY)?(?:\s+IF\s+NOT\s+EXISTS)?\s+\w+\s+ON)\s+([a-zA-Z_][\w]*)/gi;

/** Every table a migration creates, alters or indexes, ledger receipt aside. */
export function tableTargets(sql) {
  const targets = new Set();
  for (const match of sql.matchAll(TABLE_TARGET)) {
    const table = match[1].toLowerCase();
    if (table !== LEDGER_TABLE) targets.add(table);
  }
  return targets;
}

/**
 * Recorder-owned migration filenames in version order. A file qualifies when it
 * names at least one table and every table it names is the recorder's.
 */
export function transcriptMigrationFiles(dir) {
  return readdirSync(dir)
    .filter(name => /^\d+_.*\.sql$/.test(name) && Number(name.slice(0, 3)) >= TRANSCRIPT_ERA)
    .sort()
    .filter(name => {
      const targets = tableTargets(readFileSync(join(dir, name), "utf8"));
      return targets.size > 0 && [...targets].every(table => RECORDER_TABLES.includes(table));
    });
}

/** Those files concatenated in version order, ready to execute or to parse. */
export function transcriptMigrationText(dir) {
  const files = transcriptMigrationFiles(dir);
  if (files.length === 0) throw new Error(`no flight-recorder migrations found under ${dir}`);
  return files.map(name => readFileSync(join(dir, name), "utf8")).join("\n");
}
