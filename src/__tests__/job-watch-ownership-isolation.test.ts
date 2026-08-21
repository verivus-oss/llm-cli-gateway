/**
 * s5: llm_job_watch's own-or-not-found guard, proven as a SECURITY property.
 *
 * Principal isolation in this gateway is enforced in application code, not by
 * the engine (storage-unification.md 3.2), and that is the stated reason a
 * SQLite-backed remote deployment is considered no more exposed than a Postgres
 * one. Two cross-principal IDOR defects were already found and fixed in 2.9.0.
 *
 * Making the job store async turned `accessible()` into a promise-returning
 * function while it was still called in boolean position. `accessible()` and
 * `!accessible()` are both ALWAYS TRUTHY/FALSY on a promise, so the ownership
 * gate stopped being evaluated. The compiler said nothing: the code still type
 * checks, because a promise is a perfectly good thing to put in a condition.
 *
 * These assert the PROPERTY, not the branch: principal A must not reach
 * principal B's job, and must be told "not found" rather than anything that
 * confirms the job exists. Reverting the fix makes the cross-principal read
 * SUCCEED, which is what a probe on a security control has to show.
 *
 * `llm_job_watch` is registered by the same `createGatewayServer` the HTTP
 * transport uses (http-transport.ts:209), so this guard is reachable from the
 * remote OAuth surface, not only from stdio.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGatewayServer } from "../index.js";
import { AsyncJobManager, type LlmCli } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import { NoopFlightRecorder } from "../flight-recorder.js";
import { noopLogger } from "../logger.js";
import type { PersistenceConfig } from "../config.js";
import { FileSessionManager } from "../session-manager.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithRequestContext, type GatewayRequestContext } from "../request-context.js";

function mkPersistence(): PersistenceConfig {
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
  };
}

function ctx(principal: string): GatewayRequestContext {
  return { transport: "http", authScopes: [], authPrincipal: principal };
}

interface RegisteredTool {
  handler: (
    args: Record<string, unknown>,
    extra?: Record<string, unknown>
  ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

describe("llm_job_watch cross-principal isolation", () => {
  let tmp: string;
  let manager: AsyncJobManager;
  let server: ReturnType<typeof createGatewayServer>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "watch-iso-"));
    manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    server = createGatewayServer({
      sessionManager: new FileSessionManager(join(tmp, "sessions.json")),
      asyncJobManager: manager,
      persistence: mkPersistence(),
      flightRecorder: new NoopFlightRecorder(),
    });
  });

  afterEach(async () => {
    await manager.dispose({ timeoutMs: 500 });
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Invoke the REGISTERED tool, not a helper. Registration is not reachability. */
  async function watch(jobId: string, principal: string): Promise<string> {
    const reg = (server as unknown as Record<string, Record<string, RegisteredTool>>)
      ._registeredTools;
    const result = await runWithRequestContext(ctx(principal), () =>
      reg["llm_job_watch"].handler({ jobId, waitMs: 0, afterProgressSeq: 0, progressLimit: 32 }, {})
    );
    return result.content[0].text;
  }

  async function startAs(principal: string, corr: string): Promise<string> {
    const outcome = await runWithRequestContext(ctx(principal), () =>
      manager.startJobWithDedup("echo" as LlmCli, ["hello"], corr, {})
    );
    return outcome.snapshot.id;
  }

  it("does NOT let bob read alice's job", async () => {
    const aliceJob = await startAs("alice", "corr-alice-1");

    const seen = await watch(aliceJob, "bob");

    // Denied, and denied as NOT FOUND: no existence oracle, no status leak.
    expect(seen).toMatch(/not found/i);
    expect(seen).not.toMatch(/running|queued|completed/i);
    // And nothing that identifies the job beyond the id bob already supplied.
    expect(seen).not.toMatch(/echo/);
  });

  it("DOES let alice read her own job, so the gate is not simply shut", async () => {
    // The control. A guard that denied everyone would satisfy the test above
    // while being just as broken in the other direction.
    const aliceJob = await startAs("alice", "corr-alice-2");

    const seen = await watch(aliceJob, "alice");

    expect(seen).not.toMatch(/not found/i);
    expect(seen).toMatch(new RegExp(aliceJob));
  });

  it("tells bob the same thing for a job that does not exist at all", async () => {
    // Own-or-not-found means a foreign job and an absent job are INDISTINGUISHABLE.
    // Without this, the denial itself confirms the job exists.
    const aliceJob = await startAs("alice", "corr-alice-3");

    const foreign = await watch(aliceJob, "bob");
    const absent = await watch("00000000-0000-4000-8000-000000000000", "bob");

    const normalise = (s: string): string => s.replace(/"jobId":\s*"[^"]*"/, '"jobId":"X"');
    expect(normalise(foreign)).toBe(normalise(absent));
  });
});
