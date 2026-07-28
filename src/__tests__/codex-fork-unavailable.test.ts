// codex_fork_session must explain itself instead of leaking a terminal error.
//
// `codex fork` is an interactive subcommand needing a controlling terminal, and
// provider children are spawned with pipes, so the tool could never succeed from
// an MCP server. Callers previously received `exit code 1: Error: stdin is not a
// terminal`, which reads like a broken environment and sends people debugging
// their own setup. codex-fork.test.ts covered the argv builder and passed
// throughout, because it never spawned anything.
//
// These tests drive the tool over a real MCP client and assert on what a caller
// actually receives: the reason, and the route that does work.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import { createSessionManager } from "../session-manager.js";
import type { PersistenceConfig } from "../config.js";

function mkPersistence(): PersistenceConfig {
  return {
    backend: "memory",
    acknowledgeEphemeral: true,
    logsDbPath: null,
    jobsDbPath: null,
    jobRetentionDays: 7,
    dedupWindowMs: 0,
    ownsOrphanRecovery: false,
    asyncJobsEnabled: true,
    sources: { configFile: null, envOverrides: [] },
  } as unknown as PersistenceConfig;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map(part => part.text ?? "").join("\n");
}

describe("codex_fork_session reports its own unavailability", () => {
  let client: Client;

  beforeAll(async () => {
    const { createGatewayServer } = await import("../index.js");
    const server = createGatewayServer({
      asyncJobManager: new AsyncJobManager(noopLogger, undefined, new MemoryJobStore()),
      persistence: mkPersistence(),
      sessionManager: await createSessionManager(undefined, undefined, noopLogger),
      isolateState: true,
    } as Parameters<typeof createGatewayServer>[0]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "codex-fork-test", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client?.close();
  });

  for (const [label, args] of [
    ["forkLast", { prompt: "hi", forkLast: true }],
    ["explicit sessionId", { prompt: "hi", sessionId: "019fa1e1-4018-7063-b8f2-e95174f5d877" }],
  ] as const) {
    it(`explains why rather than surfacing a terminal error (${label})`, async () => {
      const result = await client.callTool({ name: "codex_fork_session", arguments: args });
      const text = textOf(result);
      // The caller must not receive the bare provider failure. Note the phrase
      // "stdin is not a terminal" DOES appear in the replacement, because the
      // message quotes it to explain what used to happen; the discriminator is
      // the raw `codex CLI (exit code 1)` envelope, which means a child ran.
      expect(text).not.toContain("Error executing codex CLI (exit code 1)");
      // It must say why, and name the route that works.
      expect(text).toContain("interactive subcommand");
      expect(text).toContain("codex_request");
      expect(text).toMatch(/resumeLatest|session UUID/);
    });
  }

  it("still reports an argument error first when the call is malformed", async () => {
    // Unavailability must not mask a caller's own mistake, or a bad call becomes
    // indistinguishable from an unsupported one.
    const result = await client.callTool({
      name: "codex_fork_session",
      arguments: { prompt: "hi" },
    });
    expect(textOf(result)).toContain("one of sessionId or forkLast is required");
  });

  it("does not spawn a doomed child", async () => {
    // A wall-clock proxy: the guard returns before any provider spawn, so the
    // call resolves far faster than launching Codex and waiting for it to fail.
    const started = Date.now();
    await client.callTool({
      name: "codex_fork_session",
      arguments: { prompt: "hi", forkLast: true },
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("does not persist session workspace scope for a request that cannot run", async () => {
    // Resolution has to run BEFORE the guard, because it is what enforces remote
    // workspace containment. But with a sessionId and a RESOLVABLE workspace it
    // also writes workspaceAlias onto the session, so an unavailable request
    // could change the scope a later resume inherits. The handler passes
    // deferWorktree while fork cannot run, keeping validation and skipping the
    // write. Raised by a cross-LLM reviewer.
    //
    // The workspace must genuinely resolve. An unknown alias throws during
    // resolution and never reaches the persistence branch, so a test using one
    // passes whether or not the fix is present (confirmed by mutation).
    const { createGatewayServer } = await import("../index.js");
    const sessions = await createSessionManager(undefined, undefined, noopLogger);
    const workspaces = {
      enabled: true,
      defaultAlias: "probe-ws",
      allowUnregisteredWorkingDir: false,
      repos: [
        {
          alias: "probe-ws",
          path: process.cwd(),
          providers: ["codex"],
          allowWorktree: false,
          allowAddDir: false,
          kind: "git",
          operatorEntry: true,
        },
      ],
      allowedRoots: [],
    };
    const server = createGatewayServer({
      asyncJobManager: new AsyncJobManager(noopLogger, undefined, new MemoryJobStore()),
      persistence: mkPersistence(),
      sessionManager: sessions,
      workspaces,
      isolateState: true,
    } as unknown as Parameters<typeof createGatewayServer>[0]);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const scoped = new Client({ name: "scope-probe", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([server.connect(st), scoped.connect(ct)]);
    try {
      const created = await sessions.createSession("codex", "scope-write probe");
      const before = JSON.stringify((await sessions.getSession(created.id))?.metadata ?? {});
      await scoped.callTool({
        name: "codex_fork_session",
        arguments: { prompt: "hi", sessionId: created.id, workspace: "probe-ws" },
      });
      const after = JSON.stringify((await sessions.getSession(created.id))?.metadata ?? {});
      expect(after, "session scope was written for a request that can never run").toBe(before);
    } finally {
      await scoped.close();
    }
  });
});
