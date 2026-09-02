/**
 * `llm_request_list` on the wire: the unkeyed route into the flight recorder.
 *
 * Registration is not reachability, so these go through the registered handler
 * rather than asserting a name appears in a list. The premise being defended is
 * that an agent holding NO correlation id and NO job id can still find a
 * request; every other flight-recorder read requires one.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGatewayServer } from "../index.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import { FlightRecorder } from "../flight-recorder.js";
import { noopLogger } from "../logger.js";
import type { PersistenceConfig } from "../config.js";
import { FileSessionManager } from "../session-manager.js";
import { runWithRequestContext, type GatewayRequestContext } from "../request-context.js";

interface RegisteredTool {
  handler: (
    args: Record<string, unknown>,
    extra?: Record<string, unknown>
  ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
  annotations?: Record<string, unknown>;
}

function mkPersistence(overrides: Partial<PersistenceConfig> = {}): PersistenceConfig {
  return {
    backend: "memory",
    path: null,
    dsn: null,
    retentionDays: 30,
    dedupWindowMs: 3600000,
    acknowledgeEphemeral: true,
    ownsOrphanRecovery: false,
    asyncJobsEnabled: true,
    sources: { configFile: null, envOverrides: [] },
    ...overrides,
  };
}

function ctx(authPrincipal?: string): GatewayRequestContext {
  return authPrincipal
    ? { transport: "http", authScopes: [], authPrincipal }
    : { transport: "stdio", authScopes: [] };
}

describe("llm_request_list (wire)", () => {
  let tmp: string;
  let flight: FlightRecorder;
  let server: ReturnType<typeof createGatewayServer>;

  function build(persistence: PersistenceConfig): ReturnType<typeof createGatewayServer> {
    return createGatewayServer({
      sessionManager: new FileSessionManager(join(tmp, "sessions.json")),
      asyncJobManager: new AsyncJobManager(noopLogger, undefined, new MemoryJobStore()),
      persistence,
      flightRecorder: flight,
    });
  }

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "reqlist-"));
    flight = new FlightRecorder(join(tmp, "logs.db"));
    server = build(mkPersistence());
  });

  afterEach(async () => {
    await flight.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function tools(s = server): Record<string, RegisteredTool> {
    return (s as unknown as Record<string, Record<string, RegisteredTool>>)._registeredTools;
  }

  async function call(
    args: Record<string, unknown>,
    principal?: string,
    s = server
  ): Promise<Record<string, any>> {
    const result = await runWithRequestContext(ctx(principal), () =>
      tools(s)["llm_request_list"].handler(args, {})
    );
    return JSON.parse(result.content[0].text);
  }

  async function seed(id: string, owner: string, jobId?: string): Promise<void> {
    await flight.logStart({
      correlationId: id,
      cli: "grok",
      model: "grok-4",
      prompt: "PROMPT-BODY",
      asyncJobId: jobId,
      ownerPrincipal: owner,
    });
    await flight.logComplete(id, {
      response: "RESPONSE-BODY",
      durationMs: 10,
      retryCount: 0,
      circuitBreakerState: "closed",
      optimizationApplied: false,
      exitCode: 0,
      status: "completed",
    });
  }

  it("finds a request from a caller holding no id at all", async () => {
    await seed("corr-1", "local");

    const res = await call({});

    expect(res.success).toBe(true);
    expect(res.count).toBe(1);
    expect(res.requests[0].correlationId).toBe("corr-1");
    // The listing must name its own successor tools, or the agent still guesses.
    expect(res.hint).toContain("llm_request_result");
    expect(res.hint).toContain("llm_job_status");
  });

  it("#296: sends an empty-handed reader to where the seat record actually is", async () => {
    // The hint used to stop at "validation seats write no flight-recorder row",
    // which is true and is the end of the trail. The seats write validation_runs
    // and validation_run_jobs, and each of those links a job row that holds the
    // launched argv and the provider output. A reader told only what is absent
    // opens the database; a reader told where to look calls the next tool.
    const res = await call({});

    expect(res.hint).toContain("validation_run_jobs");
    expect(res.hint).toContain("validation_receipt");
    expect(res.hint).toContain("llm_job_result");
    // And the opposite gap, which is what makes an OLD correlationId resolve
    // here and its job not resolve at all.
    expect(res.hint).toMatch(/request retention is unbounded by default/);
    expect(res.hint).toMatch(/job retention defaults to 30 days/);
  });

  it("hands back an asyncJobId usable with llm_job_*", async () => {
    await seed("corr-async", "local", "job-42");

    const res = await call({});

    expect(res.requests[0].asyncJobId).toBe("job-42");
  });

  it("never returns prompt or response bodies", async () => {
    await seed("corr-body", "local");

    const res = await call({});

    expect(JSON.stringify(res)).not.toContain("PROMPT-BODY");
    expect(JSON.stringify(res)).not.toContain("RESPONSE-BODY");
    expect(res.requests[0].promptChars).toBe("PROMPT-BODY".length);
    expect(res.requests[0].responseChars).toBe("RESPONSE-BODY".length);
  });

  it("is registered even with async jobs disabled, because it reads the recorder", async () => {
    const noAsync = build(
      mkPersistence({ backend: "none", asyncJobsEnabled: false, acknowledgeEphemeral: false })
    );

    expect(tools(noAsync)["llm_request_list"]).toBeDefined();
    // The gate that DOES apply at this setting, asserted so this test cannot
    // pass against a build where nothing is conditional at all.
    expect(tools(noAsync)["llm_job_status"]).toBeUndefined();

    await seed("corr-noasync", "local");
    const res = await call({}, undefined, noAsync);
    expect(res.requests[0].correlationId).toBe("corr-noasync");
  });

  it("shows a remote principal only its own rows", async () => {
    await seed("alice-row", "alice");
    await seed("bob-row", "bob");
    await seed("legacy-row", null as unknown as string);

    const alice = await call({}, "alice");
    expect(alice.requests.map((r: { correlationId: string }) => r.correlationId)).toEqual([
      "alice-row",
    ]);

    // Local stdio sees its legacy-unowned rows, and still not alice's or bob's.
    const local = await call({}, undefined);
    expect(local.requests.map((r: { correlationId: string }) => r.correlationId)).toEqual([
      "legacy-row",
    ]);
  });

  it("is annotated read-only", async () => {
    expect(tools()["llm_request_list"].annotations).toMatchObject({ readOnlyHint: true });
  });
});
