/**
 * Regression coverage for upstream CLI surfaces discovered during the 2026-07
 * contract review. These tests deliberately keep request argv validation
 * separate from the read-only subcommand catalog.
 */
import { describe, expect, it } from "vitest";
import { AsyncJobManager } from "../async-job-manager.js";
import { createGatewayServer, prepareDevinRequest } from "../index.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import { resolveClaudePermissionFlags } from "../request-helpers.js";
import {
  ACP_ENTRYPOINT_CONTRACTS,
  UPSTREAM_CLI_CONTRACTS,
  getCliSubcommandContract,
  validateUpstreamCliArgs,
  validateUpstreamCliSubcommandArgs,
} from "../upstream-contracts.js";

function getRegisteredToolField(
  toolName: string,
  fieldName: string
): { safeParse: (value: unknown) => { success: boolean } } | undefined {
  const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
  const server = createGatewayServer({
    asyncJobManager: manager,
    persistence: {
      backend: "sqlite",
      logsDbPath: ":memory:",
      jobsDbPath: ":memory:",
      jobRetentionDays: 7,
      dedupWindowMs: 0,
      asyncJobsEnabled: true,
      sources: { configFile: null, envOverrides: [] },
    },
  });
  const registry = (server as unknown as Record<string, Record<string, { inputSchema?: unknown }>>)
    ._registeredTools;
  const schema = registry[toolName]?.inputSchema as
    { _def?: { shape?: () => Record<string, unknown> } } | undefined;
  const shape = schema?._def?.shape?.() ?? {};
  return shape[fieldName] as { safeParse: (value: unknown) => { success: boolean } } | undefined;
}

describe("upstream contract upgrade regressions", () => {
  it("accepts and emits Devin accept-edits without widening unrelated permission modes", () => {
    const prep = prepareDevinRequest(
      {
        prompt: "make the requested edit",
        permissionMode: "accept-edits",
        optimizePrompt: false,
        operation: "devin_request",
      } as never,
      {} as never
    );
    expect("args" in prep).toBe(true);
    if (!("args" in prep)) return;

    expect(prep.args).toEqual([
      "-p",
      "make the requested edit",
      "--permission-mode",
      "accept-edits",
    ]);
    expect(validateUpstreamCliArgs("devin", prep.args).ok).toBe(true);
    expect(
      validateUpstreamCliArgs("devin", [
        "-p",
        "make the requested edit",
        "--permission-mode",
        "normal",
      ]).ok
    ).toBe(false);
  });

  it.each(["devin_request", "devin_request_async"])(
    "%s accepts Devin accept-edits in its registered schema",
    toolName => {
      const permissionMode = getRegisteredToolField(toolName, "permissionMode");
      expect(permissionMode, `${toolName}.permissionMode`).toBeDefined();
      expect(permissionMode?.safeParse("accept-edits").success).toBe(true);
      expect(permissionMode?.safeParse("normal").success).toBe(false);
    }
  );

  it("keeps Claude default as a no-op while manual is a real wire value", () => {
    expect(resolveClaudePermissionFlags({ permissionMode: "default" })).toEqual({ args: [] });
    expect(resolveClaudePermissionFlags({ permissionMode: "manual" })).toEqual({
      args: ["--permission-mode", "manual"],
    });
    expect(
      validateUpstreamCliArgs("claude", ["-p", "hello", "--permission-mode", "manual"]).ok
    ).toBe(true);
    expect(
      validateUpstreamCliArgs("claude", ["-p", "hello", "--permission-mode", "default"]).ok
    ).toBe(false);
    expect(getCliSubcommandContract("claude", ["gateway"])).toMatchObject({
      risk: "starts_server",
      exposure: "not_exposed",
    });
  });

  it.each(["claude_request", "claude_request_async"])(
    "%s accepts default and manual at the gateway boundary",
    toolName => {
      const permissionMode = getRegisteredToolField(toolName, "permissionMode");
      expect(permissionMode, `${toolName}.permissionMode`).toBeDefined();
      expect(permissionMode?.safeParse("default").success).toBe(true);
      expect(permissionMode?.safeParse("manual").success).toBe(true);
    }
  );

  it("tracks Antigravity agent selection without exposing it through request argv", () => {
    const contract = UPSTREAM_CLI_CONTRACTS.gemini;
    expect(contract.acknowledgedUpstreamFlags).toContain("--agent");
    expect(contract.flags["--agent"]).toBeUndefined();
    expect(validateUpstreamCliArgs("gemini", ["--print", "hello", "--agent", "reviewer"]).ok).toBe(
      false
    );

    const agent = getCliSubcommandContract("gemini", ["agent"]);
    expect(agent).not.toBeNull();
    expect(agent).toMatchObject({
      commandPath: ["agent"],
      aliases: ["agents"],
      risk: "read_only",
      exposure: "tracked_only",
      tier: "inspect",
    });

    for (const toolName of ["gemini_request", "gemini_request_async"]) {
      expect(getRegisteredToolField(toolName, "agent"), `${toolName}.agent`).toBeUndefined();
    }
  });

  it("tracks Grok fullscreen and setup JSON without allowing either on request argv", () => {
    const contract = UPSTREAM_CLI_CONTRACTS.grok;
    expect(contract.acknowledgedUpstreamFlags).toContain("--fullscreen");
    expect(contract.flags["--fullscreen"]).toBeUndefined();
    expect(validateUpstreamCliArgs("grok", ["-p", "hello", "--fullscreen"]).ok).toBe(false);

    const setup = getCliSubcommandContract("grok", ["setup"]);
    expect(setup).toMatchObject({
      risk: "writes_local_config",
      exposure: "not_exposed",
    });
    expect(validateUpstreamCliSubcommandArgs("grok", ["setup"], ["--json"]).ok).toBe(true);

    expect(getCliSubcommandContract("grok", ["ssh"])).toBeNull();
    expect(getCliSubcommandContract("grok", ["wrap"])).toMatchObject({
      risk: "destructive",
      exposure: "not_exposed",
    });
    expect(validateUpstreamCliSubcommandArgs("grok", ["wrap"], ["git", "status"]).ok).toBe(true);
  });

  it("catalogs Codex resume and delete without admitting them to request argv", () => {
    expect(getCliSubcommandContract("codex", ["resume"])).toMatchObject({
      risk: "executes_agent",
      exposure: "not_exposed",
    });
    expect(getCliSubcommandContract("codex", ["delete"])).toMatchObject({
      risk: "destructive",
      exposure: "not_exposed",
      adminProjection: "not_exposed",
    });
    expect(validateUpstreamCliArgs("codex", ["resume", "session-id"]).ok).toBe(false);
    expect(validateUpstreamCliArgs("codex", ["delete", "session-id"]).ok).toBe(false);
  });

  it("probes Devin ACP through its actual acp entrypoint", () => {
    expect(ACP_ENTRYPOINT_CONTRACTS.devin.probeArgs).toEqual([["acp", "--help"]]);
  });
});
