/**
 * What `redactDsn` says about a DSN, checked against what `pg` does with it.
 *
 * THIS FILE IS DELIBERATELY NOT NAMED `*-pg.test.ts`. That suffix is excluded
 * from `npm test` unless PG_TESTS=1 (see PG_TEST_GLOBS in vitest.config.ts),
 * and round 6 found every assertion about this function sitting behind that
 * exclusion. The full suite was green at 4761 tests for four rounds while the
 * function reported a server pg would not connect to. Nothing here needs a
 * PostgreSQL server: `pg.Client` is CONSTRUCTED and never connected.
 *
 * The oracle is pg itself. Asserting a literal string only proves the function
 * is stable; comparing it to the client object the driver hands to the socket
 * proves it is TRUE. Every case does both.
 */
import fs, { readFileSync } from "fs";
import { createRequire } from "module";
import { afterEach, describe, expect, it } from "vitest";
import { redactDsn } from "../flight-recorder-pg.js";

const require = createRequire(import.meta.url);
const { Client } = require("pg") as {
  Client: new (config: { connectionString: string }) => {
    host?: string;
    port?: number;
    database?: string;
  };
};

/**
 * Captured through the SAME property production patches, before any test has
 * run, so the restore check compares against a known reference rather than
 * against whatever happens to be installed at the time.
 */
const pristineReadFileSync = (require("fs") as { readFileSync: typeof readFileSync }).readFileSync;

const BS = String.fromCharCode(92);

const AMBIENT = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER"] as const;
const saved = new Map<string, string | undefined>();

/**
 * Every test runs with the ambient PG* variables CLEARED, not merely restored.
 * A test that only restores what it set passes on a developer's laptop and
 * fails on a host that exports PGDATABASE, which is exactly the ambient state
 * this function exists to report.
 */
function ambient(vars: Partial<Record<(typeof AMBIENT)[number], string>> = {}): void {
  for (const name of AMBIENT) {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    delete process.env[name];
  }
  Object.assign(process.env, vars);
}

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
});

/** The target pg would actually use, read off a constructed, unconnected client. */
function pgTruth(dsn: string): { kind: string; host: string; port: string; database: string } {
  const c = new Client({ connectionString: dsn });
  const host = String(c.host ?? "");
  // pg opens a unix socket when the resolved host is a path (node-pg's own
  // test is `indexOf("/") === 0`), so the KIND is derived from pg, not chosen.
  return {
    kind: host.startsWith("/") ? "socket" : "host",
    host,
    port: String(c.port ?? ""),
    database: String(c.database ?? ""),
  };
}

/**
 * Split a report into its labelled fields.
 *
 * Values are either a bare run of non-space characters or a JSON string, since
 * `show()` quotes anything containing a space. So the delimiters can be walked
 * left to right without a ` port ` INSIDE a quoted value being mistaken for the
 * separator, which is what a lastIndexOf would do to
 * `database "db port 9999 database other"`.
 */
interface ReportField {
  value: string;
  /** The parenthesised provenance, "" when the field carried none. */
  note: string;
}

function fieldsOf(report: string): {
  kind: string;
  host: ReportField;
  port: ReportField;
  database: ReportField;
} {
  let at = 0;
  const eat = (literal: string): void => {
    expect(report.slice(at, at + literal.length), `expected ${literal} at ${at} in ${report}`).toBe(
      literal
    );
    at += literal.length;
  };
  const value = (): ReportField => {
    let raw: string;
    if (report[at] === '"') {
      // A JSON string, honouring escapes so an escaped quote does not end it.
      let end = at + 1;
      while (end < report.length && report[end] !== '"') end += report[end] === "\\" ? 2 : 1;
      raw = report.slice(at, end + 1);
      at = end + 1;
    } else {
      const end = report.indexOf(" ", at);
      raw = report.slice(at, end === -1 ? report.length : end);
      at = end === -1 ? report.length : end;
    }
    // The annotation belongs to THIS field, and is RETURNED rather than
    // discarded. Round 10: throwing it away made provenance invisible to the
    // oracle, so the round 7 defect (naming PGUSER for a value the DSN
    // supplied) would have passed here unseen.
    let note = "";
    if (report.startsWith(" (", at)) {
      const close = report.indexOf(")", at);
      const stop = close === -1 ? report.length : close + 1;
      // INSIDE the parentheses. Slicing them in made every note fail the
      // `^from PGX$` test silently, so the provenance oracle below never fired
      // even once. Caught only because a mutation that should have tripped it
      // was instead caught by an outer literal.
      note = report.slice(at + 2, stop - 1);
      at = stop;
    }
    return { value: raw.startsWith('"') ? (JSON.parse(raw) as string) : raw, note };
  };
  eat("postgresql ");
  const kind = value().value;
  eat(" ");
  const host = value();
  eat(" port ");
  const port = value();
  eat(" database ");
  const database = value();
  expect(at, `trailing text in ${report}`).toBe(report.length);
  return { kind, host, port, database };
}

/**
 * An annotation must name an input that ACTUALLY decided the value.
 *
 * Measured differentially, not by re-deriving pg's precedence, and EXHAUSTIVELY
 * over the note shapes production emits. Round 11 BLOCKER, both reviewers: the
 * previous version handled `from PGX` and the empty note and silently ignored
 * everything else, which is every `(default)` and every
 * `(default: the connecting user, ...)` note. Its own comment claimed it
 * checked `(default)` differentially. It did not, so round 7's defect in its
 * CURRENT wording would still have passed here unseen. That is the second time
 * this helper claimed more than it checked, so the unknown-shape branch below
 * FAILS rather than falling through: a note this helper does not understand is
 * a hole in the oracle, not a pass.
 */
const PROVENANCE_PROBE: Record<string, string> = {
  PGHOST: "provenance.invalid",
  PGPORT: "65432",
  PGDATABASE: "provenance_db",
  PGUSER: "provenance_user",
};

function expectProvenanceIsReal(
  dsn: string,
  got: { host: ReportField; port: ReportField; database: ReportField }
): void {
  const resolvedNow = pgTruth(dsn);
  const withEnv = (
    name: string,
    value: string | undefined
  ): { host: string; port: string; database: string } => {
    const had = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    try {
      return pgTruth(dsn);
    } finally {
      if (had === undefined) delete process.env[name];
      else process.env[name] = had;
    }
  };
  const withoutVariable = (name: string): { host: string; port: string; database: string } =>
    withEnv(name, undefined);
  const withProbeFor = (name: string): { host: string; port: string; database: string } =>
    withEnv(name, PROVENANCE_PROBE[name]);

  const fields: [keyof typeof resolvedNow & ("host" | "port" | "database"), ReportField][] = [
    ["host", got.host],
    ["port", got.port],
    ["database", got.database],
  ];
  const variableFor = { host: "PGHOST", port: "PGPORT", database: "PGDATABASE" } as const;

  for (const [field, reported] of fields) {
    const note = reported.note;

    // Credited to an ambient variable: removing it must CHANGE pg's answer.
    const named = /^from (PG[A-Z]+)$/.exec(note);
    if (named !== null) {
      expect(
        withoutVariable(named[1])[field],
        `${dsn}: report credits ${named[1]} for ${field}, but removing it changes nothing`
      ).not.toBe(resolvedNow[field]);
      continue;
    }

    // Claimed explicit: no ambient variable may be able to move it.
    if (note === "") {
      for (const name of AMBIENT) {
        expect(
          withoutVariable(name)[field],
          `${dsn}: ${field} is reported as stated, but ${name} moves it`
        ).toBe(resolvedNow[field]);
      }
      continue;
    }

    // Claimed a pg built-in default: the field's own variable must be unset,
    // so SETTING it has to move the value. Deleting anything must not.
    if (note === "default") {
      const name = variableFor[field];
      expect(
        withProbeFor(name)[field],
        `${dsn}: ${field} is reported as pg's default, but setting ${name} does not move it`
      ).not.toBe(resolvedNow[field]);
      for (const other of AMBIENT) {
        expect(
          withoutVariable(other)[field],
          `${dsn}: ${field} is reported as a default, but removing ${other} moves it`
        ).toBe(resolvedNow[field]);
      }
      continue;
    }

    // The database only. pg substitutes the CONNECTING USER for an absent
    // database name, and the note names where that user came from. Round 7's
    // defect was crediting PGUSER for a user pg took from the DSN, so each of
    // these three is checked against PGUSER differentially.
    if (field === "database" && note.startsWith("default: the connecting user")) {
      if (note === "default: the connecting user, from PGUSER") {
        expect(
          withoutVariable("PGUSER").database,
          `${dsn}: database is credited to PGUSER, but removing it changes nothing`
        ).not.toBe(resolvedNow.database);
        continue;
      }
      if (note === "default: the connecting user, from the DSN") {
        expect(
          withoutVariable("PGUSER").database,
          `${dsn}: database is credited to the DSN's user, but PGUSER moves it`
        ).toBe(resolvedNow.database);
        expect(
          withProbeFor("PGUSER").database,
          `${dsn}: database is credited to the DSN's user, but PGUSER overrides it`
        ).toBe(resolvedNow.database);
        continue;
      }
      if (note === "default: the connecting user") {
        expect(
          withProbeFor("PGUSER").database,
          `${dsn}: database is credited to no named source, but setting PGUSER moves it`
        ).not.toBe(resolvedNow.database);
        continue;
      }
    }

    throw new Error(
      `${dsn}: ${field} carries the annotation "${note}", which this oracle does ` +
        `not check. Add a differential for it rather than letting it pass.`
    );
  }
}

/** Each field pg resolved must be THAT field in the report, not merely present. */
function expectAgreesWithPg(dsn: string): string {
  const report = redactDsn(dsn);
  const truth = pgTruth(dsn);
  // NO normalisation of the truth. Round 8: this stripped brackets from the
  // expected host before comparing, so `?host=[foo]` reporting `foo` while pg
  // used `[foo]` passed. An oracle that edits the truth to match the answer is
  // not an oracle. For `[]` it was worse: the bare form was "" and
  // `toContain("")` is tautologically true, so that case asserted nothing.
  //
  // POSITIONAL, not substring. `toContain` searched the whole report, so one
  // field could satisfy another's assertion: for `/db5433` the database name
  // alone satisfied `toContain(port)`, and the port could have been wrong or
  // missing with the check still green. Found by auditing this helper rather
  // than the production code.
  const got = fieldsOf(report);
  expectProvenanceIsReal(dsn, got);
  // KIND too. Round 9, both reviewers: fieldsOf returned it and this ignored
  // it, so replacing socket detection with a constant `"host"` passed the
  // oracle outright and failed only two hand-written string literals.
  expect(got.kind, `kind for ${dsn}`).toBe(truth.kind);
  expect(got.host.value, `host for ${dsn}`).toBe(truth.host);
  expect(got.port.value, `port for ${dsn}`).toBe(truth.port);
  expect(got.database.value, `database for ${dsn}`).toBe(truth.database);
  return report;
}

/**
 * WHAT THIS ORACLE CANNOT SEE, stated so nobody relies on it for these.
 *
 * `fieldsOf` JSON.parses a quoted field, which UNDOES both `JSON.stringify`
 * and the `\uXXXX` pass in `show()`. So a report carrying a RAW U+2028 and one
 * carrying `\u2028` decode to the same value and both agree with pg. Round 9
 * found that: reverting the escape set entirely leaves this helper green.
 *
 * Escaping, quoting and truncation are RENDERING properties. They are asserted
 * against the raw report string in their own tests below, never through here.
 */

/** Runs `fn` with fs.readFileSync watched, and reports what it read. */
function readsDuring(fn: () => string): { reads: string[]; result: string } {
  const reads: string[] = [];
  const real = fs.readFileSync;
  const spy = ((path: unknown, ...rest: unknown[]) => {
    reads.push(String(path));
    return (real as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.readFileSync;
  (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = spy;
  try {
    return { reads, result: fn() };
  } finally {
    (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = real;
  }
}

describe("redactDsn names the server pg will actually reach", () => {
  it("never emits a URI-SHAPED report, so none can be pasted back as a DSN", () => {
    // Round 6's defect: the round 5 fix annotated provenance INSIDE a URI.
    // PGPORT produced `postgresql://127.0.0.1:6543 (from PGPORT)/db`, which is
    // not a URI at all, and PGDATABASE produced
    // `postgresql://127.0.0.1:5433/ambient_db (from PGDATABASE)`, which IS a
    // valid URI naming a database that does not exist.
    //
    // Round 7 falsified the stronger "contains no ://" wording: pg accepts
    // `?host=evil://host`, and naming the host pg resolved is the entire job,
    // so the substring can legitimately appear INSIDE a value. The guarantee
    // is about the SHAPE of the whole string, and the last two cases below are
    // exactly the ones that broke the old wording.
    const dsns = [
      "postgresql://u:p@127.0.0.1:5432/db",
      "postgresql://u:p@127.0.0.1:5432/db?host=/var/run/postgresql",
      "postgresql://u:p@[::1]:5433/db",
      "postgresql://u:p@127.0.0.1/db",
      "postgresql://u:p@127.0.0.1:5432/db?host=evil://host",
      "postgresql://u:p@127.0.0.1:5432/foo://bar",
    ];
    ambient({ PGPORT: "6543" });
    for (const dsn of dsns) {
      const report = redactDsn(dsn);
      expect(report, dsn).not.toMatch(/^\w+:\/\//);
      expect(report, dsn).toMatch(/^postgresql (host|socket) /);
    }
    // The value-bearing cases still NAME what pg resolved, `://` and all.
    ambient();
    expect(redactDsn("postgresql://u:p@127.0.0.1:5432/foo://bar")).toContain("foo://bar");
  });

  it("does not read a file named in the DSN just to print a host", () => {
    // Round 7, measured: pg-connection-string calls fs.readFileSync on
    // sslcert, sslkey and sslrootcert, and `new Client({connectionString})`
    // does the same. This function runs at startup and in doctor, so a FIFO or
    // /dev/zero on one of those parameters would hang or exhaust the process
    // before anything connected. None of the three can move the target.
    ambient();
    const { reads, result: report } = readsDuring(() =>
      redactDsn(
        "postgresql://u:p@127.0.0.1:5433/db?sslcert=/etc/hosts&sslkey=/etc/hosts&sslrootcert=/etc/hosts&host=elsewhere"
      )
    );
    expect(reads.filter(r => r.includes("/etc/hosts"))).toEqual([]);
    // Suppressing the READ must not lose the parameters that MOVE the target.
    expect(report).toBe("postgresql host elsewhere port 5433 database db");
  });

  it("does not put a password on a surface that is read aloud", () => {
    ambient();
    expect(redactDsn("postgresql://u:sup3rsecret@127.0.0.1:5432/gw")).toBe(
      "postgresql host 127.0.0.1 port 5432 database gw"
    );
    expect(redactDsn("postgresql://u:sup3rsecret@127.0.0.1:5432/gw")).not.toContain("sup3rsecret");
  });

  it("reports the query parameters, not the authority they override", () => {
    // pg resolves through pg-connection-string, which reads ?host= and ?port=
    // in PREFERENCE to the authority. Reporting the authority told an operator
    // transcripts were on 127.0.0.1 while the connection went elsewhere.
    ambient();
    expect(expectAgreesWithPg("postgresql://u:p@127.0.0.1:5432/db?host=elsewhere&port=6666")).toBe(
      "postgresql host elsewhere port 6666 database db"
    );
    // A parameter that cannot move the target must not move the report.
    // Deliberately not sslmode: pg emits a SECURITY WARNING for it, and a
    // redactor should not make `npm test` print one on every run.
    expect(expectAgreesWithPg("postgresql://u:p@127.0.0.1:5432/db?application_name=gw")).toBe(
      "postgresql host 127.0.0.1 port 5432 database db"
    );
  });

  it("calls a unix socket a socket, whichever way the path arrives", () => {
    ambient();
    expect(expectAgreesWithPg("postgresql://u:p@127.0.0.1:5432/db?host=/var/run/postgresql")).toBe(
      "postgresql socket /var/run/postgresql port 5432 database db"
    );
    // Round 6: the socket test ran on the LITERAL host, so an empty authority
    // with a socket path in PGHOST was reported as `host`. pg opens a socket.
    ambient({ PGHOST: "/var/run/postgresql" });
    expect(expectAgreesWithPg("postgresql:///llm_gateway_test")).toBe(
      "postgresql socket /var/run/postgresql (from PGHOST) port 5432 (default) database llm_gateway_test"
    );
  });

  it("reports the host EXACTLY as pg resolved it, adding and removing nothing", () => {
    // There used to be bracket normalisation here, to disambiguate `::1:5433`
    // in the old URI-shaped report. The report has not been URI-shaped since
    // round 7: host and port are separate labelled fields, so there is nothing
    // to disambiguate, and the rule had become a pure source of disagreement.
    // Round 8 measured four, including `?host=[foo]` reported as `foo`.
    ambient();
    // Bare from ?host=, bracketed from the authority. Both pass through.
    expect(expectAgreesWithPg("postgresql://u:p@127.0.0.1:5432/db?host=::1")).toBe(
      "postgresql host ::1 port 5432 database db"
    );
    expect(expectAgreesWithPg("postgresql://u:p@[::1]:5433/db")).toBe(
      "postgresql host [::1] port 5433 database db"
    );
    // The four round-8 disagreements, each now identical to pg.
    for (const [query, expected] of [
      ["%5Bfoo%5D", "[foo]"],
      ["%5B%5D", "[]"],
      ["%5B127.0.0.1%5D", "[127.0.0.1]"],
      [":", ":"],
    ]) {
      const dsn = `postgresql://u:p@127.0.0.1:5433/db?host=${query}`;
      expect(pgTruth(dsn).host, `pg host for ${query}`).toBe(expected);
      expect(expectAgreesWithPg(dsn), query).toBe(
        `postgresql host ${expected} port 5433 database db`
      );
    }
  });

  it("quotes a value that collides with the format's own keywords", () => {
    // Round 8: `?host=port` printed `postgresql host port port 5433 database
    // db`. It agreed with pg and was unreadable. The value is still named.
    ambient();
    for (const word of ["host", "port", "database", "socket"]) {
      const dsn = `postgresql://u:p@127.0.0.1:5433/db?host=${word}`;
      expect(pgTruth(dsn).host).toBe(word);
      expect(redactDsn(dsn), word).toBe(`postgresql host "${word}" port 5433 database db`);
    }
  });

  it("follows the ambient PG* variables rather than reporting a default pg will not use", () => {
    // pg resolves `config[key] || process.env.PG* || default`, so an absent
    // field does NOT mean the libpq default. Measured: PGPORT=6543 wins.
    ambient({ PGPORT: "6543" });
    expect(expectAgreesWithPg("postgresql://u:p@127.0.0.1/db")).toBe(
      "postgresql host 127.0.0.1 port 6543 (from PGPORT) database db"
    );
    ambient({ PGDATABASE: "ambient_db" });
    expect(expectAgreesWithPg("postgresql://u:p@127.0.0.1:5433")).toBe(
      "postgresql host 127.0.0.1 port 5433 database ambient_db (from PGDATABASE)"
    );
  });

  it("names the value pg substitutes for an absent field, not a blank", () => {
    ambient();
    expect(expectAgreesWithPg("postgresql://u:p@127.0.0.1/db")).toBe(
      "postgresql host 127.0.0.1 port 5432 (default) database db"
    );
    // An absent database is not a default NAME: pg substitutes the connecting
    // user, so the report has to name that user rather than say "(default)".
    expect(expectAgreesWithPg("postgresql://u:p@127.0.0.1:5432")).toBe(
      "postgresql host 127.0.0.1 port 5432 database u (default: the connecting user, from the DSN)"
    );
  });

  it("names where the connecting user came from, not merely that PGUSER exists", () => {
    // Round 7 BLOCKER. This reported `(from PGUSER)` whenever PGUSER was SET,
    // so `postgresql://bob@host` with PGUSER=alice printed
    // `database bob (from PGUSER)`. pg took `bob` from the DSN and ignored
    // PGUSER entirely, so the annotation sent the reader to the wrong variable.
    // No test set PGUSER, so deleting the whole branch passed 10 of 10.
    ambient({ PGUSER: "alice" });
    expect(expectAgreesWithPg("postgresql://bob@127.0.0.1:5433")).toBe(
      "postgresql host 127.0.0.1 port 5433 database bob (default: the connecting user, from the DSN)"
    );
    // PGUSER is named only when pg actually used it.
    ambient({ PGUSER: "alice" });
    expect(expectAgreesWithPg("postgresql://127.0.0.1:5433")).toBe(
      "postgresql host 127.0.0.1 port 5433 database alice (default: the connecting user, from PGUSER)"
    );
    // An explicit database is never attributed to the user at all.
    ambient({ PGUSER: "alice" });
    expect(expectAgreesWithPg("postgresql://bob@127.0.0.1:5433/realdb")).toBe(
      "postgresql host 127.0.0.1 port 5433 database realdb"
    );
  });

  it("resolves a DSN that WHATWG rejects and pg accepts", () => {
    // Round 6, measured: `new URL("postgresql://u:pw@/db")` throws, so the old
    // fast path called this unparseable, while pg connects to localhost:5432.
    // Deciding well-formedness with a parser pg does not use is the same
    // two-representations mistake in its last remaining corner.
    ambient();
    expect(expectAgreesWithPg("postgresql://u:pw@/db")).toBe(
      "postgresql host localhost (default) port 5432 (default) database db"
    );
  });

  it("does not bracket a socket PATH that happens to contain a colon", () => {
    // Round 7 BLOCKER. Bracketing ran on every host before the socket test, so
    // `?host=/tmp/pg:socket`, which pg accepts, came out as
    // `socket [/tmp/pg:socket]`. A path is not an address.
    ambient();
    expect(expectAgreesWithPg("postgresql://u:p@127.0.0.1:5433/db?host=/tmp/pg%3Asocket")).toBe(
      "postgresql socket /tmp/pg:socket port 5433 database db"
    );
    ambient({ PGHOST: "/tmp/pg:socket" });
    expect(redactDsn("postgresql:///db")).toContain("socket /tmp/pg:socket");
  });

  it("cannot be made to inject a line into the log it is printed to", () => {
    // Round 7 BLOCKER. pg DECODES these fields, so `%0A` became a real newline
    // in the startup log line, and `%20port%209999%20database%20other` produced
    // `database db port 9999 database other`, which reads as structure. The
    // parent implementation was accidentally safe: its WHATWG path never
    // decoded. Decoding is correct, so the escaping has to be deliberate.
    ambient();
    for (const dsn of [
      "postgresql://u:p@127.0.0.1:5433/db%0AINJECTED",
      "postgresql://u:p@127.0.0.1:5433/db%0D%0Afake",
      "postgresql://u:p@127.0.0.1:5433/db?host=h%0Aevil",
    ]) {
      const report = redactDsn(dsn);
      expect(report, dsn).not.toMatch(/[\r\n]/);
      // One line in, one line out.
      expect(report.split("\n"), dsn).toHaveLength(1);
    }
    // A value that mimics the format's own delimiters is quoted, not merged.
    expect(redactDsn("postgresql://u:p@127.0.0.1:5433/db%20port%209999%20database%20other")).toBe(
      'postgresql host 127.0.0.1 port 5433 database "db port 9999 database other"'
    );
    // An ordinary name is NOT quoted, or every report would be noisy.
    expect(redactDsn("postgresql://u:p@127.0.0.1:5433/llm_gateway_test")).toBe(
      "postgresql host 127.0.0.1 port 5433 database llm_gateway_test"
    );
  });

  it("neutralises characters that reorder the log line around them", () => {
    // Found by attacking the round-7 quoting fix rather than by a reviewer.
    // JSON.stringify does NOT escape bidi controls, so a database named
    // `db\u202Egnirts` survived quoting and still reverses everything after it
    // when the line is rendered. Same failure as the newline: a value from the
    // input deciding how the REST of the line reads.
    ambient();
    const report = redactDsn("postgresql://u:p@127.0.0.1:5433/db%E2%80%AEgnirts");
    expect(report).not.toMatch(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/);
    expect(report).toBe('postgresql host 127.0.0.1 port 5433 database "db\\u202egnirts"');
    // An accented name is NOT mangled: escaping the whole non-ASCII range
    // would make every legitimate international database name unreadable.
    expect(redactDsn("postgresql://u:p@127.0.0.1:5433/%C3%A9t%C3%A9")).toBe(
      'postgresql host 127.0.0.1 port 5433 database "\u00e9t\u00e9"'
    );
  });

  it("bounds a field rather than putting an unbounded value on one log line", () => {
    // pg imposes no length worth relying on, so a 100KB database name went
    // straight into the startup log line as a single field.
    ambient();
    const long = "a".repeat(300);
    const report = redactDsn(`postgresql://u:p@127.0.0.1:5433/${long}`);
    expect(report.length).toBeLessThan(200);
    // Truncation must SAY it truncated, and say what the real length was, or
    // the report quietly names a database that is not the one pg opened.
    expect(report).toContain("... (300 chars)");
    // A name at the limit is untouched.
    const short = "b".repeat(120);
    expect(redactDsn(`postgresql://u:p@127.0.0.1:5433/${short}`)).toBe(
      `postgresql host 127.0.0.1 port 5433 database ${short}`
    );
  });

  it("still names the target when the DSN points at SSL material that is missing", () => {
    // Deliberate divergence from `new Client({connectionString})`, pinned here
    // so it is not mistaken for the target disagreement this file exists to
    // prevent. pg's constructor ALSO validates SSL material and throws ENOENT
    // for a cert that does not exist; this function never READS the file, so
    // it answers where the connection was going. That is what makes it useful
    // in the error message about the failure. Measured: with a cert file that
    // DOES exist, pg resolves host `good`, exactly what is reported here.
    //
    // Round 11: the title and this comment used to say the parameters were
    // STRIPPED. Nothing has been stripped since round 10 deleted the rewriting;
    // pg is handed the original string with the read suppressed underneath it.
    ambient();
    expect(
      redactDsn("postgresql://u:p@127.0.0.1:5433/db?sslcert=/nonexistent/cert.pem&host=good")
    ).toBe("postgresql host good port 5433 database db");
  });

  it("reads no SSL file in any form, and moves no target doing it", () => {
    // These spellings were the STRIPPER's edge cases, kept as target-agreement
    // cases after the stripper was deleted: whatever pg reads them as, the
    // reported target must still be the one pg resolves.
    ambient();
    const withOverride = "postgresql host elsewhere port 5433 database db";
    for (const query of [
      "sslcert=/etc/hosts&host=elsewhere",
      "SSLCERT=/etc/hosts&host=elsewhere",
      "sslcert=/etc/hosts&sslcert=/etc/hosts&host=elsewhere",
      "sslcert&host=elsewhere",
      "host=elsewhere&sslkey=/etc/hosts",
      "host=elsewhere&sslrootcert=/etc/hosts",
      "sslcert=/etc/hosts&host=elsewhere#frag",
    ]) {
      const { reads, result } = readsDuring(() =>
        redactDsn(`postgresql://u:p@127.0.0.1:5433/db?${query}`)
      );
      // BOTH properties. Asserting only the target made this blind: a stripper
      // that missed the uppercase form still reported `elsewhere`, because
      // /etc/hosts EXISTS so the read succeeds and moves nothing. The read is
      // the harm, so the read is what has to be asserted. Three mutations
      // applied cleanly against the target-only version and failed nothing.
      expect(
        reads.filter(r => r.includes("/etc/hosts")),
        query
      ).toEqual([]);
      expect(result, query).toBe(withOverride);
    }
    // A key that merely STARTS with a stripped name must survive, or an
    // unrelated parameter would be silently dropped.
    expect(redactDsn("postgresql://u:p@127.0.0.1:5433/db?sslcertificate=x&host=elsewhere")).toBe(
      withOverride
    );
  });

  it("reads no SSL file whose parameter name is percent-encoded", () => {
    // Round 8 BLOCKER. pg-connection-string reads the query with
    // URLSearchParams, which DECODES keys, so `?ssl%63ert=/etc/hosts` is
    // `sslcert` to pg and the file was read. The stripper compared raw bytes.
    // Comparing a different representation from the one that acts is this
    // module's oldest defect, and it had reappeared inside the fix for it.
    ambient();
    for (const query of [
      "ssl%63ert=/etc/hosts",
      "%73slcert=/etc/hosts",
      "ssl%6bey=/etc/hosts",
      "sslroot%63ert=/etc/hosts",
      "SSL%43ERT=/etc/hosts",
    ]) {
      const { reads } = readsDuring(() => redactDsn(`postgresql://u:p@127.0.0.1:5433/db?${query}`));
      expect(
        reads.filter(r => r.includes("/etc/hosts")),
        query
      ).toEqual([]);
    }
  });

  it("neutralises every character that can break or reorder the line", () => {
    // U+2028 split the report in two while a /[CR LF]/ assertion passed, which
    // is why the set is defined by WHAT THESE DO rather than grown one code
    // point at a time. %0A was round 7; these are the same class.
    const SEPARATORS = new RegExp(
      "[" + BS + "r" + BS + "n" + BS + "u0085" + BS + "u2028" + BS + "u2029]",
      "u"
    );
    const BIDI = new RegExp(
      "[" +
        BS +
        "u200B-" +
        BS +
        "u200F" +
        BS +
        "u202A-" +
        BS +
        "u202E" +
        BS +
        "u2066-" +
        BS +
        "u2069" +
        BS +
        "uFEFF]",
      "u"
    );
    ambient();
    for (const encoded of ["%E2%80%A8", "%E2%80%A9", "%C2%85", "%E2%80%AE", "%E2%81%A6", "%0A"]) {
      const report = redactDsn(`postgresql://u:p@127.0.0.1:5433/db${encoded}x`);
      expect(SEPARATORS.test(report), encoded).toBe(false);
      expect(BIDI.test(report), encoded).toBe(false);
    }
  });

  it("does not change which encodeURI branch pg takes", () => {
    // Round 9 BLOCKER. pg-connection-string rewrites the WHOLE string with
    // encodeURI when it contains a space, and encodeURI encodes `[` and `]`.
    // Editing the query as TEXT changed which branch that test took: removing
    // the space along with `?sslcert=...` made this DSN parse here and throw
    // `Invalid URL` in pg, and the report named a host pg never reached.
    ambient();
    const ipv6 = "postgresql://u:p@[::1]:5433/db?sslcert=/tmp/foo bar";
    expect(() => new Client({ connectionString: ipv6 }), "pg must still reject this").toThrow();
    expect(redactDsn(ipv6)).toBe("postgresql (dsn not parseable)");
    // The reverse direction: pg PARSES this one (it fails later, on the
    // missing cert file), so the target must still be named.
    const ipv4 = "postgresql://u:p@[127.0.0.1]:5433/db?sslcert=/tmp/foo bar";
    let code = "";
    try {
      new Client({ connectionString: ipv4 });
    } catch (error) {
      code = String((error as { code?: string }).code ?? "");
    }
    expect(code, "pg parses this and fails on the file, not the URL").toBe("ENOENT");
    expect(redactDsn(ipv4)).toBe("postgresql host [127.0.0.1] port 5433 database db");
  });

  it("strips SSL parameters whose keys carry characters WHATWG removes", () => {
    // Round 9 BLOCKER. `new URL` strips TAB, LF and CR from a URL before
    // parsing, so `?ssl<TAB>cert=` is `sslcert` to pg. A comparison done on
    // the raw text saw a key it did not recognise, and read the file.
    ambient();
    for (const code of [9, 10, 13]) {
      const key = `ssl${String.fromCharCode(code)}cert`;
      const { reads } = readsDuring(() =>
        redactDsn(`postgresql://u:p@127.0.0.1:5433/db?${key}=/etc/hosts`)
      );
      expect(
        reads.filter(r => r.includes("/etc/hosts")),
        `U+${code}`
      ).toEqual([]);
    }
  });

  it("agrees with pg about a DSN that begins with a character WHATWG trims", () => {
    // Round 9 BLOCKER, both reviewers. The scheme gate tested the RAW string,
    // so a leading tab made it answer "not parseable" while pg resolved the
    // DSN perfectly. WHATWG trims leading C0 controls and spaces first.
    for (const code of [9, 10, 13, 0, 27]) {
      ambient();
      const dsn = String.fromCharCode(code) + "postgresql://u:p@127.0.0.1:5433/db";
      expect(expectAgreesWithPg(dsn), `U+${code}`).toBe(
        "postgresql host 127.0.0.1 port 5433 database db"
      );
    }
    // A leading SPACE is different and must NOT be trimmed away: it triggers
    // pg's encodeURI branch, so pg resolves the dummy base host on port 5432.
    // Reporting that truthfully is the point; it is a loud signal.
    ambient();
    expect(expectAgreesWithPg(" postgresql://u:p@127.0.0.1:5433/db")).toContain(
      "host base port 5432"
    );
  });

  it("escapes every character that breaks, reorders or COMMANDS a terminal", () => {
    // Asserted on the RAW report, never through fieldsOf, which JSON.parses a
    // quoted value and so cannot see escaping at all.
    //
    // Round 9: the enumerated set missed four. U+009B is the 8-bit CSI and this
    // string goes to stderr, where `CSI 2J` ERASES THE SCREEN. U+061C was the
    // one Bidi_Control the range missed. Hence a property test, not a list.
    const UNSAFE =
      /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u2060-\u2064\uFEFF\u200B-\u200F]|\p{Bidi_Control}/u;
    for (const encoded of [
      "%C2%9B", // CSI
      "%D8%9C", // Arabic Letter Mark
      "%7F", // DEL
      "%E2%81%A0", // word joiner
      "%E2%80%A8", // line separator
      "%E2%80%8E", // left-to-right mark
      "%E2%80%AE", // right-to-left override
      "%0A", // the round 7 case
    ]) {
      ambient();
      const report = redactDsn(`postgresql://u:p@127.0.0.1:5433/db${encoded}x`);
      expect(UNSAFE.test(report), encoded).toBe(false);
      expect(report.split("\n"), encoded).toHaveLength(1);
    }
  });

  it("quotes the words an annotation is written in", () => {
    // Round 9: `?host=from` printed `postgresql host from port 5433`, and
    // `(from PGHOST)` is how provenance is written. Same class as `?host=port`.
    for (const word of ["from", "default"]) {
      ambient();
      expect(redactDsn(`postgresql://u:p@127.0.0.1:5433/db?host=${word}`), word).toBe(
        `postgresql host "${word}" port 5433 database db`
      );
    }
  });

  it("never leaks pg's internal dummy hostname", () => {
    // Round 10 BLOCKER, both reviewers. pg rewrites `@/` to `@___DUMMY___/`
    // and sets a PRIVATE flag that turns the hostname back into "". The old
    // code copied the rewrite, not the flag, then serialised the URL, so
    // adding a cert parameter to an empty-authority DSN reported host
    // `___DUMMY___` while pg used localhost. Nothing is serialised now.
    for (const query of ["", "?sslcert=/etc/hosts", "?SSLCERT=/etc/hosts", "?sslkey=/etc/hosts"]) {
      ambient();
      const dsn = `postgresql://u:p@/db${query}`;
      const report = expectAgreesWithPg(dsn);
      expect(report, query).not.toContain("DUMMY");
      expect(report, query).toBe(
        "postgresql host localhost (default) port 5432 (default) database db"
      );
    }
  });

  it("agrees with pg when TAB, LF or CR sit INSIDE the scheme", () => {
    // Round 10 BLOCKER. Round 9 trimmed only the ends. WHATWG removes these
    // from ANYWHERE in a URL before reading the scheme, so `post<TAB>gresql://`
    // is the same DSN to pg and 24 cases disagreed.
    for (const code of [9, 10, 13]) {
      ambient();
      const dsn = `post${String.fromCharCode(code)}gresql://u:p@127.0.0.1:5433/db`;
      expect(expectAgreesWithPg(dsn), `U+${code}`).toBe(
        "postgresql host 127.0.0.1 port 5433 database db"
      );
    }
  });

  it("escapes every invisible or controlling character, by property", () => {
    // EVERY matching code point, not a sample of them.
    //
    // Round 10 replaced a list of eight characters with the two BOUNDARIES
    // of every contiguous run. Round 11 BLOCKER, codex: that is still a
    // sample. Leaving ONE interior code point raw in production, U+E0061,
    // left all 31 tests green, because no run boundary touches it.
    // Boundary sampling pins where a range starts and ends, never that the
    // range has no holes.
    //
    // So every matching scalar goes through production here. They are
    // batched into database names because 4,000-odd separate calls would be
    // slow, and each batch stays under the truncation limit so that no
    // character is cut before it is checked.
    const UNSAFE = /[\u0080-\u009F\u007F\u2028\u2029]|\p{Cf}|\p{Default_Ignorable_Code_Point}/u;
    const unsafe: number[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      // Surrogates are not characters and cannot appear in a parsed value.
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (UNSAFE.test(String.fromCodePoint(cp))) unsafe.push(cp);
    }
    // A guard on the guard: if the property ever matched nothing, or only a
    // handful, every assertion below would pass while checking almost none.
    expect(unsafe.length, "the property matched too few code points").toBeGreaterThan(4000);

    const BATCH = 100;
    for (let at = 0; at < unsafe.length; at += BATCH) {
      const batch = unsafe.slice(at, at + BATCH);
      const first = batch[0].toString(16).toUpperCase();
      const last = batch[batch.length - 1].toString(16).toUpperCase();
      const label = `U+${first}..U+${last}`;
      ambient();
      const name = String.fromCodePoint(...batch);
      const report = redactDsn(`postgresql://u:p@127.0.0.1:5433/db${encodeURIComponent(name)}x`);
      expect(report, `${label} was truncated, so it was not fully exercised`).not.toContain(
        "chars)"
      );
      expect(UNSAFE.test(report), `${label}: one of these survived raw`).toBe(false);
      expect(report.split("\n"), `${label} split the line`).toHaveLength(1);
      // Each one keeps its OWN identity. Round 11 BLOCKER, codex: the
      // escape emitted charCodeAt(0), the HIGH SURROGATE, so every tag
      // character rendered the same and two different databases produced
      // byte-identical reports.
      for (const cp of batch) {
        const escape =
          cp > 0xffff
            ? `${BS}u{${cp.toString(16).padStart(5, "0")}}`
            : `${BS}u${cp.toString(16).padStart(4, "0")}`;
        expect(
          report,
          `U+${cp.toString(16).toUpperCase()} is not named uniquely in the report`
        ).toContain(escape);
      }
    }

    // And the characters the property must NOT touch, or every accented or
    // CJK database name would be rendered unreadable.
    for (const legitimate of ["\u00e9t\u00e9", "\u6570\u636e\u5e93", "db-1_2.3", "caf\u00e9"]) {
      ambient();
      const report = redactDsn(`postgresql://u:p@127.0.0.1:5433/${encodeURIComponent(legitimate)}`);
      expect(report, legitimate).toContain(legitimate);
    }
  });

  it("truncates by code point, never through a surrogate pair", () => {
    // Round 10 BLOCKER. Slicing by UTF-16 code unit severed an emoji and then
    // called 121 code units "121 chars".
    ambient();
    const atLimit = "a".repeat(119) + String.fromCodePoint(0x1f600);
    expect([...atLimit]).toHaveLength(120);
    expect(atLimit.length, "121 UTF-16 units, which is what used to be cut").toBe(121);
    const report = redactDsn(`postgresql://u:p@127.0.0.1:5433/${encodeURIComponent(atLimit)}`);
    // Exactly at the limit by code point, so it is NOT truncated at all.
    expect(report).not.toContain("chars)");
    expect(report).toContain(String.fromCodePoint(0x1f600));
    // No lone surrogate anywhere in the output.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(report)).toBe(false);
    // And the count reported for a genuinely long value is in code points.
    ambient();
    const long = String.fromCodePoint(0x1f600).repeat(130);
    expect(redactDsn(`postgresql://u:p@127.0.0.1:5433/${encodeURIComponent(long)}`)).toContain(
      "... (130 chars)"
    );
  });

  it("reads no file at all, whatever the SSL parameters say", () => {
    // The read is suppressed rather than the string rewritten, which is what
    // let every rewriting bug through. Also proves the guard is REMOVED again.
    ambient();
    const { reads } = readsDuring(() =>
      redactDsn(
        "postgresql://u:p@127.0.0.1:5433/db?sslcert=/etc/hosts&sslkey=/etc/hosts&sslrootcert=/etc/hosts"
      )
    );
    expect(reads.filter(r => r.includes("/etc/hosts"))).toEqual([]);
    // The guard must not survive the call: a later read has to work normally.
    //
    // Round 11 BLOCKER, grok: this used the NAMED import `readFileSync`, which
    // is not a live binding, so it read the original function no matter what
    // was left installed on the module object. With the guard deliberately not
    // restored the assertion still passed, and it was the only check on the
    // restore. Production patches `require("fs").readFileSync`, so the check
    // has to go through that same property.
    const fsModule = require("fs") as { readFileSync: typeof readFileSync };
    expect(fsModule.readFileSync, "the guard was left installed").toBe(pristineReadFileSync);
    expect(fsModule.readFileSync("package.json", "utf8").length).toBeGreaterThan(0);
  });

  it("refuses a string that is not a PostgreSQL DSN rather than inventing a target", () => {
    // pg's parser does not throw on garbage: parse("not a dsn") returns
    // { host: "base", database: "not a dsn" }, so it cannot decide whether the
    // input was a DSN. The scheme is the test.
    ambient();
    expect(redactDsn("not a dsn")).toBe("postgresql (dsn not parseable)");
    expect(redactDsn("")).toBe("postgresql (dsn not parseable)");
    expect(redactDsn("mysql://a/b")).toBe("postgresql (dsn not parseable)");
    // Genuinely malformed: pg throws on this one too, so refusing agrees.
    expect(() => new Client({ connectionString: "postgresql://u:p@:5433/db" })).toThrow();
    expect(redactDsn("postgresql://u:p@:5433/db")).toBe("postgresql (dsn not parseable)");
  });

  it("agrees with pg when the SSL material is real, present and inspected", () => {
    // Round 11 BLOCKER, both reviewers. The read guard returned an EMPTY
    // buffer, on a comment claiming the contents were never used. They are:
    // pg-connection-string assigns `config.ssl.ca` from the bytes and then
    // tests `if (!config.ssl.ca)` in the `uselibpqcompat=true` +
    // `sslmode=verify-ca` branch. An empty CA made that branch THROW for a DSN
    // whose real, non-empty CA satisfies it, so this reported "not parseable"
    // for a target pg resolves and connects to.
    //
    // A real file is used deliberately: pg reads it, this does not, and the two
    // must still agree. That is the whole contract of the guard.
    ambient();
    const realFile = `${process.cwd()}/package.json`;
    expect(pristineReadFileSync(realFile, "utf8").length).toBeGreaterThan(0);
    const dsn =
      `postgresql://u:p@127.0.0.1:5433/db?sslrootcert=${realFile}` +
      "&sslmode=verify-ca&uselibpqcompat=true";
    // pg parses this one: it is a documented libpq-compatible configuration,
    // and pg's own error tells operators to use it.
    expect(expectAgreesWithPg(dsn)).toBe("postgresql host 127.0.0.1 port 5433 database db");
    // And still without reading it.
    const { reads } = readsDuring(() => redactDsn(dsn));
    expect(reads.filter(r => r.includes("package.json"))).toEqual([]);
  });

  it("reads the scheme the way WHATWG does, without copying how WHATWG does it", () => {
    // Round 11 BLOCKER, both reviewers. The gate sanitised a COPY of the string
    // (strip TAB/LF/CR, trim C0) and then applied a `://` regex, which is a
    // hand-maintained reimplementation of WHATWG preprocessing and the sixth
    // instance of this module's defect class. `new URL` performs that
    // preprocessing itself, so these now resolve exactly as pg resolves them
    // instead of being refused.
    for (const dsn of ["postgres:/db", "postgresql:dbname", "postgres:///db"]) {
      ambient();
      expect(() => new Client({ connectionString: dsn }), `pg resolves ${dsn}`).not.toThrow();
      expectAgreesWithPg(dsn);
    }
    // The prefix clause still carries the DSNs `new URL` rejects for a reason
    // that is NOT the scheme: an empty authority throws there while pg retries
    // it with a dummy host. Round 6.
    ambient();
    expect(() => new URL("postgresql://u:p@/db"), "new URL alone cannot gate this").toThrow();
    expect(expectAgreesWithPg("postgresql://u:p@/db")).toBe(
      "postgresql host localhost (default) port 5432 (default) database db"
    );
  });

  it("refuses a scheme broken by a character WHATWG does not strip", () => {
    // The remaining NARROWNESS, stated rather than discovered. WHATWG removes
    // TAB, LF and CR from anywhere, so those agree with pg. A vertical tab is
    // not removed, and pg then resolves a host literally named `base`, its own
    // base URL. Nobody configured that host, so refusing is the more useful
    // answer than naming it, and this pins the choice as a decision.
    ambient();
    const dsn = `post${String.fromCharCode(11)}gresql://u:p@127.0.0.1:5433/db`;
    expect(pgTruth(dsn).host, "pg resolves its own base URL for this").toBe("base");
    expect(redactDsn(dsn)).toBe("postgresql (dsn not parseable)");
  });

  it("accepts both spellings of the scheme", () => {
    ambient();
    expect(expectAgreesWithPg("postgres://u:p@127.0.0.1:5432/db")).toBe(
      "postgresql host 127.0.0.1 port 5432 database db"
    );
  });
});
