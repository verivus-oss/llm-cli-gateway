import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AsyncJobResult, AsyncJobSnapshot } from "../async-job-manager.js";
import { SqliteJobStore } from "../job-store.js";
import type { ProviderRuntimeStatus } from "../provider-status.js";
import { runWithRequestContext } from "../request-context.js";
import type { ValidationProvider } from "../validation-normalizer.js";
import { registerValidationTools } from "../validation-tools.js";

type ToolResponse = { structuredContent: Record<string, any> };
type ToolHandler = (args: Record<string, any>) => Promise<ToolResponse>;

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

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
  const repository = mkdtempSync(path.join(tmpdir(), "review-cursor-consent-"));
  directories.push(repository);
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.email", "review@example.invalid");
  git(repository, "config", "user.name", "Review Test");
  writeFileSync(path.join(repository, "tracked.txt"), "before\n");
  git(repository, "add", "tracked.txt");
  git(repository, "commit", "-m", "seed");
  writeFileSync(path.join(repository, "tracked.txt"), "after\n");
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

function snapshot(cli: ValidationProvider, id: string, correlationId: string): AsyncJobSnapshot {
  return {
    id,
    cli,
    status: "queued",
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

function terminalResult(
  cli: ValidationProvider,
  id: string,
  correlationId: string
): AsyncJobResult {
  const stdout = `${cli} durable review evidence`;
  return {
    ...snapshot(cli, id, correlationId),
    status: "completed",
    finishedAt: new Date(1).toISOString(),
    exitCode: 0,
    exited: true,
    stdout,
    stderr: "",
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutOffsetChars: 0,
    stdoutTotalChars: stdout.length,
    stdoutNextOffsetChars: null,
    stderrOffsetChars: 0,
    stderrTotalChars: 0,
    stderrNextOffsetChars: null,
  };
}

function asPrincipal<T>(principal: string, operation: () => T): T {
  return runWithRequestContext(
    {
      transport: "http",
      authKind: "oauth",
      authScopes: ["mcp"],
      authPrincipal: principal,
    },
    operation
  );
}

function harness() {
  const repository = repositoryWithChanges();
  const stateDirectory = mkdtempSync(path.join(tmpdir(), "review-cursor-consent-store-"));
  directories.push(stateDirectory);
  const store = new SqliteJobStore(path.join(stateDirectory, "jobs.db"));
  const handlers: Record<string, ToolHandler> = {};
  const starts: Array<{
    cli: ValidationProvider;
    args: string[];
    validationId: string;
    role: string;
  }> = [];
  const results = new Map<string, AsyncJobResult>();
  const server = {
    tool(name: string, ...args: unknown[]): void {
      handlers[name] = args.at(-1) as ToolHandler;
    },
  };
  const manager = {
    getLimiterSnapshot: () => ({ running: 0, queued: 0 }),
    getJobOwner: (jobId: string) => (results.has(jobId) ? "alice" : null),
    getJobResult: (jobId: string) => results.get(jobId) ?? null,
    getJobSnapshot: () => null,
    startJobWithDedup(
      cli: ValidationProvider,
      args: string[],
      correlationId: string,
      options: {
        validationAdmission: {
          validationId: string;
          provider: ValidationProvider;
          role?: "provider" | "judge";
        };
      }
    ) {
      const admission = options.validationAdmission;
      const role = admission.role ?? "provider";
      const id = role === "judge" ? "job-cursor-judge" : `job-${cli}-reviewer`;
      starts.push({ cli, args, validationId: admission.validationId, role });
      const jobSnapshot = snapshot(cli, id, correlationId);
      if (role === "judge") {
        store.setValidationJudgeLink(admission.validationId, {
          provider: cli,
          jobId: id,
          correlationId,
        });
      } else {
        const run = store.getValidationRun(admission.validationId)!;
        store.setValidationProviderLinks(admission.validationId, [
          ...run.providerLinks,
          { provider: cli, jobId: id, correlationId },
        ]);
        results.set(id, terminalResult(cli, id, correlationId));
      }
      return {
        snapshot: jobSnapshot,
        deduped: false,
        deferredLaunch: { release: () => undefined, cancel: () => true },
      };
    },
    cancelJob: () => ({ canceled: true }),
  };

  registerValidationTools(server as never, {
    asyncJobManager: manager as never,
    getProviderRuntimeStatus: runtime,
    reviewChangesEnabled: true,
    validationRunStore: store,
    resolveReviewRepository: () => repository,
    isProviderWorkspacePath: () => false,
  });

  async function kickoff(trustCursorWorkspace: boolean) {
    return asPrincipal("alice", () =>
      handlers.review_changes({
        workingDir: repository,
        workspace: undefined,
        trustCursorWorkspace,
        scope: "uncommitted",
        base: undefined,
        paths: undefined,
        stance: "adversarial",
        focus: "Check durable cursor consent",
        models: ["codex"],
        judgeModel: "cursor",
        allowApiUpload: false,
        maxArtifactBytes: 120_000,
        maxPromptBytes: 128_000,
      })
    );
  }

  async function synthesize(validationId: string, principal = "alice") {
    return asPrincipal(principal, () =>
      handlers.synthesize_validation({
        validationId,
        workingDir: repository,
        workspace: undefined,
        judgeModel: "cursor",
        providerResults: [],
      })
    );
  }

  return { handlers, kickoff, repository, starts, store, synthesize };
}

describe("durable cursor trust consent across review tool calls", () => {
  it("persists consent at review_changes and replays it for the planned cursor judge", async () => {
    const { kickoff, starts, store, synthesize } = harness();
    const kickoffResponse = await kickoff(true);
    expect(kickoffResponse.structuredContent).toMatchObject({ success: true });
    const validationId = kickoffResponse.structuredContent.report.validationId as string;
    const storedRequest = JSON.parse(store.getValidationRun(validationId)!.requestJson);

    expect(storedRequest.reviewAuthorization.trustCursorWorkspace).toBe(true);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ cli: "codex", role: "provider", validationId });

    const crossPrincipal = await synthesize(validationId, "mallory");
    expect(crossPrincipal.structuredContent).toMatchObject({
      success: false,
      error: "The validationId does not identify an owned review_changes run",
    });
    expect(starts).toHaveLength(1);

    const synthesisResponse = await synthesize(validationId);
    expect(synthesisResponse.structuredContent).toMatchObject({
      success: true,
      synthesis: { status: "running", judgeModel: "cursor" },
    });
    expect(starts).toHaveLength(2);
    expect(starts[1]).toMatchObject({ cli: "cursor", role: "judge", validationId });
    expect(starts[1].args).toContain("--trust");
  });

  it("persists false consent and skips the unregistered cursor judge", async () => {
    const { kickoff, starts, store, synthesize } = harness();
    const kickoffResponse = await kickoff(false);
    expect(kickoffResponse.structuredContent).toMatchObject({ success: true });
    const validationId = kickoffResponse.structuredContent.report.validationId as string;
    const storedRequest = JSON.parse(store.getValidationRun(validationId)!.requestJson);

    expect(storedRequest.reviewAuthorization.trustCursorWorkspace).toBe(false);
    const synthesisResponse = await synthesize(validationId);
    expect(synthesisResponse.structuredContent).toMatchObject({
      success: true,
      synthesis: {
        status: "skipped",
        judgeModel: "cursor",
        note: expect.stringMatching(/not a workspace registered for cursor/i),
      },
    });
    expect(starts).toHaveLength(1);
    expect(starts.some(start => start.args.includes("--trust"))).toBe(false);
  });
});
