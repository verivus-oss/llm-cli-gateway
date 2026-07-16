import { describe, expect, it } from "vitest";
import type { AsyncJobSnapshot } from "../async-job-manager.js";
import type { ApiProviderRuntime } from "../config.js";
import type { ProviderRuntimeStatus } from "../provider-status.js";
import type { ValidationProvider } from "../validation-normalizer.js";
import {
  ReviewRunAuthorizationError,
  startReviewRun,
  ValidationRunPersistenceError,
} from "../validation-orchestrator.js";

interface CliStartCall {
  cli: ValidationProvider;
  args: string[];
  correlationId: string;
  cwd?: string;
  stdin?: string;
  persistedArgs?: string[];
  payloadJson?: string;
}

interface HttpStartCall {
  correlationId?: string;
  deferLaunch?: boolean;
  validationAdmission?: { validationId: string; provider: string };
  writeFlightStart?: boolean;
  flightRecorderEntry?: unknown;
  apiRequest: { messages: Array<{ content: string }> };
}

function snapshot(id: string, cli: string, correlationId: string): AsyncJobSnapshot {
  return {
    id,
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
    progress: {
      capability: "activity_only",
      lastActivityAt: new Date(0).toISOString(),
      lastSeq: 0,
      droppedCount: 0,
      events: [],
    },
  };
}

function runtime(provider: ValidationProvider): ProviderRuntimeStatus {
  return {
    provider,
    displayName: provider,
    command: provider,
    installed: true,
    version: `${provider}-test`,
    versionCommand: [provider, "--version"],
    loginStatus: "authenticated",
    loginCheck: {
      method: "not_checked",
      command: null,
      credentialStore: "not_checked",
      detail: "test runtime",
    },
    guidance: {
      provider,
      displayName: provider,
      install: { summary: "install", commands: [] },
      login: { summary: "login", commands: [], credentialHandling: "none" },
      verification: { command: `${provider} --version`, expected: "test" },
    },
  };
}

function makeManager(): {
  calls: CliStartCall[];
  httpCalls: HttpStartCall[];
  manager: Record<string, unknown>;
  validationRunStore: Record<string, unknown>;
} {
  const calls: CliStartCall[] = [];
  const httpCalls: HttpStartCall[] = [];
  let storedRun: Record<string, any> | null = null;
  const validationRunStore = {
    recordValidationRun(run: Record<string, any>): void {
      storedRun = structuredClone(run);
    },
    getValidationRun(): Record<string, any> | null {
      return storedRun ? structuredClone(storedRun) : null;
    },
    transitionValidationRunStatus(
      _id: string,
      _owner: string,
      expected: string,
      status: string
    ): boolean {
      if (!storedRun || storedRun.status !== expected) return false;
      storedRun.status = status;
      return true;
    },
    skipValidationJudge(): void {
      if (storedRun) storedRun.status = "judge_skipped";
    },
  };
  const admit = (
    admission: { provider: string } | undefined,
    jobId: string,
    correlationId: string
  ): void => {
    if (!admission || !storedRun) return;
    storedRun.providerLinks.push({ provider: admission.provider, jobId, correlationId });
  };
  return {
    calls,
    httpCalls,
    validationRunStore,
    manager: {
      startJobWithDedup(
        cli: ValidationProvider,
        args: string[],
        correlationId: string,
        options: {
          cwd?: string;
          stdin?: string;
          persistedArgs?: string[];
          payloadJson?: string;
          deferLaunch?: boolean;
          validationAdmission?: { provider: string };
        }
      ): { snapshot: AsyncJobSnapshot; deduped: boolean } {
        calls.push({ cli, args, correlationId, ...options });
        admit(options.validationAdmission, `job-${cli}`, correlationId);
        return {
          snapshot: {
            ...snapshot(`job-${cli}`, cli, correlationId),
            status: options.deferLaunch ? "queued" : "running",
          },
          deduped: false,
          ...(options.deferLaunch
            ? { deferredLaunch: { release: () => undefined, cancel: () => true } }
            : {}),
        };
      },
      startHttpJob(params: HttpStartCall): {
        snapshot: AsyncJobSnapshot;
        deduped: boolean;
      } {
        httpCalls.push(params);
        const correlationId = params.correlationId ?? "review-api";
        admit(params.validationAdmission, "job-api", correlationId);
        return {
          snapshot: {
            ...snapshot("job-api", "ollama", correlationId),
            status: params.deferLaunch ? "queued" : "running",
          },
          deduped: false,
          ...(params.deferLaunch
            ? { deferredLaunch: { release: () => undefined, cancel: () => true } }
            : {}),
        };
      },
    },
  };
}

function callFor(calls: CliStartCall[], provider: ValidationProvider): CliStartCall {
  const call = calls.find(candidate => candidate.cli === provider);
  if (!call) throw new Error(`Missing ${provider} review call`);
  return call;
}

describe("repository review integration", () => {
  it("rejects a Git root outside the caller-authorized repository path before dispatch", () => {
    const fake = makeManager();

    expect(() =>
      startReviewRun(
        {
          asyncJobManager: fake.manager as never,
          getProviderRuntimeStatus: runtime,
          validationRunStore: fake.validationRunStore as never,
        },
        {
          prompt: "FENCED REVIEW EVIDENCE",
          providers: ["claude"],
          cwd: "/workspace/repository",
          artifactSha256: "a".repeat(64),
          artifactByteLength: 22,
          scope: "branch",
          reviewAuthorization: {
            schemaVersion: "review-run-authorization.v1",
            repositoryPath: "/workspace/repository/nested-folder",
            repositoryRoot: "/workspace/repository",
            judgeProvider: null,
            allowApiUpload: false,
          },
        }
      )
    ).toThrow(ReviewRunAuthorizationError);
    expect(fake.calls).toHaveLength(0);
  });

  it("uses provider-native read-only review argv in the authorized repository", () => {
    const fake = makeManager();
    const providers: ValidationProvider[] = [
      "claude",
      "codex",
      "gemini",
      "grok",
      "mistral",
      "devin",
      "cursor",
    ];
    const prompt = "FENCED REVIEW EVIDENCE";

    const report = startReviewRun(
      {
        asyncJobManager: fake.manager as never,
        getProviderRuntimeStatus: runtime,
        validationRunStore: fake.validationRunStore as never,
      },
      {
        prompt,
        providers,
        cwd: "/authorized/repository",
        artifactSha256: "a".repeat(64),
        artifactByteLength: Buffer.byteLength(prompt),
        scope: "branch",
        reviewAuthorization: {
          schemaVersion: "review-run-authorization.v1",
          repositoryPath: "/authorized/repository",
          repositoryRoot: "/authorized/repository",
          judgeProvider: null,
          allowApiUpload: false,
        },
      }
    );

    expect(report.success).toBe(true);
    expect(fake.calls).toHaveLength(providers.length);
    expect(fake.calls.every(call => call.cwd === "/authorized/repository")).toBe(true);
    expect(callFor(fake.calls, "claude").args).toEqual([
      "-p",
      "--permission-mode",
      "plan",
      "--",
      prompt,
    ]);
    expect(callFor(fake.calls, "codex")).toMatchObject({
      args: ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--", "-"],
      stdin: prompt,
    });
    expect(callFor(fake.calls, "gemini").args).toEqual([
      "--print",
      "--mode",
      "plan",
      "--sandbox",
      prompt,
    ]);
    expect(callFor(fake.calls, "grok").args).toEqual([`-p=${prompt}`, "--permission-mode", "plan"]);
    expect(callFor(fake.calls, "mistral").args).toEqual([`-p=${prompt}`, "--agent", "plan"]);
    expect(callFor(fake.calls, "devin").args).toEqual([
      "-p",
      "--permission-mode",
      "auto",
      "--sandbox",
      "--",
      prompt,
    ]);
    expect(callFor(fake.calls, "cursor").args).toEqual([
      "--print",
      "--mode",
      "plan",
      "--sandbox",
      "enabled",
      "--",
      prompt,
    ]);
    for (const call of fake.calls) {
      expect(call.payloadJson).toBeTypeOf("string");
      expect(JSON.parse(call.payloadJson!)).toMatchObject({
        schemaVersion: "review-job-input.v1",
        prompt,
      });
      expect(JSON.stringify(call.persistedArgs)).not.toContain(prompt);
    }
  });

  it("keeps API review evidence out of the non-expiring flight recorder", () => {
    const fake = makeManager();
    const apiProvider: ApiProviderRuntime = {
      name: "ollama",
      kind: "openai-compatible",
      apiKeyEnv: null,
      baseUrl: "http://127.0.0.1:11434/v1",
      defaultModel: "review-model",
      apiKey: "",
    };
    const prompt = "PERSIST ONLY WITH JOB RETENTION";

    startReviewRun(
      {
        asyncJobManager: fake.manager as never,
        apiProviders: [apiProvider],
        validationRunStore: fake.validationRunStore as never,
      },
      {
        prompt,
        providers: ["ollama"],
        cwd: "/authorized/repository",
        artifactSha256: "b".repeat(64),
        artifactByteLength: Buffer.byteLength(prompt),
        scope: "uncommitted",
        reviewAuthorization: {
          schemaVersion: "review-run-authorization.v1",
          repositoryPath: "/authorized/repository",
          repositoryRoot: "/authorized/repository",
          judgeProvider: null,
          allowApiUpload: true,
        },
      }
    );

    expect(fake.httpCalls).toHaveLength(1);
    expect(fake.httpCalls[0].writeFlightStart).toBe(false);
    expect(fake.httpCalls[0].flightRecorderEntry).toBeUndefined();
    expect(JSON.stringify(fake.httpCalls[0].apiRequest.messages)).toContain(prompt);
  });

  it("dispatches no reviewer when durable API-judge authorization persistence fails", () => {
    const fake = makeManager();
    const apiProvider: ApiProviderRuntime = {
      name: "ollama",
      kind: "openai-compatible",
      apiKeyEnv: null,
      baseUrl: "http://127.0.0.1:11434/v1",
      defaultModel: "review-model",
      apiKey: "",
    };
    const throwingStore = {
      recordValidationRun(): never {
        throw new Error("injected persistence failure");
      },
    };

    expect(() =>
      startReviewRun(
        {
          asyncJobManager: fake.manager as never,
          apiProviders: [apiProvider],
          getProviderRuntimeStatus: runtime,
          validationRunStore: throwingStore as never,
        },
        {
          prompt: "MUST NOT DISPATCH",
          providers: ["codex"],
          cwd: "/authorized/repository",
          artifactSha256: "c".repeat(64),
          artifactByteLength: 17,
          scope: "uncommitted",
          judgeProvider: "ollama",
          reviewAuthorization: {
            schemaVersion: "review-run-authorization.v1",
            repositoryPath: "/authorized/repository",
            repositoryRoot: "/authorized/repository",
            judgeProvider: "ollama",
            allowApiUpload: true,
          },
        }
      )
    ).toThrow(ValidationRunPersistenceError);
    expect(fake.calls).toHaveLength(0);
    expect(fake.httpCalls).toHaveLength(0);
  });

  it("cancels the prepared roster without dispatch when a later atomic admission fails", () => {
    const apiProviders: ApiProviderRuntime[] = [
      {
        name: "review-api",
        kind: "openai-compatible",
        apiKeyEnv: null,
        baseUrl: "http://127.0.0.1:11434/v1",
        defaultModel: "review-model",
        apiKey: "",
      },
      {
        name: "judge-api",
        kind: "openai-compatible",
        apiKeyEnv: null,
        baseUrl: "http://127.0.0.1:11434/v1",
        defaultModel: "judge-model",
        apiKey: "",
      },
    ];
    let storedRun: Record<string, any> | null = null;
    const validationStore = {
      recordValidationRun(run: Record<string, any>): void {
        storedRun = structuredClone(run);
      },
      getValidationRun(): Record<string, any> | null {
        return storedRun ? structuredClone(storedRun) : null;
      },
      transitionValidationRunStatus(
        _id: string,
        _owner: string,
        expected: string,
        status: string
      ): boolean {
        if (!storedRun || storedRun.status !== expected) return false;
        storedRun.status = status;
        return true;
      },
    };
    let prepared = 0;
    let released = 0;
    let canceled = 0;
    const firstSnapshot = snapshot("prepared-codex", "codex", "corr-codex");
    const manager = {
      startJobWithDedup(
        _cli: string,
        _args: string[],
        _correlationId: string,
        options: Record<string, any>
      ) {
        prepared++;
        const admission = options.validationAdmission as {
          validationId: string;
          provider: string;
        };
        (storedRun!.providerLinks as Array<Record<string, unknown>>).push({
          provider: admission.provider,
          jobId: firstSnapshot.id,
          correlationId: firstSnapshot.correlationId,
        });
        return {
          snapshot: { ...firstSnapshot, status: "queued" as const },
          deduped: false,
          deferredLaunch: {
            release: () => {
              released++;
            },
            cancel: () => {
              canceled++;
              return true;
            },
          },
        };
      },
      startHttpJob(): never {
        prepared++;
        throw new Error("injected atomic provider-link admission failure");
      },
    };

    expect(() =>
      startReviewRun(
        {
          asyncJobManager: manager as never,
          apiProviders,
          getProviderRuntimeStatus: runtime,
          validationRunStore: validationStore as never,
        },
        {
          prompt: "MIXED ROSTER EVIDENCE",
          providers: ["codex", "review-api"],
          cwd: "/authorized/repository",
          artifactSha256: "d".repeat(64),
          artifactByteLength: 21,
          scope: "branch",
          judgeProvider: "judge-api",
          reviewAuthorization: {
            schemaVersion: "review-run-authorization.v1",
            repositoryPath: "/authorized/repository",
            repositoryRoot: "/authorized/repository",
            judgeProvider: "judge-api",
            allowApiUpload: true,
          },
        }
      )
    ).toThrow(/injected atomic provider-link admission failure/);
    expect(prepared).toBe(2);
    expect(released).toBe(0);
    expect(canceled).toBe(1);
    expect(storedRun?.providerLinks).toEqual([
      {
        provider: "codex",
        jobId: "prepared-codex",
        correlationId: "corr-codex",
      },
    ]);
    expect(storedRun?.status).toBe("admission_failed");
  });
});
