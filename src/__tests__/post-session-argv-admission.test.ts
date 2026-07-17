import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertFinalCliArgvAdmission,
  buildAdmittedMistralRetryPrep,
  buildMistralRetryPrep,
  handleCursorRequest,
  handleCursorRequestAsync,
  handleGeminiRequest,
  handleGeminiRequestAsync,
  prepareCursorRequest,
  prepareGeminiRequest,
  type GatewayServerRuntime,
} from "../index.js";
import {
  CLI_INPUT_TOO_LARGE_CATEGORY,
  CliInputTooLargeError,
  MAX_CLI_ARGV_UTF8_BYTES_LINUX,
  MAX_CLI_ARGV_UTF8_BYTES_POSIX,
  MAX_CLI_ARGV_UTF8_BYTES_WINDOWS,
  MAX_CLI_ARGV_UTF8_BYTES_WINDOWS_CMD,
  measureCliArgvUtf8Bytes,
  measureWindowsCmdWrapperPreflightUtf8UpperBound,
  measureWindowsCliArgvUtf8UpperBound,
} from "../cli-input-limits.js";
import { runWithRequestContext } from "../request-context.js";
import type { ISessionManager } from "../session-manager.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function sessionManagerSpies(): ISessionManager {
  return {
    createSession: vi.fn(),
    getSession: vi.fn(async () => null),
    listSessions: vi.fn(async () => []),
    deleteSession: vi.fn(async () => false),
    setActiveSession: vi.fn(async () => false),
    getActiveSession: vi.fn(async () => null),
    updateSessionUsage: vi.fn(),
    updateSessionMetadata: vi.fn(async () => false),
    clearAllSessions: vi.fn(async () => 0),
  } as ISessionManager;
}

function admissionRuntime(sessionManager: ISessionManager): {
  runtime: GatewayServerRuntime;
  startJob: ReturnType<typeof vi.fn>;
  logStart: ReturnType<typeof vi.fn>;
  logComplete: ReturnType<typeof vi.fn>;
} {
  const startJob = vi.fn();
  const logStart = vi.fn();
  const logComplete = vi.fn();
  return {
    startJob,
    logStart,
    logComplete,
    runtime: {
      sessionManager,
      asyncJobManager: { startJob } as never,
      flightRecorder: { logStart, logComplete },
      logger: noopLogger,
      performanceMetrics: { recordRequest: vi.fn() },
      compression: { enabled: false, sources: { configFile: null } },
      workspaces: {
        enabled: false,
        defaultAlias: null,
        allowUnregisteredWorkingDir: false,
        repos: [],
        allowedRoots: [],
        sources: { configFile: null },
      },
      personalConfig: { settings: { enabled: false } },
    } as unknown as GatewayServerRuntime,
  };
}

function exactLinuxGeminiIncludeDirs(): string[] {
  const dirs = [...Array.from({ length: 8 }, (_, index) => `${index}${"x".repeat(119_998)}`), "x"];
  const prep = prepareGeminiRequest(
    {
      prompt: "review",
      approvalStrategy: "legacy",
      optimizePrompt: false,
      operation: "gemini_request",
      includeDirs: dirs,
    },
    {
      logger: noopLogger,
      personalConfig: { settings: { enabled: false } },
    } as unknown as GatewayServerRuntime
  );
  if (!("args" in prep)) throw new Error("expected boundary preparation to succeed");
  const delta = MAX_CLI_ARGV_UTF8_BYTES_LINUX - measureCliArgvUtf8Bytes("agy", prep.args);
  expect(delta).toBeGreaterThan(0);
  dirs[dirs.length - 1] = "x".repeat(1 + delta);

  const exact = prepareGeminiRequest(
    {
      prompt: "review",
      approvalStrategy: "legacy",
      optimizePrompt: false,
      operation: "gemini_request",
      includeDirs: dirs,
    },
    {
      logger: noopLogger,
      personalConfig: { settings: { enabled: false } },
    } as unknown as GatewayServerRuntime
  );
  if (!("args" in exact)) throw new Error("expected exact boundary preparation to succeed");
  expect(measureCliArgvUtf8Bytes("agy", exact.args)).toBe(MAX_CLI_ARGV_UTF8_BYTES_LINUX);
  return dirs;
}

function expectNoSessionMutation(sessionManager: ISessionManager): void {
  expect(sessionManager.getSession).not.toHaveBeenCalled();
  expect(sessionManager.createSession).not.toHaveBeenCalled();
  expect(sessionManager.updateSessionUsage).not.toHaveBeenCalled();
  expect(sessionManager.updateSessionMetadata).not.toHaveBeenCalled();
}

function overrideProcessPlatform(platform: NodeJS.Platform): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (!descriptor) throw new Error("process.platform descriptor is unavailable");
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  return () => Object.defineProperty(process, "platform", descriptor);
}

function cursorWorkspaceRegistry(path: string): WorkspaceRegistry {
  return {
    enabled: true,
    defaultAlias: null,
    allowUnregisteredWorkingDir: false,
    repos: [
      {
        alias: "r",
        path,
        providers: ["cursor"],
        allowWorktree: true,
        allowAddDir: false,
        kind: "git",
        operatorEntry: true,
      },
    ],
    allowedRoots: [],
    sources: { configFile: null },
  };
}

function exactCursorAliasBoundaryPrompt(platform: "darwin" | "win32"): {
  prompt: string;
  args: string[];
} {
  const prepared = prepareCursorRequest(
    {
      prompt: "p",
      workspace: "r",
      optimizePrompt: false,
      operation: "cursor_request",
    },
    {
      logger: noopLogger,
      personalConfig: { settings: { enabled: false } },
    } as unknown as GatewayServerRuntime
  );
  if (!("args" in prepared)) throw new Error("expected Cursor boundary preparation to succeed");

  const measure =
    platform === "win32"
      ? (args: readonly string[]) =>
          measureWindowsCmdWrapperPreflightUtf8UpperBound("cursor-agent", args)
      : (args: readonly string[]) => measureCliArgvUtf8Bytes("cursor-agent", args);
  const maximum =
    platform === "win32" ? MAX_CLI_ARGV_UTF8_BYTES_WINDOWS_CMD : MAX_CLI_ARGV_UTF8_BYTES_POSIX;
  const delta = maximum - measure(prepared.args);
  expect(delta).toBeGreaterThan(0);

  const prompt = "p".repeat(1 + delta);
  const exact = prepareCursorRequest(
    {
      prompt,
      workspace: "r",
      optimizePrompt: false,
      operation: "cursor_request",
    },
    {
      logger: noopLogger,
      personalConfig: { settings: { enabled: false } },
    } as unknown as GatewayServerRuntime
  );
  if (!("args" in exact)) throw new Error("expected exact Cursor boundary preparation to succeed");
  expect(measure(exact.args)).toBe(maximum);
  return { prompt, args: exact.args };
}

describe("final provider argv admission", () => {
  it("enforces exact Darwin and Windows fork boundaries deterministically", () => {
    const darwinArgs = ["fork", "--model", "m", "--last", "--", "p".repeat(100_000)];
    const darwinDelta =
      MAX_CLI_ARGV_UTF8_BYTES_POSIX - measureCliArgvUtf8Bytes("codex", darwinArgs);
    darwinArgs[2] = "m".repeat(1 + darwinDelta);
    expect(() =>
      assertFinalCliArgvAdmission("codex", darwinArgs, "codex fork", {
        platform: "darwin",
      })
    ).not.toThrow();
    darwinArgs[2] += "m";
    expect(() =>
      assertFinalCliArgvAdmission("codex", darwinArgs, "codex fork", {
        platform: "darwin",
      })
    ).toThrowError(CliInputTooLargeError);

    const windowsArgs = ["fork", "--model", "m", "--last", "--", "p".repeat(10_000)];
    const windowsDelta =
      MAX_CLI_ARGV_UTF8_BYTES_WINDOWS - measureWindowsCliArgvUtf8UpperBound("codex", windowsArgs);
    expect(windowsDelta).toBeGreaterThan(2);
    // Windows' conservative native quoting bound counts two bytes per caller
    // byte. Land on the nearest reachable value at or below the limit.
    windowsArgs[2] = "m".repeat(1 + Math.floor(windowsDelta / 2));
    expect(measureWindowsCliArgvUtf8UpperBound("codex", windowsArgs)).toBe(
      MAX_CLI_ARGV_UTF8_BYTES_WINDOWS - (windowsDelta % 2)
    );
    expect(() =>
      assertFinalCliArgvAdmission("codex", windowsArgs, "codex fork", {
        platform: "win32",
        windowsCommandWrapper: false,
      })
    ).not.toThrow();
    windowsArgs[2] += "m";
    expect(() =>
      assertFinalCliArgvAdmission("codex", windowsArgs, "codex fork", {
        platform: "win32",
        windowsCommandWrapper: false,
      })
    ).toThrowError(CliInputTooLargeError);
  });

  it.runIf(process.platform === "linux").each(["sync", "async"] as const)(
    "rejects Gemini %s resume aggregate before recorder, session, or job side effects",
    async mode => {
      const sessionManager = sessionManagerSpies();
      const { runtime, startJob, logStart, logComplete } = admissionRuntime(sessionManager);
      const params = {
        prompt: "review",
        sessionId: "native-gemini-session",
        resumeLatest: false,
        createNewSession: false,
        approvalStrategy: "legacy" as const,
        optimizePrompt: false,
        includeDirs: exactLinuxGeminiIncludeDirs(),
      };

      const result =
        mode === "sync"
          ? await handleGeminiRequest({ sessionManager, logger: noopLogger, runtime }, params)
          : await handleGeminiRequestAsync(
              {
                sessionManager,
                asyncJobManager: runtime.asyncJobManager,
                logger: noopLogger,
                runtime,
              },
              params
            );

      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          errorCategory: CLI_INPUT_TOO_LARGE_CATEGORY,
          retryable: false,
        },
      });
      expect(result.content[0]?.text).toContain("final argv aggregate");
      expectNoSessionMutation(sessionManager);
      expect(logStart).not.toHaveBeenCalled();
      expect(logComplete).not.toHaveBeenCalled();
      expect(startJob).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["darwin", "sync"],
    ["darwin", "async"],
    ["win32", "sync"],
    ["win32", "async"],
  ] as const)(
    "rejects Cursor %s projected workspace expansion in %s mode before side effects",
    async (platform, mode) => {
      const repository = mkdtempSync(join(tmpdir(), "cursor-native-workspace-projection-"));
      const restorePlatform = overrideProcessPlatform(platform);
      const sessionManager = sessionManagerSpies();
      const { runtime, startJob, logStart, logComplete } = admissionRuntime(sessionManager);
      runtime.workspaces = cursorWorkspaceRegistry(repository);

      try {
        const boundary = exactCursorAliasBoundaryPrompt(platform);
        const workspaceValueIndex = boundary.args.indexOf("--workspace") + 1;
        expect(workspaceValueIndex).toBeGreaterThan(0);
        const projectedArgs = [...boundary.args];
        projectedArgs[workspaceValueIndex] = repository;
        const projectedBytes =
          platform === "win32"
            ? measureWindowsCmdWrapperPreflightUtf8UpperBound("cursor-agent", projectedArgs)
            : measureCliArgvUtf8Bytes("cursor-agent", projectedArgs);
        expect(projectedBytes).toBeGreaterThan(
          platform === "win32" ? MAX_CLI_ARGV_UTF8_BYTES_WINDOWS_CMD : MAX_CLI_ARGV_UTF8_BYTES_POSIX
        );

        const params = {
          prompt: boundary.prompt,
          workspace: "r",
          optimizePrompt: false,
        };
        const result =
          mode === "sync"
            ? await handleCursorRequest({ sessionManager, logger: noopLogger, runtime }, params)
            : await handleCursorRequestAsync(
                {
                  sessionManager,
                  asyncJobManager: runtime.asyncJobManager,
                  logger: noopLogger,
                  runtime,
                },
                params
              );

        expect(result).toMatchObject({
          isError: true,
          structuredContent: {
            errorCategory: CLI_INPUT_TOO_LARGE_CATEGORY,
            retryable: false,
          },
        });
        expect(result.content[0]?.text).toContain("argv aggregate");
        expectNoSessionMutation(sessionManager);
        expect(logStart).not.toHaveBeenCalled();
        expect(logComplete).not.toHaveBeenCalled();
        expect(startJob).not.toHaveBeenCalled();
      } finally {
        restorePlatform();
        rmSync(repository, { recursive: true, force: true });
      }
    }
  );

  it.each(["sync", "async"] as const)(
    "rejects a remote Cursor alias without provider authorization in %s mode before side effects",
    async mode => {
      const repository = mkdtempSync(join(tmpdir(), "cursor-unauthorized-workspace-"));
      const sessionManager = sessionManagerSpies();
      const { runtime, startJob, logStart, logComplete } = admissionRuntime(sessionManager);
      runtime.workspaces = cursorWorkspaceRegistry(repository);
      runtime.workspaces.repos[0]!.providers = ["codex"];

      try {
        const result = await runWithRequestContext(
          { transport: "http", authKind: "gateway_bearer", authScopes: ["mcp"] },
          () =>
            mode === "sync"
              ? handleCursorRequest(
                  { sessionManager, logger: noopLogger, runtime },
                  { prompt: "review", workspace: "r", optimizePrompt: false }
                )
              : handleCursorRequestAsync(
                  {
                    sessionManager,
                    asyncJobManager: runtime.asyncJobManager,
                    logger: noopLogger,
                    runtime,
                  },
                  { prompt: "review", workspace: "r", optimizePrompt: false }
                )
        );

        expect(result).toMatchObject({ isError: true });
        expect(result.content[0]?.text).toContain('does not allow provider "cursor"');
        expectNoSessionMutation(sessionManager);
        expect(logStart).not.toHaveBeenCalled();
        expect(logComplete).not.toHaveBeenCalled();
        expect(startJob).not.toHaveBeenCalled();
      } finally {
        rmSync(repository, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform === "linux")(
    "rechecks Mistral recovery retry argv after inserting native continuation",
    () => {
      const allowedTools = [
        ...Array.from({ length: 8 }, (_, index) => `${index}${"x".repeat(119_998)}`),
        "x",
      ];
      const params = {
        effectivePrompt: "review",
        approvalStrategy: "legacy" as const,
        allowedTools,
      };
      const seed = buildMistralRetryPrep(params, "mistral-medium");
      const delta = MAX_CLI_ARGV_UTF8_BYTES_LINUX - measureCliArgvUtf8Bytes("vibe", seed.args);
      expect(delta).toBeGreaterThan(0);
      allowedTools[allowedTools.length - 1] = "x".repeat(1 + delta);
      const exact = buildMistralRetryPrep(params, "mistral-medium");
      expect(measureCliArgvUtf8Bytes("vibe", exact.args)).toBe(MAX_CLI_ARGV_UTF8_BYTES_LINUX);

      expect(() =>
        buildAdmittedMistralRetryPrep(params, "mistral-medium", ["--continue"], {
          platform: "linux",
        })
      ).toThrowError(CliInputTooLargeError);
    }
  );
});
