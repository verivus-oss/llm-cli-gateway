import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PostgresJobStore,
  computeRequestKey,
  isValidationRunStore,
  type JobStore,
  type ValidationRunStore,
} from "../job-store.js";
import { cleanTestDatabase, setupTestDatabase } from "./setup.js";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgresql://test:test@localhost:5433/llm_gateway_test";

describe("PostgresJobStore", () => {
  let store: JobStore & ValidationRunStore;

  beforeEach(async () => {
    await setupTestDatabase();
    await cleanTestDatabase();
    store = new PostgresJobStore(TEST_DATABASE_URL, undefined, {
      retentionMs: 60_000,
      dedupWindowMs: 60_000,
    });
  });

  afterEach(() => {
    store.close();
  });

  it("round-trips a completed process job", () => {
    const startedAt = new Date().toISOString();
    const finishedAt = new Date().toISOString();
    const requestKey = computeRequestKey("claude", ["-p", "postgres"]);

    store.recordStart({
      id: "pg-job-1",
      correlationId: "pg-corr-1",
      requestKey,
      cli: "claude",
      args: ["-p", "postgres"],
      outputFormat: "text",
      startedAt,
      pid: 123,
      ownerPrincipal: "alice@example.com",
    });
    store.recordOutput("pg-job-1", "partial", "", false);
    store.recordComplete({
      id: "pg-job-1",
      status: "completed",
      exitCode: 0,
      stdout: "done",
      stderr: "",
      outputTruncated: false,
      error: null,
      finishedAt,
    });

    const row = store.getById("pg-job-1");
    expect(row).toMatchObject({
      id: "pg-job-1",
      correlationId: "pg-corr-1",
      requestKey,
      cli: "claude",
      argsJson: JSON.stringify(["-p", "postgres"]),
      outputFormat: "text",
      status: "completed",
      exitCode: 0,
      stdout: "done",
      stderr: "",
      outputTruncated: false,
      error: null,
      pid: 123,
      ownerPrincipal: "alice@example.com",
      transport: "process",
      httpStatus: null,
      payloadJson: null,
    });
    expect(store.findByRequestKey(requestKey)?.id).toBe("pg-job-1");
  });

  it("round-trips an HTTP job without persisting an API key", () => {
    const payloadJson = JSON.stringify({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hello" }],
    });
    store.recordStart({
      id: "pg-http-1",
      correlationId: "pg-http-corr",
      requestKey: "http-key",
      cli: "openai",
      args: [],
      startedAt: new Date().toISOString(),
      pid: null,
      transport: "http",
      payloadJson,
    });
    store.recordComplete({
      id: "pg-http-1",
      status: "failed",
      exitCode: 1,
      stdout: "",
      stderr: "unauthorized",
      outputTruncated: false,
      error: "unauthorized",
      finishedAt: new Date().toISOString(),
      httpStatus: 401,
    });

    const row = store.getById("pg-http-1");
    expect(row?.transport).toBe("http");
    expect(row?.payloadJson).toBe(payloadJson);
    expect(row?.payloadJson).not.toContain("apiKey");
    expect(row?.httpStatus).toBe(401);
  });

  it("marks running rows orphaned on startup", () => {
    const startedAt = new Date().toISOString();
    store.recordStart({
      id: "pg-running",
      correlationId: "pg-running-corr",
      requestKey: "running-key",
      cli: "mistral",
      args: ["--prompt", "x"],
      startedAt,
      pid: null,
    });

    const result = store.markOrphanedOnStartup();
    expect(result.count).toBe(1);
    expect(result.orphaned[0]).toMatchObject({
      id: "pg-running",
      correlationId: "pg-running-corr",
      startedAt,
      stdout: "",
      stderr: "",
      transport: "process",
    });
    expect(store.getById("pg-running")?.status).toBe("orphaned");
  });

  it("persists validation runs and receipts", () => {
    expect(isValidationRunStore(store)).toBe(true);
    store.recordValidationRun({
      validationId: "val-pg-1",
      ownerPrincipal: "alice",
      intent: "review",
      createdAt: new Date().toISOString(),
      requestJson: JSON.stringify({ question: "ship?" }),
      providerLinks: [{ provider: "openai", jobId: "job-openai", correlationId: "corr-openai" }],
      judgeLink: null,
      status: "running",
    });
    store.setValidationJudgeLink("val-pg-1", {
      provider: "anthropic",
      jobId: "job-judge",
      correlationId: "corr-judge",
    });
    store.setValidationRunStatus("val-pg-1", "finalized");
    store.recordValidationReceipt({
      validationId: "val-pg-1",
      ownerPrincipal: "alice",
      mintedAt: new Date().toISOString(),
      schemaVersion: "validation-report.v1",
      reportJson: JSON.stringify({ ok: true }),
      canonicalSha256: "abc123",
      prevSha256: null,
      seq: null,
      signature: null,
      models: ["openai", "anthropic"],
      hasMaterialDisagreement: false,
      confidence: "high",
    });

    expect(store.getValidationRun("val-pg-1")).toMatchObject({
      validationId: "val-pg-1",
      ownerPrincipal: "alice",
      status: "finalized",
      judgeLink: { provider: "anthropic", jobId: "job-judge", correlationId: "corr-judge" },
    });
    expect(store.getValidationRunIdByJobId("job-openai")).toBe("val-pg-1");
    expect(store.getValidationRunIdByJobId("job-judge")).toBe("val-pg-1");
    expect(store.getValidationReceipt("val-pg-1")).toMatchObject({
      validationId: "val-pg-1",
      models: ["openai", "anthropic"],
      hasMaterialDisagreement: false,
      confidence: "high",
    });
  });
});
