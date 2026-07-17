import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteJobStore, type ValidationReceiptRecord } from "../job-store.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { noopLogger } from "../logger.js";
import {
  canonicalJson,
  computeCanonicalSha256,
  eagerMintFromJobId,
  eagerMintFromValidationId,
  resolveValidationReceipt,
  VALIDATION_RECEIPT_SCHEMA_VERSION,
  type ReceiptDeps,
} from "../validation-receipt.js";
import {
  buildValidationReport,
  deriveValidationRunStatus,
  renderHumanReport,
} from "../validation-report.js";
import { normalizeJobResult } from "../validation-normalizer.js";
import { startJudgeSynthesis } from "../validation-orchestrator.js";

// Cross-LLM validation receipts (Phase 1): canonical hash + mint + resolve.

describe("canonical serialization + hash", () => {
  it("is stable across object key insertion order", () => {
    const a = { b: 1, a: { y: 2, x: [3, 4] } };
    const b = { a: { x: [3, 4], y: 2 }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(computeCanonicalSha256(a as any)).toBe(computeCanonicalSha256(b as any));
  });

  it("preserves array order (arrays are not sorted)", () => {
    expect(canonicalJson({ x: [1, 2, 3] })).not.toBe(canonicalJson({ x: [3, 2, 1] }));
  });

  it("changes when any hashed field changes", () => {
    const base = computeCanonicalSha256({ a: 1 } as any);
    expect(computeCanonicalSha256({ a: 2 } as any)).not.toBe(base);
  });
});

describe("validation receipt mint + resolve", () => {
  let tempDir: string;
  let store: SqliteJobStore;
  let manager: AsyncJobManager;
  let deps: ReceiptDeps;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "validation-receipt-"));
    store = new SqliteJobStore(join(tempDir, "jobs.db"));
    // Construct the manager BEFORE seeding jobs so its boot-time orphan sweep
    // does not flip our freshly added running rows.
    manager = new AsyncJobManager(noopLogger, undefined, store);
    deps = { asyncJobManager: manager, validationRunStore: store };
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* ignore */
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  function seedJob(
    id: string,
    opts: {
      owner?: string;
      status?: "running" | "completed" | "failed";
      stdout?: string;
      cli?: "claude" | "codex";
      correlationId?: string;
      outputTruncated?: boolean;
    } = {}
  ): void {
    const now = new Date().toISOString();
    store.recordStart({
      id,
      correlationId: opts.correlationId ?? `corr-${id}`,
      requestKey: "k",
      cli: opts.cli ?? (id.includes("codex") || id.includes("judge") ? "codex" : "claude"),
      args: [],
      startedAt: now,
      pid: null,
      ownerPrincipal: opts.owner ?? "local",
    });
    // #139: recordStart now persists 'queued'; flip to 'running' for a running
    // seed so the durable status matches the real launch flow.
    store.markRunning(id, { pid: null });
    if (opts.status && opts.status !== "running") {
      store.recordComplete({
        id,
        status: opts.status,
        exitCode: opts.status === "completed" ? 0 : 1,
        stdout: opts.stdout ?? "Verdict: approve\nLooks good.",
        stderr: "",
        outputTruncated: opts.outputTruncated ?? false,
        error: null,
        finishedAt: now,
      });
    }
  }

  interface SeedRunOptions {
    owner?: string;
    intent?: string;
    createdAt?: string;
    question?: string;
    content?: string;
    focus?: string;
    providerLinks?: Array<{ provider: string; jobId: string; correlationId: string }>;
    judgeLink?: { provider: string; jobId: string; correlationId: string } | null;
    judgeProvider?: string | null;
    modelList?: string[];
    status?: "admitting" | "running" | "judge_skipped" | "admission_failed" | "finalized";
  }

  function seedRun(validationId: string, opts: SeedRunOptions = {}): void {
    const judgeLink = opts.judgeLink ?? null;
    const requestedStatus = opts.status ?? "running";
    store.recordValidationRun({
      validationId,
      ownerPrincipal: opts.owner ?? "local",
      intent: opts.intent ?? "validate",
      createdAt: opts.createdAt ?? new Date(0).toISOString(),
      requestJson: JSON.stringify({
        question: opts.question ?? "Is this safe?",
        content: opts.content,
        focus: opts.focus,
        modelList: opts.modelList ?? ["claude", "codex"],
        judgeProvider: opts.judgeProvider === undefined ? judgeLink?.provider : opts.judgeProvider,
      }),
      providerLinks: opts.providerLinks ?? [
        { provider: "claude", jobId: "j-claude", correlationId: "corr-j-claude" },
        { provider: "codex", jobId: "j-codex", correlationId: "corr-j-codex" },
      ],
      judgeLink: null,
      status: judgeLink && requestedStatus !== "running" ? "running" : requestedStatus,
    });
    if (judgeLink) store.setValidationJudgeLink(validationId, judgeLink);
    if (judgeLink && requestedStatus !== "running") {
      store.setValidationRunStatus(validationId, requestedStatus);
    }
  }

  function requireStoredReceipt(validationId: string): ValidationReceiptRecord {
    const receipt = store.getValidationReceipt(validationId);
    expect(receipt).not.toBeNull();
    if (!receipt) throw new Error(`Expected stored receipt ${validationId}`);
    return receipt;
  }

  function recordCoherentReceiptClone(
    source: ValidationReceiptRecord,
    validationId: string,
    mutateReport: (report: any) => void = () => undefined,
    runOverrides: SeedRunOptions = {},
    mutateRecord: (record: ValidationReceiptRecord) => void = () => undefined
  ): void {
    const report = JSON.parse(source.reportJson);
    report.validationId = validationId;
    const providerLinks = report.perModelOutputs
      .filter((output: any) => output.jobId !== null)
      .map((output: any, index: number) => ({
        provider: output.provider,
        jobId: `${validationId}-provider-${index}`,
        correlationId: `${validationId}-correlation-${index}`,
      }));
    const linksByProvider = new Map(providerLinks.map(link => [link.provider, link]));
    for (const output of report.perModelOutputs) {
      const link = linksByProvider.get(output.provider);
      output.jobId = link?.jobId ?? null;
      output.correlationId = link?.correlationId ?? null;
    }
    report.jobIds = providerLinks.map(link => link.jobId);

    const sourceJudge = report.synthesis.rawJobReference;
    const judgeLink = sourceJudge
      ? {
          provider: report.synthesis.judgeModel,
          jobId: `${validationId}-judge`,
          correlationId: `${validationId}-judge-correlation`,
        }
      : null;
    if (judgeLink) {
      report.synthesis.rawJobReference = {
        jobId: judgeLink.jobId,
        correlationId: judgeLink.correlationId,
        statusTool: "job_status",
        resultTool: "job_result",
      };
    }

    seedRun(validationId, {
      intent: report.intent,
      createdAt: report.startedAt,
      question: report.originalRequest.question,
      content: report.originalRequest.content,
      focus: report.originalRequest.focus,
      providerLinks,
      modelList: report.modelList,
      judgeProvider: report.synthesis.judgeModel,
      judgeLink,
      status: "finalized",
      ...runOverrides,
    });
    mutateReport(report);
    const record: ValidationReceiptRecord = {
      ...source,
      validationId,
      ownerPrincipal: runOverrides.owner ?? source.ownerPrincipal,
      reportJson: JSON.stringify(report),
      canonicalSha256: computeCanonicalSha256(report),
      models: report.modelList,
      hasMaterialDisagreement: report.disagreements.hasMaterialDisagreement,
      confidence: report.confidence,
      prevSha256: null,
      seq: null,
      signature: null,
    };
    mutateRecord(record);
    store.recordValidationReceipt(record);
  }

  function mintDefaultSourceReceipt(validationId = "v-binding-source"): ValidationReceiptRecord {
    seedJob("j-claude", { status: "completed" });
    seedJob("j-codex", { status: "completed" });
    seedRun(validationId);
    expect(resolveValidationReceipt(deps, validationId, { caller: "local" }).status).toBe("minted");
    return requireStoredReceipt(validationId);
  }

  it("mints a receipt on read when the run is terminal", () => {
    seedJob("j-claude", { status: "completed", stdout: "Verdict: approve" });
    seedJob("j-codex", { status: "completed", stdout: "Verdict: approve" });
    seedRun("v1");

    const res = resolveValidationReceipt(deps, "v1", { caller: "local" });
    expect(res.status).toBe("minted");
    if (res.status !== "minted") return;
    expect(res.receipt.validationId).toBe("v1");
    expect(res.receipt.schemaVersion).toBe("validation-receipt.v1");
    expect(res.receipt.report.status).toBe("completed");
    expect(res.receipt.canonicalSha256).toMatch(/^[0-9a-f]{64}$/);
    // canonical hash matches the stored structuredContent
    expect(computeCanonicalSha256(res.receipt.report)).toBe(res.receipt.canonicalSha256);
    // reserved chaining/signing columns are null in v1
    expect(res.receipt.prevSha256).toBeNull();
    expect(res.receipt.seq).toBeNull();
    expect(res.receipt.signature).toBeNull();
  });

  it("is immutable: re-resolving returns the identical stored row", () => {
    seedJob("j-claude", { status: "completed" });
    seedJob("j-codex", { status: "completed" });
    seedRun("v1");

    const first = resolveValidationReceipt(deps, "v1", { caller: "local" });
    const second = resolveValidationReceipt(deps, "v1", { caller: "local" });
    expect(first.status).toBe("minted");
    expect(second.status).toBe("minted");
    if (first.status !== "minted" || second.status !== "minted") return;
    expect(second.mintedAt).toBe(first.mintedAt);
    expect(second.receipt.canonicalSha256).toBe(first.receipt.canonicalSha256);
    expect(() =>
      store.setValidationJudgeLink("v1", {
        provider: "codex",
        jobId: "late-judge",
        correlationId: "late-judge-correlation",
      })
    ).toThrow(/one-shot claim/);
    const afterLateJudgeAttempt = resolveValidationReceipt(deps, "v1", { caller: "local" });
    expect(afterLateJudgeAttempt.status).toBe("minted");
    if (afterLateJudgeAttempt.status === "minted") {
      expect(afterLateJudgeAttempt.receipt.canonicalSha256).toBe(first.receipt.canonicalSha256);
      expect(afterLateJudgeAttempt.receipt.report.synthesis.status).toBe("not_requested");
    }
  });

  it.each(["stored report", "stored hash"])(
    "fails closed when an existing receipt has a corrupted %s",
    corruption => {
      const source = mintDefaultSourceReceipt();
      const validationId = `v-corrupt-${corruption.replace(" ", "-")}`;
      recordCoherentReceiptClone(
        source,
        validationId,
        () => undefined,
        {},
        record => {
          if (corruption === "stored report") {
            const report = JSON.parse(record.reportJson);
            report.finalRecommendation = `${report.finalRecommendation} corrupted`;
            record.reportJson = JSON.stringify(report);
            return;
          }
          record.canonicalSha256 = "0".repeat(64);
        }
      );

      expect(resolveValidationReceipt(deps, validationId, { caller: "local" })).toEqual({
        status: "verification_failed",
        validationId,
      });
    }
  );

  it("accepts an unmodified coherent receipt clone", () => {
    const source = mintDefaultSourceReceipt();
    const validationId = "v-coherent-clone-control";
    recordCoherentReceiptClone(source, validationId);

    expect(resolveValidationReceipt(deps, validationId, { caller: "local" }).status).toBe("minted");
  });

  it("authorizes an existing receipt from its run owner and rejects a forged receipt owner", () => {
    seedJob("j-claude", { status: "completed", owner: "alice" });
    seedJob("j-codex", { status: "completed", owner: "alice" });
    seedRun("v-owner-source", { owner: "alice" });
    expect(resolveValidationReceipt(deps, "v-owner-source", { caller: "alice" }).status).toBe(
      "minted"
    );
    const source = store.getValidationReceipt("v-owner-source");
    expect(source).not.toBeNull();
    if (!source) return;

    const validationId = "v-forged-owner";
    recordCoherentReceiptClone(
      source,
      validationId,
      () => undefined,
      { owner: "alice" },
      record => {
        record.ownerPrincipal = "mallory";
      }
    );

    expect(resolveValidationReceipt(deps, validationId, { caller: "mallory" })).toEqual({
      status: "not_found",
      validationId,
    });
    expect(resolveValidationReceipt(deps, validationId, { caller: "alice" })).toEqual({
      status: "verification_failed",
      validationId,
    });
  });

  it("fails closed when storage returns a receipt for a different validation id", () => {
    seedJob("j-claude", { status: "completed" });
    seedJob("j-codex", { status: "completed" });
    seedRun("v1");
    expect(resolveValidationReceipt(deps, "v1", { caller: "local" }).status).toBe("minted");

    const mismatchedStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "getValidationReceipt") {
          return (validationId: string) => {
            const receipt = target.getValidationReceipt(validationId);
            return receipt ? { ...receipt, validationId: "v-other" } : null;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    expect(
      resolveValidationReceipt(
        { asyncJobManager: manager, validationRunStore: mismatchedStore },
        "v1",
        { caller: "local" }
      )
    ).toEqual({ status: "verification_failed", validationId: "v1" });
  });

  it.each([
    ["prevSha256", { prevSha256: "f".repeat(64) }],
    ["seq", { seq: 1 }],
    ["signature", { signature: "forged-signature" }],
  ])("rejects a persisted v1 receipt with non-null %s", (field, metadata) => {
    seedJob("j-claude", { status: "completed" });
    seedJob("j-codex", { status: "completed" });
    seedRun("v1");
    expect(resolveValidationReceipt(deps, "v1", { caller: "local" }).status).toBe("minted");
    const source = store.getValidationReceipt("v1");
    expect(source).not.toBeNull();
    if (!source) return;

    const validationId = `v-corrupt-${field}`;
    recordCoherentReceiptClone(
      source,
      validationId,
      () => undefined,
      {},
      record => Object.assign(record, metadata)
    );

    expect(resolveValidationReceipt(deps, validationId, { caller: "local" })).toEqual({
      status: "verification_failed",
      validationId,
    });
  });

  it.each([
    ["intent", (report: any) => (report.intent = "review")],
    ["startedAt", (report: any) => (report.startedAt = new Date(1).toISOString())],
    ["question", (report: any) => (report.originalRequest.question = "Forged question")],
    ["content", (report: any) => (report.originalRequest.content = "Forged content")],
    ["focus", (report: any) => (report.originalRequest.focus = "Forged focus")],
    ["modelList", (report: any) => (report.modelList = [...report.modelList].reverse())],
  ])("rejects a coherently rehashed receipt with mismatched run %s", (field, mutate) => {
    const source = mintDefaultSourceReceipt();
    const validationId = `v-binding-${field}`;
    recordCoherentReceiptClone(source, validationId, mutate);

    expect(resolveValidationReceipt(deps, validationId, { caller: "local" })).toEqual({
      status: "verification_failed",
      validationId,
    });
  });

  it.each([
    ["provider", (report: any) => (report.perModelOutputs[0].provider = "grok")],
    ["job id", (report: any) => (report.perModelOutputs[0].jobId = "forged-job")],
    [
      "correlation id",
      (report: any) => (report.perModelOutputs[0].correlationId = "forged-correlation"),
    ],
    ["output order", (report: any) => report.perModelOutputs.reverse()],
    ["top-level job roster", (report: any) => report.jobIds.reverse()],
    ["linked status", (report: any) => (report.perModelOutputs[0].status = "running")],
  ])("rejects a coherently rehashed receipt with mismatched provider %s", (field, mutate) => {
    const source = mintDefaultSourceReceipt();
    const validationId = `v-provider-binding-${field.replaceAll(" ", "-")}`;
    recordCoherentReceiptClone(source, validationId, mutate);

    expect(resolveValidationReceipt(deps, validationId, { caller: "local" })).toEqual({
      status: "verification_failed",
      validationId,
    });
  });

  it.each([
    ["missing requested seat", (report: any) => report.perModelOutputs.pop()],
    [
      "referenced skipped seat",
      (report: any) => {
        const skipped = report.perModelOutputs.find((output: any) => output.status === "skipped");
        skipped.jobId = "forged-skipped-job";
        skipped.correlationId = "forged-skipped-correlation";
      },
    ],
  ])("rejects a coherently rehashed receipt with a %s", (field, mutate) => {
    seedJob("j-claude", { status: "completed" });
    seedRun("v-skipped-source", {
      providerLinks: [{ provider: "claude", jobId: "j-claude", correlationId: "corr-j-claude" }],
      modelList: ["claude", "codex"],
    });
    expect(resolveValidationReceipt(deps, "v-skipped-source", { caller: "local" }).status).toBe(
      "minted"
    );
    const source = requireStoredReceipt("v-skipped-source");
    const validationId = `v-skipped-binding-${field.replaceAll(" ", "-")}`;
    recordCoherentReceiptClone(source, validationId, mutate);

    expect(resolveValidationReceipt(deps, validationId, { caller: "local" })).toEqual({
      status: "verification_failed",
      validationId,
    });
  });

  it("rejects a coherently rehashed unplanned judge synthesis", () => {
    const source = mintDefaultSourceReceipt();
    const validationId = "v-unplanned-judge-binding";
    recordCoherentReceiptClone(source, validationId, report => {
      report.synthesis = {
        status: "completed",
        judgeModel: "codex",
        rawJobReference: {
          jobId: "forged-judge",
          correlationId: "forged-judge-correlation",
          statusTool: "job_status",
          resultTool: "job_result",
        },
        note: "Forged judge synthesis.",
      };
    });

    expect(resolveValidationReceipt(deps, validationId, { caller: "local" })).toEqual({
      status: "verification_failed",
      validationId,
    });
  });

  it("mints a receipt bound to an ad-hoc judge selected after kickoff", () => {
    seedJob("j-claude", { status: "completed" });
    seedJob("j-judge", { status: "completed" });
    seedRun("v-ad-hoc-judge", {
      providerLinks: [{ provider: "claude", jobId: "j-claude", correlationId: "corr-j-claude" }],
      modelList: ["claude"],
      judgeProvider: null,
      judgeLink: {
        provider: "codex",
        jobId: "j-judge",
        correlationId: "corr-j-judge",
      },
    });

    const receipt = resolveValidationReceipt(deps, "v-ad-hoc-judge", { caller: "local" });
    expect(receipt.status).toBe("minted");
    if (receipt.status !== "minted") return;
    expect(receipt.receipt.report.synthesis).toMatchObject({
      status: "completed",
      judgeModel: "codex",
      rawJobReference: {
        jobId: "j-judge",
        correlationId: "corr-j-judge",
      },
    });
  });

  it("keeps kickoff, ad-hoc judge synthesis, and immutable receipt binding coherent", () => {
    seedJob("j-claude", { status: "completed" });
    seedRun("v-ad-hoc-flow", {
      providerLinks: [{ provider: "claude", jobId: "j-claude", correlationId: "corr-j-claude" }],
      modelList: ["claude"],
      judgeProvider: null,
    });
    const synthesis = startJudgeSynthesis(
      {
        asyncJobManager: {
          startJobWithDedup(cli: string, _args: string[], correlationId: string) {
            return {
              snapshot: {
                id: "j-ad-hoc-judge",
                cli,
                status: "running",
                startedAt: new Date(1).toISOString(),
                finishedAt: null,
                exitCode: null,
                correlationId,
                outputTruncated: false,
                stdoutBytes: 0,
                stderrBytes: 0,
                error: null,
                exited: false,
              },
              deduped: false,
            };
          },
        } as never,
        getProviderRuntimeStatus: provider =>
          ({
            provider,
            displayName: provider,
            installed: true,
            version: "test",
            loginStatus: "authenticated",
          }) as never,
        validationRunStore: store,
      },
      {
        question: "Is this safe?",
        providerResults: [
          {
            provider: "claude",
            model: null,
            status: "completed",
            verdict: "approve",
            rationale: "ok",
            risks: [],
            rawJobReference: {
              jobId: "j-claude",
              correlationId: "corr-j-claude",
              statusTool: "job_status",
              resultTool: "job_result",
            },
            error: null,
          },
        ],
        judgeProvider: "codex",
        validationId: "v-ad-hoc-flow",
      }
    );

    expect(synthesis).toMatchObject({
      status: "running",
      judgeModel: "codex",
      rawJobReference: { jobId: "j-ad-hoc-judge" },
    });
    seedJob("j-ad-hoc-judge", {
      status: "completed",
      cli: "codex",
      correlationId: synthesis.rawJobReference!.correlationId,
    });
    const receipt = resolveValidationReceipt(deps, "v-ad-hoc-flow", { caller: "local" });
    expect(receipt.status).toBe("minted");
    if (receipt.status === "minted") {
      expect(receipt.receipt.report.synthesis).toMatchObject({
        status: "completed",
        judgeModel: "codex",
        rawJobReference: { jobId: "j-ad-hoc-judge" },
      });
    }
  });

  it.each([
    ["provider", (report: any) => (report.synthesis.judgeModel = "claude")],
    ["job id", (report: any) => (report.synthesis.rawJobReference.jobId = "forged-judge")],
    [
      "correlation id",
      (report: any) =>
        (report.synthesis.rawJobReference.correlationId = "forged-judge-correlation"),
    ],
    [
      "status contract",
      (report: any) => {
        report.synthesis.status = "not_requested";
        report.synthesis.judgeModel = null;
        report.synthesis.rawJobReference = null;
      },
    ],
  ])("rejects a coherently rehashed linked-judge %s mismatch", (field, mutate) => {
    seedJob("j-claude", { status: "completed" });
    seedJob("j-codex", { status: "completed" });
    seedJob("j-judge", { status: "completed" });
    seedRun("v-linked-judge-source", {
      judgeLink: { provider: "codex", jobId: "j-judge", correlationId: "corr-j-judge" },
    });
    expect(
      resolveValidationReceipt(deps, "v-linked-judge-source", { caller: "local" }).status
    ).toBe("minted");
    const source = requireStoredReceipt("v-linked-judge-source");
    const validationId = `v-linked-judge-binding-${field.replaceAll(" ", "-")}`;
    recordCoherentReceiptClone(source, validationId, mutate);

    expect(resolveValidationReceipt(deps, validationId, { caller: "local" })).toEqual({
      status: "verification_failed",
      validationId,
    });
  });

  it("accepts a finalized existing receipt for a durably skipped planned judge", () => {
    seedJob("j-claude", { status: "completed" });
    seedJob("j-codex", { status: "completed" });
    seedRun("v-skipped-judge-source", { judgeProvider: "codex" });
    store.setValidationRunStatus("v-skipped-judge-source", "judge_skipped");
    expect(
      resolveValidationReceipt(deps, "v-skipped-judge-source", { caller: "local" }).status
    ).toBe("minted");
    const source = requireStoredReceipt("v-skipped-judge-source");
    const validationId = "v-finalized-skipped-judge";
    recordCoherentReceiptClone(source, validationId);

    expect(resolveValidationReceipt(deps, validationId, { caller: "local" }).status).toBe("minted");
  });

  it("rejects a linked judge receipt when the durable run has a skipped-judge status", () => {
    seedJob("j-claude", { status: "completed" });
    seedJob("j-codex", { status: "completed" });
    seedJob("j-judge", { status: "completed" });
    seedRun("v-linked-status-source", {
      judgeLink: { provider: "codex", jobId: "j-judge", correlationId: "corr-j-judge" },
    });
    expect(
      resolveValidationReceipt(deps, "v-linked-status-source", { caller: "local" }).status
    ).toBe("minted");
    const source = requireStoredReceipt("v-linked-status-source");
    const validationId = "v-linked-invalid-run-status";
    recordCoherentReceiptClone(source, validationId, () => undefined, {
      status: "judge_skipped",
    });

    expect(resolveValidationReceipt(deps, validationId, { caller: "local" })).toEqual({
      status: "verification_failed",
      validationId,
    });
  });

  it.each([
    ["job id", (run: SeedRunOptions) => (run.judgeLink!.jobId = run.providerLinks![0]!.jobId)],
    [
      "correlation id",
      (run: SeedRunOptions) =>
        (run.judgeLink!.correlationId = run.providerLinks![0]!.correlationId),
    ],
  ])("rejects a coherent receipt whose judge aliases a provider %s", (field, aliasJudge) => {
    seedJob("j-claude", { status: "completed" });
    seedJob("j-codex", { status: "completed" });
    seedJob("j-judge", { status: "completed" });
    seedRun("v-judge-alias-source", {
      judgeLink: { provider: "codex", jobId: "j-judge", correlationId: "corr-j-judge" },
    });
    expect(resolveValidationReceipt(deps, "v-judge-alias-source", { caller: "local" }).status).toBe(
      "minted"
    );
    const source = requireStoredReceipt("v-judge-alias-source");
    const validationId = `v-judge-alias-${field.replaceAll(" ", "-")}`;
    const sourceReport = JSON.parse(source.reportJson);
    const providerLinks = sourceReport.perModelOutputs.map((output: any, index: number) => ({
      provider: output.provider,
      jobId: `${validationId}-provider-${index}`,
      correlationId: `${validationId}-correlation-${index}`,
    }));
    const runOverrides: SeedRunOptions = {
      providerLinks,
      judgeLink: {
        provider: "codex",
        jobId: `${validationId}-judge`,
        correlationId: `${validationId}-judge-correlation`,
      },
    };
    aliasJudge(runOverrides);
    recordCoherentReceiptClone(
      source,
      validationId,
      report => {
        report.synthesis.rawJobReference.jobId = runOverrides.judgeLink!.jobId;
        report.synthesis.rawJobReference.correlationId = runOverrides.judgeLink!.correlationId;
      },
      runOverrides
    );

    expect(resolveValidationReceipt(deps, validationId, { caller: "local" })).toEqual({
      status: "verification_failed",
      validationId,
    });
  });

  it("serves a normally minted existing receipt without reloading nondurable answer jobs", () => {
    mintDefaultSourceReceipt("v-existing-binding-compatible");
    const unavailableManager = {
      getJobOwner() {
        throw new Error("Answer job owner was evicted");
      },
      getJobResult() {
        throw new Error("Answer job result was evicted");
      },
    } as unknown as AsyncJobManager;

    expect(
      resolveValidationReceipt(
        { asyncJobManager: unavailableManager, validationRunStore: store },
        "v-existing-binding-compatible",
        { caller: "local" }
      ).status
    ).toBe("minted");
  });

  it("returns pending when a provider job is still running", () => {
    seedJob("j-claude", { status: "completed" });
    seedJob("j-codex", { status: "running" });
    seedRun("v1");

    const res = resolveValidationReceipt(deps, "v1", { caller: "local" });
    expect(res.status).toBe("pending");
    if (res.status !== "pending") return;
    expect(res.run.providers.find(p => p.jobId === "j-codex")?.status).toBe("running");
  });

  it("does not finalize before a planned judge is claimed, but permits an explicit skip", () => {
    seedJob("j-claude", { status: "completed" });
    store.recordValidationRun({
      validationId: "v-planned-judge",
      ownerPrincipal: "local",
      intent: "review",
      createdAt: new Date(0).toISOString(),
      requestJson: JSON.stringify({
        question: "Review",
        modelList: ["claude"],
        judgeProvider: "codex",
      }),
      providerLinks: [{ provider: "claude", jobId: "j-claude", correlationId: "corr-j-claude" }],
      judgeLink: null,
      status: "running",
    });

    expect(resolveValidationReceipt(deps, "v-planned-judge", { caller: "local" }).status).toBe(
      "pending"
    );
    store.setValidationRunStatus("v-planned-judge", "judge_skipped");
    const skipped = resolveValidationReceipt(deps, "v-planned-judge", { caller: "local" });
    expect(skipped.status).toBe("minted");
    if (skipped.status !== "minted") return;
    expect(skipped.receipt.report.synthesis).toMatchObject({
      status: "skipped",
      judgeModel: "codex",
      rawJobReference: null,
    });
  });

  it("returns not_found for an unknown validationId", () => {
    expect(resolveValidationReceipt(deps, "missing", { caller: "local" }).status).toBe("not_found");
  });

  it("returns not_found for a run owned by another principal", () => {
    seedJob("j-claude", { status: "completed", owner: "alice" });
    seedJob("j-codex", { status: "completed", owner: "alice" });
    seedRun("v-alice", { owner: "alice" });

    expect(resolveValidationReceipt(deps, "v-alice", { caller: "bob" }).status).toBe("not_found");
    // and the owner can mint it
    expect(resolveValidationReceipt(deps, "v-alice", { caller: "alice" }).status).toBe("minted");
  });

  it("returns expired_unminted when a linked job was evicted before any mint", () => {
    // The run links jobs that were never recorded (simulating eviction).
    seedRun("v-evicted", {
      providerLinks: [{ provider: "claude", jobId: "gone-1", correlationId: "c1" }],
    });
    const res = resolveValidationReceipt(deps, "v-evicted", { caller: "local" });
    expect(res.status).toBe("expired_unminted");
  });

  it.each([
    [
      "owner",
      () => {
        seedJob("j-claude", { status: "completed", owner: "other-owner" });
        seedRun("v-integrity", {
          providerLinks: [
            { provider: "claude", jobId: "j-claude", correlationId: "corr-j-claude" },
          ],
          modelList: ["claude"],
        });
      },
    ],
    [
      "provider",
      () => {
        seedJob("j-claude", { status: "completed", cli: "codex" });
        seedRun("v-integrity", {
          providerLinks: [
            { provider: "claude", jobId: "j-claude", correlationId: "corr-j-claude" },
          ],
          modelList: ["claude"],
        });
      },
    ],
    [
      "correlation",
      () => {
        seedJob("j-claude", { status: "completed" });
        seedRun("v-integrity", {
          providerLinks: [
            { provider: "claude", jobId: "j-claude", correlationId: "wrong-correlation" },
          ],
          modelList: ["claude"],
        });
      },
    ],
    [
      "reverse run",
      () => {
        seedJob("j-claude", { status: "completed" });
        const link = {
          provider: "claude",
          jobId: "j-claude",
          correlationId: "corr-j-claude",
        };
        seedRun("v-other", { providerLinks: [link], modelList: ["claude"] });
        seedRun("v-integrity", { providerLinks: [link], modelList: ["claude"] });
      },
    ],
    [
      "truncated output",
      () => {
        seedJob("j-claude", { status: "completed", outputTruncated: true });
        seedRun("v-integrity", {
          providerLinks: [
            { provider: "claude", jobId: "j-claude", correlationId: "corr-j-claude" },
          ],
          modelList: ["claude"],
        });
      },
    ],
  ])("fails closed without a receipt for a provider-link %s mismatch", (_name, arrange) => {
    arrange();
    expect(resolveValidationReceipt(deps, "v-integrity", { caller: "local" }).status).toBe(
      "expired_unminted"
    );
    expect(store.getValidationReceipt("v-integrity")).toBeNull();
  });

  it.each([
    ["owner", { owner: "other-owner" }, "corr-j-judge"],
    ["provider", { cli: "claude" as const }, "corr-j-judge"],
    ["correlation", {}, "wrong-correlation"],
    ["truncated output", { outputTruncated: true }, "corr-j-judge"],
  ])(
    "fails closed without a receipt for a judge-link %s mismatch",
    (_name, judgeOptions, judgeCorrelationId) => {
      seedJob("j-claude", { status: "completed" });
      seedJob("j-judge", { status: "completed", ...judgeOptions });
      seedRun("v-integrity", {
        providerLinks: [{ provider: "claude", jobId: "j-claude", correlationId: "corr-j-claude" }],
        modelList: ["claude"],
        judgeLink: {
          provider: "codex",
          jobId: "j-judge",
          correlationId: judgeCorrelationId,
        },
      });

      expect(resolveValidationReceipt(deps, "v-integrity", { caller: "local" }).status).toBe(
        "expired_unminted"
      );
      expect(store.getValidationReceipt("v-integrity")).toBeNull();
    }
  );

  it("fails closed when a judge reverse link points to another run", () => {
    seedJob("j-claude", { status: "completed" });
    seedJob("j-judge", { status: "completed" });
    const judgeLink = {
      provider: "codex",
      jobId: "j-judge",
      correlationId: "corr-j-judge",
    };
    seedRun("v-other", { providerLinks: [], modelList: [], judgeLink });
    seedRun("v-integrity", {
      providerLinks: [{ provider: "claude", jobId: "j-claude", correlationId: "corr-j-claude" }],
      modelList: ["claude"],
      judgeLink,
    });

    expect(resolveValidationReceipt(deps, "v-integrity", { caller: "local" }).status).toBe(
      "expired_unminted"
    );
    expect(store.getValidationReceipt("v-integrity")).toBeNull();
  });

  it("rejects a judge link outside the stored judge plan", () => {
    seedJob("j-claude", { status: "completed" });
    seedJob("j-judge", { status: "completed" });
    seedRun("v-integrity", {
      providerLinks: [{ provider: "claude", jobId: "j-claude", correlationId: "corr-j-claude" }],
      modelList: ["claude"],
      judgeProvider: "claude",
      judgeLink: {
        provider: "codex",
        jobId: "j-judge",
        correlationId: "corr-j-judge",
      },
    });

    expect(resolveValidationReceipt(deps, "v-integrity", { caller: "local" }).status).toBe(
      "expired_unminted"
    );
    expect(store.getValidationReceipt("v-integrity")).toBeNull();
  });

  it.each([
    [
      "duplicate provider",
      [
        { provider: "claude", jobId: "j-claude", correlationId: "corr-j-claude" },
        { provider: "claude", jobId: "j-other", correlationId: "corr-j-other" },
      ],
    ],
    [
      "duplicate job id",
      [
        { provider: "claude", jobId: "j-claude", correlationId: "corr-j-claude" },
        { provider: "codex", jobId: "j-claude", correlationId: "corr-j-other" },
      ],
    ],
    [
      "duplicate correlation id",
      [
        { provider: "claude", jobId: "j-claude", correlationId: "corr-j-claude" },
        { provider: "codex", jobId: "j-other", correlationId: "corr-j-claude" },
      ],
    ],
  ])("rejects provider roster links with a %s", (_name, providerLinks) => {
    seedJob("j-claude", { status: "completed" });
    seedJob("j-other", { status: "completed" });
    seedRun("v-integrity", { providerLinks, modelList: ["claude", "codex"] });

    expect(resolveValidationReceipt(deps, "v-integrity", { caller: "local" }).status).toBe(
      "expired_unminted"
    );
    expect(store.getValidationReceipt("v-integrity")).toBeNull();
  });

  it("rejects a provider link outside the stored requested roster", () => {
    seedJob("j-codex", { status: "completed" });
    seedRun("v-integrity", {
      providerLinks: [{ provider: "codex", jobId: "j-codex", correlationId: "corr-j-codex" }],
      modelList: ["claude"],
    });

    expect(resolveValidationReceipt(deps, "v-integrity", { caller: "local" }).status).toBe(
      "expired_unminted"
    );
    expect(store.getValidationReceipt("v-integrity")).toBeNull();
  });

  it("rejects a duplicate requested provider roster", () => {
    seedJob("j-claude", { status: "completed" });
    seedRun("v-integrity", {
      providerLinks: [{ provider: "claude", jobId: "j-claude", correlationId: "corr-j-claude" }],
      modelList: ["claude", "claude"],
    });

    expect(resolveValidationReceipt(deps, "v-integrity", { caller: "local" }).status).toBe(
      "expired_unminted"
    );
    expect(store.getValidationReceipt("v-integrity")).toBeNull();
  });

  it.each([
    ["job id", "j-claude", "corr-j-claude"],
    ["correlation id", "j-judge", "corr-j-claude"],
  ])("rejects a judge link that aliases a provider %s", (_name, judgeJobId, correlationId) => {
    seedJob("j-claude", { status: "completed" });
    if (judgeJobId !== "j-claude") {
      seedJob("j-judge", { status: "completed", correlationId });
    }
    seedRun("v-integrity", {
      providerLinks: [{ provider: "claude", jobId: "j-claude", correlationId: "corr-j-claude" }],
      modelList: ["claude"],
      judgeLink: { provider: "codex", jobId: judgeJobId, correlationId },
    });

    expect(resolveValidationReceipt(deps, "v-integrity", { caller: "local" }).status).toBe(
      "expired_unminted"
    );
    expect(store.getValidationReceipt("v-integrity")).toBeNull();
  });

  it.each(["owner", "result"])("fails closed when the job %s lookup throws", lookup => {
    seedJob("j-claude", { status: "completed" });
    seedRun("v-integrity", {
      providerLinks: [{ provider: "claude", jobId: "j-claude", correlationId: "corr-j-claude" }],
      modelList: ["claude"],
    });
    const realManager = manager;
    deps = {
      validationRunStore: store,
      asyncJobManager: {
        getJobOwner(jobId: string) {
          if (lookup === "owner") throw new Error("owner lookup unavailable");
          return realManager.getJobOwner(jobId);
        },
        getJobResult(jobId: string, maxChars: number) {
          if (lookup === "result") throw new Error("result lookup unavailable");
          return realManager.getJobResult(jobId, maxChars);
        },
      } as AsyncJobManager,
    };

    expect(resolveValidationReceipt(deps, "v-integrity", { caller: "local" }).status).toBe(
      "expired_unminted"
    );
    expect(store.getValidationReceipt("v-integrity")).toBeNull();
  });

  it("rejects a job result whose id does not match its durable link", () => {
    seedJob("j-claude", { status: "completed" });
    seedRun("v-integrity", {
      providerLinks: [{ provider: "claude", jobId: "j-claude", correlationId: "corr-j-claude" }],
      modelList: ["claude"],
    });
    const realManager = manager;
    deps = {
      validationRunStore: store,
      asyncJobManager: {
        getJobOwner: (jobId: string) => realManager.getJobOwner(jobId),
        getJobResult(jobId: string, maxChars: number) {
          const result = realManager.getJobResult(jobId, maxChars);
          return result ? { ...result, id: "different-job" } : null;
        },
      } as AsyncJobManager,
    };

    expect(resolveValidationReceipt(deps, "v-integrity", { caller: "local" }).status).toBe(
      "expired_unminted"
    );
    expect(store.getValidationReceipt("v-integrity")).toBeNull();
  });

  it("mints with a judge when both providers and the judge are terminal", () => {
    seedJob("j-claude", { status: "completed" });
    seedJob("j-codex", { status: "completed" });
    seedJob("j-judge", { status: "completed", stdout: "Summary: agree" });
    seedRun("v-judge", {
      judgeLink: { provider: "codex", jobId: "j-judge", correlationId: "corr-j-judge" },
    });

    const res = resolveValidationReceipt(deps, "v-judge", { caller: "local" });
    expect(res.status).toBe("minted");
    if (res.status !== "minted") return;
    expect(res.receipt.report.synthesis.status).toBe("completed");
    expect(res.receipt.report.synthesis.judgeModel).toBe("codex");
  });

  it("stays pending while the judge job is still running", () => {
    seedJob("j-claude", { status: "completed" });
    seedJob("j-codex", { status: "completed" });
    seedJob("j-judge", { status: "running" });
    seedRun("v-judge", {
      judgeLink: { provider: "codex", jobId: "j-judge", correlationId: "corr-j-judge" },
    });
    expect(resolveValidationReceipt(deps, "v-judge", { caller: "local" }).status).toBe("pending");
  });

  // Backward compatibility with receipts minted by the shipped <= 2.17.x code.
  //
  // `mintLegacyPlannedJudgeReceipt` replays that release's tryMint for a run
  // with a planned judge that was never claimed. That code had neither the
  // plannedJudge pending gate nor the judge_skipped synthesis branch, so it fell
  // straight through to the `not_requested` synthesis, hashed THAT report,
  // recorded the receipt, and marked the run finalized. Everything the bytes
  // depend on (buildValidationReport, deriveValidationRunStatus,
  // normalizeJobResult, computeCanonicalSha256) is imported from production and
  // is unchanged since, so this reproduces the on-disk bytes rather than
  // approximating them.
  function mintLegacyPlannedJudgeReceipt(validationId: string, plannedJudge = "codex"): void {
    seedJob("j-claude", { status: "completed" });
    seedJob("j-codex", { status: "completed" });
    seedRun(validationId, { judgeProvider: plannedJudge });
    const run = store.getValidationRun(validationId);
    if (!run) throw new Error(`Expected seeded run ${validationId}`);
    const request = JSON.parse(run.requestJson);
    const results = run.providerLinks.map(link => {
      const result = manager.getJobResult(link.jobId, Number.MAX_SAFE_INTEGER);
      if (!result) throw new Error(`Expected seeded job ${link.jobId}`);
      return normalizeJobResult(link.provider as any, null, result);
    });
    // The exact legacy synthesis object: no plannedJudge branch existed.
    const synthesis = {
      status: "not_requested" as const,
      judgeModel: null,
      rawJobReference: null,
      note: "No judge synthesis was requested.",
    };
    const { structuredContent } = buildValidationReport({
      validationId,
      status: deriveValidationRunStatus(results, synthesis.status),
      startedAt: run.createdAt,
      intent: run.intent as any,
      originalRequest: {
        question: request.question,
        content: request.content,
        focus: request.focus,
      },
      modelList: request.modelList,
      results,
      synthesis,
    });
    store.recordValidationReceipt({
      validationId,
      ownerPrincipal: run.ownerPrincipal,
      mintedAt: new Date().toISOString(),
      schemaVersion: VALIDATION_RECEIPT_SCHEMA_VERSION,
      reportJson: JSON.stringify(structuredContent),
      canonicalSha256: computeCanonicalSha256(structuredContent),
      prevSha256: null,
      seq: null,
      signature: null,
      models: structuredContent.modelList as string[],
      hasMaterialDisagreement: structuredContent.disagreements.hasMaterialDisagreement,
      confidence: structuredContent.confidence,
    });
    // The legacy mint always stamped the run finalized right after recording.
    store.setValidationRunStatus(validationId, "finalized");
  }

  it("verifies a legacy receipt minted before the planned-judge gate existed", () => {
    mintLegacyPlannedJudgeReceipt("v-legacy-planned-judge");
    const stored = requireStoredReceipt("v-legacy-planned-judge");
    // Precondition: the fixture really is the legacy shape the old mint wrote.
    expect(JSON.parse(stored.reportJson).synthesis).toEqual({
      status: "not_requested",
      judgeModel: null,
      rawJobReference: null,
      note: "No judge synthesis was requested.",
    });

    const res = resolveValidationReceipt(deps, "v-legacy-planned-judge", { caller: "local" });
    expect(res.status).toBe("minted");
    if (res.status !== "minted") return;
    // The stored bytes are served back untouched and still hash to the stored
    // digest: canonical hashing is unchanged, this was only a policy mismatch.
    expect(res.receipt.canonicalSha256).toBe(stored.canonicalSha256);
    expect(computeCanonicalSha256(res.receipt.report)).toBe(stored.canonicalSha256);
    expect(res.receipt.report.synthesis.status).toBe("not_requested");
  });

  it("reports verification_failed, not expired_unminted, for a corrupted legacy receipt", () => {
    mintLegacyPlannedJudgeReceipt("v-legacy-corrupt");
    const stored = requireStoredReceipt("v-legacy-corrupt");
    // Same legacy shape and a roster that matches the run exactly, so the ONLY
    // defect under test is the tampered evidence itself.
    const validationId = "v-legacy-corrupt-clone";
    const report = JSON.parse(stored.reportJson);
    report.validationId = validationId;
    seedRun(validationId, {
      modelList: report.modelList,
      judgeProvider: "codex",
      status: "finalized",
    });
    store.recordValidationReceipt({
      ...stored,
      validationId,
      reportJson: JSON.stringify(report),
      canonicalSha256: "0".repeat(64),
    });

    const res = resolveValidationReceipt(deps, validationId, { caller: "local" });
    // Fail-closed: the receipt still refuses to verify ...
    expect(res.status).not.toBe("minted");
    // ... and says so honestly instead of claiming nothing was ever minted.
    expect(res).toEqual({ status: "verification_failed", validationId });
    expect(store.getValidationReceipt(validationId)).not.toBeNull();
  });

  it("does not extend the legacy allowance to a run that never finalized", () => {
    // The legacy shape is accepted only on a finalized run, which is the state
    // the legacy mint always left behind. A planned-judge run still in
    // `running` is gated to pending today and must never mint this shape, so a
    // receipt claiming it does not verify.
    mintLegacyPlannedJudgeReceipt("v-legacy-running-source");
    const stored = requireStoredReceipt("v-legacy-running-source");
    const validationId = "v-legacy-running";
    const report = JSON.parse(stored.reportJson);
    report.validationId = validationId;
    // Coherently rehashed against a matching roster: only the run status,
    // which the allowance deliberately pins to `finalized`, is out of contract.
    seedRun(validationId, {
      modelList: report.modelList,
      judgeProvider: "codex",
      status: "running",
    });
    store.recordValidationReceipt({
      ...stored,
      validationId,
      reportJson: JSON.stringify(report),
      canonicalSha256: computeCanonicalSha256(report),
    });

    expect(resolveValidationReceipt(deps, validationId, { caller: "local" })).toEqual({
      status: "verification_failed",
      validationId,
    });
  });

  it("reports expired_unminted (absence), never verification_failed, when no receipt exists", () => {
    // The run links a job that was never recorded (simulating eviction): there
    // is nothing to verify, so absence is the honest answer.
    seedRun("v-absent", {
      providerLinks: [{ provider: "claude", jobId: "gone-1", correlationId: "c1" }],
    });

    expect(resolveValidationReceipt(deps, "v-absent", { caller: "local" })).toEqual({
      status: "expired_unminted",
      validationId: "v-absent",
    });
    expect(store.getValidationReceipt("v-absent")).toBeNull();
  });

  it("includeRawResponses returns the full answer as a read-time field, never in the hashed report", () => {
    // Output longer than both the report's 1800-char rationale excerpt and the
    // manager's default 200,000-char page, with a sentinel only in the full text.
    const longAnswer = `${"verbose ".repeat(26_000)} TAILSENTINEL`;
    seedJob("j-claude", { status: "completed", stdout: longAnswer });
    seedJob("j-codex", { status: "completed", stdout: "Verdict: approve" });
    seedRun("v1");

    const withRaw = resolveValidationReceipt(deps, "v1", {
      caller: "local",
      includeRawResponses: true,
    });
    const withoutRaw = resolveValidationReceipt(deps, "v1", { caller: "local" });
    expect(withRaw.status).toBe("minted");
    expect(withoutRaw.status).toBe("minted");
    if (withRaw.status !== "minted" || withoutRaw.status !== "minted") return;

    // Full raw answer (incl. the tail sentinel) is present in rawResponses...
    expect(withRaw.rawResponses?.some(r => r.text.includes("TAILSENTINEL"))).toBe(true);
    expect(withoutRaw.rawResponses).toBeUndefined();
    // ...but the truncated report never carries the tail, and the canonical hash
    // is identical whether or not raw responses were requested.
    expect(JSON.stringify(withRaw.receipt.report)).not.toContain("TAILSENTINEL");
    expect(withRaw.receipt.canonicalSha256).toBe(withoutRaw.receipt.canonicalSha256);
  });

  it("omits raw responses whose complete-page or byte identity checks fail", () => {
    seedJob("j-claude", { status: "completed" });
    seedJob("j-codex", { status: "completed" });
    seedRun("v1");
    expect(resolveValidationReceipt(deps, "v1", { caller: "local" }).status).toBe("minted");

    const getJobResult = manager.getJobResult.bind(manager);
    const integrityCheckingManager = {
      getJobOwner: manager.getJobOwner.bind(manager),
      getJobResult(jobId: string, maxChars?: number) {
        const value = getJobResult(jobId, maxChars);
        if (!value) return null;
        if (jobId === "j-claude") {
          return { ...value, stdoutTruncated: true, stdoutNextOffsetChars: value.stdout.length };
        }
        return { ...value, stdoutBytes: value.stdoutBytes + 1 };
      },
    } as unknown as AsyncJobManager;

    const resolved = resolveValidationReceipt(
      { asyncJobManager: integrityCheckingManager, validationRunStore: store },
      "v1",
      { caller: "local", includeRawResponses: true }
    );

    expect(resolved.status).toBe("minted");
    if (resolved.status !== "minted") return;
    expect(resolved.rawResponses).toEqual([]);
  });

  it("eager mint from a collected job id mints the receipt without a read", () => {
    seedJob("j-claude", { status: "completed" });
    seedJob("j-codex", { status: "completed" });
    seedRun("v1");

    expect(store.getValidationReceipt("v1")).toBeNull();
    eagerMintFromJobId(deps, "j-codex"); // simulates the job_result hook
    expect(store.getValidationReceipt("v1")).not.toBeNull();
  });

  it("eager mint is a no-op when the run is not yet terminal", () => {
    seedJob("j-claude", { status: "completed" });
    seedJob("j-codex", { status: "running" });
    seedRun("v1");
    eagerMintFromJobId(deps, "j-claude");
    expect(store.getValidationReceipt("v1")).toBeNull();
  });

  it("returns not_found when no durable run store is wired", () => {
    const noStore: ReceiptDeps = { asyncJobManager: manager };
    expect(resolveValidationReceipt(noStore, "v1", { caller: "local" }).status).toBe("not_found");
  });

  // Phase 2: auto-mint by validationId (synthesize_validation convenience) +
  // markdown rendering on read.
  it("eagerMintFromValidationId mints a terminal run with no judge", () => {
    seedJob("j-claude", { status: "completed" });
    seedJob("j-codex", { status: "completed" });
    seedRun("v1");
    eagerMintFromValidationId(deps, "v1");
    expect(store.getValidationReceipt("v1")).not.toBeNull();
  });

  it("eagerMintFromValidationId is a no-op while the judge is still running", () => {
    seedJob("j-claude", { status: "completed" });
    seedJob("j-codex", { status: "completed" });
    seedJob("j-judge", { status: "running" });
    seedRun("v-judge", {
      judgeLink: { provider: "codex", jobId: "j-judge", correlationId: "corr-j-judge" },
    });
    eagerMintFromValidationId(deps, "v-judge");
    expect(store.getValidationReceipt("v-judge")).toBeNull();
  });

  it("marks the run finalized once a receipt is minted", () => {
    seedJob("j-claude", { status: "completed" });
    seedJob("j-codex", { status: "completed" });
    seedRun("v1");
    expect(store.getValidationRun("v1")?.status).toBe("running");
    resolveValidationReceipt(deps, "v1", { caller: "local" });
    expect(store.getValidationRun("v1")?.status).toBe("finalized");
  });

  it("records a non-completed judge as skipped synthesis, never completed", () => {
    seedJob("j-claude", { status: "completed" });
    seedJob("j-codex", { status: "completed" });
    seedJob("j-judge", { status: "failed" });
    seedRun("v-judge", {
      judgeLink: { provider: "codex", jobId: "j-judge", correlationId: "corr-j-judge" },
    });
    const res = resolveValidationReceipt(deps, "v-judge", { caller: "local" });
    expect(res.status).toBe("minted");
    if (res.status !== "minted") return;
    expect(res.receipt.report.synthesis.status).toBe("skipped");
    expect(res.receipt.report.synthesis.note).toMatch(/failed/);
  });

  it("reconstructs skipped providers (requested but not dispatched) in the minted report", () => {
    seedJob("j-claude", { status: "completed" });
    seedJob("j-codex", { status: "completed" });
    // gemini was requested at kickoff but never dispatched (no provider link).
    seedRun("v1", { modelList: ["claude", "codex", "gemini"] });
    const res = resolveValidationReceipt(deps, "v1", { caller: "local" });
    expect(res.status).toBe("minted");
    if (res.status !== "minted") return;
    const gemini = res.receipt.report.perModelOutputs.find(o => o.provider === "gemini");
    expect(gemini?.status).toBe("skipped");
    expect(res.receipt.report.modelList).toEqual(["claude", "codex", "gemini"]);
  });

  it("the receipt envelope's humanReadable is the renderHumanReport of the stored report", () => {
    seedJob("j-claude", { status: "completed" });
    seedJob("j-codex", { status: "completed" });
    seedRun("v1");
    const res = resolveValidationReceipt(deps, "v1", { caller: "local" });
    expect(res.status).toBe("minted");
    if (res.status !== "minted") return;
    expect(res.receipt.humanReadable).toBe(renderHumanReport(res.receipt.report));
    expect(res.receipt.humanReadable).toContain("Validation report v1");
  });
});
