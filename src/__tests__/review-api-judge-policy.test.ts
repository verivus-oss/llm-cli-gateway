import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AsyncJobManager } from "../async-job-manager.js";
import {
  type ApiProviderConfig,
  type ApiProviderRuntime,
  type PersistenceConfig,
  type ProvidersConfig,
} from "../config.js";
import { createGatewayServer } from "../index.js";
import { MemoryJobStore, SqliteJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import { runWithRequestContext } from "../request-context.js";
import { registerValidationTools } from "../validation-tools.js";
import type { ValidationProvider } from "../validation-normalizer.js";

interface RegisteredTool {
  handler: (
    args: Record<string, unknown>,
    extra?: Record<string, unknown>
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

function providers(): ProvidersConfig {
  const provider: ApiProviderConfig = {
    name: "ollama",
    kind: "openai-compatible",
    apiKeyEnv: null,
    baseUrl: "http://127.0.0.1:11434/v1",
    defaultModel: "review-model",
  };
  return { xai: null, providers: { ollama: provider }, sources: { configFile: null } };
}

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("review judge API-upload policy", () => {
  it("refuses a local API judge when synthesize_validation cannot grant upload consent", async () => {
    const repository = mkdtempSync(join(tmpdir(), "gateway-api-judge-policy-"));
    directories.push(repository);
    const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    const gateway = createGatewayServer({
      asyncJobManager: manager,
      persistence: persistence(),
      providers: providers(),
    });

    const response = await registeredTools(gateway).synthesize_validation.handler({
      question: "Judge repository evidence",
      providerResults: [
        {
          provider: "codex",
          model: "test",
          status: "completed",
          verdict: "approve",
          rationale: "No finding",
          risks: [],
          rawJobReference: null,
          error: null,
        },
      ],
      judgeModel: "ollama",
      workingDir: repository,
    });

    expect(JSON.parse(response.content[0].text)).toMatchObject({
      success: false,
      error: expect.stringMatching(/upload consent bound to an owned durable review_changes run/),
    });

    await gateway.close();
  });

  it("refuses an API judge in review_changes before repository resolution", async () => {
    type ReviewToolHandler = (args: Record<string, unknown>) => Promise<{
      structuredContent: Record<string, unknown>;
    }>;
    const handlers: Record<string, ReviewToolHandler> = {};
    const server = {
      tool(name: string, ...args: unknown[]): void {
        handlers[name] = args.at(-1) as ReviewToolHandler;
      },
    };
    const apiProvider: ApiProviderRuntime = {
      name: "ollama",
      kind: "openai-compatible",
      apiKeyEnv: null,
      baseUrl: "http://127.0.0.1:11434/v1",
      defaultModel: "review-model",
      apiKey: "",
    };
    let resolutions = 0;

    registerValidationTools(server as never, {
      asyncJobManager: { getLimiterSnapshot: () => ({}) } as never,
      apiProviders: [apiProvider],
      reviewChangesEnabled: true,
      resolveReviewRepository: () => {
        resolutions++;
        return "/must-not-resolve";
      },
    });

    const response = await handlers.review_changes({
      workingDir: "/repository",
      workspace: undefined,
      scope: "auto",
      base: undefined,
      paths: undefined,
      stance: "standard",
      focus: undefined,
      models: ["codex"],
      judgeModel: "ollama",
      allowApiUpload: false,
      maxArtifactBytes: 120_000,
      maxPromptBytes: 128_000,
    });

    expect(resolutions).toBe(0);
    expect(response.structuredContent).toMatchObject({
      success: false,
      tool: "review_changes",
      providers: ["ollama"],
    });
  });

  it("refuses an API judge plan when durable consent binding is unavailable", async () => {
    type ReviewToolHandler = (args: Record<string, unknown>) => Promise<{
      structuredContent: Record<string, unknown>;
    }>;
    const handlers: Record<string, ReviewToolHandler> = {};
    const server = {
      tool(name: string, ...args: unknown[]): void {
        handlers[name] = args.at(-1) as ReviewToolHandler;
      },
    };
    const apiProvider: ApiProviderRuntime = {
      name: "ollama",
      kind: "openai-compatible",
      apiKeyEnv: null,
      baseUrl: "http://127.0.0.1:11434/v1",
      defaultModel: "review-model",
      apiKey: "",
    };
    let resolutions = 0;

    registerValidationTools(server as never, {
      asyncJobManager: { getLimiterSnapshot: () => ({}) } as never,
      apiProviders: [apiProvider],
      reviewChangesEnabled: true,
      resolveReviewRepository: () => {
        resolutions++;
        return "/must-not-resolve";
      },
    });

    const response = await handlers.review_changes({
      workingDir: "/repository",
      workspace: undefined,
      scope: "auto",
      base: undefined,
      paths: undefined,
      stance: "standard",
      focus: undefined,
      models: ["codex"],
      judgeModel: "ollama",
      allowApiUpload: true,
      maxArtifactBytes: 120_000,
      maxPromptBytes: 128_000,
    });

    expect(resolutions).toBe(0);
    expect(response.structuredContent).toMatchObject({
      success: false,
      tool: "review_changes",
      providers: ["ollama"],
      error: expect.stringMatching(/durable validation-run storage/),
    });
  });

  it("executes an accepted API judge only with its durable owner-scoped consent", async () => {
    const repository = mkdtempSync(join(tmpdir(), "gateway-api-judge-bound-"));
    directories.push(repository);
    execFileSync("git", ["init", "-b", "main"], { cwd: repository, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "review@example.invalid"], {
      cwd: repository,
    });
    execFileSync("git", ["config", "user.name", "Review Test"], { cwd: repository });
    writeFileSync(join(repository, "review.txt"), "before\n");
    execFileSync("git", ["add", "review.txt"], { cwd: repository });
    execFileSync("git", ["commit", "-m", "seed"], { cwd: repository, stdio: "ignore" });
    writeFileSync(join(repository, "review.txt"), "after\n");

    type ReviewToolHandler = (args: Record<string, unknown>) => Promise<{
      structuredContent: Record<string, any>;
    }>;
    const handlers: Record<string, ReviewToolHandler> = {};
    const server = {
      tool(name: string, ...args: unknown[]): void {
        handlers[name] = args.at(-1) as ReviewToolHandler;
      },
    };
    const apiProvider: ApiProviderRuntime = {
      name: "ollama",
      kind: "openai-compatible",
      apiKeyEnv: null,
      baseUrl: "http://127.0.0.1:11434/v1",
      defaultModel: "review-model",
      apiKey: "",
    };
    let sequence = 0;
    let store: SqliteJobStore;
    const httpStarts: Array<Record<string, unknown>> = [];
    const completedJobs = new Map<string, Record<string, unknown>>();
    const repositorySelections: Array<Record<string, unknown>> = [];
    const snapshot = (cli: string, correlationId: string) => ({
      id: `job-${++sequence}`,
      cli,
      status: "running" as const,
      startedAt: new Date(0).toISOString(),
      finishedAt: null,
      exitCode: null,
      correlationId,
      outputTruncated: false,
      stdoutBytes: 0,
      stderrBytes: 0,
      error: null,
      exited: false,
      progress: {
        capability: "structured" as const,
        lastActivityAt: new Date(0).toISOString(),
        lastSeq: 0,
        droppedCount: 0,
        events: [],
      },
    });
    const manager = {
      getLimiterSnapshot: () => ({ running: 0, queued: 0 }),
      startJobWithDedup(
        cli: string,
        _args: string[],
        correlationId: string,
        options: Record<string, any>
      ) {
        const prepared = snapshot(cli, correlationId);
        if (options.validationAdmission) {
          const admission = options.validationAdmission as {
            validationId: string;
            provider: string;
          };
          const existing = store.getValidationRun(admission.validationId)!;
          store.setValidationProviderLinks(admission.validationId, [
            ...existing.providerLinks,
            { provider: admission.provider, jobId: prepared.id, correlationId },
          ]);
        }
        completedJobs.set(prepared.id, {
          ...prepared,
          status: "completed",
          exitCode: 0,
          finishedAt: new Date(1).toISOString(),
          stdout: "Verdict: approve\nNo finding",
          stderr: "",
          stdoutBytes: 27,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutOffsetChars: 0,
          stdoutTotalChars: 27,
          stdoutNextOffsetChars: null,
          stderrOffsetChars: 0,
          stderrTotalChars: 0,
          stderrNextOffsetChars: null,
        });
        return {
          snapshot: { ...prepared, status: options.deferLaunch ? "queued" : "running" },
          deduped: false,
          ...(options.deferLaunch
            ? { deferredLaunch: { release: () => undefined, cancel: () => true } }
            : {}),
        };
      },
      startHttpJob(input: Record<string, any>) {
        httpStarts.push(input);
        const prepared = snapshot("ollama", input.correlationId);
        if (input.validationAdmission?.role === "judge") {
          store.setValidationJudgeLink(input.validationAdmission.validationId, {
            provider: input.validationAdmission.provider,
            jobId: prepared.id,
            correlationId: prepared.correlationId,
          });
        }
        return {
          snapshot: { ...prepared, status: input.deferLaunch ? "queued" : "running" },
          deduped: false,
          ...(input.deferLaunch
            ? { deferredLaunch: { release: () => undefined, cancel: () => true } }
            : {}),
        };
      },
      getJobResult: (jobId: string) => completedJobs.get(jobId) ?? null,
      getJobSnapshot: (jobId: string) => completedJobs.get(jobId) ?? null,
      getJobOwner: () => "alice",
    };
    const storeDirectory = mkdtempSync(join(tmpdir(), "gateway-api-judge-store-"));
    directories.push(storeDirectory);
    store = new SqliteJobStore(join(storeDirectory, "validation-runs.db"));
    const runtime = (provider: ValidationProvider) => ({
      provider,
      displayName: provider,
      command: provider,
      installed: true,
      version: `${provider}-test`,
      versionCommand: [provider, "--version"],
      loginStatus: "authenticated" as const,
      loginCheck: {
        method: "not_checked" as const,
        command: null,
        credentialStore: "not_checked" as const,
        detail: "test runtime",
      },
      guidance: {
        provider,
        displayName: provider,
        install: { summary: "install", commands: [] },
        login: { summary: "login", commands: [], credentialHandling: "none" },
        verification: { command: `${provider} --version`, expected: "test" },
      },
    });

    try {
      registerValidationTools(server as never, {
        asyncJobManager: manager as never,
        apiProviders: [apiProvider],
        validationRunStore: store,
        getProviderRuntimeStatus: runtime,
        reviewChangesEnabled: true,
        resolveReviewRepository: selection => {
          repositorySelections.push(selection);
          return repository;
        },
      });

      const alice = {
        transport: "http" as const,
        authKind: "oauth" as const,
        authScopes: ["mcp"],
        authPrincipal: "alice",
      };
      const bob = { ...alice, authPrincipal: "bob" };
      const kickoff = await runWithRequestContext(alice, () =>
        handlers.review_changes({
          workingDir: undefined,
          workspace: "review",
          scope: "uncommitted",
          base: undefined,
          paths: undefined,
          stance: "standard",
          focus: undefined,
          models: ["codex"],
          judgeModel: "ollama",
          allowApiUpload: true,
          maxArtifactBytes: 120_000,
          maxPromptBytes: 128_000,
        })
      );
      expect(kickoff.structuredContent.success).toBe(true);
      const validationId = kickoff.structuredContent.report.validationId as string;
      const storedRun = store.getValidationRun(validationId)!;
      expect(JSON.parse(storedRun.requestJson)).toMatchObject({
        reviewAuthorization: {
          schemaVersion: "review-run-authorization.v1",
          repositoryPath: repository,
          repositoryRoot: repository,
          judgeProvider: "ollama",
          allowApiUpload: true,
        },
      });
      expect(storedRun.providerLinks).toHaveLength(1);
      expect(store.getValidationRunIdByJobId(storedRun.providerLinks[0].jobId)).toBe(validationId);

      const judgeInput = {
        question: "Judge the completed review",
        providerResults: [
          {
            provider: "codex",
            model: "test",
            status: "completed",
            verdict: "approve",
            rationale: "No finding",
            risks: [],
            rawJobReference: null,
            error: null,
          },
        ],
        validationId,
        workspace: "review",
      };
      store.recordValidationRun({
        validationId: "review-without-consent",
        ownerPrincipal: "alice",
        intent: "review",
        createdAt: new Date(0).toISOString(),
        requestJson: JSON.stringify({
          question: "Review without consent",
          modelList: ["codex"],
          judgeProvider: "ollama",
          reviewAuthorization: {
            schemaVersion: "review-run-authorization.v1",
            repositoryPath: repository,
            repositoryRoot: repository,
            judgeProvider: "ollama",
            allowApiUpload: false,
          },
        }),
        providerLinks: [],
        judgeLink: null,
        status: "running",
      });
      const spoofedConsent = await runWithRequestContext(alice, () =>
        handlers.synthesize_validation({
          ...judgeInput,
          validationId: "review-without-consent",
          judgeModel: "ollama",
          allowApiUpload: true,
        })
      );
      expect(spoofedConsent.structuredContent).toMatchObject({ success: false });
      expect(httpStarts).toHaveLength(0);

      const spoofedJudge = await runWithRequestContext(alice, () =>
        handlers.synthesize_validation({ ...judgeInput, judgeModel: "codex" })
      );
      expect(spoofedJudge.structuredContent).toMatchObject({ success: false });
      expect(httpStarts).toHaveLength(0);

      const foreign = await runWithRequestContext(bob, () =>
        handlers.synthesize_validation({
          ...judgeInput,
          judgeModel: "ollama",
          allowApiUpload: true,
        })
      );
      expect(foreign.structuredContent).toMatchObject({ success: false });
      expect(httpStarts).toHaveLength(0);

      const accepted = await runWithRequestContext(alice, () =>
        handlers.synthesize_validation({
          ...judgeInput,
          judgeModel: "ollama",
          allowApiUpload: false,
        })
      );
      expect(accepted.structuredContent).toMatchObject({
        success: true,
        synthesis: { status: "running", judgeModel: "ollama" },
      });
      expect(httpStarts).toHaveLength(1);
      expect(repositorySelections.at(-1)).toMatchObject({
        providers: ["ollama"],
        allowApiUpload: true,
      });
    } finally {
      store.close();
    }
  });
});
