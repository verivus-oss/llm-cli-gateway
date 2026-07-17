import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGatewayServer } from "../index.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import { NoopFlightRecorder } from "../flight-recorder.js";
import { noopLogger } from "../logger.js";
import { PerformanceMetrics } from "../metrics.js";
import { ResourceProvider } from "../resources.js";
import type { PersistenceConfig } from "../config.js";
import { FileSessionManager, type ProviderType } from "../session-manager.js";
import { runWithRequestContext, type GatewayRequestContext } from "../request-context.js";

// F3b: ownership enforcement on the *_request EXECUTION handlers and the
// sessions://* resources — the surface the 2.9.0 security review found
// unguarded (cross-principal session takeover + session-id/metadata leak).
// These tests exercise the DENY paths, which short-circuit before any CLI is
// spawned, so they need no provider binaries.

function mkPersistence(): PersistenceConfig {
  return {
    backend: "memory",
    path: null,
    dsn: null,
    retentionDays: 30,
    dedupWindowMs: 3600000,
    acknowledgeEphemeral: true,
    ownsOrphanRecovery: false,
    asyncJobsEnabled: true,
    sources: { configFile: null, envOverrides: [] },
  };
}

function ctx(authPrincipal?: string): GatewayRequestContext {
  return authPrincipal
    ? { transport: "http", authScopes: [], authPrincipal }
    : { transport: "stdio", authScopes: [] };
}

interface RegisteredTool {
  handler: (
    args: Record<string, unknown>,
    extra?: Record<string, unknown>
  ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

describe("F3b request-handler ownership isolation", () => {
  let tmp: string;
  let sessions: FileSessionManager;
  let server: ReturnType<typeof createGatewayServer>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "f3b-req-"));
    sessions = new FileSessionManager(join(tmp, "sessions.json"));
    server = createGatewayServer({
      sessionManager: sessions,
      asyncJobManager: new AsyncJobManager(noopLogger, undefined, new MemoryJobStore()),
      persistence: mkPersistence(),
      flightRecorder: new NoopFlightRecorder(),
    });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function create(cli: ProviderType, principal?: string) {
    return runWithRequestContext(ctx(principal), () => sessions.createSession(cli, "s"));
  }

  async function call(
    name: string,
    args: Record<string, unknown>,
    principal?: string
  ): Promise<{ text: string; isError?: boolean }> {
    const reg = (server as unknown as Record<string, Record<string, RegisteredTool>>)
      ._registeredTools;
    const result = await runWithRequestContext(ctx(principal), () => reg[name].handler(args, {}));
    return { text: result.content[0].text, isError: result.isError };
  }

  it("claude_request refuses to resume another principal's session id", async () => {
    const bob = create("claude", "bob");
    const res = await call("claude_request", { prompt: "hi", sessionId: bob.id }, "alice");
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/not accessible/i);
  });

  it("codex_request refuses to resume another principal's session id", async () => {
    const bob = create("codex", "bob");
    const res = await call("codex_request", { prompt: "hi", sessionId: bob.id }, "alice");
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/not accessible/i);
  });

  it("codex_request_async refuses to resume another principal's session id", async () => {
    const bob = create("codex", "bob");
    const res = await call("codex_request_async", { prompt: "hi", sessionId: bob.id }, "alice");
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/not accessible/i);
  });

  it("a foreign session id is rejected even though it is the provider-type match (no provider-leak)", async () => {
    // Bob owns a codex session; alice asking codex_request must be denied on
    // ownership, never told what provider the id belongs to.
    const bob = create("codex", "bob");
    const res = await call("codex_request", { prompt: "hi", sessionId: bob.id }, "alice");
    expect(res.text).not.toMatch(/belongs to provider/i);
    expect(res.text).toMatch(/not accessible/i);
  });

  it("the owner is NOT blocked by the ownership gate on their own session id", async () => {
    // Alice resuming her own session must not hit the "not accessible" guard.
    // (It may fail later for lack of a real CLI binary; that is a different
    // error and proves the guard did not fire.)
    const mine = create("claude", "alice");
    const res = await call("claude_request", { prompt: "hi", sessionId: mine.id }, "alice");
    expect(res.text).not.toMatch(/not accessible/i);
  });

  it("session_get does not expose internal worktree ownership to an HTTP owner", async () => {
    const mine = create("mistral", "alice");
    sessions.updateSessionMetadata(mine.id, {
      worktreeOwnerHostname: "developer-workstation",
      worktreeOwnerInstanceId: "gateway-instance-uuid",
      worktreeCleanupPending: true,
    });

    const res = await call("session_get", { sessionId: mine.id }, "alice");
    const body = JSON.parse(res.text) as { session: { metadata?: Record<string, unknown> } };
    expect(res.isError).not.toBe(true);
    expect(body.session.metadata?.worktreeOwnerHostname).toBeUndefined();
    expect(body.session.metadata?.worktreeOwnerInstanceId).toBeUndefined();
    expect(body.session.metadata?.worktreeCleanupPending).toBeUndefined();
    expect(sessions.getSession(mine.id)?.metadata?.worktreeOwnerHostname).toBe(
      "developer-workstation"
    );
    expect(sessions.getSession(mine.id)?.metadata?.worktreeOwnerInstanceId).toBe(
      "gateway-instance-uuid"
    );
  });
});

describe("F3b sessions://* resource ownership isolation", () => {
  let tmp: string;
  let sessions: FileSessionManager;
  let provider: ResourceProvider;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "f3b-res-"));
    sessions = new FileSessionManager(join(tmp, "sessions.json"));
    provider = new ResourceProvider(sessions, new PerformanceMetrics());
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function create(cli: ProviderType, principal?: string) {
    return runWithRequestContext(ctx(principal), () => sessions.createSession(cli, "s"));
  }

  async function read(uri: string, principal?: string): Promise<any> {
    const contents = await runWithRequestContext(ctx(principal), () => provider.readResource(uri));
    return JSON.parse(contents!.text);
  }

  it("sessions://all hides another principal's session ids", async () => {
    const alice = create("claude", "alice");
    const bob = create("claude", "bob");

    const aliceView = await read("sessions://all", "alice");
    const ids = aliceView.sessions.map((s: any) => s.id);
    expect(ids).toContain(alice.id);
    expect(ids).not.toContain(bob.id);
    expect(aliceView.sessions.every((session: any) => !("generation" in session))).toBe(true);
  });

  it("sessions://all hides another principal's active-session pointer", async () => {
    const bob = create("codex", "bob");
    runWithRequestContext(ctx("bob"), () => sessions.setActiveSession("codex", bob.id));

    const aliceView = await read("sessions://all", "alice");
    expect(aliceView.activeSessions.codex).toBeNull();

    const bobView = await read("sessions://all", "bob");
    expect(bobView.activeSessions.codex).toBe(bob.id);
  });

  it("per-provider sessions://claude is owner-filtered", async () => {
    const alice = create("claude", "alice");
    const bob = create("claude", "bob");

    const aliceView = await read("sessions://claude", "alice");
    const ids = aliceView.sessions.map((s: any) => s.id);
    expect(ids).toContain(alice.id);
    expect(ids).not.toContain(bob.id);
  });

  it("sessions://all does not expose internal worktree ownership to an HTTP owner", async () => {
    const alice = create("mistral", "alice");
    sessions.updateSessionMetadata(alice.id, {
      worktreeOwnerHostname: "developer-workstation",
      worktreeOwnerInstanceId: "gateway-instance-uuid",
      worktreeCleanupPending: true,
    });

    const view = await read("sessions://all", "alice");
    const projected = view.sessions.find((session: any) => session.id === alice.id);
    expect(projected.metadata?.worktreeOwnerHostname).toBeUndefined();
    expect(projected.metadata?.worktreeOwnerInstanceId).toBeUndefined();
    expect(projected.metadata?.worktreeCleanupPending).toBeUndefined();
    expect(sessions.getSession(alice.id)?.metadata?.worktreeOwnerHostname).toBe(
      "developer-workstation"
    );
    expect(sessions.getSession(alice.id)?.metadata?.worktreeOwnerInstanceId).toBe(
      "gateway-instance-uuid"
    );
  });

  it("the local (stdio) principal sees legacy-unowned + local rows, not a remote principal's", async () => {
    const localSession = create("grok"); // owner "local"
    const remote = create("grok", "alice");

    const localView = await read("sessions://all", undefined);
    const ids = localView.sessions.map((s: any) => s.id);
    expect(ids).toContain(localSession.id);
    expect(ids).not.toContain(remote.id);
  });
});
