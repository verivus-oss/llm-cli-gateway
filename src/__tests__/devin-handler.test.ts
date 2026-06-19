/**
 * Slice D0 — Devin CLI handler tests.
 *
 * These exercise the pure argv builder `prepareDevinRequest` (no I/O): headless
 * print mode (`devin -p <prompt>`), the optional `--model` / `--permission-mode`
 * / `--prompt-file` flags, prompt-optimization, and the empty-prompt guard.
 * Session resume args (`--resume` / `--continue`) are appended by the handler
 * via resolveGrokSessionArgs and covered by that helper's own tests.
 */
import { describe, it, expect } from "vitest";
import { prepareDevinRequest } from "../index.js";

// prepareDevinRequest ignores its runtime arg (prefixed `_runtime`); a `never`
// cast satisfies the signature without constructing a full GatewayServerRuntime.
const RUNTIME = {} as never;

function prep(params: {
  prompt?: string;
  model?: string;
  permissionMode?: "auto" | "smart" | "dangerous";
  promptFile?: string;
  optimizePrompt?: boolean;
}): { args: string[] } | { content: unknown } {
  return prepareDevinRequest(
    {
      prompt: params.prompt,
      model: params.model,
      permissionMode: params.permissionMode,
      promptFile: params.promptFile,
      optimizePrompt: params.optimizePrompt ?? false,
      operation: "devin_request",
    },
    RUNTIME
  ) as { args: string[] } | { content: unknown };
}

function argsOf(result: { args: string[] } | { content: unknown }): string[] {
  if (!("args" in result)) {
    throw new Error("expected a successful prep with argv, got an error response");
  }
  return result.args;
}

describe("Slice D0 prepareDevinRequest — headless argv", () => {
  it("emits the prompt via `-p` in print mode (first two argv slots)", () => {
    const args = argsOf(prep({ prompt: "hello devin" }));
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe("hello devin");
  });

  it("returns an error response (not argv) when the prompt is empty", () => {
    const result = prep({ prompt: "   " });
    expect("args" in result).toBe(false);
    expect("content" in result).toBe(true);
  });

  it("returns an error response when the prompt is omitted entirely", () => {
    const result = prep({});
    expect("args" in result).toBe(false);
  });

  it("emits `--model <resolved>` when a model is supplied", () => {
    const args = argsOf(prep({ prompt: "x", model: "opus" }));
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBeTruthy();
  });

  it("does NOT emit `--model` when no model is supplied (devin has no default)", () => {
    const args = argsOf(prep({ prompt: "x" }));
    expect(args).not.toContain("--model");
  });

  it("emits `--permission-mode <mode>` when set", () => {
    const args = argsOf(prep({ prompt: "x", permissionMode: "smart" }));
    const idx = args.indexOf("--permission-mode");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("smart");
  });

  it("does NOT emit `--permission-mode` when unset", () => {
    const args = argsOf(prep({ prompt: "x" }));
    expect(args).not.toContain("--permission-mode");
  });

  // Verified against devin 2026.7.19 (a64a20ba): modes are `auto`, `smart`, `dangerous`.
  it.each(["auto", "smart", "dangerous"] as const)(
    "forwards the CLI-valid permission-mode %s verbatim",
    mode => {
      const args = argsOf(prep({ prompt: "x", permissionMode: mode }));
      const idx = args.indexOf("--permission-mode");
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe(mode);
    }
  );

  it("emits `--prompt-file <path>` when set", () => {
    const args = argsOf(prep({ prompt: "x", promptFile: "/tmp/p.txt" }));
    const idx = args.indexOf("--prompt-file");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("/tmp/p.txt");
  });

  it("emits only `-p <prompt>` when no optional flags are supplied", () => {
    const args = argsOf(prep({ prompt: "just a prompt" }));
    expect(args).toEqual(["-p", "just a prompt"]);
  });

  it("rewrites the prompt text when optimizePrompt is true", () => {
    // Use a prompt the optimizer measurably shrinks (collapses whitespace).
    const raw = "please    do      the     thing";
    const args = argsOf(prep({ prompt: raw, optimizePrompt: true }));
    expect(args[0]).toBe("-p");
    expect(args[1]).not.toBe(raw);
    expect(args[1].length).toBeLessThanOrEqual(raw.length);
  });

  it("leaves the prompt verbatim when optimizePrompt is false", () => {
    const raw = "please    do      the     thing";
    const args = argsOf(prep({ prompt: raw, optimizePrompt: false }));
    expect(args[1]).toBe(raw);
  });
});
