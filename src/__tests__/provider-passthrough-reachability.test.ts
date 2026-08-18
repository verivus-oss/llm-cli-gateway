/**
 * Yesterday's pass-through tests asserted on `prepare*Request` argv and passed
 * while every real call died two layers later: `handle*Request` runs
 * `assertUpstreamCliArgs`, which rejected any flag absent from the bundled
 * table. Building argv is not reaching the CLI. This file asserts the second
 * half.
 */
import { describe, expect, it } from "vitest";
import {
  resolveGatewayServerRuntime,
  prepareClaudeRequest,
  prepareCodexRequest,
  prepareCursorRequest,
  prepareDevinRequest,
  prepareGeminiRequest,
  prepareGrokRequest,
  prepareMistralRequest,
} from "../index.js";
import { assertUpstreamCliArgs, validateUpstreamCliArgs } from "../upstream-contracts.js";
import type { CliType } from "../provider-types.js";

const COMMON = { prompt: "hi", approvalStrategy: "legacy" as const, optimizePrompt: false };

const PROVIDERS: Array<{ cli: CliType; prepare: unknown; op: string }> = [
  { cli: "claude", prepare: prepareClaudeRequest, op: "claude_request" },
  { cli: "codex", prepare: prepareCodexRequest, op: "codex_request" },
  { cli: "gemini", prepare: prepareGeminiRequest, op: "gemini_request" },
  { cli: "grok", prepare: prepareGrokRequest, op: "grok_request" },
  { cli: "mistral", prepare: prepareMistralRequest, op: "mistral_request" },
  { cli: "devin", prepare: prepareDevinRequest, op: "devin_request" },
  { cli: "cursor", prepare: prepareCursorRequest, op: "cursor_request" },
];

function argvOf(result: unknown): string[] {
  if (typeof result === "object" && result !== null && "args" in result) {
    return (result as { args: string[] }).args;
  }
  throw new Error(`expected a prepared request, got: ${JSON.stringify(result)}`);
}

describe.each(PROVIDERS)("$cli pass-through survives argv admission", ({ cli, prepare, op }) => {
  const build = (providerFlags: Record<string, unknown>) =>
    argvOf(
      (prepare as (p: unknown, r: unknown) => unknown)(
        { ...COMMON, operation: op, providerFlags },
        resolveGatewayServerRuntime()
      )
    );

  it("a flag with a value passes the upstream contract assertion", () => {
    const flags = { "--gateway-probe-unknown": "3" };
    expect(() => assertUpstreamCliArgs(cli, build(flags), flags)).not.toThrow();
  });

  it("a boolean flag passes the upstream contract assertion", () => {
    const flags = { "--gateway-probe-bool": true };
    expect(() => assertUpstreamCliArgs(cli, build(flags), flags)).not.toThrow();
  });

  it("the unknown flag's value is not counted as a positional", () => {
    const result = validateUpstreamCliArgs(cli, build({ "--gateway-probe-unknown": "3" }), {
      passthroughFlags: { "--gateway-probe-unknown": "3" },
    });
    expect(result.violations.map(v => v.message).join("; ")).not.toMatch(/positional/);
    expect(result.unknownFlagCount).toBe(1);
  });
});

describe("fail_open is scoped to what the caller named", () => {
  it("a flag the caller did NOT name is still refused, so gateway typos stay caught", () => {
    const result = validateUpstreamCliArgs("grok", ["-p=hi", "--typo-in-our-own-argv"]);
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.message).toMatch(/Unsupported grok CLI flag/);
  });

  it("names the caller's flags nowhere in the result, which is logged", () => {
    const result = validateUpstreamCliArgs("grok", ["-p=hi", "--x", "sk-secret-value"], {
      passthroughFlags: { "--x": "sk-secret-value" },
    });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("sk-secret-value");
    expect(JSON.stringify(result)).not.toContain("--x");
    expect(result.unknownFlagCount).toBe(1);
  });
});

describe("retained_enforcement is bounded", () => {
  it("a BOOLEAN pass-through flag does not swallow the next token", () => {
    // Arity comes from the caller's value, not from a guess, so "stray" stays a
    // positional and still trips the bound.
    const result = validateUpstreamCliArgs("mistral", ["-p", "hello", "--unknown", "stray"], {
      passthroughFlags: { "--unknown": true },
    });
    expect(result.ok).toBe(false);
    expect(result.violations.map(v => v.message).join("; ")).toMatch(/positional/);
  });

  it("still refuses a non-option value on a KNOWN flag, the injection guard", () => {
    const result = validateUpstreamCliArgs("claude", ["--print", "--model", "--evil", "--", "hi"]);
    expect(result.ok).toBe(false);
  });

  it("still requires the headless flag", () => {
    const result = validateUpstreamCliArgs("claude", ["--unknown-thing", "--", "hi"]);
    expect(result.ok).toBe(false);
    expect(result.violations.map(v => v.message).join("; ")).toMatch(/headless flag/);
  });

  it("does not let an unknown flag swallow the prompt terminator", () => {
    const result = validateUpstreamCliArgs("claude", ["-p", "--unknown", "--", "hi"], {
      passthroughFlags: { "--unknown": true },
    });
    expect(result.ok).toBe(true);
  });
});
