import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GOVERNED_FILE,
  guardedMethods,
  sessionStatements,
  stripComments,
  violations,
} from "./check-session-tombstone-scope.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = readFileSync(join(ROOT, GOVERNED_FILE), "utf8");
const PREDICATE_CALL = "${sessionNotTombstonedSql()}";

const tally = source => {
  const statements = sessionStatements(source);
  return {
    total: statements.length,
    scoped: statements.filter(s => !s.insertOnly && s.scoped).length,
    insertOnly: statements.filter(s => s.insertOnly).length,
    exempt: statements.filter(s => !s.insertOnly && s.exempted).length,
    failures: violations(statements).length,
  };
};

describe("the governed file", () => {
  // Every number the script PRINTS is asserted. An unasserted figure reads as
  // coverage while saying nothing, and the split between predicate, insert and
  // exemption is the whole claim: a statement quietly moving from the first
  // bucket to the third is exactly the drift this gate exists to catch.
  it("has every session-row statement scoped, inserting, or exempt with a reason", () => {
    expect(tally(SOURCE)).toEqual({
      total: 32,
      scoped: 19,
      insertOnly: 6,
      exempt: 7,
      failures: 0,
    });
  });

  it("reports every method fenced by either mechanism", () => {
    // Four of the predicate calls sit in predicates handed to the shared
    // delete-or-stage builder rather than in a statement of their own, so a
    // derivation that only read statements would drop the three deletion paths
    // from the covered set and the behaviour suite would stop requiring them.
    const methods = guardedMethods(SOURCE);
    expect(methods).toHaveLength(15);
    expect(methods).toEqual(expect.arrayContaining(["deleteSession", "clearAllSessions"]));
    expect(methods).not.toContain("constructor");
  });
});

describe("negative controls", () => {
  // The gate passing on a clean tree proves the tree is clean, not that the
  // gate can see anything. Each of these mutates the real source and requires
  // it to go red.
  it("fires on every statement when the predicate is removed wholesale", () => {
    // Both spellings, not just the bare call: two statements alias or join the
    // table and pass `"s"`, and a control that removed only the default form
    // reported 21 of 23 while looking like a clean sweep.
    const mutated = SOURCE.replaceAll(/\$\{sessionNotTombstonedSql\([^)]*\)\}/g, "");
    expect(SOURCE.split(PREDICATE_CALL).length - 1).toBe(21);
    expect(SOURCE.split('sessionNotTombstonedSql("s")').length - 1).toBe(2);
    // 19, not 23: four of the calls are in predicates the builder receives, and
    // those are fenced by its runtime throw rather than by this gate.
    expect(tally(mutated).failures).toBe(19);
  });

  it("fires when one statement loses the predicate", () => {
    // A named statement, not "the first occurrence": some occurrences are in
    // builder predicates this gate does not govern, so an ordinal control here
    // would pass or fail on the order of the file.
    const target = `WHERE id = $1 AND ${PREDICATE_CALL}\``;
    expect(SOURCE).toContain(target);
    const mutated = SOURCE.replace(target, "WHERE id = $1`");
    expect(tally(mutated).failures).toBe(1);
  });

  it("fires when an exemption marker is deleted", () => {
    const mutated = SOURCE.replace("tombstone-scope: exempt", "");
    expect(tally(mutated)).toMatchObject({ exempt: 6, failures: 1 });
  });

  it("fires on a new unscoped read added to the file", () => {
    const added = `${SOURCE}\nconst leak = \`SELECT id FROM sessions WHERE cli = $1\`;\n`;
    expect(tally(added)).toMatchObject({ total: 33, failures: 1 });
  });
});

describe("what the scanner counts", () => {
  const one = sql => sessionStatements(`  method() {\n    query(\`${sql}\`);\n  }\n`);

  it("treats an insert of a new row as exempt by shape, not by declaration", () => {
    expect(one("INSERT INTO sessions (id) VALUES ($1)")[0]).toMatchObject({
      insertOnly: true,
      exempted: false,
    });
    expect(violations(one("INSERT INTO sessions (id) VALUES ($1)"))).toEqual([]);
  });

  it("does not govern the pointer tables", () => {
    expect(one("SELECT session_id FROM active_sessions WHERE cli = $1")).toEqual([]);
    expect(one("DELETE FROM kit_active_sessions WHERE cli = $1")).toEqual([]);
  });

  it("governs an aliased join, which a bare-column predicate would miss", () => {
    expect(one("SELECT s.id FROM kit_active_sessions a JOIN sessions AS s ON s.id = a.id")).toEqual(
      [expect.objectContaining({ insertOnly: false, scoped: false })]
    );
  });

  it("does not mistake backticked prose in a comment for a statement", () => {
    const body = `  method() {\n    // reads \`FROM sessions\` in prose only\n    return 1;\n  }\n`;
    expect(sessionStatements(body)).toEqual([]);
    expect(stripComments(body)).not.toContain("FROM sessions");
  });

  it("will not accept an exemption written too far above the statement", () => {
    const far = ["  method() {", "    // tombstone-scope: exempt"]
      .concat(Array.from({ length: 20 }, (_, i) => `    const filler${i} = ${i};`))
      .concat(["    query(`SELECT id FROM sessions WHERE id = $1`);", "  }"])
      .join("\n");
    expect(violations(sessionStatements(far))).toHaveLength(1);
  });

  it("names the method so a failure points at the statement", () => {
    const failures = violations(one("SELECT id FROM sessions WHERE id = $1"));
    expect(failures[0]).toContain("method");
  });
});
