import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GOVERNED_FILE,
  guardedMethods,
  productionSources,
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
      total: 31,
      scoped: 19,
      insertOnly: 6,
      exempt: 6,
      failures: 0,
    });
  });

  it("reports every method fenced by either mechanism", () => {
    // The builder now splices the exclusion itself, so its statement carries
    // the predicate; its three callers are still fenced through it and must
    // stay in the covered set the behaviour suite derives.
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
    expect(SOURCE.split(PREDICATE_CALL).length - 1).toBe(20);
    expect(SOURCE.split('sessionNotTombstonedSql("s")').length - 1).toBe(2);
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
    expect(tally(mutated)).toMatchObject({ exempt: 5, failures: 1 });
  });

  it("fires on a new unscoped read added to the file", () => {
    const added = `${SOURCE}\nconst leak = \`SELECT id FROM sessions WHERE cli = $1\`;\n`;
    expect(tally(added)).toMatchObject({ total: 32, failures: 1 });
  });
});

describe("the bypasses two reviewers walked through", () => {
  // Every case here defeated an earlier version of this gate. They are kept as
  // the gate's own regression suite: the census it prints is only worth
  // something if these stay red.
  const wrap = body => `  meth() {\n    q(\`${body}\`);\n  }\n`;
  const fires = body => violations(sessionStatements(wrap(body)));

  it("sees a quoted, schema-qualified or ONLY table reference", () => {
    expect(fires('SELECT id FROM "sessions" WHERE id = $1')).toHaveLength(1);
    expect(fires("SELECT id FROM public.sessions WHERE id = $1")).toHaveLength(1);
    expect(fires('SELECT id FROM "public"."sessions" WHERE id = $1')).toHaveLength(1);
    expect(fires("SELECT id FROM ONLY sessions WHERE id = $1")).toHaveLength(1);
    expect(fires("UPDATE ONLY sessions SET x = 1 WHERE id = $1")).toHaveLength(1);
  });

  it("refuses a table name assembled at runtime rather than trying to read it", () => {
    const body =
      '  meth() {\n    const t = "sessions";\n    q(`SELECT id FROM ${t} WHERE id = $1`);\n  }\n';
    const failures = violations(sessionStatements(body));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("builds a table name at runtime");
  });

  it("does not accept a predicate that cannot execute", () => {
    // A substring test cannot tell a live splice from a dead branch.
    expect(
      fires('SELECT id FROM sessions WHERE id = $1 ${false ? sessionNotTombstonedSql() : ""}')
    ).toHaveLength(1);
    expect(fires("SELECT id FROM sessions WHERE id = $1 AND ${sessionNotTombstonedSql()}")).toEqual(
      []
    );
  });

  it("does not fire on prose or on a non-SQL template", () => {
    const body = "  meth() {\n    log(`copied from ${source} to ${dest}`);\n  }\n";
    expect(sessionStatements(body)).toEqual([]);
  });

  it("governs a view definition, because it reads rows like anything else", () => {
    // The DDL exemption is GONE. A reviewer hid a live read behind it twice:
    // `CREATE TABLE copy AS SELECT * FROM sessions` copied a tombstone on a
    // real server, and a trailing `-- CREATE VIEW decoy` comment made an
    // ordinary read scan as DDL. The `session_summary` view carries the
    // predicate now instead of an exemption.
    expect(fires("CREATE OR REPLACE VIEW session_summary AS SELECT s.id FROM sessions s")).toEqual([
      expect.stringContaining("reads or mutates a session row"),
    ]);
    expect(
      fires(
        'CREATE OR REPLACE VIEW session_summary AS SELECT s.id FROM sessions s WHERE ${sessionNotTombstonedSql("s")}'
      )
    ).toEqual([]);
    expect(fires("CREATE TABLE copy AS SELECT * FROM sessions")).toHaveLength(1);
  });

  it("sees a bare TABLE read, which names no FROM at all", () => {
    // `TABLE sessions` is exactly `SELECT * FROM sessions` in PostgreSQL, and a
    // reviewer read a tombstone back with it while this gate printed a clean
    // census. Schema statements that merely contain the keyword are not reads.
    expect(fires("TABLE sessions")).toHaveLength(1);
    expect(fires("TABLE public.sessions")).toHaveLength(1);
    expect(fires("ALTER TABLE sessions ALTER COLUMN id TYPE TEXT")).toEqual([]);
    expect(fires("DROP TABLE sessions")).toEqual([]);
  });

  it("scans the whole production tree, not just the module it started from", () => {
    const modules = productionSources();
    expect(modules.length).toBeGreaterThan(100);
    expect(modules.some(file => file.endsWith("/src/migrate.ts"))).toBe(true);
    expect(modules.some(file => file.endsWith(`/${GOVERNED_FILE}`))).toBe(true);
    expect(modules.some(file => file.includes("/__tests__/"))).toBe(false);
    expect(modules.every(file => file.endsWith(".ts"))).toBe(true);
  });

  it("actually scans that tree when RUN, which asserting the helper does not show", () => {
    // Both reviewers narrowed `main()` to a single file and every test here
    // stayed green while the gate printed "1 production modules scanned". The
    // helper being correct says nothing about `main()` still calling it, so
    // this asserts the number the command PRINTS, against the same derivation.
    const printed = execFileSync(
      "node",
      [join(ROOT, "scripts/check-session-tombstone-scope.mjs")],
      {
        encoding: "utf8",
      }
    );
    const scanned = /(\d+) production modules scanned/.exec(printed);
    expect(scanned, printed).not.toBeNull();
    expect(Number(scanned[1])).toBe(productionSources().length);
    expect(Number(scanned[1])).toBeGreaterThan(100);
  });

  it("sees the row statements that name no FROM at all", () => {
    // `COPY sessions TO STDOUT` reads every row, `TRUNCATE` destroys them,
    // `MERGE INTO` writes them. A reviewer walked through the first while the
    // gate printed a clean census.
    expect(fires("COPY sessions TO STDOUT")).toHaveLength(1);
    expect(fires("TRUNCATE sessions")).toHaveLength(1);
    expect(fires("MERGE INTO sessions USING x ON x.id = sessions.id")).toHaveLength(1);
  });

  it("sees a table reference hidden behind an SQL comment", () => {
    const body = "  meth() {\n    q(`SELECT id FROM--x\n       sessions WHERE id = $1`);\n  }\n";
    expect(violations(sessionStatements(body))).toHaveLength(1);
  });

  it("refuses SQL split inside the identifier, not only at the joint", () => {
    // The end-of-literal rule catches a split at the keyword boundary and
    // misses one mid-word. Closing the joint before looking finds both.
    const midWord = '  meth() {\n    q("SELECT id FROM sess" + "ions WHERE id = $1");\n  }\n';
    const failures = violations(sessionStatements(midWord));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("more than one string literal");
  });

  it("does not fire on prose that merely sits beside a concatenation", () => {
    // SQL_SHAPE matches English "update" and "copy", and the SQL-comment strip
    // can truncate such prose so it ends on a keyword. Six unrelated message
    // strings were flagged before the rule required the table to be named.
    expect(
      violations(sessionStatements('  meth() {\n    log("will update " + "the config");\n  }\n'))
    ).toEqual([]);
    expect(
      violations(sessionStatements('  meth() {\n    log("grok update " + "--version x");\n  }\n'))
    ).toEqual([]);
  });

  it("refuses a table reference split across concatenated literals", () => {
    const body = '  meth() {\n    q("SELECT id, cli FROM " + "sessions WHERE id = $1");\n  }\n';
    const failures = violations(sessionStatements(body));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("more than one string literal");
    // Ending on a lock clause is not a split reference.
    expect(
      fires("SELECT id FROM sessions WHERE id = $1 AND ${sessionNotTombstonedSql()} FOR UPDATE")
    ).toEqual([]);
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
