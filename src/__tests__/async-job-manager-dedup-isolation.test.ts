import { describe, it, expect } from "vitest";
import { AsyncJobManager, type LlmCli, type StartJobOutcome } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import { runWithRequestContext, type GatewayRequestContext } from "../request-context.js";

// Issue #130: dedup must be principal-safe. Two distinct remote principals
// issuing identical requests must never dedup onto (and thereby read) one
// another's job, while the original owner still self-dedups and local
// unauthenticated stdio dedup is preserved.

function httpCtx(principal: string): GatewayRequestContext {
  return { transport: "http", authScopes: [], authPrincipal: principal };
}
const STDIO_CTX: GatewayRequestContext = { transport: "stdio", authScopes: [] };

async function startAs(
  manager: AsyncJobManager,
  ctx: GatewayRequestContext,
  args: string[],
  corr: string
): Promise<StartJobOutcome> {
  // startJobWithDedup captures the principal from the ambient request context,
  // and runWithRequestContext is AsyncLocalStorage-backed, so the context
  // survives the awaits inside it.
  //
  // The `as StartJobOutcome` that used to be here was load bearing in the worst
  // way: once startJobWithDedup became async this helper returned a PROMISE
  // that the cast told the compiler was a record, so every caller read
  // `undefined` off it and five tests failed on `expected undefined to be
  // false` many frames from the mistake. No cast now, so the type is checked.
  return runWithRequestContext(ctx, () =>
    manager.startJobWithDedup("echo" as LlmCli, args, corr, {})
  );
}

describe("AsyncJobManager principal-safe dedup (issue #130)", () => {
  it("lets the same principal self-dedup onto its own running job", async () => {
    const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    const a1 = await startAs(manager, httpCtx("alice"), ["hello"], "a1");
    expect(a1.deduped).toBe(false);

    const a2 = await startAs(manager, httpCtx("alice"), ["hello"], "a2");
    expect(a2.deduped).toBe(true);
    expect(a2.snapshot.id).toBe(a1.snapshot.id);
  });

  it("does NOT let a different principal dedup onto the first principal's job", async () => {
    const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    const alice = await startAs(manager, httpCtx("alice"), ["hello"], "a1");
    const bob = await startAs(manager, httpCtx("bob"), ["hello"], "b1");

    expect(bob.deduped).toBe(false);
    expect(bob.snapshot.id).not.toBe(alice.snapshot.id);
  });

  it("does NOT let a remote principal dedup onto a local (stdio) job", async () => {
    const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    const local = await startAs(manager, STDIO_CTX, ["hello"], "l1");
    const alice = await startAs(manager, httpCtx("alice"), ["hello"], "a1");

    expect(alice.deduped).toBe(false);
    expect(alice.snapshot.id).not.toBe(local.snapshot.id);
  });

  it("preserves local unauthenticated stdio self-dedup (no principal)", async () => {
    const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    const l1 = await startAs(manager, STDIO_CTX, ["hello"], "l1");
    const l2 = await startAs(manager, STDIO_CTX, ["hello"], "l2");

    expect(l1.deduped).toBe(false);
    expect(l2.deduped).toBe(true);
    expect(l2.snapshot.id).toBe(l1.snapshot.id);
  });

  it("uses managed config fingerprints to dedup equal content but separate different content", async () => {
    const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    const firstFingerprint = "a".repeat(64);
    const secondFingerprint = "b".repeat(64);
    const first = await manager.startJobWithDedup(
      "echo" as LlmCli,
      ["--mcp-config", "/tmp/request-a.json", "--", "hello"],
      "artifact-a",
      {
        dedupArgs: ["--mcp-config", `[gateway-claude-mcp:${firstFingerprint}]`, "--", "hello"],
      }
    );
    const second = await manager.startJobWithDedup(
      "echo" as LlmCli,
      ["--mcp-config", "/tmp/request-b.json", "--", "hello"],
      "artifact-b",
      {
        dedupArgs: ["--mcp-config", `[gateway-claude-mcp:${firstFingerprint}]`, "--", "hello"],
      }
    );
    const changedConfig = await manager.startJobWithDedup(
      "echo" as LlmCli,
      ["--mcp-config", "/tmp/request-c.json", "--", "hello"],
      "artifact-c",
      {
        dedupArgs: ["--mcp-config", `[gateway-claude-mcp:${secondFingerprint}]`, "--", "hello"],
      }
    );

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.snapshot.id).toBe(first.snapshot.id);
    expect(changedConfig.deduped).toBe(false);
    expect(changedConfig.snapshot.id).not.toBe(first.snapshot.id);
  });

  it("keeps cross-principal isolation across the store-hydration (restart) reuse path", async () => {
    // The reuse path prefers an in-memory record but falls back to hydrating
    // from the store (e.g. after a gateway restart). Prove isolation holds on
    // that path too: a fresh manager sharing the same store must not let a
    // different principal reuse the seeded job.
    const store = new MemoryJobStore();
    const seeder = new AsyncJobManager(noopLogger, undefined, store);
    const alice = await startAs(seeder, httpCtx("alice"), ["backstop"], "seed");
    expect((await store.getById(alice.snapshot.id)!).ownerPrincipal).toBe("alice");

    // Fresh manager = empty in-memory map, so any reuse MUST hydrate from store.
    const restarted = new AsyncJobManager(noopLogger, undefined, store);
    const bob = await startAs(restarted, httpCtx("bob"), ["backstop"], "b1");
    expect(bob.deduped).toBe(false);
    expect(bob.snapshot.id).not.toBe(alice.snapshot.id);

    // The original owner still self-dedups after the restart (hydration path).
    const aliceAgain = await startAs(restarted, httpCtx("alice"), ["backstop"], "a2");
    expect(aliceAgain.deduped).toBe(true);
    expect(aliceAgain.snapshot.id).toBe(alice.snapshot.id);
  });
});
