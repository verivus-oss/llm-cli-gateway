import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGatewayServer } from "../index.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import { NoopFlightRecorder } from "../flight-recorder.js";
import { noopLogger } from "../logger.js";
import type { PersistenceConfig } from "../config.js";
import { FileSessionManager, type ProviderType } from "../session-manager.js";
import { runWithRequestContext, type GatewayRequestContext } from "../request-context.js";

// F3b: end-to-end ownership enforcement on the session_* MCP tools, driven
// through the real registered handlers under different request-context
// principals.

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

// A remote principal carries authPrincipal; omitting it yields the "local"
// (stdio) principal.
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

describe("F3b session ownership isolation", () => {
  let tmp: string;
  let sessions: FileSessionManager;
  let server: ReturnType<typeof createGatewayServer>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "f3b-sessions-"));
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
  ): Promise<Record<string, any>> {
    const reg = (server as unknown as Record<string, Record<string, RegisteredTool>>)
      ._registeredTools;
    const result = await runWithRequestContext(ctx(principal), () => reg[name].handler(args, {}));
    return JSON.parse(result.content[0].text);
  }

  it("session_list shows only the caller's own sessions", async () => {
    const alice = create("claude", "alice");
    const bob = create("claude", "bob");

    const aliceList = await call("session_list", {}, "alice");
    const aliceIds = aliceList.sessions.map((s: any) => s.id);
    expect(aliceIds).toContain(alice.id);
    expect(aliceIds).not.toContain(bob.id);
  });

  it("session_get / session_delete are own-or-not-found across principals", async () => {
    const alice = create("codex", "alice");

    const bobGet = await call("session_get", { sessionId: alice.id }, "bob");
    expect(bobGet.success).toBe(false);
    expect(bobGet.error).toMatch(/not found/i);

    const bobDelete = await call("session_delete", { sessionId: alice.id }, "bob");
    expect(bobDelete.error).toMatch(/not found/i);

    // Alice's session is untouched and still visible to her.
    const aliceGet = await call("session_get", { sessionId: alice.id }, "alice");
    expect(aliceGet.session.id).toBe(alice.id);
  });

  it("local principal sees legacy-unowned + local sessions but not a remote principal's", async () => {
    const localSession = create("grok"); // owner "local"
    const aliceSession = create("grok", "alice");

    const localList = await call("session_list", {}, undefined);
    const ids = localList.sessions.map((s: any) => s.id);
    expect(ids).toContain(localSession.id);
    expect(ids).not.toContain(aliceSession.id);
  });

  it("session_clear_all only removes the caller's own sessions", async () => {
    create("mistral", "alice");
    const bob = create("mistral", "bob");

    const cleared = await call("session_clear_all", {}, "alice");
    expect(cleared.deletedCount).toBe(1);

    // Bob's session survives.
    const bobGet = await call("session_get", { sessionId: bob.id }, "bob");
    expect(bobGet.session.id).toBe(bob.id);
  });

  it("session_set_active rejects pointing at a session the caller does not own", async () => {
    const alice = create("claude", "alice");
    const denied = await call("session_set_active", { cli: "claude", sessionId: alice.id }, "bob");
    expect(denied.success).toBe(false);
    expect(denied.error).toMatch(/not found/i);
  });
});
