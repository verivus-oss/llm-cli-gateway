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
import { FORMAT_KEYWORDS, redactDsn } from "../flight-recorder-pg.js";
import { parsePgDsn } from "../storage/pg-dsn-parse.js";

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

/**
 * `JSON.parse`, after folding `show()`'s astral escape into a real character.
 * `\u{e0061}` is valid JavaScript and NOT valid JSON, so parsing the report
 * verbatim threw. Folding keeps this helper's existing, documented inability to
 * see escaping, without turning it into an exception.
 */
function decodeReportedValue(raw: string): string {
  const folded = raw.replace(/\\u\{([0-9a-f]{1,6})\}/gi, (_match, hex: string) =>
    JSON.stringify(String.fromCodePoint(Number.parseInt(hex, 16))).slice(1, -1)
  );
  return JSON.parse(folded) as string;
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
    return { value: raw.startsWith('"') ? decodeReportedValue(raw) : raw, note };
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
    //
    // ROUND 13 BLOCKER, both reviewers. This used to only DELETE variables, and
    // every test here runs with all four already cleared, so it compared a
    // value against itself. Dropping the `(default)` annotation from production
    // entirely stayed green. SETTING each variable is the check that can fail:
    // an explicitly stated field must survive a probe, a defaulted one must not.
    if (note === "") {
      for (const name of AMBIENT) {
        expect(
          withProbeFor(name)[field],
          `${dsn}: ${field} is reported as stated, but setting ${name} moves it`
        ).toBe(resolvedNow[field]);
        expect(
          withoutVariable(name)[field],
          `${dsn}: ${field} is reported as stated, but removing ${name} moves it`
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
 * Round 13, codex: it also used to THROW on the astral form. `\u{e0061}` is
 * not valid JSON, so `JSON.parse` failed with "Bad Unicode escape" and a test
 * routing such a value through `expectAgreesWithPg` died on the ORACLE rather
 * than on the code. It is folded to a real character before parsing now, which
 * keeps the documented blindness rather than adding a crash on top of it.
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
interface ReadsDuring {
  reads: string[];
  result: string;
  /**
   * What was installed on the fs module the instant `fn` RETURNED, before this
   * helper put the original back.
   *
   * ROUND 13 BLOCKER, codex. The restore assertion used to run after this
   * helper's own `finally` had already restored the function, so disabling
   * production's `finally` outright left the test green: the helper was
   * repairing the very thing the test claimed to measure. Round 12 tried to fix
   * this by changing WHICH reference the assertion read. That was the wrong
   * half. The problem is WHEN it reads.
   *
   * Production restores whatever it found, which is `spy`, so a test can assert
   * `installedAfter === spy` and actually fail when production leaks its stub.
   */
  installedAfter: unknown;
  spy: unknown;
}

function readsDuring(fn: () => string): ReadsDuring {
  const reads: string[] = [];
  const target = require("fs") as { readFileSync: typeof fs.readFileSync };
  const real = target.readFileSync;
  const spy = ((path: unknown, ...rest: unknown[]) => {
    reads.push(String(path));
    return (real as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.readFileSync;
  target.readFileSync = spy;
  try {
    const result = fn();
    return { reads, result, installedAfter: target.readFileSync, spy };
  } finally {
    target.readFileSync = real;
  }
}

/**
 * Mirrors passwordSpan's contract for the test that claims provenance cannot
 * see a given input. Kept deliberately dumb: it asserts only that there is no
 * `user:password@` to scrub, which is the condition being claimed.
 */
/** Mirrors the filler the module uses, so inertness has a subject here. */
const SCRUBBED_PASSWORD_IN_USE = "redacted";

function passwordSpanIsBlind(dsn: string): boolean {
  const marker = dsn.indexOf("//");
  if (marker < 0) return true;
  const start = marker + 2;
  const slash = dsn.indexOf("/", start);
  const at = dsn.lastIndexOf("@", slash < 0 ? dsn.length : slash);
  if (at < start) return true;
  const colon = dsn.indexOf(":", start);
  return colon < 0 || colon > at;
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
      expect(report, dsn).toMatch(/^postgresql (host |socket |\(dsn not parseable\))/);
    }
    // ROUND 7 REVERSED, deliberately. That round required a host to be NAMED
    // `://` and all, on the reasoning that nothing could be carried across the
    // `@` into it. Round 17 falsified the reasoning: `postgres://u:?host=X&@h/db`
    // puts credential text straight into the host, because `?` ends the
    // authority before the `@` ever arrives. Under an allowlist `evil://host`
    // is simply not a hostname, and pg could not resolve it either.
    ambient();
    // ROUND 24. Round 16 withheld this; the host now comes from pg's own
    // resolution and pg resolves it to exactly this string, so naming it is
    // correct. The SHAPE property is held by quoting instead of by withholding,
    // which is why `show` refuses the bare-word form for anything holding `://`.
    expect(redactDsn("postgresql://u:p@127.0.0.1:5432/db?host=evil://host")).toBe(
      'postgresql host "evil://host" port 5432 database db'
    );

    // A DATABASE no longer does, and round 16 gave that up ON PURPOSE. A name
    // holding `://` is indistinguishable from userinfo pg relocated into the
    // path, which is how five spellings of the password reached this report in
    // round 15. Being wrong one way discloses a credential; being wrong the
    // other way tells an operator a database nobody names this way is withheld.
    // This is the ONLY faithfulness the withholding rule costs, and it is
    // asserted here so a later round cannot restore it without reading why.
    // ROUND 16 REVERSED, THEN ROUND 22 REVERSED BACK. Round 21 argued that a
    // strict parse does not need to guess, so a database named `foo://bar`
    // could be named faithfully. Round 22 measured the cost of that: the colon
    // it re-admitted is the opening of an apparent `user:password`, and the
    // corpus found a disclosure through a colon in PATH position that no
    // authority rule sees. The colon is now constrained everywhere except the
    // host:port separator, and this name goes back to being refused.
    //
    // This is the faithfulness the rule costs, recorded so a later round
    // reverses it a third time only after reading what it buys.
    expect(redactDsn("postgresql://u:p@127.0.0.1:5432/foo://bar")).toBe(
      "postgresql (dsn not parseable)"
    );
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
    // ROUND 24 CHANGED THE SECOND HALF. The target used to be named alongside
    // the suppressed read, because this module had its own parser. It now uses
    // pg's, and pg's parse IS the read, so the only way to keep the file shut
    // is to decline to name the target. The connection is unaffected: the core
    // gate carries no ssl rule, so pg still dials it and reads the file itself.
    expect(report).toBe(
      "postgresql (target not named: the dsn names an ssl file this reporter will not open)"
    );
  });

  it("never prints the password, over a GENERATED cross product of DSN shapes", () => {
    // The corpus is BUILT, not listed. Round 14's was 18 shapes I typed out
    // from the previous incident, and it passed while five isomorphic spellings
    // of the same defect leaked, because a list can only contain the failures
    // already known. This enumerates a grammar instead, so a shape nobody
    // thought of is still generated.
    //
    // The secret sits in the PASSWORD position only. A single userinfo token
    // with no colon is a USERNAME by the URL Standard's authority state and by
    // libpq's `user[:password]` grammar, pg parses it to `password: ""`, and
    // reporting it is correct; that case is pinned by its own test below.
    // Round 22. One marker is not enough. `pw/3f9a2c+DO-NOT-PRINT` holds `/`
    // and `+`, and BOTH are refused in a hostname before any leak can be
    // observed: `/` ends the authority and `+` is outside REG_NAME. So every
    // shape that plants the marker in host position self-refused, and the
    // corpus scored that as a pass. The round-22 disclosure used a marker made
    // only of unreserved characters, which is exactly what this second one is.
    const MARKERS = ["pw/3f9a2c+DO-NOT-PRINT", "pw3f9a2cDO-NOT-PRINT"];
    expect(
      MARKERS.some(marker => encodeURIComponent(marker) !== marker),
      "no marker has an encoded spelling that differs, so the encoded assertion is dead"
    ).toBe(true);
    let namedTotal = 0;
    let refusedTotal = 0;
    let corpusTotal = 0;
    for (const SECRET of MARKERS) {
      const USER = "usr-not-a-secret";
      const schemes = ["postgres:", "postgresql:", "POSTGRES:", "PostgreSQL:"];
      const slashes = ["", "/", "//", "///", "////"];
      // Round 17 axis. The old list held only URI userinfo, so it explored one
      // grammar thoroughly and never emitted a `?` BEFORE the `@`, which ends the
      // authority and turns the whole apparent password span into query
      // parameters. Both reviewers found that class; the generator could not.
      const userinfos = [
        "",
        `${USER}:${SECRET}@`,
        `${USER}%3A${SECRET}@`,
        `${USER}:${encodeURIComponent(SECRET)}@`,
        `:${SECRET}@`,
        `${USER}:${SECRET}@@`,
        `${USER}:${SECRET}/x@`,
        `${USER}:?host=${SECRET}&@`,
        `${USER}:?user=${SECRET}&@`,
        `${USER}:?port=6543&host=${SECRET}&@`,
        `${USER}:#${SECRET}@`,
        // Round 22 axes. The list above emits `?` before the `@` and it emits a
        // `#`, but it never emitted the `@` AFTER the `#`, nor `@` in its
        // percent-encoded spelling, and those were the two shapes that got out.
        `${USER}:?host=${SECRET}&user=r#@`,
        `${USER}:?host=${SECRET}&x=%40`,
        `${USER}:?host=${SECRET}&user=r#`,
        `${USER}:?host=${SECRET}#@`,
        `${USER}:${SECRET}#@`,
        `${USER}:${SECRET}%40`,
      ];
      // Round 17 axis. libpq keyword and JDBC property grammars, whose delimiters
      // (`=`, `,`, `;`, `&`, space) the URI parser never treats as boundaries, so
      // the whole run lands in one field intact and no delimiter test can see it.
      const authorities = [
        "",
        "host",
        "127.0.0.1",
        "[::1]:5433",
        "host:5433",
        "/",
        `host=localhost,user=u,password=${SECRET},dbname=db`,
      ];
      // The marker sits ONLY where a password can sit. `/${SECRET}` was here and
      // was wrong: it names a DATABASE `pw-...`, and reporting a database by its
      // real name is the function working, not leaking. A generator that plants
      // the marker in a faithful position manufactures its own failures.
      const paths = [
        "",
        "/",
        "/db",
        `/${USER}:${SECRET}@gw`,
        `/${USER}%3A${SECRET}%40gw`,
        `/db;password=${SECRET}`,
        `/db&password=${SECRET}`,
        `/db%20password=${SECRET}`,
      ];
      const queries = ["", "?host=elsewhere", `?password=${SECRET}`, `?application_name=${SECRET}`];

      const corpus: string[] = [];
      for (const scheme of schemes) {
        for (const slash of slashes) {
          for (const userinfo of userinfos) {
            for (const authority of authorities) {
              for (const path of paths) {
                for (const query of queries) {
                  corpus.push(`${scheme}${slash}${userinfo}${authority}${path}${query}`);
                }
              }
            }
          }
        }
      }
      // Leading junk is a SEPARATE axis, not a shape: one space changes which
      // branch pg's parser takes, because it triggers the encodeURI rewrite.
      const junked: string[] = [];
      for (const code of [32, 9, 10, 13, 0, 27, 11]) {
        for (const dsn of corpus) junked.push(String.fromCharCode(code) + dsn);
      }
      const all = [...corpus, ...junked];

      let named = 0;
      let refused = 0;
      for (const dsn of all) {
        ambient();
        let report: string;
        try {
          report = redactDsn(dsn);
        } catch (error) {
          throw new Error(`redactDsn THREW on ${JSON.stringify(dsn)}: ${String(error)}`);
        }
        expect(report, `report leaked the password for ${JSON.stringify(dsn)}`).not.toContain(
          SECRET
        );
        // pg percent-DECODES, so an encoded leak and a decoded one are the same
        // disclosure. Asserted separately because the two spellings differ.
        expect(
          report,
          `report leaked the encoded password for ${JSON.stringify(dsn)}`
        ).not.toContain(encodeURIComponent(SECRET));
        if (!report.includes("not parseable")) named += 1;
        else refused += 1;
      }

      // GUARDS ON THE GUARD, both of which this test would otherwise satisfy by
      // doing nothing. If every DSN were refused, or none ever tripped the
      // withholding rule, the assertions above would pass over an empty subject.
      // Round 17: `encodeURIComponent(SECRET) === SECRET` for a marker made only
      // of unreserved characters, which made the encoded assertion a duplicate of
      // the plain one and hid the fact that nothing tested the encoded spelling.
      // PER MARKER. A marker whose every shape self-refuses proves nothing, and
      // that is precisely how the first marker hid round 22.
      expect(
        named,
        `every DSN carrying ${SECRET} was refused, so that marker proved nothing`
      ).toBeGreaterThan(200);
      namedTotal += named;
      refusedTotal += refused;
      corpusTotal += all.length;
    }

    expect(corpusTotal, "the generator produced too small a corpus").toBeGreaterThan(4000);
    expect(namedTotal, "every DSN was refused, so this test proved nothing").toBeGreaterThan(500);
    expect(refusedTotal, "nothing was ever refused, so the parser never rejected").toBeGreaterThan(
      100
    );
  });

  it("separates the pair that PROVES no rule over (field, value) can work", () => {
    // Round 17's central falsifier, kept as the first thing a later round reads.
    // Both DSNs make pg resolve host "reporter-host". One is the operator's real
    // target; in the other that text sat where a reader, and libpq's grammar,
    // put the password. By the time a classifier sees ("host", "reporter-host")
    // they are byte-identical, so NO function of the field and value can print
    // the first and withhold the second. Only re-reading the input separates
    // them, which is what passwordSpan exists to do.
    ambient();
    expect(redactDsn("postgres://u:p@real/db?host=reporter-host")).toBe(
      "postgresql host reporter-host port 5432 (default) database db"
    );
    // Round 21 answers it by REFUSING rather than withholding. The two
    // readings of these bytes disagree about where userinfo ends, so there is
    // no honest target to name, and inventing one is what rounds 15 to 19 did.
    expect(redactDsn("postgres://u:?host=reporter-host&@real/db")).toBe(
      "postgresql (dsn not parseable)"
    );
  });

  it("refuses each reject rule's own case, naming WHICH rule fired", () => {
    // A mutation probe showed three rules could be deleted with every test
    // still green, because a later rule caught the same input. Asserting the
    // REASON rather than just the refusal makes each rule a real control: if
    // one is removed, the input is still refused but by a different rule, and
    // that is what these assertions notice.
    ambient();
    const S = "pw-rules-DO-NOT-PRINT";
    const why = (dsn: string): string => {
      const parsed = parsePgDsn(dsn, {});
      if (parsed.ok) throw new Error(`expected a refusal for ${JSON.stringify(dsn)}`);
      return parsed.reason;
    };

    // The SCHEMED keyword/value string. The unschemed spelling never reaches
    // here: the prefix check refuses it first. RFC 3986 admits `=` and `,` in a
    // reg-name as sub-delims, so the generic grammar takes a whole libpq
    // keyword string as one opaque hostname.
    expect(why(`postgres://host=localhost,user=u,password=${S},dbname=db`)).toBe(
      "a keyword-shaped authority is not a URI authority"
    );
    expect(redactDsn(`postgres://host=localhost,password=${S}`)).not.toContain(S);
    // MEMBER-WISE, because the case above carries BOTH separators and either
    // arm alone still refuses it: a mutation probe deleting either arm left all
    // 4836 tests green. The `,` arm is the only rule that sees a comma at all,
    // and the `=` arm is pinned by the REASON, since dropping it lets the
    // decoded-keyword rule below catch the same string under a different name.
    for (const separator of ["=", ","]) {
      expect(why(`postgres://host${separator}localhost/db`), separator).toBe(
        "a keyword-shaped authority is not a URI authority"
      );
    }

    // More than one unencoded `@`. RFC 3986 allows exactly one, so a second
    // means the userinfo boundary is not where it looks.
    expect(why(`postgres://u:${S}@@host/db`)).toBe("more than one unencoded @ in the authority");

    // ROUND 24 DELETED THE USERINFO GRAMMAR RULE, and this records the measured
    // reason rather than the rule. pg accepts `u[1]` and resolves host `host`,
    // so refusing it was our grammar disagreeing with the one that connects.
    // Naming what pg reaches is the job, so it is now named.
    expect(redactDsn("postgres://u[1]:p@host/db")).toBe(
      'postgresql host "host" port 5432 (default) database db'
    );

    // A port with no host is still refused, but by pg rather than by us: pg
    // THROWS on it, and inheriting that is strictly better than a second rule
    // that has to be kept in agreement with it.
    expect(why("postgresql://u:p@:5433/db")).toBe("pg refused the connection string");

    // A raw space is not a URI character, and its presence makes pg rewrite
    // the whole string, changing which characters are structural.
    expect(why("postgresql://u:p@[::1]:5433/db?sslcert=/tmp/foo bar")).toBe(
      "holds a character RFC 3986 requires to be percent-encoded"
    );

    // Decoding may carry data, never structure. This case deliberately holds
    // NO `@` in either spelling: the ambiguity rule below would otherwise
    // refuse it first and this control would stop being executed.
    expect(why(`postgres://host/db=${S}`)).toBe("the database name holds URI or keyword structure");
    // ROUND 24: the ENCODED spelling is named, not refused, and that is pg
    // agreement rather than a gap. pg decodes the path with decodeURI, which
    // leaves every reserved character encoded, so the database pg opens is
    // literally `db%3D...`. No delimiter is reintroduced and no apparent
    // password position exists in this string, so naming it is the job.
    expect(redactDsn(`postgres://host/db%3D${S}`)).toContain(`db%3D${S}`);

    // The prefix rule. Round 22 found it had no pinned reason of its own.
    expect(why(`postgres:/u:${S}@host/db`)).toBe("not a postgresql:// or postgres:// URI");

    // THE AMBIGUITY RULE, in all three spellings round 22 escaped through.
    const ambiguous = "an @ after the authority is ambiguous; it may be relocated userinfo";
    expect(why(`postgres://u:?host=${S}&user=reporter#@real.invalid/db`)).toBe(ambiguous);
    expect(why(`postgres://u:?host=${S}&x=%40real.invalid/db`)).toBe(ambiguous);
    expect(why(`postgres://u:?host=${S}&user=r%40real#@real/db`)).toBe(ambiguous);
    // `#` must end the authority for the rule that follows it. If it does not,
    // the `@` before `evil` is read as the userinfo terminator and everything
    // after it looks clean.
    expect(why(`postgres://u:${S}@host#@evil.invalid/db`)).toBe(ambiguous);

    // ROUND 24 REPLACED THE EMPTY-PORT RULE WITH ITS CLASS. Round 23 named the
    // empty span, so `u:?host=X` was refused and `u:1?host=X` was not: one
    // digit walked past it, which grok found and which is why this is now
    // stated over the shape. All four are the same DSN to a reader.
    // ROUND 24, codex. A query value carrying a WHOLE DSN. pg copies every
    // query key onto its config and `ConnectionParameters` re-parses
    // `connectionString`, so one nesting level re-enters pg's parser BEHIND
    // every rule here. It re-admitted round 23's falsifier and made the
    // reporter open a file it had just refused to open.
    expect(why(`postgres://safe/db?connectionString=postgres://u:1?host=${S}`)).toBe(
      "a query parameter carrying a whole DSN re-enters the parser behind this gate"
    );

    // ROUND 24, grok. An encoded colon ANYWHERE in the authority. Round 24
    // shipped this keyed on there being an `@`, and the sibling next to it
    // printed the secret as the host.
    const hidden = "an encoded colon in the authority is a delimiter in hiding";
    expect(why(`postgres://u%3A${S}`)).toBe(hidden);
    expect(why(`postgres://u%3A${S}/db`)).toBe(hidden);
    expect(why(`postgres://%3A${S}/db`)).toBe(hidden);
    expect(why(`postgres://usr%3A${S}@host/db`)).toBe(hidden);
    // The `i` flag on that pattern is a CONTROL, not decoration: `%3a` is a
    // valid spelling of the same delimiter and pg decodes both. Dropping the
    // flag killed nothing until this case existed.
    expect(why(`postgres://usr%3a${S}@host/db`)).toBe(hidden);

    // MEMBER-WISE, not rule-wise. Round 24's matrix mutated whole rules and
    // called fourteen kills coverage; codex showed removing a single MEMBER of
    // either enumerated set kills nothing, because every pinned case also
    // carried another member. A check that enumerates the set it governs has
    // that enumeration inside its own blast radius, so each member gets a case
    // no other member catches.
    for (const key of ["host", "port", "user", "dbname"]) {
      expect(why(`postgres://u:1?${key}=${S}`), key).toBe(
        "a colon in the authority with a target parameter is an apparent password"
      );
    }
    for (const separator of [";", "=", "&"]) {
      expect(why(`postgres:///db${separator}x`), separator).toBe(
        "the database name holds URI or keyword structure"
      );
    }

    // ROUND 25. Both reviewers reached ONE class from two different components,
    // which is what showed the rule had only ever been true of the path.
    // codex, through the authority percent-encoded:
    expect(why(`postgres://host%3Bpassword%3D${S}/db`)).toBe(
      "the authority decodes to keyword structure"
    );
    expect(why(`postgres://host%3Dlocalhost%2Cpassword%3D${S}/db`)).toBe(
      "the authority decodes to keyword structure"
    );
    // grok, through a target parameter's value, raw and encoded and space-run:
    const inAValue = "a target parameter's value holds keyword structure";
    expect(why(`postgres://u:p@h.invalid/db?host=x;password=${S}`)).toBe(inAValue);
    expect(why(`postgres://u:p@h.invalid/db?host=x%3Bpassword%3D${S}`)).toBe(inAValue);
    expect(why(`postgres://u:p@h.invalid/db?host=password=${S}`)).toBe(inAValue);
    expect(why(`postgres://u:p@h.invalid/db?host=x%20password%3D${S}`)).toBe(inAValue);
    expect(why(`postgres://h.invalid?user=alice;password=${S}`)).toBe(inAValue);

    // And the shape the VALUE rule must not eat: it is scoped to the parameters
    // pg resolves into the target, so a parameter that moves nothing carries no
    // keyword structure worth refusing. Removing that scope refuses strictly
    // more, which no assertion here noticed until this one.
    expect(redactDsn("postgres://h.invalid/db?application_name=svc;role=admin")).toBe(
      "postgresql host h.invalid port 5432 (default) database db"
    );

    // And the shape the rule must NOT eat. A space is deliberately absent from
    // the keyword set: `db name` is a database PostgreSQL opens, and every
    // keyword run carries an `=` that is caught anyway.
    expect(redactDsn("postgresql://u:p@h.invalid/db%20name")).toBe(
      'postgresql host h.invalid port 5432 (default) database "db name"'
    );

    // A target parameter given twice. pg takes the LAST silently, so the string
    // means two different targets to two readers of it. The authority here
    // holds no colon, so this is the case ONLY this rule catches: a mutation
    // probe removing it left all 40 tests passing until this was written.
    expect(why("postgres://h.invalid/db?host=first&host=second")).toBe(
      "a target parameter is given more than once"
    );

    const apparent = "a colon in the authority with a target parameter is an apparent password";
    expect(why(`postgres://u:?host=${S}&user=reporter#`)).toBe(apparent);
    expect(why(`postgres://u:1?host=${S}`)).toBe(apparent);
    expect(why(`postgres://u:65535?host=${S}`)).toBe(apparent);
    expect(why(`postgres://u:5432?host=${S}&user=r`)).toBe(apparent);
    // And the shape it must NOT eat: an ordinary host:port with no parameter
    // moving the target is the commonest DSN there is.
    expect(redactDsn("postgres://h.invalid:5433/db")).toBe(
      "postgresql host h.invalid port 5433 database db"
    );

    // THE COLON RULES. These two overlap heavily, so each is pinned by a case
    // the OTHER does not catch. A mutation probe that disabled either one
    // alone left all 40 tests passing until these were written.
    //
    // Only the raw-path rule sees this: the database comes from the query, so
    // the name check never inspects the path segment holding the colon.
    expect(why(`postgres:///usr:?host=h.invalid&dbname=safe`)).toBe(
      "a colon outside the authority opens an apparent password"
    );
    // ROUND 24: same reasoning as the encoded `=` above. pg leaves `%3A`
    // encoded, so no colon exists in the database it opens, and this string
    // holds no apparent password position at all. The RAW colon is what is
    // refused, and it is pinned by the empty-authority case above.
    expect(redactDsn(`postgres://host/db%3A${S}`)).toContain(`db%3A${S}`);
  });

  it("keeps the ambiguity rule from eating the DSNs it is supposed to allow", () => {
    // A password containing `@` is spelled with `%40` INSIDE the userinfo, and
    // that is the correct spelling, not an attack. The rule scans only what
    // follows the userinfo terminator, so this must still be reported in full.
    // Without this test the cheapest way to pass the round-22 cases is to
    // refuse every `%40`, which would refuse a large share of real DSNs.
    expect(redactDsn("postgres://u:p%40ss@db.invalid:5433/app")).toBe(
      "postgresql host db.invalid port 5433 database app"
    );
    expect(redactDsn("postgresql:///db?host=/var/run/postgresql")).toBe(
      "postgresql socket /var/run/postgresql port 5432 (default) database db"
    );
    expect(redactDsn("postgresql://u:p@[::1]:5433/db")).toBe(
      "postgresql host [::1] port 5433 database db"
    );
  });

  it("records the price the ambiguity rule charges, so it is a decision and not a surprise", () => {
    // KNOWN COST, accepted deliberately in round 22. An `@` percent-encoded in
    // a QUERY value is refused even though pg connects with it, because the
    // rule cannot tell it from a relocated userinfo without re-introducing the
    // per-component reasoning that this class escaped three times.
    //
    // The report degrades to the unparseable line. Nothing about the
    // CONNECTION changes: db.ts hands pg the original string.
    expect(redactDsn("postgresql://host/db?user=alice%40srv")).toBe(
      "postgresql (dsn not parseable)"
    );
  });

  it("refuses a keyword/value DSN, which the withholding rule alone would NOT catch", () => {
    // The scheme gate is SECURITY, not input hygiene, and this test exists so
    // it cannot be relaxed by someone who reads it as the latter.
    //
    // node-postgres is not libpq. It does not reject a keyword/value string, it
    // MISPARSES it, putting the entire string, password included, into the
    // database:
    //
    //   host=localhost user=u password=PW dbname=db
    //     host      "base"
    //     database  "host=localhost user=u password=PW dbname=db"
    //
    // The withholding rule cannot save this. Its delimiters are the ones that
    // separate URI components, and that string contains none of them: `=` and
    // the spaces are not boundaries a URI parser could have carried text over.
    // Refusing the DSN outright is what keeps the password out of the report.
    ambient();
    const SECRET = "pw-kv-DO-NOT-PRINT";
    const report = redactDsn(`host=localhost user=u password=${SECRET} dbname=db`);
    expect(report).toBe("postgresql (dsn not parseable)");
    expect(report).not.toContain(SECRET);
  });

  it("reports a lone userinfo token, because that is a USERNAME and not a password", () => {
    // NOT a leak, and round 15 recorded it as one. The URL Standard's authority
    // state assigns a colon-less userinfo buffer to username, which is libpq's
    // `user[:password]` grammar; pg parses `password` to the empty string, and
    // then applies its dbname-defaults-to-user rule. Withholding here would
    // break every ordinary `postgres://alice@host`, where alice IS the database
    // pg opens. libpq agrees: its PQconninfoOption table marks `user` with the
    // displayable dispchar "" and only `password`/`sslpassword` with "*".
    ambient();
    expect(redactDsn("postgres://alice@db.invalid")).toBe(
      "postgresql host db.invalid port 5432 (default) database alice (default: the connecting user, from the DSN)"
    );
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
    // Round 21 names all four again. There is no host allowlist: the parse
    // either produced a target or refused the string, so a value that reached
    // here IS what pg resolved, and round 8's rule holds unchanged. Round 18
    // withheld `[foo]` and `[]` on the theory that neither is an address; that
    // was a guess layered on a parse it did not trust, and both reviewers said
    // so.
    for (const [query, pgHost, reported] of [
      ["%5Bfoo%5D", "[foo]", "[foo]"],
      ["%5B%5D", "[]", "[]"],
      ["%5B127.0.0.1%5D", "[127.0.0.1]", "[127.0.0.1]"],
      [":", ":", ":"],
    ]) {
      const dsn = `postgresql://u:p@127.0.0.1:5433/db?host=${query}`;
      expect(pgTruth(dsn).host, `pg host for ${query}`).toBe(pgHost);
      expect(redactDsn(dsn), query).toBe(`postgresql host ${reported} port 5433 database db`);
    }
  });

  it("quotes a value that collides with the format's own keywords", () => {
    // Round 8: `?host=port` printed `postgresql host port port 5433 database
    // db`. It agreed with pg and was unreadable. The value is still named.
    // DERIVED FROM THE SET, not from a list of it. Two hand-written loops
    // covered six of the seven members between them and `postgresql` was in
    // neither, so deleting it from the set killed nothing. A check that
    // enumerates the set it governs has that enumeration inside its own blast
    // radius; iterating the set means a new member arrives with its case.
    expect(FORMAT_KEYWORDS.size).toBeGreaterThan(0);
    for (const word of FORMAT_KEYWORDS) {
      ambient();
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

    // And the third arm, which no case here produced: NO user in the DSN and no
    // PGUSER either, so pg falls back to the OS user. Deleting that switch case
    // left the suite green, and the line then read `(default)`, which sends the
    // reader looking for a default database name that does not exist. The user
    // is whoever runs this, so the ANNOTATION is asserted and not the name.
    ambient();
    const osUser = redactDsn("postgresql://127.0.0.1:5433");
    expect(osUser).toContain(" (default: the connecting user)");
    expect(osUser).not.toContain("(default: the connecting user, from");
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
    // A value that mimics the format's own delimiters used to be QUOTED. Round
    // 18 refuses it instead: a database name holding spaces is not a name pg
    // would open, and the shape allowlist reaches it before `show` does. The
    // quoting still exists for values that pass the allowlist, such as a socket
    // path containing `@`, which the faithfulness cases below exercise.
    // Round 21 names it again, QUOTED. There is no database allowlist any more:
    // `db port 9999 database other` is a database PostgreSQL can open, and the
    // reviewers were right that refusing it bought no secrecy. Quoting is the
    // CWE-117 output-neutralisation control, and it is enough.
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
    // Redirected at the SOCKET PATH in round 18. A database name holding a
    // bidi override is refused outright now, so this property would have had no
    // live subject there; a socket path still admits one and still needs it.
    const report = redactDsn("postgresql://u:p@127.0.0.1:5433/db?host=%2Fs%E2%80%AEgnirts");
    expect(report).not.toMatch(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/);
    expect(report).toBe('postgresql socket "/s\\u202egnirts" port 5433 database db');
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
    // Round 21 removed the database allowlist, so `show`'s own bound is the
    // control again and it is reachable. It must SAY it truncated, and say the
    // real length, or the report quietly names a database pg did not open.
    expect(report).toContain("... (300 chars)");
    // A name inside the bound is untouched.
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
    // ROUND 24. The point survives in a weaker form: a cert that does not exist
    // must not make this THROW or hang, and it does not, because the file is
    // never opened. What it no longer does is name the target, since naming it
    // now requires pg's parse and pg's parse is what opens the file.
    expect(
      redactDsn("postgresql://u:p@127.0.0.1:5433/db?sslcert=/nonexistent/cert.pem&host=good")
    ).toBe("postgresql (target not named: the dsn names an ssl file this reporter will not open)");
  });

  it("reads no SSL file in any form, and moves no target doing it", () => {
    // These spellings were the STRIPPER's edge cases, kept as target-agreement
    // cases after the stripper was deleted: whatever pg reads them as, the
    // reported target must still be the one pg resolves.
    ambient();
    const withOverride = "postgresql host elsewhere port 5433 database db";
    // ROUND 24 SPLIT THIS TABLE. The reporter declines exactly the spellings pg
    // would OPEN, and no more: pg reads under `if (config.sslcert)` with
    // case-sensitive keys, so an uppercase key and a valueless key open nothing
    // and must still be named. Refusing those would be a refusal pg's own
    // behaviour does not earn, and it is how an over-broad guard hides.
    const declined =
      "postgresql (target not named: the dsn names an ssl file this reporter will not open)";
    for (const [query, expected] of [
      ["sslcert=/etc/hosts&host=elsewhere", declined],
      ["SSLCERT=/etc/hosts&host=elsewhere", withOverride],
      ["sslcert=/etc/hosts&sslcert=/etc/hosts&host=elsewhere", declined],
      ["sslcert&host=elsewhere", withOverride],
      ["host=elsewhere&sslkey=/etc/hosts", declined],
      ["host=elsewhere&sslrootcert=/etc/hosts", declined],
      ["sslcert=/etc/hosts&host=elsewhere#frag", declined],
    ] as const) {
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
      expect(result, query).toBe(expected);
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
    // Round 21 REFUSES both, and this direction is a deliberate faithfulness
    // loss: pg accepts this one. A raw space is not a URI character, and its
    // presence makes pg rewrite the WHOLE string with encodeURI, so the same
    // bytes mean different things with and without it. Refusing the character
    // refuses the divergence rather than betting on which reading wins.
    expect(redactDsn(ipv4)).toBe("postgresql (dsn not parseable)");
  });

  it("reads no SSL file whose key carries characters WHATWG removes", () => {
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

  it("refuses a DSN whose scheme is only a scheme after preprocessing", () => {
    // ROUND 13 BLOCKER, and a REVERSAL of rounds 9, 10 and 12.
    //
    // Those rounds each treated "this disagrees with pg" as the defect and
    // widened the gate until it matched what pg resolves. Round 13 measured the
    // cost. pg resolves a string with no authority by putting the INPUT IN THE
    // PATH, so widening the gate to accept these made redactDsn print the
    // password:
    //
    //   " postgresql://u:sup3rsecret@h/db" -> database " postgresql://u:sup3r..."
    //
    // The previous version of this test asserted exactly that and called it "a
    // loud signal", using toContain("host base port 5432"), which never looks
    // at the database field where the password sits.
    //
    // Agreeing with pg is now subordinate to not printing secrets. Every string
    // below is one pg WOULD resolve to something. All are refused.
    for (const code of [32, 9, 10, 13, 0, 27]) {
      ambient();
      const dsn = String.fromCharCode(code) + "postgresql://u:p@127.0.0.1:5433/db";
      expect(redactDsn(dsn), `leading U+${code}`).toBe("postgresql (dsn not parseable)");
    }
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

  it("never leaks pg's internal dummy hostname", () => {
    // Round 10 BLOCKER, both reviewers. pg rewrites `@/` to `@___DUMMY___/`
    // and sets a PRIVATE flag that turns the hostname back into "". The old
    // code copied the rewrite, not the flag, then serialised the URL, so
    // adding a cert parameter to an empty-authority DSN reported host
    // `___DUMMY___` while pg used localhost. Nothing is serialised now.
    // ROUND 24. Two of these spellings are now declined for naming an ssl file,
    // so they are asserted on the refusal line. The other two still exercise
    // the round-10 property against pg, which is the point of the test: pg's
    // own `connectionParameters` resolves the rewrite back to localhost, so the
    // defect is gone at its source rather than guarded against here.
    for (const query of ["", "?SSLCERT=/etc/hosts"]) {
      ambient();
      const report = expectAgreesWithPg(`postgresql://u:p@/db${query}`);
      expect(report, query).not.toContain("DUMMY");
      expect(report, query).toBe(
        "postgresql host localhost (default) port 5432 (default) database db"
      );
    }
    for (const query of ["?sslcert=/etc/hosts", "?sslkey=/etc/hosts"]) {
      ambient();
      const report = redactDsn(`postgresql://u:p@/db${query}`);
      expect(report, query).not.toContain("DUMMY");
      expect(report, query).toBe(
        "postgresql (target not named: the dsn names an ssl file this reporter will not open)"
      );
    }
  });

  it("refuses a scheme broken by a control character, wherever it sits", () => {
    // ROUND 13, reversing round 10. Round 10 blocked because a TAB inside the
    // scheme made this answer "not parseable" while pg resolved the real host,
    // and its fix was a sanitiser; round 12 replaced that with `new URL`, whose
    // trimming is what let a credential through. The gate is a prefix test on
    // the raw string now, so an interior control character refuses again.
    //
    // Pinned deliberately, not discovered: `config.ts` rejects the same string,
    // so a DSN in this shape cannot reach a live connection either.
    for (const code of [9, 10, 13, 11, 12]) {
      ambient();
      const dsn = `post${String.fromCharCode(code)}gresql://u:p@127.0.0.1:5433/db`;
      expect(redactDsn(dsn), `interior U+${code}`).toBe("postgresql (dsn not parseable)");
    }
    // What pg does with one of them, so the cost of refusing is on the record
    // rather than implied: it resolves a host literally named `base`, its own
    // base URL, which is nobody's configured target.
    ambient();
    const vertical = `post${String.fromCharCode(11)}gresql://u:p@127.0.0.1:5433/db`;
    expect(pgTruth(vertical).host, "pg resolves its own base URL for this").toBe("base");
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
    // Asserted after the loop: both arms must actually run, or one of the two
    // safe outcomes is being claimed without ever having been exercised.

    // Back to 100 with the DATABASE as the carrier. Round 18 had to move this
    // into a byte-bounded socket path because its allowlist refused any
    // database holding these code points; round 21 removed that allowlist.
    const BATCH = 100;
    let escaped = 0;
    let refused = 0;
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
      // Each one keeps its OWN identity, IN ORDER. Round 11 BLOCKER, codex:
      // the escape emitted charCodeAt(0), the HIGH SURROGATE, so every tag
      // character rendered identically and two different databases produced
      // byte-identical reports.
      //
      // ROUND 13, codex: asserting that each escape appeared SOMEWHERE let a
      // batch be reversed and stay green, so it checked the set and not the
      // sequence. A report naming the right characters in the wrong order names
      // a different database. The run is built and compared as one string.
      const escapes = batch.map(cp =>
        cp > 0xffff
          ? `${BS}u{${cp.toString(16).padStart(5, "0")}}`
          : `${BS}u${cp.toString(16).padStart(4, "0")}`
      );
      // TWO safe outcomes, and the test must accept both or it lies about one.
      // A batch containing U+2028 or U+2029 is REFUSED by the socket grammar,
      // because JS `\s` counts them as whitespace; the rest reach `show` and
      // come back escaped. Refusing is at least as safe as escaping, so the
      // invariant asserted above (no raw unsafe code point, one line) is what
      // binds, and this only records which arm ran.
      if (report.includes("not parseable")) refused += 1;
      else {
        escaped += 1;
        expect(report, `${label} is not rendered in order`).toContain(`db${escapes.join("")}x`);
      }
    }

    expect(escaped, "no batch ever reached `show`, so escaping went untested").toBeGreaterThan(0);

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
    // Round 18: the bound that acts is the allowlist's BYTE budget, not show's
    // code-point trim, which no reported field can now reach. The property that
    // still matters is that no bound ever leaves half a surrogate pair behind.
    const atLimit = "a".repeat(119) + String.fromCodePoint(0x1f600);
    expect([...atLimit]).toHaveLength(120);
    expect(atLimit.length, "121 UTF-16 units, which is what used to be cut").toBe(121);
    const report = redactDsn(`postgresql://u:p@127.0.0.1:5433/${encodeURIComponent(atLimit)}`);
    // Exactly at the limit by code point, so it is NOT truncated at all.
    expect(report).not.toContain("chars)");
    expect(report).toContain(String.fromCodePoint(0x1f600));
    // No lone surrogate anywhere in the output.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(report)).toBe(false);
    // And the count reported for a genuinely long value is in CODE POINTS.
    ambient();
    const long = String.fromCodePoint(0x1f600).repeat(130);
    const over = redactDsn(`postgresql://u:p@127.0.0.1:5433/${encodeURIComponent(long)}`);
    expect(over).toContain("... (130 chars)");
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(over)).toBe(false);
  });

  it("reads no file at all, whatever the SSL parameters say", () => {
    // The read is suppressed rather than the string rewritten, which is what
    // let every rewriting bug through. Also proves the guard is REMOVED again.
    ambient();
    const { reads, installedAfter, spy } = readsDuring(() =>
      redactDsn(
        "postgresql://u:p@127.0.0.1:5433/db?sslcert=/etc/hosts&sslkey=/etc/hosts&sslrootcert=/etc/hosts"
      )
    );
    expect(reads.filter(r => r.includes("/etc/hosts"))).toEqual([]);
    // The guard must not survive the call. Checked at the only instant that
    // can fail: what production left installed when it RETURNED, captured
    // by `readsDuring` before that helper restored anything.
    //
    // Two earlier versions of this assertion could not fail at all. Round
    // 11 read a named import, which is not a live binding. Round 12 moved
    // it to the module property but still read it AFTER `readsDuring` had
    // put the original back, so production skipping its own `finally`
    // stayed green. Round 13, codex.
    expect(installedAfter, "production left its own stub installed").toBe(spy);
    // And nothing outlived the helper either, through the same property.
    const fsModule = require("fs") as { readFileSync: typeof readFileSync };
    expect(fsModule.readFileSync, "the guard outlived the helper").toBe(pristineReadFileSync);
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
    // ROUND 24 RETIRED THE AGREEMENT HALF OF THIS TEST, and the round-11 defect
    // it was built for went with it. That defect was a read guard returning an
    // EMPTY buffer, which made pg's own `if (!config.ssl.ca)` branch throw for a
    // DSN whose real CA satisfies it. There is no read guard now: the reporter
    // does not call pg's parse at all when an ssl file is named, so there is no
    // half-read state left to disagree about.
    //
    // What must still hold, and is the reason this keeps a REAL file: the
    // reporter opens nothing, even when the file is present and readable.
    const { reads, result } = readsDuring(() => redactDsn(dsn));
    expect(result).toBe(
      "postgresql (target not named: the dsn names an ssl file this reporter will not open)"
    );
    expect(reads.filter(r => r.includes("package.json"))).toEqual([]);
  });

  it("refuses every scheme spelling that is not the authority form", () => {
    // ROUND 13 BLOCKER, reversing round 12. `new URL(dsn).protocol` accepted an
    // opaque path, and pg then resolved the credential into the database:
    //
    //   redactDsn("postgres:/user:sup3rsecret@host/db")
    //     -> database "user:sup3rsecret@host/db"
    //
    // pg resolves all of these to something. None is a spelling this gateway
    // admits, and `carriesPostgresDsnScheme` is the same predicate `config.ts`
    // validates with, so the gate and the validator cannot drift apart.
    for (const dsn of [
      "postgres:/db",
      "postgresql:dbname",
      "pg://127.0.0.1/db",
      "socket:/var/run/postgresql?db=gw",
      "/var/run/postgresql gw",
    ]) {
      ambient();
      expect(redactDsn(dsn), dsn).toBe("postgresql (dsn not parseable)");
    }
    // The authority form still works, including the two empty-authority
    // spellings. `postgres:///db` is `postgres://` plus an empty host, and
    // `postgresql://u:p@/db` is the one pg retries with a dummy host, which is
    // round 6 and must not regress. Neither can echo a credential, because the
    // authority delimiter is what makes pg parse userinfo AS userinfo.
    ambient();
    expect(expectAgreesWithPg("postgres:///db")).toBe(
      "postgresql host localhost (default) port 5432 (default) database db"
    );
    ambient();
    expect(expectAgreesWithPg("postgresql://u:p@/db")).toBe(
      "postgresql host localhost (default) port 5432 (default) database db"
    );
    // Case-insensitive, because pg lowercases the scheme and this one connects.
    ambient();
    expect(expectAgreesWithPg("POSTGRESQL://u:p@127.0.0.1:5433/db")).toBe(
      "postgresql host 127.0.0.1 port 5433 database db"
    );
  });

  it("accepts both spellings of the scheme", () => {
    ambient();
    expect(expectAgreesWithPg("postgres://u:p@127.0.0.1:5432/db")).toBe(
      "postgresql host 127.0.0.1 port 5432 database db"
    );
  });
});
