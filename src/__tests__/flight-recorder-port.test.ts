import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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

    it("REQUIRED across writers: an earlier-decided completion landing second overwrites the final body", async () => {
      const instanceA = new FlightRecorder(dbPath);
      const instanceB = new FlightRecorder(dbPath);
      try {
        await instanceA.logStart({
          correlationId: "merge-1",
          cli: "claude",
          model: "opus",
          prompt: "p",
        });

        // DECIDED FIRST, by instance B's #139 orphan sweep.
        const decidedFirst = completion("stale orphan body", "failed");
        // DECIDED SECOND, by instance A, which actually has the answer.
        const decidedSecond = completion("the real final answer");

        // LANDS FIRST: the later decision. Deterministic, not timed: each call
        // is awaited to completion before the next is issued.
        await instanceA.logComplete("merge-1", decidedSecond);
        // LANDS SECOND: the earlier decision.
        await instanceB.logComplete("merge-1", decidedFirst);

        const row = await instanceA.readRequestById("merge-1");
        // Status IS monotonic: the metadata half is fenced to `started`, so the
        // stale writer could not move it back.
        expect(row?.status).toBe("completed");
        expect(row?.exit_code).toBe(0);
        // The body is NOT. The stale writer's response overwrote the final one,
        // and nothing anywhere reports it. This is the finding: a revision
        // fence is required rather than optional, for any deployment with two
        // writers on one row (the #139 sweep is exactly that).
        expect(row?.response).toBe("stale orphan body");
      } finally {
        await instanceA.close();
        await instanceB.close();
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
        // Status stays at the FIRST completion's value: the metadata half is
        // fenced to `started`, which is the monotonicity half of the rule.
        expect(row?.status).toBe("failed");
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
        expect(decision.deferredBecause).toBeUndefined();
      }
    });

    it("postgres is REFUSED with a reason rather than ignored", () => {
      const decision = flightRecorderEngineDecision("postgres");
      expect(decision.engine).toBe("sqlite");
      expect(decision.requested).toBe("postgres");
      // The hard gate, named so a reader of llm_process_health can act on it.
      expect(decision.deferredBecause).toMatch(/postgres-security-hardening\.md section 6/);
      expect(decision.deferredBecause).toMatch(/no Postgres transcript schema/i);
    });
  });
});
