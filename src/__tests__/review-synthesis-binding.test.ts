import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiProviderRuntime } from "../config.js";
import type { AsyncJobResult, AsyncJobSnapshot } from "../async-job-manager.js";
import { SqliteJobStore, type ValidationRunRecord } from "../job-store.js";
import { runWithRequestContext } from "../request-context.js";
import { registerValidationTools } from "../validation-tools.js";

type ToolResponse = { structuredContent: Record<string, any> };
type ToolHandler = (args: Record<string, any>) => Promise<ToolResponse>;

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function result(overrides: Partial<AsyncJobResult> = {}): AsyncJobResult {
  const stdout = overrides.stdout ?? "durable provider finding";
  const stderr = overrides.stderr ?? "";
  return {
    id: "job-codex",
    cli: "codex",
    status: "completed",
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(1).toISOString(),
    exitCode: 0,
    correlationId: "corr-codex",
    outputTruncated: false,
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    error: null,
    exited: true,
    progress: {
      capability: "activity_only",
      lastActivityAt: new Date(1).toISOString(),
      lastSeq: 0,
      droppedCount: 0,
      events: [],
    },
    stdout,
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutOffsetChars: 0,
    stdoutTotalChars: stdout.length,
    stdoutNextOffsetChars: null,
    stderrOffsetChars: 0,
    stderrTotalChars: stderr.length,
    stderrNextOffsetChars: null,
    ...overrides,
  };
}

function runRecord(overrides: Partial<ValidationRunRecord> = {}): ValidationRunRecord {
  const repository = "/authorized/repository";
  return {
    validationId: "review-1",
    ownerPrincipal: "alice",
    intent: "review",
    createdAt: new Date(0).toISOString(),
    requestJson: JSON.stringify({
      question: "stored canonical review question",
      modelList: ["codex"],
      judgeProvider: "ollama",
      reviewAuthorization: {
        schemaVersion: "review-run-authorization.v1",
        repositoryPath: repository,
        repositoryRoot: repository,
        judgeProvider: "ollama",
        allowApiUpload: true,
      },
    }),
    providerLinks: [{ provider: "codex", jobId: "job-codex", correlationId: "corr-codex" }],
    judgeLink: null,
    status: "running",
    ...overrides,
  };
}

function harness(options: {
  run?: ValidationRunRecord;
  reverseIndexedRun?: ValidationRunRecord;
  providerResult?: AsyncJobResult | null;
  providerResultsById?: Record<string, AsyncJobResult | null>;
  providerOwner?: string | null;
}) {
  const directory = mkdtempSync(join(tmpdir(), "review-synthesis-binding-"));
  directories.push(directory);
  const store = new SqliteJobStore(join(directory, "jobs.db"));
  const run = options.run ?? runRecord();
  if (options.reverseIndexedRun) store.recordValidationRun(options.reverseIndexedRun);
  store.recordValidationRun(run);

  const handlers: Record<string, ToolHandler> = {};
  const httpStarts: Array<Record<string, any>> = [];
  const providerResult = options.providerResult === undefined ? result() : options.providerResult;
  const providerResultsById = options.providerResultsById ?? { "job-codex": providerResult };
  const providerOwner = options.providerOwner === undefined ? "alice" : options.providerOwner;
  const manager = {
    getLimiterSnapshot: () => ({ running: 0, queued: 0 }),
    getJobOwner: (jobId: string) =>
      Object.hasOwn(providerResultsById, jobId) ? providerOwner : "alice",
    getJobResult: (jobId: string) => providerResultsById[jobId] ?? null,
    getJobSnapshot: () => null,
    startHttpJob(input: Record<string, any>) {
      httpStarts.push(input);
      const snapshot: AsyncJobSnapshot = {
        id: "job-judge",
        cli: "ollama",
        status: "running",
        startedAt: new Date(2).toISOString(),
        finishedAt: null,
        exitCode: null,
        correlationId: input.correlationId,
        outputTruncated: false,
        stdoutBytes: 0,
        stderrBytes: 0,
        error: null,
        exited: false,
        progress: {
          capability: "lifecycle_only",
          lastActivityAt: new Date(2).toISOString(),
          lastSeq: 0,
          droppedCount: 0,
          events: [],
        },
      };
      if (input.validationAdmission?.role === "judge") {
        store.setValidationJudgeLink(input.validationAdmission.validationId, {
          provider: input.validationAdmission.provider,
          jobId: snapshot.id,
          correlationId: snapshot.correlationId,
        });
      }
      return {
        snapshot: { ...snapshot, status: input.deferLaunch ? "queued" : snapshot.status },
        deduped: false,
        ...(input.deferLaunch
          ? { deferredLaunch: { release: () => undefined, cancel: () => true } }
          : {}),
      };
    },
    cancelJob: () => ({ canceled: true }),
  };
  const apiProvider: ApiProviderRuntime = {
    name: "ollama",
    kind: "openai-compatible",
    apiKeyEnv: null,
    baseUrl: "http://127.0.0.1:11434/v1",
    defaultModel: "review-model",
    apiKey: "",
  };
  const server = {
    tool(name: string, ...args: unknown[]): void {
      handlers[name] = args.at(-1) as ToolHandler;
    },
  };
  registerValidationTools(server as never, {
    asyncJobManager: manager as never,
    apiProviders: [apiProvider],
    validationRunStore: store,
    resolveReviewRepository: () => "/authorized/repository",
  });
  return { handlers, httpStarts, store };
}

async function synthesize(handler: ToolHandler, overrides: Record<string, any> = {}) {
  return runWithRequestContext(
    {
      transport: "http",
      authKind: "oauth",
      authScopes: ["mcp"],
      authPrincipal: "alice",
    },
    () =>
      handler({
        validationId: "review-1",
        workspace: "review",
        judgeModel: "ollama",
        ...overrides,
      })
  );
}

describe("durable review synthesis input binding", () => {
  it("uses only the stored question and exact durable provider result", async () => {
    const { handlers, httpStarts, store } = harness({});
    const response = await synthesize(handlers.synthesize_validation, {
      question: "fabricated caller question",
      providerResults: [
        {
          provider: "claude",
          model: null,
          status: "completed",
          verdict: "approve",
          rationale: "fabricated caller result",
          risks: [],
          rawJobReference: null,
          error: null,
        },
      ],
    });

    expect(response.structuredContent).toMatchObject({
      success: true,
      synthesis: { status: "running", judgeModel: "ollama" },
    });
    expect(httpStarts).toHaveLength(1);
    const prompt = JSON.stringify(httpStarts[0].apiRequest.messages);
    expect(prompt).toContain("stored canonical review question");
    expect(prompt).toContain("durable provider finding");
    expect(prompt).not.toContain("fabricated caller question");
    expect(prompt).not.toContain("fabricated caller result");
    expect(store.getValidationRun("review-1")?.judgeLink?.jobId).toBe("job-judge");
  });

  it("preserves a material finding beyond normalized rationale limits", async () => {
    const materialFinding = "MATERIAL_FINDING_AFTER_1800: unsafe rollback deletes user data";
    const stdout = `${"context ".repeat(300)}${materialFinding}`;
    const { handlers, httpStarts } = harness({ providerResult: result({ stdout }) });

    const response = await synthesize(handlers.synthesize_validation);
    expect(response.structuredContent).toMatchObject({ success: true });
    expect(httpStarts).toHaveLength(1);
    const prompt = httpStarts[0].apiRequest.messages[0].content as string;
    expect(prompt).toContain(materialFinding);
    expect(prompt).toContain(`"byteLength": ${Buffer.byteLength(stdout)}`);
    expect(prompt).toContain(createHash("sha256").update(stdout).digest("hex"));
    expect(prompt).toContain("review-judge-evidence.v1");
    expect(prompt).toContain("requestedRoster");
  });

  it("preserves failed linked stderr and roster status alongside completed evidence", async () => {
    const failedStderr = "FULL_FAILED_PROVIDER_STDERR: authentication expired during review";
    const base = runRecord();
    const run = {
      ...base,
      requestJson: JSON.stringify({
        ...JSON.parse(base.requestJson),
        modelList: ["codex", "claude"],
      }),
      providerLinks: [
        ...base.providerLinks,
        { provider: "claude", jobId: "job-claude", correlationId: "corr-claude" },
      ],
    };
    const { handlers, httpStarts } = harness({
      run,
      providerResultsById: {
        "job-codex": result(),
        "job-claude": result({
          id: "job-claude",
          cli: "claude",
          correlationId: "corr-claude",
          status: "failed",
          exitCode: 1,
          stderr: failedStderr,
        }),
      },
    });

    const response = await synthesize(handlers.synthesize_validation);
    expect(response.structuredContent).toMatchObject({ success: true });
    expect(httpStarts).toHaveLength(1);
    const prompt = httpStarts[0].apiRequest.messages[0].content as string;
    expect(prompt).toContain(failedStderr);
    expect(prompt).toContain('"provider": "claude"');
    expect(prompt).toContain('"status": "failed"');
  });

  it.each([
    ["durable truncation", result({ outputTruncated: true })],
    ["stdout page truncation", result({ stdoutTruncated: true })],
    ["incomplete stdout paging", result({ stdoutNextOffsetChars: 10 })],
    ["wrong stdout offset", result({ stdoutOffsetChars: 1 })],
  ])("rejects %s before API dispatch", async (_name, providerResult) => {
    const { handlers, httpStarts } = harness({ providerResult });
    const response = await synthesize(handlers.synthesize_validation);
    expect(response.structuredContent).toMatchObject({
      success: false,
      errorCategory: "review_synthesis_binding_failed",
      error: expect.stringContaining("truncated or paging is incomplete"),
    });
    expect(httpStarts).toHaveLength(0);
  });

  it("rejects inconsistent durable output byte identity before API dispatch", async () => {
    const { handlers, httpStarts } = harness({
      providerResult: result({ stdoutBytes: 1 }),
    });
    const response = await synthesize(handlers.synthesize_validation);
    expect(response.structuredContent).toMatchObject({
      success: false,
      errorCategory: "review_synthesis_binding_failed",
      error: expect.stringContaining("byte identity is inconsistent"),
    });
    expect(httpStarts).toHaveLength(0);
  });

  it("rejects durable evidence whose reverse index belongs to another run", async () => {
    const reverseIndexedRun = runRecord({ validationId: "review-other" });
    const { handlers, httpStarts } = harness({ reverseIndexedRun });

    const response = await synthesize(handlers.synthesize_validation);

    expect(response.structuredContent).toMatchObject({
      success: false,
      errorCategory: "review_synthesis_binding_failed",
      error: expect.stringContaining("linked to another run"),
    });
    expect(httpStarts).toHaveLength(0);
  });

  it("rejects duplicate provider-link correlation IDs before API dispatch", async () => {
    const base = runRecord();
    const duplicateCorrelationRun = {
      ...base,
      requestJson: JSON.stringify({
        ...JSON.parse(base.requestJson),
        modelList: ["codex", "claude"],
      }),
      providerLinks: [
        { provider: "codex", jobId: "job-codex", correlationId: "corr-shared" },
        { provider: "claude", jobId: "job-claude", correlationId: "corr-shared" },
      ],
    };
    const { handlers, httpStarts } = harness({
      run: duplicateCorrelationRun,
      providerResultsById: {
        "job-codex": result({ correlationId: "corr-shared" }),
        "job-claude": result({
          id: "job-claude",
          cli: "claude",
          correlationId: "corr-shared",
        }),
      },
    });

    const response = await synthesize(handlers.synthesize_validation);

    expect(response.structuredContent).toMatchObject({
      success: false,
      errorCategory: "review_synthesis_binding_failed",
      error: expect.stringContaining("provider links are invalid"),
    });
    expect(httpStarts).toHaveLength(0);
  });

  it.each([
    ["missing", null, "alice", "result is missing"],
    ["nonterminal", result({ status: "running", finishedAt: null }), "alice", "must be terminal"],
    ["unowned", result(), "mallory", "not owned"],
    ["legacy-unowned", result(), null, "not owned"],
    ["provider mismatch", result({ cli: "claude" }), "alice", "result is mismatched"],
    [
      "correlation mismatch",
      result({ correlationId: "corr-other" }),
      "alice",
      "result is mismatched",
    ],
  ])("rejects %s durable evidence before API dispatch", async (_name, job, owner, message) => {
    const { handlers, httpStarts } = harness({
      providerResult: job as AsyncJobResult | null,
      providerOwner: owner as string | null,
    });
    const response = await synthesize(handlers.synthesize_validation);
    expect(response.structuredContent).toMatchObject({
      success: false,
      errorCategory: "review_synthesis_binding_failed",
      error: expect.stringContaining(message),
    });
    expect(httpStarts).toHaveLength(0);
  });

  it.each([
    [
      "missing stored question",
      (() => {
        const base = runRecord();
        const request = JSON.parse(base.requestJson);
        delete request.question;
        return { ...base, requestJson: JSON.stringify(request) };
      })(),
      "request is incomplete or invalid",
    ],
    [
      "mismatched stored judge",
      (() => {
        const base = runRecord();
        return {
          ...base,
          requestJson: JSON.stringify({
            ...JSON.parse(base.requestJson),
            judgeProvider: "codex",
          }),
        };
      })(),
      "judgeModel does not match",
    ],
  ])("rejects a run with %s", async (_name, run, message) => {
    const { handlers, httpStarts } = harness({ run });
    const response = await synthesize(handlers.synthesize_validation);
    expect(response.structuredContent).toMatchObject({
      success: false,
      error: expect.stringContaining(message),
    });
    expect(httpStarts).toHaveLength(0);
  });

  it("reconstructs a requested but undispatched provider as skipped", async () => {
    const base = runRecord();
    const run = {
      ...base,
      requestJson: JSON.stringify({
        ...JSON.parse(base.requestJson),
        modelList: ["codex", "claude"],
      }),
    };
    const { handlers, httpStarts } = harness({ run });
    const response = await synthesize(handlers.synthesize_validation);
    expect(response.structuredContent).toMatchObject({
      success: true,
      synthesis: {
        status: "running",
        note: expect.stringContaining("1 non-completed result(s) were preserved but omitted"),
      },
    });
    expect(httpStarts).toHaveLength(1);
  });

  it.each([
    [
      "duplicate requested provider",
      (() => {
        const base = runRecord();
        return {
          ...base,
          requestJson: JSON.stringify({
            ...JSON.parse(base.requestJson),
            modelList: ["codex", "codex"],
          }),
        };
      })(),
    ],
    [
      "unexpected provider link",
      runRecord({
        providerLinks: [
          { provider: "codex", jobId: "job-codex", correlationId: "corr-codex" },
          { provider: "claude", jobId: "job-claude", correlationId: "corr-claude" },
        ],
      }),
    ],
  ])("rejects a %s", async (_name, run) => {
    const { handlers, httpStarts } = harness({ run });
    const response = await synthesize(handlers.synthesize_validation);
    expect(response.structuredContent).toMatchObject({
      success: false,
      error: expect.stringContaining("duplicate or unexpected links"),
    });
    expect(httpStarts).toHaveLength(0);
  });

  it.each([
    ["finalized run", runRecord({ status: "finalized" }), "not open"],
    [
      "already-linked judge",
      runRecord({
        judgeLink: {
          provider: "ollama",
          jobId: "existing-judge",
          correlationId: "existing-correlation",
        },
      }),
      "already has a judge job",
    ],
  ])("rejects a %s before API dispatch", async (_name, run, message) => {
    const { handlers, httpStarts } = harness({ run });
    const response = await synthesize(handlers.synthesize_validation);
    expect(response.structuredContent).toMatchObject({
      success: false,
      error: expect.stringContaining(message),
    });
    expect(httpStarts).toHaveLength(0);
  });

  it("still requires caller inputs for general validation synthesis", async () => {
    const { handlers, httpStarts } = harness({});
    const response = await handlers.synthesize_validation({ judgeModel: "codex" });
    expect(response.structuredContent).toMatchObject({
      success: false,
      error: "General validation synthesis requires question and providerResults",
    });
    expect(httpStarts).toHaveLength(0);
  });
});
