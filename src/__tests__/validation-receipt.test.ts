import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteJobStore } from "../job-store.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { noopLogger } from "../logger.js";
import {
  canonicalJson,
  computeCanonicalSha256,
  eagerMintFromJobId,
  eagerMintFromValidationId,
  resolveValidationReceipt,
  type ReceiptDeps,
} from "../validation-receipt.js";
import { renderHumanReport } from "../validation-report.js";

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
    opts: { owner?: string; status?: "running" | "completed" | "failed"; stdout?: string } = {}
  ): void {
    const now = new Date().toISOString();
    store.recordStart({
      id,
      correlationId: `corr-${id}`,
      requestKey: "k",
      cli: "claude",
      args: [],
      startedAt: now,
      pid: null,
      ownerPrincipal: opts.owner ?? "local",
    });
    if (opts.status && opts.status !== "running") {
      store.recordComplete({
        id,
        status: opts.status,
        exitCode: opts.status === "completed" ? 0 : 1,
        stdout: opts.stdout ?? "Verdict: approve\nLooks good.",
        stderr: "",
        outputTruncated: false,
        error: null,
        finishedAt: now,
      });
    }
  }

  function seedRun(
    validationId: string,
    opts: {
      owner?: string;
      providerLinks?: Array<{ provider: string; jobId: string; correlationId: string }>;
      judgeLink?: { provider: string; jobId: string; correlationId: string } | null;
      modelList?: string[];
    } = {}
  ): void {
    store.recordValidationRun({
      validationId,
      ownerPrincipal: opts.owner ?? "local",
      intent: "validate",
      createdAt: new Date(0).toISOString(),
      requestJson: JSON.stringify({
        question: "Is this safe?",
        modelList: opts.modelList ?? ["claude", "codex"],
      }),
      providerLinks: opts.providerLinks ?? [
        { provider: "claude", jobId: "j-claude", correlationId: "corr-j-claude" },
        { provider: "codex", jobId: "j-codex", correlationId: "corr-j-codex" },
      ],
      judgeLink: opts.judgeLink ?? null,
      status: "running",
    });
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

  it("mints with a judge when both providers and the judge are terminal", () => {
    seedJob("j-claude", { status: "completed" });
    seedJob("j-codex", { status: "completed" });
    seedJob("j-judge", { status: "completed", stdout: "Summary: agree" });
    seedRun("v-judge", {
      judgeLink: { provider: "codex", jobId: "j-judge", correlationId: "corr-judge" },
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
      judgeLink: { provider: "codex", jobId: "j-judge", correlationId: "corr-judge" },
    });
    expect(resolveValidationReceipt(deps, "v-judge", { caller: "local" }).status).toBe("pending");
  });

  it("includeRawResponses returns the full answer as a read-time field, never in the hashed report", () => {
    // Output longer than the report's 1800-char rationale excerpt, with a tail
    // sentinel that survives only in the full raw text, not in the report.
    const longAnswer = `${"verbose ".repeat(400)} TAILSENTINEL`;
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
      judgeLink: { provider: "codex", jobId: "j-judge", correlationId: "corr-judge" },
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
      judgeLink: { provider: "codex", jobId: "j-judge", correlationId: "corr-judge" },
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
