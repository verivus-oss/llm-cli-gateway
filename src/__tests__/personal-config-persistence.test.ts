import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { AsyncJobManager, type LlmCli } from "../async-job-manager.js";
import type { PersistenceConfig } from "../config.js";
import {
  NoopFlightRecorder,
  type CompressionTelemetry,
  type FlightLogResult,
  type FlightLogStart,
  type FlightRecorderLike,
} from "../flight-recorder.js";
import { createGatewayServer } from "../index.js";
import { MemoryJobStore, SqliteJobStore, computeRequestKey } from "../job-store.js";
import { openDatabase } from "../sqlite-driver.js";
import type {
  KitExecutionRef,
  KitSessionAttempt,
  KitSessionBinding,
} from "../personal-config-types.js";
import { isKitSessionBinding, kitScopeKey } from "../personal-config-types.js";
import { runWithRequestContext } from "../request-context.js";
import {
  assertKitSessionManagerStorageHealthy,
  FileSessionManager,
  FileSessionStorageFaultError,
  kitActiveSessionKey,
} from "../session-manager.js";

function execution(overrides: Partial<KitExecutionRef> = {}): KitExecutionRef {
  return {
    version: 1,
    releaseId: "release-a",
    configStamp: "stamp-a",
    scopeRoot: "/workspace/a",
    scopeHead: "head-a",
    contextIdentity: "context-a",
    ...overrides,
  };
}

function binding(overrides: Partial<KitSessionBinding> = {}): KitSessionBinding {
  return {
    execution: execution(),
    nativeSessionId: "11111111-1111-4111-8111-111111111111",
    resumeEligible: true,
    ...overrides,
  };
}

function attempt(overrides: Partial<KitSessionAttempt> = {}): KitSessionAttempt {
  const now = Date.now();
  return {
    id: "attempt-a",
    kind: "durable",
    acquiredAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    expectedNativeSessionId: "11111111-1111-4111-8111-111111111111",
    ...overrides,
  };
}

function requestContext(principal: string) {
  return {
    transport: "http" as const,
    authKind: "oauth" as const,
    authScopes: [],
    authPrincipal: principal,
  };
}

function waitForDone(manager: AsyncJobManager, jobId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5_000;
    const check = (): void => {
      const status = manager.getJobSnapshot(jobId)?.status;
      if (status && status !== "queued" && status !== "running") {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("job did not finish"));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

function persistence(path: string): PersistenceConfig {
  return {
    backend: "sqlite",
    path,
    dsn: null,
    retentionDays: 30,
    dedupWindowMs: 0,
    acknowledgeEphemeral: false,
    ownsOrphanRecovery: false,
    instanceHeartbeatMs: 15_000,
    instanceLeaseTtlMs: 90_000,
    httpJobGraceMs: 300_000,
    orphanSweepIntervalMs: 30_000,
    instanceGcMs: 3_600_000,
    asyncJobsEnabled: true,
    sources: { configFile: null, envOverrides: [] },
  };
}

class CompressionCapturingFlightRecorder extends NoopFlightRecorder {
  readonly compression: Array<{ correlationId: string; telemetry: CompressionTelemetry }> = [];

  override recordCompressionTelemetry(
    correlationId: string,
    telemetry: CompressionTelemetry
  ): void {
    this.compression.push({ correlationId, telemetry });
  }
}

describe("Personal Agent Config Kit persistence", () => {
  let testDir: string | null = null;

  afterEach(() => {
    if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    testDir = null;
  });

  it("keeps active Kit sessions scoped by provider and canonical workspace", () => {
    testDir = join(
      tmpdir(),
      `kit-session-test-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
    const manager = new FileSessionManager(join(testDir, "sessions.json"));
    const one = binding();
    const two = binding({
      execution: execution({
        releaseId: "release-b",
        configStamp: "stamp-b",
        scopeRoot: "/workspace/b",
        scopeHead: "head-b",
        contextIdentity: "context-b",
      }),
      nativeSessionId: "22222222-2222-4222-8222-222222222222",
    });

    const first = manager.createKitSession("claude", one);
    const second = manager.createKitSession("claude", two);

    expect(manager.getActiveKitSession("claude", "/workspace/a", one.execution)?.id).toBe(first.id);
    expect(manager.getActiveKitSession("claude", "/workspace/b", two.execution)?.id).toBe(
      second.id
    );
    expect(manager.getActiveKitSession("claude", "/workspace/a", two.execution)).toBeNull();
    // A mismatched request does not erase the valid pointer for the original stamp.
    expect(manager.getActiveKitSession("claude", "/workspace/a", one.execution)?.id).toBe(first.id);
    expect(manager.getActiveSession("claude")).toBeNull();
    expect(manager.getPinnedKitReleaseIds()).toEqual([]);
  });

  it("rewrites exact historical Kit pointer keys without crossing owners", async () => {
    testDir = join(
      tmpdir(),
      `kit-session-legacy-pointer-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
    const storagePath = join(testDir, "sessions.json");
    const manager = new FileSessionManager(storagePath);
    const kitBinding = binding();
    const session = await runWithRequestContext(requestContext("alice"), () =>
      manager.createKitSession("claude", kitBinding)
    );
    const storage = JSON.parse(readFileSync(storagePath, "utf8")) as {
      activeKitSession: Record<string, Record<string, string>>;
    };
    const canonicalKey = kitActiveSessionKey(
      kitBinding.execution.scopeRoot,
      kitBinding.execution,
      "alice"
    );
    const legacyKey = kitScopeKey(
      kitBinding.execution.scopeRoot,
      kitBinding.execution.configStamp,
      "alice"
    );
    delete storage.activeKitSession.claude[canonicalKey];
    storage.activeKitSession.claude[legacyKey] = session.id;
    writeFileSync(storagePath, JSON.stringify(storage), "utf8");

    const reloaded = new FileSessionManager(storagePath);
    const activeForAlice = await runWithRequestContext(requestContext("alice"), () =>
      reloaded.getActiveKitSession("claude", kitBinding.execution.scopeRoot, kitBinding.execution)
    );
    const activeForBob = await runWithRequestContext(requestContext("bob"), () =>
      reloaded.getActiveKitSession("claude", kitBinding.execution.scopeRoot, kitBinding.execution)
    );
    expect(activeForAlice?.id).toBe(session.id);
    expect(activeForBob).toBeNull();

    const rewritten = JSON.parse(readFileSync(storagePath, "utf8")) as {
      activeKitSession: Record<string, Record<string, string>>;
    };
    expect(rewritten.activeKitSession.claude).toEqual({ [canonicalKey]: session.id });
  });

  it("accepts root-only legacy pointers only for local sessions and rejects collisions", async () => {
    testDir = join(
      tmpdir(),
      `kit-session-legacy-root-pointer-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
    const storagePath = join(testDir, "sessions.json");
    const manager = new FileSessionManager(storagePath);
    const localBinding = binding();
    const localSession = manager.createKitSession("claude", localBinding);
    const localStorage = JSON.parse(readFileSync(storagePath, "utf8")) as {
      activeKitSession: Record<string, Record<string, string>>;
    };
    const localCanonical = kitActiveSessionKey(
      localBinding.execution.scopeRoot,
      localBinding.execution,
      "local"
    );
    delete localStorage.activeKitSession.claude[localCanonical];
    localStorage.activeKitSession.claude[kitScopeKey(localBinding.execution.scopeRoot)] =
      localSession.id;
    writeFileSync(storagePath, JSON.stringify(localStorage), "utf8");
    const localReloaded = new FileSessionManager(storagePath);
    expect(
      localReloaded.getActiveKitSession(
        "claude",
        localBinding.execution.scopeRoot,
        localBinding.execution
      )?.id
    ).toBe(localSession.id);

    const remoteBinding = binding({
      execution: execution({ contextIdentity: "remote-root-only-legacy-pointer" }),
    });
    const remoteSession = await runWithRequestContext(requestContext("alice"), () =>
      localReloaded.createKitSession("claude", remoteBinding)
    );
    const remoteStorage = JSON.parse(readFileSync(storagePath, "utf8")) as {
      activeKitSession: Record<string, Record<string, string>>;
    };
    const remoteCanonical = kitActiveSessionKey(
      remoteBinding.execution.scopeRoot,
      remoteBinding.execution,
      "alice"
    );
    delete remoteStorage.activeKitSession.claude[remoteCanonical];
    remoteStorage.activeKitSession.claude[kitScopeKey(remoteBinding.execution.scopeRoot)] =
      remoteSession.id;
    writeFileSync(storagePath, JSON.stringify(remoteStorage), "utf8");
    const remoteFault = new FileSessionManager(storagePath);
    expect(() => assertKitSessionManagerStorageHealthy(remoteFault)).toThrow(
      FileSessionStorageFaultError
    );

    const collisionManager = new FileSessionManager(join(testDir, "collision-sessions.json"));
    const first = collisionManager.createKitSession("claude", localBinding);
    const second = collisionManager.createKitSession("claude", localBinding);
    const collisionStorage = JSON.parse(
      readFileSync(join(testDir, "collision-sessions.json"), "utf8")
    ) as { activeKitSession: Record<string, Record<string, string>> };
    collisionStorage.activeKitSession.claude[kitScopeKey(localBinding.execution.scopeRoot)] =
      second.id;
    writeFileSync(
      join(testDir, "collision-sessions.json"),
      JSON.stringify(collisionStorage),
      "utf8"
    );
    const collisionFault = new FileSessionManager(join(testDir, "collision-sessions.json"));
    expect(() => assertKitSessionManagerStorageHealthy(collisionFault)).toThrow(
      FileSessionStorageFaultError
    );
    expect(first.id).not.toBe(second.id);
  });

  it("get-or-creates one exact Kit session per execution and principal", async () => {
    testDir = join(
      tmpdir(),
      `kit-session-get-or-create-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
    const manager = new FileSessionManager(join(testDir, "sessions.json"));
    const firstBinding = binding();
    const sameScopeDifferentExecution = binding({
      execution: execution({ scopeHead: "head-b", contextIdentity: "context-b" }),
      nativeSessionId: "22222222-2222-4222-8222-222222222222",
    });

    const concurrent = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        Promise.resolve().then(() =>
          manager.getOrCreateKitSession("claude", firstBinding, undefined, `candidate-${index}`)
        )
      )
    );
    expect(new Set(concurrent.map(session => session.id))).toHaveLength(1);

    const second = manager.getOrCreateKitSession("claude", sameScopeDifferentExecution);
    expect(second.id).not.toBe(concurrent[0].id);
    expect(manager.getActiveKitSession("claude", "/workspace/a", firstBinding.execution)?.id).toBe(
      concurrent[0].id
    );
    expect(
      manager.getActiveKitSession("claude", "/workspace/a", sameScopeDifferentExecution.execution)
        ?.id
    ).toBe(second.id);

    const alice = await runWithRequestContext(requestContext("alice"), () =>
      manager.getOrCreateKitSession("claude", firstBinding)
    );
    const bob = await runWithRequestContext(requestContext("bob"), () =>
      manager.getOrCreateKitSession("claude", firstBinding)
    );
    expect(alice.id).not.toBe(bob.id);
    expect(
      (
        await runWithRequestContext(requestContext("alice"), () =>
          manager.getOrCreateKitSession("claude", firstBinding)
        )
      ).id
    ).toBe(alice.id);
  });

  it("reloads under the file-store lock before Kit pointer and attempt mutations", () => {
    testDir = join(
      tmpdir(),
      `kit-session-file-lock-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
    const storagePath = join(testDir, "sessions.json");
    const first = new FileSessionManager(storagePath);
    const stalePointerContender = new FileSessionManager(storagePath);
    const pendingBinding = binding({
      resumeEligible: false,
      attempt: attempt({ id: "prebound-attempt" }),
    });

    const firstSession = first.getOrCreateKitSession(
      "claude",
      pendingBinding,
      undefined,
      "first-pending-session"
    );
    const secondSession = stalePointerContender.getOrCreateKitSession(
      "claude",
      pendingBinding,
      undefined,
      "second-pending-session"
    );
    expect(secondSession.id).toBe(firstSession.id);
    expect(secondSession.metadata?.kit?.attempt?.id).toBe("prebound-attempt");

    const leaseBinding = binding({
      execution: execution({ contextIdentity: "file-lock-attempt-context" }),
      resumeEligible: false,
    });
    const leaseSession = first.createKitSession("claude", leaseBinding);
    const staleAttemptContender = new FileSessionManager(storagePath);
    expect(
      first.claimKitSessionAttempt(
        "claude",
        leaseBinding.execution.scopeRoot,
        leaseBinding.execution,
        leaseSession.id,
        attempt({ id: "winning-file-attempt" })
      )
    ).toBe(true);
    expect(
      staleAttemptContender.claimKitSessionAttempt(
        "claude",
        leaseBinding.execution.scopeRoot,
        leaseBinding.execution,
        leaseSession.id,
        attempt({ id: "losing-file-attempt" })
      )
    ).toBe(false);

    const invalidAttempt = attempt({
      acquiredAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:00:00.000Z",
    });
    expect(() =>
      first.createKitSession(
        "claude",
        binding({
          execution: execution({ contextIdentity: "invalid-attempt-context" }),
          attempt: invalidAttempt,
        })
      )
    ).toThrow("Invalid Personal Agent Config Kit session binding");
  });

  it("retains a corrupt Kit session file without allocating a competing lease", () => {
    testDir = join(
      tmpdir(),
      `kit-session-storage-fault-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
    const storagePath = join(testDir, "sessions.json");
    const manager = new FileSessionManager(storagePath);
    const leaseBinding = binding({ resumeEligible: false });
    const session = manager.createKitSession("claude", leaseBinding);
    const heldAttempt = attempt({ id: "held-storage-fault-attempt" });
    expect(
      manager.claimKitSessionAttempt(
        "claude",
        leaseBinding.execution.scopeRoot,
        leaseBinding.execution,
        session.id,
        heldAttempt
      )
    ).toBe(true);
    const validReplacement = readFileSync(storagePath, "utf8");
    const corrupt = "{ active Kit lease is unreadable";
    writeFileSync(storagePath, corrupt, "utf8");

    const contender = new FileSessionManager(storagePath);
    expect(() =>
      contender.getActiveKitSession(
        "claude",
        leaseBinding.execution.scopeRoot,
        leaseBinding.execution
      )
    ).toThrow(FileSessionStorageFaultError);
    expect(() =>
      contender.getOrCreateKitSession(
        "claude",
        leaseBinding,
        "Competing Kit Session",
        "competing-storage-fault-session"
      )
    ).toThrow(FileSessionStorageFaultError);
    expect(() =>
      contender.claimKitSessionAttempt(
        "claude",
        leaseBinding.execution.scopeRoot,
        leaseBinding.execution,
        session.id,
        attempt({ id: "competing-storage-fault-attempt" })
      )
    ).toThrow(FileSessionStorageFaultError);
    expect(readFileSync(storagePath, "utf8")).toBe(corrupt);

    // A repaired, fully valid replacement is the only transition out of the
    // fault state. The exact existing lease is then visible again.
    writeFileSync(storagePath, validReplacement, "utf8");
    expect(() => assertKitSessionManagerStorageHealthy(contender)).not.toThrow();
    const recovered = contender.getOrCreateKitSession("claude", leaseBinding);
    expect(recovered.id).toBe(session.id);
    expect(recovered.metadata?.kit?.attempt?.id).toBe(heldAttempt.id);
    const restored = JSON.parse(readFileSync(storagePath, "utf8")) as {
      sessions: Record<string, unknown>;
      activeKitSession: Record<string, Record<string, string>>;
    };
    expect(Object.keys(restored.sessions)).toEqual([session.id]);
    expect(
      restored.activeKitSession.claude[
        kitActiveSessionKey(leaseBinding.execution.scopeRoot, leaseBinding.execution, "local")
      ]
    ).toBe(session.id);
  });

  it("fails closed for malformed Kit metadata and pointer records", () => {
    testDir = join(
      tmpdir(),
      `kit-session-malformed-storage-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
    const storagePath = join(testDir, "sessions.json");
    const manager = new FileSessionManager(storagePath);
    const kitBinding = binding();
    const session = manager.createKitSession("claude", kitBinding);
    const validStorage = JSON.parse(readFileSync(storagePath, "utf8")) as {
      sessions: Record<string, { metadata?: { kit?: unknown } }>;
      activeKitSession: Record<string, Record<string, string>>;
    };

    validStorage.sessions[session.id].metadata!.kit = { malformed: true };
    const malformedMetadata = JSON.stringify(validStorage);
    writeFileSync(storagePath, malformedMetadata, "utf8");
    const metadataFault = new FileSessionManager(storagePath);
    expect(() => metadataFault.getPinnedKitReleaseIds()).toThrow(FileSessionStorageFaultError);
    expect(() => metadataFault.createKitSession("claude", kitBinding)).toThrow(
      FileSessionStorageFaultError
    );
    expect(readFileSync(storagePath, "utf8")).toBe(malformedMetadata);

    const pointerStorage = JSON.parse(readFileSync(storagePath, "utf8")) as {
      sessions: Record<string, { metadata?: { kit?: unknown } }>;
      activeKitSession: Record<string, Record<string, string>>;
    };
    pointerStorage.sessions[session.id].metadata!.kit = kitBinding;
    pointerStorage.activeKitSession.claude[
      kitActiveSessionKey(kitBinding.execution.scopeRoot, kitBinding.execution, "local")
    ] = "missing-kit-session";
    const malformedPointer = JSON.stringify(pointerStorage);
    writeFileSync(storagePath, malformedPointer, "utf8");
    const pointerFault = new FileSessionManager(storagePath);
    expect(() =>
      pointerFault.getActiveKitSession(
        "claude",
        kitBinding.execution.scopeRoot,
        kitBinding.execution
      )
    ).toThrow(FileSessionStorageFaultError);
    expect(() =>
      pointerFault.setActiveKitSession(
        "claude",
        kitBinding.execution.scopeRoot,
        session.id,
        kitBinding.execution
      )
    ).toThrow(FileSessionStorageFaultError);
    expect(readFileSync(storagePath, "utf8")).toBe(malformedPointer);
  });

  it("conditionally clears only the current exact Kit pointer", async () => {
    testDir = join(
      tmpdir(),
      `kit-session-conditional-clear-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
    const manager = new FileSessionManager(join(testDir, "sessions.json"));
    const targetBinding = binding();
    const target = manager.createKitSession("claude", targetBinding);
    const unpointed = manager.createKitSession("claude", targetBinding);
    const differentExecution = execution({ contextIdentity: "context-different" });

    expect(
      manager.clearActiveKitSessionIfCurrent(
        "claude",
        "/workspace/a",
        targetBinding.execution,
        unpointed.id
      )
    ).toBe(false);
    expect(
      manager.clearActiveKitSessionIfCurrent(
        "claude",
        "/workspace/a",
        differentExecution,
        target.id
      )
    ).toBe(false);
    expect(manager.getActiveKitSession("claude", "/workspace/a", targetBinding.execution)?.id).toBe(
      target.id
    );
    expect(
      manager.clearActiveKitSessionIfCurrent(
        "claude",
        "/workspace/a",
        targetBinding.execution,
        target.id
      )
    ).toBe(true);
    expect(
      manager.getActiveKitSession("claude", "/workspace/a", targetBinding.execution)
    ).toBeNull();

    const alice = await runWithRequestContext(requestContext("alice"), () =>
      manager.createKitSession("claude", targetBinding)
    );
    expect(
      await runWithRequestContext(requestContext("bob"), () =>
        manager.clearActiveKitSessionIfCurrent(
          "claude",
          "/workspace/a",
          targetBinding.execution,
          alice.id
        )
      )
    ).toBe(false);
    expect(
      (
        await runWithRequestContext(requestContext("alice"), () =>
          manager.getActiveKitSession("claude", "/workspace/a", targetBinding.execution)
        )
      )?.id
    ).toBe(alice.id);
  });

  it("keeps legacy-unowned Kit pointers local-only", async () => {
    testDir = join(
      tmpdir(),
      `kit-session-legacy-owner-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
    const storagePath = join(testDir, "sessions.json");
    const manager = new FileSessionManager(storagePath);
    const legacyBinding = binding();
    const legacy = manager.createKitSession("claude", legacyBinding);
    const storage = JSON.parse(readFileSync(storagePath, "utf8")) as {
      sessions: Record<string, { ownerPrincipal?: string | null }>;
    };
    storage.sessions[legacy.id].ownerPrincipal = null;
    writeFileSync(storagePath, JSON.stringify(storage));

    expect(
      await runWithRequestContext(requestContext("remote-user"), () =>
        manager.getActiveKitSession(
          "claude",
          legacyBinding.execution.scopeRoot,
          legacyBinding.execution
        )
      )
    ).toBeNull();
    expect(
      await runWithRequestContext(requestContext("remote-user"), () =>
        manager.setActiveKitSession(
          "claude",
          legacyBinding.execution.scopeRoot,
          legacy.id,
          legacyBinding.execution
        )
      )
    ).toBe(false);
    expect(
      manager.getActiveKitSession(
        "claude",
        legacyBinding.execution.scopeRoot,
        legacyBinding.execution
      )?.id
    ).toBe(legacy.id);
  });

  it("continues a held legacy-unowned local Kit attempt without allocating a second session", async () => {
    testDir = join(
      tmpdir(),
      `kit-session-legacy-local-attempt-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
    const storagePath = join(testDir, "sessions.json");
    const manager = new FileSessionManager(storagePath);
    const legacyBinding = binding({ resumeEligible: false });
    const legacy = manager.createKitSession("claude", legacyBinding);
    const heldAttempt = attempt({ id: "legacy-local-held-attempt" });
    expect(
      manager.claimKitSessionAttempt(
        "claude",
        legacyBinding.execution.scopeRoot,
        legacyBinding.execution,
        legacy.id,
        heldAttempt
      )
    ).toBe(true);

    const storage = JSON.parse(readFileSync(storagePath, "utf8")) as {
      sessions: Record<string, { ownerPrincipal?: string | null }>;
    };
    storage.sessions[legacy.id].ownerPrincipal = null;
    writeFileSync(storagePath, JSON.stringify(storage), "utf8");

    const reloaded = new FileSessionManager(storagePath);
    const resolved = reloaded.getOrCreateKitSession("claude", legacyBinding);
    expect(resolved.id).toBe(legacy.id);
    expect(resolved.metadata?.kit?.attempt?.id).toBe(heldAttempt.id);
    expect(Object.keys(JSON.parse(readFileSync(storagePath, "utf8")).sessions)).toEqual([
      legacy.id,
    ]);

    expect(
      await runWithRequestContext(requestContext("remote-user"), () =>
        reloaded.renewKitSessionAttempt(
          "claude",
          legacyBinding.execution.scopeRoot,
          legacyBinding.execution,
          legacy.id,
          heldAttempt.id,
          new Date(Date.now() + 120_000).toISOString()
        )
      )
    ).toBe(false);
    expect(
      reloaded.renewKitSessionAttempt(
        "claude",
        legacyBinding.execution.scopeRoot,
        legacyBinding.execution,
        legacy.id,
        heldAttempt.id,
        new Date(Date.now() + 120_000).toISOString()
      )
    ).toBe(true);
    expect(
      reloaded.releaseKitSessionAttempt(
        "claude",
        legacyBinding.execution.scopeRoot,
        legacyBinding.execution,
        legacy.id,
        heldAttempt.id
      )
    ).toBe(true);

    const terminalAttempt = attempt({ id: "legacy-local-terminal-attempt" });
    expect(
      reloaded.claimKitSessionAttempt(
        "claude",
        legacyBinding.execution.scopeRoot,
        legacyBinding.execution,
        legacy.id,
        terminalAttempt
      )
    ).toBe(true);
    const terminalBinding = binding({
      execution: legacyBinding.execution,
      nativeSessionId: "33333333-3333-4333-8333-333333333333",
      resumeEligible: false,
    });
    expect(reloaded.updateKitSessionBinding(legacy.id, terminalBinding, terminalAttempt.id)).toBe(
      true
    );
    expect(
      reloaded.clearActiveKitSessionIfCurrent(
        "claude",
        legacyBinding.execution.scopeRoot,
        legacyBinding.execution,
        legacy.id
      )
    ).toBe(true);
    expect(
      JSON.parse(readFileSync(storagePath, "utf8")).sessions[legacy.id].ownerPrincipal
    ).toBeNull();
  });

  it("keeps active Kit pointers but retires persisted resumable sessions", () => {
    testDir = join(
      tmpdir(),
      `kit-session-ttl-parity-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
    const storagePath = join(testDir, "sessions.json");
    const manager = new FileSessionManager(storagePath, 1_000);
    const activeBinding = binding({
      execution: execution({ contextIdentity: "ttl-active", releaseId: "release-active" }),
      resumeEligible: false,
    });
    const resumableBinding = binding({
      execution: execution({ contextIdentity: "ttl-resumable", releaseId: "release-resumable" }),
      resumeEligible: true,
    });
    const retiredBinding = binding({
      execution: execution({ contextIdentity: "ttl-retired", releaseId: "release-retired" }),
      resumeEligible: false,
    });
    const active = manager.createKitSession("claude", activeBinding);
    const resumable = manager.createKitSession("codex", resumableBinding);
    const retired = manager.createKitSession("gemini", retiredBinding);

    expect(
      manager.clearActiveKitSessionIfCurrent(
        "codex",
        resumableBinding.execution.scopeRoot,
        resumableBinding.execution,
        resumable.id
      )
    ).toBe(true);
    expect(
      manager.clearActiveKitSessionIfCurrent(
        "gemini",
        retiredBinding.execution.scopeRoot,
        retiredBinding.execution,
        retired.id
      )
    ).toBe(true);

    const storage = JSON.parse(readFileSync(storagePath, "utf8")) as {
      sessions: Record<string, { lastUsedAt: string }>;
    };
    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    storage.sessions[active.id].lastUsedAt = expiredAt;
    storage.sessions[resumable.id].lastUsedAt = expiredAt;
    storage.sessions[retired.id].lastUsedAt = expiredAt;
    writeFileSync(storagePath, JSON.stringify(storage));

    const reloaded = new FileSessionManager(storagePath, 1_000);
    expect(
      reloaded
        .listSessions()
        .map(session => session.id)
        .sort()
    ).toEqual([active.id]);
    expect(
      reloaded.getActiveKitSession(
        "claude",
        activeBinding.execution.scopeRoot,
        activeBinding.execution
      )?.id
    ).toBe(active.id);
    expect(reloaded.getSession(resumable.id)).toBeNull();
    expect(reloaded.getPinnedKitReleaseIds()).toEqual([]);
    expect(reloaded.getSession(retired.id)).toBeNull();
  });

  it("leases exact bindings, protects them from TTL, and requires a matching terminal holder", async () => {
    testDir = join(
      tmpdir(),
      `kit-session-attempt-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
    const storagePath = join(testDir, "sessions.json");
    const manager = new FileSessionManager(storagePath, 1_000);
    const leaseBinding = binding({ resumeEligible: false });
    const session = manager.createKitSession("claude", leaseBinding);
    const heldAttempt = attempt();

    expect(
      manager.claimKitSessionAttempt(
        "claude",
        leaseBinding.execution.scopeRoot,
        leaseBinding.execution,
        session.id,
        heldAttempt
      )
    ).toBe(true);
    expect(await manager.getPinnedKitReleaseIds()).toEqual(["release-a"]);
    expect(
      manager.claimKitSessionAttempt(
        "claude",
        leaseBinding.execution.scopeRoot,
        leaseBinding.execution,
        session.id,
        attempt({ id: "attempt-b" })
      )
    ).toBe(false);
    expect(
      await runWithRequestContext(requestContext("other-principal"), () =>
        manager.claimKitSessionAttempt(
          "claude",
          leaseBinding.execution.scopeRoot,
          leaseBinding.execution,
          session.id,
          attempt({ id: "other-attempt" })
        )
      )
    ).toBe(false);

    const storage = JSON.parse(readFileSync(storagePath, "utf8")) as {
      sessions: Record<string, { lastUsedAt: string }>;
    };
    storage.sessions[session.id].lastUsedAt = new Date(Date.now() - 60 * 60 * 1_000).toISOString();
    writeFileSync(storagePath, JSON.stringify(storage));
    expect(manager.getSession(session.id)?.id).toBe(session.id);

    const terminalBinding = binding({
      execution: leaseBinding.execution,
      nativeSessionId: "33333333-3333-4333-8333-333333333333",
      resumeEligible: false,
    });
    expect(manager.updateSessionMetadata(session.id, { kit: terminalBinding })).toBe(false);
    expect(manager.updateKitSessionBinding(session.id, terminalBinding)).toBe(false);
    expect(manager.updateKitSessionBinding(session.id, terminalBinding, "stale-attempt")).toBe(
      false
    );
    expect(manager.getSession(session.id)?.metadata?.kit?.attempt?.id).toBe(heldAttempt.id);
    expect(
      manager.renewKitSessionAttempt(
        "claude",
        leaseBinding.execution.scopeRoot,
        leaseBinding.execution,
        session.id,
        heldAttempt.id,
        new Date(Date.now() + 120_000).toISOString()
      )
    ).toBe(true);
    expect(manager.updateKitSessionBinding(session.id, terminalBinding, heldAttempt.id)).toBe(true);
    expect(manager.getSession(session.id)?.metadata?.kit?.attempt).toBeUndefined();
    expect(manager.getPinnedKitReleaseIds()).toEqual([]);
    expect(
      manager.releaseKitSessionAttempt(
        "claude",
        leaseBinding.execution.scopeRoot,
        leaseBinding.execution,
        session.id,
        heldAttempt.id
      )
    ).toBe(false);
  });

  it("retires native handles from retained terminal bindings", () => {
    testDir = join(
      tmpdir(),
      `kit-terminal-retry-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
    const manager = new FileSessionManager(join(testDir, "sessions.json"));
    const leaseBinding = binding({ resumeEligible: false });
    const session = manager.createKitSession("claude", leaseBinding);
    const heldAttempt = attempt({ id: "retained-terminal-attempt" });
    expect(
      manager.claimKitSessionAttempt(
        "claude",
        leaseBinding.execution.scopeRoot,
        leaseBinding.execution,
        session.id,
        heldAttempt
      )
    ).toBe(true);

    const terminalNativeId = "abababab-abab-4bab-8bab-abababababab";
    const retainedTerminalBinding = binding({
      execution: leaseBinding.execution,
      nativeSessionId: terminalNativeId,
      resumeEligible: true,
      attempt: { ...heldAttempt, expectedNativeSessionId: terminalNativeId },
    });
    // A crash after session finalization must not leave a provider-native
    // continuation in the durable lease. The retry remains fenced by attempt id.
    expect(
      manager.updateKitSessionBinding(session.id, retainedTerminalBinding, heldAttempt.id)
    ).toBe(true);
    expect(
      manager.updateKitSessionBinding(session.id, retainedTerminalBinding, heldAttempt.id)
    ).toBe(true);
    const persisted = JSON.parse(readFileSync(join(testDir, "sessions.json"), "utf8")) as {
      sessions: Record<string, { metadata?: { kit?: KitSessionBinding } }>;
    };
    expect(persisted.sessions[session.id]?.metadata?.kit?.nativeSessionId).toBeNull();
    expect(persisted.sessions[session.id]?.metadata?.kit?.resumeEligible).toBe(false);
    expect(persisted.sessions[session.id]?.metadata?.kit?.attempt?.expectedNativeSessionId).toBe(
      null
    );
    expect(JSON.stringify(persisted)).not.toContain(terminalNativeId);
    expect(
      manager.releaseKitSessionAttempt(
        "claude",
        leaseBinding.execution.scopeRoot,
        leaseBinding.execution,
        session.id,
        heldAttempt.id
      )
    ).toBe(true);
  });

  it("scrubs legacy provider handles when the file session store reopens", () => {
    testDir = join(
      tmpdir(),
      `kit-file-session-handle-scrub-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
    const storagePath = join(testDir, "sessions.json");
    const manager = new FileSessionManager(storagePath);
    const session = manager.createKitSession(
      "claude",
      binding({ nativeSessionId: null, resumeEligible: false })
    );
    const legacyNativeHandle = "f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0";
    const legacy = JSON.parse(readFileSync(storagePath, "utf8")) as {
      sessions: Record<string, { metadata?: { kit?: KitSessionBinding } }>;
    };
    const legacyBinding = legacy.sessions[session.id]?.metadata?.kit;
    expect(legacyBinding).toBeDefined();
    legacyBinding!.nativeSessionId = legacyNativeHandle;
    legacyBinding!.resumeEligible = true;
    writeFileSync(storagePath, JSON.stringify(legacy));

    const reopened = new FileSessionManager(storagePath);
    const stored = readFileSync(storagePath, "utf8");
    expect(stored).not.toContain(legacyNativeHandle);
    expect(reopened.getSession(session.id)?.metadata?.kit?.nativeSessionId).toBeNull();
    expect(reopened.getSession(session.id)?.metadata?.kit?.resumeEligible).toBe(false);
  });

  it("rejects malformed native handles in durable Kit metadata", () => {
    const privateContext = "PRIVATE_INVALID_NATIVE_HANDLE";
    expect(isKitSessionBinding(binding({ nativeSessionId: privateContext }))).toBe(false);
    expect(
      isKitSessionBinding(
        binding({ attempt: attempt({ expectedNativeSessionId: privateContext }) })
      )
    ).toBe(false);
  });

  it("does not replace an expired durable attempt without an explicit release", () => {
    testDir = join(
      tmpdir(),
      `kit-session-expired-attempt-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
    const manager = new FileSessionManager(join(testDir, "sessions.json"));
    const expiredBinding = binding({
      execution: execution({ contextIdentity: "expired-attempt-context" }),
      nativeSessionId: null,
      resumeEligible: false,
      attempt: attempt({
        id: "expired-attempt",
        acquiredAt: new Date(Date.now() - 120_000).toISOString(),
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        expectedNativeSessionId: null,
      }),
    });
    const session = manager.createKitSession("claude", expiredBinding);
    const replacement = attempt({ id: "replacement-attempt", expectedNativeSessionId: null });

    expect(
      manager.claimKitSessionAttempt(
        "claude",
        expiredBinding.execution.scopeRoot,
        expiredBinding.execution,
        session.id,
        replacement
      )
    ).toBe(false);
    expect(manager.getPinnedKitReleaseIds()).toEqual(["release-a"]);
    expect(
      manager.releaseKitSessionAttempt(
        "claude",
        expiredBinding.execution.scopeRoot,
        expiredBinding.execution,
        session.id,
        "expired-attempt"
      )
    ).toBe(true);
    expect(
      manager.claimKitSessionAttempt(
        "claude",
        expiredBinding.execution.scopeRoot,
        expiredBinding.execution,
        session.id,
        replacement
      )
    ).toBe(true);
  });

  it("permanently fences an explicitly recovered unadmitted Kit job id", () => {
    testDir = join(
      tmpdir(),
      `kit-attempt-fence-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
    const store = new SqliteJobStore(join(testDir, "jobs.db"));
    const ref = execution({ contextIdentity: "fenced-attempt-context" });
    const fence = {
      attemptId: "fenced-attempt",
      cli: "claude",
      kitExecution: ref,
      kitSessionId: "fenced-kit-session",
      ownerPrincipal: "local",
      fencedAt: new Date().toISOString(),
    };
    try {
      expect(store.fenceUnadmittedKitAttempt(fence)).toBe("reserved");
      // A retry after a crash between fencing and lease release is safe only
      // for the exact same durable identity.
      expect(store.fenceUnadmittedKitAttempt(fence)).toBe("already_recovered");
      expect(store.fenceUnadmittedKitAttempt({ ...fence, kitSessionId: "other-kit-session" })).toBe(
        "conflict"
      );
      expect(() =>
        store.recordStart({
          id: fence.attemptId,
          correlationId: "late-admission",
          requestKey: "late-admission-key",
          cli: "claude",
          args: ["-p", "late"],
          startedAt: new Date().toISOString(),
          pid: null,
          kitExecution: ref,
          kitSessionId: fence.kitSessionId,
          ownerPrincipal: "local",
        })
      ).toThrow(/permanently recovered/);
      expect(store.getById(fence.attemptId)).toBeNull();
      // Fences are intentionally outside ordinary job retention.
      expect(store.evictExpired()).toBe(0);
      expect(store.fenceUnadmittedKitAttempt(fence)).toBe("already_recovered");
    } finally {
      store.close();
    }
  });

  it("keeps terminal Kit state pinned without durable native metadata", () => {
    const store = new MemoryJobStore({ retentionMs: 1 });
    const ref = execution();
    store.recordStart({
      id: "kit-job",
      correlationId: "corr",
      requestKey: computeRequestKey("claude", ["-p", "kit"]),
      cli: "claude",
      args: ["-p", "kit"],
      startedAt: new Date().toISOString(),
      pid: null,
      kitExecution: ref,
      kitSessionId: "gateway-kit-session",
    });

    expect(store.getById("kit-job")?.kitExecution).toEqual(ref);
    expect(store.getById("kit-job")?.requestKey).toBe("kit:kit-job");
    expect(store.getPinnedKitReleaseIds()).toEqual(["release-a"]);

    store.recordComplete({
      id: "kit-job",
      status: "completed",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      outputTruncated: false,
      error: null,
      finishedAt: new Date(Date.now() - 1_000).toISOString(),
      kitTerminalMetadata: {
        version: 1,
        nativeSessionId: "11111111-1111-4111-8111-111111111111",
      },
    });
    expect(store.getPendingKitFinalizations()).toMatchObject([
      {
        jobId: "kit-job",
        kitSessionId: "gateway-kit-session",
        kitExecution: ref,
        terminalMetadata: null,
      },
    ]);
    expect(store.getPinnedKitReleaseIds()).toEqual(["release-a"]);
    expect(store.evictExpired()).toBe(0);
    expect(store.markKitTerminalFinalized("kit-job", "wrong-session")).toBe(false);
    expect(store.markKitTerminalFinalized("kit-job", "gateway-kit-session")).toBe(true);
    expect(store.markKitTerminalFinalized("kit-job", "gateway-kit-session")).toBe(true);
    expect(store.getById("kit-job")?.kitTerminalFinalized).toBe(true);
    expect(store.getPendingKitFinalizations()).toEqual([]);
    expect(store.getPinnedKitReleaseIds()).toEqual([]);
    expect(store.evictExpired()).toBe(1);
  });

  it("reconciles a terminal Kit result from a reopened durable job store", async () => {
    testDir = join(
      tmpdir(),
      `kit-job-finalization-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
    const dbPath = join(testDir, "jobs.db");
    const first = new SqliteJobStore(dbPath);
    const ref = execution({ releaseId: "release-restart", contextIdentity: "context-restart" });
    try {
      first.recordStart({
        id: "restart-kit-job",
        correlationId: "restart-corr",
        requestKey: computeRequestKey("claude", ["-p", "restart"]),
        cli: "claude",
        args: ["-p", "restart"],
        outputFormat: "stream-json",
        startedAt: new Date().toISOString(),
        pid: null,
        kitExecution: ref,
        kitSessionId: "gateway-restart-session",
      });
      first.recordComplete({
        id: "restart-kit-job",
        status: "completed",
        exitCode: 0,
        stdout: "",
        stderr: "",
        outputTruncated: false,
        error: null,
        finishedAt: new Date().toISOString(),
        kitTerminalMetadata: {
          version: 1,
          nativeSessionId: "22222222-2222-4222-8222-222222222222",
        },
      });
    } finally {
      first.close();
    }

    const reopened = new SqliteJobStore(dbPath);
    const manager = new AsyncJobManager(undefined, undefined, reopened);
    try {
      expect(manager.getPendingKitFinalizations()).toMatchObject([
        {
          jobId: "restart-kit-job",
          kitSessionId: "gateway-restart-session",
          kitExecution: ref,
          terminalMetadata: null,
        },
      ]);
      expect(manager.getPinnedKitReleaseIds()).toEqual(["release-restart"]);
      expect(manager.markKitTerminalFinalized("restart-kit-job", "gateway-restart-session")).toBe(
        true
      );
      expect(manager.getPendingKitFinalizations()).toEqual([]);
      expect(manager.getPinnedKitReleaseIds()).toEqual([]);
      expect(reopened.getById("restart-kit-job")?.kitTerminalFinalizedAt).toEqual(
        expect.any(String)
      );
    } finally {
      await manager.dispose();
      reopened.close();
    }
  });

  it("uses fresh Kit jobs and keeps terminal hooks separate from cleanup", async () => {
    testDir = join(
      tmpdir(),
      `kit-durable-job-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
    const store = new SqliteJobStore(join(testDir, "jobs.db"));
    const manager = new AsyncJobManager(undefined, undefined, store);
    const terminal: string[] = [];
    let terminalOwner: string | null = null;
    let terminalMetadata: { version: 1; nativeSessionId: string | null } | null = null;
    const cleanup: string[] = [];
    const first = manager.startJobWithDedup(
      "sh" as LlmCli,
      ["-c", "printf out; printf err >&2"],
      "kit-a",
      {
        kitExecution: execution(),
        kitSessionId: "gateway-session-a",
        jobId: randomUUID(),
        forceRefresh: true,
        outputFormat: "stream-json",
        onTerminal: event => {
          terminal.push(event.kitSessionId ?? "missing");
          terminalOwner = event.ownerPrincipal;
          terminalMetadata = event.terminalMetadata;
        },
        artifactCleanup: () => cleanup.push("cleanup"),
      }
    );
    const second = manager.startJobWithDedup("sh" as LlmCli, ["-c", "sleep 0.05"], "kit-b", {
      kitExecution: execution(),
      kitSessionId: "gateway-session-b",
      jobId: randomUUID(),
      forceRefresh: true,
    });

    expect(second.deduped).toBe(false);
    expect(second.snapshot.id).not.toBe(first.snapshot.id);
    await waitForDone(manager, first.snapshot.id);
    await waitForDone(manager, second.snapshot.id);

    expect(terminal).toEqual(["gateway-session-a"]);
    expect(terminalOwner).toBe("local");
    expect(terminalMetadata).toEqual({ version: 1, nativeSessionId: null });
    expect(cleanup).toEqual(["cleanup"]);
    expect(manager.getJobKitExecution(first.snapshot.id)?.releaseId).toBe("release-a");
    expect(store.getPendingKitFinalizations()).toMatchObject([
      {
        jobId: second.snapshot.id,
        kitSessionId: "gateway-session-b",
      },
    ]);
    await manager.dispose();
    store.close();
  });

  it("keeps echoed Kit context out of streaming, terminal, and flight persistence", async () => {
    testDir = join(
      tmpdir(),
      `kit-output-privacy-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
    const store = new SqliteJobStore(join(testDir, "jobs.db"));
    let flightComplete: FlightLogResult | null = null;
    let flightStart: FlightLogStart | null = null;
    const flightRecorder = {
      logStart: (entry: FlightLogStart) => {
        flightStart = entry;
      },
      logComplete: (_correlationId: string, result: FlightLogResult) => {
        flightComplete = result;
      },
      queryRequests: () => [],
      flush: () => {},
      close: () => {},
    } as unknown as FlightRecorderLike;
    const manager = new AsyncJobManager(undefined, undefined, store, flightRecorder);
    const privateContext = "PRIVATE_KIT_STDIN_SENTINEL";

    try {
      const started = manager.startJobWithDedup(
        "sh" as LlmCli,
        ["-c", "cat; sleep 1.1; printf .; sleep 0.5"],
        "kit-output-privacy",
        {
          kitExecution: execution(),
          kitSessionId: "gateway-output-privacy-session",
          jobId: randomUUID(),
          forceRefresh: true,
          stdin: privateContext,
          writeFlightStart: true,
          flightRecorderEntry: {
            model: "test",
            prompt: privateContext,
            sessionId: privateContext,
            stablePrefixHash: privateContext,
            stablePrefixTokens: privateContext.length,
            cacheControlBlocks: 1,
            cacheControlTtlSeconds: 3600,
          },
          extractUsage: () => ({
            inputTokens: privateContext.length,
            outputTokens: privateContext.length,
            cacheReadTokens: privateContext.length,
            cacheCreationTokens: privateContext.length,
            costUsd: privateContext.length,
            costBasis: "provider-reported",
          }),
        }
      );

      expect(flightStart?.prompt).toContain("prompt is withheld");
      expect(flightStart?.sessionId).toBeUndefined();
      expect(flightStart?.stablePrefixHash).toBeUndefined();
      expect(flightStart?.stablePrefixTokens).toBeUndefined();
      expect(JSON.stringify(flightStart)).not.toContain(privateContext);

      await new Promise(resolve => setTimeout(resolve, 1_250));
      const streamed = store.getById(started.snapshot.id);
      expect(streamed?.status).toBe("running");
      expect(`${streamed?.stdout}${streamed?.stderr}${streamed?.error}`).not.toContain(
        privateContext
      );

      await waitForDone(manager, started.snapshot.id);
      const liveResult = manager.getJobResult(started.snapshot.id);
      expect(liveResult?.stdout).toContain(privateContext);

      const durable = store.getById(started.snapshot.id);
      expect(`${durable?.stdout}${durable?.stderr}${durable?.error}`).not.toContain(privateContext);
      expect(durable?.stdout).toBe("");
      expect(durable?.stderr).toBe("");
      expect(durable?.kitTerminalMetadata).toBeNull();
      expect(flightComplete?.response).toContain("output is withheld");
      expect(`${flightComplete?.response}${flightComplete?.errorMessage}`).not.toContain(
        privateContext
      );
      expect(flightComplete?.inputTokens).toBeUndefined();
      expect(flightComplete?.outputTokens).toBeUndefined();
      expect(flightComplete?.cacheReadTokens).toBeUndefined();
      expect(flightComplete?.cacheCreationTokens).toBeUndefined();
      expect(flightComplete?.costUsd).toBeUndefined();

      await manager.dispose();
      const restarted = new AsyncJobManager(undefined, undefined, store);
      try {
        const recovered = restarted.getJobResult(started.snapshot.id);
        expect(recovered?.stdout).toContain("output is withheld");
        expect(recovered?.stdout).not.toContain(privateContext);
      } finally {
        await restarted.dispose();
      }
    } finally {
      await manager.dispose();
      store.close();
    }
  });

  it("compresses a live Kit result without persisting compression telemetry", async () => {
    testDir = join(
      tmpdir(),
      `kit-compression-privacy-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
    const store = new SqliteJobStore(join(testDir, "jobs.db"));
    const flightRecorder = new CompressionCapturingFlightRecorder();
    const manager = new AsyncJobManager(undefined, undefined, store, flightRecorder);
    const server = createGatewayServer({
      asyncJobManager: manager,
      flightRecorder,
      persistence: persistence(join(testDir, "jobs.db")),
      sessionManager: new FileSessionManager(join(testDir, "sessions.json")),
    });
    const privateContext = "PRIVATE_KIT_COMPRESSION_SENTINEL";
    const jobId = randomUUID();

    try {
      manager.startJobWithDedup(
        "sh" as LlmCli,
        [
          "-c",
          `for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do printf '%s\\n' '${privateContext}'; done`,
        ],
        "kit-compression-privacy",
        {
          kitExecution: execution(),
          kitSessionId: "gateway-compression-session",
          jobId,
          forceRefresh: true,
          compressResponse: true,
          writeFlightStart: true,
          flightRecorderEntry: { model: "test", prompt: privateContext },
        }
      );
      await waitForDone(manager, jobId);

      const tool = (server as unknown as Record<string, Record<string, any>>)._registeredTools
        .llm_job_result;
      const response = await runWithRequestContext(
        { transport: "stdio", authKind: "disabled", authScopes: [] },
        () => tool.handler({ jobId, maxChars: 200000 }, {})
      );
      const payload = JSON.parse(response.content[0].text) as { result: { stdout: string } };

      expect(payload.result.stdout).toContain("[[gateway-note:v1");
      expect(flightRecorder.compression).toEqual([]);
    } finally {
      await manager.dispose();
      store.close();
    }
  });

  it("redacts private Kit argv before durable job persistence", async () => {
    testDir = join(
      tmpdir(),
      `kit-redacted-job-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
    const store = new SqliteJobStore(join(testDir, "jobs.db"));
    const manager = new AsyncJobManager(undefined, undefined, store);
    const privateContext = "personal-config-private-token-must-not-persist";

    try {
      const started = manager.startJobWithDedup(
        "sh" as LlmCli,
        ["-c", "true", privateContext],
        "kit-redacted-argv",
        {
          kitExecution: execution(),
          kitSessionId: "gateway-redacted-argv-session",
          jobId: randomUUID(),
          forceRefresh: true,
        }
      );

      const durable = store.getById(started.snapshot.id);
      expect(durable?.argsJson).toBe(JSON.stringify(["[personal-config-kit arguments redacted]"]));
      expect(durable?.argsJson).not.toContain(privateContext);
      await waitForDone(manager, started.snapshot.id);
    } finally {
      await manager.dispose();
      store.close();
    }
  });

  it("scrubs active and terminal legacy Kit rows whenever SQLite reopens", () => {
    testDir = join(
      tmpdir(),
      `kit-sqlite-upgrade-privacy-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
    const dbPath = join(testDir, "jobs.db");
    const privateContext = "PRIVATE_SQLITE_LEGACY_KIT_CONTEXT_SENTINEL";
    const legacyNativeHandle = "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1";
    const legacyRequestKeyFingerprint = "kit:deterministic-private-input-fingerprint";
    const legacyJobs = [
      { id: "legacy-kit-queued-privacy-job", status: "queued" },
      { id: "legacy-kit-running-privacy-job", status: "running" },
      { id: "legacy-kit-failed-privacy-job", status: "failed" },
    ] as const;
    const initial = new SqliteJobStore(dbPath);
    try {
      for (const { id } of legacyJobs) {
        initial.recordStart({
          id,
          correlationId: `${id}-corr`,
          requestKey: `${id}-key`,
          cli: "claude",
          args: ["-p", "safe"],
          startedAt: new Date().toISOString(),
          pid: null,
          kitExecution: execution({ contextIdentity: `${id}-context` }),
          kitSessionId: `${id}-session`,
        });
        expect(initial.getById(id)?.requestKey).toBe(`kit:${id}`);
      }
    } finally {
      initial.close();
    }

    const legacyWriter = openDatabase(dbPath);
    try {
      for (const { id, status } of legacyJobs) {
        legacyWriter
          .prepare(
            `UPDATE jobs
             SET status = ?, args_json = ?, request_key = ?, stdout = ?, stderr = ?, error = ?, payload_json = ?, kit_terminal_metadata_json = ?
             WHERE id = ?`
          )
          .run(
            status,
            JSON.stringify(["-p", privateContext]),
            legacyRequestKeyFingerprint,
            privateContext,
            privateContext,
            privateContext,
            privateContext,
            JSON.stringify({ version: 1, nativeSessionId: legacyNativeHandle }),
            id
          );
      }
    } finally {
      legacyWriter.close();
    }

    const reopened = new SqliteJobStore(dbPath);
    try {
      const rows = legacyJobs.map(({ id }) => reopened.getById(id));
      for (const [index, row] of rows.entries()) {
        const { id } = legacyJobs[index];
        expect(row).toMatchObject({
          requestKey: `kit:${id}`,
          argsJson: JSON.stringify(["[personal-config-kit arguments redacted]"]),
          stdout: "",
          stderr: "",
          payloadJson: null,
        });
        expect(row?.requestKey).not.toContain(legacyRequestKeyFingerprint);
        expect(row?.kitTerminalMetadata).toBeNull();
      }
      expect(rows[0]?.error).toBeNull();
      expect(rows[1]?.error).toBeNull();
      expect(rows[2]?.error).toBe(
        "Personal Agent Config Kit provider execution failed; detailed output is withheld"
      );
      expect(JSON.stringify(rows)).not.toContain(privateContext);
      expect(JSON.stringify(rows)).not.toContain(legacyNativeHandle);
      const rawRows = openDatabase(dbPath);
      try {
        const remaining = rawRows
          .prepare(
            "SELECT COUNT(*) AS count FROM jobs WHERE kit_execution_json IS NOT NULL AND kit_terminal_metadata_json IS NOT NULL"
          )
          .get() as { count: number };
        expect(remaining.count).toBe(0);
      } finally {
        rawRows.close();
      }

      // The startup scrub remains defensive for a partially upgraded database,
      // but a row that already meets the privacy boundary must not be rewritten
      // on every gateway open. A trigger makes an accidental no-op UPDATE
      // observable without depending on SQLite implementation internals.
      const auditWriter = openDatabase(dbPath);
      try {
        auditWriter.exec(`
          CREATE TABLE kit_scrub_update_audit (job_id TEXT NOT NULL);
          CREATE TRIGGER kit_scrub_update_audit_trigger
          AFTER UPDATE ON jobs
          BEGIN
            INSERT INTO kit_scrub_update_audit (job_id) VALUES (NEW.id);
          END;
        `);
        const cleanReopened = new SqliteJobStore(dbPath);
        try {
          expect(cleanReopened.getById(legacyJobs[0].id)?.status).toBe("queued");
          expect(cleanReopened.getById(legacyJobs[1].id)?.status).toBe("running");
        } finally {
          cleanReopened.close();
        }
        const audit = auditWriter
          .prepare("SELECT COUNT(*) AS count FROM kit_scrub_update_audit")
          .get() as { count: number };
        expect(audit.count).toBe(0);
      } finally {
        auditWriter.close();
      }
    } finally {
      reopened.close();
    }
  });

  it("fails closed when a Kit execution has no gateway session binding", () => {
    const manager = new AsyncJobManager(undefined, undefined, new MemoryJobStore());
    try {
      expect(() =>
        manager.startJobWithDedup("sh" as LlmCli, ["-c", "true"], "missing-kit-session", {
          kitExecution: execution(),
        })
      ).toThrow(/kitSessionId/);
    } finally {
      void manager.dispose();
    }
  });
});
