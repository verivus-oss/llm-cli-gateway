import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { FlightRecorder } from "../flight-recorder.js";
import { loadLcrPriorRows, computeLcrPriors } from "../lcr-priors.js";

// Phase_2: the lcr-priors loader is otherwise tested only against a STUB
// FlightRecorderQuery, which cannot catch a wrong column name. This exercises
// loadLcrPriorRows against a REAL FlightRecorder DB so the SELECT is validated
// against the actual requests/gateway_metadata schema (esp. where cost_usd lives).

describe("loadLcrPriorRows against a real flight-recorder DB", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "lcr-loader-test-"));
    dbPath = path.join(tmpDir, "logs.db");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads the projected columns for a completed T2 row (SQL matches the schema)", () => {
    const rec = new FlightRecorder(dbPath);
    rec.logStart({
      correlationId: "c1",
      cli: "gemini",
      model: "gemini-2.5-flash",
      prompt: "hello world",
    });
    rec.logComplete("c1", {
      response: "hi",
      durationMs: 5,
      retryCount: 0,
      circuitBreakerState: "closed",
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.001,
      costBasis: "derived-from-tokens",
      optimizationApplied: false,
      exitCode: 0,
      status: "completed",
    });
    rec.recordRouting("c1", {
      estCostUsd: 0.0012,
      estConfidence: "low",
      reason: "cheapest",
      considered: 3,
      reroutes: 0,
    });

    const rows = loadLcrPriorRows(rec);
    rec.close();

    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.provider).toBe("gemini");
    expect(row.model).toBe("gemini-2.5-flash");
    expect(row.prompt).toBe("hello world");
    expect(row.inputTokens).toBe(100);
    expect(row.outputTokens).toBe(40);
    expect(row.costBasis).toBe("derived-from-tokens");
    // cost_usd + route_est_cost_usd live on gateway_metadata; the join must surface them.
    expect(row.costUsd).toBe(0.001);
    expect(row.routeEstCostUsd).toBe(0.0012);
    expect(row.sessionContinued).toBe(false);
  });

  it("computes non-empty priors from real rows end to end", () => {
    const rec = new FlightRecorder(dbPath);
    for (let i = 0; i < 3; i++) {
      const id = `g${i}`;
      rec.logStart({
        correlationId: id,
        cli: "gemini",
        model: "gemini-2.5-flash",
        prompt: "some prose prompt here",
      });
      rec.logComplete(id, {
        response: "ok",
        durationMs: 5,
        retryCount: 0,
        circuitBreakerState: "closed",
        inputTokens: 50 + i,
        outputTokens: 200 + i,
        costUsd: 0.001,
        costBasis: "derived-from-tokens",
        optimizationApplied: false,
        exitCode: 0,
        status: "completed",
      });
    }
    const rows = loadLcrPriorRows(rec);
    rec.close();
    const priors = computeLcrPriors(rows, { priorsScope: "global" });
    expect(priors.outputPriors.get("gemini:gemini-2.5-flash")?.samples).toBe(3);
    expect(priors.outputPriors.get("gemini:gemini-2.5-flash")?.median).toBeGreaterThan(0);
  });
});
