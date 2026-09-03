/**
 * Slice D0 — Devin CLI handler tests.
 *
 * These exercise the pure argv builder `prepareDevinRequest` (no I/O): headless
 * print mode (`devin -p <prompt>`), the optional `--model` / `--permission-mode`
 * / `--prompt-file` flags, prompt-optimization, and the empty-prompt guard.
 * Session resume args (`--resume` / `--continue`) are appended by the handler
 * via resolveGrokSessionArgs and covered by that helper's own tests.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { prepareDevinRequest } from "../index.js";

// #296 defaults --export on, and resolving that path creates a directory.
// Point HOME at a temp dir so a test run writes nothing into the real home.
let fakeHome: string;
let realHome: string | undefined;
beforeAll(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "devin-handler-home-"));
  realHome = process.env.HOME;
  process.env.HOME = fakeHome;
});
afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

// prepareDevinRequest ignores its runtime arg (prefixed `_runtime`); a `never`
// cast satisfies the signature without constructing a full GatewayServerRuntime.
const RUNTIME = {} as never;

function prep(params: {
  prompt?: string;
  model?: string;
  permissionMode?: "auto" | "accept-edits" | "smart" | "dangerous";
  promptFile?: string;
  optimizePrompt?: boolean;
  exportSession?: boolean | string;
}): { args: string[] } | { content: unknown } {
  return prepareDevinRequest(
    {
      prompt: params.prompt,
      model: params.model,
      permissionMode: params.permissionMode,
      promptFile: params.promptFile,
      optimizePrompt: params.optimizePrompt ?? false,
      exportSession: params.exportSession,
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
  it("emits the prompt after an end-of-options boundary in print mode", () => {
    const args = argsOf(prep({ prompt: "hello devin" }));
    expect(args[0]).toBe("-p");
    expect(args.slice(-2)).toEqual(["--", "hello devin"]);
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

  // `accept-edits` auto-approves workspace edits while retaining approval for
  // more dangerous operations. Keep all installed CLI modes wired verbatim.
  it.each(["auto", "accept-edits", "smart", "dangerous"] as const)(
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

  it("emits `-p`, the default #296 transcript export, then the prompt", () => {
    // The export is ON by default: devin writes only its final text to stdout,
    // so without it a run leaves no reconstructable record. The next case pins
    // the opt-out, so the pair covers both directions.
    const args = argsOf(prep({ prompt: "just a prompt" }));
    expect(args[0]).toBe("-p");
    expect(args.slice(-2)).toEqual(["--", "just a prompt"]);
    expect(args).toContain("--export");
  });

  it("emits only `-p -- <prompt>` when the export is declined", () => {
    const args = argsOf(prep({ prompt: "just a prompt", exportSession: false }));
    expect(args).toEqual(["-p", "--", "just a prompt"]);
  });

  it("rewrites the prompt text when optimizePrompt is true", () => {
    // Use a prompt the optimizer measurably shrinks (collapses whitespace).
    const raw = "please    do      the     thing";
    const args = argsOf(prep({ prompt: raw, optimizePrompt: true }));
    expect(args[0]).toBe("-p");
    expect(args.at(-1)).not.toBe(raw);
    expect(args.at(-1)!.length).toBeLessThanOrEqual(raw.length);
  });

  it("leaves the prompt verbatim when optimizePrompt is false", () => {
    const raw = "please    do      the     thing";
    const args = argsOf(prep({ prompt: raw, optimizePrompt: false }));
    expect(args.at(-1)).toBe(raw);
  });
});
