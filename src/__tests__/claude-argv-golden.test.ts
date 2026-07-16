/**
 * Claude argv golden (Phase 4 Part A).
 *
 * Locks the EXACT `prepareClaudeRequest(params).args` emission for the
 * remaining headless-safe Claude CLI modifiers wired in Part A
 * (--include-hook-events, --replay-user-messages, --system-prompt-file,
 * --append-system-prompt-file, --name, --plugin-dir, --plugin-url, --safe-mode,
 * --bare, --debug, --debug-file). Every flag traces to `claude --help`.
 *
 * Test-veracity: the kitchen-sink snapshot is the exact-argv oracle. Deleting or
 * renaming any flag emission in `prepareClaudeHighImpactFlags` (e.g. changing
 * "--safe-mode" to "--safemode", or dropping the `--name` push) changes the
 * snapshot AND the explicit per-flag assertions below, flipping this suite red.
 *
 * Interactive-only (--tmux) and gateway-managed (--background, --remote-control)
 * flags are NOT wired as passthrough request fields; that classification is
 * asserted in provider-part-a-flag-classification.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { prepareClaudeRequest } from "../index.js";

const BASE_PARAMS = {
  prompt: "PROMPT",
  outputFormat: "text" as const,
  dangerouslySkipPermissions: false,
  approvalStrategy: "legacy" as const,
  mcpServers: [] as never[],
  strictMcpConfig: false,
  optimizePrompt: false,
  operation: "claude_request",
};

function argsFor(extra: Record<string, unknown>): string[] {
  const result = prepareClaudeRequest({ ...BASE_PARAMS, ...extra } as never);
  if (!("args" in result)) {
    throw new Error(
      "prepareClaudeRequest returned an ExtendedToolResponse instead of CliRequestPrep: " +
        JSON.stringify(result).slice(0, 200)
    );
  }
  return result.args;
}

function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function count(args: string[], flag: string): number {
  return args.filter(a => a === flag).length;
}

describe("claude argv golden (Phase 4 Part A)", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    // Sandbox HOME so the MCP-config write side-effect lands in a temp dir.
    testHome = mkdtempSync(join(tmpdir(), "claude-argv-golden-"));
    originalHome = process.env.HOME;
    process.env.HOME = testHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(testHome, { recursive: true, force: true });
  });

  it("emits no Part A flags for a minimal prompt-only request", () => {
    const args = argsFor({});
    expect(args).toEqual(["-p", "--", "PROMPT"]);
    for (const flag of [
      "--include-hook-events",
      "--replay-user-messages",
      "--system-prompt-file",
      "--append-system-prompt-file",
      "--name",
      "--plugin-dir",
      "--plugin-url",
      "--safe-mode",
      "--bare",
      "--debug",
      "--debug-file",
    ]) {
      expect(args).not.toContain(flag);
    }
  });

  it("emits every wired Part A flag with exact argv (kitchen sink)", () => {
    const args = argsFor({
      includeHookEvents: true,
      replayUserMessages: true,
      systemPromptFile: "/tmp/sys.txt",
      appendSystemPromptFile: "/tmp/append.txt",
      name: "my-session",
      pluginDir: ["/tmp/plugA", "/tmp/plugB.zip"],
      pluginUrl: ["https://example.com/a.zip", "https://example.com/b.zip"],
      safeMode: true,
      bare: true,
      debug: "api,hooks",
      debugFile: "/tmp/debug.log",
    });
    expect(args).toMatchSnapshot();

    // Boolean toggles.
    expect(args).toContain("--include-hook-events");
    expect(args).toContain("--replay-user-messages");
    expect(args).toContain("--safe-mode");
    expect(args).toContain("--bare");

    // Value flags carry their value as the immediately-following argv token.
    expect(valueAfter(args, "--system-prompt-file")).toBe("/tmp/sys.txt");
    expect(valueAfter(args, "--append-system-prompt-file")).toBe("/tmp/append.txt");
    expect(valueAfter(args, "--name")).toBe("my-session");
    expect(valueAfter(args, "--debug")).toBe("api,hooks");
    expect(valueAfter(args, "--debug-file")).toBe("/tmp/debug.log");

    // Repeatable flags: one instance per entry, values preserved in order.
    expect(count(args, "--plugin-dir")).toBe(2);
    expect(count(args, "--plugin-url")).toBe(2);
    expect(args).toContain("/tmp/plugA");
    expect(args).toContain("/tmp/plugB.zip");
    expect(args).toContain("https://example.com/a.zip");
    expect(args).toContain("https://example.com/b.zip");
  });

  it("emits a bare --debug (no value token) when debug === true", () => {
    const args = argsFor({ debug: true });
    expect(args).toEqual(["-p", "--debug", "--", "PROMPT"]);
  });

  it("omits --debug entirely when debug === false", () => {
    const args = argsFor({ debug: false });
    expect(args).not.toContain("--debug");
  });

  it("emits --debug <filter> when debug is a string", () => {
    const args = argsFor({ debug: "hooks" });
    expect(args).toEqual(["-p", "--debug", "hooks", "--", "PROMPT"]);
  });

  it("produces byte-identical argv for sync and async operations (parity)", () => {
    const shared = {
      name: "parity",
      includeHookEvents: true,
      pluginDir: ["/tmp/p"],
      debug: "api",
    };
    const sync = argsFor({ ...shared, operation: "claude_request" });
    const async = argsFor({ ...shared, operation: "claude_request_async" });
    expect(async).toEqual(sync);
  });
});
