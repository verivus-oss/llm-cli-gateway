import { describe, expect, it } from "vitest";
import type { AsyncJobSnapshot } from "../async-job-manager.js";
import type { ProviderRuntimeStatus } from "../provider-status.js";
import {
  collectValidationJobResult,
  startJudgeSynthesis,
  startValidationRun,
} from "../validation-orchestrator.js";
import type { NormalizedValidationResult, ValidationProvider } from "../validation-normalizer.js";

function runtime(provider: ValidationProvider, installed = true): ProviderRuntimeStatus {
  return {
    provider,
    displayName: provider,
    command: provider,
    installed,
    version: installed ? `${provider}-fake` : null,
    versionCommand: [provider, "--version"],
    loginStatus: installed ? "authenticated" : "not_checked",
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

function fakeAsyncJobManager() {
  const jobs = new Map<string, any>();
  const startCalls: Array<{ cli: ValidationProvider; args: string[]; correlationId: string }> = [];
  return {
    startCalls,
    manager: {
      startJob(cli: ValidationProvider, args: string[], correlationId: string): AsyncJobSnapshot {
        startCalls.push({ cli, args, correlationId });
        const id = `job-${cli}-${startCalls.length}`;
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
        jobs.set(id, {
          ...snapshot,
          status: "completed",
          finishedAt: new Date().toISOString(),
          exitCode: 0,
          stdout: `Verdict: ${cli} approves\nRationale: ok`,
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        });
        return snapshot;
      },
      getJobResult(jobId: string) {
        return jobs.get(jobId) ?? null;
      },
    },
  };
}

describe("Layer 4 validation orchestration", () => {
  it("fans out to multiple providers and preserves partial skipped providers", () => {
    const fake = fakeAsyncJobManager();
    const report = startValidationRun(
      {
        asyncJobManager: fake.manager as any,
        getProviderRuntimeStatus: provider => runtime(provider, provider !== "grok"),
      },
      {
        intent: "validate",
        question: "Is this connected?",
        providers: ["claude", "codex", "grok"],
      }
    );

    expect(report.status).toBe("partial");
    expect(fake.startCalls.map(call => call.cli)).toEqual(["claude", "codex"]);
    expect(report.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "claude",
          status: "running",
          verdict: "pending",
          rawJobReference: expect.objectContaining({ resultTool: "job_result" }),
        }),
        expect.objectContaining({
          provider: "grok",
          status: "skipped",
          error: "grok runtime is not installed.",
        }),
      ])
    );
  });

  it("keeps judge synthesis waiting until provider jobs are terminal", () => {
    const fake = fakeAsyncJobManager();
    const pending: NormalizedValidationResult = {
      provider: "claude",
      model: "claude-fake",
      status: "running",
      verdict: "pending",
      rationale: "Provider job is running asynchronously.",
      risks: [],
      rawJobReference: {
        jobId: "job-claude-1",
        correlationId: "validation-x-claude",
        statusTool: "job_status",
        resultTool: "job_result",
      },
      error: null,
    };

    const synthesis = startJudgeSynthesis(
      {
        asyncJobManager: fake.manager as any,
        getProviderRuntimeStatus: provider => runtime(provider),
      },
      {
        question: "Is this connected?",
        providerResults: [pending],
        judgeProvider: "codex",
      }
    );

    expect(synthesis.status).toBe("waiting_for_provider_results");
    expect(synthesis.rawJobReference).toBeNull();
    expect(fake.startCalls).toHaveLength(0);
  });

  it("skips judge synthesis when no completed provider results are available", () => {
    const fake = fakeAsyncJobManager();
    const skipped: NormalizedValidationResult = {
      provider: "grok",
      model: null,
      status: "skipped",
      verdict: "not_run",
      rationale: "grok runtime is not installed.",
      risks: ["grok runtime is not installed."],
      rawJobReference: null,
      error: "grok runtime is not installed.",
    };
    const failed: NormalizedValidationResult = {
      provider: "claude",
      model: "claude-fake",
      status: "failed",
      verdict: "failed",
      rationale: "CLI failed.",
      risks: ["CLI failed."],
      rawJobReference: {
        jobId: "job-claude-1",
        correlationId: "validation-x-claude",
        statusTool: "job_status",
        resultTool: "job_result",
      },
      error: "CLI failed.",
    };

    const synthesis = startJudgeSynthesis(
      {
        asyncJobManager: fake.manager as any,
        getProviderRuntimeStatus: provider => runtime(provider),
      },
      {
        question: "Is this connected?",
        providerResults: [skipped, failed],
        judgeProvider: "codex",
      }
    );

    expect(synthesis.status).toBe("skipped");
    expect(synthesis.rawJobReference).toBeNull();
    expect(synthesis.note).toContain("requires at least one completed provider result");
    expect(fake.startCalls).toHaveLength(0);
  });

  it("starts judge synthesis from collected terminal provider results", () => {
    const fake = fakeAsyncJobManager();
    const report = startValidationRun(
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

    expect(report.synthesis.status).toBe("waiting_for_provider_results");
    const normalized = report.results.map(result =>
      collectValidationJobResult(
        { asyncJobManager: fake.manager as any },
        result.provider,
        result.rawJobReference!.jobId,
        result.model
      )
    ) as NormalizedValidationResult[];
    const synthesis = startJudgeSynthesis(
      {
        asyncJobManager: fake.manager as any,
        getProviderRuntimeStatus: provider => runtime(provider),
      },
      {
        question: "Is this connected?",
        providerResults: normalized,
        judgeProvider: "gemini",
      }
    );

    expect(synthesis.status).toBe("running");
    expect(synthesis.judgeModel).toBe("gemini");
    expect(synthesis.rawJobReference).toEqual(
      expect.objectContaining({ statusTool: "job_status", resultTool: "job_result" })
    );
    expect(fake.startCalls.at(-1)?.args.join("\n")).toContain('"provider": "claude"');
  });

  it("omits skipped or failed provider results from judge evidence", () => {
    const fake = fakeAsyncJobManager();
    const completed: NormalizedValidationResult = {
      provider: "claude",
      model: "claude-fake",
      status: "completed",
      verdict: "approved",
      rationale: "Claude approves.",
      risks: [],
      rawJobReference: {
        jobId: "job-claude-1",
        correlationId: "validation-x-claude",
        statusTool: "job_status",
        resultTool: "job_result",
      },
      error: null,
    };
    const skipped: NormalizedValidationResult = {
      provider: "grok",
      model: null,
      status: "skipped",
      verdict: "not_run",
      rationale: "grok runtime is not installed.",
      risks: ["grok runtime is not installed."],
      rawJobReference: null,
      error: "grok runtime is not installed.",
    };

    const synthesis = startJudgeSynthesis(
      {
        asyncJobManager: fake.manager as any,
        getProviderRuntimeStatus: provider => runtime(provider),
      },
      {
        question: "Is this connected?",
        providerResults: [completed, skipped],
        judgeProvider: "gemini",
      }
    );

    expect(synthesis.status).toBe("running");
    expect(synthesis.note).toContain("1 non-completed result(s) were preserved but omitted");
    const judgePrompt = fake.startCalls.at(-1)?.args.join("\n") ?? "";
    expect(judgePrompt).toContain('"provider": "claude"');
    expect(judgePrompt).not.toContain('"provider": "grok"');
  });

  it("U22 routes mistral as a validation provider and uses -p prompt args", () => {
    const fake = fakeAsyncJobManager();
    const report = startValidationRun(
      {
        asyncJobManager: fake.manager as any,
        getProviderRuntimeStatus: provider => runtime(provider),
      },
      {
        intent: "validate",
        question: "Is this connected?",
        providers: ["mistral"],
      }
    );

    expect(report.modelList).toEqual(["mistral"]);
    expect(fake.startCalls).toHaveLength(1);
    expect(fake.startCalls[0].cli).toBe("mistral");
    // Mistral mirrors Grok's headless surface: `-p PROMPT`
    expect(fake.startCalls[0].args[0]).toBe("-p");
  });

  it("U22 skips mistral when its runtime is not installed", () => {
    const fake = fakeAsyncJobManager();
    const report = startValidationRun(
      {
        asyncJobManager: fake.manager as any,
        getProviderRuntimeStatus: provider => runtime(provider, provider !== "mistral"),
      },
      {
        intent: "validate",
        question: "ping",
        providers: ["claude", "mistral"],
      }
    );

    const mistralResult = report.results.find(r => r.provider === "mistral");
    expect(mistralResult?.status).toBe("skipped");
  });
});
