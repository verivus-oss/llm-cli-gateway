import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertCliArgUtf8Size,
  assertCliArgvUtf8Size,
  CLI_INPUT_TOO_LARGE_CATEGORY,
  CliInputTooLargeError,
  isNativeArgumentListTooLong,
  MAX_CLI_ARG_UTF8_BYTES,
  MAX_CLI_ARGV_ELEMENTS,
  MAX_CLI_ARGV_UTF8_BYTES_WINDOWS,
  MAX_CLI_ARGV_UTF8_BYTES_WINDOWS_CMD,
  measureCliArgvUtf8Bytes,
  measureWindowsCliArgvUtf8UpperBound,
  measureWindowsCmdWrapperPreflightUtf8UpperBound,
  normalizeCliInputTooLargeError,
  planCodexStdinPrompt,
} from "../cli-input-limits.js";
import { resolveCommandForSpawn, spawnCliProcess } from "../executor.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { MemoryJobStore, SqliteJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import {
  activeNeutralExecutionWorkspaceCountForTest,
  cleanupNeutralExecutionWorkspaces,
} from "../neutral-workspace.js";

describe("CLI input byte limits", () => {
  it("accepts the exact UTF-8 argv boundary and rejects one byte over", () => {
    expect(() =>
      assertCliArgUtf8Size("x".repeat(MAX_CLI_ARG_UTF8_BYTES), {
        provider: "test",
        inputName: "prompt",
      })
    ).not.toThrow();

    expect(() =>
      assertCliArgUtf8Size("x".repeat(MAX_CLI_ARG_UTF8_BYTES + 1), {
        provider: "test",
        inputName: "prompt",
      })
    ).toThrow(CliInputTooLargeError);
  });

  it("budgets encoded bytes and the provider's inline prompt prefix", () => {
    const prompt = "中".repeat(43_690);
    const promptArg = `-p=${prompt}`;

    try {
      assertCliArgUtf8Size(promptArg, { provider: "grok", inputName: "prompt" });
      throw new Error("expected prompt admission to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CliInputTooLargeError);
      expect(error).toMatchObject({
        code: "E2BIG",
        errorCategory: CLI_INPUT_TOO_LARGE_CATEGORY,
        retryable: false,
        actualUtf8Bytes: Buffer.byteLength(promptArg, "utf8"),
        maxUtf8Bytes: MAX_CLI_ARG_UTF8_BYTES,
      });
      expect((error as Error).message).not.toContain(prompt);
      expect((error as Error).message).toContain("will not truncate");
    }
  });

  it("admits the exact aggregate boundary and rejects one byte over", () => {
    const command = "provider";
    const args = ["one", "two"];
    const exact = measureCliArgvUtf8Bytes(command, args);
    expect(() =>
      assertCliArgvUtf8Size(command, args, { provider: "test", maxUtf8Bytes: exact })
    ).not.toThrow();
    expect(() =>
      assertCliArgvUtf8Size(command, args, { provider: "test", maxUtf8Bytes: exact - 1 })
    ).toThrow(
      expect.objectContaining({
        inputName: "argv aggregate",
        errorCategory: CLI_INPUT_TOO_LARGE_CATEGORY,
        retryable: false,
      })
    );
  });

  it("uses a quoting-safe Windows native command-line upper bound", () => {
    const quoteAndBackslashHeavy = `${"\\".repeat(8_000)}"`;
    const upperBound = measureWindowsCliArgvUtf8UpperBound("provider.exe", [
      quoteAndBackslashHeavy,
    ]);
    expect(upperBound).toBeGreaterThan(Buffer.byteLength(quoteAndBackslashHeavy, "utf8") * 2);
    expect(() =>
      assertCliArgvUtf8Size("provider.exe", [quoteAndBackslashHeavy], {
        provider: "test",
        platform: "win32",
        windowsCommandWrapper: false,
        maxUtf8Bytes: upperBound,
      })
    ).not.toThrow();
    expect(() =>
      assertCliArgvUtf8Size("provider.exe", [quoteAndBackslashHeavy], {
        provider: "test",
        platform: "win32",
        windowsCommandWrapper: false,
        maxUtf8Bytes: upperBound - 1,
      })
    ).toThrow(CliInputTooLargeError);
    expect(upperBound).toBeLessThan(MAX_CLI_ARGV_UTF8_BYTES_WINDOWS);
  });

  it("assumes the cmd wrapper budget during unresolved Windows provider preflight", () => {
    const wrapperHeavy = "^".repeat(4_000);
    const preflightUpperBound = measureWindowsCmdWrapperPreflightUtf8UpperBound("provider", [
      wrapperHeavy,
    ]);

    expect(preflightUpperBound).toBeGreaterThan(MAX_CLI_ARGV_UTF8_BYTES_WINDOWS_CMD);
    expect(() =>
      assertCliArgvUtf8Size("provider", [wrapperHeavy], {
        provider: "provider",
        platform: "win32",
      })
    ).toThrow(
      expect.objectContaining({
        inputName: "argv aggregate",
        maxUtf8Bytes: MAX_CLI_ARGV_UTF8_BYTES_WINDOWS_CMD,
        actualUtf8Bytes: preflightUpperBound,
      })
    );

    expect(() =>
      assertCliArgvUtf8Size("provider.exe", [wrapperHeavy], {
        provider: "provider",
        platform: "win32",
        windowsCommandWrapper: false,
      })
    ).not.toThrow();

    const shimRoot = mkdtempSync(path.join(tmpdir(), "windows-preflight-shim-"));
    const shim = path.join(shimRoot, "provider.cmd");
    try {
      writeFileSync(shim, "@echo off\r\nexit /b 0\r\n");
      const resolved = resolveCommandForSpawn(shim, [wrapperHeavy], { platform: "win32" });
      expect(resolved).toMatchObject({
        command: "cmd.exe",
        windowsVerbatimArguments: true,
      });
      expect(() =>
        assertCliArgvUtf8Size(resolved.command, resolved.args, {
          provider: "provider",
          platform: "win32",
          windowsCommandWrapper: true,
        })
      ).toThrow(
        expect.objectContaining({
          inputName: "argv aggregate",
          maxUtf8Bytes: MAX_CLI_ARGV_UTF8_BYTES_WINDOWS_CMD,
        })
      );
    } finally {
      rmSync(shimRoot, { recursive: true, force: true });
    }
  });

  it("applies the smaller limit to an already escaped Windows cmd composite", () => {
    const composite = `"provider.cmd ${"^\\".repeat(4_000)}"`;
    expect(() =>
      assertCliArgvUtf8Size("cmd.exe", ["/d", "/s", "/c", composite], {
        provider: "provider",
        platform: "win32",
        windowsCommandWrapper: true,
      })
    ).toThrow(
      expect.objectContaining({
        inputName: "argv aggregate",
        maxUtf8Bytes: MAX_CLI_ARGV_UTF8_BYTES_WINDOWS_CMD,
      })
    );
  });

  it.runIf(process.platform === "linux")(
    "rejects many individually valid elements before allocating a neutral cwd",
    () => {
      cleanupNeutralExecutionWorkspaces();
      const before = activeNeutralExecutionWorkspaceCountForTest();
      const args = Array.from({ length: 9 }, () => "x".repeat(120_000));
      expect(() =>
        spawnCliProcess("must-not-spawn-aggregate-regression", args, {
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        })
      ).toThrow(
        expect.objectContaining({
          inputName: "argv aggregate",
          errorCategory: CLI_INPUT_TOO_LARGE_CATEGORY,
          retryable: false,
        })
      );
      expect(activeNeutralExecutionWorkspaceCountForTest()).toBe(before);
    }
  );

  it("rejects too many empty argv elements before allocating a neutral cwd", () => {
    cleanupNeutralExecutionWorkspaces();
    const before = activeNeutralExecutionWorkspaceCountForTest();
    expect(() =>
      assertCliArgvUtf8Size(
        "provider",
        Array.from({ length: MAX_CLI_ARGV_ELEMENTS }, () => ""),
        {
          provider: "test",
        }
      )
    ).not.toThrow();
    const args = Array.from({ length: MAX_CLI_ARGV_ELEMENTS + 1 }, () => "");
    try {
      spawnCliProcess("must-not-spawn-argc-regression", args, {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      throw new Error("expected argv element-count admission to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CliInputTooLargeError);
      expect(error).toMatchObject({
        inputName: "argv aggregate",
        actualUtf8Bytes: null,
        maxUtf8Bytes: null,
        errorCategory: CLI_INPUT_TOO_LARGE_CATEGORY,
        retryable: false,
      });
      expect((error as Error).message).toContain(`maximum ${MAX_CLI_ARGV_ELEMENTS}`);
    }
    expect(activeNeutralExecutionWorkspaceCountForTest()).toBe(before);
  });

  it("recognizes E2BIG through retry-layer causes", () => {
    const native = Object.assign(new Error("spawn E2BIG"), { code: "E2BIG" });
    const wrapped = new Error("operation failed", { cause: native });

    expect(isNativeArgumentListTooLong(wrapped)).toBe(true);
    const normalized = normalizeCliInputTooLargeError(wrapped, {
      provider: "codex",
      inputName: "argv",
    });
    expect(normalized).toBeInstanceOf(CliInputTooLargeError);
    expect(normalized).toMatchObject({
      provider: "codex",
      inputName: "argv",
      actualUtf8Bytes: null,
      maxUtf8Bytes: null,
      retryable: false,
    });
  });

  it("does not retain native spawnargs while normalizing E2BIG", () => {
    const rawValue = "private-instruction-that-must-not-survive";
    const native = Object.assign(new Error("spawn provider E2BIG"), {
      code: "E2BIG",
      path: "provider",
      spawnargs: ["--system-prompt", rawValue],
    });
    const wrapped = new Error("launch failed", { cause: native });
    const normalized = normalizeCliInputTooLargeError(wrapped, {
      provider: "claude",
      inputName: "argv aggregate",
    });

    expect(normalized).toBeInstanceOf(CliInputTooLargeError);
    expect((normalized as Error).cause).toBeUndefined();
    expect(JSON.stringify(normalized)).not.toContain(rawValue);
    expect((normalized as Error).message).not.toContain(rawValue);
  });

  it("does not misclassify unrelated launch errors", () => {
    const enoent = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    expect(isNativeArgumentListTooLong(enoent)).toBe(false);
    expect(
      normalizeCliInputTooLargeError(enoent, { provider: "claude", inputName: "argv" })
    ).toBeNull();
  });

  it("does not trust message-only argument-list phrases as native E2BIG", () => {
    const providerControlled = new Error("Argument list too long");
    const wrapped = new Error("provider process failed", { cause: providerControlled });

    expect(isNativeArgumentListTooLong(providerControlled)).toBe(false);
    expect(isNativeArgumentListTooLong(wrapped)).toBe(false);
    expect(
      normalizeCliInputTooLargeError(wrapped, { provider: "grok", inputName: "argv" })
    ).toBeNull();
  });

  it("does not mask a wrapped timeout whose stderr contains an argument-list phrase", () => {
    const timeout = Object.assign(new Error("Argument list too long"), {
      code: 124,
      result: {
        stdout: "",
        stderr: "Argument list too long\nProcess timed out after 300ms",
        code: 124,
      },
    });
    const wrapped = Object.assign(new Error("retry wrapper", { cause: timeout }), {
      code: 124,
      result: timeout.result,
    });

    expect(isNativeArgumentListTooLong(wrapped)).toBe(false);
    expect(
      normalizeCliInputTooLargeError(wrapped, { provider: "codex", inputName: "argv" })
    ).toBeNull();
    expect(wrapped.result.code).toBe(124);
  });

  it("plans Codex stdin without rewriting a literal dash prompt", () => {
    expect(planCodexStdinPrompt("review this")).toEqual({
      argument: "-",
      stdin: "review this",
    });
    expect(planCodexStdinPrompt("-")).toEqual({ argument: "-", stdin: "-" });
  });

  it.runIf(process.platform !== "win32")(
    "rejects an oversized final argv element at the spawn chokepoint",
    () => {
      expect(() => {
        spawnCliProcess("/bin/true", ["x".repeat(4 * 1024 * 1024)], {
          cwd: "/",
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
      }).toThrow(
        expect.objectContaining({
          provider: "/bin/true",
          inputName: "argv aggregate",
          errorCategory: CLI_INPUT_TOO_LARGE_CATEGORY,
          retryable: false,
        })
      );
    }
  );

  it.runIf(process.platform !== "win32")(
    "terminalizes and persists an async native E2BIG launch failure",
    async () => {
      const store = new MemoryJobStore();
      const manager = new AsyncJobManager(noopLogger, undefined, store);
      try {
        const started = manager.startJob(
          "codex",
          ["x".repeat(4 * 1024 * 1024)],
          "corr-native-e2big",
          "/"
        );

        expect(started).toMatchObject({
          status: "failed",
          exitCode: 126,
          errorCategory: CLI_INPUT_TOO_LARGE_CATEGORY,
          retryable: false,
          exited: true,
        });
        expect(started.finishedAt).not.toBeNull();
        expect(started.error).toContain("too large");

        const durable = store.getById(started.id);
        expect(durable).toMatchObject({
          status: "failed",
          exitCode: 126,
          errorCategory: CLI_INPUT_TOO_LARGE_CATEGORY,
          retryable: false,
        });
        expect(durable?.finishedAt).not.toBeNull();

        expect(manager.getJobResult(started.id)).toMatchObject({
          errorCategory: CLI_INPUT_TOO_LARGE_CATEGORY,
          retryable: false,
        });
      } finally {
        await manager.dispose();
      }
    }
  );

  it.runIf(process.platform !== "win32")(
    "hydrates async E2BIG classification from a restarted durable store",
    async () => {
      const tempDir = mkdtempSync(path.join(tmpdir(), "gateway-e2big-durable-"));
      const dbPath = path.join(tempDir, "jobs.db");
      const firstStore = new SqliteJobStore(dbPath);
      const firstManager = new AsyncJobManager(noopLogger, undefined, firstStore);
      let jobId = "";
      try {
        const started = firstManager.startJob(
          "codex",
          ["x".repeat(4 * 1024 * 1024)],
          "corr-durable-e2big",
          "/"
        );
        jobId = started.id;
        expect(started).toMatchObject({
          status: "failed",
          errorCategory: CLI_INPUT_TOO_LARGE_CATEGORY,
          retryable: false,
        });
      } finally {
        await firstManager.dispose();
        firstStore.close();
      }

      const restartedStore = new SqliteJobStore(dbPath);
      const restartedManager = new AsyncJobManager(noopLogger, undefined, restartedStore);
      try {
        expect(restartedManager.getJobSnapshot(jobId)).toMatchObject({
          status: "failed",
          exitCode: 126,
          errorCategory: CLI_INPUT_TOO_LARGE_CATEGORY,
          retryable: false,
        });
        expect(restartedManager.getJobResult(jobId)).toMatchObject({
          status: "failed",
          errorCategory: CLI_INPUT_TOO_LARGE_CATEGORY,
          retryable: false,
        });
      } finally {
        await restartedManager.dispose();
        restartedStore.close();
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  );
});
