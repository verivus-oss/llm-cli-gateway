/**
 * Slice 3 — API providers as validation reviewers/judges.
 *
 * The orchestrator dispatches a configured API provider through startHttpJob
 * (HttpJobRunner) while CLI providers keep the argv startJob path, on one shared
 * dispatch point. Covers: API reviewer routes to startHttpJob, CLI reviewer
 * routes to startJob, a mixed run, an API judge, and that an API provider is
 * treated as installed (not skipped) without a CLI runtime probe.
 */
import { describe, expect, it } from "vitest";
import type { AsyncJobResult, AsyncJobSnapshot } from "../async-job-manager.js";
import { startValidationRun, startJudgeSynthesis } from "../validation-orchestrator.js";
import { buildValidationSchemas } from "../validation-tools.js";
import type { ValidationProvider } from "../validation-normalizer.js";
import type { ApiProviderRuntime } from "../config.js";

const ollama: ApiProviderRuntime = {
  name: "ollama",
  kind: "openai-compatible",
  apiKeyEnv: null,
  baseUrl: "http://127.0.0.1:11434/v1",
  defaultModel: "qwen2.5",
  apiKey: "",
};

function snapshot(id: string, cli: string, status: AsyncJobSnapshot["status"]): AsyncJobSnapshot {
  return {
    id,
    cli,
    status,
    startedAt: new Date().toISOString(),
    finishedAt: status === "running" ? null : new Date().toISOString(),
    exitCode: status === "running" ? null : 0,
    correlationId: `corr-${id}`,
    outputTruncated: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    error: null,
    exited: status !== "running",
  };
}

function makeManager() {
  const startJobCalls: string[] = [];
  const startHttpCalls: string[] = [];
  let n = 0;
  return {
    startJobCalls,
    startHttpCalls,
    manager: {
      startJob(cli: string): AsyncJobSnapshot {
        startJobCalls.push(cli);
        return snapshot(`cli-${++n}`, cli, "running");
      },
      startHttpJob(params: { provider: { name: string } }): {
        snapshot: AsyncJobSnapshot;
        deduped: boolean;
      } {
        startHttpCalls.push(params.provider.name);
        return {
          snapshot: snapshot(`http-${++n}`, params.provider.name, "running"),
          deduped: false,
        };
      },
      getJobResult(): AsyncJobResult | null {
        return null;
      },
      getJobSnapshot(): AsyncJobSnapshot | null {
        return null;
      },
    },
  };
}

// A CLI runtime stub so the CLI branch reports installed without touching the host.
const cliInstalled = (provider: ValidationProvider) =>
  ({
    provider,
    displayName: provider,
    command: provider,
    installed: true,
    version: `${provider}-fake`,
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
  }) as any;

describe("Slice 3 — API providers as validation reviewers", () => {
  it("dispatches an API reviewer through startHttpJob, a CLI reviewer through startJob", () => {
    const fake = makeManager();
    const report = startValidationRun(
      {
        asyncJobManager: fake.manager as any,
        getProviderRuntimeStatus: cliInstalled,
        apiProviders: [ollama],
      },
      { intent: "validate", question: "q", providers: ["claude", "ollama"] }
    );
    expect(fake.startJobCalls).toEqual(["claude"]);
    expect(fake.startHttpCalls).toEqual(["ollama"]);
    // Both reviewers started (neither skipped).
    expect(report.results.map(r => r.status).sort()).toEqual(["running", "running"]);
  });

  it("treats an API provider as installed without a CLI runtime probe", () => {
    const fake = makeManager();
    const report = startValidationRun(
      // No getProviderRuntimeStatus provided — the CLI path would skip, but the
      // API provider must still start via its own status resolution.
      { asyncJobManager: fake.manager as any, apiProviders: [ollama] },
      { intent: "ask_model", question: "q", providers: ["ollama"] }
    );
    expect(fake.startHttpCalls).toEqual(["ollama"]);
    expect(report.results[0].status).toBe("running");
  });

  it("routes an API judge through startHttpJob", () => {
    const fake = makeManager();
    const synthesis = startJudgeSynthesis(
      { asyncJobManager: fake.manager as any, apiProviders: [ollama] },
      {
        question: "q",
        judgeProvider: "ollama",
        providerResults: [
          {
            provider: "claude",
            model: null,
            status: "completed",
            verdict: "ok",
            rationale: "fine",
            risks: [],
            rawJobReference: null,
            error: null,
          },
        ],
      }
    );
    expect(synthesis.status).toBe("running");
    expect(fake.startHttpCalls).toEqual(["ollama"]);
    expect(fake.startJobCalls).toEqual([]);
  });

  it("derives the validation provider enum from CLI_TYPES + enabled API names", () => {
    const { providerSchema } = buildValidationSchemas({
      asyncJobManager: {} as any,
      apiProviders: [ollama],
    });
    expect(providerSchema.safeParse("claude").success).toBe(true);
    expect(providerSchema.safeParse("ollama").success).toBe(true);
    expect(providerSchema.safeParse("not-a-provider").success).toBe(false);

    // With no apiProviders, only the five CLIs are accepted (pre-Slice-3 shape).
    const { providerSchema: cliOnly } = buildValidationSchemas({ asyncJobManager: {} as any });
    expect(cliOnly.safeParse("ollama").success).toBe(false);
    expect(cliOnly.safeParse("grok").success).toBe(true);
  });

  it("leaves CLI-only runs unchanged when no apiProviders are configured", () => {
    const fake = makeManager();
    startValidationRun(
      { asyncJobManager: fake.manager as any, getProviderRuntimeStatus: cliInstalled },
      { intent: "validate", question: "q", providers: ["claude", "codex"] }
    );
    expect(fake.startJobCalls).toEqual(["claude", "codex"]);
    expect(fake.startHttpCalls).toEqual([]);
  });
});
