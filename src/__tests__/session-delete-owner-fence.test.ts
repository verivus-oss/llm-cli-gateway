import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGatewayServer } from "../index.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import { NoopFlightRecorder } from "../flight-recorder.js";
import { noopLogger } from "../logger.js";
import type { PersistenceConfig } from "../config.js";
import { FileSessionManager } from "../session-manager.js";
import { runWithRequestContext, type GatewayRequestContext } from "../request-context.js";

// The ownership decision that admits a session_delete is made in the handler,
// an await before the write that acts on it. These tests assert the STORE, not
// the handler's return value: a test that only checked for `false` would pass
// against code whose delete statement carries no owner predicate at all.

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

describe("session_delete owner fence", () => {
  let tmp: string;
  let storePath: string;
  let sessions: FileSessionManager;
  let server: ReturnType<typeof createGatewayServer>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "rf-delete-fence-"));
    storePath = join(tmp, "sessions.json");
    sessions = new FileSessionManager(storePath);
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

  /** The durable row, read off disk rather than through any manager guard. */
  function storedRow(id: string): { ownerPrincipal?: string } | undefined {
    return JSON.parse(readFileSync(storePath, "utf8")).sessions[id];
  }

  function call(
    name: string,
    args: Record<string, unknown>,
    principal?: string
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    const reg = (server as unknown as Record<string, Record<string, RegisteredTool>>)
      ._registeredTools;
    return Promise.resolve(
      runWithRequestContext(ctx(principal), () => reg[name].handler(args, {}))
    );
  }

  it("does not delete a row another principal took over during the request", async () => {
    const alice = await runWithRequestContext(ctx("alice"), () =>
      sessions.createSession("claude", "alice session")
    );

    // Hold the handler open between its ownership decision and the write, with
    // a gate the test owns. No sleep, and no reliance on the defect itself:
    // the barrier resolves whether or not the delete is fenced.
    let release!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    // Two-way. Without the arrival half the swap could land before the held
    // read runs, the read would miss, and the test would pass against the
    // unfenced delete without ever reaching it.
    const reached = new Promise<void>(resolve => (arrived = resolve));
    const realGetSession = sessions.getSession.bind(sessions);
    let held = false;
    (sessions as unknown as Record<string, unknown>).getSession = async (id: string) => {
      const found = realGetSession(id);
      if (!held && id === alice.id) {
        held = true;
        arrived();
        await gate;
      }
      return found;
    };

    const deleting = call("session_delete", { sessionId: alice.id }, "alice");
    await reached;

    // The window. Alice's row goes away legitimately (her own second delete,
    // TTL eviction, or worktree cleanup) and bob claims the freed id, which
    // resolveApiSession does with a caller-supplied sessionId.
    await runWithRequestContext(ctx("alice"), () => sessions.deleteSession(alice.id));
    await runWithRequestContext(ctx("bob"), () =>
      sessions.createSession("claude", "bob session", alice.id)
    );
    expect(storedRow(alice.id)?.ownerPrincipal).toBe("bob");

    release();
    await deleting;

    // THE ASSERTION: bob's row survived alice's in-flight delete.
    expect(storedRow(alice.id)?.ownerPrincipal).toBe("bob");
  });

  it("refuses a foreign-owned row at the store, not only at the handler", async () => {
    const alice = await runWithRequestContext(ctx("alice"), () =>
      sessions.createSession("claude", "alice session")
    );

    const deleted = await runWithRequestContext(ctx("bob"), () => sessions.deleteSession(alice.id));

    expect(deleted).toBe(false);
    expect(storedRow(alice.id)?.ownerPrincipal).toBe("alice");
  });

  it("does not point the active pointer at a row taken over during the request", async () => {
    const alice = await runWithRequestContext(ctx("alice"), () =>
      sessions.createSession("claude", "alice one")
    );
    const keep = await runWithRequestContext(ctx("alice"), () =>
      sessions.createSession("claude", "alice two")
    );
    // Park the pointer somewhere alice owns, so a create in the window cannot
    // claim an empty pointer and hide what the handler did.
    await runWithRequestContext(ctx("alice"), () => sessions.setActiveSession("claude", keep.id));

    let release!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const reached = new Promise<void>(resolve => (arrived = resolve));
    const realGetSession = sessions.getSession.bind(sessions);
    let held = false;
    (sessions as unknown as Record<string, unknown>).getSession = async (id: string) => {
      const found = realGetSession(id);
      if (!held && id === alice.id) {
        held = true;
        arrived();
        await gate;
      }
      return found;
    };

    const activating = call("session_set_active", { cli: "claude", sessionId: alice.id }, "alice");
    await reached;

    await runWithRequestContext(ctx("alice"), () => sessions.deleteSession(alice.id));
    await runWithRequestContext(ctx("bob"), () =>
      sessions.createSession("claude", "bob session", alice.id)
    );

    release();
    await activating;

    (sessions as unknown as Record<string, unknown>).getSession = realGetSession;
    const active = JSON.parse(readFileSync(storePath, "utf8")).activeSession.claude;
    // THE ASSERTION: the pointer was not aimed at bob's row by alice's request.
    expect(active).toBe(keep.id);
  });

  it("refuses to point the active pointer at a foreign-owned session", async () => {
    const alice = await runWithRequestContext(ctx("alice"), () =>
      sessions.createSession("claude", "alice session")
    );

    expect(
      await runWithRequestContext(ctx("bob"), () => sessions.setActiveSession("claude", alice.id))
    ).toBe(false);
  });

  it("still evicts an expired row for whichever principal touches the store", async () => {
    const short = new FileSessionManager(join(tmp, "short.json"), 1);
    const alice = await runWithRequestContext(ctx("alice"), () =>
      short.createSession("claude", "expiring")
    );
    // Age the row past the 1 ms TTL without a timer: rewrite lastUsedAt.
    const raw = JSON.parse(readFileSync(join(tmp, "short.json"), "utf8"));
    raw.sessions[alice.id].lastUsedAt = new Date(Date.now() - 60_000).toISOString();
    rmSync(join(tmp, "short.json"));
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(tmp, "short.json"), JSON.stringify(raw), { mode: 0o600 });

    const reopened = new FileSessionManager(join(tmp, "short.json"), 1);
    expect(await runWithRequestContext(ctx("bob"), () => reopened.getSession(alice.id))).toBeNull();
    expect(JSON.parse(readFileSync(join(tmp, "short.json"), "utf8")).sessions[alice.id]).toBe(
      undefined
    );
  });
});
