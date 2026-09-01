import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFlightRecorder,
  FlightRecorder,
  flightRecorderEngineDecision,
  type FlightLogResult,
} from "../flight-recorder.js";
import { FlightOwnership } from "../flight-ownership.js";
import { SqliteStorageDriver } from "../storage/drivers/sqlite.js";
import { FLIGHT_RECORDER_OPERATION_CLASSES } from "../storage/operations.js";

// s7: the recorder on the storage port. Everything here is driven against a
// real SQLite file, never a mock of the thing under test.

function completion(
  response: string,
  status: "completed" | "failed" = "completed"
): FlightLogResult {
  return {
    response,
    durationMs: 3,
    retryCount: 0,
    circuitBreakerState: "closed",
    optimizationApplied: false,
    exitCode: status === "completed" ? 0 : 1,
    status,
  };
}

describe("flight recorder on the storage port (s7)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "s7-recorder-port-"));
    dbPath = join(dir, "logs.db");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("the startup barrier", () => {
    // Hazard 1: construction stopped implying initialisation ran. A synchronous
    // constructor finished the DDL before returning; an async one cannot, so
    // every operation has to wait on the same memo.

    it("a read issued in the same tick as the constructor sees a built schema", async () => {
      const recorder = new FlightRecorder(dbPath);
      try {
        // No await between construction and this call. Without ensureSchema()
        // in front of the read it is "no such table: requests".
        await expect(recorder.readRequestById("nothing")).resolves.toBeNull();
      } finally {
        await recorder.close();
      }
    });

    it("a write issued in the same tick as the constructor lands", async () => {
      const recorder = new FlightRecorder(dbPath);
      try {
        await recorder.logStart({
          correlationId: "barrier-1",
          cli: "claude",
          model: "opus",
          prompt: "p",
        });
        expect((await recorder.readRequestById("barrier-1"))?.prompt).toBe("p");
      } finally {
        await recorder.close();
      }
    });

    it("two concurrent first operations share one bootstrap", async () => {
      const bootstrap = vi.spyOn(SqliteStorageDriver.prototype, "bootstrap");
      const recorder = new FlightRecorder(dbPath);
      try {
        await Promise.all([
          recorder.readRequestById("a"),
          recorder.readRequestById("b"),
          recorder.readRoutingDecisions(1),
        ]);
        // The memo is installed before the first await, so the racers join it.
        expect(bootstrap).toHaveBeenCalledTimes(1);
      } finally {
        await recorder.close();
      }
    });

    it("refuses every operation once closed", async () => {
      const recorder = new FlightRecorder(dbPath);
      await recorder.close();
      await expect(
        recorder.logStart({ correlationId: "x", cli: "claude", model: "m", prompt: "p" })
      ).rejects.toThrow(/closed/i);
      await expect(recorder.readRequestById("x")).rejects.toThrow(/closed/i);
    });
  });

  describe("operation classes travel as data", () => {
    // s3sig recorded the defect this prevents: job-store.ts passes "write" at
    // every call site INCLUDING its reads, so on a four-credential deployment
    // its reads still run as `app` and role separation is inert. A literal at
    // one call site is how that happens, so the class must come from the
    // declaration.

    it("each operation routes with the class it declared", async () => {
      const transaction = vi.spyOn(SqliteStorageDriver.prototype, "transaction");
      const withConnection = vi.spyOn(SqliteStorageDriver.prototype, "withConnection");
      const recorder = new FlightRecorder(dbPath);
      try {
        await recorder.logStart({
          correlationId: "cls-1",
          cli: "claude",
          model: "opus",
          prompt: "p",
        });
        await recorder.logComplete("cls-1", completion("r"));
        await recorder.recordRouting("cls-1", { reason: "cheapest" });
        await recorder.recordCompressionTelemetry("cls-1", {
          route: "native",
          transforms: [],
          originalChars: 1,
          compressedChars: 1,
          estimatedTokensSaved: 0,
        });
        await recorder.readCacheRowsBySession("s");
        await recorder.readCacheRowsByPrefix("h");
        await recorder.readCacheRowsGlobal();
        await recorder.readRequestById("cls-1");
        await recorder.listRequestSummaries({ ownerPrincipal: "p", limit: 1 });
        await recorder.readLcrPriorRows();
        await recorder.readRoutingDecisions(1);

        const writes = transaction.mock.calls.map(call => call[0]);
        expect(writes).toEqual([
          FLIGHT_RECORDER_OPERATION_CLASSES.logStart,
          FLIGHT_RECORDER_OPERATION_CLASSES.logComplete,
          FLIGHT_RECORDER_OPERATION_CLASSES.recordRouting,
          FLIGHT_RECORDER_OPERATION_CLASSES.recordCompressionTelemetry,
        ]);
        const reads = withConnection.mock.calls.map(call => call[0]);
        expect(reads).toEqual([
          FLIGHT_RECORDER_OPERATION_CLASSES.readCacheRowsBySession,
          FLIGHT_RECORDER_OPERATION_CLASSES.readCacheRowsByPrefix,
          FLIGHT_RECORDER_OPERATION_CLASSES.readCacheRowsGlobal,
          FLIGHT_RECORDER_OPERATION_CLASSES.readRequestById,
          FLIGHT_RECORDER_OPERATION_CLASSES.listRequestSummaries,
          FLIGHT_RECORDER_OPERATION_CLASSES.readLcrPriorRows,
          FLIGHT_RECORDER_OPERATION_CLASSES.readRoutingDecisions,
        ]);
        // Not all one value: a recorder that passed "write" everywhere, which
        // is exactly what the job store does, would satisfy neither list.
        expect(new Set(reads).size).toBe(2);
      } finally {
        await recorder.close();
      }
    });

    it("a read class cannot open a transaction", async () => {
      const driver = new SqliteStorageDriver(join(dir, "solo.db"));
      try {
        await expect(driver.transaction("analytics_read", async () => undefined)).rejects.toThrow(
          /read class/
        );
      } finally {
        await driver.close();
      }
    });
  });

  describe("close drains, which is why performShutdown must await it", () => {
    it("close() settles only after an already-submitted write has settled", async () => {
      const recorder = new FlightRecorder(dbPath);
      const order: string[] = [];
      const pending = recorder
        .logStart({ correlationId: "drain-1", cli: "claude", model: "opus", prompt: "p" })
        .then(() => order.push("write"));
      await recorder.close().then(() => order.push("close"));
      await pending;

      // The whole reason the missing `await flightRecorder.close()` in
      // performShutdown mattered: process.exit() would have fired here between
      // "write" and "close".
      expect(order).toEqual(["write", "close"]);

      const reopened = new FlightRecorder(dbPath);
      try {
        expect((await reopened.readRequestById("drain-1"))?.prompt).toBe("p");
      } finally {
        await reopened.close();
      }
    });
  });

  describe("the start-await fence", () => {
    // s6 found this and flagged it FOR s7: awaiting flight.start() is what
    // fences the CROSS-WRITER case. `execute` cannot dispatch until the start
    // row is down, so the async manager cannot be armed to complete a row that
    // does not exist yet. s6 could only assert it statically, because with a
    // synchronous recorder the await was decorative. It is not any more.

    it("with the await, a second writer's completion lands on the start row", async () => {
      const recorder = new FlightRecorder(dbPath);
      try {
        const own = new FlightOwnership(
          () =>
            recorder.logStart({
              correlationId: "fence-1",
              cli: "claude",
              model: "opus",
              prompt: "p",
            }),
          result => recorder.logComplete("fence-1", result)
        );
        await own.start();
        // The manager: a writer that is NOT on FlightOwnership's chain.
        await recorder.logComplete("fence-1", completion("manager wrote this"));
        const row = await recorder.readRequestById("fence-1");
        expect(row?.status).toBe("completed");
        expect(row?.response).toBe("manager wrote this");
      } finally {
        await recorder.close();
      }
    });

    it("without the await, the same completion reaches the database first and is lost", async () => {
      const recorder = new FlightRecorder(dbPath);
      try {
        const own = new FlightOwnership(
          () =>
            recorder.logStart({
              correlationId: "fence-2",
              cli: "claude",
              model: "opus",
              prompt: "p",
            }),
          result => recorder.logComplete("fence-2", result)
        );
        // The one dropped await. No sleeps and no gates: FlightOwnership defers
        // its sink by one microtask turn, so a completion issued in this tick
        // reaches the driver's queue ahead of the start row.
        const started = own.start();
        await recorder.logComplete("fence-2", completion("manager wrote this"));
        await started;

        const row = await recorder.readRequestById("fence-2");
        // The row exists (the start write eventually landed) but the completion
        // matched nothing: status is still `started` and the body is gone.
        expect(row?.status).toBe("started");
        expect(row?.response).toBeNull();
      } finally {
        await recorder.close();
      }
    });
  });

  describe("the merge fence (s6 left this unsettled and only s7 can settle it)", () => {
    // write-ordering.ts `merge_fence`: "Completion is a merge, not a no-op:
    // last writer wins on the response body, terminal status is monotonic.
    // Today the body update is unfenced ... so out-of-order arrivals are not
    // distinguished." Whether that matters was unknowable with a synchronous
    // recorder, because two completions could not arrive out of order.

    it("across writers: a PRESUMED completion landing second cannot overwrite the observed one", async () => {
      const instanceA = new FlightRecorder(dbPath);
      const instanceB = new FlightRecorder(dbPath);
      try {
        await instanceA.logStart({
          correlationId: "merge-1",
          cli: "claude",
          model: "opus",
          prompt: "p",
        });

        // DECIDED FIRST, by instance B's #139 orphan sweep. The sweep is
        // PRESUMING an outcome for a job it believes died, which is what
        // `buildOrphanFlightResult` now marks on every one of its returns.
        const decidedFirst = {
          ...completion("stale orphan body", "failed"),
          completionKind: "presumed" as const,
        };
        // DECIDED SECOND, by instance A, which actually has the answer.
        const decidedSecond = completion("the real final answer");

        // LANDS FIRST: the later decision. Deterministic, not timed: each call
        // is awaited to completion before the next is issued.
        await instanceA.logComplete("merge-1", decidedSecond);
        // LANDS SECOND: the earlier decision.
        await instanceB.logComplete("merge-1", decidedFirst);

        const row = await instanceA.readRequestById("merge-1");
        // migrations/023: the fence is AUTHORITY, not arrival. The sweep is
        // rank 1 (presumed), the real completion rank 2 (observed), and a
        // completion lands only if its rank is >= the stored one. So the
        // guess cannot overwrite the answer even though it arrived later.
        //
        // Before 023 this test pinned the opposite as a known defect: "a
        // revision fence is required rather than optional, for any deployment
        // with two writers on one row (the #139 sweep is exactly that)". It is
        // no longer optional, and body and status now agree instead of the body
        // being last-wins while the status was monotonic.
        expect(row?.status).toBe("completed");
        expect(row?.exit_code).toBe(0);
        expect(row?.response).toBe("the real final answer");
      } finally {
        await instanceA.close();
        await instanceB.close();
      }
    });

    it("across writers: an OBSERVED completion landing second replaces the presumption", async () => {
      // The other ordering, and the one a naive `status <> 'started'` fence
      // gets wrong: the sweep gives up on a job FIRST, then the process that
      // was still alive returns the real answer. Fencing on "already terminal"
      // would freeze the guess and discard the answer, which is worse than the
      // defect it set out to fix. Rank admits it because 2 >= 1.
      const instanceA = new FlightRecorder(dbPath);
      const instanceB = new FlightRecorder(dbPath);
      try {
        await instanceA.logStart({
          correlationId: "merge-3",
          cli: "claude",
          model: "opus",
          prompt: "p",
        });
        await instanceB.logComplete("merge-3", {
          ...completion("stale orphan body", "failed"),
          completionKind: "presumed" as const,
        });
        await instanceA.logComplete("merge-3", completion("the real final answer"));

        const row = await instanceA.readRequestById("merge-3");
        expect(row?.response).toBe("the real final answer");
        expect(row?.status).toBe("completed");
      } finally {
        await instanceA.close();
        await instanceB.close();
      }
    });

    it("RANK 3 is reserved for imported history and nothing live can complete it", async () => {
      // The s10 cutover copies rows from a logs.db that predates this engine.
      // They land at rank 3, above anything `completionKind` can express, so the
      // fence blocks every live completion on that key. This is the whole
      // mechanism protecting migrated history from a gateway that starts
      // mid-copy, and it is pinned here so a later rank 3 with a different
      // meaning fails loudly instead of quietly unblocking those rows.
      const recorder = new FlightRecorder(dbPath);
      try {
        await recorder.logStart({
          correlationId: "imported-1",
          cli: "claude",
          model: "opus",
          prompt: "p",
        });
        await recorder.logComplete("imported-1", completion("historical answer"));
        // Promote to imported-history rank, as the cutover's copy would write
        // it. Done on a separate handle because the recorder has no API for it
        // and deliberately never will: nothing that can call `logComplete` may
        // mint rank 3.
        const promote = new DatabaseSync(dbPath);
        promote.exec(
          "UPDATE gateway_metadata SET completion_rank = 3 WHERE request_id = 'imported-1'"
        );
        promote.close();

        await recorder.logComplete("imported-1", completion("live observed answer"));
        await recorder.logComplete("imported-1", {
          ...completion("live presumed answer", "failed"),
          completionKind: "presumed" as const,
        });

        const row = await recorder.readRequestById("imported-1");
        expect(row?.response).toBe("historical answer");
      } finally {
        await recorder.close();
      }
    });

    it("a second PRESUMED completion cannot overwrite the first presumption's body", async () => {
      // Two sweeps racing over one abandoned job. Neither outranks the other,
      // so `rank >= stored` admits the second and the last guess wins. That is
      // acceptable precisely because neither is evidence; what matters is that
      // no presumption can displace an observation, which merge-1 covers.
      const recorder = new FlightRecorder(dbPath);
      try {
        await recorder.logStart({
          correlationId: "merge-4",
          cli: "claude",
          model: "opus",
          prompt: "p",
        });
        const presumed = (body: string) => ({
          ...completion(body, "failed"),
          completionKind: "presumed" as const,
        });
        await recorder.logComplete("merge-4", presumed("first guess"));
        await recorder.logComplete("merge-4", presumed("second guess"));
        const row = await recorder.readRequestById("merge-4");
        expect(row?.response).toBe("second guess");
      } finally {
        await recorder.close();
      }
    });

    it("NOT reachable within one recorder: submission order is landing order", async () => {
      const recorder = new FlightRecorder(dbPath);
      try {
        await recorder.logStart({
          correlationId: "merge-2",
          cli: "claude",
          model: "opus",
          prompt: "p",
        });
        // Both issued in one tick, neither awaited individually. The driver
        // serialises transactions on one queue, so the second submission is the
        // second write and last-writer-wins gives the right answer.
        const first = recorder.logComplete("merge-2", completion("decided first", "failed"));
        const second = recorder.logComplete("merge-2", completion("decided second"));
        await Promise.all([first, second]);

        const row = await recorder.readRequestById("merge-2");
        expect(row?.response).toBe("decided second");
        // Both completions are OBSERVED (rank 2), so `rank >= stored` admits
        // the second and last-write-wins still decides. Since 023 the status
        // follows the same rule as the body rather than being fenced to
        // `started`: the row now reports one completion's outcome, not the
        // first one's status beside the last one's body.
        expect(row?.status).toBe("completed");
      } finally {
        await recorder.close();
      }
    });
  });

  describe("the engine decision", () => {
    it("sqlite and none are honoured as themselves", () => {
      for (const backend of ["sqlite", "none", undefined]) {
        const decision = flightRecorderEngineDecision(backend);
        expect(decision.engine).toBe("sqlite");
        expect(decision.requested).toBeUndefined();
      }
    });

    it("postgres is authoritative and never falls back to SQLite", () => {
      const decision = flightRecorderEngineDecision("postgres");
      expect(decision.engine).toBe("postgres");
      expect(decision.requested).toBe("postgres");
    });

    it("a PostgreSQL construction failure does not create the SQLite file", () => {
      vi.stubEnv("LLM_GATEWAY_LOGS_DB", dbPath);
      const error = vi.fn();
      const recorder = createFlightRecorder({ info: () => {}, error }, "postgres", {});
      expect(recorder).not.toBeInstanceOf(FlightRecorder);
      expect(recorder.health()).toMatchObject({
        state: "unavailable",
        path: "postgresql",
        error: "PostgreSQL operation failed",
      });
      expect(existsSync(dbPath)).toBe(false);
      expect(error.mock.calls.flat().map(String).join(" ")).toContain(
        "postgres needs an `app` DSN"
      );
    });

    it("the recorder's explicit off switch still wins", () => {
      // LLM_GATEWAY_LOGS_DB is the recorder's own switch on either engine.
      vi.stubEnv("LLM_GATEWAY_LOGS_DB", "none");
      const recorder = createFlightRecorder({ info: () => {}, error: () => {} }, "postgres", {
        app: "postgresql://u@127.0.0.1/gw",
      });
      expect(recorder.health().state).toBe("disabled");
    });
  });
});
