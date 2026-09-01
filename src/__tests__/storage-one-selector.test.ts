/**
 * s9: one selector, and the credentials it carries.
 *
 * Three properties, each with its own failure mode:
 *
 * 1. The `DATABASE_URL` precedence rule is combinatorial, so it is tested as a
 *    matrix over (explicit backend x DATABASE_URL set x agreeing) rather than
 *    at the two cells someone happened to think of. It is asserted through the
 *    exported decision so every cell is cheap enough to actually enumerate.
 * 2. `[persistence.roles]` must REACH the driver. A credential parsed into a
 *    config object nothing threads through is the defect this node exists to
 *    fix, so the driver constructions are what is asserted, not the config.
 * 3. `backend = "none"` must not silence the flight recorder, and an operator
 *    must be able to read what happened to their request history.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadConfig,
  loadPersistenceConfig,
  resolveDatabaseUrlPrecedence,
  resetSessionDatabaseUrlWarning,
  type PersistenceConfig,
} from "../config.js";
import { formatStorageDisposition, storageDisposition } from "../storage-disposition.js";
import { noopLogger } from "../logger.js";

const APP_DSN = "postgresql://llmgw_app@db.example/gw";
const READER_DSN = "postgresql://llmgw_reader@db.example/gw";
const OTHER_DSN = "postgresql://llmgw_app@other.example/gw";

let tempDir: string;
let stashedConfig: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "s9-one-selector-"));
  stashedConfig = process.env.LLM_GATEWAY_CONFIG;
  resetSessionDatabaseUrlWarning();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tempDir, { recursive: true, force: true });
  if (stashedConfig === undefined) delete process.env.LLM_GATEWAY_CONFIG;
  else process.env.LLM_GATEWAY_CONFIG = stashedConfig;
});

/** Point the loader at a config file, and clear the legacy vars setup.ts sets. */
function withToml(body: string): void {
  const p = join(tempDir, "config.toml");
  writeFileSync(p, body);
  vi.stubEnv("LLM_GATEWAY_CONFIG", p);
  vi.stubEnv("LLM_GATEWAY_LOGS_DB", "");
  vi.stubEnv("LLM_GATEWAY_JOBS_DB", "");
}

function withNoToml(): void {
  vi.stubEnv("LLM_GATEWAY_CONFIG", join(tempDir, "absent.toml"));
  vi.stubEnv("LLM_GATEWAY_LOGS_DB", "");
  vi.stubEnv("LLM_GATEWAY_JOBS_DB", "");
}

describe("DATABASE_URL precedence matrix", () => {
  const cells: Array<{
    name: string;
    input: Parameters<typeof resolveDatabaseUrlPrecedence>[0];
    outcome: string;
    connectionString: string | null;
  }> = [
    {
      name: "no backend written down, DATABASE_URL unset",
      input: {
        databaseUrl: undefined,
        persistenceDsn: null,
        explicitBackend: false,
        backend: "sqlite",
      },
      outcome: "absent",
      connectionString: null,
    },
    {
      name: "no backend written down, DATABASE_URL set: the only signal a legacy host has",
      input: {
        databaseUrl: APP_DSN,
        persistenceDsn: null,
        explicitBackend: false,
        backend: "sqlite",
      },
      outcome: "honoured",
      connectionString: APP_DSN,
    },
    {
      name: "explicit sqlite, DATABASE_URL set",
      input: {
        databaseUrl: APP_DSN,
        persistenceDsn: null,
        explicitBackend: true,
        backend: "sqlite",
      },
      outcome: "ignored_explicit_backend",
      connectionString: null,
    },
    {
      name: "explicit memory, DATABASE_URL set",
      input: {
        databaseUrl: APP_DSN,
        persistenceDsn: null,
        explicitBackend: true,
        backend: "memory",
      },
      outcome: "ignored_explicit_backend",
      connectionString: null,
    },
    {
      name: "explicit none, DATABASE_URL set",
      input: { databaseUrl: APP_DSN, persistenceDsn: null, explicitBackend: true, backend: "none" },
      outcome: "ignored_explicit_backend",
      connectionString: null,
    },
    {
      name: "postgres backend, DATABASE_URL unset",
      input: {
        databaseUrl: undefined,
        persistenceDsn: APP_DSN,
        explicitBackend: true,
        backend: "postgres",
      },
      outcome: "absent",
      connectionString: APP_DSN,
    },
    {
      name: "postgres backend, DATABASE_URL agreeing",
      input: {
        databaseUrl: APP_DSN,
        persistenceDsn: APP_DSN,
        explicitBackend: true,
        backend: "postgres",
      },
      outcome: "redundant",
      connectionString: APP_DSN,
    },
    {
      name: "postgres backend, DATABASE_URL disagreeing: refused, not resolved",
      input: {
        databaseUrl: OTHER_DSN,
        persistenceDsn: APP_DSN,
        explicitBackend: true,
        backend: "postgres",
      },
      outcome: "ignored_conflict",
      connectionString: APP_DSN,
    },
    {
      name: "empty DATABASE_URL is not set",
      input: { databaseUrl: "", persistenceDsn: null, explicitBackend: false, backend: "sqlite" },
      outcome: "absent",
      connectionString: null,
    },
  ];

  for (const cell of cells) {
    it(`resolves: ${cell.name}`, () => {
      const decision = resolveDatabaseUrlPrecedence(cell.input);
      expect(decision.outcome).toBe(cell.outcome);
      expect(decision.connectionString).toBe(cell.connectionString);
      // Every outcome except "absent" owes the operator a reason.
      expect(decision.reason === null).toBe(cell.outcome === "absent");
    });
  }

  it("a conflict does NOT abort startup; loadConfig returns the [persistence] database", () => {
    withToml(["[persistence]", 'backend = "postgres"', `dsn = "${APP_DSN}"`].join("\n"));
    vi.stubEnv("DATABASE_URL", OTHER_DSN);
    const persistence = loadPersistenceConfig(noopLogger);
    const config = loadConfig(persistence, noopLogger);
    expect(config.database?.connectionString).toBe(APP_DSN);
    expect(config.databaseSource).toBe("persistence");
  });

  it("an ignored DATABASE_URL is reported as an outcome, not only warned about once", () => {
    withToml(["[persistence]", 'backend = "postgres"', `dsn = "${APP_DSN}"`].join("\n"));
    vi.stubEnv("DATABASE_URL", OTHER_DSN);
    const report = storageDisposition(loadPersistenceConfig(noopLogger)).deprecatedInputs;
    const databaseUrl = report.find(entry => entry.name === "DATABASE_URL");
    expect(databaseUrl).toMatchObject({ set: true, outcome: "ignored_conflict" });
    expect(databaseUrl?.reason).toContain("disagrees with");
  });
});

describe("[persistence.roles]", () => {
  it("carries every configured credential, with app taken from dsn", () => {
    withToml(
      [
        "[persistence]",
        'backend = "postgres"',
        `dsn = "${APP_DSN}"`,
        "",
        "[persistence.roles]",
        `reader = "${READER_DSN}"`,
      ].join("\n")
    );
    const cfg = loadPersistenceConfig(noopLogger);
    expect(cfg.roleDsns).toEqual({ app: APP_DSN, reader: READER_DSN });
  });

  it("holds app alone when no roles table is written", () => {
    withToml(["[persistence]", 'backend = "postgres"', `dsn = "${APP_DSN}"`].join("\n"));
    expect(loadPersistenceConfig(noopLogger).roleDsns).toEqual({ app: APP_DSN });
  });

  it("is empty on a sqlite backend, which has no database identities", () => {
    withNoToml();
    expect(loadPersistenceConfig(noopLogger).roleDsns).toEqual({});
  });

  it("refuses `app`, because the runtime credential is [persistence].dsn", () => {
    withToml(
      [
        "[persistence]",
        'backend = "postgres"',
        `dsn = "${APP_DSN}"`,
        "",
        "[persistence.roles]",
        `app = "${APP_DSN}"`,
      ].join("\n")
    );
    expect(() => loadPersistenceConfig(noopLogger)).toThrow(/app is not accepted here/);
  });

  it("refuses `migrate`, which a running gateway must not hold", () => {
    withToml(
      [
        "[persistence]",
        'backend = "postgres"',
        `dsn = "${APP_DSN}"`,
        "",
        "[persistence.roles]",
        `migrate = "${APP_DSN}"`,
      ].join("\n")
    );
    expect(() => loadPersistenceConfig(noopLogger)).toThrow(/owner-equivalent/);
  });

  it("refuses a misspelled role rather than silently holding no reader", () => {
    withToml(
      [
        "[persistence]",
        'backend = "postgres"',
        `dsn = "${APP_DSN}"`,
        "",
        "[persistence.roles]",
        `readr = "${READER_DSN}"`,
      ].join("\n")
    );
    expect(() => loadPersistenceConfig(noopLogger)).toThrow(/Invalid \[persistence\] config/);
  });

  it("refuses a role DSN that is not a postgres URL", () => {
    withToml(
      [
        "[persistence]",
        'backend = "postgres"',
        `dsn = "${APP_DSN}"`,
        "",
        "[persistence.roles]",
        'reader = "mysql://nope/gw"',
      ].join("\n")
    );
    expect(() => loadPersistenceConfig(noopLogger)).toThrow(/Invalid \[persistence\] config/);
  });

  it("refuses roles on a backend that has no per-role credentials", () => {
    withToml(
      [
        "[persistence]",
        'backend = "sqlite"',
        "",
        "[persistence.roles]",
        `reader = "${READER_DSN}"`,
      ].join("\n")
    );
    expect(() => loadPersistenceConfig(noopLogger)).toThrow(/only meaningful with backend/);
  });

  it("reports separation as in force only when every class has its own credential", () => {
    const partial = {
      ...mkPersistence(),
      roleDsns: { app: APP_DSN, reader: READER_DSN },
    } as PersistenceConfig;
    const partialReport = storageDisposition(partial).roles;
    expect(partialReport.separationInForce).toBe(false);
    expect(partialReport.configured).toEqual(["app", "reader"]);
    expect(partialReport.degraded.map(entry => entry.operation).sort()).toEqual([
      "analytics_read",
      "retention",
    ]);

    const full = {
      ...mkPersistence(),
      roleDsns: {
        app: APP_DSN,
        reader: READER_DSN,
        analytics: READER_DSN,
        retention: READER_DSN,
      },
    } as PersistenceConfig;
    expect(storageDisposition(full).roles.separationInForce).toBe(true);
  });

  it("does not count a key that is not a storage role", () => {
    const rogue = {
      ...mkPersistence(),
      roleDsns: { app: APP_DSN, readr: READER_DSN },
    } as unknown as PersistenceConfig;
    expect(storageDisposition(rogue).roles.configured).toEqual(["app"]);
    expect(storageDisposition(rogue).roles.separationInForce).toBe(false);
  });
});

describe('backend = "none" and LLM_GATEWAY_LOGS_DB', () => {
  it("does not disable the flight recorder, and says so at startup", () => {
    withToml(["[persistence]", 'backend = "none"'].join("\n"));
    vi.stubEnv("LLM_GATEWAY_LOGS_DB", join(tempDir, "logs.db"));
    const disposition = storageDisposition(loadPersistenceConfig(noopLogger));
    expect(disposition.jobStore.asyncJobsEnabled).toBe(false);
    expect(disposition.requestHistory.enabled).toBe(true);
    const lines = formatStorageDisposition(disposition).join("\n");
    expect(lines).toContain("disables async job persistence ONLY");
    expect(lines).toContain("request history is being written");
  });

  it("LLM_GATEWAY_LOGS_DB=none disables the recorder and the log says history is not written", () => {
    withToml(["[persistence]", 'backend = "sqlite"'].join("\n"));
    vi.stubEnv("LLM_GATEWAY_LOGS_DB", "none");
    const disposition = storageDisposition(loadPersistenceConfig(noopLogger));
    expect(disposition.requestHistory.enabled).toBe(false);
    expect(disposition.requestHistory.decidedBy).toBe("LLM_GATEWAY_LOGS_DB");
    expect(formatStorageDisposition(disposition).join("\n")).toContain(
      "request history is NOT being written"
    );
  });

  it("reports the recorder as following a postgres backend without topology inference", () => {
    withToml(["[persistence]", 'backend = "postgres"', `dsn = "${APP_DSN}"`].join("\n"));
    vi.stubEnv("LLM_GATEWAY_LOGS_DB", join(tempDir, "logs.db"));
    const disposition = storageDisposition(loadPersistenceConfig(noopLogger));
    expect(disposition.requestHistory.engine).toBe("postgres");
    expect(disposition.requestHistory.decidedBy).toBe("default");
    expect(disposition.requestHistory.followsPersistenceBackend).toBe(true);
    expect(disposition.requestHistory.engineRequested).toBe("postgres");
    expect(
      disposition.deprecatedInputs.find(input => input.name === "LLM_GATEWAY_LOGS_DB")
    ).toMatchObject({ outcome: "recorder_path_ignored" });
    expect(formatStorageDisposition(disposition).join("\n")).toContain(
      'IS following [persistence].backend = "postgres"'
    );
  });

  it("does not claim that an SQLite recorder follows memory persistence", () => {
    withToml(["[persistence]", 'backend = "memory"', "acknowledgeEphemeral = true"].join("\n"));
    vi.stubEnv("LLM_GATEWAY_LOGS_DB", join(tempDir, "logs.db"));
    const disposition = storageDisposition(loadPersistenceConfig(noopLogger));
    expect(disposition.requestHistory.engine).toBe("sqlite");
    expect(disposition.requestHistory.followsPersistenceBackend).toBe(false);
  });
});

/** A minimal resolved config for the pure-function assertions above. */
function mkPersistence(): PersistenceConfig {
  return {
    backend: "postgres",
    path: null,
    dsn: APP_DSN,
    roleDsns: { app: APP_DSN },
    retentionDays: 30,
    dedupWindowMs: 0,
    acknowledgeEphemeral: false,
    ownsOrphanRecovery: false,
    instanceHeartbeatMs: 15000,
    instanceLeaseTtlMs: 90000,
    httpJobGraceMs: 300000,
    orphanSweepIntervalMs: 30000,
    instanceGcMs: 3600000,
    asyncJobsEnabled: true,
    sources: { configFile: null, envOverrides: [] },
    explicitBackend: true,
  };
}
