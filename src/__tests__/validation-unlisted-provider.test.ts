import { describe, expect, it } from "vitest";
import type { AsyncJobSnapshot } from "../async-job-manager.js";
import type { ProviderRuntimeStatus } from "../provider-status.js";
import type { ValidationProvider } from "../validation-normalizer.js";
import { startValidationRun } from "../validation-orchestrator.js";
import { WorkspaceRegistryError } from "../workspace-registry.js";

// Issue #271: a provider missing from the selected workspace's `providers`
// list must degrade to `skipped`, not abort the whole multi-provider call.
//
// Observed condition: a host with [workspaces] default set, where every
// [[workspaces.repos]] entry lists ["claude","codex","gemini","grok","mistral"]
// and therefore omits cursor and devin. Any validation call including either
// failed outright rather than returning the other reviewers' opinions.
//
// These tests drive startValidationRun with an injected resolveProviderCwd that
// throws for one provider. Round 1 (codex and grok, independently) rejected the
// previous version of this file: it asserted the ORDER OF STRINGS in
// validation-orchestrator.ts, which stays green if the catch is unreachable, if
// deferLaunch is inverted, or if the branch is moved into a comment. The claim
// that a behavioural test needs a live job manager was wrong; the dependency is
// injectable and the fake below is the whole cost.

function snapshot(cli: string, correlationId: string): AsyncJobSnapshot {
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

function makeManager(): { started: string[]; manager: Record<string, unknown> } {
  const started: string[] = [];
  return {
    started,
    manager: {
      startJobWithDedup(
        cli: string,
        _args: string[],
        correlationId: string
      ): { snapshot: AsyncJobSnapshot; deduped: boolean } {
        started.push(cli);
        return { snapshot: snapshot(cli, correlationId), deduped: false };
      },
    },
  };
}

/** Reject `unlisted` the way resolveWorkspaceForProvider does for a real registry. */
function cwdResolver(unlisted: string, message?: string): (p: string) => string {
  return provider => {
    if (provider === unlisted) {
      throw new WorkspaceRegistryError(
        message ?? `Workspace "shared" does not allow provider "${provider}"`
      );
    }
    return "/workspace/shared";
  };
}

function run(
  providers: ValidationProvider[],
  resolveProviderCwd: (p: string) => string
): { report: ReturnType<typeof startValidationRun>; started: string[] } {
  const fake = makeManager();
  const report = startValidationRun(
    {
      asyncJobManager: fake.manager as never,
      getProviderRuntimeStatus: runtime,
      resolveProviderCwd: resolveProviderCwd as never,
    },
    { intent: "validate", question: "is this correct?", providers }
  );
  return { report, started: fake.started };
}

function statusOf(
  report: ReturnType<typeof startValidationRun>,
  provider: ValidationProvider
): { status: string; error: string | null } {
  const found = report.results.find(r => r.provider === provider);
  if (!found) throw new Error(`No ${provider} result`);
  return { status: found.status, error: found.error };
}

describe("issue #271: an unlisted provider is skipped, not fatal", () => {
  it("does not abort the call: the listed providers still start", () => {
    // THE REGRESSION TEST. Before the fix this threw out of startValidationRun
    // and the caller got nothing at all, including from providers that were
    // perfectly well configured.
    const { report, started } = run(["claude", "codex", "cursor"], cwdResolver("cursor"));
    expect(started).toEqual(["claude", "codex"]);
    expect(statusOf(report, "claude").status).toBe("running");
    expect(statusOf(report, "codex").status).toBe("running");
  });

  it("marks the unlisted provider skipped, with the workspace reason", () => {
    const { report } = run(["claude", "cursor"], cwdResolver("cursor"));
    const cursor = statusOf(report, "cursor");
    expect(cursor.status).toBe("skipped");
    expect(cursor.error).toContain("does not allow provider");
  });

  it("tells the operator how to fix THAT provider", () => {
    const { report } = run(["cursor"], cwdResolver("cursor"));
    expect(statusOf(report, "cursor").error).toMatch(/providers list/);
  });

  it("does not offer the providers-list remedy for an unrelated workspace error", () => {
    // Round 1 (grok): the suffix was appended to every WorkspaceRegistryError,
    // so "No workspace selected" was answered with "add it to that workspace's
    // providers list", which is not the setting that fixes it.
    const { report } = run(
      ["cursor"],
      cwdResolver(
        "cursor",
        "No workspace selected. Configure [workspaces].default or pass a registered workspace alias."
      )
    );
    const cursor = statusOf(report, "cursor");
    expect(cursor.status).toBe("skipped");
    expect(cursor.error).toContain("No workspace selected");
    expect(cursor.error).not.toMatch(/providers list/);
  });

  it("leaves an unrelated error fatal rather than swallowing it as a skip", () => {
    // The catch must stay narrow. A bug in cwd resolution is not a workspace
    // policy statement about one provider, and silently degrading it to
    // "skipped" would hide a real fault behind a configuration message.
    expect(() =>
      run(["claude"], () => {
        throw new TypeError("cwd resolution is broken");
      })
    ).toThrow(TypeError);
  });
});
