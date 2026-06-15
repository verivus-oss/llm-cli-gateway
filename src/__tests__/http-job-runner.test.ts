/**
 * Slice 1 — HttpJobRunner: http jobs as first-class AsyncJobRecords.
 *
 * Exercises the http transport branch end-to-end against a loopback server:
 * lifecycle (start→complete), failure→exitCode 1 + httpStatus, cancel via
 * AbortController, dedup hit/miss, orphan-on-restart, the legacy-DB transport
 * migration, flight-recorder httpStatus, and the guard that an http job never
 * touches the process-group/pid machinery.
 */
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AsyncJobManager } from "../async-job-manager.js";
import { MemoryJobStore, SqliteJobStore } from "../job-store.js";
import {
  OpenAiCompatibleProvider,
  resetApiProviderBreakers,
  type ApiRequest,
} from "../api-provider.js";
import { openDatabase } from "../sqlite-driver.js";
import { mockLogger } from "./setup.js";

interface ServerControl {
  status: number;
  payload: string;
  delayMs: number;
}

async function waitForTerminal(mgr: AsyncJobManager, id: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snap = mgr.getJobSnapshot(id);
    if (snap && snap.status !== "running") return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`job ${id} did not terminate within ${timeoutMs}ms`);
}

describe("Slice 1 — HttpJobRunner", () => {
  let server: Server;
  let baseUrl: string;
  let control: ServerControl;
  let mgr: AsyncJobManager;
  let store: MemoryJobStore;

  const apiReq = (over: Partial<ApiRequest> = {}): ApiRequest => ({
    baseUrl,
    apiKey: "sk-test",
    model: "m1",
    messages: [{ role: "user", content: "ping" }],
    ...over,
  });

  beforeEach(async () => {
    resetApiProviderBreakers();
    control = {
      status: 200,
      payload: JSON.stringify({
        model: "m1",
        choices: [{ message: { content: "pong" } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
      delayMs: 0,
    };
    server = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        setTimeout(() => {
          res.writeHead(control.status, { "content-type": "application/json" });
          res.end(control.payload);
        }, control.delayMs);
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    store = new MemoryJobStore();
    mgr = new AsyncJobManager(mockLogger, undefined, store);
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it("runs an http job start→complete (stdout=text, httpStatus, exitCode 0)", async () => {
    const provider = new OpenAiCompatibleProvider("ollama");
    const { snapshot, deduped } = mgr.startHttpJob({
      provider,
      apiRequest: apiReq(),
      correlationId: "c1",
    });
    expect(deduped).toBe(false);
    expect(snapshot.cli).toBe("ollama");
    expect(snapshot.status).toBe("running");

    await waitForTerminal(mgr, snapshot.id);
    const result = mgr.getJobResult(snapshot.id)!;
    expect(result.status).toBe("completed");
    expect(result.stdout).toBe("pong");
    expect(result.exitCode).toBe(0);
  });

  it("never persists the apiKey into the durable jobs payload (secret-leak guard)", async () => {
    const { snapshot } = mgr.startHttpJob({
      provider: new OpenAiCompatibleProvider("ollama"),
      apiRequest: apiReq({ apiKey: "sk-super-secret-value" }),
      correlationId: "c-secret",
    });
    await waitForTerminal(mgr, snapshot.id);
    const row = store.getById(snapshot.id)!;
    expect(row.transport).toBe("http");
    expect(row.payloadJson).not.toBeNull();
    expect(row.payloadJson!).not.toContain("sk-super-secret-value");
    expect(row.payloadJson!).not.toContain("apiKey");
    // The canonical fields ARE persisted (so dedup/audit still work).
    expect(JSON.parse(row.payloadJson!).model).toBe("m1");
  });

  it("never registers a pid / process for an http job", () => {
    const { snapshot } = mgr.startHttpJob({
      provider: new OpenAiCompatibleProvider("ollama"),
      apiRequest: apiReq(),
      correlationId: "c-guard",
    });
    const running = mgr.getRunningJobs().find(j => j.jobId === snapshot.id);
    expect(running?.pid).toBeNull();
  });

  it("maps an HTTP failure to exitCode 1 with the real httpStatus", async () => {
    control.status = 503;
    control.payload = JSON.stringify({ error: { message: "overloaded" } });
    const { snapshot } = mgr.startHttpJob({
      provider: new OpenAiCompatibleProvider("ollama"),
      apiRequest: apiReq(),
      correlationId: "c-fail",
    });
    await waitForTerminal(mgr, snapshot.id, 8000);
    const result = mgr.getJobResult(snapshot.id)!;
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.error).toMatch(/503/);
    // exitCode (1) and the real HTTP status (503) are kept SEPARATE — the store
    // row carries http_status=503, never overloading exitCode.
    const row = store.getById(snapshot.id)!;
    expect(row.exitCode).toBe(1);
    expect(row.httpStatus).toBe(503);
  });

  it("cancels an in-flight http job via the AbortController", async () => {
    control.delayMs = 1000;
    const { snapshot } = mgr.startHttpJob({
      provider: new OpenAiCompatibleProvider("ollama"),
      apiRequest: apiReq(),
      correlationId: "c-cancel",
    });
    const res = mgr.cancelJob(snapshot.id);
    expect(res.canceled).toBe(true);
    expect(mgr.getJobSnapshot(snapshot.id)?.status).toBe("canceled");
  });

  it("dedups two identical http requests but not when the model differs", async () => {
    const provider = new OpenAiCompatibleProvider("ollama");
    const first = mgr.startHttpJob({ provider, apiRequest: apiReq(), correlationId: "d1" });
    await waitForTerminal(mgr, first.snapshot.id);

    const second = mgr.startHttpJob({ provider, apiRequest: apiReq(), correlationId: "d2" });
    expect(second.deduped).toBe(true);
    expect(second.snapshot.id).toBe(first.snapshot.id);

    const third = mgr.startHttpJob({
      provider,
      apiRequest: apiReq({ model: "m2" }),
      correlationId: "d3",
    });
    expect(third.deduped).toBe(false);
    expect(third.snapshot.id).not.toBe(first.snapshot.id);
  });

  it("dedup misses when only previousResponseId differs", async () => {
    const provider = new OpenAiCompatibleProvider("ollama");
    const a = mgr.startHttpJob({
      provider,
      apiRequest: apiReq({ previousResponseId: "r1" }),
      correlationId: "p1",
    });
    await waitForTerminal(mgr, a.snapshot.id);
    const b = mgr.startHttpJob({
      provider,
      apiRequest: apiReq({ previousResponseId: "r2" }),
      correlationId: "p2",
    });
    expect(b.deduped).toBe(false);
  });
});

describe("Slice 1 — http job persistence + orphan + migration (SqliteJobStore)", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "http-job-pg-"));
    dbPath = join(tempDir, "jobs.db");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("force-orphans an in-flight http row on restart and refuses to cancel it", () => {
    // First store: record a running http job, then "crash" (close).
    const store1 = new SqliteJobStore(dbPath, mockLogger);
    store1.recordStart({
      id: "job-http-1",
      correlationId: "orph-1",
      requestKey: "k1",
      cli: "ollama",
      args: [],
      startedAt: new Date().toISOString(),
      pid: null,
      transport: "http",
      payloadJson: JSON.stringify({ model: "m" }),
    });
    store1.close();

    // New gateway boot: a fresh store + manager flips it to orphaned.
    const store2 = new SqliteJobStore(dbPath, mockLogger);
    const mgr = new AsyncJobManager(mockLogger, undefined, store2);
    const row = store2.getById("job-http-1")!;
    expect(row.status).toBe("orphaned");
    expect(row.transport).toBe("http");

    // Hydrated http row has no live abort handle → cancel is refused.
    const snap = mgr.getJobSnapshot("job-http-1");
    expect(snap?.cli).toBe("ollama");
    const cancel = mgr.cancelJob("job-http-1");
    expect(cancel.canceled).toBe(false);
    store2.close();
  });

  it("migrates a legacy jobs table (no transport column) and backfills 'process'", () => {
    // Build a legacy schema lacking transport/http_status/payload_json.
    const legacy = openDatabase(dbPath);
    legacy.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY, correlation_id TEXT NOT NULL, request_key TEXT NOT NULL,
        cli TEXT NOT NULL, args_json TEXT NOT NULL, output_format TEXT, status TEXT NOT NULL,
        exit_code INTEGER, stdout TEXT, stderr TEXT, output_truncated INTEGER NOT NULL DEFAULT 0,
        error TEXT, started_at TEXT NOT NULL, finished_at TEXT, pid INTEGER, expires_at TEXT NOT NULL
      );
      INSERT INTO jobs (id, correlation_id, request_key, cli, args_json, status, output_truncated,
                        started_at, expires_at)
      VALUES ('legacy-1', 'corr', 'key', 'claude', '["-p","hi"]', 'completed', 0,
              '2026-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z');
    `);
    legacy.close();

    // Opening via SqliteJobStore runs ensureJobsTransportColumns.
    const store = new SqliteJobStore(dbPath, mockLogger);
    const row = store.getById("legacy-1")!;
    expect(row.transport).toBe("process");
    expect(row.httpStatus).toBeNull();
    expect(row.payloadJson).toBeNull();
    store.close();
  });
});
