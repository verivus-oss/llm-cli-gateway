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

/** The report must NAME each field pg resolved, whatever prose surrounds it. */
function expectAgreesWithPg(dsn: string): string {
  const report = redactDsn(dsn);
  const truth = pgTruth(dsn);
  const bare = truth.host.startsWith("[") ? truth.host.slice(1, -1) : truth.host;
  expect(report, `host for ${dsn}`).toContain(bare);
  expect(report, `port for ${dsn}`).toContain(truth.port);
  expect(report, `database for ${dsn}`).toContain(truth.database);
  return report;
}

describe("redactDsn names the server pg will actually reach", () => {
  it("never emits a URI, so no report can be mistaken for a DSN", () => {
    // Round 6's defect: the round 5 fix annotated provenance INSIDE a URI.
    // PGPORT produced `postgresql://127.0.0.1:6543 (from PGPORT)/db`, which is
    // not a URI at all, and PGDATABASE produced
    // `postgresql://127.0.0.1:5433/ambient_db (from PGDATABASE)`, which IS a
    // valid URI naming a database that does not exist. One shape removes the
    // whole class rather than the two instances.
    const dsns = [
      "postgresql://u:p@127.0.0.1:5432/db",
      "postgresql://u:p@127.0.0.1:5432/db?host=/var/run/postgresql",
      "postgresql://u:p@[::1]:5433/db",
      "postgresql://u:p@127.0.0.1/db",
    ];
    ambient({ PGPORT: "6543" });
    for (const dsn of dsns) expect(redactDsn(dsn), dsn).not.toContain("://");
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
    expect(expectAgreesWithPg("postgresql://u:p@127.0.0.1:5432/db?sslmode=require")).toBe(
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

  it("brackets IPv6 whichever side it arrives from", () => {
    // The authority form arrives bracketed; ?host= arrives bare. Unbracketed
    // output read as `::1:5433`, which is ambiguous about where the port is.
    ambient();
    expect(expectAgreesWithPg("postgresql://u:p@127.0.0.1:5432/db?host=::1")).toBe(
      "postgresql host [::1] port 5432 database db"
    );
    expect(expectAgreesWithPg("postgresql://u:p@[::1]:5433/db")).toBe(
      "postgresql host [::1] port 5433 database db"
    );
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
      "postgresql host 127.0.0.1 port 5432 database u (default: the connecting user)"
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
