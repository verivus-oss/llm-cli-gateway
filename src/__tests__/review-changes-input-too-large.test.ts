import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultLeastCostConfig } from "../config.js";
import { SqliteJobStore } from "../job-store.js";
import { registerValidationTools } from "../validation-tools.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  structuredContent: Record<string, unknown>;
}>;

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
}

describe("review_changes oversized provider input", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns a stable non-retryable error instead of an MCP exception", async () => {
    const repository = mkdtempSync(path.join(tmpdir(), "gateway-review-input-limit-"));
    directories.push(repository);
    runGit(repository, ["init", "-q"]);
    runGit(repository, ["config", "user.name", "Gateway Test"]);
    runGit(repository, ["config", "user.email", "gateway-test@example.invalid"]);
    writeFileSync(path.join(repository, "README.md"), "baseline\n");
    runGit(repository, ["add", "README.md"]);
    runGit(repository, ["commit", "-qm", "baseline"]);
    writeFileSync(path.join(repository, "oversized.txt"), "中".repeat(44_000));

    const store = new SqliteJobStore(path.join(repository, "jobs.db"));
    const handlers = new Map<string, ToolHandler>();
    const server = {
      tool(name: string, ...args: unknown[]): void {
        handlers.set(name, args.at(-1) as ToolHandler);
      },
    };
    const manager = {
      getLimiterSnapshot: () => ({ running: 0, queued: 0 }),
      startJobWithDedup: () => {
        throw new Error("manager must not receive an argv-oversized review prompt");
      },
    };

    registerValidationTools(server as never, {
      asyncJobManager: manager as never,
      getProviderRuntimeStatus: provider =>
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
        }) as never,
      leastCost: defaultLeastCostConfig(),
      resolveReviewRepository: () => repository,
      reviewChangesEnabled: true,
      validationRunStore: store,
    });

    const response = await handlers.get("review_changes")!({
      workingDir: repository,
      scope: "uncommitted",
      stance: "standard",
      models: ["grok"],
      maxArtifactBytes: 512_000,
      maxPromptBytes: 512_000,
    });

    expect(response.structuredContent).toMatchObject({
      success: false,
      tool: "review_changes",
      errorCategory: "input_too_large",
      retryable: false,
      error: expect.stringContaining("too large"),
    });
  });
});
