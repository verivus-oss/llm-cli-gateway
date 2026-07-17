import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AsyncJobManager, type LlmCli } from "../async-job-manager.js";
import { OpenAiCompatibleProvider, type ApiRequest } from "../api-provider.js";
import type { ApiProviderRuntime } from "../config.js";
import { MemoryJobStore, SqliteJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import type { JobLimitsConfig } from "../config.js";
import type { ValidationProvider } from "../validation-normalizer.js";
import {
  startJudgeSynthesis,
  startReviewRun,
  ValidationRunPersistenceError,
} from "../validation-orchestrator.js";

function apiRuntime(name = "review-api"): ApiProviderRuntime {
  return {
    name,
    kind: "openai-compatible",
    apiKeyEnv: null,
    baseUrl: "http://127.0.0.1:1/v1",
    defaultModel: "review-model",
    apiKey: "test-key",
  };
}

const completedProviderResult = {
  provider: "codex" as ValidationProvider,
  model: "test",
  status: "completed" as const,
  verdict: "approve" as const,
  rationale: "No finding",
  risks: [],
  rawJobReference: null,
  error: null,
};

const completedReviewEvidence = {
  schemaVersion: "review-judge-evidence.v1" as const,
  provider: "codex",
  jobId: "job-codex",
  correlationId: "corr-codex",
  status: "completed",
  exitCode: 0,
  error: null,
  stdout: { text: "No finding", byteLength: 10, sha256: "a".repeat(64) },
  stderr: { text: "", byteLength: 0, sha256: "b".repeat(64) },
};

const directories: string[] = [];

function createStore(ownerPrincipal = "local"): {
  store: SqliteJobStore;
  validationId: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "validation-admission-barrier-"));
  directories.push(directory);
  const store = new SqliteJobStore(join(directory, "jobs.db"));
  const validationId = `validation-${directories.length}`;
  store.recordValidationRun({
    validationId,
    ownerPrincipal,
    intent: "review",
    createdAt: new Date(0).toISOString(),
    requestJson: JSON.stringify({ question: "review" }),
    providerLinks: [],
    judgeLink: null,
    status: "admitting",
  });
  return { store, validationId };
}

async function waitForTerminal(manager: AsyncJobManager, jobId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const status = manager.getJobSnapshot(jobId)?.status;
    if (status && status !== "queued" && status !== "running") return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Job ${jobId} did not become terminal`);
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("validation roster durable admission barrier", () => {
  it("rejects validation admission with null or non-validation stores before CLI or HTTP I/O", async () => {
    let requests = 0;
    const server: Server = createServer((request, response) => {
      requests++;
      request.resume();
      response.writeHead(200).end();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const noStoreManager = new AsyncJobManager(noopLogger);
    const memoryManager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    const marker = join(mkdtempSync(join(tmpdir(), "validation-no-store-")), "must-not-launch");
    directories.push(join(marker, ".."));
    try {
      expect(() =>
        noStoreManager.startJobWithDedup(
          "sh" as LlmCli,
          ["-c", `touch '${marker}'`],
          "no-store-cli",
          {
            forceRefresh: true,
            deferLaunch: true,
            validationAdmission: { validationId: "missing", provider: "codex" },
          }
        )
      ).toThrow(/Durable job admission failed/);
      expect(() =>
        memoryManager.startHttpJob({
          provider: new OpenAiCompatibleProvider("review-api"),
          apiRequest: {
            baseUrl,
            apiKey: "test-key",
            model: "m1",
            messages: [{ role: "user", content: "review" }],
          },
          correlationId: "memory-http",
          forceRefresh: true,
          deferLaunch: true,
          validationAdmission: { validationId: "missing", provider: "review-api" },
        })
      ).toThrow(/Durable job admission failed/);
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(existsSync(marker)).toBe(false);
      expect(requests).toBe(0);
    } finally {
      await noStoreManager.dispose();
      await memoryManager.dispose();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("holds a CLI process until its atomically linked queued job is released", async () => {
    const { store, validationId } = createStore();
    const manager = new AsyncJobManager(noopLogger, undefined, store);
    const marker = join(directories.at(-1)!, "cli-launched");
    try {
      const outcome = manager.startJobWithDedup(
        "sh" as LlmCli,
        ["-c", `touch '${marker}'`],
        "cli-barrier",
        {
          forceRefresh: true,
          deferLaunch: true,
          validationAdmission: { validationId, provider: "codex" },
        }
      );
      expect(outcome.snapshot.status).toBe("queued");
      expect(existsSync(marker)).toBe(false);
      expect(store.getById(outcome.snapshot.id)?.status).toBe("queued");
      expect(store.getValidationRun(validationId)?.providerLinks).toEqual([
        {
          provider: "codex",
          jobId: outcome.snapshot.id,
          correlationId: "cli-barrier",
        },
      ]);
      expect(store.getValidationRunIdByJobId(outcome.snapshot.id)).toBe(validationId);

      outcome.deferredLaunch!.release();
      await waitForTerminal(manager, outcome.snapshot.id);
      expect(existsSync(marker)).toBe(true);
    } finally {
      await manager.dispose();
      store.close();
    }
  });

  it("holds a permit granted later from the limiter queue until release", async () => {
    const { store, validationId } = createStore();
    const limits: JobLimitsConfig = {
      maxRunningJobs: 1,
      maxRunningJobsPerProvider: 1,
      maxQueuedJobs: 5,
      queueTimeoutMs: 10_000,
      completedJobMemoryTtlMs: 60_000,
      maxJobOutputBytes: 1024 * 1024,
    };
    const manager = new AsyncJobManager(noopLogger, undefined, store, undefined, limits);
    const marker = join(directories.at(-1)!, "queued-cli-launched");
    try {
      const blocker = manager.startJob("sleep" as LlmCli, ["5"], "barrier-blocker");
      const outcome = manager.startJobWithDedup(
        "sh" as LlmCli,
        ["-c", `touch '${marker}'`],
        "queued-cli-barrier",
        {
          forceRefresh: true,
          deferLaunch: true,
          validationAdmission: { validationId, provider: "codex" },
        }
      );
      expect(outcome.snapshot.status).toBe("queued");
      expect(manager.getLimiterSnapshot().queued).toBe(1);
      manager.cancelJob(blocker.id);
      const grantDeadline = Date.now() + 5_000;
      while (manager.getLimiterSnapshot().queued !== 0 && Date.now() < grantDeadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(manager.getLimiterSnapshot().queued).toBe(0);
      expect(manager.getJobSnapshot(outcome.snapshot.id)?.status).toBe("queued");
      expect(existsSync(marker)).toBe(false);

      outcome.deferredLaunch!.release();
      await waitForTerminal(manager, outcome.snapshot.id);
      expect(existsSync(marker)).toBe(true);
    } finally {
      await manager.dispose();
      store.close();
    }
  });

  it("launches no CLI process when the atomic validation link is rejected", async () => {
    const { store, validationId } = createStore("another-owner");
    const manager = new AsyncJobManager(noopLogger, undefined, store);
    const marker = join(directories.at(-1)!, "cli-must-not-launch");
    try {
      expect(() =>
        manager.startJobWithDedup("sh" as LlmCli, ["-c", `touch '${marker}'`], "cli-rejected", {
          forceRefresh: true,
          deferLaunch: true,
          validationAdmission: { validationId, provider: "codex" },
        })
      ).toThrow(/Durable job admission failed/);
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(existsSync(marker)).toBe(false);
      expect(store.getValidationRun(validationId)?.providerLinks).toEqual([]);
    } finally {
      await manager.dispose();
      store.close();
    }
  });

  it("holds HTTP I/O until release and sends nothing when link admission fails", async () => {
    let requests = 0;
    const server: Server = createServer((request, response) => {
      requests++;
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ model: "m1", choices: [{ message: { content: "ok" } }] }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const apiRequest: ApiRequest = {
      baseUrl,
      apiKey: "test-key",
      model: "m1",
      messages: [{ role: "user", content: "review" }],
    };
    const accepted = createStore();
    const acceptedManager = new AsyncJobManager(noopLogger, undefined, accepted.store);
    const rejected = createStore("another-owner");
    const rejectedManager = new AsyncJobManager(noopLogger, undefined, rejected.store);
    try {
      const outcome = acceptedManager.startHttpJob({
        provider: new OpenAiCompatibleProvider("review-api"),
        apiRequest,
        correlationId: "http-barrier",
        forceRefresh: true,
        deferLaunch: true,
        validationAdmission: { validationId: accepted.validationId, provider: "review-api" },
      });
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(outcome.snapshot.status).toBe("queued");
      expect(requests).toBe(0);
      expect(accepted.store.getValidationRunIdByJobId(outcome.snapshot.id)).toBe(
        accepted.validationId
      );
      outcome.deferredLaunch!.release();
      await waitForTerminal(acceptedManager, outcome.snapshot.id);
      expect(requests).toBe(1);

      expect(() =>
        rejectedManager.startHttpJob({
          provider: new OpenAiCompatibleProvider("review-api"),
          apiRequest,
          correlationId: "http-rejected",
          forceRefresh: true,
          deferLaunch: true,
          validationAdmission: {
            validationId: rejected.validationId,
            provider: "review-api",
          },
        })
      ).toThrow(/Durable job admission failed/);
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(requests).toBe(1);
      expect(rejected.store.getValidationRun(rejected.validationId)?.providerLinks).toEqual([]);
    } finally {
      await acceptedManager.dispose();
      await rejectedManager.dispose();
      accepted.store.close();
      rejected.store.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("cancels an actual prepared HTTP seat when a later roster input is too large", async () => {
    let requests = 0;
    const server: Server = createServer((request, response) => {
      requests++;
      request.resume();
      response.writeHead(200).end();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const { store } = createStore();
    let validationId = "";
    const originalRecord = store.recordValidationRun.bind(store);
    store.recordValidationRun = run => {
      validationId = run.validationId;
      originalRecord(run);
    };
    const manager = new AsyncJobManager(noopLogger, undefined, store);
    const reviewer = {
      ...apiRuntime(),
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    };
    try {
      expect(() =>
        startReviewRun(
          {
            asyncJobManager: manager,
            validationRunStore: store,
            apiProviders: [reviewer],
            getProviderRuntimeStatus: provider =>
              ({
                provider,
                displayName: provider,
                installed: true,
                version: "test",
                loginStatus: "authenticated",
              }) as never,
          },
          {
            prompt: "x".repeat(140_000),
            providers: ["review-api", "grok"],
            cwd: "/authorized/repository",
            artifactSha256: "a".repeat(64),
            artifactByteLength: 140_000,
            scope: "branch",
            reviewAuthorization: {
              schemaVersion: "review-run-authorization.v1",
              repositoryPath: "/authorized/repository",
              repositoryRoot: "/authorized/repository",
              judgeProvider: null,
              allowApiUpload: true,
            },
          }
        )
      ).toThrow(/too large/i);
      await new Promise(resolve => setTimeout(resolve, 25));
      const run = store.getValidationRun(validationId)!;
      expect(run.status).toBe("admission_failed");
      expect(run.providerLinks).toHaveLength(1);
      expect(manager.getJobSnapshot(run.providerLinks[0].jobId)?.status).toBe("canceled");
      expect(manager.getLimiterSnapshot()).toMatchObject({ running: 0, queued: 0 });
      expect(requests).toBe(0);
    } finally {
      await manager.dispose();
      store.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("rejects wrong-owner, closed, and duplicate judge claims before HTTP I/O", async () => {
    let requests = 0;
    const server: Server = createServer((request, response) => {
      requests++;
      request.resume();
      response.writeHead(200).end();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const { store } = createStore();
    const manager = new AsyncJobManager(noopLogger, undefined, store);
    const judge = {
      ...apiRuntime("judge-api"),
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    };
    const requestJson = JSON.stringify({
      judgeProvider: "judge-api",
      reviewAuthorization: { judgeProvider: "judge-api" },
    });
    store.recordValidationRun({
      validationId: "judge-wrong-owner",
      ownerPrincipal: "another-owner",
      intent: "review",
      createdAt: new Date(0).toISOString(),
      requestJson,
      providerLinks: [],
      judgeLink: null,
      status: "running",
    });
    store.recordValidationRun({
      validationId: "judge-closed",
      ownerPrincipal: "local",
      intent: "review",
      createdAt: new Date(0).toISOString(),
      requestJson,
      providerLinks: [],
      judgeLink: null,
      status: "finalized",
    });
    store.recordValidationRun({
      validationId: "judge-duplicate",
      ownerPrincipal: "local",
      intent: "review",
      createdAt: new Date(0).toISOString(),
      requestJson,
      providerLinks: [],
      judgeLink: {
        provider: "judge-api",
        jobId: "already-claimed",
        correlationId: "already-claimed",
      },
      status: "running",
    });
    try {
      for (const validationId of ["judge-wrong-owner", "judge-closed", "judge-duplicate"]) {
        expect(() =>
          startJudgeSynthesis(
            { asyncJobManager: manager, validationRunStore: store, apiProviders: [judge] },
            {
              question: "Judge",
              providerResults: [completedProviderResult],
              judgeProvider: "judge-api",
              validationId,
              cwd: "/authorized/repository",
              review: true,
              reviewEvidence: [completedReviewEvidence],
            }
          )
        ).toThrow(ValidationRunPersistenceError);
      }
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(manager.getLimiterSnapshot()).toMatchObject({ running: 0, queued: 0 });
      expect(requests).toBe(0);
    } finally {
      await manager.dispose();
      store.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
