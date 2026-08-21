import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SqliteJobStore,
  MemoryJobStore,
  isValidationRunStore,
  type ValidationRunRecord,
} from "../job-store.js";
import { startJudgeSynthesis, startValidationRun } from "../validation-orchestrator.js";
import { AsyncJobManager, type AsyncJobSnapshot } from "../async-job-manager.js";
import type { NormalizedValidationResult, ValidationProvider } from "../validation-normalizer.js";
import { noopLogger } from "../logger.js";
import { openDatabase } from "../sqlite-driver.js";
import { eagerMintFromJobId } from "../validation-receipt.js";

// Cross-LLM validation receipts (Phase 0): durable validation-run identity.

function runRecord(overrides: Partial<ValidationRunRecord> = {}): ValidationRunRecord {
  return {
    validationId: overrides.validationId ?? "val-1",
    ownerPrincipal: overrides.ownerPrincipal ?? "local",
    intent: overrides.intent ?? "validate",
    createdAt: overrides.createdAt ?? new Date(0).toISOString(),
    requestJson: overrides.requestJson ?? JSON.stringify({ question: "?" }),
    providerLinks: overrides.providerLinks ?? [
      { provider: "claude", jobId: "job-claude", correlationId: "corr-claude" },
    ],
    judgeLink: overrides.judgeLink ?? null,
    status: overrides.status ?? "running",
  };
}

describe("ValidationRunStore (SqliteJobStore)", () => {
  let tempDir: string;
  let dbPath: string;
  let store: SqliteJobStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "validation-run-store-"));
    dbPath = join(tempDir, "jobs.db");
    store = new SqliteJobStore(dbPath);
  });

  afterEach(async () => {
    try {
      await store.close();
    } catch {
      /* ignore */
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("round-trips a validation run record", async () => {
    const record = runRecord();
    await store.recordValidationRun(record);
    expect(await store.getValidationRun("val-1")).toEqual(record);
  });

  it.each([
    ["provider_links", "job-claude", /provider links are malformed/],
    ["judge_link", "job-judge", /judge link is malformed/],
  ] as const)(
    "fails closed when durable SQLite %s is malformed despite a surviving reverse link",
    async (column, reverseJobId, expectedError) => {
      await store.recordValidationRun(
        runRecord({
          requestJson: JSON.stringify({ question: "?", modelList: ["claude"] }),
          providerLinks:
            column === "provider_links"
              ? [{ provider: "claude", jobId: reverseJobId, correlationId: "corr-claude" }]
              : [],
          status: "running",
        })
      );
      if (column === "judge_link") {
        await store.setValidationJudgeLink("val-1", {
          provider: "codex",
          jobId: reverseJobId,
          correlationId: "corr-judge",
        });
      }

      const corruptionDb = openDatabase(dbPath);
      try {
        corruptionDb
          .prepare(`UPDATE validation_runs SET ${column} = ? WHERE validation_id = ?`)
          .run("not-json", "val-1");
      } finally {
        corruptionDb.close();
      }

      expect(await store.getValidationRunIdByJobId(reverseJobId)).toBe("val-1");
      await expect(store.getValidationRun("val-1")).rejects.toThrow(expectedError);
      await eagerMintFromJobId(
        { validationRunStore: store, asyncJobManager: {} as AsyncJobManager },
        reverseJobId
      );
      expect(await store.getValidationReceipt("val-1")).toBeNull();
    }
  );

  it("returns null for an unknown validation id", async () => {
    expect(await store.getValidationRun("missing")).toBeNull();
  });

  it("is idempotent on the validation_id PK (INSERT OR IGNORE, no overwrite)", async () => {
    await store.recordValidationRun(runRecord({ status: "running" }));
    // A second write with the same id must NOT overwrite the existing row.
    await store.recordValidationRun(runRecord({ status: "finalized", ownerPrincipal: "attacker" }));
    const stored = await store.getValidationRun("val-1");
    expect(stored?.status).toBe("running");
    expect(stored?.ownerPrincipal).toBe("local");
  });

  it("sets the judge link on an existing run", async () => {
    await store.recordValidationRun(runRecord());
    await store.setValidationJudgeLink("val-1", {
      provider: "codex",
      jobId: "job-judge",
      correlationId: "corr-judge",
    });
    expect((await store.getValidationRun("val-1"))?.judgeLink).toEqual({
      provider: "codex",
      jobId: "job-judge",
      correlationId: "corr-judge",
    });

    await expect(
      store.setValidationJudgeLink("val-1", {
        provider: "claude",
        jobId: "job-second-judge",
        correlationId: "corr-second-judge",
      })
    ).rejects.toThrow(/one-shot claim/);
    expect((await store.getValidationRun("val-1"))?.judgeLink).toEqual({
      provider: "codex",
      jobId: "job-judge",
      correlationId: "corr-judge",
    });
  });

  it("attaches provider links after a pre-dispatch run record", async () => {
    await store.recordValidationRun(runRecord({ providerLinks: [] }));
    const links = [
      { provider: "claude", jobId: "job-claude", correlationId: "corr-claude" },
      { provider: "codex", jobId: "job-codex", correlationId: "corr-codex" },
    ];
    await store.setValidationProviderLinks("val-1", links);
    expect((await store.getValidationRun("val-1"))?.providerLinks).toEqual(links);
    expect(await store.getValidationRunIdByJobId("job-claude")).toBe("val-1");
    expect(await store.getValidationRunIdByJobId("job-codex")).toBe("val-1");
  });

  it("atomically rolls back a queued job when validation-link admission fails", async () => {
    await store.recordValidationRun(
      runRecord({ intent: "review", providerLinks: [], status: "admitting" })
    );
    await expect(
      store.recordStart({
        id: "job-wrong-owner",
        correlationId: "corr-wrong-owner",
        requestKey: "request-wrong-owner",
        cli: "codex",
        args: ["exec"],
        startedAt: new Date(0).toISOString(),
        pid: null,
        ownerPrincipal: "other-owner",
        validationAdmission: { validationId: "val-1", provider: "codex" },
      })
    ).rejects.toThrow(/missing or owned by another principal/);
    expect(await store.getById("job-wrong-owner")).toBeNull();
    expect((await store.getValidationRun("val-1"))?.providerLinks).toEqual([]);
    expect(await store.getValidationRunIdByJobId("job-wrong-owner")).toBeNull();
  });

  it("atomically admits a queued job and its provider/reverse links", async () => {
    await store.recordValidationRun(
      runRecord({ intent: "review", providerLinks: [], status: "admitting" })
    );
    await store.recordStart({
      id: "job-admitted",
      correlationId: "corr-admitted",
      requestKey: "request-admitted",
      cli: "codex",
      args: ["exec"],
      startedAt: new Date(0).toISOString(),
      pid: null,
      ownerPrincipal: "local",
      validationAdmission: { validationId: "val-1", provider: "codex" },
    });
    expect((await store.getById("job-admitted"))?.status).toBe("queued");
    expect((await store.getValidationRun("val-1"))?.providerLinks).toEqual([
      { provider: "codex", jobId: "job-admitted", correlationId: "corr-admitted" },
    ]);
    expect(await store.getValidationRunIdByJobId("job-admitted")).toBe("val-1");
  });

  it("atomically claims the exact planned review judge only once", async () => {
    await store.recordValidationRun(
      runRecord({
        intent: "review",
        providerLinks: [],
        requestJson: JSON.stringify({
          judgeProvider: "judge-api",
          reviewAuthorization: { judgeProvider: "judge-api" },
        }),
        status: "running",
      })
    );
    await store.recordStart({
      id: "job-judge",
      correlationId: "corr-judge",
      requestKey: "request-judge",
      cli: "judge-api",
      args: [],
      startedAt: new Date(0).toISOString(),
      pid: null,
      ownerPrincipal: "local",
      validationAdmission: {
        validationId: "val-1",
        provider: "judge-api",
        role: "judge",
      },
    });
    expect((await store.getValidationRun("val-1"))?.judgeLink).toEqual({
      provider: "judge-api",
      jobId: "job-judge",
      correlationId: "corr-judge",
    });
    expect(await store.getValidationRunIdByJobId("job-judge")).toBe("val-1");

    await expect(
      store.recordStart({
        id: "job-judge-duplicate",
        correlationId: "corr-judge-duplicate",
        requestKey: "request-judge-duplicate",
        cli: "judge-api",
        args: [],
        startedAt: new Date(0).toISOString(),
        pid: null,
        ownerPrincipal: "local",
        validationAdmission: {
          validationId: "val-1",
          provider: "judge-api",
          role: "judge",
        },
      })
    ).rejects.toThrow(/already claimed/);
    expect(await store.getById("job-judge-duplicate")).toBeNull();
  });

  it("rejects a judge claim for the wrong plan, owner, or run state", async () => {
    const requestJson = JSON.stringify({
      judgeProvider: "judge-api",
      reviewAuthorization: { judgeProvider: "judge-api" },
    });
    for (const [validationId, ownerPrincipal, status] of [
      ["wrong-plan", "local", "running"],
      ["wrong-owner", "alice", "running"],
      ["closed", "local", "finalized"],
    ] as const) {
      await store.recordValidationRun(
        runRecord({
          validationId,
          ownerPrincipal,
          intent: "review",
          providerLinks: [],
          requestJson,
          status,
        })
      );
    }
    const attempts = [
      { validationId: "wrong-plan", provider: "other-judge", ownerPrincipal: "local" },
      { validationId: "wrong-owner", provider: "judge-api", ownerPrincipal: "local" },
      { validationId: "closed", provider: "judge-api", ownerPrincipal: "local" },
    ];
    for (const [index, attempt] of attempts.entries()) {
      const jobId = `rejected-judge-${index}`;
      await expect(
        store.recordStart({
          id: jobId,
          correlationId: `corr-${jobId}`,
          requestKey: `request-${jobId}`,
          cli: attempt.provider,
          args: [],
          startedAt: new Date(0).toISOString(),
          pid: null,
          ownerPrincipal: attempt.ownerPrincipal,
          validationAdmission: {
            validationId: attempt.validationId,
            provider: attempt.provider,
            role: "judge",
          },
        })
      ).rejects.toThrow();
      expect(await store.getById(jobId)).toBeNull();
    }
  });

  it("transitions roster state by owner and records a skipped judge atomically", async () => {
    await store.recordValidationRun(
      runRecord({
        intent: "review",
        providerLinks: [],
        requestJson: JSON.stringify({
          judgeProvider: "judge-api",
          reviewAuthorization: { judgeProvider: "judge-api" },
        }),
        status: "admitting",
      })
    );
    expect(await store.transitionValidationRunStatus("val-1", "other", "admitting", "running")).toBe(
      false
    );
    expect(await store.transitionValidationRunStatus("val-1", "local", "admitting", "running")).toBe(
      true
    );
    await store.skipValidationJudge("val-1", "judge-api", "local");
    expect((await store.getValidationRun("val-1"))?.status).toBe("judge_skipped");
  });

  it("updates the run status to finalized", async () => {
    await store.recordValidationRun(runRecord());
    await store.setValidationRunStatus("val-1", "finalized");
    expect((await store.getValidationRun("val-1"))?.status).toBe("finalized");
  });

  it("persists across a re-open (CREATE TABLE IF NOT EXISTS is durable)", async () => {
    const dbPath = join(tempDir, "reopen.db");
    const first = new SqliteJobStore(dbPath);
    await first.recordValidationRun(runRecord({ validationId: "val-reopen" }));
    await first.close();
    const second = new SqliteJobStore(dbPath);
    try {
      expect((await second.getValidationRun("val-reopen"))?.validationId).toBe("val-reopen");
    } finally {
      await second.close();
    }
  });

  it("isValidationRunStore is true for SqliteJobStore and false for MemoryJobStore", () => {
    expect(isValidationRunStore(store)).toBe(true);
    const memory = new MemoryJobStore();
    expect(isValidationRunStore(memory)).toBe(false);
    expect(isValidationRunStore(null)).toBe(false);
    expect(isValidationRunStore({})).toBe(false);
  });
});

// A minimal scripted async-job manager whose startJobWithDedup always returns a running
// snapshot (mirrors the orchestrator test's scripted manager).
function scriptedManager() {
  let n = 0;
  return {
    startJobWithDedup(
      cli: string,
      _args: string[],
      correlationId: string
    ): { snapshot: AsyncJobSnapshot; deduped: boolean } {
      n += 1;
      return {
        snapshot: {
          id: `job-${cli}-${n}`,
          cli,
          status: "running",
          startedAt: new Date(0).toISOString(),
          finishedAt: null,
          exitCode: null,
          correlationId,
          outputTruncated: false,
          stdoutBytes: 0,
          stderrBytes: 0,
          error: null,
          exited: false,
        } as AsyncJobSnapshot,
        deduped: false,
      };
    },
  };
}

describe("startValidationRun durable run persistence (Phase 0)", () => {
  let tempDir: string;
  let store: SqliteJobStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "validation-run-kickoff-"));
    store = new SqliteJobStore(join(tempDir, "jobs.db"));
  });

  afterEach(async () => {
    try {
      await store.close();
    } catch {
      /* ignore */
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes exactly one validation_runs row at kickoff with owner + provider links", async () => {
    const manager = scriptedManager();
    const run = await startValidationRun(
      {
        asyncJobManager: manager as any,
        getProviderRuntimeStatus: () => ({
          installed: true,
          version: "1",
          loginStatus: "authenticated",
          displayName: "X",
        }),
        validationRunStore: store,
      },
      { intent: "validate", question: "Is this safe?", providers: ["claude", "codex"] }
    );

    const stored = await store.getValidationRun(run.validationId);
    expect(stored).not.toBeNull();
    expect(stored?.ownerPrincipal).toBe("local"); // no request context => local principal
    expect(stored?.intent).toBe("validate");
    expect(stored?.status).toBe("running");
    expect(stored?.providerLinks.map(link => link.provider)).toEqual(["claude", "codex"]);
    expect(stored?.providerLinks.map(link => link.jobId)).toEqual(
      run.results.map(result => result.rawJobReference!.jobId)
    );
  });

  it("does not write a run row when no durable store is wired, but still returns a validationId", async () => {
    const manager = scriptedManager();
    const run = await startValidationRun(
      {
        asyncJobManager: manager as any,
        getProviderRuntimeStatus: () => ({
          installed: true,
          version: "1",
          loginStatus: "authenticated",
          displayName: "X",
        }),
        // no validationRunStore: mirrors a non-durable backend (memory/none)
      },
      { intent: "validate", question: "?", providers: ["claude"] }
    );

    expect(run.validationId).toMatch(/[0-9a-f-]{36}/);
    // Nothing was persisted anywhere; the run id is purely transient.
    expect(await store.getValidationRun(run.validationId)).toBeNull();
  });
});

function completedResult(provider: ValidationProvider): NormalizedValidationResult {
  return {
    provider,
    model: null,
    status: "completed",
    verdict: "approve",
    rationale: "ok",
    risks: [],
    rawJobReference: {
      jobId: `job-${provider}`,
      correlationId: `corr-${provider}`,
      statusTool: "job_status",
      resultTool: "job_result",
    },
    error: null,
  };
}

describe("startJudgeSynthesis judge-link persistence (Phase 0)", () => {
  let tempDir: string;
  let store: SqliteJobStore;

  function deps() {
    return {
      asyncJobManager: scriptedManager() as any,
      getProviderRuntimeStatus: () => ({
        installed: true,
        version: "1",
        loginStatus: "authenticated" as const,
        displayName: "Judge",
      }),
      validationRunStore: store,
    };
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "validation-judge-link-"));
    store = new SqliteJobStore(join(tempDir, "jobs.db"));
  });

  afterEach(async () => {
    try {
      await store.close();
    } catch {
      /* ignore */
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("links the judge job into an owned run", async () => {
    await store.recordValidationRun(runRecord({ validationId: "v-own", ownerPrincipal: "local" }));
    const synthesis = await startJudgeSynthesis(deps(), {
      question: "?",
      providerResults: [completedResult("claude")],
      judgeProvider: "codex",
      validationId: "v-own",
    });
    expect(synthesis.status).toBe("running");
    expect((await store.getValidationRun("v-own"))?.judgeLink?.jobId).toBe(
      synthesis.rawJobReference!.jobId
    );
  });

  it("does not mutate a run owned by a different principal (own-or-not-found)", async () => {
    await store.recordValidationRun(
      runRecord({ validationId: "v-other", ownerPrincipal: "someone-else" })
    );
    const synthesis = await startJudgeSynthesis(deps(), {
      question: "?",
      providerResults: [completedResult("claude")],
      judgeProvider: "codex",
      validationId: "v-other",
    });
    // The judge still starts (status running), but the cross-principal run is untouched.
    expect(synthesis.status).toBe("running");
    expect((await store.getValidationRun("v-other"))?.judgeLink).toBeNull();
  });

  it("behaves as before when no validationId is supplied", async () => {
    const synthesis = await startJudgeSynthesis(deps(), {
      question: "?",
      providerResults: [completedResult("claude")],
      judgeProvider: "codex",
    });
    expect(synthesis.status).toBe("running");
  });
});

// The durability gate's mechanism: getValidationRunStore() exposes the run store
// only for an attached backend that implements ValidationRunStore. index.ts
// wires that capability directly to the validation tools, so memory/none can
// never produce a run store.
describe("AsyncJobManager.getValidationRunStore durability gate (Phase 0)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "validation-run-gate-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns the store for a durable sqlite backend", async () => {
    const sqlite = new SqliteJobStore(join(tempDir, "jobs.db"));
    try {
      const manager = new AsyncJobManager(noopLogger, undefined, sqlite);
      expect(manager.getValidationRunStore()).toBe(sqlite);
    } finally {
      await sqlite.close();
    }
  });

  it("returns null for the ephemeral memory backend", () => {
    const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    expect(manager.getValidationRunStore()).toBeNull();
  });

  it("returns null when no store is attached", () => {
    const manager = new AsyncJobManager(noopLogger, undefined, null);
    expect(manager.getValidationRunStore()).toBeNull();
  });
});

// Graceful degradation: a persistence hiccup in the run store must never break
// the validation kickoff or judge synthesis (the caller still gets a validationId
// / a running synthesis).
describe("validation run persistence degrades gracefully on store errors (Phase 0)", () => {
  const throwingStore = {
    recordValidationRun(): void {
      throw new Error("boom");
    },
    getValidationRun(): never {
      throw new Error("boom");
    },
    setValidationJudgeLink(): void {
      throw new Error("boom");
    },
    setValidationRunStatus(): void {
      throw new Error("boom");
    },
  };

  it("startValidationRun still returns a validationId when recordValidationRun throws", async () => {
    const run = await startValidationRun(
      {
        asyncJobManager: scriptedManager() as any,
        getProviderRuntimeStatus: () => ({
          installed: true,
          version: "1",
          loginStatus: "authenticated",
          displayName: "X",
        }),
        validationRunStore: throwingStore as any,
      },
      { intent: "validate", question: "?", providers: ["claude"] }
    );
    expect(run.validationId).toMatch(/[0-9a-f-]{36}/);
  });

  it("startJudgeSynthesis still starts the judge when the run store throws", async () => {
    const synthesis = await startJudgeSynthesis(
      {
        asyncJobManager: scriptedManager() as any,
        getProviderRuntimeStatus: () => ({
          installed: true,
          version: "1",
          loginStatus: "authenticated",
          displayName: "Judge",
        }),
        validationRunStore: throwingStore as any,
      },
      {
        question: "?",
        providerResults: [completedResult("claude")],
        judgeProvider: "codex",
        validationId: "v-throws",
      }
    );
    expect(synthesis.status).toBe("running");
  });
});
