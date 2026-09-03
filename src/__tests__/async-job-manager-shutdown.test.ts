import { randomUUID } from "crypto";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { AsyncJobManager, isAsyncJobInProgress, type LlmCli } from "../async-job-manager.js";
import { buildClaudeMcpConfig } from "../claude-mcp-config.js";
import type { JobLimitsConfig } from "../config.js";
import { SqliteJobStore } from "../job-store.js";
import type { KitExecutionRef } from "../personal-config-types.js";

function limits(overrides: Partial<JobLimitsConfig> = {}): JobLimitsConfig {
  return {
    maxRunningJobs: 1,
    maxRunningJobsPerProvider: 1,
    maxQueuedJobs: 5,
    queueTimeoutMs: 10_000,
    completedJobMemoryTtlMs: 60 * 60 * 1000,
    maxJobOutputBytes: 50 * 1024 * 1024,
    ...overrides,
  };
}

function execution(): KitExecutionRef {
  return {
    version: 1,
    releaseId: "shutdown-test-release",
    configStamp: "shutdown-test-stamp",
    scopeRoot: "/workspace/shutdown-test",
    scopeHead: "shutdown-test-head",
    contextIdentity: "shutdown-test-context",
  };
}

function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = async (): Promise<void> => {
      if (await condition()) return resolve();
      if (Date.now() >= deadline) return reject(new Error("waitFor timed out"));
      setTimeout(check, 10);
    };
    void check();
  });
}

describe("AsyncJobManager shutdown fencing", () => {
  it("never launches a queued process after dispose releases the running permit", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "async-shutdown-queue-"));
    const markerPath = join(testDir, "queued-job-started");
    const manager = new AsyncJobManager(undefined, undefined, null, undefined, limits());

    try {
      const running = await manager.startJob(
        "sh" as LlmCli,
        ["-c", "sleep 30"],
        "shutdown-running"
      );
      const queued = await manager.startJob(
        "sh" as LlmCli,
        ["-c", `printf started > ${JSON.stringify(markerPath)}; sleep 30`],
        "shutdown-queued"
      );
      expect((await manager.getJobSnapshot(running.id))?.status).toBe("running");
      expect((await manager.getJobSnapshot(queued.id))?.status).toBe("queued");

      await manager.dispose({ timeoutMs: 3_000 });
      await waitFor(
        async () => !isAsyncJobInProgress((await manager.getJobSnapshot(running.id)!).status)
      );

      expect(await manager.getJobSnapshot(queued.id)).toMatchObject({
        status: "failed",
        exitCode: 1,
      });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      await manager.dispose({ timeoutMs: 100 });
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("does not classify a TERM-trapped Kit process as completed during shutdown", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "async-shutdown-signal-"));
    const store = new SqliteJobStore(join(testDir, "jobs.db"));
    const manager = new AsyncJobManager(undefined, undefined, store);
    let terminalStatus: string | null = null;
    let terminalExitCode: number | null = null;

    try {
      const job = await manager.startJobWithDedup(
        "sh" as LlmCli,
        ["-c", 'trap "exit 0" TERM; while :; do sleep 1; done'],
        "shutdown-signal",
        {
          kitExecution: execution(),
          kitSessionId: "gateway-shutdown-signal",
          jobId: randomUUID(),
          forceRefresh: true,
          onTerminal: event => {
            terminalStatus = event.snapshot.status;
            terminalExitCode = event.snapshot.exitCode;
          },
        }
      );
      expect((await manager.getJobSnapshot(job.snapshot.id))?.status).toBe("running");

      await manager.dispose({ timeoutMs: 3_000 });
      await waitFor(() => terminalStatus !== null);

      expect(terminalStatus).toBe("failed");
      expect(terminalExitCode).toBe(1);
      expect(await store.getById(job.snapshot.id)).toMatchObject({
        status: "failed",
        exitCode: 1,
      });
    } finally {
      await manager.dispose({ timeoutMs: 100 });
      await store.close();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("drains a transient Kit terminal-write failure before clean disposal", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "async-shutdown-persist-"));
    const store = new SqliteJobStore(join(testDir, "jobs.db"));
    const manager = new AsyncJobManager(undefined, undefined, store);
    const recordComplete = store.recordComplete.bind(store);
    let allowTerminalWrite = false;
    let completeCalls = 0;
    let terminalHookCalls = 0;
    store.recordComplete = input => {
      completeCalls += 1;
      if (!allowTerminalWrite) throw new Error("transient terminal-store failure");
      return recordComplete(input);
    };

    try {
      const job = await manager.startJobWithDedup(
        "sh" as LlmCli,
        ["-c", "true"],
        "shutdown-persist",
        {
          kitExecution: execution(),
          kitSessionId: "gateway-shutdown-persist",
          jobId: randomUUID(),
          forceRefresh: true,
          onTerminal: () => {
            terminalHookCalls += 1;
          },
        }
      );
      await waitFor(
        async () => !isAsyncJobInProgress((await manager.getJobSnapshot(job.snapshot.id)!).status)
      );
      const inMemoryJob = (
        manager as unknown as { jobs: Map<string, { terminalPersistenceAcknowledged?: boolean }> }
      ).jobs.get(job.snapshot.id);
      expect(completeCalls).toBeGreaterThanOrEqual(1);
      expect(inMemoryJob?.terminalPersistenceAcknowledged).toBe(false);

      let disposeSettled = false;
      const disposing = manager.dispose({ timeoutMs: 1_000 }).then(() => {
        disposeSettled = true;
      });
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(disposeSettled).toBe(false);
      expect(terminalHookCalls).toBe(0);
      allowTerminalWrite = true;
      await disposing;

      expect(completeCalls).toBeGreaterThanOrEqual(2);
      expect(terminalHookCalls).toBe(1);
      expect(await store.getById(job.snapshot.id)).toMatchObject({
        status: "completed",
        kitTerminalFinalized: true,
      });
    } finally {
      await manager.dispose({ timeoutMs: 100 });
      await store.close();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("bounds an immediate retry whose terminal store write stalls", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "async-shutdown-stalled-retry-"));
    const store = new SqliteJobStore(join(testDir, "jobs.db"));
    const manager = new AsyncJobManager(undefined, undefined, store);
    const recordComplete = store.recordComplete.bind(store);
    let releaseRetry: (() => void) | undefined;
    const retryGate = new Promise<void>(resolve => {
      releaseRetry = resolve;
    });
    let completeCalls = 0;
    let deregistered = false;
    store.recordComplete = input => {
      completeCalls += 1;
      if (completeCalls === 1) throw new Error("initial terminal-store failure");
      return retryGate.then(() => recordComplete(input));
    };
    const deregisterInstance = store.deregisterInstance.bind(store);
    store.deregisterInstance = async instanceId => {
      deregistered = true;
      await deregisterInstance(instanceId);
    };

    try {
      const job = await manager.startJobWithDedup(
        "sh" as LlmCli,
        ["-c", "true"],
        "shutdown-stalled-retry",
        {
          kitExecution: execution(),
          kitSessionId: "gateway-shutdown-stalled-retry",
          jobId: randomUUID(),
          forceRefresh: true,
        }
      );
      await waitFor(
        async () => !isAsyncJobInProgress((await manager.getJobSnapshot(job.snapshot.id)!).status)
      );
      const inMemoryJob = (
        manager as unknown as {
          jobs: Map<
            string,
            {
              terminalPersistenceAcknowledged?: boolean;
              terminalWriteChain?: Promise<void>;
            }
          >;
        }
      ).jobs.get(job.snapshot.id);
      await waitFor(() => inMemoryJob?.terminalWriteChain === undefined);
      expect(inMemoryJob?.terminalPersistenceAcknowledged).toBe(false);

      const startedAt = Date.now();
      await manager.dispose({ timeoutMs: 75 });

      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(completeCalls).toBeGreaterThanOrEqual(2);
      expect(deregistered).toBe(false);
    } finally {
      releaseRetry?.();
      await manager.whenPendingWritesSettled();
      await store.close();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("tracks post-persistence artifact acknowledgement through the shutdown deadline", async () => {
    const originalHome = process.env.HOME;
    const testDir = mkdtempSync(join(tmpdir(), "async-shutdown-artifact-"));
    process.env.HOME = testDir;
    const config = buildClaudeMcpConfig([]);
    const store = new SqliteJobStore(join(testDir, "jobs.db"));
    const manager = new AsyncJobManager(undefined, undefined, store, undefined, limits());
    const acknowledgeMcpArtifactCleanup = store.acknowledgeMcpArtifactCleanup.bind(store);
    const deregisterInstance = store.deregisterInstance.bind(store);
    let releaseAcknowledgement: (() => void) | undefined;
    const acknowledgementGate = new Promise<void>(resolve => {
      releaseAcknowledgement = resolve;
    });
    let acknowledgementStarted = false;
    let deregistered = false;
    store.acknowledgeMcpArtifactCleanup = async (...args) => {
      acknowledgementStarted = true;
      await acknowledgementGate;
      return acknowledgeMcpArtifactCleanup(...args);
    };
    store.deregisterInstance = async instanceId => {
      deregistered = true;
      await deregisterInstance(instanceId);
    };

    try {
      const slot = await manager.acquireProcessSlot("claude");
      try {
        const queued = await manager.startJobWithDedup(
          "claude",
          ["-p", "review", "--mcp-config", config.path],
          "shutdown-artifact-acknowledgement",
          {
            forceRefresh: true,
            artifactCleanup: config.cleanup,
            mcpArtifactPath: config.path,
            mcpArtifactScope: config.artifactScope,
          }
        );
        expect(queued.snapshot.status).toBe("queued");

        const startedAt = Date.now();
        await manager.dispose({ timeoutMs: 75 });

        expect(Date.now() - startedAt).toBeLessThan(1_000);
        expect(acknowledgementStarted).toBe(true);
        expect(deregistered).toBe(false);
      } finally {
        slot.release();
      }
    } finally {
      releaseAcknowledgement?.();
      await manager.whenPendingWritesSettled();
      config.cleanup?.();
      await store.close();
      rmSync(testDir, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it("does not spawn after shutdown fences a stalled pre-spawn progress write", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "async-shutdown-pre-spawn-"));
    const markerPath = join(testDir, "late-process-started");
    const store = new SqliteJobStore(join(testDir, "jobs.db"));
    const manager = new AsyncJobManager(undefined, undefined, store, undefined, limits());
    const recordProgressIfStatus = store.recordProgressIfStatus.bind(store);
    let releaseProgress: (() => void) | undefined;
    const progressGate = new Promise<void>(resolve => {
      releaseProgress = resolve;
    });
    let runningProgressStarted = false;
    store.recordProgressIfStatus = async (...args) => {
      if (args[1] === "running") {
        runningProgressStarted = true;
        await progressGate;
      }
      return recordProgressIfStatus(...args);
    };

    try {
      const prepared = await manager.startJobWithDedup(
        "sh" as LlmCli,
        ["-c", `printf started > ${JSON.stringify(markerPath)}`],
        "shutdown-stalled-pre-spawn",
        { forceRefresh: true, deferLaunch: true }
      );
      expect(prepared.snapshot.status).toBe("queued");
      expect(prepared.deferredLaunch).toBeDefined();

      await new Promise(resolve => setTimeout(resolve, 1_050));
      prepared.deferredLaunch!.release();
      await waitFor(() => runningProgressStarted);

      const startedAt = Date.now();
      await manager.dispose({ timeoutMs: 75 });
      expect(Date.now() - startedAt).toBeLessThan(1_000);

      releaseProgress?.();
      await waitFor(
        async () =>
          !isAsyncJobInProgress((await manager.getJobSnapshot(prepared.snapshot.id)!).status)
      );
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(existsSync(markerPath)).toBe(false);
      expect(await manager.getJobSnapshot(prepared.snapshot.id)).toMatchObject({
        status: "failed",
        exitCode: 1,
      });
    } finally {
      releaseProgress?.();
      await manager.whenPendingWritesSettled();
      await store.close();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("bounds instance deregistration by the remaining shutdown deadline", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "async-shutdown-deregister-"));
    const store = new SqliteJobStore(join(testDir, "jobs.db"));
    const manager = new AsyncJobManager(undefined, undefined, store);
    const deregisterInstance = store.deregisterInstance.bind(store);
    let releaseDeregistration: (() => void) | undefined;
    const deregistrationGate = new Promise<void>(resolve => {
      releaseDeregistration = resolve;
    });
    let deregistrationStarted = false;
    store.deregisterInstance = async instanceId => {
      deregistrationStarted = true;
      await deregistrationGate;
      await deregisterInstance(instanceId);
    };

    try {
      await manager.whenStartupSettled();
      const startedAt = Date.now();
      await manager.dispose({ timeoutMs: 75 });

      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(deregistrationStarted).toBe(true);
    } finally {
      releaseDeregistration?.();
      await manager.whenPendingWritesSettled();
      await store.close();
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
