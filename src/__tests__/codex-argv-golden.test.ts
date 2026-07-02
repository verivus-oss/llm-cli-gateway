/**
 * Codex argv golden (Phase 4 Part A).
 *
 * Locks the EXACT `prepareCodexRequest(params).args` emission for the remaining
 * `codex exec` flags wired in Part A: --enable, --disable, --strict-config,
 * --oss, --local-provider, --color, --output-last-message, and the top-level
 * danger flag --dangerously-bypass-hook-trust. Every flag traces to
 * `codex exec --help`. --skip-git-repo-check is already emitted unconditionally
 * (asserted below), so it carries no toggle field.
 *
 * Branch gating (mirrors slice ζ -C/--add-dir): provider/output-selection flags
 * (--oss, --local-provider, --strict-config, --color, --output-last-message) are
 * emitted on NEW sessions only; --enable/--disable are `-c features.*`
 * equivalents and emit on resume too; --dangerously-bypass-hook-trust emits
 * unconditionally.
 *
 * Test-veracity: the new-session kitchen-sink is asserted via exact `toEqual`.
 * Deleting or renaming any emission (e.g. "--oss" -> "--use-oss", or moving
 * --strict-config out of the new-session branch) flips the exact-argv oracle and
 * the resume-gating assertions red.
 *
 * TUI-only / gateway-managed flags (--remote, --remote-auth-token-env) are NOT
 * wired; that classification is asserted in
 * provider-part-a-flag-classification.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { prepareCodexRequest } from "../index.js";

const BASE_PARAMS = {
  prompt: "hello codex",
  fullAuto: false,
  dangerouslyBypassApprovalsAndSandbox: false,
  approvalStrategy: "legacy" as const,
  mcpServers: [] as never[],
  optimizePrompt: false,
  operation: "codex_request",
};

function argsFor(extra: Record<string, unknown>): string[] {
  const result = prepareCodexRequest({ ...BASE_PARAMS, ...extra } as never);
  if (!("args" in result)) {
    throw new Error(
      "prepareCodexRequest returned an ExtendedToolResponse instead of CliRequestPrep: " +
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

describe("codex argv golden (Phase 4 Part A)", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), "codex-argv-golden-"));
    originalHome = process.env.HOME;
    process.env.HOME = testHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(testHome, { recursive: true, force: true });
  });

  it("emits the always-on baseline (--json, --skip-git-repo-check) and no Part A flags", () => {
    const args = argsFor({});
    expect(args).toEqual(["exec", "--json", "--skip-git-repo-check", "hello codex"]);
    // Guardrail: the danger flag is never silently defaulted on.
    expect(args).not.toContain("--dangerously-bypass-hook-trust");
    for (const flag of [
      "--enable",
      "--disable",
      "--strict-config",
      "--oss",
      "--local-provider",
      "--color",
      "--output-last-message",
    ]) {
      expect(args).not.toContain(flag);
    }
  });

  it("emits every wired Part A flag with exact argv on a NEW session", () => {
    const args = argsFor({
      enable: ["feat_a", "feat_b"],
      disable: ["feat_c"],
      strictConfig: true,
      oss: true,
      localProvider: "ollama",
      color: "never",
      outputLastMessage: "/tmp/last.txt",
      dangerouslyBypassHookTrust: true,
    });
    expect(args).toEqual([
      "exec",
      "--dangerously-bypass-hook-trust",
      "--json",
      "--skip-git-repo-check",
      "--oss",
      "--local-provider",
      "ollama",
      "--strict-config",
      "--color",
      "never",
      "--output-last-message",
      "/tmp/last.txt",
      "--enable",
      "feat_a",
      "--enable",
      "feat_b",
      "--disable",
      "feat_c",
      "hello codex",
    ]);
    expect(args).toMatchSnapshot();

    // Value flags: value is the immediately-following argv token.
    expect(valueAfter(args, "--local-provider")).toBe("ollama");
    expect(valueAfter(args, "--color")).toBe("never");
    expect(valueAfter(args, "--output-last-message")).toBe("/tmp/last.txt");
    // Repeatable feature toggles: one instance per entry.
    expect(count(args, "--enable")).toBe(2);
    expect(count(args, "--disable")).toBe(1);
  });

  it("on RESUME emits enable/disable + hook-trust but gates out provider/output flags", () => {
    const args = argsFor({
      resumeLatest: true,
      enable: ["feat_a"],
      disable: ["feat_c"],
      strictConfig: true,
      oss: true,
      localProvider: "ollama",
      color: "never",
      outputLastMessage: "/tmp/last.txt",
      dangerouslyBypassHookTrust: true,
    });
    expect(args.slice(0, 3)).toEqual(["exec", "resume", "--last"]);
    // Resume-safe (both branches): -c features.* equivalents + unconditional danger flag.
    expect(args).toContain("--enable");
    expect(args).toContain("feat_a");
    expect(args).toContain("--disable");
    expect(args).toContain("feat_c");
    expect(args).toContain("--dangerously-bypass-hook-trust");
    // New-session-only: resume inherits the original session's provider/output config.
    expect(args).not.toContain("--oss");
    expect(args).not.toContain("--local-provider");
    expect(args).not.toContain("--strict-config");
    expect(args).not.toContain("--color");
    expect(args).not.toContain("--output-last-message");
  });

  it("produces byte-identical argv for sync and async operations (parity)", () => {
    const shared = {
      enable: ["feat_a"],
      oss: true,
      color: "auto",
      outputLastMessage: "/tmp/x",
    };
    const sync = argsFor({ ...shared, operation: "codex_request" });
    const async = argsFor({ ...shared, operation: "codex_request_async" });
    expect(async).toEqual(sync);
  });
});
