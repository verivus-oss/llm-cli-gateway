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

describe("d4a: admission consults the resolved surface, not just the typed table", () => {
  it("admits a flag the SEED evidenced and no human declared", () => {
    // grok --client-identifier is in the generated seed, probed present with
    // arity one, and is not in contract.flags. Before d4a it was rejected as an
    // unsupported flag, which is the gateway refusing what the customer's own
    // binary accepts.
    const result = validateUpstreamCliArgs("grok", ["-p=hi", "--client-identifier", "x"]);
    expect(result.ok, result.violations.map(v => v.message).join("; ")).toBe(true);
  });

  it("consumes that flag's value, so it is not counted as a positional", () => {
    const result = validateUpstreamCliArgs("grok", ["-p=hi", "--client-identifier", "x"]);
    expect(result.violations.map(v => v.message).join("; ")).not.toMatch(/positional/);
  });

  it("still refuses a flag NO source evidenced", () => {
    const result = validateUpstreamCliArgs("grok", ["-p=hi", "--not-a-flag-anywhere"]);
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.message).toMatch(/Unsupported grok CLI flag/);
  });

  it("still refuses a flag the contract DECLARES it will not emit", () => {
    expect(validateUpstreamCliArgs("mistral", ["-p", "hello", "--auto-approve"]).ok).toBe(false);
  });
});

describe("review findings: one validation path, several fact sources", () => {
  // Codex and Grok both attacked the branch d4a added. It returned early, so a
  // surfaced flag skipped every check a declared flag gets. Each case below is
  // a reviewer's verbatim input.

  it("GROK: an inline --flag=--value on a surfaced flag is refused", () => {
    // Was ok:true. The declared path already refuses this, because most flags
    // carry inlineValue:false; the surfaced branch never asked.
    const result = validateUpstreamCliArgs("grok", [
      "-p=hi",
      "--client-identifier=--always-approve",
    ]);
    expect(result.ok).toBe(false);
    expect(result.violations.map(v => v.message).join("; ")).toMatch(/inline value/);
  });

  it("GROK: the caller's boolean is honoured even when the surface knows the flag", () => {
    // Was: surfaced arity won and swallowed "stray", so the positional bound
    // stopped firing for exactly the flags the seed had taught us about.
    const surfaced = validateUpstreamCliArgs("grok", ["-p=hi", "--client-identifier", "stray"], {
      passthroughFlags: { "--client-identifier": true },
    });
    const unsurfaced = validateUpstreamCliArgs("grok", ["-p=hi", "--not-surfaced", "stray"], {
      passthroughFlags: { "--not-surfaced": true },
    });
    expect(surfaced.ok, "surfaced").toBe(false);
    expect(unsurfaced.ok, "unsurfaced").toBe(false);
    expect(surfaced.violations.map(v => v.message).join("; ")).toMatch(/positional/);
  });

  it("GROK: a surfaced flag with a value still rejects a leading-hyphen value", () => {
    const result = validateUpstreamCliArgs(
      "grok",
      ["-p=hi", "--client-identifier", "--always-approve"],
      {
        passthroughFlags: { "--client-identifier": "x" },
      }
    );
    expect(result.ok).toBe(false);
  });

  it("CODEX r2: a surfaced flag of UNKNOWN arity consumes NOTHING", () => {
    // `optional` was the first answer and it swallowed the next token, hiding
    // it from the positional bound. claude --help is a real no-value flag, so
    // this argv carries a positional claude does not accept, and the guard has
    // to be the thing that says so.
    const result = validateUpstreamCliArgs("claude", ["-p", "--help", "value", "--", "hi"]);
    expect(result.ok).toBe(false);
    expect(result.violations.map(v => v.message).join("; ")).toMatch(/positional/);
  });

  it("a caller who wants a value says so, and then it is consumed", () => {
    expect(
      validateUpstreamCliArgs("claude", ["-p", "--help", "value", "--", "hi"], {
        passthroughFlags: { "--help": "value" },
      }).ok
    ).toBe(true);
  });

  it("still admits what d4a set out to admit", () => {
    expect(validateUpstreamCliArgs("grok", ["-p=hi", "--client-identifier", "x"]).ok).toBe(true);
  });
});
