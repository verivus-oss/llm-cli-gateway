import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AsyncJobManager } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";

describe.runIf(process.platform !== "win32")("job progress wire capability", () => {
  it("reports Codex validation and review without --json as activity only", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-progress-wire-"));
    const executable = join(root, "codex");
    writeFileSync(executable, "#!/bin/sh\nsleep 30\n", "utf8");
    chmodSync(executable, 0o755);
    const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    const env = { PATH: root };

    try {
      const validation = manager.startJobWithDedup(
        "codex",
        ["exec", "--skip-git-repo-check", "--", "-"],
        "codex-validation-progress",
        { cwd: root, stdin: "validation prompt", env, forceRefresh: true }
      );
      const review = manager.startJobWithDedup(
        "codex",
        ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--", "-"],
        "codex-review-progress",
        { cwd: root, stdin: "review prompt", env, forceRefresh: true }
      );
      const jsonl = manager.startJobWithDedup(
        "codex",
        ["exec", "--json", "--skip-git-repo-check", "--", "-"],
        "codex-jsonl-progress",
        { cwd: root, stdin: "direct request prompt", env, forceRefresh: true }
      );
      const promptNamedJson = manager.startJobWithDedup(
        "codex",
        ["exec", "--skip-git-repo-check", "--", "--json"],
        "codex-prompt-named-json-progress",
        { cwd: root, env, forceRefresh: true }
      );

      expect(validation.snapshot.progress.capability).toBe("activity_only");
      expect(review.snapshot.progress.capability).toBe("activity_only");
      expect(jsonl.snapshot.progress.capability).toBe("structured");
      expect(promptNamedJson.snapshot.progress.capability).toBe("activity_only");

      manager.cancelJob(validation.snapshot.id);
      manager.cancelJob(review.snapshot.id);
      manager.cancelJob(jsonl.snapshot.id);
      manager.cancelJob(promptNamedJson.snapshot.id);
    } finally {
      await manager.dispose({ timeoutMs: 2_000 });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
