import { describe, expect, it, vi } from "vitest";
import { AsyncJobManager, type AsyncJobSnapshot } from "../async-job-manager.js";
import { type PersistenceConfig } from "../config.js";
import { createGatewayServer } from "../index.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";

interface RegisteredTool {
  handler: (
    args: Record<string, unknown>,
    extra: {
      signal: AbortSignal;
      _meta?: { progressToken?: string | number };
      sendNotification: (notification: unknown) => Promise<void>;
    }
  ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

function registeredTools(
  server: ReturnType<typeof createGatewayServer>
): Record<string, RegisteredTool> {
  return (server as unknown as Record<string, Record<string, RegisteredTool>>)._registeredTools;
}

function persistence(): PersistenceConfig {
  return {
    backend: "memory",
    path: null,
    dsn: null,
    retentionDays: 30,
    dedupWindowMs: 0,
    acknowledgeEphemeral: true,
    ownsOrphanRecovery: false,
    asyncJobsEnabled: true,
    sources: { configFile: null, envOverrides: [] },
  };
}

class WatchJobManager extends AsyncJobManager {
  private reads = 0;

  override getJobOwner(jobId: string): string | null | undefined {
    return jobId === "watch-job" ? "local" : undefined;
  }

  override getJobSnapshot(jobId: string): AsyncJobSnapshot | null {
    if (jobId !== "watch-job") return null;
    this.reads++;
    const startedAt = new Date(0).toISOString();
    return {
      id: jobId,
      cli: "codex",
      status: "running",
      startedAt,
      finishedAt: null,
      exitCode: null,
      correlationId: "watch-correlation",
      outputTruncated: false,
      stdoutBytes: 0,
      stderrBytes: 0,
      error: null,
      exited: false,
      progress: {
        capability: "structured",
        lastActivityAt: startedAt,
        lastSeq: this.reads > 1 ? 1 : 0,
        droppedCount: 0,
        events:
          this.reads > 1
            ? [
                {
                  seq: 1,
                  ts: startedAt,
                  phase: "thinking",
                  kind: "activity",
                  message: "Provider process is active",
                  source: "provider",
                },
              ]
            : [],
      },
    };
  }
}

class MultiEventWatchJobManager extends AsyncJobManager {
  override getJobOwner(jobId: string): string | null | undefined {
    return jobId === "watch-job" ? "local" : undefined;
  }

  override getJobSnapshot(jobId: string): AsyncJobSnapshot | null {
    if (jobId !== "watch-job") return null;
    const startedAt = new Date(0).toISOString();
    return {
      id: jobId,
      cli: "codex",
      status: "running",
      startedAt,
      finishedAt: null,
      exitCode: null,
      correlationId: "watch-correlation",
      outputTruncated: false,
      stdoutBytes: 0,
      stderrBytes: 0,
      error: null,
      exited: false,
      progress: {
        capability: "structured",
        lastActivityAt: startedAt,
        lastSeq: 3,
        droppedCount: 0,
        events: [1, 2, 3].map(seq => ({
          seq,
          ts: startedAt,
          phase: "thinking" as const,
          kind: "activity" as const,
          message: `Provider event ${seq}`,
          source: "provider" as const,
        })),
      },
    };
  }
}

describe("llm_job_watch cancellation", () => {
  it("does not emit progress notifications after the request is aborted", async () => {
    const manager = new WatchJobManager(noopLogger, undefined, new MemoryJobStore());
    const gateway = createGatewayServer({ asyncJobManager: manager, persistence: persistence() });
    const controller = new AbortController();
    const sendNotification = vi.fn(async () => undefined);

    const responsePromise = registeredTools(gateway).llm_job_watch.handler(
      { jobId: "watch-job", afterProgressSeq: 0, progressLimit: 32, waitMs: 1_000 },
      {
        signal: controller.signal,
        _meta: { progressToken: "watch-token" },
        sendNotification,
      }
    );
    setTimeout(() => controller.abort(), 10);
    const response = await responsePromise;

    expect(response.isError).not.toBe(true);
    expect(sendNotification).not.toHaveBeenCalled();
    await gateway.close();
  });

  it("stops a multi-event emission loop when notification delivery aborts the request", async () => {
    const manager = new MultiEventWatchJobManager(noopLogger, undefined, new MemoryJobStore());
    const gateway = createGatewayServer({ asyncJobManager: manager, persistence: persistence() });
    const controller = new AbortController();
    const delivered: unknown[] = [];
    const sendNotification = vi.fn(async (notification: unknown) => {
      delivered.push(notification);
      controller.abort();
    });

    const response = await registeredTools(gateway).llm_job_watch.handler(
      { jobId: "watch-job", afterProgressSeq: 0, progressLimit: 32, waitMs: 0 },
      {
        signal: controller.signal,
        _meta: { progressToken: "watch-token" },
        sendNotification,
      }
    );

    expect(response.isError).not.toBe(true);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(delivered).toHaveLength(1);
    await gateway.close();
  });
});
