import { describe, it, expect, vi, beforeEach } from "vitest";

// Issue #130: HTTP API jobs must not call runApiRequest until a limiter permit
// is acquired. We mock runApiRequest with a controllable, never-auto-resolving
// promise so a "running" http job holds its slot while we observe queueing, and
// we assert the mock is not invoked for a queued job.

const { runApiRequestMock } = vi.hoisted(() => ({ runApiRequestMock: vi.fn() }));

vi.mock("../api-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../api-provider.js")>("../api-provider.js");
  return { ...actual, runApiRequest: runApiRequestMock };
});

import { AsyncJobManager } from "../async-job-manager.js";
import type { JobLimitsConfig } from "../config.js";
import type { ApiProvider, ApiRequest, ApiResult } from "../api-provider.js";

function limits(overrides: Partial<JobLimitsConfig> = {}): JobLimitsConfig {
  return {
    maxRunningJobs: 1,
    maxRunningJobsPerProvider: 5,
    maxQueuedJobs: 5,
    queueTimeoutMs: 10_000,
    completedJobMemoryTtlMs: 60 * 60 * 1000,
    maxJobOutputBytes: 50 * 1024 * 1024,
    ...overrides,
  };
}

const provider: ApiProvider = {
  name: "openrouter",
  kind: "openai-compatible",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "test-key", // gitleaks:allow
} as unknown as ApiProvider;

function apiReq(model: string): ApiRequest {
  return {
    baseUrl: provider.baseUrl,
    model,
    messages: [{ role: "user", content: "hi" }],
  } as unknown as ApiRequest;
}

function result(text: string): ApiResult {
  return { text, httpStatus: 200, model: "m", usage: undefined } as unknown as ApiResult;
}

describe("AsyncJobManager HTTP limiter (issue #130)", () => {
  beforeEach(() => {
    runApiRequestMock.mockReset();
  });

  it("does not call runApiRequest for a queued http job until capacity frees", async () => {
    // First job's request hangs (holds the only run slot). Second job's request
    // resolves immediately once it is finally invoked.
    let releaseFirst: (r: ApiResult) => void = () => {};
    const firstPending = new Promise<ApiResult>(resolve => {
      releaseFirst = resolve;
    });
    runApiRequestMock
      .mockReturnValueOnce(firstPending)
      .mockResolvedValueOnce(result("second-done"));

    const manager = new AsyncJobManager(undefined, undefined, null, undefined, limits());

    const a = manager.startHttpJob({
      provider,
      apiRequest: apiReq("model-a"),
      correlationId: "c-a",
    });
    const b = manager.startHttpJob({
      provider,
      apiRequest: apiReq("model-b"),
      correlationId: "c-b",
    });

    // a is running (invoked once), b is queued (NOT invoked yet).
    expect(manager.getJobSnapshot(a.snapshot.id)!.status).toBe("running");
    expect(manager.getJobSnapshot(b.snapshot.id)!.status).toBe("queued");
    expect(runApiRequestMock).toHaveBeenCalledTimes(1);

    // Free the slot: a completes, which pumps the queue and starts b.
    releaseFirst(result("first-done"));
    await vi.waitFor(() => {
      expect(runApiRequestMock).toHaveBeenCalledTimes(2);
      expect(manager.getJobSnapshot(b.snapshot.id)!.status).toBe("completed");
    });
  });

  it("rejects an http job with a saturation error when the queue is full", async () => {
    runApiRequestMock.mockReturnValue(new Promise(() => {})); // all hang
    const manager = new AsyncJobManager(
      undefined,
      undefined,
      null,
      undefined,
      limits({ maxQueuedJobs: 0 })
    );

    manager.startHttpJob({ provider, apiRequest: apiReq("m1"), correlationId: "c1" }); // running
    expect(() =>
      manager.startHttpJob({ provider, apiRequest: apiReq("m2"), correlationId: "c2" })
    ).toThrow(/at capacity/i);
    // Only the first job's request was ever fired.
    expect(runApiRequestMock).toHaveBeenCalledTimes(1);
  });
});
