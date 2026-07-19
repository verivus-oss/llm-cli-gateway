// Copyright 2026 Verivus
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

/**
 * Phase-0 acceptance net for the PrepPipeline extraction (design draft v5,
 * section 6). Argv goldens alone are insufficient because they snapshot only
 * `prepareClaudeRequest(...).args`; this suite locks the FULL `CliRequestPrep`
 * field surface (effectivePrompt, stdinPayload, warnings, cacheControlBlocks,
 * reviewIntegrity, approvalDecision, stablePrefix*), plus the Tier-A telemetry
 * side effect `logOptimizationTokens` (Codex round-4 blocker: assert it fires
 * with the correct kind, and does not fire when optimize is off).
 *
 * Any Tier-A extraction that shifts a field value, drops a warning, or drops the
 * optimize telemetry flips this suite red while `.args` alone could stay green.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { logger, prepareClaudeRequest } from "../index.js";

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

function isPrep(result: Record<string, unknown>): boolean {
  return "args" in result;
}

/** Did any logger.info call carry the optimize telemetry for `kind`? */
function loggedOptimizeTokens(
  spy: ReturnType<typeof vi.spyOn>,
  kind: "prompt" | "response"
): boolean {
  return spy.mock.calls.some(
    call => typeof call[0] === "string" && (call[0] as string).includes(`${kind} tokens`)
  );
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
    // No optimize requested -> no optimize telemetry.
    expect(loggedOptimizeTokens(infoSpy, "prompt")).toBe(false);
  });

  it("optimizePrompt fires the prompt optimize telemetry (Codex R4 gate)", () => {
    const p = prep({ optimizePrompt: true, prompt: "please   kindly   summarize   this   text" });
    expect(isPrep(p)).toBe(true);
    // Telemetry side effect must fire for kind=prompt when optimize is on.
    expect(loggedOptimizeTokens(infoSpy, "prompt")).toBe(true);
    // The optimized text is what lands as the final argv prompt element.
    const args = p.args as string[];
    expect(args[args.length - 1]).toBe(p.effectivePrompt);
  });

  it("does not fire optimize telemetry when optimizePrompt is off", () => {
    prep({ optimizePrompt: false, prompt: "please   kindly   summarize   this   text" });
    expect(loggedOptimizeTokens(infoSpy, "prompt")).toBe(false);
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

  it("optimizePrompt + explicit cacheControl halts with an error response (incompat guard)", () => {
    const p = prep({
      prompt: undefined,
      optimizePrompt: true,
      promptParts: { system: "SYSTEM", task: "task", cacheControl: { system: true } },
      outputFormat: "stream-json",
    });
    expect(isPrep(p)).toBe(false); // ExtendedToolResponse, not CliRequestPrep
    expect(loggedOptimizeTokens(infoSpy, "prompt")).toBe(false); // guard fires before optimize
  });

  it("debug starting with '-' halts with an argument-injection error (input guard)", () => {
    const p = prep({ debug: "-x" });
    expect(isPrep(p)).toBe(false);
  });
});
