/**
 * The Postgres flight recorder against a REAL server.
 *
 * Two things a fake cannot establish, and both were found by running this:
 * `pg` returns int8 and numeric as STRINGS, so an uncast `COUNT(*)` or a
 * `NUMERIC` money column reaches a `number`-typed field as text; and the
 * compatibility bootstrap and migrations/022 have to produce the same schema or
 * a host that ran `npm run migrate` and a host that did not are two databases.
 *
 * Isolated in its OWN PostgreSQL schema through the DSN's `options` keyword, so
 * it neither sees nor leaves anything in `public` where the other -pg suites live.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { PostgresFlightRecorder } from "../flight-recorder-pg.js";
import type { FlightLogResult, FlightLogStart } from "../flight-recorder.js";
import { collectStorageHealth } from "../doctor.js";
import { TEST_DATABASE_URL } from "./setup.js";
// @ts-expect-error - plain ESM helper shared with the static parity gate
import { transcriptMigrationText } from "../../scripts/transcript-migration-selection.mjs";

const BASE_DSN = TEST_DATABASE_URL;
const SCHEMA = `flight_pg_${process.pid}`;
const MIRROR = `${SCHEMA}_mirror`;
const INCOMPLETE = `${SCHEMA}_incomplete`;
const NULLABLE_RANK = `${SCHEMA}_nullable_rank`;
const DEFAULTLESS_RANK = `${SCHEMA}_defaultless_rank`;

function scoped(schema: string): string {
  const url = new URL(BASE_DSN);
  url.searchParams.set("options", `-csearch_path=${schema}`);
  return url.toString();
}

let admin: Pool;
let recorder: PostgresFlightRecorder;

const ID = "corr-pg-1";

const START: FlightLogStart = {
  correlationId: ID,
  cli: "claude",
  model: "opus-5",
  prompt: "the prompt body",
  system: "the system body",
  sessionId: "gw-session-1",
  asyncJobId: "job-77",
  stablePrefixHash: "hash-abc",
  stablePrefixTokens: 1234,
  cacheControlBlocks: 3,
  cacheControlTtlSeconds: 3600,
  ownerPrincipal: "local",
};

const RESULT: FlightLogResult = {
  response: "the response body",
  inputTokens: 111,
  outputTokens: 222,
  cacheReadTokens: 333,
  cacheCreationTokens: 444,
  durationMs: 5678,
  retryCount: 2,
  circuitBreakerState: "CLOSED",
  costUsd: 0.000123,
  costBasis: "provider-reported",
  approvalDecision: "allow",
  optimizationApplied: true,
  thinkingBlocks: ["thought one", "thought two"],
  exitCode: 0,
  httpStatus: 200,
  errorMessage: "none",
  status: "completed",
  providerSessionId: "prov-session-9",
  stopReason: "end_turn",
};

beforeAll(async () => {
  admin = new Pool({ connectionString: BASE_DSN });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.query(`DROP SCHEMA IF EXISTS ${MIRROR} CASCADE`);
  await admin.query(`DROP SCHEMA IF EXISTS ${INCOMPLETE} CASCADE`);
  await admin.query(`DROP SCHEMA IF EXISTS ${NULLABLE_RANK} CASCADE`);
  await admin.query(`DROP SCHEMA IF EXISTS ${DEFAULTLESS_RANK} CASCADE`);
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  await admin.query(`CREATE SCHEMA ${MIRROR}`);
  await admin.query(`CREATE SCHEMA ${INCOMPLETE}`);
  await admin.query(`CREATE SCHEMA ${NULLABLE_RANK}`);
  await admin.query(`CREATE SCHEMA ${DEFAULTLESS_RANK}`);
});

afterAll(async () => {
  await recorder?.close();
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.query(`DROP SCHEMA IF EXISTS ${MIRROR} CASCADE`);
  await admin.query(`DROP SCHEMA IF EXISTS ${INCOMPLETE} CASCADE`);
  await admin.query(`DROP SCHEMA IF EXISTS ${NULLABLE_RANK} CASCADE`);
  await admin.query(`DROP SCHEMA IF EXISTS ${DEFAULTLESS_RANK} CASCADE`);
  await admin.end();
});

/**
 * Every flight-recorder migration, concatenated in version order. The selection
 * is the one `scripts/check-transcript-schema-parity.mjs` uses, imported rather
 * than restated, so a later recorder migration lands in the mirror without
 * anyone remembering to add it here and a migration for another subsystem stays
 * out of a schema that has none of its tables.
 */
function transcriptMigrations(): string {
  return transcriptMigrationText(join(process.cwd(), "migrations"));
}

/** The stored rank, read on a connection the recorder does not own. */
async function storedRank(requestId: string): Promise<number> {
  const rows = await raw<{ completion_rank: number }>(
    `SELECT completion_rank FROM gateway_metadata WHERE request_id = '${requestId}'`
  );
  return rows[0]?.completion_rank;
}

/** Read a column back on a connection this recorder does not own. */
async function raw<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const result = await admin.query(`SET search_path TO ${SCHEMA}; ${sql}`);
  return (Array.isArray(result) ? result[1].rows : result.rows) as T[];
}

describe("a whole transcript round trip", () => {
  beforeEach(async () => {
    await recorder?.close();
    recorder = new PostgresFlightRecorder({ app: scoped(SCHEMA) }, { redactSecrets: false });
    await recorder.readStorageStats();
    await raw("DELETE FROM gateway_metadata; DELETE FROM requests");
  });

  it("writes EVERY column and reads all of them back unchanged", async () => {
    await (async () => {
      await recorder.logStart(START);
      await recorder.logComplete(ID, RESULT);
      await recorder.recordRouting(ID, {
        estCostUsd: 0.00099,
        estConfidence: "high",
        reason: "cheapest-eligible",
        considered: 4,
        reroutes: 1,
      });
      await recorder.recordCompressionTelemetry(ID, {
        route: "native",
        transforms: ["dedupe", "strip"],
        originalChars: 9000,
        compressedChars: 4500,
        estimatedTokensSaved: 1125,
      });
    })();

    const row = await recorder.readRequestById(ID);
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      id: ID,
      cli: "claude",
      model: "opus-5",
      prompt: "the prompt body",
      response: "the response body",
      session_id: "gw-session-1",
      duration_ms: 5678,
      input_tokens: 111,
      output_tokens: 222,
      cache_read_tokens: 333,
      cache_creation_tokens: 444,
      owner_principal: "local",
      retry_count: 2,
      circuit_breaker_state: "CLOSED",
      exit_code: 0,
      error_message: "none",
      async_job_id: "job-77",
      provider_session_id: "prov-session-9",
      status: "completed",
    });
    expect(JSON.parse(row?.thinking_blocks ?? "[]")).toEqual(["thought one", "thought two"]);

    // THE MONEY COLUMN. NUMERIC would have made this the string "0.00012300",
    // which every equality here would still have to be rewritten to accept.
    expect(row?.cost_usd).toBe(0.000123);
    expect(typeof row?.cost_usd).toBe("number");
    // And the counters, which BIGINT would have made strings.
    expect(typeof row?.input_tokens).toBe("number");
    expect(typeof row?.duration_ms).toBe("number");
    // datetime_utc stays an ISO string. TIMESTAMPTZ would return a Date here.
    expect(typeof row?.datetime_utc).toBe("string");
    expect(() => new Date(row?.datetime_utc ?? "").toISOString()).not.toThrow();
  });

  it("does not rewrite routing or compression on a migrated (rank 3) row (#287)", async () => {
    await recorder.logStart({ ...START, correlationId: "pg-migrated" });
    await recorder.logComplete("pg-migrated", RESULT);
    // Reserved rank 3 marks a row imported by the transcript cutover.
    await raw("UPDATE gateway_metadata SET completion_rank = 3 WHERE request_id = 'pg-migrated'");

    await recorder.recordRouting("pg-migrated", { reason: "cheapest-capable", considered: 4 });
    await recorder.recordCompressionTelemetry("pg-migrated", {
      route: "native",
      transforms: ["dedupe"],
      originalChars: 10,
      compressedChars: 5,
      estimatedTokensSaved: 2,
    });

    const rows = await raw<{
      routed: boolean | null;
      route_reason: string | null;
      compression_route: string | null;
      completion_rank: number;
    }>(
      "SELECT routed, route_reason, compression_route, completion_rank FROM gateway_metadata WHERE request_id = 'pg-migrated'"
    );
    expect(rows[0].completion_rank).toBe(3);
    expect(rows[0].routed).toBeNull();
    expect(rows[0].route_reason).toBeNull();
    expect(rows[0].compression_route).toBeNull();
  });

  it("still applies routing and compression to a live (rank < 3) row (#287)", async () => {
    await recorder.logStart({ ...START, correlationId: "pg-live" });
    await recorder.logComplete("pg-live", RESULT);

    await recorder.recordRouting("pg-live", { reason: "cheapest-capable", considered: 4 });
    await recorder.recordCompressionTelemetry("pg-live", {
      route: "native",
      transforms: ["dedupe"],
      originalChars: 10,
      compressedChars: 5,
      estimatedTokensSaved: 2,
    });

    const rows = await raw<{
      routed: boolean | null;
      route_reason: string | null;
      compression_route: string | null;
      completion_rank: number;
    }>(
      "SELECT routed, route_reason, compression_route, completion_rank FROM gateway_metadata WHERE request_id = 'pg-live'"
    );
    expect(rows[0].completion_rank).toBe(2);
    expect(rows[0].routed).toBe(true);
    expect(rows[0].route_reason).toBe("cheapest-capable");
    expect(rows[0].compression_route).toBe("native");
  });

  it("stores the two 1/0 columns as real booleans", async () => {
    await recorder.logStart(START);
    await recorder.logComplete(ID, RESULT);
    await recorder.recordRouting(ID, { estCostUsd: 1, reason: "r", considered: 1, reroutes: 0 });
    const [meta] = await raw<{ optimization_applied: unknown; routed: unknown }>(
      "SELECT optimization_applied, routed FROM gateway_metadata"
    );
    expect(meta.optimization_applied).toBe(true);
    expect(meta.routed).toBe(true);
  });

  it("finds the routed row, which needs `routed IS TRUE` and not `routed = 1`", async () => {
    await recorder.logStart(START);
    await recorder.logComplete(ID, RESULT);
    await recorder.recordRouting(ID, {
      estCostUsd: 0.00099,
      estConfidence: "high",
      reason: "cheapest-eligible",
      considered: 4,
      reroutes: 1,
    });
    const decisions = await recorder.readRoutingDecisions(10);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].route_est_cost_usd).toBe(0.00099);
    expect(typeof decisions[0].route_est_cost_usd).toBe("number");
    expect(decisions[0].route_considered).toBe(4);
  });

  it("projects summaries with character counts and no body", async () => {
    await recorder.logStart(START);
    await recorder.logComplete(ID, RESULT);
    const rows = await recorder.listRequestSummaries({ ownerPrincipal: "local", limit: 5 });
    expect(rows).toHaveLength(1);
    expect(rows[0].prompt_chars).toBe("the prompt body".length);
    expect(rows[0].response_chars).toBe("the response body".length);
    expect(rows[0]).not.toHaveProperty("prompt");
  });

  it("scopes summaries to the owning principal", async () => {
    await recorder.logStart(START);
    expect(
      await recorder.listRequestSummaries({ ownerPrincipal: "someone-else", limit: 5 })
    ).toHaveLength(0);
    expect(await recorder.listRequestSummaries({ ownerPrincipal: "local", limit: 5 })).toHaveLength(
      1
    );
  });

  it("returns the cache aggregates all three ways", async () => {
    await recorder.logStart(START);
    await recorder.logComplete(ID, RESULT);
    const bySession = await recorder.readCacheRowsBySession("gw-session-1");
    expect(bySession[0]).toMatchObject({
      cli: "claude",
      cache_read_tokens: 333,
      cache_control_blocks: 3,
      cache_control_ttl_seconds: 3600,
    });
    expect(await recorder.readCacheRowsByPrefix("hash-abc")).toHaveLength(1);
    expect(await recorder.readCacheRowsGlobal()).toHaveLength(1);
    expect(await recorder.readCacheRowsGlobal("2999-01-01T00:00:00.000Z")).toHaveLength(0);
  });

  it("carries the LCR prior signals, both money columns included", async () => {
    await recorder.logStart(START);
    await recorder.logComplete(ID, RESULT);
    await recorder.recordRouting(ID, { estCostUsd: 0.00099 });
    const [prior] = await recorder.readLcrPriorRows();
    expect(prior.cost_usd).toBe(0.000123);
    expect(prior.route_est_cost_usd).toBe(0.00099);
    expect(prior.cost_basis).toBe("provider-reported");
    expect(prior.derived_prompt_chars).toBe("the prompt body".length);
  });

  it("counts rows as NUMBERS, which an uncast COUNT(*) would not", async () => {
    await recorder.logStart(START);
    const stats = await recorder.readStorageStats("2999-01-01T00:00:00.000Z");
    expect(stats.requestRows).toBe(1);
    expect(typeof stats.requestRows).toBe("number");
    expect(stats.requestsBeyondRetention).toBe(1);
    expect(typeof stats.requestsBeyondRetention).toBe("number");
    expect(stats.oldestRequest).toBe(stats.newestRequest);
  });

  it("admits an equal-rank second completion, and moves the body and status TOGETHER", async () => {
    // Until migrations/023 this test asserted the opposite, and its comment said
    // "the requests UPDATE is unfenced ... the metadata status is what stays
    // monotonic". Both halves stopped being true when the rank fence replaced
    // the `status = 'started'` guard, and nothing caught it because this suite
    // runs only under `npm run test:pg` and the assertion could not see a body.
    //
    // The contract now: a completion lands where its rank is >= the stored one.
    // Two OBSERVED completions are both rank 2, so the second lands, and the
    // point of the fence is that the body and the status move together rather
    // than the body being last-wins under a monotonic status.
    await recorder.logStart(START);
    await recorder.logComplete(ID, RESULT);
    await recorder.logComplete(ID, { ...RESULT, response: "LATER", status: "failed" });
    const row = await recorder.readRequestById(ID);
    expect(row?.status).toBe("failed");
    expect(row?.response).toBe("LATER");
    expect(await storedRank(ID)).toBe(2);
  });

  it("writes the compression telemetry once and keeps the first write", async () => {
    await recorder.logStart(START);
    await recorder.recordCompressionTelemetry(ID, {
      route: "native",
      transforms: ["a"],
      originalChars: 10,
      compressedChars: 5,
      estimatedTokensSaved: 1,
    });
    await recorder.recordCompressionTelemetry(ID, {
      route: "SECOND",
      transforms: ["b"],
      originalChars: 20,
      compressedChars: 10,
      estimatedTokensSaved: 2,
    });
    const [meta] = await raw<{ compression_route: string }>(
      "SELECT compression_route FROM gateway_metadata"
    );
    expect(meta.compression_route).toBe("native");
  });

  it("reports the co-resident job tables, which on this engine are the LIVE ones", async () => {
    await raw("CREATE TABLE IF NOT EXISTS jobs (status TEXT)");
    await raw("INSERT INTO jobs (status) VALUES ('running'), ('done')");
    const stats = await recorder.readStorageStats();
    expect(stats.coResident).toEqual([{ table: "jobs", rows: 2, unfinished: 1 }]);
    expect(typeof stats.coResident[0].rows).toBe("number");
    await raw("DROP TABLE jobs");
  });

  it("refuses every operation once closed, rather than answering empty", async () => {
    await recorder.close();
    await expect(recorder.readRequestById(ID)).rejects.toThrow(/closed/);
    await expect(recorder.logStart(START)).rejects.toThrow(/closed/);
    expect(recorder.health().closed).toBe(true);
  });

  it("uses the safe target projection on health surfaces", () => {
    const path = recorder.health().path;
    const target = new URL(BASE_DSN);
    expect(path).toBe(
      `postgresql host ${target.hostname} port ${target.port} database ${target.pathname.slice(1)}`
    );
    expect(path).not.toContain("://");
    expect(path).not.toContain("@");
  });
});

describe("the five states", () => {
  it("reaches `active` on its own, with NO operation forcing the bootstrap", async () => {
    // The SQLite twin kicks its bootstrap off in the constructor. Without the
    // same kick-off here an idle gateway reports `initialising` for as long as
    // nothing logs a request, and every request-history read is reported as
    // non-authoritative on a recorder that is perfectly healthy.
    const fresh = new PostgresFlightRecorder({ app: scoped(SCHEMA) }, { redactSecrets: false });
    try {
      expect(fresh.health().state).toBe("initialising");
      for (
        let attempt = 0;
        attempt < 200 && fresh.health().state === "initialising";
        attempt += 1
      ) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(fresh.health().state).toBe("active");
      expect(fresh.health().closed).toBe(false);
    } finally {
      await fresh.close();
    }
  });

  it("names a socket target while keeping its operation error opaque", async () => {
    const marker = "dsn-health-target";
    const url = new URL(BASE_DSN);
    url.searchParams.set("host", `/tmp/${marker}`);
    const logError = vi.fn();
    const broken = new PostgresFlightRecorder(
      { app: url.toString() },
      { redactSecrets: false, logger: { info: () => {}, error: logError } }
    );
    try {
      await expect(broken.readStorageStats()).rejects.toThrow();
      const health = broken.health();
      expect(health.state).toBe("degraded");
      expect(health.path).toBe(
        `postgresql socket /tmp/${marker} port ${url.port} database ${url.pathname.slice(1)}`
      );
      expect(health.error).toBe("PostgreSQL operation failed");
      expect(health.error).not.toContain(marker);
      expect(health.path).not.toContain("://");
      expect(health.path).not.toContain("@");
      expect(health.failureCount).toBeGreaterThan(0);
      const logs = logError.mock.calls
        .flat()
        .map(value => (value instanceof Error ? value.message : String(value)))
        .join(" ");
      expect(logs).toContain(marker);
    } finally {
      await broken.close();
    }
  });

  it("names the configured target while keeping doctor operation errors opaque", async () => {
    const marker = "doctor-dsn-health-target";
    const url = new URL(BASE_DSN);
    url.searchParams.set("host", `/tmp/${marker}`);
    const dir = mkdtempSync(join(tmpdir(), "doctor-pg-health-"));
    const configPath = join(dir, "config.toml");
    writeFileSync(
      configPath,
      ["[persistence]", 'backend = "postgres"', `dsn = ${JSON.stringify(url.toString())}`, ""].join(
        "\n"
      )
    );
    const savedConfig = process.env.LLM_GATEWAY_CONFIG;
    const savedLogs = process.env.LLM_GATEWAY_LOGS_DB;
    process.env.LLM_GATEWAY_CONFIG = configPath;
    process.env.LLM_GATEWAY_LOGS_DB = join(dir, "unused-sqlite.db");
    try {
      const storage = await collectStorageHealth();
      expect(storage.job_store.backend).toBe("postgres");
      expect(storage.flight_recorder.path).toBe(
        `postgresql socket /tmp/${marker} port ${url.port} database ${url.pathname.slice(1)}`
      );
      expect(storage.flight_recorder.path).not.toContain("://");
      expect(storage.flight_recorder.path).not.toContain("@");
      expect(storage.flight_recorder.error).toBe("PostgreSQL operation failed");
      expect(storage.warnings.join(" ")).toContain(marker);
      expect(storage.warnings.join(" ")).toContain("PostgreSQL operation failed");
    } finally {
      if (savedConfig === undefined) delete process.env.LLM_GATEWAY_CONFIG;
      else process.env.LLM_GATEWAY_CONFIG = savedConfig;
      if (savedLogs === undefined) delete process.env.LLM_GATEWAY_LOGS_DB;
      else process.env.LLM_GATEWAY_LOGS_DB = savedLogs;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The rank fence on the engine the s10 cutover actually targets.
 *
 * `flight-recorder-port.test.ts` pins all of this on SQLite, and every one of
 * those tests constructs `new FlightRecorder(dbPath)` and promotes rows through
 * `DatabaseSync`. So until this block existed, the mechanism protecting migrated
 * history was verified only on the engine that history is migrating AWAY from,
 * while the PostgreSQL twin's four `completion_rank` predicates had no test at
 * all. That is the wrong way round: the cutover's target is PostgreSQL.
 */
describe("the completion rank fence (migrations/023)", () => {
  beforeEach(async () => {
    await recorder?.close();
    recorder = new PostgresFlightRecorder({ app: scoped(SCHEMA) }, { redactSecrets: false });
    await recorder.readStorageStats();
    await raw("DELETE FROM gateway_metadata; DELETE FROM requests");
  });

  it("a PRESUMED completion landing second cannot overwrite the OBSERVED one", async () => {
    // The #139 orphan sweep decides first and lands second. Rank 1 against a
    // stored 2, so the guess cannot displace the answer. Last-writer-wins is
    // what s7 measured losing the real completion here.
    await recorder.logStart(START);
    await recorder.logComplete(ID, { ...RESULT, response: "the real final answer" });
    await recorder.logComplete(ID, {
      ...RESULT,
      response: "stale orphan body",
      status: "failed",
      exitCode: 1,
      completionKind: "presumed",
    });

    const row = await recorder.readRequestById(ID);
    expect(row?.response).toBe("the real final answer");
    expect(row?.status).toBe("completed");
    expect(row?.exit_code).toBe(0);
    expect(await storedRank(ID)).toBe(2);
  });

  it("an OBSERVED completion landing second REPLACES the presumption", async () => {
    // The other ordering, and the commoner one. A `status <> 'started'` fence
    // gets this exactly wrong: it would freeze the sweep's guess and discard
    // the real answer. Rank admits it because 2 >= 1.
    await recorder.logStart(START);
    await recorder.logComplete(ID, {
      ...RESULT,
      response: "stale orphan body",
      status: "failed",
      exitCode: 1,
      completionKind: "presumed",
    });
    expect(await storedRank(ID)).toBe(1);

    await recorder.logComplete(ID, { ...RESULT, response: "the real final answer" });

    const row = await recorder.readRequestById(ID);
    expect(row?.response).toBe("the real final answer");
    expect(row?.status).toBe("completed");
    expect(await storedRank(ID)).toBe(2);
  });

  it("RANK 3 is reserved for imported history and nothing live can complete it", async () => {
    // What the s10 cutover writes, and the only thing standing between a
    // migrated transcript and a gateway that starts mid-copy. `completionKind`
    // deliberately cannot express 3, so neither observed (2) nor presumed (1)
    // satisfies `stored <= incoming`.
    await recorder.logStart(START);
    await recorder.logComplete(ID, { ...RESULT, response: "historical answer" });
    // Promoted on a connection the recorder does not own, exactly as the
    // cutover's copy would write it. The recorder has no API for rank 3 and
    // deliberately never will.
    await raw(`UPDATE gateway_metadata SET completion_rank = 3 WHERE request_id = '${ID}'`);

    await recorder.logComplete(ID, { ...RESULT, response: "live observed answer" });
    await recorder.logComplete(ID, {
      ...RESULT,
      response: "live presumed answer",
      status: "failed",
      completionKind: "presumed",
    });

    const row = await recorder.readRequestById(ID);
    expect(row?.response).toBe("historical answer");
    expect(row?.status).toBe("completed");
    expect(await storedRank(ID)).toBe(3);
  });

  it("a row the copy left at DEFAULT 0 is NOT protected, which is why s10 writes the literal 3", async () => {
    // The round-8 blocker, on the target engine. An INSERT that omits
    // `completion_rank` lands at DEFAULT 0 rather than failing, and every later
    // completion outranks it. This is the failure the cutover's one-sided
    // verification assertion exists to catch, so it is pinned here as the
    // behaviour that makes that assertion necessary.
    await raw(
      `INSERT INTO requests (id, datetime_utc, cli, model, prompt, response, owner_principal)
       VALUES ('imported-0', now()::text, 'claude', 'opus-5', 'p', 'historical answer', 'local');
       INSERT INTO gateway_metadata (request_id, status) VALUES ('imported-0', 'completed')`
    );
    const before = await raw<{ completion_rank: number }>(
      `SELECT completion_rank FROM gateway_metadata WHERE request_id = 'imported-0'`
    );
    expect(before[0].completion_rank).toBe(0);

    await recorder.logComplete("imported-0", { ...RESULT, response: "live overwrite" });

    const row = await recorder.readRequestById("imported-0");
    expect(row?.response).toBe("live overwrite");
  });
});

describe("readiness requires every transcript migration", () => {
  it("rejects a migration-022-only schema before reporting authoritative reads", async () => {
    const migration022 = readFileSync(
      join(process.cwd(), "migrations/022_flight_recorder_transcripts.sql"),
      "utf8"
    );
    await admin.query(
      `SET search_path TO ${INCOMPLETE};
       CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL);
       ${migration022}`
    );
    const logError = vi.fn();
    const incomplete = new PostgresFlightRecorder(
      { app: scoped(INCOMPLETE) },
      {
        redactSecrets: false,
        logger: { info: () => {}, error: logError },
      }
    );
    try {
      await expect(incomplete.readStorageStats()).rejects.toThrow(/every transcript migration/);
      expect(incomplete.health()).toMatchObject({
        state: "degraded",
        error: "PostgreSQL operation failed",
      });
      expect(incomplete.health().error).not.toContain("migration");
      const logs = logError.mock.calls
        .flat()
        .map(value => (value instanceof Error ? value.message : String(value)))
        .join(" ");
      expect(logs).toContain("every transcript migration");
    } finally {
      await incomplete.close();
    }
  });

  it.each([
    [NULLABLE_RANK, "DROP NOT NULL"],
    [DEFAULTLESS_RANK, "DROP DEFAULT"],
  ])(
    "rejects completion_rank when its write invariant is missing: %s",
    async (schema, alteration) => {
      await admin.query(
        `SET search_path TO ${schema};
       CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL);
       ${transcriptMigrations()}
       ALTER TABLE gateway_metadata ALTER COLUMN completion_rank ${alteration}`
      );
      const incomplete = new PostgresFlightRecorder(
        { app: scoped(schema) },
        { redactSecrets: false, logger: { info: () => {}, error: () => {} } }
      );
      try {
        await expect(incomplete.readStorageStats()).rejects.toThrow(/every transcript migration/);
        expect(incomplete.health()).toMatchObject({
          state: "degraded",
          error: "PostgreSQL operation failed",
        });
      } finally {
        await incomplete.close();
      }
    }
  );
});

describe("the bootstrap and the migration are the same schema", () => {
  it("produces identical columns and indexes either way", async () => {
    // Migration path: EVERY transcript migration, 022 onward, in version order.
    // Reading 022 alone was wrong the moment 023 added `completion_rank`: the
    // bootstrap carried the column, the mirror did not, and this test reported
    // the bootstrap as the drift. `check-transcript-schema-parity.mjs` already
    // selects them this way; hard-coding one file here left the same fact with
    // two readers and only one of them corrected.
    const sql = transcriptMigrations();
    await admin.query(
      `SET search_path TO ${MIRROR};
       CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL);
       ${sql}`
    );
    // Bootstrap path: whatever the recorder builds for itself, already run by
    // the beforeEach above in SCHEMA.
    const columns = async (schema: string): Promise<unknown[]> =>
      (
        await admin.query(
          `SELECT table_name, column_name, data_type, is_nullable, column_default
             FROM information_schema.columns
            WHERE table_schema = $1 AND table_name IN ('requests', 'gateway_metadata')
            ORDER BY table_name, column_name`,
          [schema]
        )
      ).rows;
    expect(await columns(SCHEMA)).toEqual(await columns(MIRROR));

    const indexes = async (schema: string): Promise<string[]> =>
      (
        await admin.query(
          `SELECT indexname, indexdef FROM pg_indexes
            WHERE schemaname = $1 AND tablename IN ('requests', 'gateway_metadata')
            ORDER BY indexname`,
          [schema]
        )
      ).rows.map(row => `${row.indexname} ${row.indexdef.replace(schema, "S")}`);
    const built = await indexes(SCHEMA);
    expect(built).toEqual(await indexes(MIRROR));
    // The six the SQLite schema carries, plus the two primary keys.
    expect(built.map(entry => entry.split(" ")[0])).toEqual([
      "gateway_metadata_pkey",
      "idx_metadata_status",
      "idx_requests_cli",
      "idx_requests_datetime",
      "idx_requests_model",
      "idx_requests_session",
      "idx_requests_stable_hash",
      "requests_pkey",
    ]);
  });

  it("records migration 22 in the ledger the runner reads", async () => {
    const rows = await admin.query(
      `SELECT version, name FROM ${MIRROR}.schema_migrations WHERE version = 22`
    );
    expect(rows.rows).toEqual([{ version: 22, name: "022_flight_recorder_transcripts" }]);
  });
});

describe("s11: the transcript termination on PostgreSQL", () => {
  const CUTOFF = "2030-01-01T00:00:00.000Z";

  async function seed(id: string, datetimeUtc: string): Promise<void> {
    await recorder.logStart({ ...START, correlationId: id, prompt: `p-${id}` });
    await recorder.logComplete(id, { ...RESULT, response: `r-${id}` });
    // `datetime_utc` is stamped at logStart, so ageing a row means writing the
    // column. Done on a connection the recorder does not own.
    await raw(`UPDATE requests SET datetime_utc = '${datetimeUtc}' WHERE id = '${id}'`);
  }

  beforeEach(async () => {
    await recorder?.close();
    recorder = new PostgresFlightRecorder({ app: scoped(SCHEMA) }, { redactSecrets: false });
    await recorder.readStorageStats();
    await raw("DELETE FROM gateway_metadata; DELETE FROM requests");
    await seed("old-1", "2020-01-01T00:00:00.000Z");
    await seed("old-2", "2020-01-01T00:00:00.000Z");
    await seed("keep-1", "2099-01-01T00:00:00.000Z");
  });

  it("takes the metadata row first, which the foreign key requires here too", async () => {
    // The CONTROL. migrations/022 carries `REFERENCES requests(id)` with no
    // ON DELETE CASCADE, exactly as the SQLite schema does, so the obvious
    // single DELETE fails on a real server rather than only on SQLite.
    await expect(raw(`DELETE FROM requests WHERE datetime_utc < '${CUTOFF}'`)).rejects.toThrow(
      /foreign key/i
    );
    expect(await recorder.evictExpiredRequests(CUTOFF, 500)).toBe(2);
    const rows = await raw<{ id: string }>("SELECT id FROM requests ORDER BY id");
    expect(rows.map(row => row.id)).toEqual(["keep-1"]);
    const meta = await raw<{ request_id: string }>(
      "SELECT request_id FROM gateway_metadata ORDER BY request_id"
    );
    expect(meta.map(row => row.request_id)).toEqual(["keep-1"]);
  });

  it("LEAVES the survivor's bodies untouched", async () => {
    await recorder.evictExpiredRequests(CUTOFF, 500);
    const row = await recorder.readRequestById("keep-1");
    expect(row?.prompt).toBe("p-keep-1");
    expect(row?.response).toBe("r-keep-1");
  });

  it("honours the row bound, so a shared store is not locked in one statement", async () => {
    expect(await recorder.evictExpiredRequests(CUTOFF, 1)).toBe(1);
    const stats = await recorder.readStorageStats(CUTOFF);
    expect(stats.requestRows).toBe(2);
    expect(stats.requestsBeyondRetention).toBe(1);
    expect(stats.oldestRequest).toBe("2020-01-01T00:00:00.000Z");
    expect(stats.newestRequest).toBe("2099-01-01T00:00:00.000Z");
  });

  it("reports NO reclaimable bytes, because that is not a question here", async () => {
    // Not zero. Autovacuum reuses the space and there is no operator step, so
    // a number would imply a lock to schedule that does not exist.
    expect((await recorder.readStorageStats()).reclaimableBytes).toBeNull();
  });
});
