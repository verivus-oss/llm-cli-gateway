import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AsyncJobSnapshot } from "../async-job-manager.js";
import type { ApiProviderRuntime } from "../config.js";
import type { ProviderRuntimeStatus } from "../provider-status.js";
import type { ValidationProvider } from "../validation-normalizer.js";
import { registerValidationTools, type ReviewRepositorySelection } from "../validation-tools.js";

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  structuredContent: Record<string, unknown>;
}>;

const repositories: string[] = [];

function git(repository: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd: repository,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

function repositoryWithChanges(): string {
  const repository = mkdtempSync(path.join(tmpdir(), "gateway-review-tool-"));
  repositories.push(repository);
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.email", "review@example.invalid");
  git(repository, "config", "user.name", "Review Test");
  writeFileSync(path.join(repository, "tracked.txt"), "before\n");
  git(repository, "add", "tracked.txt");
  git(repository, "commit", "-m", "seed");
  writeFileSync(path.join(repository, "tracked.txt"), "after\n");
  writeFileSync(path.join(repository, "untracked.txt"), "sensitive untracked review bytes\n");
  return repository;
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

function snapshot(correlationId: string): AsyncJobSnapshot {
  return {
    id: "review-job",
    cli: "codex",
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
      capability: "structured",
      lastActivityAt: new Date(0).toISOString(),
      lastSeq: 1,
      droppedCount: 0,
      events: [],
    },
  };
}

afterEach(() => {
  for (const repository of repositories.splice(0)) {
    rmSync(repository, { recursive: true, force: true });
  }
});

describe("review_changes tool wiring", () => {
  it("does not advertise repository review without durable review jobs", () => {
    const handlers: Record<string, ToolHandler> = {};
    const server = {
      tool(name: string, ...args: unknown[]): void {
        handlers[name] = args.at(-1) as ToolHandler;
      },
    };

    registerValidationTools(server as never, {
      asyncJobManager: { getLimiterSnapshot: () => ({}) } as never,
      reviewChangesEnabled: false,
      resolveReviewRepository: () => "/must-not-resolve",
    });

    expect(handlers.review_changes).toBeUndefined();
  });

  it("requires explicit API upload consent before repository resolution", async () => {
    const handlers: Record<string, ToolHandler> = {};
    const server = {
      tool(name: string, ...args: unknown[]): void {
        handlers[name] = args.at(-1) as ToolHandler;
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
      models: ["ollama"],
      judgeModel: undefined,
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

  it("authorizes before capture, starts a read-only job in that repository, and returns identity", async () => {
    const repository = repositoryWithChanges();
    const handlers: Record<string, ToolHandler> = {};
    const selections: ReviewRepositorySelection[] = [];
    const starts: Array<{ args: string[]; cwd?: string; stdin?: string }> = [];
    let storedRun: Record<string, any> | null = null;
    const server = {
      tool(
        name: string,
        _description: string,
        _schema: unknown,
        _annotations: unknown,
        handler: ToolHandler
      ): void {
        handlers[name] = handler;
      },
    };
    const manager = {
      getLimiterSnapshot: () => ({ running: 0, queued: 0 }),
      startJobWithDedup(
        _cli: string,
        args: string[],
        correlationId: string,
        options: {
          cwd?: string;
          stdin?: string;
          deferLaunch?: boolean;
          validationAdmission?: { provider: string };
        }
      ): { snapshot: AsyncJobSnapshot; deduped: boolean } {
        starts.push({ args, cwd: options.cwd, stdin: options.stdin });
        const prepared = { ...snapshot(correlationId), status: "queued" as const };
        storedRun!.providerLinks.push({
          provider: options.validationAdmission!.provider,
          jobId: prepared.id,
          correlationId,
        });
        return {
          snapshot: prepared,
          deduped: false,
          deferredLaunch: { release: () => undefined, cancel: () => true },
        };
      },
    };
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
    };

    registerValidationTools(server as never, {
      asyncJobManager: manager as never,
      getProviderRuntimeStatus: runtime,
      reviewChangesEnabled: true,
      validationRunStore: validationRunStore as never,
      resolveReviewRepository: selection => {
        selections.push(selection);
        return repository;
      },
    });

    expect(handlers.review_changes).toBeTypeOf("function");
    const response = await handlers.review_changes({
      workingDir: repository,
      workspace: undefined,
      scope: "uncommitted",
      base: undefined,
      paths: undefined,
      stance: "adversarial",
      focus: "Check filesystem safety",
      models: ["codex"],
      judgeModel: undefined,
      allowApiUpload: false,
      maxArtifactBytes: 120_000,
      maxPromptBytes: 128_000,
    });

    expect(selections).toEqual([
      {
        workingDir: repository,
        workspace: undefined,
        providers: ["codex"],
        allowApiUpload: false,
      },
    ]);
    expect(starts).toHaveLength(1);
    expect(starts[0].cwd).toBe(repository);
    expect(starts[0].args).toEqual([
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--",
      "-",
    ]);
    expect(starts[0].stdin).toContain('"schemaVersion": "review-evidence.v2"');
    expect(starts[0].stdin).toContain("sensitive untracked review bytes");
    expect(starts[0].stdin).toMatch(/<<<REVIEW_EVIDENCE_[a-f0-9]{48}_BEGIN>>>/);

    expect(response.structuredContent).toMatchObject({
      success: true,
      tool: "review_changes",
      evidence: {
        schemaVersion: "review-evidence.v2",
        complete: true,
        requestedMode: "uncommitted",
        resolvedMode: "uncommitted",
        workingTreeIncluded: true,
        stance: "adversarial",
      },
      report: {
        success: true,
        intent: "review",
      },
    });
    expect(JSON.stringify(response.structuredContent)).not.toContain(
      "sensitive untracked review bytes"
    );
  });
});
