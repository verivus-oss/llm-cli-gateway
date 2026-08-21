import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// awaitJobOrDefer owns the request-scoped cleanup when the async start fails.
//
// The contract (index.ts, above `awaitJobOrDefer`): once the function returns
// OR throws, the caller must consider `onComplete` consumed. codex-sync relies
// on it literally: its envelope is registered with
// `fireRequestCleanupInCatch: false` (index.ts:11642) precisely BECAUSE
// "awaitJobOrDefer's contract owns its request cleanup" (index.ts:2557). So if
// awaitJobOrDefer does not reclaim, nobody does.
//
// C3 made startJobWithDedup async. The start was assigned inside a try and
// awaited on the NEXT line, so the rejection surfaced outside the try: the
// catch was dead, `onCompleteOwnedByCaller = false` ran unconditionally, and
// the codex `--output-schema` temp file was leaked on every fail-closed start.
//
// The failure driven here is real, not stubbed: `maxQueuedJobs: 0` with the one
// process slot already held makes the limiter REJECT, and startJobWithDedup
// throws JobSaturationError after `this.jobs.delete(id)` -- one of the three
// rejection paths that never fire the manager's own artifact cleanup.

const { executeCliMock } = vi.hoisted(() => ({ executeCliMock: vi.fn() }));

vi.mock("../executor.js", async () => {
  const actual = await vi.importActual<typeof import("../executor.js")>("../executor.js");
  return { ...actual, executeCli: executeCliMock };
});

import { AsyncJobManager } from "../async-job-manager.js";
import { PersistenceConfig, type JobLimitsConfig } from "../config.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import { runWithRequestContext, type GatewayRequestContext } from "../request-context.js";
import { FileSessionManager } from "../session-manager.js";
import type { CodexRequestParams } from "../index.js";

const LOCAL: GatewayRequestContext = { transport: "stdio", authScopes: [] };

function persistenceMemory(): PersistenceConfig {
  return {
    backend: "memory",
    path: null,
    dsn: null,
    retentionDays: 30,
    dedupWindowMs: 3_600_000,
    acknowledgeEphemeral: true,
    ownsOrphanRecovery: false,
    asyncJobsEnabled: true,
    sources: { configFile: null, envOverrides: [] },
  };
}

/** maxQueuedJobs: 0 turns a saturated limiter into a REJECTION, not a queue. */
function rejectingLimits(): JobLimitsConfig {
  return {
    maxRunningJobs: 1,
    maxRunningJobsPerProvider: 1,
    maxQueuedJobs: 0,
    queueTimeoutMs: 10_000,
    completedJobMemoryTtlMs: 60 * 60 * 1000,
    maxJobOutputBytes: 50 * 1024 * 1024,
  };
}

function baseParams(overrides: Partial<CodexRequestParams> = {}): CodexRequestParams {
  return {
    prompt: "leak the schema temp file if the cleanup contract is broken",
    outputFormat: "text",
    fullAuto: false,
    dangerouslyBypassApprovalsAndSandbox: false,
    approvalStrategy: "legacy",
    createNewSession: false,
    optimizePrompt: false,
    optimizeResponse: false,
    forceRefresh: false,
    ...overrides,
  };
}

/** The temp file `prepareCodexOutputSchema` wrote, named in the built argv. */
function schemaPathFromArgs(args: string[]): string {
  const i = args.indexOf("--output-schema");
  expect(i).toBeGreaterThanOrEqual(0);
  const path = args[i + 1];
  expect(typeof path).toBe("string");
  return path!;
}

describe("awaitJobOrDefer reclaims request cleanup when the async start REJECTS", () => {
  let originalDeadline: string | undefined;
  let tmp: string;
  let sessions: FileSessionManager;

  beforeEach(() => {
    originalDeadline = process.env.SYNC_DEADLINE_MS;
    process.env.SYNC_DEADLINE_MS = "25";
    tmp = mkdtempSync(join(tmpdir(), "await-job-cleanup-"));
    sessions = new FileSessionManager(join(tmp, "sessions.json"));
    executeCliMock.mockReset();
    vi.resetModules();
  });

  afterEach(() => {
    if (originalDeadline === undefined) delete process.env.SYNC_DEADLINE_MS;
    else process.env.SYNC_DEADLINE_MS = originalDeadline;
    rmSync(tmp, { recursive: true, force: true });
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("does not leak the codex outputSchema temp file when the limiter rejects", async () => {
    const { handleCodexRequest, resolveGatewayServerRuntime } = await import("../index.js");
    const manager = new AsyncJobManager(
      noopLogger,
      undefined,
      new MemoryJobStore(),
      undefined,
      rejectingLimits()
    );
    await manager.whenStartupSettled();
    // Hold the only slot. With maxQueuedJobs: 0 the next acquire is rejected
    // outright rather than queued, so startJobWithDedup throws.
    const slot = await manager.acquireProcessSlot("codex");
    const runtime = resolveGatewayServerRuntime(
      {
        asyncJobManager: manager,
        sessionManager: sessions,
        logger: noopLogger,
        persistence: persistenceMemory(),
      },
      { isolateState: true }
    );
    // Call through: the REAL startJobWithDedup runs and rejects. The spy is
    // here only to read the argv, which is where the temp-file path lives.
    const start = vi.spyOn(manager, "startJobWithDedup");

    try {
      const result = await runWithRequestContext(LOCAL, () =>
        handleCodexRequest(
          { runtime, sessionManager: sessions, logger: noopLogger },
          baseParams({
            correlationId: "codex-cleanup-on-reject",
            outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
          })
        )
      );

      // The request failed, which is the whole point: this is the fail-closed
      // durable start the programme exists to surface.
      expect(result.isError).toBe(true);
      expect(start).toHaveBeenCalledTimes(1);

      const schemaPath = schemaPathFromArgs(start.mock.calls[0]![1] as string[]);
      // THE PROPERTY. Before the fix the dead catch left this file behind and
      // codex's envelope did not reclaim it either, so it survived the request.
      expect(existsSync(schemaPath)).toBe(false);
    } finally {
      slot.release();
      await manager.dispose();
    }
  });
});
