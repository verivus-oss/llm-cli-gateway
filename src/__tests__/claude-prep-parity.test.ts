// Copyright 2026 Verivus
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

/**
 * Phase-0 acceptance net for the PrepPipeline extraction (design draft v5,
 * section 6). Argv goldens alone are insufficient because they snapshot only
 * `prepareClaudeRequest(...).args`; this suite locks the FULL `CliRequestPrep`
 * field surface (effectivePrompt, stdinPayload, warnings, cacheControl fields,
 * reviewIntegrity, approvalDecision, stablePrefix*, mcpConfig path/fingerprint/
 * cleanup, requestedMcpServers, and the ArgvAndMcp fence argv), plus the Tier-A
 * telemetry side effect `logOptimizationTokens`.
 *
 * Test-veracity: these assertions are mutation-probe hardened. Each of the
 * following real regressions MUST flip this suite red (verified against the
 * round-1 implementation review that found them green under a weaker net):
 *  - drop the `logOptimizationTokens` call;
 *  - swap its before/after arguments (log becomes "6 -> 7");
 *  - run optimize but do not assign `effectivePrompt = optimized`;
 *  - run review-integrity on `params.prompt` instead of the assembled prompt;
 *  - drop the optimize+cacheControl incompat guard or the debug-injection guard;
 *  - drop the `--mcp-config` fence emission or the mcpConfig materialization.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { logger, prepareClaudeRequest, type GatewayServerRuntime } from "../index.js";
import { estimateTokens, optimizePrompt } from "../optimizer.js";
import { noopLogger } from "../logger.js";

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

function prep(extra: Record<string, unknown>): Record<string, unknown> {
  const result = prepareClaudeRequest({ ...BASE_PARAMS, ...extra } as never);
  return result as unknown as Record<string, unknown>;
}

/**
 * A runtime whose approvalManager.decide captures the `managedRiskReasons` the
 * Policy stage threaded into the approval request, then approves. This observes
 * the Policy output directly, avoiding the singleton runtime's approvals-file
 * write (both reviewers' recipe for a deterministic per-reason lock).
 */
function capturingRuntime(sink: { managedRiskReasons?: string[] }): GatewayServerRuntime {
  return {
    logger: noopLogger,
    cacheAwareness: {
      emitAnthropicCacheControl: false,
      anthropicTtlSeconds: 300,
      warnOnTtlExpiry: false,
      minStableTokensForCacheControl: { sonnet: 1024, opus: 4096, haiku: 4096, default: 4096 },
      sources: { configFile: null },
    },
    approvalManager: {
      decide: (request: { metadata?: { managedRiskReasons?: string[] } }) => {
        sink.managedRiskReasons = request.metadata?.managedRiskReasons;
        return { status: "approved" };
      },
    },
  } as unknown as GatewayServerRuntime;
}

function prepWith(extra: Record<string, unknown>, runtime: GatewayServerRuntime): void {
  prepareClaudeRequest({ ...BASE_PARAMS, ...extra } as never, runtime);
}

function isPrep(result: Record<string, unknown>): boolean {
  return "args" in result;
}

/** The exact message strings logOptimizationTokens passed to logger.info. */
function infoMessages(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map(call => call[0]).filter((m): m is string => typeof m === "string");
}

describe("claude prep parity (Phase 0 CliRequestPrep acceptance net)", () => {
  let testHome: string;
  let originalHome: string | undefined;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), "claude-prep-parity-"));
    originalHome = process.env.HOME;
    process.env.HOME = testHome;
    infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(testHome, { recursive: true, force: true });
  });

  it("minimal prompt-only prep exposes the expected full field surface", () => {
    const p = prep({});
    expect(isPrep(p)).toBe(true);
    expect(p.args).toEqual(["-p", "--", "PROMPT"]);
    expect(p.effectivePrompt).toBe("PROMPT");
    expect(p.resolvedModel).toBeUndefined();
    expect(p.stdinPayload).toBeUndefined();
    expect(p.cacheControlBlocks).toBeUndefined();
    expect(p.cacheControlTtlSeconds).toBeUndefined();
    expect(p.stablePrefixHash).toBeNull(); // legacy `prompt`, not promptParts
    expect(p.stablePrefixTokens).toBeNull();
    expect(p.approvalDecision).toBeNull(); // legacy strategy: no approval record
    expect(p.reviewIntegrity).toBeDefined();
    expect(Array.isArray(p.warnings) ? p.warnings : []).toEqual([]);
    // No `--mcp-config` fence for a plain legacy request.
    expect(p.args as string[]).not.toContain("--mcp-config");
    // No optimize requested -> no optimize telemetry.
    expect(infoMessages(infoSpy).some(m => m.includes("prompt tokens"))).toBe(false);
  });

  it("optimizePrompt rewrites effectivePrompt AND logs exact before->after tokens", () => {
    // "please   kindly   summarize   this   text" optimizes to
    // "kindly summarize this text" (7 -> 6 tokens). Locking the exact optimized
    // value catches a dropped `effectivePrompt = optimized` assignment; locking
    // the exact "before -> after" token string catches a before/after arg swap.
    const raw = "please   kindly   summarize   this   text";
    const expectedOptimized = optimizePrompt(raw);
    expect(expectedOptimized).not.toBe(raw); // guard the fixture itself
    const p = prep({ optimizePrompt: true, prompt: raw, correlationId: "parity-opt" });
    expect(isPrep(p)).toBe(true);

    // The optimized text is what lands as effectivePrompt and as the argv prompt.
    expect(p.effectivePrompt).toBe(expectedOptimized);
    const args = p.args as string[];
    expect(args[args.length - 1]).toBe(expectedOptimized);

    // Telemetry fires with the correct kind and correct before->after counts.
    const expectedPrefix = `[parity-opt] prompt tokens ${estimateTokens(raw)} → ${estimateTokens(expectedOptimized)} `;
    const match = infoMessages(infoSpy).filter(m => m.startsWith(expectedPrefix));
    expect(match).toHaveLength(1);
  });

  it("does not fire optimize telemetry when optimizePrompt is off", () => {
    prep({ optimizePrompt: false, prompt: "please   kindly   summarize   this   text" });
    expect(infoMessages(infoSpy).some(m => m.includes("prompt tokens"))).toBe(false);
  });

  it("computes review integrity from the ASSEMBLED prompt, not params.prompt", () => {
    // promptParts (params.prompt is undefined) whose assembled text is a review
    // context; empty allowedTools then triggers an `empty_allowed_tools`
    // violation. If integrity ran on params.prompt (undefined) instead of the
    // assembled prompt, isReviewContext would be false and there would be no
    // violation.
    const p = prep({
      prompt: undefined,
      promptParts: { task: "Review the auth module for bugs" },
      allowedTools: [],
      outputFormat: "text",
    });
    expect(isPrep(p)).toBe(true);
    const ri = p.reviewIntegrity as { isReviewContext: boolean; violations: { type: string }[] };
    expect(ri.isReviewContext).toBe(true);
    expect(ri.violations.map(v => v.type)).toContain("empty_allowed_tools");
  });

  it("promptParts + explicit cacheControl takes the slice-kappa stdin path", () => {
    const p = prep({
      prompt: undefined,
      promptParts: {
        system: "SYSTEM CONTEXT",
        task: "do the thing",
        cacheControl: { system: true },
      },
      outputFormat: "stream-json",
    });
    expect(isPrep(p)).toBe(true);
    const args = p.args as string[];
    // Kappa header, not the positional `-p <prompt>` path.
    expect(args.slice(0, 3)).toEqual(["-p", "--input-format", "stream-json"]);
    expect(args).not.toContain("--");
    expect(typeof p.stdinPayload).toBe("string");
    expect((p.stdinPayload as string).endsWith("\n")).toBe(true);
    expect(p.cacheControlBlocks).toBeGreaterThanOrEqual(1);
    expect(p.cacheControlTtlSeconds).toBe(3600);
    expect(p.stablePrefixHash).not.toBeNull();
  });

  it("materializes the mcpConfig artifact and emits the --mcp-config fence", () => {
    // strictMcpConfig forces the ArgvAndMcp materialize + insert + re-admit path
    // (design 5.1.1). Locks mcpConfig path/fingerprint/cleanup, the deduped
    // requestedMcpServers, and the fence argv the design's section 6 requires.
    const p = prep({ strictMcpConfig: true, mcpServers: ["sqry", "sqry"] });
    expect(isPrep(p)).toBe(true);
    expect(p.requestedMcpServers).toEqual(["sqry"]); // dedup preserved
    const mcp = p.mcpConfig as { path: string; fingerprint: string; cleanup?: () => void };
    expect(typeof mcp.path).toBe("string");
    expect(mcp.path.length).toBeGreaterThan(0);
    expect(typeof mcp.fingerprint).toBe("string");
    expect(mcp.fingerprint.length).toBeGreaterThan(0);
    expect(typeof p.cleanup).toBe("function");
    const args = p.args as string[];
    expect(args).toContain("--mcp-config");
    expect(args).toContain("--strict-mcp-config");
    // The --mcp-config flag is followed by the materialized path.
    expect(args[args.indexOf("--mcp-config") + 1]).toBe(mcp.path);
    (p.cleanup as () => void)(); // remove the request-scoped artifact
  });

  it("optimizePrompt + explicit cacheControl halts with an error response (incompat guard)", () => {
    const p = prep({
      prompt: undefined,
      optimizePrompt: true,
      promptParts: { system: "SYSTEM", task: "task", cacheControl: { system: true } },
      outputFormat: "stream-json",
    });
    expect(isPrep(p)).toBe(false); // ExtendedToolResponse, not CliRequestPrep
    // Guard fires before optimize, so no optimize telemetry.
    expect(infoMessages(infoSpy).some(m => m.includes("prompt tokens"))).toBe(false);
  });

  it("debug starting with '-' halts with an argument-injection error (input guard)", () => {
    const p = prep({ debug: "-x" });
    expect(isPrep(p)).toBe(false);
  });

  it("mcp_managed with a non-gateway MCP server halts (Policy managed-server gate)", () => {
    // Policy phase (50): a managed request may only use gateway-managed MCP
    // servers. A non-gateway name must halt before the ArgvAndMcp try / approval.
    const p = prep({
      approvalStrategy: "mcp_managed",
      mcpServers: ["definitely-not-a-gateway-server"],
    });
    expect(isPrep(p)).toBe(false); // createMcpConfigErrorResponse
    // Pin the SPECIFIC Policy-gate error, not merely "not a prep": deleting the
    // gate lets the request die later in ArgvAndMcp with a different message
    // (strictMcpConfig unavailable-servers), which `isPrep === false` alone would
    // not catch. Mirrors the strong lock in model-defaults.test.ts.
    expect(JSON.stringify(p)).toContain("only permits gateway-managed MCP servers");
  });

  // Per-reason lock for the Policy stage's managedRiskReasons collection. Each
  // case sets exactly one input and asserts the exact reason label the Policy
  // stage threads into the approval request. Dropping or relabelling any push
  // in claudePolicyStage flips the matching case red.
  const RISK_REASON_CASES: Array<[string, Record<string, unknown>]> = [
    ["permission_bypass", { dangerouslySkipPermissions: true }],
    ["permission_bypass", { permissionMode: "bypassPermissions" }],
    ["settings", { settings: "SETTINGS" }],
    ["setting_sources", { settingSources: "project" }],
    ["system_prompt", { systemPrompt: "SYS" }],
    ["append_system_prompt", { appendSystemPrompt: "APP" }],
    ["agent", { agent: "reviewer" }],
    ["agents", { agents: { helper: { description: "d", prompt: "p" } } }],
    ["native_fork", { forkSession: true }],
    ["plugin_dir", { pluginDir: ["/tmp/plugins"] }],
    ["plugin_url", { pluginUrl: ["https://example.com/p"] }],
    ["allowed_tools", { allowedTools: ["Bash"] }],
    ["builtin_tools", { tools: ["Read"] }],
    ["additional_workspace_dir", { addDir: ["/tmp/ws"] }],
    ["primary_workspace_dir", { workingDir: "/tmp/root" }],
    ["system_prompt_file", { systemPromptFile: "/tmp/sys.txt" }],
    ["append_system_prompt_file", { appendSystemPromptFile: "/tmp/app.txt" }],
    ["debug_file", { debugFile: "/tmp/debug.log" }],
    ["safe_mode", { safeMode: true }],
    ["bare_mode", { bare: true }],
    ["native_resume", { nativeResumeRequested: true }],
    ["gateway_worktree", { gatewayWorktreeRequested: true }],
  ];

  it.each(RISK_REASON_CASES)(
    "Policy threads managed-risk reason %s to the approval request",
    (reason, extra) => {
      const sink: { managedRiskReasons?: string[] } = {};
      // approvalStrategy:mcp_managed is the only path that reaches decide; empty
      // mcpServers passes the managed-server gate so the request reaches approval.
      prepWith(
        { approvalStrategy: "mcp_managed", mcpServers: [], ...extra },
        capturingRuntime(sink)
      );
      expect(sink.managedRiskReasons).toEqual([reason]);
    }
  );

  it("Policy emits no managed-risk reasons for a clean managed request", () => {
    const sink: { managedRiskReasons?: string[] } = {};
    prepWith({ approvalStrategy: "mcp_managed", mcpServers: [] }, capturingRuntime(sink));
    expect(sink.managedRiskReasons).toEqual([]);
  });
});
