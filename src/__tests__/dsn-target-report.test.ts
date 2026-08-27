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
import fs from "fs";
import { createRequire } from "module";
import { afterEach, describe, expect, it } from "vitest";
import { redactDsn, withoutSslFileParams } from "../flight-recorder-pg.js";

const require = createRequire(import.meta.url);
const { Client } = require("pg") as {
  Client: new (config: { connectionString: string }) => {
    host?: string;
    port?: number;
    database?: string;
  };
};

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
function pgTruth(dsn: string): { host: string; port: string; database: string } {
  const c = new Client({ connectionString: dsn });
  return {
    host: String(c.host ?? ""),
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
function fieldsOf(report: string): { kind: string; host: string; port: string; database: string } {
  let at = 0;
  const eat = (literal: string): void => {
    expect(report.slice(at, at + literal.length), `expected ${literal} at ${at} in ${report}`).toBe(
      literal
    );
    at += literal.length;
  };
  const value = (): string => {
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
    // An annotation such as ` (from PGPORT)` belongs to this field, not the next.
    if (report.startsWith(" (", at)) {
      const close = report.indexOf(")", at);
      at = close === -1 ? report.length : close + 1;
    }
    return raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
  };
  eat("postgresql ");
  const kind = value();
  eat(" ");
  const host = value();
  eat(" port ");
  const port = value();
  eat(" database ");
  const database = value();
  expect(at, `trailing text in ${report}`).toBe(report.length);
  return { kind, host, port, database };
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
  expect(got.host, `host for ${dsn}`).toBe(truth.host);
  expect(got.port, `port for ${dsn}`).toBe(truth.port);
  expect(got.database, `database for ${dsn}`).toBe(truth.database);
  return report;
}

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
    // Stripping those parameters must not lose the ones that MOVE the target.
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
    // for a cert that does not exist; this function strips those parameters, so
    // it answers where the connection was going. That is what makes it useful
    // in the error message about the failure. Measured: with a cert file that
    // DOES exist, pg resolves host `good`, exactly what is reported here.
    ambient();
    expect(
      redactDsn("postgresql://u:p@127.0.0.1:5433/db?sslcert=/nonexistent/cert.pem&host=good")
    ).toBe("postgresql host good port 5433 database db");
  });

  it("strips SSL file parameters in every form without moving the target", () => {
    // A stripper that dropped the wrong parameter would change the reported
    // target, which is worse than the disk read it exists to prevent.
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

  it("strips SSL file parameters whose names are percent-encoded", () => {
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

  it("accepts both spellings of the scheme", () => {
    ambient();
    expect(expectAgreesWithPg("postgres://u:p@127.0.0.1:5432/db")).toBe(
      "postgresql host 127.0.0.1 port 5432 database db"
    );
  });
});

describe("the SSL-parameter stripper itself", () => {
  // Called directly. Two of its branches are broader than pg and so cannot be
  // seen through redactDsn: pg does not read a file for an uppercase SSLCERT,
  // and pg ignores fragments. Mutating either failed nothing until this
  // describe existed, which is the whole reason it exists.
  it("removes exactly the three file-reading parameters, whatever their case", () => {
    expect(withoutSslFileParams("postgresql://h/db?sslcert=/x&host=e")).toBe(
      "postgresql://h/db?host=e"
    );
    expect(withoutSslFileParams("postgresql://h/db?SSLCERT=/x&host=e")).toBe(
      "postgresql://h/db?host=e"
    );
    expect(withoutSslFileParams("postgresql://h/db?SslKey=/x&host=e")).toBe(
      "postgresql://h/db?host=e"
    );
    expect(withoutSslFileParams("postgresql://h/db?sslrootcert=/x&host=e")).toBe(
      "postgresql://h/db?host=e"
    );
    expect(withoutSslFileParams("postgresql://h/db?sslcert=/x&sslkey=/y&sslrootcert=/z")).toBe(
      "postgresql://h/db"
    );
  });

  it("keeps a parameter that merely STARTS with one of the three names", () => {
    // A prefix match here would silently drop an unrelated parameter, and if
    // that parameter were `host` or `port` it would move the reported target.
    expect(withoutSslFileParams("postgresql://h/db?sslcertificate=x&host=e")).toBe(
      "postgresql://h/db?sslcertificate=x&host=e"
    );
    expect(withoutSslFileParams("postgresql://h/db?sslmode=require")).toBe(
      "postgresql://h/db?sslmode=require"
    );
  });

  it("keeps the fragment, wherever the stripped parameter sits", () => {
    // With the stripped parameter LAST, a naive split takes the fragment with
    // it. pg ignores fragments, so redactDsn cannot see this; the stripper's
    // contract is still to return the same DSN minus those parameters.
    expect(withoutSslFileParams("postgresql://h/db?host=e&sslcert=/x#frag")).toBe(
      "postgresql://h/db?host=e#frag"
    );
    expect(withoutSslFileParams("postgresql://h/db?sslcert=/x#frag")).toBe(
      "postgresql://h/db#frag"
    );
  });

  it("leaves a DSN it has no business touching exactly as it found it", () => {
    for (const dsn of [
      "postgresql://h/db",
      "postgresql://h/db?",
      "postgresql://h/db?host=e",
      "postgresql://h/db#frag",
      "postgresql://h/sslcert=x",
    ]) {
      expect(withoutSslFileParams(dsn), dsn).toBe(dsn);
    }
  });
});
