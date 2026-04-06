import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  executeCli,
  killProcessGroup,
  killAllProcessGroups,
  registerProcessGroup,
  unregisterProcessGroup,
} from "../executor.js";
import { spawn } from "child_process";

describe("executeCli", () => {
  describe("basic execution", () => {
    it("should execute a simple command and return stdout", async () => {
      const result = await executeCli("echo", ["hello world"]);
      expect(result.stdout.trim()).toBe("hello world");
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
    });

    it("should handle commands with multiple arguments", async () => {
      const result = await executeCli("echo", ["-n", "no newline"]);
      expect(result.stdout).toBe("no newline");
      expect(result.code).toBe(0);
    });

    it("should capture stderr separately from stdout", async () => {
      const result = await executeCli("sh", ["-c", "echo stdout; echo stderr >&2"]);
      expect(result.stdout.trim()).toBe("stdout");
      expect(result.stderr.trim()).toBe("stderr");
      expect(result.code).toBe(0);
    });

    it("should return non-zero exit code on failure", async () => {
      const result = await executeCli("sh", ["-c", "exit 42"]);
      expect(result.code).toBe(42);
    });

    it("should handle empty output", async () => {
      const result = await executeCli("true", []);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
    });
  });

  describe("special characters and escaping", () => {
    it("should handle arguments with spaces", async () => {
      const result = await executeCli("echo", ["hello world with spaces"]);
      expect(result.stdout.trim()).toBe("hello world with spaces");
    });

    it("should handle arguments with quotes", async () => {
      const result = await executeCli("echo", ['hello "quoted" world']);
      expect(result.stdout.trim()).toBe('hello "quoted" world');
    });

    it("should handle arguments with single quotes", async () => {
      const result = await executeCli("echo", ["hello 'single' quotes"]);
      expect(result.stdout.trim()).toBe("hello 'single' quotes");
    });

    it("should handle arguments with newlines", async () => {
      const result = await executeCli("echo", ["line1\nline2"]);
      expect(result.stdout).toContain("line1");
    });

    it("should handle arguments with special shell characters", async () => {
      const result = await executeCli("echo", ["$HOME && || ; | > < `backticks`"]);
      expect(result.stdout.trim()).toBe("$HOME && || ; | > < `backticks`");
    });

    it("should handle unicode characters", async () => {
      const result = await executeCli("echo", ["Hello 世界 🌍 émojis"]);
      expect(result.stdout.trim()).toBe("Hello 世界 🌍 émojis");
    });

    it("should handle backslashes", async () => {
      const result = await executeCli("echo", ["path\\to\\file"]);
      expect(result.stdout).toContain("path");
    });
  });

  describe("error handling", () => {
    it("should reject when command is not found", async () => {
      await expect(executeCli("nonexistent-command-xyz", [])).rejects.toThrow();
    });

    it("should handle command that outputs to stderr and exits with error", async () => {
      const result = await executeCli("sh", ["-c", "echo error >&2; exit 1"]);
      expect(result.stderr.trim()).toBe("error");
      expect(result.code).toBe(1);
    });

    it("should handle commands that produce large output", async () => {
      const result = await executeCli("sh", ["-c", "for i in $(seq 1 1000); do echo line$i; done"]);
      expect(result.stdout).toContain("line1");
      expect(result.stdout).toContain("line1000");
      expect(result.code).toBe(0);
    });
  });

  describe("environment and PATH", () => {
    it("should have access to extended PATH", async () => {
      // The executor extends PATH to include common CLI locations
      const result = await executeCli("sh", ["-c", "echo $PATH"]);
      expect(result.stdout).toContain(".local/bin");
    });

    it("should inherit environment variables", async () => {
      const result = await executeCli("sh", ["-c", "echo $HOME"]);
      expect(result.stdout.trim()).toBeTruthy();
      expect(result.stdout.trim()).toContain("/");
    });
  });

  describe("working directory", () => {
    it("should use specified working directory", async () => {
      const result = await executeCli("pwd", [], { cwd: "/tmp" });
      expect(result.stdout.trim()).toBe("/tmp");
    });

    it("should default to current directory when cwd not specified", async () => {
      const result = await executeCli("pwd", []);
      expect(result.stdout.trim()).toBeTruthy();
    });
  });

  describe("concurrent execution", () => {
    it("should handle multiple concurrent executions", async () => {
      const promises = Array.from({ length: 5 }, (_, i) => executeCli("echo", [`message ${i}`]));
      const results = await Promise.all(promises);

      results.forEach((result, i) => {
        expect(result.stdout.trim()).toBe(`message ${i}`);
        expect(result.code).toBe(0);
      });
    });
  });

  describe("binary output handling", () => {
    it("should handle commands that output binary-like data", async () => {
      const result = await executeCli("sh", ["-c", "printf '\\x00\\x01\\x02'"]);
      // Binary data might be mangled but shouldn't crash
      expect(result.code).toBe(0);
    });
  });

  describe("idle timeout", () => {
    it("should kill process after idle timeout with no output", async () => {
      const result = await executeCli("sleep", ["30"], { idleTimeout: 500 });
      expect(result.code).toBe(125);
      expect(result.stderr).toContain("inactivity");
    }, 15000);

    it("should reset idle timer on output", async () => {
      // Process outputs every 200ms for ~1s — idle timeout of 500ms should not fire
      const result = await executeCli(
        "sh",
        ["-c", "for i in 1 2 3 4 5; do echo tick; sleep 0.2; done"],
        { idleTimeout: 500 }
      );
      expect(result.code).toBe(0);
    }, 15000);

    it("should not idle-timeout when idleTimeout is not set", async () => {
      const result = await executeCli("sleep", ["1"]);
      expect(result.code).toBe(0);
    }, 15000);

    it("should return exit code 125 distinct from wall-clock timeout 124", async () => {
      const result = await executeCli("sleep", ["30"], { idleTimeout: 300 });
      expect(result.code).toBe(125);
      expect(result.code).not.toBe(124);
    }, 15000);
  });

  describe("kill escalation", () => {
    it("should SIGKILL a process that ignores SIGTERM on idle timeout", async () => {
      // Code 125 is non-transient → no retry, completes in ~5.5s.
      // Verifies the exited flag fix: proc.killed was always true after
      // SIGTERM so SIGKILL never fired. The exited flag tracks actual exit.
      const result = await executeCli("bash", ["-c", "trap '' TERM; sleep 30"], {
        idleTimeout: 500,
      });
      expect(result.code).toBe(125);
      expect(result.stderr).toContain("inactivity");
    }, 15000);
  });

  describe("process group termination", () => {
    it("should spawn with detached:true and use process group kill", async () => {
      // Verify that a simple command still works with detached spawn
      const result = await executeCli("echo", ["process-group-test"]);
      expect(result.stdout.trim()).toBe("process-group-test");
      expect(result.code).toBe(0);
    });

    it("should handle ESRCH when killing already-dead process group", () => {
      const proc = spawn("true", [], { detached: true, stdio: "ignore" });
      proc.unref();
      // Wait for process to exit
      return new Promise<void>(resolve => {
        proc.on("close", () => {
          // Process is now dead — killProcessGroup should not throw
          const result = killProcessGroup(proc, "SIGTERM");
          expect(result).toBe(false);
          resolve();
        });
      });
    });
  });

  describe("process group registry", () => {
    it("should register and unregister process groups", () => {
      const fakePid = 9999999;
      registerProcessGroup(fakePid);
      // Should not throw
      unregisterProcessGroup(fakePid);
      // Double unregister should not throw
      unregisterProcessGroup(fakePid);
    });

    it("should resolve immediately when no process groups are registered", async () => {
      // killAllProcessGroups should return immediately when empty
      const start = Date.now();
      await killAllProcessGroups();
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(100);
    });
  });
});
