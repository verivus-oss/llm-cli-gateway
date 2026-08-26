import { describe, expect, it } from "vitest";
import { Client } from "pg";
// @ts-expect-error -- plain ESM script, no type declarations by design.
import { assertFixtureDsn, canonicalDsn, describeFixture } from "../../scripts/pg-fixture.mjs";

/**
 * The guard in front of a DESTRUCTIVE reset.
 *
 * `scripts/pg-fixture.mjs` issues `DROP DATABASE` against a server sitting one
 * port away from the operator's live gateway database, so this file is the
 * ratchet on the only thing standing between a typo and data loss.
 *
 * It exists because the guard has already been wrong twice, both times in ways
 * that LOOKED correct: a stale-role sweep whose LIKE prefixes matched nothing,
 * and an allowlist that validated the WHATWG URL authority while `pg` connected
 * using query parameters instead. Neither was caught by a test, because there
 * were none.
 */

/** Collects the refusal instead of exiting, so a refusal is assertable. */
function refusalOf(dsn: string): string | null {
  let reason: string | null = null;
  assertFixtureDsn(dsn, (message: string) => {
    reason = message;
    return null;
  });
  return reason;
}

const VALID = "postgresql://test:test@127.0.0.1:5433/llm_gateway_test";

describe("the fixture DSN guard", () => {
  it("accepts the fixture and reports its identity without credentials", () => {
    const fixture = assertFixtureDsn(VALID);

    expect(fixture).toMatchObject({
      host: "127.0.0.1",
      port: 5433,
      user: "test",
      database: "llm_gateway_test",
    });
    // The printable form must never carry the password.
    expect(describeFixture(fixture)).toBe("127.0.0.1:5433/llm_gateway_test");
    expect(describeFixture(fixture)).not.toContain("test:test");
  });

  describe("refuses anything not provably disposable", () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      [
        "the operator's live port",
        "postgresql://test:test@127.0.0.1:5432/llm_gateway_test",
        "5432",
      ],
      [
        "an absent port, which MEANS 5432",
        "postgresql://test:test@127.0.0.1/llm_gateway_test",
        "no port",
      ],
      [
        "another database on the fixture port",
        "postgresql://test:test@127.0.0.1:5433/gateway",
        "refusing database",
      ],
      [
        "a non-loopback host",
        "postgresql://test:test@db.example.com:5433/llm_gateway_test",
        "refusing host",
      ],
      [
        "localhost, whose resolution is not pinned",
        "postgresql://test:test@localhost:5433/llm_gateway_test",
        "refusing host",
      ],
      [
        "a non-postgres scheme",
        "mysql://test:test@127.0.0.1:5433/llm_gateway_test",
        "refusing protocol",
      ],
      ["an unparseable string", "not a url", "not a parseable URL"],
      ["a fragment", "postgresql://test:test@127.0.0.1:5433/llm_gateway_test#x", "fragment"],
    ];

    for (const [label, dsn, expected] of cases) {
      it(`refuses ${label}`, () => {
        expect(refusalOf(dsn)).toContain(expected);
      });
    }
  });

  /**
   * The round-2 blocker, kept as an executable statement rather than a comment.
   *
   * `pg-connection-string` copies query parameters BEFORE falling back to the
   * URL authority, so `?host=`/`?port=` silently win. A guard reading
   * `url.port` therefore approved 5433 while the client connected to 5432.
   */
  describe("the query-parameter bypass", () => {
    const bypasses = [
      `${VALID}?port=5432`,
      `${VALID}?host=db.example.com`,
      `${VALID}?host=/tmp`,
      `${VALID}?options=-c%20search_path%3Devil`,
      `${VALID}?port=5432&host=elsewhere`,
    ];

    for (const dsn of bypasses) {
      it(`refuses ${dsn.slice(VALID.length)}`, () => {
        expect(refusalOf(dsn)).toContain("query parameters");
      });
    }

    it("proves the bypass was real, so this guard is not theatre", async () => {
      // Not a claim about our code: a claim about the client library. If pg ever
      // stops honouring these, this test says so rather than quietly passing.
      const client = new Client({ connectionString: `${VALID}?port=5432` });
      expect(client.port).toBe(5432);
      expect(assertFixtureDsn(`${VALID}?port=5432`, () => null)).toBeNull();
    });
  });

  /**
   * The actual invariant. Validating one representation and handing a DIFFERENT
   * one to the dangerous operation is the defect class behind both bugs above,
   * so assert on what `pg` RESOLVES rather than on what the string looks like.
   */
  describe("what was validated is what gets connected to", () => {
    it("resolves the canonical DSN to the validated host, port and database", () => {
      const fixture = assertFixtureDsn(VALID);
      const client = new Client({ connectionString: canonicalDsn(fixture) });

      expect(client.host).toBe(fixture.host);
      expect(client.port).toBe(fixture.port);
      expect(client.database).toBe(fixture.database);
    });

    it("keeps the admin DSN on the same server, differing only in database", () => {
      const fixture = assertFixtureDsn(VALID);
      const admin = new Client({ connectionString: canonicalDsn(fixture, "postgres") });

      expect(admin.host).toBe(fixture.host);
      expect(admin.port).toBe(fixture.port);
      expect(admin.database).toBe("postgres");
      // The reset connects here. If this ever drifts to 5432 the sweep runs on
      // the operator's cluster.
      expect(admin.port).not.toBe(5432);
    });

    it("survives a password containing characters that break naive parsing", () => {
      // The removed shell redactor used [^@/]*, which stopped at a slash. A
      // password is not required to be URL-safe, so round-trip it properly.
      const awkward = "postgresql://test:p%2Fa%40ss@127.0.0.1:5433/llm_gateway_test";
      const fixture = assertFixtureDsn(awkward);
      expect(fixture.password).toBe("p/a@ss");

      const client = new Client({ connectionString: canonicalDsn(fixture) });
      expect(client.password).toBe("p/a@ss");
      expect(client.port).toBe(5433);
      expect(describeFixture(fixture)).not.toContain("p/a@ss");
    });
  });
});
