/**
 * U26 — `codex_fork_session` tool.
 *
 * Verifies the pure `prepareCodexForkRequest` helper builds the expected
 * `codex fork ...` argv, enforces the (sessionId | forkLast) XOR constraint,
 * and rejects gateway-prefixed session IDs via `validateSessionId`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalManager } from "../approval-manager.js";
import {
  AsyncJobManager,
  type AsyncJobErrorCategory,
  type AsyncJobResult,
  type AsyncJobSnapshot,
} from "../async-job-manager.js";
import type { PersistenceConfig } from "../config.js";
import { NoopFlightRecorder } from "../flight-recorder.js";
import { createGatewayServer } from "../index.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import { PersonalConfigManager } from "../personal-config.js";
import { prepareCodexForkRequest } from "../request-helpers.js";
import { FileSessionManager } from "../session-manager.js";
import { validateUpstreamCliSubcommandArgs } from "../upstream-contracts.js";
import { CLI_INPUT_TOO_LARGE_CATEGORY, CLI_INVALID_INPUT_CATEGORY } from "../cli-input-limits.js";

interface RegisteredTool {
  handler: (
    args: Record<string, unknown>,
    extra?: Record<string, unknown>
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  }>;
}

function registeredTools(
  server: ReturnType<typeof createGatewayServer>
): Record<string, RegisteredTool> {
  return (server as unknown as Record<string, Record<string, RegisteredTool>>)._registeredTools;
}

function memoryPersistence(): PersistenceConfig {
  return {
    backend: "memory",
    path: null,
    dsn: null,
    retentionDays: 30,
    dedupWindowMs: 3_600_000,
    acknowledgeEphemeral: true,
    ownsOrphanRecovery: false,
    asyncJobsEnabled: true,
    sources: { configFile: null, envOverrides: [] },
  };
}

class ClassifiedForkFailureJobManager extends AsyncJobManager {
  private completed: AsyncJobSnapshot | null = null;

  constructor(readonly category: AsyncJobErrorCategory) {
    super(noopLogger, undefined, new MemoryJobStore());
  }

  override startJobWithDedup(
    ...args: Parameters<AsyncJobManager["startJobWithDedup"]>
  ): ReturnType<AsyncJobManager["startJobWithDedup"]> {
    const message =
      this.category === CLI_INPUT_TOO_LARGE_CATEGORY
        ? "codex fork input is too large for the provider CLI argv transport."
        : "codex fork input cannot be passed to the provider CLI.";
    this.completed = {
      id: "classified-fork-failure",
      cli: "codex",
      status: "failed",
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(1).toISOString(),
      exitCode: 126,
      correlationId: args[2],
      outputTruncated: false,
      stdoutBytes: 0,
      stderrBytes: Buffer.byteLength(message, "utf8"),
      error: message,
      errorCategory: this.category,
      retryable: false,
      exited: true,
      progress: {
        capability: "activity_only",
        lastActivityAt: new Date(1).toISOString(),
        lastSeq: 0,
        droppedCount: 0,
        events: [],
      },
    };
    return { snapshot: this.completed, deduped: false };
  }

  override getJobSnapshot(jobId: string): AsyncJobSnapshot | null {
    return this.completed?.id === jobId ? this.completed : null;
  }

  override getJobResult(jobId: string): AsyncJobResult | null {
    if (!this.completed || this.completed.id !== jobId) return null;
    const stderr = this.completed.error ?? "";
    return {
      ...this.completed,
      stdout: "",
      stderr,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutOffsetChars: 0,
      stdoutTotalChars: 0,
      stdoutNextOffsetChars: null,
      stderrOffsetChars: 0,
      stderrTotalChars: stderr.length,
      stderrNextOffsetChars: null,
    };
  }
}

describe("U26 — codex_fork_session (prepareCodexForkRequest)", () => {
  it('emits ["fork", "--last", "--", PROMPT] when forkLast=true', () => {
    const { args } = prepareCodexForkRequest({ forkLast: true, prompt: "hello" });
    expect(args).toEqual(["fork", "--last", "--", "hello"]);
  });

  it('emits ["fork", <UUID>, "--", PROMPT] when sessionId is supplied', () => {
    const { args } = prepareCodexForkRequest({
      sessionId: "abc-123",
      prompt: "hello",
    });
    expect(args).toEqual(["fork", "abc-123", "--", "hello"]);
  });

  it("throws when neither sessionId nor forkLast is set", () => {
    expect(() => prepareCodexForkRequest({ prompt: "hello" })).toThrow(
      /one of sessionId or forkLast is required/
    );
  });

  it("throws when both sessionId and forkLast are set", () => {
    expect(() =>
      prepareCodexForkRequest({
        sessionId: "abc-123",
        forkLast: true,
        prompt: "hello",
      })
    ).toThrow(/mutually exclusive/);
  });

  it("rejects a gateway-prefixed sessionId via validateSessionId", () => {
    expect(() => prepareCodexForkRequest({ sessionId: "gw-fake", prompt: "hi" })).toThrow(
      /reserved prefix/
    );
  });

  it("preserves the prompt as the final positional regardless of mode", () => {
    expect(
      prepareCodexForkRequest({ forkLast: true, prompt: "multi word prompt" }).args.at(-1)
    ).toBe("multi word prompt");
    expect(
      prepareCodexForkRequest({
        sessionId: "uuid-1",
        prompt: "multi word prompt",
      }).args.at(-1)
    ).toBe("multi word prompt");
  });

  it("rejects an oversized multibyte fork prompt before spawn", () => {
    const invoke = () => prepareCodexForkRequest({ forkLast: true, prompt: "中".repeat(44_000) });
    expect(invoke).toThrow(/too large for the provider CLI argv transport/);
    expect(invoke).toThrow(/will not truncate/);
  });

  it("matches the declared Codex fork subcommand contract", () => {
    for (const args of [
      prepareCodexForkRequest({ forkLast: true, prompt: "review this" }).args,
      prepareCodexForkRequest({ sessionId: "native-session", prompt: "review this" }).args,
    ]) {
      const result = validateUpstreamCliSubcommandArgs("codex", ["fork"], args.slice(1));
      expect(result.ok, result.violations.map(violation => violation.message).join("; ")).toBe(
        true
      );
    }
  });
});

describe("codex_fork_session MCP-managed boundary", () => {
  let testDir: string;
  let originalApprovalAllowBypass: string | undefined;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "codex-fork-managed-"));
    originalApprovalAllowBypass = process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
    delete process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
  });

  afterEach(() => {
    if (originalApprovalAllowBypass === undefined) {
      delete process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
    } else {
      process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = originalApprovalAllowBypass;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  function createManagedServer(
    jobs: AsyncJobManager = new AsyncJobManager(
      noopLogger,
      undefined,
      new MemoryJobStore(),
      new NoopFlightRecorder()
    )
  ): {
    server: ReturnType<typeof createGatewayServer>;
    sessions: FileSessionManager;
    approvals: ApprovalManager;
    jobs: AsyncJobManager;
  } {
    const sessions = new FileSessionManager(join(testDir, "sessions.json"));
    const approvals = new ApprovalManager(join(testDir, "approvals.jsonl"), noopLogger);
    const recorder = new NoopFlightRecorder();
    const server = createGatewayServer({
      sessionManager: sessions,
      approvalManager: approvals,
      asyncJobManager: jobs,
      persistence: memoryPersistence(),
      flightRecorder: recorder,
      logger: noopLogger,
      personalConfig: new PersonalConfigManager({
        enabled: false,
        baselinePath: join(testDir, "baseline"),
        maxStaleHours: 168,
      }),
    });
    return { server, sessions, approvals, jobs };
  }

  it.each([CLI_INPUT_TOO_LARGE_CATEGORY, CLI_INVALID_INPUT_CATEGORY] as const)(
    "preserves a durable %s classification on codex_fork_session",
    async errorCategory => {
      const jobs = new ClassifiedForkFailureJobManager(errorCategory);
      const { server } = createManagedServer(jobs);
      try {
        const result = await registeredTools(server).codex_fork_session.handler(
          {
            prompt: "continue the review",
            forkLast: true,
            approvalStrategy: "legacy",
          },
          {}
        );

        expect(result).toMatchObject({
          isError: true,
          structuredContent: {
            errorCategory,
            retryable: false,
          },
        });
      } finally {
        await server.close();
        await jobs.dispose();
      }
    }
  );

  it.each([
    ["darwin", { prompt: "p".repeat(100_000), model: "m".repeat(40_000), sessionId: "native" }],
    ["win32", { prompt: "p".repeat(20_000), forkLast: true }],
  ] as const)(
    "rejects the final fork argv on %s before session lookup or durable job admission",
    async (platform, input) => {
      const { server, sessions, jobs } = createManagedServer();
      const getSession = vi.spyOn(sessions, "getSession");
      const startJob = vi.spyOn(jobs, "startJob");
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      try {
        const result = await registeredTools(server).codex_fork_session.handler(
          {
            ...input,
            approvalStrategy: "legacy",
          },
          {}
        );

        expect(result).toMatchObject({
          isError: true,
          structuredContent: {
            errorCategory: CLI_INPUT_TOO_LARGE_CATEGORY,
            retryable: false,
          },
        });
        expect(result.content[0]?.text).toContain("final argv aggregate");
        expect(getSession).not.toHaveBeenCalled();
        expect(startJob).not.toHaveBeenCalled();
        expect(jobs.getRunningJobs()).toEqual([]);
      } finally {
        platformSpy.mockRestore();
        await jobs.dispose();
      }
    }
  );

  it("rejects a managed native fork before approval or provider execution", async () => {
    const { server, sessions, approvals } = createManagedServer();
    const session = sessions.createSession("codex", "native Codex session", "native-codex-session");

    const result = await registeredTools(server).codex_fork_session.handler(
      {
        prompt: "continue the isolated review",
        sessionId: session.id,
        approvalStrategy: "mcp_managed",
      },
      {}
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "approvalStrategy:mcp_managed is unavailable for codex"
    );
    expect(approvals.list(1)).toEqual([]);
  });

  it("rejects a managed native fork even when the operator bypass setting is enabled", async () => {
    process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = "1";
    const { server, sessions, approvals } = createManagedServer();
    const session = sessions.createSession("codex", "native Codex session", "native-codex-session");

    const result = await registeredTools(server).codex_fork_session.handler(
      {
        prompt: "continue the isolated review",
        sessionId: session.id,
        approvalStrategy: "mcp_managed",
        approvalPolicy: "strict",
      },
      {}
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "approvalStrategy:mcp_managed is unavailable for codex"
    );
    expect(approvals.list(1)).toEqual([]);
  });

  it("rejects forkLast under mcp_managed before it can resolve native state", async () => {
    const { server, approvals } = createManagedServer();

    const result = await registeredTools(server).codex_fork_session.handler(
      {
        prompt: "continue the isolated review",
        forkLast: true,
        approvalStrategy: "mcp_managed",
      },
      {}
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "approvalStrategy:mcp_managed is unavailable for codex"
    );
    expect(approvals.list(1)).toEqual([]);
  });
});
