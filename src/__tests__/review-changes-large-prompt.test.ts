import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { AsyncJobSnapshot } from "../async-job-manager.js";
import { defaultLeastCostConfig } from "../config.js";
import { registerValidationTools } from "../validation-tools.js";
import type { ValidationProvider } from "../validation-normalizer.js";

interface StartCall {
  cli: string;
  args: string[];
  cwd?: string;
  stdin?: string;
  persistedArgs?: string[];
  payloadJson?: string;
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
}

function snapshot(id: string, cli: string, correlationId: string): AsyncJobSnapshot {
  return {
    id,
    cli,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    correlationId,
    outputTruncated: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    error: null,
    exited: false,
  };
}

const installed = (provider: ValidationProvider) =>
  ({
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
      detail: "",
    },
    guidance: {
      provider,
      displayName: provider,
      install: { summary: "", commands: [] },
      login: { summary: "", commands: [], credentialHandling: "none" },
      verification: { command: "", expected: "" },
    },
  }) as never;

describe("review_changes large prompt transport", () => {
  const repositories: string[] = [];

  afterEach(() => {
    for (const repository of repositories.splice(0)) {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it("cancels an admitted stdin reviewer when a later argv reviewer is too large", async () => {
    const repository = mkdtempSync(path.join(tmpdir(), "gateway-review-large-"));
    repositories.push(repository);
    runGit(repository, ["init", "-q"]);
    runGit(repository, ["config", "user.name", "Gateway Test"]);
    runGit(repository, ["config", "user.email", "gateway-test@example.invalid"]);
    writeFileSync(path.join(repository, "README.md"), "baseline\n");
    runGit(repository, ["add", "README.md"]);
    runGit(repository, ["commit", "-qm", "baseline"]);
    writeFileSync(path.join(repository, "large-review.txt"), "中".repeat(44_000));

    const calls: StartCall[] = [];
    let storedRun: Record<string, any> | null = null;
    let released = 0;
    let canceled = 0;
    const handlers = new Map<string, (args: never) => Promise<Record<string, any>>>();
    const server = {
      tool(
        name: string,
        _description: string,
        _schema: unknown,
        _annotations: unknown,
        handler: (args: never) => Promise<Record<string, any>>
      ): void {
        handlers.set(name, handler);
      },
    };
    const manager = {
      startJobWithDedup(
        cli: string,
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
        calls.push({ cli, args, ...options });
        const prepared = snapshot(`job-${calls.length}`, cli, correlationId);
        storedRun!.providerLinks.push({
          provider: options.validationAdmission!.provider,
          jobId: prepared.id,
          correlationId,
        });
        return {
          snapshot: { ...prepared, status: "queued" },
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
      getLimiterSnapshot(): Record<string, never> {
        return {};
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
      getProviderRuntimeStatus: installed,
      leastCost: defaultLeastCostConfig(),
      resolveReviewRepository: () => repository,
      reviewChangesEnabled: true,
      validationRunStore: validationRunStore as never,
    });

    const response = await handlers.get("review_changes")!({
      workingDir: repository,
      scope: "uncommitted",
      stance: "standard",
      models: ["codex", "grok"],
      maxArtifactBytes: 512_000,
      maxPromptBytes: 512_000,
    } as never);

    expect(response.structuredContent).toMatchObject({
      success: false,
      errorCategory: "input_too_large",
      retryable: false,
    });
    expect(calls).toHaveLength(1);
    expect(released).toBe(0);
    expect(canceled).toBe(1);
    expect(storedRun?.status).toBe("admission_failed");
    expect(calls[0]).toMatchObject({
      cli: "codex",
      cwd: repository,
      args: ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--", "-"],
    });
    expect(calls[0].stdin).toContain("large-review.txt");
    expect(calls[0].stdin).toContain("中".repeat(100));
    expect(calls[0].args.join(" ")).not.toContain("中");
    expect(calls[0].persistedArgs?.join(" ")).not.toContain("中");
    expect(calls[0].payloadJson).toContain("中".repeat(100));
  });
});
