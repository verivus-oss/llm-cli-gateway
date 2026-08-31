/**
 * The gate on the CONNECT side, at each of the places that dial.
 *
 * `admitPgDsn` itself is pinned in `dsn-target-report.test.ts`, thoroughly. What
 * was not pinned anywhere is that these four callers CONSULT it. A derived
 * mutation sweep over the reviewed diff deleted each of them in turn and the
 * whole suite stayed green at 4836 tests:
 *
 *   src/storage/drivers/postgres.ts   the pool factory, called "the convergence
 *                                     point where every connector is covered"
 *   src/db.ts                         the session connection's gate loop, and
 *                                     the guard inside it, separately
 *   src/migrate.ts                    the only path that had no gate at all
 *   src/config.ts                     `.refine(carriesPostgresDsnScheme)`
 *
 * Four security controls with no evidence, which is what five rounds of review
 * had been told was eliminated. Every test here removes exactly one of them.
 *
 * None of these connect. `pg.Pool`'s constructor creates no clients and
 * defaults `min` to 0, and every case is refused before a socket is opened.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { nodePostgresPoolFactory } from "../storage/drivers/postgres.js";
import { namesSslFileParameter } from "../storage/pg-dsn-gate.js";
import { DatabaseConnection } from "../db.js";
import { loadConfig } from "../config.js";
import type { Config, PersistenceConfig } from "../config.js";
import { noopLogger } from "../logger.js";

/** Keyword structure pg resolves INTO the host, which the gate refuses. */
const HOSTILE = "postgres://host=evil;password=NOT-A-REAL-SECRET/app";
/** An ordinary DSN, so every case below also shows what is NOT refused. */
const ORDINARY = "postgres://gateway:pw@127.0.0.1:5432/gw";

describe("the pool factory refuses a DSN the reporter will not name", () => {
  it("gates the REAL factory, not a mock of it", async () => {
    // The suite reached `nodePostgresPoolFactory` only through injected fakes,
    // so deleting `assertAdmissiblePgDsn` from it was invisible. This builds the
    // real one over the real `pg`.
    const factory = await nodePostgresPoolFactory(() => undefined);
    expect(() => factory("app", HOSTILE)).toThrow(/refusing to connect with the app DSN/);
  });

  it("still builds a pool for an ordinary DSN, and opens no connection doing it", async () => {
    // The control for over-refusal. Without it the test above passes against a
    // factory that throws on everything.
    const factory = await nodePostgresPoolFactory(() => undefined);
    const pool = factory("app", ORDINARY);
    expect(pool).toBeDefined();
    await pool.end();
  });
});

describe("the session connection refuses one before it dials", () => {
  const config = (connectionString: string): Config =>
    ({
      database: { connectionString, maxConnections: 1, idleTimeoutMs: 1, connectionTimeoutMs: 1 },
    }) as unknown as Config;

  it("refuses the app DSN", async () => {
    const connection = new DatabaseConnection(config(HOSTILE));
    await expect(connection.connect()).rejects.toThrow(/refusing to connect with the app DSN/);
  });

  it("refuses a ROLE DSN too, which the app DSN alone would not reach", async () => {
    // The loop is the control, not the single check: a deployment configures
    // `[persistence.roles]` separately, and gating only `app` would dial the
    // other three with a string the reporter refused to name. Deleting the loop
    // and deleting the guard inside it were two separate surviving mutations.
    const withRoles = {
      ...config(ORDINARY),
      roleDsns: { reader: HOSTILE },
    } as unknown as Config;
    await expect(new DatabaseConnection(withRoles).connect()).rejects.toThrow(
      /refusing to connect with the reader DSN/
    );
  });
});

describe("the session DATABASE_URL must be a PostgreSQL URI, not merely a URL", () => {
  // `DatabaseUrlSchema` is `z.string().url().refine(carriesPostgresDsnScheme)`.
  // `[persistence].dsn` has the same predicate and is well covered in
  // config.test.ts; this link is NOT, and dropping it left the suite green.
  // `.url()` alone accepts `http://`, `ftp://` and `file://`, and every one of
  // them reaches `redactDsn` through `roleDsns.app` on the doctor path.
  //
  // The same schema guards the three ROLE credentials, so an unrefined link
  // admits a non-postgres string on four surfaces, not one.
  const load = (databaseUrl: string): Config => {
    vi.stubEnv("DATABASE_URL", databaseUrl);
    return loadConfig({ backend: "sqlite" } as unknown as PersistenceConfig, noopLogger);
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["an http URL", "http://127.0.0.1:5432/gw"],
    ["a file URL", "file:///tmp/gw"],
    ["an ftp URL", "ftp://127.0.0.1/gw"],
  ])("refuses %s, which `.url()` alone accepts", (_name, databaseUrl) => {
    expect(() => load(databaseUrl)).toThrow(/Invalid database URL/);
  });

  it("still accepts both spellings pg accepts", () => {
    for (const databaseUrl of ["postgres://127.0.0.1/gw", "postgresql://127.0.0.1/gw"]) {
      expect(() => load(databaseUrl), databaseUrl).not.toThrow();
    }
  });
});

describe("migrate refuses before it builds a pool", () => {
  // migrate.ts is a CLI entry point: it exports nothing and calls `main()` at
  // module load, so the only honest test runs it. It never reaches PostgreSQL,
  // because the gate is checked before `new Pool`.
  const here = dirname(fileURLToPath(import.meta.url));
  const built = join(here, "..", "..", "dist", "migrate.js");

  const run = (databaseUrl: string): { status: number; output: string } => {
    try {
      const stdout = execFileSync(process.execPath, [built], {
        env: { ...process.env, DATABASE_URL: databaseUrl },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      });
      return { status: 0, output: stdout };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return {
        status: failure.status ?? -1,
        output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
      };
    }
  };

  it("has something to run", () => {
    // NOT a skip. A migration gate that is not exercised because the build is
    // absent is a gate with no evidence, reported as a pass.
    expect(existsSync(built), `${built} is missing; run \`npm run build\` first`).toBe(true);
  });

  it("refuses a keyword-shaped DATABASE_URL, naming the shape and not the DSN", () => {
    const { status, output } = run(HOSTILE);
    expect(status).toBe(1);
    expect(output).toContain("refusing to migrate with this DATABASE_URL");
    expect(output).not.toContain("NOT-A-REAL-SECRET");
  });
});

describe("the ssl-file question is asked of PostgreSQL DSNs only", () => {
  // `namesSslFileParameter` is exported and asked BEFORE anything opens a file.
  // Inside `parsePgDsn` the gate has already refused a foreign scheme, so its
  // own prefix guard is unreachable from that caller and a sweep deleting it
  // killed nothing. It is reachable from the export, which is the surface a
  // future caller uses, so it is pinned here rather than deleted.
  it("answers false for a scheme that is not postgres, whatever the query says", () => {
    expect(namesSslFileParameter("http://h.invalid/db?sslcert=/etc/hosts")).toBe(false);
    expect(namesSslFileParameter("mysql://h.invalid/db?sslrootcert=/etc/hosts")).toBe(false);
    expect(namesSslFileParameter("?sslkey=/etc/hosts")).toBe(false);
  });

  it("answers true for a PostgreSQL DSN that names one with a value", () => {
    for (const key of ["sslcert", "sslkey", "sslrootcert"]) {
      expect(namesSslFileParameter(`postgresql://h.invalid/db?${key}=/etc/hosts`), key).toBe(true);
    }
    // Valueless, and uppercase, are both inert to pg and must stay inert here.
    expect(namesSslFileParameter("postgresql://h.invalid/db?sslcert")).toBe(false);
    expect(namesSslFileParameter("postgresql://h.invalid/db?SSLCERT=/etc/hosts")).toBe(false);
  });
});
