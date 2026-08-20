import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import {
  FlightRecorder,
  NoopFlightRecorder,
  type PersistedRequestSummaryRow,
} from "../flight-recorder.js";
import {
  listPersistedRequests,
  PERSISTED_REQUEST_LIST_MAX_LIMIT,
  PERSISTED_REQUEST_LIST_DEFAULT_LIMIT,
} from "../cache-stats.js";
import type { ProviderType } from "../provider-types.js";

/**
 * The gap this closes: every other flight-recorder read demands an id handed
 * out inline to the originating caller. These tests assert the unkeyed route
 * in, and that widening the read surface did not widen the ownership boundary.
 */
describe("listPersistedRequests", () => {
  let tmpDir: string;
  let rec: FlightRecorder;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "list-persisted-test-"));
    rec = new FlightRecorder(path.join(tmpDir, "logs.db"));
  });

  afterEach(() => {
    rec.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seed(opts: {
    id: string;
    cli?: ProviderType;
    when: string;
    sessionId?: string;
    asyncJobId?: string;
    owner?: string | null;
    prompt?: string;
    response?: string;
    providerSessionId?: string;
  }): void {
    rec.logStart({
      correlationId: opts.id,
      cli: opts.cli ?? "gemini",
      model: "gemini-2.5-pro",
      prompt: opts.prompt ?? "the prompt",
      sessionId: opts.sessionId,
      asyncJobId: opts.asyncJobId,
      ownerPrincipal: opts.owner === undefined ? "local" : opts.owner,
    });
    rec.logComplete(opts.id, {
      response: opts.response ?? "the verdict",
      durationMs: 1234,
      inputTokens: 100,
      outputTokens: 200,
      retryCount: 0,
      circuitBreakerState: "closed",
      costUsd: 0.01,
      optimizationApplied: false,
      exitCode: 0,
      status: "completed",
      providerSessionId: opts.providerSessionId,
    });
    // datetime_utc is stamped by logStart; overwrite it so ordering and the
    // `since` bound are asserted against known values rather than wall clock.
    (rec as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db
      .prepare("UPDATE requests SET datetime_utc = ? WHERE id = ?")
      .run(opts.when, opts.id);
  }

  it("finds requests with NO correlation id, which is the whole point", () => {
    seed({ id: "corr-a", when: "2026-08-21T10:00:00.000Z" });

    const rows = listPersistedRequests(rec, { callerPrincipal: "local" });

    expect(rows.map(r => r.correlationId)).toEqual(["corr-a"]);
    expect(rows[0].cli).toBe("gemini");
    expect(rows[0].status).toBe("completed");
    expect(rows[0].exitCode).toBe(0);
  });

  it("projects asyncJobId so the listing bootstraps into llm_job_*", () => {
    seed({ id: "corr-sync", when: "2026-08-21T10:00:00.000Z" });
    seed({ id: "corr-async", when: "2026-08-21T11:00:00.000Z", asyncJobId: "job-77" });

    const rows = listPersistedRequests(rec, { callerPrincipal: "local" });
    const byId = new Map(rows.map(r => [r.correlationId, r]));

    expect(byId.get("corr-async")!.asyncJobId).toBe("job-77");
    expect(byId.get("corr-sync")!.asyncJobId).toBeNull();
  });

  it("carries NO prompt or response text, only lengths", () => {
    seed({
      id: "corr-body",
      when: "2026-08-21T10:00:00.000Z",
      prompt: "SECRET-PROMPT-TEXT",
      response: "SECRET-RESPONSE-TEXT",
    });

    const [row] = listPersistedRequests(rec, { callerPrincipal: "local" });

    expect(JSON.stringify(row)).not.toContain("SECRET-PROMPT-TEXT");
    expect(JSON.stringify(row)).not.toContain("SECRET-RESPONSE-TEXT");
    expect(row.promptChars).toBe("SECRET-PROMPT-TEXT".length);
    expect(row.responseChars).toBe("SECRET-RESPONSE-TEXT".length);
  });

  it("orders newest-first", () => {
    seed({ id: "old", when: "2026-08-19T10:00:00.000Z" });
    seed({ id: "newest", when: "2026-08-21T10:00:00.000Z" });
    seed({ id: "middle", when: "2026-08-20T10:00:00.000Z" });

    const rows = listPersistedRequests(rec, { callerPrincipal: "local" });

    expect(rows.map(r => r.correlationId)).toEqual(["newest", "middle", "old"]);
  });

  it("filters by since, cli and sessionId", () => {
    seed({ id: "old-gemini", when: "2026-08-01T10:00:00.000Z" });
    seed({ id: "new-gemini", when: "2026-08-21T10:00:00.000Z", sessionId: "sess-1" });
    seed({ id: "new-grok", cli: "grok", when: "2026-08-21T11:00:00.000Z", sessionId: "sess-2" });

    expect(
      listPersistedRequests(rec, {
        callerPrincipal: "local",
        since: "2026-08-20T00:00:00.000Z",
      }).map(r => r.correlationId)
    ).toEqual(["new-grok", "new-gemini"]);

    expect(
      listPersistedRequests(rec, { callerPrincipal: "local", cli: "grok" }).map(
        r => r.correlationId
      )
    ).toEqual(["new-grok"]);

    expect(
      listPersistedRequests(rec, { callerPrincipal: "local", sessionId: "sess-1" }).map(
        r => r.correlationId
      )
    ).toEqual(["new-gemini"]);
  });

  it("clamps limit to the hard ceiling rather than trusting the caller", () => {
    // MUST exceed the ceiling, or "asked for more, got fewer" is satisfied by
    // there simply being fewer rows and the assertion proves nothing.
    const seeded = PERSISTED_REQUEST_LIST_MAX_LIMIT + 5;
    for (let i = 0; i < seeded; i += 1) {
      seed({ id: `corr-${i}`, when: `2026-08-21T10:00:${String(i % 60).padStart(2, "0")}.000Z` });
    }

    expect(listPersistedRequests(rec, { callerPrincipal: "local", limit: 2 })).toHaveLength(2);
    // The ceiling is the answer, not the caller's ask, and not the row count.
    expect(
      listPersistedRequests(rec, {
        callerPrincipal: "local",
        limit: PERSISTED_REQUEST_LIST_MAX_LIMIT + 10_000,
      })
    ).toHaveLength(PERSISTED_REQUEST_LIST_MAX_LIMIT);
    // An omitted limit is the default, not "everything".
    expect(listPersistedRequests(rec, { callerPrincipal: "local" })).toHaveLength(
      PERSISTED_REQUEST_LIST_DEFAULT_LIMIT
    );
    // A zero or negative ask cannot become an unbounded or invalid LIMIT.
    expect(listPersistedRequests(rec, { callerPrincipal: "local", limit: 0 })).toHaveLength(1);
    expect(listPersistedRequests(rec, { callerPrincipal: "local", limit: -10 })).toHaveLength(1);
  });

  describe("ownership (F3b own-or-not-found holds for the listing too)", () => {
    it("never lists another principal's rows", () => {
      seed({ id: "mine", when: "2026-08-21T10:00:00.000Z", owner: "user:alice" });
      seed({ id: "theirs", when: "2026-08-21T11:00:00.000Z", owner: "user:bob" });

      expect(
        listPersistedRequests(rec, { callerPrincipal: "user:alice" }).map(r => r.correlationId)
      ).toEqual(["mine"]);
    });

    it("hides legacy-unowned rows from a remote principal, shows them to local", () => {
      seed({ id: "legacy", when: "2026-08-21T10:00:00.000Z", owner: null });

      expect(listPersistedRequests(rec, { callerPrincipal: "user:bob" })).toEqual([]);
      expect(
        listPersistedRequests(rec, { callerPrincipal: "local" }).map(r => r.correlationId)
      ).toEqual(["legacy"]);
    });

    it("counts LIMIT against visible rows, so a page is not silently short", () => {
      // Interleave so a naive LIMIT-before-ownership query would return one
      // visible row when two were asked for.
      seed({ id: "theirs-1", when: "2026-08-21T12:00:00.000Z", owner: "user:bob" });
      seed({ id: "mine-1", when: "2026-08-21T11:00:00.000Z", owner: "user:alice" });
      seed({ id: "theirs-2", when: "2026-08-21T10:00:00.000Z", owner: "user:bob" });
      seed({ id: "mine-2", when: "2026-08-21T09:00:00.000Z", owner: "user:alice" });

      expect(
        listPersistedRequests(rec, { callerPrincipal: "user:alice", limit: 2 }).map(
          r => r.correlationId
        )
      ).toEqual(["mine-1", "mine-2"]);
    });

    it("drops another principal's row even when the SQL layer hands it over", () => {
      // The SQL scope is only a prefilter. This exercises the JS control on its
      // own by supplying a reader that ignores the WHERE clause entirely, which
      // is the exact failure the second layer exists to absorb. Without it this
      // control is never executed in both states by any other test here.
      const ignoresTheWhereClause = {
        readCacheRowsBySession: () => [],
        readCacheRowsByPrefix: () => [],
        readCacheRowsGlobal: () => [],
        readRequestById: () => null,
        readLcrPriorRows: () => [],
        readRoutingDecisions: () => [],
        listRequestSummaries: () =>
          [
            {
              id: "theirs",
              owner_principal: "user:bob",
              cli: "grok",
              model: "m",
              session_id: null,
              datetime_utc: "2026-08-21T11:00:00.000Z",
              duration_ms: 1,
              prompt_chars: 3,
              response_chars: 4,
              async_job_id: null,
              status: "completed",
              exit_code: 0,
              provider_session_id: null,
            },
            {
              id: "mine",
              owner_principal: "user:alice",
              cli: "grok",
              model: "m",
              session_id: null,
              datetime_utc: "2026-08-21T10:00:00.000Z",
              duration_ms: 1,
              prompt_chars: 3,
              response_chars: 4,
              async_job_id: null,
              status: "completed",
              exit_code: 0,
              provider_session_id: null,
            },
          ] as unknown as PersistedRequestSummaryRow[],
      };

      expect(
        listPersistedRequests(ignoresTheWhereClause, { callerPrincipal: "user:alice" }).map(
          r => r.correlationId
        )
      ).toEqual(["mine"]);

      // And the legacy-unowned arm, which has its own predicate branch.
      const legacyRow = {
        readCacheRowsBySession: () => [],
        readCacheRowsByPrefix: () => [],
        readCacheRowsGlobal: () => [],
        readRequestById: () => null,
        readLcrPriorRows: () => [],
        readRoutingDecisions: () => [],
        listRequestSummaries: () =>
          [
            {
              id: "legacy",
              owner_principal: null,
              cli: "grok",
              model: "m",
              session_id: null,
              datetime_utc: "2026-08-21T10:00:00.000Z",
              duration_ms: 1,
              prompt_chars: 3,
              response_chars: 4,
              async_job_id: null,
              status: "completed",
              exit_code: 0,
              provider_session_id: null,
            },
          ] as unknown as PersistedRequestSummaryRow[],
      };
      expect(listPersistedRequests(legacyRow, { callerPrincipal: "user:bob" })).toEqual([]);
      expect(listPersistedRequests(legacyRow, { callerPrincipal: "local" })).toHaveLength(1);
    });

    it("does not treat an empty principal as a wildcard", () => {
      seed({ id: "mine", when: "2026-08-21T10:00:00.000Z", owner: "user:alice" });
      seed({ id: "legacy", when: "2026-08-21T11:00:00.000Z", owner: null });

      expect(listPersistedRequests(rec, { callerPrincipal: "" })).toEqual([]);
    });
  });

  it("redacts a provider session id from the session field for remote callers", () => {
    seed({
      id: "corr-psid",
      when: "2026-08-21T10:00:00.000Z",
      sessionId: "wrapper-11112222-3333-4444-5555-666677778888-tail",
      providerSessionId: "11112222-3333-4444-5555-666677778888",
    });

    const remote = listPersistedRequests(rec, {
      callerPrincipal: "local",
      redactProviderSessionId: true,
    });
    expect(remote[0].sessionId).not.toContain("11112222-3333-4444-5555-666677778888");

    const local = listPersistedRequests(rec, { callerPrincipal: "local" });
    expect(local[0].sessionId).toContain("11112222-3333-4444-5555-666677778888");
  });

  it("returns [] rather than throwing when flight recording is disabled", () => {
    expect(listPersistedRequests(new NoopFlightRecorder(), { callerPrincipal: "local" })).toEqual(
      []
    );
  });
});
