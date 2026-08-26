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
      // Round 3's blocker. pg resolves config with a TRUTHY test, so a
      // field-wise port 0 reads as absent and falls back to 5432. Port zero
      // MEANS the live database while looking like a stated port.
      [
        "port zero, which pg resolves to 5432",
        "postgresql://test:test@127.0.0.1:0/llm_gateway_test",
        "refusing port",
      ],
      [
        "a zero port written as 00",
        "postgresql://test:test@127.0.0.1:00/llm_gateway_test",
        "refusing port",
      ],
      [
        "an empty user, which becomes the OS user",
        "postgresql://:test@127.0.0.1:5433/llm_gateway_test",
        "no user",
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

    /**
     * The gate that would have caught round 3's blocker and did not exist.
     *
     * pg-fixture.mjs builds its clients FIELD-WISE, never from a string.
     * Asserting only on canonicalDsn therefore tested a path production does
     * not take: port 0 survived the string path as 0 while the field path
     * silently resolved it to 5432. Both are asserted here, and asserted to
     * AGREE, so a value meaning different things to the two parsers cannot pass.
     */
    it("resolves identically whether pg is given fields or the canonical string", () => {
      const fixture = assertFixtureDsn(VALID);

      const fromFields = new Client({ ...fixture, database: "postgres" });
      const fromString = new Client({ connectionString: canonicalDsn(fixture, "postgres") });

      expect(fromFields.port).toBe(fixture.port);
      expect(fromFields.host).toBe(fixture.host);
      expect(fromString.port).toBe(fromFields.port);
      expect(fromString.host).toBe(fromFields.host);
      expect(fromString.database).toBe(fromFields.database);
    });

    it("never lets the field-wise admin client reach the operator's port", () => {
      // Directly the round-3 failure: assert on what the DESTRUCTIVE client
      // resolves to, not on what the DSN looks like.
      const fixture = assertFixtureDsn(VALID);
      const destructive = new Client({ ...fixture, database: "postgres" });

      expect(destructive.port).not.toBe(5432);
      expect(destructive.port).toBe(5433);
    });

    it("emits a single-line DSN, since the caller captures stdout", () => {
      // A second stdout line beginning ?port=5432 would be a bypass wearing the
      // shape of a formatting bug: pg strips the newline and honours it.
      const fixture = assertFixtureDsn(VALID);
      expect(canonicalDsn(fixture)).not.toMatch(/[\r\n]/);
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
