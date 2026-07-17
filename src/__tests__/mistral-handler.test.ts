/**
 * U22 — Mistral Vibe handler tests.
 *
 * These tests exercise the pure helpers in request-helpers.ts (the parts that
 * matter for U22's five hard divergences): model-via-env, --agent passthrough,
 * --enabled-tools allowlist, and --disabled-tools denylist emission.
 */
import { describe, it, expect } from "vitest";
import {
  prepareMistralRequest,
  resolveMistralSessionArgs,
  MISTRAL_BUILTIN_AGENT_MODES,
  MISTRAL_DEFAULT_AGENT_MODE,
} from "../request-helpers.js";

describe("U22 prepareMistralRequest — Vibe divergences", () => {
  it("injects VIBE_ACTIVE_MODEL via env, never as a --model flag", () => {
    const result = prepareMistralRequest({
      prompt: "hello",
      resolvedModel: "mistral-medium-3.5",
    });
    expect(result.env.VIBE_ACTIVE_MODEL).toBe("mistral-medium-3.5");
    expect(result.args).not.toContain("--model");
    // No arg should equal the model name either
    expect(result.args).not.toContain("mistral-medium-3.5");
  });

  it("emits prompt via an inline -p value (mirrors Grok's headless surface)", () => {
    const result = prepareMistralRequest({ prompt: "hello there" });
    expect(result.args[0]).toBe("-p=hello there");
  });

  it("defaults to --agent accept-edits in programmatic mode when no permissionMode is set (#155)", () => {
    const result = prepareMistralRequest({ prompt: "x" });
    const agentIdx = result.args.indexOf("--agent");
    expect(agentIdx).toBeGreaterThan(-1);
    expect(result.args[agentIdx + 1]).toBe("accept-edits");
    expect(MISTRAL_DEFAULT_AGENT_MODE).toBe("accept-edits");
  });

  it.each(MISTRAL_BUILTIN_AGENT_MODES)("maps permissionMode=%s onto --agent %s", mode => {
    const result = prepareMistralRequest({ prompt: "x", permissionMode: mode });
    const agentIdx = result.args.indexOf("--agent");
    expect(result.args[agentIdx + 1]).toBe(mode);
  });

  // Vibe --agent accepts arbitrary names (install-gated builtins like `lean`,
  // custom agents from ~/.vibe/agents); the gateway passes them through.
  it.each(["lean", "my-custom-agent"])("passes through non-builtin --agent name %s", mode => {
    const result = prepareMistralRequest({ prompt: "x", permissionMode: mode });
    const agentIdx = result.args.indexOf("--agent");
    expect(result.args[agentIdx + 1]).toBe(mode);
  });

  it('emits "--enabled-tools <tool>" once per allowedTool (allowlist-only)', () => {
    const result = prepareMistralRequest({
      prompt: "x",
      allowedTools: ["read", "write"],
    });
    // We expect two --enabled-tools flags, one per tool, in order
    const positions = result.args
      .map((arg, idx) => (arg === "--enabled-tools" ? idx : -1))
      .filter(idx => idx !== -1);
    expect(positions).toHaveLength(2);
    expect(result.args[positions[0] + 1]).toBe("read");
    expect(result.args[positions[1] + 1]).toBe("write");
  });

  it('emits "--disabled-tools <tool>" once per disallowedTool after enabled tools', () => {
    const result = prepareMistralRequest({
      prompt: "x",
      allowedTools: ["read", "write"],
      disallowedTools: ["bash", "network"],
    });
    expect(result.args).not.toContain("--disallowed-tools");
    const positions = result.args
      .map((arg, idx) => (arg === "--disabled-tools" ? idx : -1))
      .filter(idx => idx !== -1);
    expect(positions).toHaveLength(2);
    expect(result.args[positions[0] + 1]).toBe("bash");
    expect(result.args[positions[1] + 1]).toBe("network");
    expect(positions[0]).toBeGreaterThan(result.args.lastIndexOf("--enabled-tools"));
    expect(result).not.toHaveProperty("ignoredDisallowedTools");
  });

  it("does not emit --disabled-tools when disallowedTools is empty", () => {
    const result = prepareMistralRequest({ prompt: "x", disallowedTools: [] });
    expect(result.args).not.toContain("--disabled-tools");
  });

  it("emits outputFormat when supplied", () => {
    const result = prepareMistralRequest({
      prompt: "x",
      outputFormat: "json",
    });
    expect(result.args).toContain("--output");
    expect(result.args).toContain("json");
  });

  it("never emits --effort / --reasoning-effort (vibe rejects them)", () => {
    // vibe 2.x argparse hard-rejects these ("unrecognized arguments: --effort"),
    // so the builder must not emit them for any input. Exercise a fully-populated
    // request to guard against a regression that re-adds the emission.
    const result = prepareMistralRequest({
      prompt: "x",
      outputFormat: "json",
      permissionMode: "auto-approve",
      allowedTools: ["read"],
      trust: true,
      maxTurns: 3,
      maxPrice: 0.5,
      maxTokens: 1000,
      workingDir: "/tmp/w",
      addDir: ["/tmp/a"],
    });
    expect(result.args).not.toContain("--effort");
    expect(result.args).not.toContain("--reasoning-effort");
  });

  it("normalizes legacy outputFormat aliases to Vibe 2.x values", () => {
    const plain = prepareMistralRequest({ prompt: "x", outputFormat: "plain" });
    const plainIdx = plain.args.indexOf("--output");
    expect(plain.args[plainIdx + 1]).toBe("text");

    const streaming = prepareMistralRequest({ prompt: "x", outputFormat: "stream-json" });
    const streamingIdx = streaming.args.indexOf("--output");
    expect(streaming.args[streamingIdx + 1]).toBe("streaming");
  });
});

describe("U22 resolveMistralSessionArgs", () => {
  it("returns no resume args by default", () => {
    expect(resolveMistralSessionArgs({})).toEqual({
      resumeArgs: [],
      effectiveSessionId: undefined,
      userProvidedSession: false,
    });
  });

  it("maps resumeLatest=true to --continue (not --resume latest)", () => {
    const r = resolveMistralSessionArgs({ resumeLatest: true });
    expect(r.resumeArgs).toEqual(["--continue"]);
  });

  it("maps sessionId to --resume <id>", () => {
    const r = resolveMistralSessionArgs({ sessionId: "abc-123" });
    expect(r.resumeArgs).toEqual(["--resume", "abc-123"]);
    expect(r.userProvidedSession).toBe(true);
  });

  it("rejects gateway-generated gw- session IDs", () => {
    expect(() => resolveMistralSessionArgs({ sessionId: "gw-abc" })).toThrow(/reserved prefix/);
  });

  it("returns no resume args when createNewSession is true", () => {
    const r = resolveMistralSessionArgs({
      createNewSession: true,
      sessionId: "abc",
      resumeLatest: true,
    });
    expect(r.resumeArgs).toEqual([]);
  });
});

describe("Phase 4 slice γ — Mistral --trust wiring", () => {
  it("emits --trust when trust=true", () => {
    const result = prepareMistralRequest({ prompt: "hi", trust: true });
    expect(result.args).toContain("--trust");
  });

  it("does NOT emit --trust when trust=false", () => {
    const result = prepareMistralRequest({ prompt: "hi", trust: false });
    expect(result.args).not.toContain("--trust");
  });

  it("does NOT emit --trust when trust is omitted (default behaviour preserved)", () => {
    const result = prepareMistralRequest({ prompt: "hi" });
    expect(result.args).not.toContain("--trust");
  });
});

describe("Phase 4 slice δ — Mistral --max-turns / --max-price wiring", () => {
  it("emits --max-turns <N> when maxTurns is set", () => {
    const result = prepareMistralRequest({ prompt: "x", maxTurns: 5 });
    const idx = result.args.indexOf("--max-turns");
    expect(idx).toBeGreaterThan(-1);
    expect(result.args[idx + 1]).toBe("5");
  });

  it("emits --max-price <DOLLARS> when maxPrice is set", () => {
    const result = prepareMistralRequest({ prompt: "x", maxPrice: 0.5 });
    const idx = result.args.indexOf("--max-price");
    expect(idx).toBeGreaterThan(-1);
    expect(result.args[idx + 1]).toBe("0.5");
  });

  it("does NOT emit --max-turns / --max-price when both are omitted", () => {
    const result = prepareMistralRequest({ prompt: "x" });
    expect(result.args).not.toContain("--max-turns");
    expect(result.args).not.toContain("--max-price");
  });

  it("emits both flags together when both are set", () => {
    const result = prepareMistralRequest({ prompt: "x", maxTurns: 3, maxPrice: 0.01 });
    expect(result.args).toContain("--max-turns");
    expect(result.args).toContain("--max-price");
    const turnsIdx = result.args.indexOf("--max-turns");
    const priceIdx = result.args.indexOf("--max-price");
    expect(result.args[turnsIdx + 1]).toBe("3");
    expect(result.args[priceIdx + 1]).toBe("0.01");
  });

  it("emits --max-tokens <N> when maxTokens is set", () => {
    const result = prepareMistralRequest({ prompt: "x", maxTokens: 1234 });
    const idx = result.args.indexOf("--max-tokens");
    expect(idx).toBeGreaterThan(-1);
    expect(result.args[idx + 1]).toBe("1234");
  });
});
