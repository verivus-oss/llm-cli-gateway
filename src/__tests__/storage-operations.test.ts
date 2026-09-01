import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { FlightRecorder, NoopFlightRecorder } from "../flight-recorder.js";
import {
  FLIGHT_RECORDER_NON_OPERATIONS,
  FLIGHT_RECORDER_OPERATION_CLASSES,
  STATE_GROUP_AUTHORSHIP,
} from "../storage/operations.js";
import { STATE_INVENTORY } from "../storage/store.js";

const PROMPT = "s3sig-body-marker-prompt-9f2c";
const RESPONSE = "s3sig-body-marker-response-4a71";
const OWNER = "principal-s3sig";

describe("the flight recorder's declared operation set", () => {
  it("names every method the recorder actually has, or says why not", async () => {
    // The drift control. s7 implements FlightRecorderOperations; if the
    // recorder grows a method and the port surface does not, s7 ships a
    // subsystem with a write path the port cannot see, which is the exact
    // defect this programme exists to remove. Measured against the Noop
    // because it is the interface both implementations must satisfy.
    const real = Object.getOwnPropertyNames(NoopFlightRecorder.prototype).filter(
      name => name !== "constructor"
    );
    const declared = [
      ...Object.keys(FLIGHT_RECORDER_OPERATION_CLASSES),
      ...Object.keys(FLIGHT_RECORDER_NON_OPERATIONS),
    ];
    expect(new Set(declared)).toEqual(new Set(real));
  });

  it("keeps the one exclusion explicit rather than merely absent", async () => {
    // TWO exclusions since obs, and `flush` is still not one of them: it was
    // deleted from the recorder rather than ported, because a no-op named
    // "flush" on an asynchronous surface reads as a durability guarantee
    // nothing provides. `health` is the second, and it is a deliberate
    // extension of this list rather than an omission from the operation set.
    expect(Object.keys(FLIGHT_RECORDER_NON_OPERATIONS).sort()).toEqual(["health", "queryRequests"]);
    for (const reason of Object.values(FLIGHT_RECORDER_NON_OPERATIONS)) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it("reaches no PRAGMA and no VACUUM, by name or by argument", async () => {
    // The s3sig constraint, at the surface. Neither maintenance verb is an
    // operation, and no operation takes a statement: every parameter is a
    // domain value, so there is nothing for one to be smuggled through.
    for (const name of Object.keys(FLIGHT_RECORDER_OPERATION_CLASSES)) {
      expect(name.toLowerCase()).not.toMatch(/pragma|vacuum|exec|sql/);
    }
  });
});

describe("transcript_read is declared exactly where a body can come back", () => {
  let tmpDir: string;
  let recorder: FlightRecorder;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "s3sig-ops-"));
    recorder = new FlightRecorder(path.join(tmpDir, "logs.db"));
    await recorder.logStart({
      correlationId: "c-1",
      cli: "claude",
      model: "sonnet",
      prompt: PROMPT,
      sessionId: "sess-1",
      stablePrefixHash: "prefix-1",
      ownerPrincipal: OWNER,
    });
    await recorder.logComplete("c-1", {
      response: RESPONSE,
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 3,
      cacheCreationTokens: 4,
      durationMs: 5,
      retryCount: 0,
      circuitBreakerState: "CLOSED",
      costUsd: 0.01,
      costBasis: "provider-reported",
      optimizationApplied: false,
      exitCode: 0,
      status: "completed",
    });
    await recorder.recordRouting("c-1", { estCostUsd: 0.01, reason: "cheapest", considered: 2 });
  });

  afterEach(async () => {
    await recorder.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("the one transcript_read operation really does return the body", async () => {
    // Without this the next test passes vacuously: six reads returning nothing
    // also contain no prompt.
    const row = await recorder.readRequestById("c-1");
    expect(row?.prompt).toBe(PROMPT);
    expect(row?.response).toBe(RESPONSE);
    expect(FLIGHT_RECORDER_OPERATION_CLASSES.readRequestById).toBe("transcript_read");
  });

  it("no analytics_read operation returns prompt or response text", async () => {
    const analytics: Record<string, () => Promise<unknown>> = {
      readCacheRowsBySession: () => recorder.readCacheRowsBySession("sess-1"),
      readCacheRowsByPrefix: () => recorder.readCacheRowsByPrefix("prefix-1"),
      readCacheRowsGlobal: () => recorder.readCacheRowsGlobal(),
      listRequestSummaries: () =>
        recorder.listRequestSummaries({ ownerPrincipal: OWNER, limit: 5 }),
      readLcrPriorRows: () => recorder.readLcrPriorRows(),
      readRoutingDecisions: () => recorder.readRoutingDecisions(5),
    };
    for (const [name, read] of Object.entries(analytics)) {
      expect(FLIGHT_RECORDER_OPERATION_CLASSES, name).toHaveProperty(name, "analytics_read");
      const serialized = JSON.stringify(await read());
      expect(serialized, `${name} returned no rows, so it proves nothing`).not.toBe("[]");
      expect(serialized, `${name} leaked prompt text`).not.toContain(PROMPT);
      expect(serialized, `${name} leaked response text`).not.toContain(RESPONSE);
    }
  });
});

describe("the state inventory after the durable subsystems reached the port", () => {
  it("gives every group a determination about who authors its operations", async () => {
    expect(Object.keys(STATE_GROUP_AUTHORSHIP).sort()).toEqual(
      STATE_INVENTORY.map(group => group.id).sort()
    );
  });

  it("names the three in-port groups no DAG node carries", async () => {
    // s3 part 1 wrote inPort: true for eleven groups, which reads as a plan.
    // These three have no node and never had one. Pinned so a fourth cannot
    // join them silently and so these three cannot be quietly dropped.
    const unowned = STATE_INVENTORY.filter(g => g.inPort && !g.owningNode).map(g => g.id);
    expect(unowned).toEqual(["approvals", "admin_audit", "workspace_registry"]);
  });

  it("marks as carried exactly the groups the completed nodes moved", async () => {
    const carried = STATE_INVENTORY.filter(g => g.carried).map(g => g.id);
    expect(carried).toEqual([
      "jobs",
      "validation_runs",
      "validation_receipts",
      "kit_persistence",
      "requests",
      "gateway_metadata",
    ]);
    for (const group of STATE_INVENTORY.filter(g =>
      ["jobs", "validation_runs", "validation_receipts", "kit_persistence"].includes(g.id)
    )) {
      expect(group.owningNode).toBe("s5.job-store-first");
    }
    for (const group of STATE_INVENTORY.filter(g =>
      ["requests", "gateway_metadata"].includes(g.id)
    )) {
      expect(group.owningNode).toBe("s7.flight-recorder-onto-the-port");
    }
  });

  it("records the dual-engine transcript groups as completed work", async () => {
    for (const id of ["requests", "gateway_metadata"] as const) {
      const group = STATE_INVENTORY.find(g => g.id === id);
      expect(group?.owningNode).toBe("s7.flight-recorder-onto-the-port");
      expect(group?.current).toBe("logs.db or Postgres");
      expect(group?.carried).toBe(true);
      expect(group?.note).toBeTruthy();
    }
  });
});
