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

  afterEach(async () => {
    try {
      // Dispose BEFORE closing the store. The manager owns heartbeat, sweep and
      // eviction timers, and those writes are asynchronous now, so a tick still
      // in flight lands on a closed database ("database is not open"). While
      // the store was synchronous the timer body finished inside its own tick
      // and could never overlap teardown.
      await manager.dispose({ timeoutMs: 500 });
      await store.close();
    } catch {
      /* ignore */
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function seedJob(
    id: string,
    opts: {
      owner?: string;
      status?: "running" | "completed" | "failed";
      stdout?: string;
      cli?: "claude" | "codex";
      correlationId?: string;
      outputTruncated?: boolean;
    } = {}
  ): Promise<void> {
    const now = new Date().toISOString();
    await store.recordStart({
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
    await store.markRunning(id, { pid: null });
    if (opts.status && opts.status !== "running") {
      await store.recordComplete({
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

  async function seedRun(validationId: string, opts: SeedRunOptions = {}): Promise<void> {
    const judgeLink = opts.judgeLink ?? null;
    const requestedStatus = opts.status ?? "running";
    await store.recordValidationRun({
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
    if (judgeLink) await store.setValidationJudgeLink(validationId, judgeLink);
    if (judgeLink && requestedStatus !== "running") {
      await store.setValidationRunStatus(validationId, requestedStatus);
    }
  }

  async function requireStoredReceipt(validationId: string): Promise<ValidationReceiptRecord> {
    // Awaited at the source. Unawaited, `!receipt` tested a promise and was
    // always false, so the guard never fired and this returned the PROMISE
    // typed as a record: every caller then read undefined off it.
    const receipt = await store.getValidationReceipt(validationId);
    expect(receipt).not.toBeNull();
    if (!receipt) throw new Error(`Expected stored receipt ${validationId}`);
    return receipt;
  }

  async function recordCoherentReceiptClone(
    source: ValidationReceiptRecord,
    validationId: string,
    mutateReport: (report: any) => void = () => undefined,
    runOverrides: SeedRunOptions = {},
    mutateRecord: (record: ValidationReceiptRecord) => void = () => undefined
  ): Promise<void> {
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

    await seedRun(validationId, {
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
    await store.recordValidationReceipt(record);
  }

  async function mintDefaultSourceReceipt(
    validationId = "v-binding-source"
  ): Promise<ValidationReceiptRecord> {
    await seedJob("j-claude", { status: "completed" });
    await seedJob("j-codex", { status: "completed" });
    await seedRun(validationId);
    expect((await resolveValidationReceipt(deps, validationId, { caller: "local" })).status).toBe(
      "minted"
    );
    return requireStoredReceipt(validationId);
  }

  it("mints a receipt on read when the run is terminal", async () => {
    await seedJob("j-claude", { status: "completed", stdout: "Verdict: approve" });
    await seedJob("j-codex", { status: "completed", stdout: "Verdict: approve" });
    await seedRun("v1");

    const res = await resolveValidationReceipt(deps, "v1", { caller: "local" });
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

  it("is immutable: re-resolving returns the identical stored row", async () => {
    await seedJob("j-claude", { status: "completed" });
    await seedJob("j-codex", { status: "completed" });
    await seedRun("v1");

    const first = await resolveValidationReceipt(deps, "v1", { caller: "local" });
    const second = await resolveValidationReceipt(deps, "v1", { caller: "local" });
    expect(first.status).toBe("minted");
    expect(second.status).toBe("minted");
    if (first.status !== "minted" || second.status !== "minted") return;
    expect(second.mintedAt).toBe(first.mintedAt);
    expect(second.receipt.canonicalSha256).toBe(first.receipt.canonicalSha256);
    await expect(
      store.setValidationJudgeLink("v1", {
        provider: "codex",
        jobId: "late-judge",
        correlationId: "late-judge-correlation",
      })
    ).rejects.toThrow(/one-shot claim/);
    const afterLateJudgeAttempt = await resolveValidationReceipt(deps, "v1", { caller: "local" });
    expect(afterLateJudgeAttempt.status).toBe("minted");
    if (afterLateJudgeAttempt.status === "minted") {
      expect(afterLateJudgeAttempt.receipt.canonicalSha256).toBe(first.receipt.canonicalSha256);
      expect(afterLateJudgeAttempt.receipt.report.synthesis.status).toBe("not_requested");
    }
  });

  it.each(["stored report", "stored hash"])(
    "fails closed when an existing receipt has a corrupted %s",
    async corruption => {
      const source = await mintDefaultSourceReceipt();
      const validationId = `v-corrupt-${corruption.replace(" ", "-")}`;
      await recordCoherentReceiptClone(
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

      expect(await resolveValidationReceipt(deps, validationId, { caller: "local" })).toEqual({
        status: "verification_failed",
        validationId,
      });
    }
  );

  it("accepts an unmodified coherent receipt clone", async () => {
    const source = await mintDefaultSourceReceipt();
    const validationId = "v-coherent-clone-control";
    await recordCoherentReceiptClone(source, validationId);

    expect((await resolveValidationReceipt(deps, validationId, { caller: "local" })).status).toBe(
      "minted"
    );
  });

  it("authorizes an existing receipt from its run owner and rejects a forged receipt owner", async () => {
    await seedJob("j-claude", { status: "completed", owner: "alice" });
    await seedJob("j-codex", { status: "completed", owner: "alice" });
    await seedRun("v-owner-source", { owner: "alice" });
    expect(
      (await resolveValidationReceipt(deps, "v-owner-source", { caller: "alice" })).status
    ).toBe("minted");
    const source = store.getValidationReceipt("v-owner-source");
    expect(await source).not.toBeNull();
    if (!source) return;

    const validationId = "v-forged-owner";
    await recordCoherentReceiptClone(
      source,
      validationId,
      () => undefined,
      { owner: "alice" },
      record => {
        record.ownerPrincipal = "mallory";
      }
    );

    expect(await resolveValidationReceipt(deps, validationId, { caller: "mallory" })).toEqual({
      status: "not_found",
      validationId,
    });
    expect(await resolveValidationReceipt(deps, validationId, { caller: "alice" })).toEqual({
      status: "verification_failed",
      validationId,
    });
  });

  it("fails closed when storage returns a receipt for a different validation id", async () => {
    await seedJob("j-claude", { status: "completed" });
    await seedJob("j-codex", { status: "completed" });
    await seedRun("v1");
    expect((await resolveValidationReceipt(deps, "v1", { caller: "local" })).status).toBe("minted");

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
      await resolveValidationReceipt(
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
  ])("rejects a persisted v1 receipt with non-null %s", async (field, metadata) => {
    await seedJob("j-claude", { status: "completed" });
    await seedJob("j-codex", { status: "completed" });
    await seedRun("v1");
    expect((await resolveValidationReceipt(deps, "v1", { caller: "local" })).status).toBe("minted");
    const source = store.getValidationReceipt("v1");
    expect(await source).not.toBeNull();
    if (!source) return;

    const validationId = `v-corrupt-${field}`;
    await recordCoherentReceiptClone(
      source,
      validationId,
      () => undefined,
      {},
      record => Object.assign(record, metadata)
    );

    expect(await resolveValidationReceipt(deps, validationId, { caller: "local" })).toEqual({
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
  ])("rejects a coherently rehashed receipt with mismatched run %s", async (field, mutate) => {
    const source = await mintDefaultSourceReceipt();
    const validationId = `v-binding-${field}`;
    await recordCoherentReceiptClone(source, validationId, mutate);

    expect(await resolveValidationReceipt(deps, validationId, { caller: "local" })).toEqual({
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
  ])("rejects a coherently rehashed receipt with mismatched provider %s", async (field, mutate) => {
    const source = await mintDefaultSourceReceipt();
    const validationId = `v-provider-binding-${field.replaceAll(" ", "-")}`;
    await recordCoherentReceiptClone(source, validationId, mutate);

    expect(await resolveValidationReceipt(deps, validationId, { caller: "local" })).toEqual({
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
  ])("rejects a coherently rehashed receipt with a %s", async (field, mutate) => {
    await seedJob("j-claude", { status: "completed" });
    await seedRun("v-skipped-source", {
      providerLinks: [{ provider: "claude", jobId: "j-claude", correlationId: "corr-j-claude" }],
      modelList: ["claude", "codex"],
    });
    expect(
      (await resolveValidationReceipt(deps, "v-skipped-source", { caller: "local" })).status
    ).toBe("minted");
    const source = requireStoredReceipt("v-skipped-source");
    const validationId = `v-skipped-binding-${field.replaceAll(" ", "-")}`;
    await recordCoherentReceiptClone(source, validationId, mutate);

    expect(await resolveValidationReceipt(deps, validationId, { caller: "local" })).toEqual({
      status: "verification_failed",
      validationId,
    });
  });

  it("rejects a coherently rehashed unplanned judge synthesis", async () => {
    const source = await mintDefaultSourceReceipt();
    const validationId = "v-unplanned-judge-binding";
    await recordCoherentReceiptClone(source, validationId, async report => {
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

    expect(await resolveValidationReceipt(deps, validationId, { caller: "local" })).toEqual({
      status: "verification_failed",
      validationId,
    });
  });

  it("mints a receipt bound to an ad-hoc judge selected after kickoff", async () => {
    await seedJob("j-claude", { status: "completed" });
    await seedJob("j-judge", { status: "completed" });
    await seedRun("v-ad-hoc-judge", {
      providerLinks: [{ provider: "claude", jobId: "j-claude", correlationId: "corr-j-claude" }],
      modelList: ["claude"],
      judgeProvider: null,
      judgeLink: {
        provider: "codex",
        jobId: "j-judge",
        correlationId: "corr-j-judge",
      },
    });

    const receipt = await resolveValidationReceipt(deps, "v-ad-hoc-judge", { caller: "local" });
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

  it("keeps kickoff, ad-hoc judge synthesis, and immutable receipt binding coherent", async () => {
    await seedJob("j-claude", { status: "completed" });
    await seedRun("v-ad-hoc-flow", {
      providerLinks: [{ provider: "claude", jobId: "j-claude", correlationId: "corr-j-claude" }],
      modelList: ["claude"],
      judgeProvider: null,
    });
    const synthesis = await startJudgeSynthesis(
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
    await seedJob("j-ad-hoc-judge", {
      status: "completed",
      cli: "codex",
      correlationId: synthesis.rawJobReference!.correlationId,
    });
    const receipt = await resolveValidationReceipt(deps, "v-ad-hoc-flow", { caller: "local" });
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
  ])("rejects a coherently rehashed linked-judge %s mismatch", async (field, mutate) => {
    await seedJob("j-claude", { status: "completed" });
    await seedJob("j-codex", { status: "completed" });
    await seedJob("j-judge", { status: "completed" });
    await seedRun("v-linked-judge-source", {
      judgeLink: { provider: "codex", jobId: "j-judge", correlationId: "corr-j-judge" },
    });
    expect(
      (await resolveValidationReceipt(deps, "v-linked-judge-source", { caller: "local" })).status
    ).toBe("minted");
    const source = requireStoredReceipt("v-linked-judge-source");
    const validationId = `v-linked-judge-binding-${field.replaceAll(" ", "-")}`;
    await recordCoherentReceiptClone(source, validationId, mutate);

    expect(await resolveValidationReceipt(deps, validationId, { caller: "local" })).toEqual({
      status: "verification_failed",
      validationId,
    });
  });

  it("accepts a finalized existing receipt for a durably skipped planned judge", async () => {
    await seedJob("j-claude", { status: "completed" });
    await seedJob("j-codex", { status: "completed" });
    await seedRun("v-skipped-judge-source", { judgeProvider: "codex" });
    await store.setValidationRunStatus("v-skipped-judge-source", "judge_skipped");
    expect(
      (await resolveValidationReceipt(deps, "v-skipped-judge-source", { caller: "local" })).status
    ).toBe("minted");
    const source = requireStoredReceipt("v-skipped-judge-source");
    const validationId = "v-finalized-skipped-judge";
    await recordCoherentReceiptClone(source, validationId);

    expect((await resolveValidationReceipt(deps, validationId, { caller: "local" })).status).toBe(
      "minted"
    );
  });

  it("rejects a linked judge receipt when the durable run has a skipped-judge status", async () => {
    await seedJob("j-claude", { status: "completed" });
    await seedJob("j-codex", { status: "completed" });
    await seedJob("j-judge", { status: "completed" });
    await seedRun("v-linked-status-source", {
      judgeLink: { provider: "codex", jobId: "j-judge", correlationId: "corr-j-judge" },
    });
    expect(
      (await resolveValidationReceipt(deps, "v-linked-status-source", { caller: "local" })).status
    ).toBe("minted");
    const source = requireStoredReceipt("v-linked-status-source");
    const validationId = "v-linked-invalid-run-status";
    await recordCoherentReceiptClone(source, validationId, () => undefined, {
      status: "judge_skipped",
    });

    expect(await resolveValidationReceipt(deps, validationId, { caller: "local" })).toEqual({
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
  ])("rejects a coherent receipt whose judge aliases a provider %s", async (field, aliasJudge) => {
    await seedJob("j-claude", { status: "completed" });
    await seedJob("j-codex", { status: "completed" });
    await seedJob("j-judge", { status: "completed" });
    await seedRun("v-judge-alias-source", {
      judgeLink: { provider: "codex", jobId: "j-judge", correlationId: "corr-j-judge" },
    });
    expect(
      (await resolveValidationReceipt(deps, "v-judge-alias-source", { caller: "local" })).status
    ).toBe("minted");
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
    await recordCoherentReceiptClone(
      source,
      validationId,
      report => {
        report.synthesis.rawJobReference.jobId = runOverrides.judgeLink!.jobId;
        report.synthesis.rawJobReference.correlationId = runOverrides.judgeLink!.correlationId;
      },
      runOverrides
    );

    expect(await resolveValidationReceipt(deps, validationId, { caller: "local" })).toEqual({
      status: "verification_failed",
      validationId,
    });
  });

  it("serves a normally minted existing receipt without reloading nondurable answer jobs", async () => {
    await mintDefaultSourceReceipt("v-existing-binding-compatible");
    const unavailableManager = {
      getJobOwner() {
        throw new Error("Answer job owner was evicted");
      },
      getJobResult() {
        throw new Error("Answer job result was evicted");
      },
    } as unknown as AsyncJobManager;

    expect(
      (
        await resolveValidationReceipt(
          { asyncJobManager: unavailableManager, validationRunStore: store },
          "v-existing-binding-compatible",
          { caller: "local" }
        )
      ).status
    ).toBe("minted");
  });

  it("returns pending when a provider job is still running", async () => {
    await seedJob("j-claude", { status: "completed" });
    await seedJob("j-codex", { status: "running" });
    await seedRun("v1");

    const res = await resolveValidationReceipt(deps, "v1", { caller: "local" });
    expect(res.status).toBe("pending");
    if (res.status !== "pending") return;
    expect(res.run.providers.find(p => p.jobId === "j-codex")?.status).toBe("running");
  });

  it("does not finalize before a planned judge is claimed, but permits an explicit skip", async () => {
    await seedJob("j-claude", { status: "completed" });
    await store.recordValidationRun({
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

    expect(
      (await resolveValidationReceipt(deps, "v-planned-judge", { caller: "local" })).status
    ).toBe("pending");
    await store.setValidationRunStatus("v-planned-judge", "judge_skipped");
    const skipped = await resolveValidationReceipt(deps, "v-planned-judge", { caller: "local" });
    expect(skipped.status).toBe("minted");
    if (skipped.status !== "minted") return;
    expect(skipped.receipt.report.synthesis).toMatchObject({
      status: "skipped",
      judgeModel: "codex",
      rawJobReference: null,
    });
  });

  it("returns not_found for an unknown validationId", async () => {
    expect((await resolveValidationReceipt(deps, "missing", { caller: "local" })).status).toBe(
      "not_found"
    );
  });

  it("returns not_found for a run owned by another principal", async () => {
    await seedJob("j-claude", { status: "completed", owner: "alice" });
    await seedJob("j-codex", { status: "completed", owner: "alice" });
    await seedRun("v-alice", { owner: "alice" });

    expect((await resolveValidationReceipt(deps, "v-alice", { caller: "bob" })).status).toBe(
      "not_found"
    );
    // and the owner can mint it
    expect((await resolveValidationReceipt(deps, "v-alice", { caller: "alice" })).status).toBe(
      "minted"
    );
  });

  it("returns expired_unminted when a linked job was evicted before any mint", async () => {
    // The run links jobs that were never recorded (simulating eviction).
    await seedRun("v-evicted", {
      providerLinks: [{ provider: "claude", jobId: "gone-1", correlationId: "c1" }],
    });
    const res = await resolveValidationReceipt(deps, "v-evicted", { caller: "local" });
    expect(res.status).toBe("expired_unminted");
  });

  it.each([
    [
      "owner",
      async () => {
        await seedJob("j-claude", { status: "completed", owner: "other-owner" });
        await seedRun("v-integrity", {
          providerLinks: [
            { provider: "claude", jobId: "j-claude", correlationId: "corr-j-claude" },
          ],
          modelList: ["claude"],
        });
      },
    ],
    [
      "provider",
      async () => {
        await seedJob("j-claude", { status: "completed", cli: "codex" });
        await seedRun("v-integrity", {
          providerLinks: [
            { provider: "claude", jobId: "j-claude", correlationId: "corr-j-claude" },
          ],
          modelList: ["claude"],
        });
      },
    ],
    [
      "correlation",
      async () => {
        await seedJob("j-claude", { status: "completed" });
        await seedRun("v-integrity", {
          providerLinks: [
            { provider: "claude", jobId: "j-claude", correlationId: "wrong-correlation" },
          ],
          modelList: ["claude"],
        });
      },
    ],
    [
      "reverse run",
      async () => {
        await seedJob("j-claude", { status: "completed" });
        const link = {
          provider: "claude",
          jobId: "j-claude",
          correlationId: "corr-j-claude",
        };
        await seedRun("v-other", { providerLinks: [link], modelList: ["claude"] });
        await seedRun("v-integrity", { providerLinks: [link], modelList: ["claude"] });
      },
    ],
    [
      "truncated output",
      async () => {
        await seedJob("j-claude", { status: "completed", outputTruncated: true });
        await seedRun("v-integrity", {
          providerLinks: [
            { provider: "claude", jobId: "j-claude", correlationId: "corr-j-claude" },
          ],
          modelList: ["claude"],
        });
      },
    ],
  ])("fails closed without a receipt for a provider-link %s mismatch", async (_name, arrange) => {
    await arrange();
    expect((await resolveValidationReceipt(deps, "v-integrity", { caller: "local" })).status).toBe(
      "expired_unminted"
    );
    expect(await store.getValidationReceipt("v-integrity")).toBeNull();
  });

  it.each([
    ["owner", { owner: "other-owner" }, "corr-j-judge"],
    ["provider", { cli: "claude" as const }, "corr-j-judge"],
    ["correlation", {}, "wrong-correlation"],
    ["truncated output", { outputTruncated: true }, "corr-j-judge"],
  ])(
    "fails closed without a receipt for a judge-link %s mismatch",
    async (_name, judgeOptions, judgeCorrelationId) => {
      await seedJob("j-claude", { status: "completed" });
      await seedJob("j-judge", { status: "completed", ...judgeOptions });
      await seedRun("v-integrity", {
        providerLinks: [{ provider: "claude", jobId: "j-claude", correlationId: "corr-j-claude" }],
        modelList: ["claude"],
        judgeLink: {
          provider: "codex",
          jobId: "j-judge",
          correlationId: judgeCorrelationId,
        },
      });

      expect(
        (await resolveValidationReceipt(deps, "v-integrity", { caller: "local" })).status
      ).toBe("expired_unminted");
      expect(await store.getValidationReceipt("v-integrity")).toBeNull();
    }
  );

  it("fails closed when a judge reverse link points to another run", async () => {
    await seedJob("j-claude", { status: "completed" });
    await seedJob("j-judge", { status: "completed" });
    const judgeLink = {
      provider: "codex",
      jobId: "j-judge",
      correlationId: "corr-j-judge",
    };
    await seedRun("v-other", { providerLinks: [], modelList: [], judgeLink });
    await seedRun("v-integrity", {
      providerLinks: [{ provider: "claude", jobId: "j-claude", correlationId: "corr-j-claude" }],
      modelList: ["claude"],
      judgeLink,
    });

    expect((await resolveValidationReceipt(deps, "v-integrity", { caller: "local" })).status).toBe(
      "expired_unminted"
    );
    expect(await store.getValidationReceipt("v-integrity")).toBeNull();
  });

  it("rejects a judge link outside the stored judge plan", async () => {
    await seedJob("j-claude", { status: "completed" });
    await seedJob("j-judge", { status: "completed" });
    await seedRun("v-integrity", {
      providerLinks: [{ provider: "claude", jobId: "j-claude", correlationId: "corr-j-claude" }],
      modelList: ["claude"],
      judgeProvider: "claude",
      judgeLink: {
        provider: "codex",
        jobId: "j-judge",
        correlationId: "corr-j-judge",
      },
    });

    expect((await resolveValidationReceipt(deps, "v-integrity", { caller: "local" })).status).toBe(
      "expired_unminted"
    );
    expect(await store.getValidationReceipt("v-integrity")).toBeNull();
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
  ])("rejects provider roster links with a %s", async (_name, providerLinks) => {
    await seedJob("j-claude", { status: "completed" });
    await seedJob("j-other", { status: "completed" });
    await seedRun("v-integrity", { providerLinks, modelList: ["claude", "codex"] });

    expect((await resolveValidationReceipt(deps, "v-integrity", { caller: "local" })).status).toBe(
      "expired_unminted"
    );
    expect(await store.getValidationReceipt("v-integrity")).toBeNull();
  });

  it("rejects a provider link outside the stored requested roster", async () => {
    await seedJob("j-codex", { status: "completed" });
    await seedRun("v-integrity", {
      providerLinks: [{ provider: "codex", jobId: "j-codex", correlationId: "corr-j-codex" }],
      modelList: ["claude"],
    });

    expect((await resolveValidationReceipt(deps, "v-integrity", { caller: "local" })).status).toBe(
      "expired_unminted"
    );
    expect(await store.getValidationReceipt("v-integrity")).toBeNull();
  });

  it("rejects a duplicate requested provider roster", async () => {
    await seedJob("j-claude", { status: "completed" });
    await seedRun("v-integrity", {
      providerLinks: [{ provider: "claude", jobId: "j-claude", correlationId: "corr-j-claude" }],
      modelList: ["claude", "claude"],
    });

    expect((await resolveValidationReceipt(deps, "v-integrity", { caller: "local" })).status).toBe(
      "expired_unminted"
    );
    expect(await store.getValidationReceipt("v-integrity")).toBeNull();
  });

  it.each([
    ["job id", "j-claude", "corr-j-claude"],
    ["correlation id", "j-judge", "corr-j-claude"],
  ])(
    "rejects a judge link that aliases a provider %s",
    async (_name, judgeJobId, correlationId) => {
      await seedJob("j-claude", { status: "completed" });
      if (judgeJobId !== "j-claude") {
        await seedJob("j-judge", { status: "completed", correlationId });
      }
      await seedRun("v-integrity", {
        providerLinks: [{ provider: "claude", jobId: "j-claude", correlationId: "corr-j-claude" }],
        modelList: ["claude"],
        judgeLink: { provider: "codex", jobId: judgeJobId, correlationId },
      });

      expect(
        (await resolveValidationReceipt(deps, "v-integrity", { caller: "local" })).status
      ).toBe("expired_unminted");
      expect(await store.getValidationReceipt("v-integrity")).toBeNull();
    }
  );

  it.each(["owner", "result"])("fails closed when the job %s lookup throws", async lookup => {
    await seedJob("j-claude", { status: "completed" });
    await seedRun("v-integrity", {
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

    expect((await resolveValidationReceipt(deps, "v-integrity", { caller: "local" })).status).toBe(
      "expired_unminted"
    );
    expect(await store.getValidationReceipt("v-integrity")).toBeNull();
  });

  it("rejects a job result whose id does not match its durable link", async () => {
    await seedJob("j-claude", { status: "completed" });
    await seedRun("v-integrity", {
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

    expect((await resolveValidationReceipt(deps, "v-integrity", { caller: "local" })).status).toBe(
      "expired_unminted"
    );
    expect(await store.getValidationReceipt("v-integrity")).toBeNull();
  });

  it("mints with a judge when both providers and the judge are terminal", async () => {
    await seedJob("j-claude", { status: "completed" });
    await seedJob("j-codex", { status: "completed" });
    await seedJob("j-judge", { status: "completed", stdout: "Summary: agree" });
    await seedRun("v-judge", {
      judgeLink: { provider: "codex", jobId: "j-judge", correlationId: "corr-j-judge" },
    });

    const res = await resolveValidationReceipt(deps, "v-judge", { caller: "local" });
    expect(res.status).toBe("minted");
    if (res.status !== "minted") return;
    expect(res.receipt.report.synthesis.status).toBe("completed");
    expect(res.receipt.report.synthesis.judgeModel).toBe("codex");
  });

  it("stays pending while the judge job is still running", async () => {
    await seedJob("j-claude", { status: "completed" });
    await seedJob("j-codex", { status: "completed" });
    await seedJob("j-judge", { status: "running" });
    await seedRun("v-judge", {
      judgeLink: { provider: "codex", jobId: "j-judge", correlationId: "corr-j-judge" },
    });
    expect((await resolveValidationReceipt(deps, "v-judge", { caller: "local" })).status).toBe(
      "pending"
    );
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
  async function mintLegacyPlannedJudgeReceipt(
    validationId: string,
    plannedJudge = "codex"
  ): Promise<void> {
    await seedJob("j-claude", { status: "completed" });
    await seedJob("j-codex", { status: "completed" });
    await seedRun(validationId, { judgeProvider: plannedJudge });
    const run = await store.getValidationRun(validationId);
    if (!run) throw new Error(`Expected seeded run ${validationId}`);
    const request = JSON.parse(run.requestJson);
    const results = run.providerLinks.map(async link => {
      const result = manager.getJobResult(link.jobId, Number.MAX_SAFE_INTEGER);
      if (!result) throw new Error(`Expected seeded job ${link.jobId}`);
      return await normalizeJobResult(link.provider as any, null, result);
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
      status: await deriveValidationRunStatus(results, synthesis.status),
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
    await store.recordValidationReceipt({
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
    await store.setValidationRunStatus(validationId, "finalized");
  }

  it("verifies a legacy receipt minted before the planned-judge gate existed", async () => {
    await mintLegacyPlannedJudgeReceipt("v-legacy-planned-judge");
    const stored = requireStoredReceipt("v-legacy-planned-judge");
    // Precondition: the fixture really is the legacy shape the old mint wrote.
    expect(JSON.parse(stored.reportJson).synthesis).toEqual({
      status: "not_requested",
      judgeModel: null,
      rawJobReference: null,
      note: "No judge synthesis was requested.",
    });

    const res = await resolveValidationReceipt(deps, "v-legacy-planned-judge", { caller: "local" });
    expect(res.status).toBe("minted");
    if (res.status !== "minted") return;
    // The stored bytes are served back untouched and still hash to the stored
    // digest: canonical hashing is unchanged, this was only a policy mismatch.
    expect(res.receipt.canonicalSha256).toBe(stored.canonicalSha256);
    expect(computeCanonicalSha256(res.receipt.report)).toBe(stored.canonicalSha256);
    expect(res.receipt.report.synthesis.status).toBe("not_requested");
  });

  it("reports verification_failed, not expired_unminted, for a corrupted legacy receipt", async () => {
    await mintLegacyPlannedJudgeReceipt("v-legacy-corrupt");
    const stored = requireStoredReceipt("v-legacy-corrupt");
    // Same legacy shape and a roster that matches the run exactly, so the ONLY
    // defect under test is the tampered evidence itself.
    const validationId = "v-legacy-corrupt-clone";
    const report = JSON.parse(stored.reportJson);
    report.validationId = validationId;
    await seedRun(validationId, {
      modelList: report.modelList,
      judgeProvider: "codex",
      status: "finalized",
    });
    await store.recordValidationReceipt({
      ...stored,
      validationId,
      reportJson: JSON.stringify(report),
      canonicalSha256: "0".repeat(64),
    });

    const res = await resolveValidationReceipt(deps, validationId, { caller: "local" });
    // Fail-closed: the receipt still refuses to verify ...
    expect(res.status).not.toBe("minted");
    // ... and says so honestly instead of claiming nothing was ever minted.
    expect(res).toEqual({ status: "verification_failed", validationId });
    expect(await store.getValidationReceipt(validationId)).not.toBeNull();
  });

  it("does not extend the legacy allowance to a run that never finalized", async () => {
    // The legacy shape is accepted only on a finalized run, which is the state
    // the legacy mint always left behind. A planned-judge run still in
    // `running` is gated to pending today and must never mint this shape, so a
    // receipt claiming it does not verify.
    await mintLegacyPlannedJudgeReceipt("v-legacy-running-source");
    const stored = requireStoredReceipt("v-legacy-running-source");
    const validationId = "v-legacy-running";
    const report = JSON.parse(stored.reportJson);
    report.validationId = validationId;
    // Coherently rehashed against a matching roster: only the run status,
    // which the allowance deliberately pins to `finalized`, is out of contract.
    await seedRun(validationId, {
      modelList: report.modelList,
      judgeProvider: "codex",
      status: "running",
    });
    await store.recordValidationReceipt({
      ...stored,
      validationId,
      reportJson: JSON.stringify(report),
      canonicalSha256: computeCanonicalSha256(report),
    });

    expect(await resolveValidationReceipt(deps, validationId, { caller: "local" })).toEqual({
      status: "verification_failed",
      validationId,
    });
  });

  it("reports expired_unminted (absence), never verification_failed, when no receipt exists", async () => {
    // The run links a job that was never recorded (simulating eviction): there
    // is nothing to verify, so absence is the honest answer.
    await seedRun("v-absent", {
      providerLinks: [{ provider: "claude", jobId: "gone-1", correlationId: "c1" }],
    });

    expect(await resolveValidationReceipt(deps, "v-absent", { caller: "local" })).toEqual({
      status: "expired_unminted",
      validationId: "v-absent",
    });
    expect(await store.getValidationReceipt("v-absent")).toBeNull();
  });

  it("includeRawResponses returns the full answer as a read-time field, never in the hashed report", async () => {
    // Output longer than both the report's 1800-char rationale excerpt and the
    // manager's default 200,000-char page, with a sentinel only in the full text.
    const longAnswer = `${"verbose ".repeat(26_000)} TAILSENTINEL`;
    await seedJob("j-claude", { status: "completed", stdout: longAnswer });
    await seedJob("j-codex", { status: "completed", stdout: "Verdict: approve" });
    await seedRun("v1");

    const withRaw = await resolveValidationReceipt(deps, "v1", {
      caller: "local",
      includeRawResponses: true,
    });
    const withoutRaw = await resolveValidationReceipt(deps, "v1", { caller: "local" });
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

  it("omits raw responses whose complete-page or byte identity checks fail", async () => {
    await seedJob("j-claude", { status: "completed" });
    await seedJob("j-codex", { status: "completed" });
    await seedRun("v1");
    expect((await resolveValidationReceipt(deps, "v1", { caller: "local" })).status).toBe("minted");

    const getJobResult = manager.getJobResult.bind(manager);
    const integrityCheckingManager = {
      getJobOwner: manager.getJobOwner.bind(manager),
      async getJobResult(jobId: string, maxChars?: number) {
        const value = await getJobResult(jobId, maxChars);
        if (!value) return null;
        if (jobId === "j-claude") {
          return { ...value, stdoutTruncated: true, stdoutNextOffsetChars: value.stdout.length };
        }
        return { ...value, stdoutBytes: value.stdoutBytes + 1 };
      },
    } as unknown as AsyncJobManager;

    const resolved = await resolveValidationReceipt(
      { asyncJobManager: integrityCheckingManager, validationRunStore: store },
      "v1",
      { caller: "local", includeRawResponses: true }
    );

    expect(resolved.status).toBe("minted");
    if (resolved.status !== "minted") return;
    expect(resolved.rawResponses).toEqual([]);
  });

  it("eager mint from a collected job id mints the receipt without a read", async () => {
    await seedJob("j-claude", { status: "completed" });
    await seedJob("j-codex", { status: "completed" });
    await seedRun("v1");

    expect(await store.getValidationReceipt("v1")).toBeNull();
    await eagerMintFromJobId(deps, "j-codex"); // simulates the job_result hook
    expect(await store.getValidationReceipt("v1")).not.toBeNull();
  });

  it("eager mint is a no-op when the run is not yet terminal", async () => {
    await seedJob("j-claude", { status: "completed" });
    await seedJob("j-codex", { status: "running" });
    await seedRun("v1");
    await eagerMintFromJobId(deps, "j-claude");
    expect(await store.getValidationReceipt("v1")).toBeNull();
  });

  it("returns not_found when no durable run store is wired", async () => {
    const noStore: ReceiptDeps = { asyncJobManager: manager };
    expect((await resolveValidationReceipt(noStore, "v1", { caller: "local" })).status).toBe(
      "not_found"
    );
  });

  // Phase 2: auto-mint by validationId (synthesize_validation convenience) +
  // markdown rendering on read.
  it("eagerMintFromValidationId mints a terminal run with no judge", async () => {
    await seedJob("j-claude", { status: "completed" });
    await seedJob("j-codex", { status: "completed" });
    await seedRun("v1");
    await eagerMintFromValidationId(deps, "v1");
    expect(await store.getValidationReceipt("v1")).not.toBeNull();
  });

  it("eagerMintFromValidationId is a no-op while the judge is still running", async () => {
    await seedJob("j-claude", { status: "completed" });
    await seedJob("j-codex", { status: "completed" });
    await seedJob("j-judge", { status: "running" });
    await seedRun("v-judge", {
      judgeLink: { provider: "codex", jobId: "j-judge", correlationId: "corr-j-judge" },
    });
    await eagerMintFromValidationId(deps, "v-judge");
    expect(await store.getValidationReceipt("v-judge")).toBeNull();
  });

  it("marks the run finalized once a receipt is minted", async () => {
    await seedJob("j-claude", { status: "completed" });
    await seedJob("j-codex", { status: "completed" });
    await seedRun("v1");
    expect((await store.getValidationRun("v1"))?.status).toBe("running");
    await resolveValidationReceipt(deps, "v1", { caller: "local" });
    expect((await store.getValidationRun("v1"))?.status).toBe("finalized");
  });

  it("records a non-completed judge as skipped synthesis, never completed", async () => {
    await seedJob("j-claude", { status: "completed" });
    await seedJob("j-codex", { status: "completed" });
    await seedJob("j-judge", { status: "failed" });
    await seedRun("v-judge", {
      judgeLink: { provider: "codex", jobId: "j-judge", correlationId: "corr-j-judge" },
    });
    const res = await resolveValidationReceipt(deps, "v-judge", { caller: "local" });
    expect(res.status).toBe("minted");
    if (res.status !== "minted") return;
    expect(res.receipt.report.synthesis.status).toBe("skipped");
    expect(res.receipt.report.synthesis.note).toMatch(/failed/);
  });

  it("reconstructs skipped providers (requested but not dispatched) in the minted report", async () => {
    await seedJob("j-claude", { status: "completed" });
    await seedJob("j-codex", { status: "completed" });
    // gemini was requested at kickoff but never dispatched (no provider link).
    await seedRun("v1", { modelList: ["claude", "codex", "gemini"] });
    const res = await resolveValidationReceipt(deps, "v1", { caller: "local" });
    expect(res.status).toBe("minted");
    if (res.status !== "minted") return;
    const gemini = res.receipt.report.perModelOutputs.find(o => o.provider === "gemini");
    expect(gemini?.status).toBe("skipped");
    expect(res.receipt.report.modelList).toEqual(["claude", "codex", "gemini"]);
  });

  it("the receipt envelope's humanReadable is the renderHumanReport of the stored report", async () => {
    await seedJob("j-claude", { status: "completed" });
    await seedJob("j-codex", { status: "completed" });
    await seedRun("v1");
    const res = await resolveValidationReceipt(deps, "v1", { caller: "local" });
    expect(res.status).toBe("minted");
    if (res.status !== "minted") return;
    expect(res.receipt.humanReadable).toBe(renderHumanReport(res.receipt.report));
    expect(res.receipt.humanReadable).toContain("Validation report v1");
  });
});
