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
  let store: SqliteJobStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "validation-run-store-"));
    store = new SqliteJobStore(join(tempDir, "jobs.db"));
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* ignore */
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("round-trips a validation run record", () => {
    const record = runRecord();
    store.recordValidationRun(record);
    expect(store.getValidationRun("val-1")).toEqual(record);
  });

  it("returns null for an unknown validation id", () => {
    expect(store.getValidationRun("missing")).toBeNull();
  });

  it("is idempotent on the validation_id PK (INSERT OR IGNORE, no overwrite)", () => {
    store.recordValidationRun(runRecord({ status: "running" }));
    // A second write with the same id must NOT overwrite the existing row.
    store.recordValidationRun(runRecord({ status: "finalized", ownerPrincipal: "attacker" }));
    const stored = store.getValidationRun("val-1");
    expect(stored?.status).toBe("running");
    expect(stored?.ownerPrincipal).toBe("local");
  });

  it("sets the judge link on an existing run", () => {
    store.recordValidationRun(runRecord());
    store.setValidationJudgeLink("val-1", {
      provider: "codex",
      jobId: "job-judge",
      correlationId: "corr-judge",
    });
    expect(store.getValidationRun("val-1")?.judgeLink).toEqual({
      provider: "codex",
      jobId: "job-judge",
      correlationId: "corr-judge",
    });
  });

  it("updates the run status to finalized", () => {
    store.recordValidationRun(runRecord());
    store.setValidationRunStatus("val-1", "finalized");
    expect(store.getValidationRun("val-1")?.status).toBe("finalized");
  });

  it("persists across a re-open (CREATE TABLE IF NOT EXISTS is durable)", () => {
    const dbPath = join(tempDir, "reopen.db");
    const first = new SqliteJobStore(dbPath);
    first.recordValidationRun(runRecord({ validationId: "val-reopen" }));
    first.close();
    const second = new SqliteJobStore(dbPath);
    try {
      expect(second.getValidationRun("val-reopen")?.validationId).toBe("val-reopen");
    } finally {
      second.close();
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

// A minimal scripted async-job manager whose startJob always returns a running
// snapshot (mirrors the orchestrator test's scripted manager).
function scriptedManager() {
  let n = 0;
  return {
    startJob(cli: string, _args: string[], correlationId: string): AsyncJobSnapshot {
      n += 1;
      return {
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
      } as AsyncJobSnapshot;
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

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* ignore */
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes exactly one validation_runs row at kickoff with owner + provider links", () => {
    const manager = scriptedManager();
    const run = startValidationRun(
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

    const stored = store.getValidationRun(run.validationId);
    expect(stored).not.toBeNull();
    expect(stored?.ownerPrincipal).toBe("local"); // no request context => local principal
    expect(stored?.intent).toBe("validate");
    expect(stored?.status).toBe("running");
    expect(stored?.providerLinks.map(link => link.provider)).toEqual(["claude", "codex"]);
    expect(stored?.providerLinks.map(link => link.jobId)).toEqual(
      run.results.map(result => result.rawJobReference!.jobId)
    );
  });

  it("does not write a run row when no durable store is wired, but still returns a validationId", () => {
    const manager = scriptedManager();
    const run = startValidationRun(
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
    expect(store.getValidationRun(run.validationId)).toBeNull();
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

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* ignore */
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("links the judge job into an owned run", () => {
    store.recordValidationRun(runRecord({ validationId: "v-own", ownerPrincipal: "local" }));
    const synthesis = startJudgeSynthesis(deps(), {
      question: "?",
      providerResults: [completedResult("claude")],
      judgeProvider: "codex",
      validationId: "v-own",
    });
    expect(synthesis.status).toBe("running");
    expect(store.getValidationRun("v-own")?.judgeLink?.jobId).toBe(
      synthesis.rawJobReference!.jobId
    );
  });

  it("does not mutate a run owned by a different principal (own-or-not-found)", () => {
    store.recordValidationRun(
      runRecord({ validationId: "v-other", ownerPrincipal: "someone-else" })
    );
    const synthesis = startJudgeSynthesis(deps(), {
      question: "?",
      providerResults: [completedResult("claude")],
      judgeProvider: "codex",
      validationId: "v-other",
    });
    // The judge still starts (status running), but the cross-principal run is untouched.
    expect(synthesis.status).toBe("running");
    expect(store.getValidationRun("v-other")?.judgeLink).toBeNull();
  });

  it("behaves as before when no validationId is supplied", () => {
    const synthesis = startJudgeSynthesis(deps(), {
      question: "?",
      providerResults: [completedResult("claude")],
      judgeProvider: "codex",
    });
    expect(synthesis.status).toBe("running");
  });
});

// The durability gate's mechanism: getValidationRunStore() exposes the run store
// ONLY for an attached durable backend. index.ts wires it to the validation tools
// via `persistence.backend === "sqlite" ? asyncJobManager.getValidationRunStore() : null`,
// so this is the load-bearing half of that one-liner (memory/postgres/none can
// never produce a run store, with or without the redundant backend guard).
describe("AsyncJobManager.getValidationRunStore durability gate (Phase 0)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "validation-run-gate-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns the store for a durable sqlite backend", () => {
    const sqlite = new SqliteJobStore(join(tempDir, "jobs.db"));
    try {
      const manager = new AsyncJobManager(noopLogger, undefined, sqlite);
      expect(manager.getValidationRunStore()).toBe(sqlite);
    } finally {
      sqlite.close();
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

  it("startValidationRun still returns a validationId when recordValidationRun throws", () => {
    const run = startValidationRun(
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

  it("startJudgeSynthesis still starts the judge when the run store throws", () => {
    const synthesis = startJudgeSynthesis(
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
