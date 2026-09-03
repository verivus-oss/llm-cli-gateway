import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeJobCwd, parseJobCwdScope } from "../job-cwd-scope.js";
import { MemoryJobStore, SqliteJobStore, type JobStore } from "../job-store.js";
import { openDatabase } from "../sqlite-driver.js";

/**
 * #296: a dispatched job did not record which directory it ran in, so nothing
 * durable said which AGENTS.md or CLAUDE.md the provider had loaded.
 */
describe("describeJobCwd", () => {
  it("calls an absent cwd neutral, and refuses to name the directory", () => {
    // The executor mints this directory at spawn and removes it on close, so a
    // path here would be a join that succeeds and answers nothing. That the job
    // was unscoped IS the record: no repository instruction file was reachable.
    expect(describeJobCwd(undefined)).toEqual({
      scope: "neutral",
      path: null,
      workspaceAlias: null,
    });
    expect(describeJobCwd(undefined, { effectiveWorkingDir: "/repo" })).toMatchObject({
      scope: "neutral",
      path: null,
    });
  });

  it("records unknown, not a guess, when the call site cannot describe itself", () => {
    expect(describeJobCwd("/repo")).toEqual({
      scope: "unknown",
      path: "/repo",
      workspaceAlias: null,
    });
  });

  it("separates a caller-selected directory from a workspace binding", () => {
    expect(describeJobCwd("/repo/src", { effectiveWorkingDir: "/repo/src" })).toMatchObject({
      scope: "caller",
      path: "/repo/src",
    });
    expect(describeJobCwd("/ws", { workspaceAlias: "main" })).toEqual({
      scope: "workspace",
      path: "/ws",
      workspaceAlias: "main",
    });
  });

  it("keeps the alias on a caller directory validated inside a workspace", () => {
    // A path is not a workspace identity: the binding can be repointed, so the
    // alias has to survive alongside the directory the caller chose.
    expect(
      describeJobCwd("/ws/sub", { effectiveWorkingDir: "/ws/sub", workspaceAlias: "main" })
    ).toEqual({ scope: "caller", path: "/ws/sub", workspaceAlias: "main" });
  });

  it("marks a worktree as a worktree rather than as its workspace", () => {
    expect(
      describeJobCwd("/ws/.worktrees/x", {
        worktreePath: "/ws/.worktrees/x",
        workspaceAlias: "main",
      })
    ).toMatchObject({ scope: "worktree", workspaceAlias: "main" });
  });

  it("falls back to unknown when a resolution names no binding it could have come from", () => {
    // effectiveWorkingDir lost to some other source and there is no alias, so
    // nothing in the resolution accounts for this directory.
    expect(describeJobCwd("/elsewhere", { effectiveWorkingDir: "/repo" })).toMatchObject({
      scope: "unknown",
      path: "/elsewhere",
    });
  });

  it("reads back only the values it writes", () => {
    expect(parseJobCwdScope("worktree")).toBe("worktree");
    expect(parseJobCwdScope("something-else")).toBeNull();
    expect(parseJobCwdScope(null)).toBeNull();
    expect(parseJobCwdScope(undefined)).toBeNull();
  });
});

describe("the job row carries the directory it ran in", () => {
  let tempDir: string;
  let dbPath: string;
  let store: JobStore;

  const start = async (id: string, cwd: Parameters<JobStore["recordStart"]>[0]["cwd"]) => {
    await store.recordStart({
      id,
      correlationId: `corr-${id}`,
      requestKey: `key-${id}`,
      cli: "codex",
      args: ["exec", "hello"],
      startedAt: new Date().toISOString(),
      pid: null,
      cwd,
    });
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "job-cwd-"));
    dbPath = join(tempDir, "jobs.db");
    store = new SqliteJobStore(dbPath);
  });

  afterEach(async () => {
    await store.close().catch(() => undefined);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("persists the scope, the path and the binding across a read", async () => {
    await start("j1", { scope: "workspace", path: "/ws", workspaceAlias: "main" });
    expect(await store.getById("j1")).toMatchObject({
      cwdScope: "workspace",
      cwdPath: "/ws",
      workspaceAlias: "main",
    });
  });

  it("stores neutral WITHOUT a path", async () => {
    await start("j2", { scope: "neutral", path: null, workspaceAlias: null });
    const row = await store.getById("j2");
    expect(row?.cwdScope).toBe("neutral");
    expect(row?.cwdPath).toBeNull();
  });

  it("reads a legacy row as NOT MEASURED rather than as neutral", async () => {
    // A row written before the column existed says nothing about its directory.
    // Answering "neutral" there would invent evidence that no instruction file
    // was loaded, which is the opposite of what the row knows.
    await start("j3", undefined);
    const db = openDatabase(dbPath);
    try {
      db.prepare("UPDATE jobs SET cwd_scope = NULL WHERE id = ?").run("j3");
    } finally {
      db.close();
    }
    const row = await store.getById("j3");
    expect(row?.cwdScope).toBeNull();
  });

  it("withholds the directory from a Kit row, as it withholds the argv", async () => {
    await store.recordStart({
      id: "kit-1",
      correlationId: "corr-kit-1",
      requestKey: "key-kit-1",
      cli: "codex",
      args: ["exec", "hello"],
      startedAt: new Date().toISOString(),
      pid: null,
      cwd: { scope: "caller", path: "/home/dev/private", workspaceAlias: null },
      kitSessionId: "gw-kit-session",
      kitExecution: {
        version: 1,
        releaseId: "rel-1",
        configStamp: "stamp-1",
        scopeRoot: null,
        scopeHead: null,
        contextIdentity: "ctx-1",
      } as never,
    });
    const row = await store.getById("kit-1");
    expect(row?.cwdPath).toBeNull();
    expect(row?.cwdScope).toBeNull();
  });

  it("keeps the same contract in the memory store the tests run against", async () => {
    const memory = new MemoryJobStore();
    await memory.recordStart({
      id: "m1",
      correlationId: "corr-m1",
      requestKey: "key-m1",
      cli: "grok",
      args: [],
      startedAt: new Date().toISOString(),
      pid: null,
      cwd: { scope: "worktree", path: "/ws/.worktrees/x", workspaceAlias: "main" },
    });
    expect(await memory.getById("m1")).toMatchObject({
      cwdScope: "worktree",
      cwdPath: "/ws/.worktrees/x",
      workspaceAlias: "main",
    });
  });
});
