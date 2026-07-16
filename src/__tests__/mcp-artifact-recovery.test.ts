import { randomUUID } from "crypto";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { hostname, tmpdir } from "os";
import { dirname, join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildClaudeMcpConfig } from "../claude-mcp-config.js";
import { SqliteJobStore } from "../job-store.js";
import {
  MCP_ARTIFACT_RECOVERY_ACKNOWLEDGEMENT,
  recoverMcpArtifactCleanupPin,
} from "../mcp-artifact-recovery.js";

describe("MCP artifact cleanup pin recovery", () => {
  let originalHome: string | undefined;
  let testHome: string;
  let store: SqliteJobStore;

  beforeEach(() => {
    originalHome = process.env.HOME;
    testHome = mkdtempSync(join(tmpdir(), "mcp-artifact-recovery-"));
    process.env.HOME = testHome;
    store = new SqliteJobStore(join(testHome, "jobs.db"));
  });

  afterEach(() => {
    store.close();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(testHome, { recursive: true, force: true });
  });

  function seedTerminalArtifactPin(
    id: string,
    artifactPath: string,
    artifactScope: string,
    ownerHostname = hostname()
  ): void {
    store.recordStart({
      id,
      correlationId: `corr-${id}`,
      requestKey: `key-${id}`,
      cli: "claude",
      args: ["-p", "review", "--mcp-config", artifactPath],
      startedAt: new Date().toISOString(),
      pid: null,
      ownerInstance: `owner-${id}`,
      ownerHostname,
      mcpArtifactPath: artifactPath,
      mcpArtifactScope: artifactScope,
      transport: "process",
    });
    store.recordComplete({
      id,
      status: "completed",
      exitCode: 0,
      stdout: "",
      stderr: "",
      outputTruncated: false,
      error: null,
      finishedAt: new Date().toISOString(),
    });
  }

  function recover(id: string) {
    return recoverMcpArtifactCleanupPin({
      store,
      jobId: id,
      acknowledgement: MCP_ARTIFACT_RECOVERY_ACKNOWLEDGEMENT,
    });
  }

  it("safely removes the exact generated artifact then acknowledges its one row", () => {
    const config = buildClaudeMcpConfig(["sqry"]);
    const id = randomUUID();
    seedTerminalArtifactPin(id, config.path, config.artifactScope!);

    const result = recover(id);

    expect(result).toEqual({ ok: true, jobId: id, outcome: "removed_and_acknowledged" });
    expect(existsSync(config.path)).toBe(false);
    expect(store.getById(id)?.mcpArtifactCleanupPending).toBe(false);
  });

  it("allows explicit recovery of an already absent config only after scope proof", () => {
    const config = buildClaudeMcpConfig(["sqry"]);
    const id = randomUUID();
    seedTerminalArtifactPin(id, config.path, config.artifactScope!);
    config.cleanup?.();
    expect(existsSync(config.path)).toBe(false);

    const result = recover(id);

    expect(result).toEqual({
      ok: true,
      jobId: id,
      outcome: "verified_absent_and_acknowledged",
    });
    expect(store.getById(id)?.mcpArtifactCleanupPending).toBe(false);
  });

  it("retains a pin when its captured request namespace is gone", () => {
    const config = buildClaudeMcpConfig(["sqry"]);
    const id = randomUUID();
    seedTerminalArtifactPin(id, config.path, config.artifactScope!);
    unlinkSync(config.path);
    rmSync(dirname(config.path), { recursive: true, force: true });

    const result = recover(id);

    expect(result).toMatchObject({
      ok: false,
      jobId: id,
      outcome: "refused",
      reason: "artifact_not_safely_recoverable",
    });
    expect(store.getById(id)?.mcpArtifactCleanupPending).toBe(true);
  });

  it("cannot authorize a foreign host or a same-host foreign scope", () => {
    const foreignHostConfig = buildClaudeMcpConfig(["sqry"]);
    const foreignHostId = randomUUID();
    seedTerminalArtifactPin(
      foreignHostId,
      foreignHostConfig.path,
      foreignHostConfig.artifactScope!,
      "other-gateway-host"
    );

    const foreignScopeConfig = buildClaudeMcpConfig(["sqry"]);
    const foreignScopeId = randomUUID();
    seedTerminalArtifactPin(
      foreignScopeId,
      foreignScopeConfig.path,
      "v2:foreign-installation:1:1:request.1.00000000-0000-4000-8000-000000000000:foreign:1:1"
    );

    expect(recover(foreignHostId)).toMatchObject({
      ok: false,
      reason: "foreign_or_unknown_host",
    });
    expect(recover(foreignScopeId)).toMatchObject({
      ok: false,
      reason: "artifact_not_safely_recoverable",
    });
    expect(existsSync(foreignHostConfig.path)).toBe(true);
    expect(existsSync(foreignScopeConfig.path)).toBe(true);
    expect(store.getById(foreignHostId)?.mcpArtifactCleanupPending).toBe(true);
    expect(store.getById(foreignScopeId)?.mcpArtifactCleanupPending).toBe(true);
  });

  it("cannot turn an arbitrary durable path into filesystem authority", () => {
    const id = randomUUID();
    const sentinel = join(testHome, "must-not-delete.txt");
    writeFileSync(sentinel, "sentinel", "utf8");
    seedTerminalArtifactPin(id, sentinel, "not-a-gateway-scope");

    const result = recover(id);

    expect(result).toMatchObject({
      ok: false,
      jobId: id,
      outcome: "refused",
      reason: "artifact_not_safely_recoverable",
    });
    expect(existsSync(sentinel)).toBe(true);
    expect(store.getById(id)?.mcpArtifactCleanupPending).toBe(true);
  });

  it("requires an explicit acknowledgement and rejects nonterminal rows", () => {
    const config = buildClaudeMcpConfig(["sqry"]);
    const id = randomUUID();
    store.recordStart({
      id,
      correlationId: `corr-${id}`,
      requestKey: `key-${id}`,
      cli: "claude",
      args: ["-p", "review", "--mcp-config", config.path],
      startedAt: new Date().toISOString(),
      pid: null,
      ownerHostname: hostname(),
      mcpArtifactPath: config.path,
      mcpArtifactScope: config.artifactScope,
      transport: "process",
    });

    expect(
      recoverMcpArtifactCleanupPin({ store, jobId: id, acknowledgement: "not-acknowledged" })
    ).toMatchObject({ ok: false, reason: "acknowledgement_required" });
    expect(recover(id)).toMatchObject({ ok: false, reason: "not_terminal_claude_process_job" });
    expect(existsSync(config.path)).toBe(true);
    expect(store.getById(id)?.mcpArtifactCleanupPending).toBe(true);
  });
});
