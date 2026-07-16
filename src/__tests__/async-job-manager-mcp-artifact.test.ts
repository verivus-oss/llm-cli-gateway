import fs, {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { syncBuiltinESMExports } from "module";
import os, { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { randomUUID } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncJobManager, type LlmCli } from "../async-job-manager.js";
import { buildClaudeMcpConfig, getClaudeMcpArtifactScopeForPath } from "../claude-mcp-config.js";
import { SqliteJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import { openDatabase } from "../sqlite-driver.js";

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("waitFor timed out"));
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

function deadPid(): number {
  for (const pid of [999_999, 9_999_999, 99_999_999]) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("Unable to find a definitely-dead test PID");
}

describe("AsyncJobManager Claude MCP artifacts", () => {
  let originalHome: string | undefined;
  let testHome: string;
  let dbPath: string;
  let store: SqliteJobStore;
  let manager: AsyncJobManager;

  beforeEach(() => {
    originalHome = process.env.HOME;
    testHome = mkdtempSync(join(tmpdir(), "async-mcp-artifact-home-"));
    process.env.HOME = testHome;
    dbPath = join(testHome, "jobs.db");
    store = new SqliteJobStore(dbPath);
    manager = new AsyncJobManager(noopLogger, undefined, store);
  });

  afterEach(async () => {
    await manager?.dispose();
    store?.close();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(testHome, { recursive: true, force: true });
  });

  function seedExpiredProcessRow(
    id: string,
    args: string[],
    hostname: string | null,
    pid = deadPid(),
    mcpArtifactPath?: string,
    mcpArtifactScope?: string
  ): string {
    const ownerInstance = `dead-owner-${id}`;
    store.registerInstance({
      instanceId: ownerInstance,
      role: "gateway",
      hostname,
      pid,
    });
    store.recordStart({
      id,
      correlationId: `corr-${id}`,
      requestKey: `key-${id}`,
      cli: "claude",
      args,
      startedAt: new Date().toISOString(),
      pid,
      ownerInstance,
      ownerHostname: hostname,
      mcpArtifactPath,
      mcpArtifactScope:
        mcpArtifactPath === undefined
          ? undefined
          : (mcpArtifactScope ?? getClaudeMcpArtifactScopeForPath(mcpArtifactPath)),
      transport: "process",
    });
    expect(store.markRunning(id, { pid })).toBe(true);
    const db = openDatabase(dbPath);
    try {
      db.prepare("UPDATE jobs SET lease_deadline = 1 WHERE id = ?").run(id);
    } finally {
      db.close();
    }
    return ownerInstance;
  }

  function seedExpiredQueuedRow(
    id: string,
    args: string[],
    hostname: string | null,
    mcpArtifactPath?: string,
    mcpArtifactScope?: string
  ): void {
    const ownerInstance = `dead-owner-${id}`;
    store.registerInstance({
      instanceId: ownerInstance,
      role: "gateway",
      hostname,
      pid: deadPid(),
    });
    store.recordStart({
      id,
      correlationId: `corr-${id}`,
      requestKey: `key-${id}`,
      cli: "claude",
      args,
      startedAt: new Date().toISOString(),
      pid: null,
      ownerInstance,
      ownerHostname: hostname,
      mcpArtifactPath,
      mcpArtifactScope:
        mcpArtifactPath === undefined
          ? undefined
          : (mcpArtifactScope ?? getClaudeMcpArtifactScopeForPath(mcpArtifactPath)),
      transport: "process",
    });
    const db = openDatabase(dbPath);
    try {
      db.prepare("UPDATE jobs SET lease_deadline = 1 WHERE id = ?").run(id);
    } finally {
      db.close();
    }
  }

  function expireLease(id: string): void {
    const db = openDatabase(dbPath);
    try {
      db.prepare("UPDATE jobs SET lease_deadline = 1 WHERE id = ?").run(id);
    } finally {
      db.close();
    }
  }

  it("reclaims only a local, confirmed-orphan generated config", () => {
    const valid = buildClaudeMcpConfig(["sqry"]);
    const queued = buildClaudeMcpConfig(["sqry"]);
    const remote = buildClaudeMcpConfig(["sqry"]);
    const live = buildClaudeMcpConfig(["sqry"]);
    const sentinel = join(testHome, "must-not-delete.txt");
    writeFileSync(sentinel, "sentinel", "utf8");
    const symlinkArtifactDirectory = join(
      dirname(dirname(valid.path)),
      `request.${process.pid}.${randomUUID()}`
    );
    mkdirSync(symlinkArtifactDirectory, { mode: 0o700 });
    const symlinkArtifact = join(symlinkArtifactDirectory, "config.json");
    symlinkSync(sentinel, symlinkArtifact);

    seedExpiredProcessRow(
      "valid",
      ["-p", "review", "--mcp-config", valid.path],
      os.hostname(),
      deadPid(),
      valid.path
    );
    seedExpiredQueuedRow(
      "queued",
      ["-p", "review", "--mcp-config", queued.path],
      os.hostname(),
      queued.path
    );
    seedExpiredProcessRow("outside", ["-p", "review", "--mcp-config", sentinel], os.hostname());
    seedExpiredProcessRow(
      "symlink",
      ["-p", "review", "--mcp-config", symlinkArtifact],
      os.hostname()
    );
    seedExpiredProcessRow(
      "remote",
      ["-p", "review", "--mcp-config", remote.path],
      "other-gateway-host",
      deadPid(),
      remote.path
    );
    seedExpiredProcessRow(
      "live",
      ["-p", "review", "--mcp-config", live.path],
      os.hostname(),
      process.pid,
      live.path
    );

    manager.runOrphanSweepNow();

    expect(store.getById("valid")?.status).toBe("orphaned");
    expect(existsSync(valid.path)).toBe(false);
    expect(store.getById("queued")?.status).toBe("orphaned");
    expect(existsSync(queued.path)).toBe(false);
    expect(store.getById("outside")?.status).toBe("orphaned");
    expect(existsSync(sentinel)).toBe(true);
    expect(store.getById("symlink")?.status).toBe("orphaned");
    expect(existsSync(symlinkArtifact)).toBe(true);
    expect(store.getById("remote")?.status).toBe("orphaned");
    expect(existsSync(remote.path)).toBe(true);
    expect(store.getById("live")?.status).toBe("running");
    expect(existsSync(live.path)).toBe(true);
  });

  it("reclaims a local artifact after the one-shot live-PID grace expires", () => {
    const config = buildClaudeMcpConfig(["sqry"]);
    seedExpiredProcessRow(
      "graced",
      ["-p", "review", "--mcp-config", config.path],
      os.hostname(),
      process.pid,
      config.path
    );

    manager.runOrphanSweepNow();
    expect(store.getById("graced")?.status).toBe("running");
    expect(store.getById("graced")?.pid).toBeNull();
    expect(existsSync(config.path)).toBe(true);

    expireLease("graced");
    manager.runOrphanSweepNow();

    expect(store.getById("graced")?.status).toBe("orphaned");
    expect(existsSync(config.path)).toBe(false);
  });

  it("reconciles a local artifact already orphaned by another workstation", async () => {
    const config = buildClaudeMcpConfig(["sqry"]);
    const ownerInstance = seedExpiredProcessRow(
      "cross-host",
      ["-p", "review", "--mcp-config", config.path],
      os.hostname(),
      deadPid(),
      config.path
    );

    // This is the durable transition a different workstation can make. It has
    // no access to this workstation's HOME, so the local artifact remains.
    expect(store.recoverStaleJobs(90_000, 300_000)).toHaveLength(1);
    expect(store.getById("cross-host")?.status).toBe("orphaned");
    expect(existsSync(config.path)).toBe(true);

    // The old owner instance can be garbage-collected before its workstation
    // returns. Reconciliation must use the job's durable hostname snapshot,
    // not this short-lived observability row.
    const db = openDatabase(dbPath);
    try {
      db.prepare("UPDATE gateway_instances SET last_heartbeat = 1 WHERE instance_id = ?").run(
        ownerInstance
      );
    } finally {
      db.close();
    }
    expect(store.gcInstances(90_000)).toBe(1);

    await manager.dispose();
    const restarted = new AsyncJobManager(noopLogger, undefined, store);
    try {
      expect(existsSync(config.path)).toBe(false);
    } finally {
      await restarted.dispose();
    }
  });

  it("pins an expired cross-host orphan until its origin acknowledges exact artifact cleanup", async () => {
    const config = buildClaudeMcpConfig(["sqry"]);
    seedExpiredProcessRow(
      "retention-pinned-cross-host",
      ["-p", "review", "--mcp-config", config.path],
      os.hostname(),
      deadPid(),
      config.path
    );

    // A different workstation performs the durable orphan transition. It must
    // not touch this workstation's HOME, and retention must not erase the only
    // exact-path cleanup record before this origin returns.
    expect(store.recoverStaleJobs(90_000, 300_000)).toHaveLength(1);
    const db = openDatabase(dbPath);
    try {
      db.prepare("UPDATE jobs SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(
        "retention-pinned-cross-host"
      );
    } finally {
      db.close();
    }
    expect(store.evictExpired()).toBe(0);
    expect(store.getById("retention-pinned-cross-host")).toMatchObject({
      status: "orphaned",
      mcpArtifactPath: config.path,
      mcpArtifactCleanupPending: true,
    });
    expect(existsSync(config.path)).toBe(true);

    await manager.dispose();
    const restarted = new AsyncJobManager(noopLogger, undefined, store);
    try {
      expect(existsSync(config.path)).toBe(false);
      expect(store.getById("retention-pinned-cross-host")?.mcpArtifactCleanupPending).toBe(false);

      const afterAck = openDatabase(dbPath);
      try {
        afterAck
          .prepare("UPDATE jobs SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?")
          .run("retention-pinned-cross-host");
      } finally {
        afterAck.close();
      }
      expect(store.evictExpired()).toBe(1);
    } finally {
      await restarted.dispose();
    }
  });

  it("does not acknowledge a same-host foreign-scope artifact when its local path is absent", async () => {
    const config = buildClaudeMcpConfig(["sqry"]);
    const foreignScope = "foreign-installation:1:1";
    seedExpiredProcessRow(
      "same-host-foreign-scope",
      ["-p", "review", "--mcp-config", config.path],
      os.hostname(),
      deadPid(),
      config.path,
      foreignScope
    );

    // A second installation can share the hostname and durable database while
    // having an isolated filesystem. Model its absent local path explicitly:
    // without the scope predicate, ENOENT would be treated as a successful
    // cleanup and permanently clear this origin installation's retention pin.
    expect(store.recoverStaleJobs(90_000, 300_000)).toHaveLength(1);
    config.cleanup?.();
    expect(existsSync(config.path)).toBe(false);
    await manager.dispose();
    const restarted = new AsyncJobManager(noopLogger, undefined, store);
    try {
      expect(existsSync(config.path)).toBe(false);
      expect(store.getById("same-host-foreign-scope")).toMatchObject({
        mcpArtifactPath: config.path,
        mcpArtifactScope: foreignScope,
        mcpArtifactCleanupPending: true,
      });
      expect(store.evictExpired()).toBe(0);
    } finally {
      await restarted.dispose();
    }
  });

  it("keeps a same-scope absent artifact retention-pinned", async () => {
    const config = buildClaudeMcpConfig(["sqry"]);
    seedExpiredProcessRow(
      "same-scope-absent",
      ["-p", "review", "--mcp-config", config.path],
      os.hostname(),
      deadPid(),
      config.path,
      config.artifactScope
    );

    expect(store.recoverStaleJobs(90_000, 300_000)).toHaveLength(1);
    const db = openDatabase(dbPath);
    try {
      db.prepare("UPDATE jobs SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(
        "same-scope-absent"
      );
    } finally {
      db.close();
    }
    config.cleanup?.();
    expect(existsSync(config.path)).toBe(false);

    await manager.dispose();
    const restarted = new AsyncJobManager(noopLogger, undefined, store);
    try {
      expect(store.getById("same-scope-absent")?.mcpArtifactCleanupPending).toBe(true);
      expect(store.evictExpired()).toBe(0);
    } finally {
      await restarted.dispose();
    }
  });

  it("acknowledges a terminal artifact only after its own confirmed unlink", async () => {
    const config = buildClaudeMcpConfig(["sqry"]);
    const originalPath = process.env.PATH;
    process.env.PATH = join(testHome, "empty-bin");
    try {
      const started = manager.startJobWithDedup(
        "claude",
        ["-p", "review", "--mcp-config", config.path],
        "confirmed-terminal-artifact-unlink",
        {
          forceRefresh: true,
          artifactCleanup: config.cleanup,
          mcpArtifactPath: config.path,
          mcpArtifactScope: config.artifactScope,
        }
      );
      await waitFor(() => manager.getJobSnapshot(started.snapshot.id)?.exited === true);

      expect(existsSync(config.path)).toBe(false);
      expect(store.getById(started.snapshot.id)?.mcpArtifactCleanupPending).toBe(false);
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  });

  it.skipIf(process.platform !== "linux")(
    "acknowledges only the descriptor-pinned original after a cross-scope unlink race",
    async () => {
      const config = buildClaudeMcpConfig(["sqry"]);
      const rootDirectory = dirname(dirname(config.path));
      const artifactDirectoryName = basename(dirname(config.path));
      const movedRootDirectory = join(testHome, "moved-terminal-race-root");
      const originalArtifactPath = join(movedRootDirectory, artifactDirectoryName, "config.json");
      const originalUnlinkSync = fs.unlinkSync;
      let replacementInjected = false;
      const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation(path => {
        const pathname = String(path);
        if (
          !replacementInjected &&
          pathname.startsWith("/proc/self/fd/") &&
          pathname.endsWith("/config.json")
        ) {
          replacementInjected = true;
          renameSync(rootDirectory, movedRootDirectory);
          mkdirSync(join(rootDirectory, artifactDirectoryName), { recursive: true, mode: 0o700 });
          writeFileSync(config.path, "replacement must survive", "utf8");
        }
        return originalUnlinkSync(path);
      });
      syncBuiltinESMExports();

      const originalPath = process.env.PATH;
      process.env.PATH = join(testHome, "empty-bin");
      try {
        const started = manager.startJobWithDedup(
          "claude",
          ["-p", "review", "--mcp-config", config.path],
          "descriptor-pinned-terminal-acknowledgement",
          {
            forceRefresh: true,
            artifactCleanup: config.cleanup,
            mcpArtifactPath: config.path,
            mcpArtifactScope: config.artifactScope,
          }
        );
        await waitFor(() => manager.getJobSnapshot(started.snapshot.id)?.exited === true);

        expect(replacementInjected).toBe(true);
        expect(readFileSync(config.path, "utf8")).toBe("replacement must survive");
        expect(existsSync(originalArtifactPath)).toBe(false);
        expect(store.getById(started.snapshot.id)?.mcpArtifactCleanupPending).toBe(false);
      } finally {
        if (originalPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = originalPath;
        }
        unlinkSpy.mockRestore();
        syncBuiltinESMExports();
      }
    }
  );

  it("retains an unsafe terminal artifact when the generic cleanup closure runs", async () => {
    const config = buildClaudeMcpConfig(["sqry"]);
    const sentinel = join(testHome, "unsafe-terminal-artifact-sentinel.txt");
    writeFileSync(sentinel, "must remain", "utf8");
    unlinkSync(config.path);
    symlinkSync(sentinel, config.path);
    const genericCleanup = vi.fn(() => config.cleanup?.());

    const originalPath = process.env.PATH;
    process.env.PATH = join(testHome, "empty-bin");
    try {
      const started = manager.startJobWithDedup(
        "claude",
        ["-p", "review", "--mcp-config", config.path],
        "unsafe-terminal-artifact-generic-cleanup",
        {
          forceRefresh: true,
          artifactCleanup: genericCleanup,
          mcpArtifactPath: config.path,
          mcpArtifactScope: config.artifactScope,
        }
      );
      await waitFor(() => manager.getJobSnapshot(started.snapshot.id)?.exited === true);

      expect(existsSync(config.path)).toBe(true);
      expect(existsSync(sentinel)).toBe(true);
      expect(genericCleanup).toHaveBeenCalledTimes(1);
      expect(store.getById(started.snapshot.id)).toMatchObject({
        mcpArtifactPath: config.path,
        mcpArtifactScope: config.artifactScope,
        mcpArtifactCleanupPending: true,
      });
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  });

  it("retains its pin when an unsafe directory replacement reaches terminal cleanup", async () => {
    const config = buildClaudeMcpConfig(["sqry"]);
    const artifactDirectory = dirname(config.path);
    const movedArtifactDirectory = join(testHome, "moved-terminal-artifact-directory");
    const binDirectory = join(testHome, "bin");
    const fakeClaude = join(binDirectory, "claude");
    mkdirSync(binDirectory, { recursive: true });
    writeFileSync(fakeClaude, "#!/bin/sh\n/bin/sleep 0.4\nexit 1\n", {
      encoding: "utf8",
      mode: 0o755,
    });
    const genericCleanup = vi.fn(() => config.cleanup?.());

    const originalPath = process.env.PATH;
    process.env.PATH = binDirectory;
    try {
      const started = manager.startJobWithDedup(
        "claude",
        ["-p", "review", "--mcp-config", config.path],
        "unsafe-directory-terminal-cleanup",
        {
          forceRefresh: true,
          artifactCleanup: genericCleanup,
          mcpArtifactPath: config.path,
          mcpArtifactScope: config.artifactScope,
        }
      );
      await waitFor(() => manager.getJobSnapshot(started.snapshot.id)?.status === "running");
      renameSync(artifactDirectory, movedArtifactDirectory);
      symlinkSync(movedArtifactDirectory, artifactDirectory, "dir");

      await waitFor(() => manager.getJobSnapshot(started.snapshot.id)?.exited === true);

      expect(lstatSync(artifactDirectory).isSymbolicLink()).toBe(true);
      expect(existsSync(config.path)).toBe(true);
      expect(genericCleanup).toHaveBeenCalledTimes(1);
      expect(store.getById(started.snapshot.id)).toMatchObject({
        mcpArtifactPath: config.path,
        mcpArtifactScope: config.artifactScope,
        mcpArtifactCleanupPending: true,
      });
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  });

  it("retains an artifact pin when its directory changes before startup reconciliation", async () => {
    const config = buildClaudeMcpConfig(["sqry"]);
    const artifactDirectory = dirname(config.path);
    const replacedDirectory = join(testHome, "replaced-during-cleanup");
    const originalArtifactPath = join(replacedDirectory, basename(config.path));
    seedExpiredProcessRow(
      "directory-replacement-during-cleanup",
      ["-p", "review", "--mcp-config", config.path],
      os.hostname(),
      deadPid(),
      config.path,
      config.artifactScope
    );

    expect(store.recoverStaleJobs(90_000, 300_000)).toHaveLength(1);
    renameSync(artifactDirectory, replacedDirectory);
    mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });

    // Startup reconciliation must read the replacement scope before it touches
    // the row. It must not treat the absent replacement pathname as cleanup of
    // the original file in the renamed directory.
    await manager.dispose();
    const restarted = new AsyncJobManager(noopLogger, undefined, store);
    try {
      expect(existsSync(config.path)).toBe(false);
      expect(existsSync(originalArtifactPath)).toBe(true);
      expect(store.getById("directory-replacement-during-cleanup")).toMatchObject({
        mcpArtifactScope: config.artifactScope,
        mcpArtifactCleanupPending: true,
      });
    } finally {
      await restarted.dispose();
    }
  });

  it("retains a pinned orphan whose captured artifact scope is missing", async () => {
    const config = buildClaudeMcpConfig(["sqry"]);
    seedExpiredProcessRow(
      "missing-artifact-scope",
      ["-p", "review", "--mcp-config", config.path],
      os.hostname(),
      deadPid(),
      config.path,
      config.artifactScope
    );
    expect(store.recoverStaleJobs(90_000, 300_000)).toHaveLength(1);
    const db = openDatabase(dbPath);
    try {
      db.prepare("UPDATE jobs SET mcp_artifact_scope = NULL WHERE id = ?").run(
        "missing-artifact-scope"
      );
    } finally {
      db.close();
    }

    await manager.dispose();
    const restarted = new AsyncJobManager(noopLogger, undefined, store);
    try {
      expect(existsSync(config.path)).toBe(true);
      expect(store.getById("missing-artifact-scope")).toMatchObject({
        mcpArtifactScope: null,
        mcpArtifactCleanupPending: true,
      });
    } finally {
      await restarted.dispose();
    }
  });

  it("fails closed when an artifact directory is replaced before durable admission", () => {
    const config = buildClaudeMcpConfig(["sqry"]);
    const artifactDirectory = dirname(config.path);
    const replacedDirectory = join(testHome, "replaced-claude-mcp");
    const originalArtifactPath = join(replacedDirectory, basename(config.path));

    expect(config.artifactScope).toBe(getClaudeMcpArtifactScopeForPath(config.path));
    renameSync(artifactDirectory, replacedDirectory);
    mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });

    expect(() =>
      manager.startJobWithDedup(
        "claude",
        ["-p", "review", "--mcp-config", config.path],
        "directory-replacement-before-admission",
        {
          forceRefresh: true,
          artifactCleanup: config.cleanup,
          mcpArtifactPath: config.path,
          mcpArtifactScope: config.artifactScope,
        }
      )
    ).toThrow(/artifact directory changed before durable admission/);
    expect(existsSync(config.path)).toBe(false);
    expect(existsSync(originalArtifactPath)).toBe(true);

    // A caller that reclaims its unhanded request resource must not unlink a
    // same-named replacement-path file or mistake the original artifact as
    // cleaned after its directory identity changed.
    config.cleanup?.();
    expect(existsSync(originalArtifactPath)).toBe(true);
  });

  it("rejects Kit plus MCP provenance before a durable row or attempt fence is written", () => {
    const config = buildClaudeMcpConfig(["sqry"]);
    const jobId = randomUUID();
    const kitExecution = {
      version: 1 as const,
      releaseId: "kit-artifact-admission-release",
      configStamp: "kit-artifact-admission-stamp",
      scopeRoot: "/workspace/kit-artifact-admission",
      scopeHead: "kit-artifact-admission-head",
      contextIdentity: "kit-artifact-admission-context",
    };

    expect(() =>
      manager.startJobWithDedup(
        "claude",
        ["-p", "review", "--mcp-config", config.path],
        "kit-artifact-admission",
        {
          forceRefresh: true,
          jobId,
          kitExecution,
          kitSessionId: "kit-artifact-admission-session",
          mcpArtifactPath: config.path,
          mcpArtifactScope: config.artifactScope,
        }
      )
    ).toThrow(/Kit jobs cannot carry Claude MCP artifact provenance/);
    expect(store.getById(jobId)).toBeNull();

    const db = openDatabase(dbPath);
    try {
      const fence = db
        .prepare("SELECT attempt_id FROM kit_attempt_fences WHERE attempt_id = ?")
        .get(jobId);
      expect(fence).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("waits for close before cleaning an artifact after cancellation", async () => {
    const cleanup = vi.fn();
    const job = manager.startJobWithDedup(
      "bash" as LlmCli,
      ["-c", "trap 'sleep 0.4; exit 0' TERM; while true; do sleep 1; done"],
      "mcp-artifact-cancel",
      { artifactCleanup: cleanup }
    );
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(manager.cancelJob(job.snapshot.id).canceled).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(cleanup).not.toHaveBeenCalled();

      await waitFor(() => manager.getJobSnapshot(job.snapshot.id)?.exited === true);
      expect(cleanup).toHaveBeenCalledTimes(1);
    } finally {
      manager.cancelJob(job.snapshot.id);
    }
  }, 15000);
});
