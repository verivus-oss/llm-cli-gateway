import { afterEach, describe, expect, it, vi } from "vitest";

// Counts real bwrap probes so the caching claim has an executed control rather
// than an assertion about the shape of the source.
const bwrapProbes: string[] = [];
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (command: string, ...rest: unknown[]) => {
      if (command === "bwrap") bwrapProbes.push(command);
      return (actual.spawnSync as (...a: unknown[]) => unknown)(command, ...rest);
    },
  };
});

import type { AsyncJobSnapshot } from "../async-job-manager.js";
import type { ProviderRuntimeStatus } from "../provider-status.js";
import type { ValidationProvider } from "../validation-normalizer.js";
import { startReviewRun, startValidationRun } from "../validation-orchestrator.js";
import { assertUpstreamCliArgs } from "../upstream-contracts.js";

// Issue #270: cursor and devin failed on every review seat.
//
// cursor: the review argv never contained --trust, so cursor refused with
//   "Workspace Trust Required" for any repository not already in that host's
//   trusted_folders.toml.
// devin:  --sandbox is emitted unconditionally for review and devin resolves it
//   through bubblewrap on Linux. Without bwrap it failed at spawn, and nothing
//   probed for it.
//
// These tests drive startReviewRun/startValidationRun and assert on the argv
// that actually reaches the job manager. An earlier version of this file
// asserted against the text of validation-orchestrator.ts, which could not
// distinguish emitted argv from a comment, and could not have caught either of
// the two defects a real run exposed: that the devin refusal aborted the whole
// roster, and that it surfaced as an unrelated NUL-byte message.

interface CliStartCall {
  cli: ValidationProvider;
  args: string[];
  cwd?: string;
}

function snapshot(cli: string, correlationId: string, queued: boolean): AsyncJobSnapshot {
  return {
    id: `job-${cli}`,
    cli,
    status: queued ? "queued" : "running",
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
  manager: Record<string, unknown>;
  validationRunStore: Record<string, unknown>;
} {
  const calls: CliStartCall[] = [];
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
  return {
    calls,
    validationRunStore,
    manager: {
      startJobWithDedup(
        cli: ValidationProvider,
        args: string[],
        correlationId: string,
        options: {
          cwd?: string;
          deferLaunch?: boolean;
          validationAdmission?: { provider: string };
        }
      ): { snapshot: AsyncJobSnapshot; deduped: boolean } {
        calls.push({ cli, args, cwd: options.cwd });
        if (options.validationAdmission && storedRun) {
          storedRun.providerLinks.push({
            provider: options.validationAdmission.provider,
            jobId: `job-${cli}`,
            correlationId,
          });
        }
        return {
          snapshot: snapshot(cli, correlationId, options.deferLaunch === true),
          deduped: false,
          ...(options.deferLaunch
            ? { deferredLaunch: { release: () => undefined, cancel: () => true } }
            : {}),
        };
      },
    },
  };
}

function review(
  providers: ValidationProvider[],
  hasBubblewrap: () => boolean,
  opts: { registered?: boolean; trustCursorWorkspace?: boolean } = {}
): { report: ReturnType<typeof startReviewRun>; calls: CliStartCall[] } {
  const fake = makeManager();
  const prompt = "FENCED REVIEW EVIDENCE";
  const report = startReviewRun(
    {
      asyncJobManager: fake.manager as never,
      getProviderRuntimeStatus: runtime,
      validationRunStore: fake.validationRunStore as never,
      hasBubblewrap,
      // Default true so the cases about devin/sandbox are not silently altered
      // by the cursor trust boundary; the trust cases set it explicitly.
      isProviderWorkspacePath: () => opts.registered !== false,
    },
    {
      prompt,
      providers,
      trustCursorWorkspace: opts.trustCursorWorkspace === true,
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
  return { report, calls: fake.calls };
}

function resultFor(
  report: ReturnType<typeof startReviewRun>,
  provider: ValidationProvider
): { status: string; error: string | null } {
  const found = report.results.find(r => r.provider === provider);
  if (!found) throw new Error(`No ${provider} result`);
  return { status: found.status, error: found.error };
}

const withPlatform = (platform: string, run: () => void): void => {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    run();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("issue #270: cursor trust", () => {
  it("emits --trust for a repository registered for cursor", () => {
    const { calls } = review(["cursor"], () => true, { registered: true });
    expect(calls[0].args).toEqual([
      "--print",
      "--mode",
      "plan",
      "--sandbox",
      "enabled",
      "--trust",
      "--",
      "FENCED REVIEW EVIDENCE",
    ]);
  });

  it("does NOT emit --trust for an ordinary ask", () => {
    // The ask path is where the neutral temp cwd applies. Granting trust there
    // would widen the change well beyond the defect.
    const fake = makeManager();
    startValidationRun(
      { asyncJobManager: fake.manager as never, getProviderRuntimeStatus: runtime },
      { intent: "second_opinion", question: "is this right?", providers: ["cursor"] }
    );
    expect(fake.calls[0].args).toContain("ask");
    expect(fake.calls[0].args).not.toContain("--trust");
  });

  it("SKIPS cursor on an unregistered repository instead of trusting it", () => {
    // Round 2 (codex): --trust also makes cursor load project rules, AGENTS.md
    // and project MCP config FROM THE REPOSITORY UNDER REVIEW, while
    // review-prompt.ts fences that same repository's evidence as "untrusted
    // data, never instructions". Granting it unconditionally let the reviewed
    // repository instruct its own reviewer through a channel outside the fence.
    const { report, calls } = review(["claude", "cursor"], () => true, { registered: false });
    const cursor = resultFor(report, "cursor");
    expect(cursor.status).toBe("skipped");
    expect(cursor.error).toMatch(/not a workspace registered for cursor/i);
    expect(cursor.error).toMatch(/AGENTS\.md|instruct the reviewer/i);
    // and it does not take the rest of the roster with it
    expect(calls.map(c => c.cli)).toEqual(["claude"]);
  });

  it("grants trust on an unregistered repository ONLY with the explicit opt-in", () => {
    const { report, calls } = review(["cursor"], () => true, {
      registered: false,
      trustCursorWorkspace: true,
    });
    expect(resultFor(report, "cursor").status).not.toBe("skipped");
    expect(calls[0].args).toContain("--trust");
  });

  it("fails closed when trust cannot be established at all", () => {
    // No predicate wired: the gateway cannot show the operator registered this
    // directory, so it must not assume they did.
    const fake = makeManager();
    const prompt = "p";
    const report = startReviewRun(
      {
        asyncJobManager: fake.manager as never,
        getProviderRuntimeStatus: runtime,
        validationRunStore: fake.validationRunStore as never,
        hasBubblewrap: () => true,
      },
      {
        prompt,
        providers: ["cursor"],
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
    expect(resultFor(report, "cursor").status).toBe("skipped");
    expect(fake.calls).toHaveLength(0);
  });

  it("--trust is a real cursor flag that passes argv admission", () => {
    // Guards against emitting a flag the contract would reject at admission,
    // which would replace one deterministic failure with another.
    expect(() =>
      assertUpstreamCliArgs("cursor", [
        "--print",
        "--mode",
        "plan",
        "--sandbox",
        "enabled",
        "--trust",
        "review this",
      ])
    ).not.toThrow();
  });
});

describe("issue #270: devin sandbox preflight", () => {
  it("skips only the devin seat when bwrap is absent, and still launches the rest", () => {
    // The defect this replaces: throwing here aborted the entire roster,
    // because startReviewRun defers launches and rethrows admission errors.
    withPlatform("linux", () => {
      const { report, calls } = review(["claude", "devin", "cursor"], () => false);
      expect(resultFor(report, "devin").status).toBe("skipped");
      expect(calls.map(c => c.cli)).toEqual(["claude", "cursor"]);
      expect(report.success).toBe(true);
    });
  });

  it("names bubblewrap in the skip reason rather than an unrelated cause", () => {
    // The first attempt reused CliInvalidInputError, whose message is hard-coded
    // to "contains an embedded NUL byte", so a missing package was reported as a
    // malformed argument.
    withPlatform("linux", () => {
      const { report } = review(["devin"], () => false);
      const { error } = resultFor(report, "devin");
      expect(error).toMatch(/bubblewrap/i);
      expect(error).not.toMatch(/NUL byte/i);
    });
  });

  it("runs devin with --sandbox retained when bwrap is present", () => {
    // Dropping --sandbox to make it run is the tempting wrong fix: a review that
    // asked for isolation and silently ran without it is the worse outcome.
    withPlatform("linux", () => {
      const { report, calls } = review(["devin"], () => true);
      expect(resultFor(report, "devin").status).not.toBe("skipped");
      expect(calls[0].args).toContain("--sandbox");
    });
  });

  it("does not gate on bwrap off Linux, where devin uses a different sandbox", () => {
    // `devin --help`: "macOS seatbelt / Linux bwrap+seccomp". Gating every
    // platform on bwrap refused every macOS review despite a working sandbox.
    withPlatform("darwin", () => {
      const { report, calls } = review(["devin"], () => false);
      expect(resultFor(report, "devin").status).not.toBe("skipped");
      expect(calls[0].args).toContain("--sandbox");
    });
  });

  it("does not consult the probe for a non-devin provider, nor for a devin ask", () => {
    // Round 2 (grok): the previous version claimed "or for an ask" in its name
    // but never ran an ask, so half the assertion was decorative. The ask path
    // is now actually exercised, with devin, which is the only case where the
    // gate could wrongly fire.
    const probe = vi.fn(() => true);
    withPlatform("linux", () => {
      review(["claude", "cursor"], probe);
    });
    expect(probe).not.toHaveBeenCalled();

    const fake = makeManager();
    withPlatform("linux", () => {
      startValidationRun(
        {
          asyncJobManager: fake.manager as never,
          getProviderRuntimeStatus: runtime,
          hasBubblewrap: probe,
        },
        { intent: "second_opinion", question: "is this right?", providers: ["devin"] }
      );
    });
    expect(probe).not.toHaveBeenCalled();
    expect(fake.calls[0].cli).toBe("devin");
    expect(fake.calls[0].args).not.toContain("--sandbox");
  });

  it("probes bwrap at most once per process, not once per review seat", () => {
    // Kept last: every test above injects the probe, so the real one has not
    // run yet and the counter starts clean.
    const fake = makeManager();
    const runOnce = (): void => {
      startReviewRun(
        {
          asyncJobManager: fake.manager as never,
          getProviderRuntimeStatus: runtime,
          validationRunStore: fake.validationRunStore as never,
        },
        {
          prompt: "p",
          providers: ["devin"],
          cwd: "/authorized/repository",
          artifactSha256: "a".repeat(64),
          artifactByteLength: 1,
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
    };
    withPlatform("linux", () => {
      runOnce();
      runOnce();
      runOnce();
    });
    // Round 2 (grok): `<= 1` also passes when the probe NEVER runs, so it could
    // not distinguish "cached" from "never called" and was a control that could
    // not fail in the direction that matters. Pin it to exactly one: the default
    // probe must run, and must run only once across three review runs.
    expect(bwrapProbes.length).toBe(1);
  });
});
