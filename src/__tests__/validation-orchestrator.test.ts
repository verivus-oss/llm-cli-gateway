import { describe, expect, it } from "vitest";
import type { AsyncJobResult, AsyncJobSnapshot } from "../async-job-manager.js";
import type { ProviderRuntimeStatus } from "../provider-status.js";
import {
  collectValidationJobResult,
  startJudgeSynthesis,
  startValidationRun,
} from "../validation-orchestrator.js";
import type { ValidationProvider } from "../validation-normalizer.js";

// Layer 6 / U20: cross-validation partial success/failure orchestration coverage.
//
// The Layer 4 test file covers the start/skip/judge transitions. These tests
// cover the orchestrator-driven flows the MVP needs end-to-end: terminal
// success collection, terminal failure collection, and end-to-end happy paths
// where the orchestrator produces a validation report alongside the job
// references.

function runtime(
  provider: ValidationProvider,
  installed = true,
  login: ProviderRuntimeStatus["loginStatus"] = "authenticated"
): ProviderRuntimeStatus {
  return {
    provider,
    displayName: provider,
    command: provider,
    installed,
    version: installed ? `${provider}-fake` : null,
    versionCommand: [provider, "--version"],
    loginStatus: installed ? login : "not_checked",
    loginCheck: {
      method: "not_checked",
      command: null,
      credentialStore: "not_checked",
      detail: installed ? "fake runtime" : "not installed",
    },
    guidance: {
      provider,
      displayName: provider,
      install: { summary: "install", commands: [] },
      login: { summary: "login", commands: [], credentialHandling: "none" },
      verification: { command: `${provider} --version`, expected: "fake" },
    },
  };
}

type ScriptedJob = {
  status: AsyncJobResult["status"];
  stdout: string;
  stderr?: string;
  error?: string | null;
  exitCode?: number | null;
};

function makeScriptedManager(script: Partial<Record<ValidationProvider, ScriptedJob>>) {
  const startCalls: Array<{
    cli: ValidationProvider;
    args: string[];
    correlationId: string;
    stdin?: string;
  }> = [];
  const jobs = new Map<string, AsyncJobResult>();

  return {
    startCalls,
    manager: {
      startJobWithDedup(
        cli: ValidationProvider,
        args: string[],
        correlationId: string,
        options: { stdin?: string } = {}
      ): { snapshot: AsyncJobSnapshot; deduped: boolean } {
        startCalls.push({ cli, args, correlationId, stdin: options.stdin });
        const id = `job-${cli}-${startCalls.length}`;
        const planned = script[cli];
        if (!planned) {
          const snapshot: AsyncJobSnapshot = {
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
          return { snapshot, deduped: false };
        }
        const result: AsyncJobResult = {
          id,
          cli,
          status: planned.status,
          startedAt: new Date(0).toISOString(),
          finishedAt: new Date(1).toISOString(),
          exitCode: planned.exitCode ?? (planned.status === "completed" ? 0 : 1),
          correlationId,
          outputTruncated: false,
          stdoutBytes: planned.stdout.length,
          stderrBytes: (planned.stderr ?? "").length,
          error: planned.error ?? null,
          exited: true,
          stdout: planned.stdout,
          stderr: planned.stderr ?? "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
        jobs.set(id, result);
        return {
          snapshot: {
            id,
            cli,
            status: "running",
            startedAt: result.startedAt,
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
      getJobResult(jobId: string): AsyncJobResult | null {
        return jobs.get(jobId) ?? null;
      },
      getJobSnapshot(jobId: string): AsyncJobSnapshot | null {
        return jobs.get(jobId) ?? null;
      },
    },
  };
}

describe("Layer 6 validation orchestrator (U20)", () => {
  it("returns a validation report when all providers start", () => {
    const fake = makeScriptedManager({
      claude: { status: "completed", stdout: "Verdict: approve\nLooks good." },
      codex: { status: "completed", stdout: "Verdict: reject\nFound a bug." },
    });
    const report = startValidationRun(
      {
        asyncJobManager: fake.manager as any,
        getProviderRuntimeStatus: provider => runtime(provider),
      },
      {
        intent: "validate",
        question: "Is this safe?",
        providers: ["claude", "codex"],
      }
    );

    expect(report.success).toBe(true);
    expect(report.status).toBe("running");
    expect(report.report.schemaVersion).toBe("validation-report.v1");
    expect(report.report.structuredContent.modelList).toEqual(["claude", "codex"]);
    expect(report.report.structuredContent.jobIds).toEqual(["job-claude-1", "job-codex-2"]);
  });

  it("builds Cursor validation reviewer jobs with the headless print surface", () => {
    const fake = makeScriptedManager({});
    startValidationRun(
      { asyncJobManager: fake.manager as any, getProviderRuntimeStatus: runtime },
      { intent: "validate", question: "can cursor review?", providers: ["cursor"] }
    );
    expect(fake.startCalls).toHaveLength(1);
    expect(fake.startCalls[0].cli).toBe("cursor");
    expect(fake.startCalls[0].args.slice(0, 4)).toEqual(["--print", "--mode", "ask", "--sandbox"]);
    expect(fake.startCalls[0].args[4]).toBe("enabled");
    expect(fake.startCalls[0].args.at(-1)).toContain("can cursor review?");
  });

  it("uses the verified Codex stdin marker for validation prompts", () => {
    const fake = makeScriptedManager({});
    startValidationRun(
      { asyncJobManager: fake.manager as any, getProviderRuntimeStatus: runtime },
      { intent: "validate", question: "review through stdin", providers: ["codex"] }
    );

    expect(fake.startCalls).toHaveLength(1);
    expect(fake.startCalls[0]).toMatchObject({
      cli: "codex",
      args: ["exec", "--skip-git-repo-check", "--", "-"],
    });
    expect(fake.startCalls[0].stdin).toContain("review through stdin");
    expect(fake.startCalls[0].args.join(" ")).not.toContain("review through stdin");
  });

  it("skips only argv-bound reviewers whose assembled prompt exceeds the byte limit", () => {
    const fake = makeScriptedManager({});
    const report = startValidationRun(
      { asyncJobManager: fake.manager as any, getProviderRuntimeStatus: runtime },
      {
        intent: "validate",
        question: "中".repeat(44_000),
        providers: ["grok", "codex"],
      }
    );

    expect(report.status).toBe("partial");
    expect(report.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "grok",
          status: "skipped",
          error: expect.stringContaining("too large"),
        }),
        expect.objectContaining({ provider: "codex", status: "running" }),
      ])
    );
    expect(fake.startCalls.map(call => call.cli)).toEqual(["codex"]);
    expect(fake.startCalls[0].stdin).toContain("中".repeat(100));
  });

  it("normalizes a completed provider result with a verdict heading", () => {
    const fake = makeScriptedManager({
      claude: {
        status: "completed",
        stdout: "Verdict: approve\nRationale: looks good.\n- Risk: depends on cache hit rate",
      },
    });
    const run = startValidationRun(
      {
        asyncJobManager: fake.manager as any,
        getProviderRuntimeStatus: provider => runtime(provider),
      },
      { intent: "validate", question: "?", providers: ["claude"] }
    );
    const normalized = collectValidationJobResult(
      { asyncJobManager: fake.manager as any },
      "claude",
      run.results[0].rawJobReference!.jobId,
      "claude-fake"
    );

    expect(normalized).not.toBeNull();
    expect(normalized!.status).toBe("completed");
    expect(normalized!.verdict).toBe("approve");
    expect(normalized!.rationale).toContain("looks good");
    expect(normalized!.risks.some(r => /risk/i.test(r))).toBe(true);
  });

  it("normalizes a failed provider result with its stderr surfaced as error", () => {
    const fake = makeScriptedManager({
      codex: {
        status: "failed",
        stdout: "",
        stderr: "auth required",
        exitCode: 1,
      },
    });
    const run = startValidationRun(
      {
        asyncJobManager: fake.manager as any,
        getProviderRuntimeStatus: provider => runtime(provider),
      },
      { intent: "validate", question: "?", providers: ["codex"] }
    );
    const normalized = collectValidationJobResult(
      { asyncJobManager: fake.manager as any },
      "codex",
      run.results[0].rawJobReference!.jobId,
      "codex-fake"
    );

    expect(normalized).not.toBeNull();
    expect(normalized!.status).toBe("failed");
    expect(normalized!.verdict).toBe("failed");
    expect(normalized!.error).toBe("auth required");
  });

  it("partial success: one provider missing, others started successfully", () => {
    const fake = makeScriptedManager({
      claude: { status: "completed", stdout: "Verdict: approve" },
    });
    const report = startValidationRun(
      {
        asyncJobManager: fake.manager as any,
        getProviderRuntimeStatus: provider => runtime(provider, provider === "claude"),
      },
      {
        intent: "validate",
        question: "Is this connected?",
        providers: ["claude", "gemini"],
      }
    );

    expect(report.status).toBe("partial");
    expect(report.results).toHaveLength(2);
    const skipped = report.results.find(r => r.provider === "gemini");
    expect(skipped?.status).toBe("skipped");
    expect(skipped?.error).toContain("not installed");
    const started = report.results.find(r => r.provider === "claude");
    expect(started?.status).toBe("running");
    expect(started?.rawJobReference).not.toBeNull();
  });

  it("treats all-missing providers as not_started", () => {
    const fake = makeScriptedManager({});
    const report = startValidationRun(
      {
        asyncJobManager: fake.manager as any,
        getProviderRuntimeStatus: provider => runtime(provider, false),
      },
      { intent: "validate", question: "?", providers: ["claude", "codex"] }
    );

    expect(report.success).toBe(false);
    expect(report.status).toBe("not_started");
    expect(report.results.every(r => r.status === "skipped")).toBe(true);
    expect(fake.startCalls).toHaveLength(0);
  });

  it("warns when a started provider's login status is not authenticated", () => {
    const fake = makeScriptedManager({
      gemini: { status: "completed", stdout: "Verdict: approve" },
    });
    const report = startValidationRun(
      {
        asyncJobManager: fake.manager as any,
        getProviderRuntimeStatus: provider => runtime(provider, true, "not_authenticated"),
      },
      { intent: "validate", question: "?", providers: ["gemini"] }
    );
    expect(report.results[0].warning).toBeDefined();
    expect(report.results[0].warning).toMatch(/login/i);
  });

  it("judge synthesis runs once all provider results are terminal and at least one completed", () => {
    const fake = makeScriptedManager({
      claude: { status: "completed", stdout: "Verdict: approve\nRationale: looks fine." },
      codex: { status: "completed", stdout: "Verdict: approve" },
      gemini: { status: "completed", stdout: "Verdict: approve" },
    });
    const run = startValidationRun(
      {
        asyncJobManager: fake.manager as any,
        getProviderRuntimeStatus: provider => runtime(provider),
      },
      {
        intent: "validate",
        question: "Is this connected?",
        providers: ["claude", "codex"],
        judgeProvider: "gemini",
      }
    );

    expect(run.synthesis.status).toBe("waiting_for_provider_results");

    const collected = run.results.map(result =>
      collectValidationJobResult(
        { asyncJobManager: fake.manager as any },
        result.provider,
        result.rawJobReference!.jobId,
        result.provider
      )!
    );
    const synthesis = startJudgeSynthesis(
      {
        asyncJobManager: fake.manager as any,
        getProviderRuntimeStatus: provider => runtime(provider),
      },
      { question: "Is this connected?", providerResults: collected, judgeProvider: "gemini" }
    );
    expect(synthesis.status).toBe("running");
    expect(synthesis.judgeModel).toBe("gemini");
    expect(synthesis.rawJobReference?.statusTool).toBe("job_status");
    expect(fake.startCalls.at(-1)?.cli).toBe("gemini");
  });

  it("judge synthesis is skipped when the chosen judge runtime is missing", () => {
    const fake = makeScriptedManager({});
    const synthesis = startJudgeSynthesis(
      {
        asyncJobManager: fake.manager as any,
        getProviderRuntimeStatus: provider => runtime(provider, provider !== "grok"),
      },
      {
        question: "?",
        providerResults: [
          {
            provider: "claude",
            model: "claude-fake",
            status: "completed",
            verdict: "approve",
            rationale: "ok",
            risks: [],
            rawJobReference: {
              jobId: "job-claude-1",
              correlationId: "corr",
              statusTool: "job_status",
              resultTool: "job_result",
            },
            error: null,
          },
        ],
        judgeProvider: "grok",
      }
    );
    expect(synthesis.status).toBe("skipped");
    expect(synthesis.note).toMatch(/not installed/i);
    expect(fake.startCalls).toHaveLength(0);
  });

  it("returns null when collecting a job_result that does not exist", () => {
    const fake = makeScriptedManager({});
    const normalized = collectValidationJobResult(
      { asyncJobManager: fake.manager as any },
      "claude",
      "missing-job",
      null
    );
    expect(normalized).toBeNull();
  });
});
