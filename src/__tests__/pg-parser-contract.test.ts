/**
 * The pg behaviours `pg-dsn-gate.ts` is built on.
 *
 * The gate is not sound in the abstract. It is sound against a SPECIFIC
 * parser, and that parser is not `pg`: it is `pg-connection-string`, which pg
 * pulls through its own caret range. `pg ^8.12.0` admitted 2.6.4, eight minors
 * behind everything this branch measured, so the declared peer floor was a
 * range over a different parser. The floor is now `^8.22.0`, the first release
 * that guarantees `pg-connection-string ^2.14.0`.
 *
 * A caret cannot pin a minor, so this file is the control. If an upgrade
 * changes any assumption below, this goes red and names which one, instead of
 * the gate going quietly unsound.
 *
 * Every case constructs, never connects.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "pg";
import { parse } from "pg-connection-string";

const AMBIENT = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"] as const;

beforeEach(() => {
  for (const name of AMBIENT) delete process.env[name];
});

/** The resolved target, read off a constructed client. Never connected. */
function resolved(dsn: string): { host: string; port: number; database: string; user: string } {
  const c = new Client({ connectionString: dsn }) as unknown as Record<string, unknown>;
  return {
    host: String(c.host ?? ""),
    port: Number(c.port),
    database: String(c.database ?? ""),
    user: String(c.user ?? ""),
  };
}

describe("the pg parser contract the DSN gate depends on", () => {
  it("copies every query key onto the config, which is why a nested DSN is refused", () => {
    // The whole reason NESTED_DSN_KEYS exists. If this stops being true the
    // rule becomes dead weight; if it stays true and the rule is removed, the
    // nested value re-enters the parser behind the gate.
    const config = parse("postgres://h.invalid/db?connectionString=postgres://nested/x") as Record<
      string,
      unknown
    >;
    expect(config.connectionString).toBe("postgres://nested/x");
  });

  it("RE-PARSES a connectionString found on the CONFIG, but not one inside a raw string", () => {
    // The exploitable half, and the distinction matters more than it looks.
    // Handing pg the ORIGINAL string is safe here: the outer authority wins and
    // the nested value stays inert on the config.
    const outer = "postgres://safe.invalid/db?connectionString=postgres://nested.invalid:1/x";
    expect(resolved(outer).host).toBe("safe.invalid");

    // Handing pg the PARSED CONFIG is not, because `connectionString` is now a
    // property and `ConnectionParameters` does
    // `config = { ...config, ...parse(config.connectionString) }`.
    // `parsePgDsn` takes exactly this second path, which is how round 24's
    // nested bypass reached the reporter while `db.ts`, passing the raw string,
    // resolved somewhere else entirely. Two consumers, two targets, one DSN.
    const viaConfig = new Client(parse(outer)) as unknown as Record<string, unknown>;
    expect(viaConfig.host).toBe("nested.invalid");
    expect(Number(viaConfig.port)).toBe(1);
  });

  it("decodes the path with decodeURI and the userinfo with decodeURIComponent", () => {
    // The asymmetry the keyword-separator rule relies on: reserved characters
    // survive encoded in a PATH, so a raw-byte check on the path is complete.
    expect(resolved("postgresql://u:p@h.invalid/db%3Aname").database).toBe("db%3Aname");
    expect(resolved("postgresql://u:p@h.invalid/db%20name").database).toBe("db name");
    const config = parse("postgresql://u:p%40ss@h.invalid/db") as Record<string, unknown>;
    expect(config.password).toBe("p@ss");
  });

  it("treats + as a space in a query value and as a literal in a path", () => {
    expect(resolved("postgresql://u:p@h.invalid/db?host=a+b").host).toBe("a b");
    expect(resolved("postgresql://u:p@h.invalid/a+b").database).toBe("a+b");
  });

  it("lets the LAST duplicate query key win, which is why duplicates are refused", () => {
    expect(resolved("postgresql://u:p@h.invalid/db?host=first&host=second").host).toBe("second");
  });

  it("ignores dbname in the query, so the gate lists it defensively and not because pg reads it", () => {
    // If this flips, `dbname` in TARGET_KEYS stops being defensive and starts
    // being load-bearing. Either way the gate is correct; the COMMENT is not.
    expect(resolved("postgresql://u:p@h.invalid?dbname=other").database).toBe("u");
  });

  it("throws on a bracketed non-address and on an IPv6 zone id", () => {
    // Inherited refusals. The gate deliberately has no rule of its own for
    // these, so if pg starts accepting them the reporter starts naming them.
    expect(() => resolved("postgresql://u:p@[foo]:5433/db")).toThrow();
    expect(() => resolved("postgresql://u:p@[fe80::1%25eth0]:5433/db")).toThrow();
  });

  it("reads an ssl file only when the key carries a value, and matches case-sensitively", () => {
    // `namesSslFileParameter` mirrors pg's `if (config.sslcert)` exactly. Both
    // halves matter: widening it refuses DSNs pg opens nothing for.
    const withValue = parse("postgresql://h.invalid/db?sslcert=/etc/hosts") as Record<
      string,
      unknown
    >;
    expect(withValue.sslcert).toBe("/etc/hosts");
    const valueless = parse("postgresql://h.invalid/db?sslcert") as Record<string, unknown>;
    expect(valueless.sslcert).toBeFalsy();
    const uppercase = parse("postgresql://h.invalid/db?SSLCERT=/etc/hosts") as Record<
      string,
      unknown
    >;
    expect(uppercase.sslcert).toBeUndefined();
  });

  it("resolves an empty authority to localhost rather than pg's internal dummy host", () => {
    // Round 10's defect is gone at its source. If pg ever surfaces the dummy,
    // the reporter would print it, because the reporter now trusts pg.
    const target = resolved("postgresql://u:p@/db");
    expect(target.host).toBe("localhost");
    expect(target.host).not.toContain("DUMMY");
  });

  it("BACKSTOP: a resolved target holding keyword structure is refused even from the environment", async () => {
    // The gate inspects its INPUTS; this inspects the printed OUTPUT. Only the
    // output placement covers a value that never appeared in the DSN, which is
    // what makes it a distinct control rather than a duplicate of the gate.
    const { parsePgDsn } = await import("../storage/pg-dsn-parse.js");
    process.env.PGHOST = "h.invalid;password=pwCONTRACT-DO-NOT-PRINT";
    const parsed = parsePgDsn("postgresql:///db");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe("the resolved target holds keyword structure");
  });

  it("falls back to the environment for an unstated field", () => {
    // The reporter reads the RESOLVED value, so pg's fallback is what gets
    // printed. `parse` alone returns "" here and would print a blank target.
    process.env.PGHOST = "envhost.invalid";
    expect(resolved("postgresql:///db").host).toBe("envhost.invalid");
    expect((parse("postgresql:///db") as Record<string, unknown>).host).toBe("");
  });
});
