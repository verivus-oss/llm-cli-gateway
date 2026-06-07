import { describe, expect, it } from "vitest";
import type { AsyncJobSnapshot } from "../async-job-manager.js";
import type { ProviderRuntimeStatus } from "../provider-status.js";
import { buildValidationReport } from "../validation-report.js";
import { registerValidationTools } from "../validation-tools.js";
import type { ValidationProvider } from "../validation-normalizer.js";

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

function fakeSnapshot(cli: ValidationProvider, correlationId: string): AsyncJobSnapshot {
  return {
    id: `job-${cli}`,
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
  };
}

describe("Layer 5 validation report", () => {
  it("marks conflicting completed verdicts as material disagreement and retains job IDs", () => {
    const report = buildValidationReport({
      validationId: "validation-test",
      status: "partial",
      startedAt: new Date(0).toISOString(),
      intent: "validate",
      originalRequest: { question: "Is this correct?" },
      modelList: ["claude", "codex"],
      results: [
        {
          provider: "claude",
          model: "claude-fake",
          status: "completed",
          verdict: "approve",
          rationale: "Looks correct.",
          risks: [],
          rawJobReference: {
            jobId: "job-claude",
            correlationId: "corr-claude",
            statusTool: "job_status",
            resultTool: "job_result",
          },
          error: null,
        },
        {
          provider: "codex",
          model: "codex-fake",
          status: "completed",
          verdict: "reject",
          rationale: "Found a bug.",
          risks: ["risk: bug"],
          rawJobReference: {
            jobId: "job-codex",
            correlationId: "corr-codex",
            statusTool: "job_status",
            resultTool: "job_result",
          },
          error: null,
        },
      ],
      synthesis: {
        status: "not_requested",
        judgeModel: null,
        rawJobReference: null,
        note: "No judge requested.",
      },
    });

    expect(report.humanReadable).toContain("Validation report validation-test");
    expect(report.structuredContent.disagreements.hasMaterialDisagreement).toBe(true);
    expect(report.structuredContent.confidence).toBe("low");
    expect(report.structuredContent.jobIds).toEqual(["job-claude", "job-codex"]);
  });

  it("returns human-readable report text as MCP content while preserving structuredContent", async () => {
    const handlers = new Map<string, (args: any) => Promise<any>>();
    const server = {
      // Registrations use the 4-arg form (name, description, schema, handler);
      // capture the last argument as the handler to stay form-agnostic.
      tool(name: string, ...rest: unknown[]) {
        handlers.set(name, rest[rest.length - 1] as (args: any) => Promise<any>);
      },
    };
    const asyncJobManager = {
      startJob(cli: ValidationProvider, _args: string[], correlationId: string) {
        return fakeSnapshot(cli, correlationId);
      },
      getJobResult() {
        return null;
      },
      getJobSnapshot() {
        return null;
      },
    };

    registerValidationTools(server as any, {
      asyncJobManager: asyncJobManager as any,
      getProviderRuntimeStatus: provider => runtime(provider),
    });

    const result = await handlers.get("validate_with_models")!({
      question: "Is the gateway connected?",
      models: ["claude"],
      focus: "connectivity",
    });

    expect(result.content[0].text).toMatch(/^Validation report /);
    expect(result.structuredContent.report.report.humanReadable).toBe(result.content[0].text);
    expect(result.structuredContent.report.report.structuredContent.jobIds).toEqual(["job-claude"]);
  });
});
