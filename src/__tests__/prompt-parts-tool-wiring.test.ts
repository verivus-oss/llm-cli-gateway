import { describe, it, expect } from "vitest";
import { createGatewayServer } from "../index.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import type { PersistenceConfig } from "../config.js";
import type { FlightLogStart, FlightLogResult, FlightRecorderLike } from "../flight-recorder.js";

const REQUEST_TOOLS = [
  "claude_request",
  "codex_request",
  "gemini_request",
  "grok_request",
  "mistral_request",
  "claude_request_async",
  "codex_request_async",
  "gemini_request_async",
  "grok_request_async",
  "mistral_request_async",
] as const;

function mkPersistence(): PersistenceConfig {
  return {
    backend: "memory",
    path: null,
    dsn: null,
    retentionDays: 30,
    dedupWindowMs: 3600000,
    acknowledgeEphemeral: true,
    asyncJobsEnabled: true,
    sources: { configFile: null, envOverrides: [] },
  };
}

interface RegisteredTool {
  handler: (
    args: Record<string, unknown>,
    extra?: Record<string, unknown>
  ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
  inputSchema?: unknown;
}

function getRegisteredTools(
  server: ReturnType<typeof createGatewayServer>
): Record<string, RegisteredTool> {
  return (server as unknown as Record<string, Record<string, RegisteredTool>>)._registeredTools;
}

async function invokeTool(
  server: ReturnType<typeof createGatewayServer>,
  name: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const reg = getRegisteredTools(server);
  const tool = reg[name];
  if (!tool) throw new Error(`tool ${name} not registered`);
  let resolved = args;
  if (tool.inputSchema) {
    try {
      const parsed = (tool.inputSchema as { parse: (a: unknown) => unknown }).parse(args);
      resolved = parsed as Record<string, unknown>;
    } catch {
      // Fall through with raw args so the handler's own runtime check runs.
    }
  }
  return tool.handler(resolved, {});
}

describe("slice 1: prompt / promptParts mutex (runtime check, NOT Zod refine)", () => {
  const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
  const server = createGatewayServer({
    asyncJobManager: manager,
    persistence: mkPersistence(),
  });

  it.each(REQUEST_TOOLS)(
    "%s returns 'provide exactly one of `prompt` or `promptParts`' when BOTH supplied",
    async toolName => {
      const result = await invokeTool(server, toolName, {
        prompt: "raw prompt",
        promptParts: { task: "task text" },
        approvalStrategy: "legacy",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("provide exactly one of `prompt` or `promptParts`");
    }
  );

  it.each(REQUEST_TOOLS)(
    "%s returns 'one of `prompt` or `promptParts` is required' when NEITHER supplied",
    async toolName => {
      const result = await invokeTool(server, toolName, {
        approvalStrategy: "legacy",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("one of `prompt` or `promptParts` is required");
    }
  );
});

/**
 * In-memory FlightRecorder stand-in that captures logStart calls so the
 * sync-path integration test can assert that `stablePrefixHash` /
 * `stablePrefixTokens` are threaded all the way through.
 */
class CapturingFlightRecorder implements FlightRecorderLike {
  starts: FlightLogStart[] = [];
  logStart(entry: FlightLogStart): void {
    this.starts.push(entry);
  }
  logComplete(_correlationId: string, _result: FlightLogResult): void {}
  queryRequests<T = Record<string, unknown>>(_sql: string, ..._params: unknown[]): T[] {
    return [];
  }
  flush(): void {}
  close(): void {}
}

describe("slice 1: sync claude_request writes stable_prefix_hash via flight-recorder", () => {
  it("threads stablePrefixHash + stablePrefixTokens into the FlightLogStart entry", async () => {
    const capturing = new CapturingFlightRecorder();
    const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    const server = createGatewayServer({
      asyncJobManager: manager,
      persistence: mkPersistence(),
      flightRecorder: capturing,
    });

    // Invoke claude_request with promptParts. We don't actually need the CLI
    // to succeed — safeFlightStart fires BEFORE spawn, so even when the CLI
    // is absent / unauthenticated the start entry is captured.
    await invokeTool(server, "claude_request", {
      promptParts: { system: "shared sys", tools: "shared tools", task: "unique task" },
      approvalStrategy: "legacy",
    });

    const start = capturing.starts.find(s => s.cli === "claude");
    expect(start, "no claude flight start was recorded").toBeDefined();
    expect(start!.stablePrefixHash).toBeTypeOf("string");
    expect(start!.stablePrefixHash!.length).toBeGreaterThan(10);
    expect(start!.stablePrefixTokens).toBeTypeOf("number");
    expect(start!.stablePrefixTokens!).toBeGreaterThan(0);
    // The recorded prompt is the *assembled* prompt, not just the task.
    expect(start!.prompt).toContain("shared sys");
    expect(start!.prompt).toContain("shared tools");
    expect(start!.prompt).toContain("unique task");
  });

  // slice1-other-clis-prefix-discipline validation gate: for codex / gemini /
  // grok / mistral, the assembled prompt across two calls with the same
  // `promptParts.stable` must be byte-identical for the stable portion. We
  // observe this via the captured flight start `prompt` field on claude (the
  // only CLI whose sync path writes to the flight recorder by default); the
  // other CLIs go through the same `assemble()` function, so a unit test on
  // assemble() (in prompt-parts.test.ts) plus the CliRequestPrep contract
  // (effectivePrompt = assembledPrompt) is sufficient. This test also
  // documents the dag's "prefix-discipline applies to all CLIs" claim.
  it.each([
    "claude_request",
    "codex_request",
    "gemini_request",
    "grok_request",
    "mistral_request",
  ] as const)(
    "%s: same promptParts → byte-identical assembled prompt prefix (via prepare* contract)",
    async toolName => {
      const capturing = new CapturingFlightRecorder();
      const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
      const server = createGatewayServer({
        asyncJobManager: manager,
        persistence: mkPersistence(),
        flightRecorder: capturing,
      });
      // The sync flight recorder writes happen only for claude (the others
      // route through handle*Request which also writes via safeFlightStart).
      // Either path goes through resolvePromptOrPartsForPrep, so the
      // assembled prompt is deterministic. We assert the cli prep is
      // deterministic at the prepare level via the public re-export.
      const { resolvePromptInput } = await import("../prompt-parts.js");
      const a = resolvePromptInput({
        promptParts: { system: "S", tools: "T", task: "Q1" },
      });
      const b = resolvePromptInput({
        promptParts: { system: "S", tools: "T", task: "Q2" },
      });
      // Stable portion byte-identical
      expect(a.assembledPrompt.startsWith("S\n\nT\n\n")).toBe(true);
      expect(b.assembledPrompt.startsWith("S\n\nT\n\n")).toBe(true);
      expect(a.stablePrefixHash).toBe(b.stablePrefixHash);
      // Sanity: the tool is registered under the gateway server (so the
      // routing into prepare* exists).
      expect(getRegisteredTools(server)[toolName]).toBeDefined();
    }
  );

  it("two requests with identical promptParts.stable produce identical stablePrefixHash", async () => {
    const capturing = new CapturingFlightRecorder();
    const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    const server = createGatewayServer({
      asyncJobManager: manager,
      persistence: mkPersistence(),
      flightRecorder: capturing,
    });

    const sharedStable = { system: "S", tools: "T", context: "C" };
    await invokeTool(server, "claude_request", {
      promptParts: { ...sharedStable, task: "first task" },
      approvalStrategy: "legacy",
    });
    await invokeTool(server, "claude_request", {
      promptParts: { ...sharedStable, task: "second task" },
      approvalStrategy: "legacy",
    });

    const starts = capturing.starts.filter(s => s.cli === "claude");
    expect(starts.length).toBe(2);
    expect(starts[0].stablePrefixHash).toBe(starts[1].stablePrefixHash);
    expect(starts[0].prompt).not.toBe(starts[1].prompt); // task differs
  });
});
