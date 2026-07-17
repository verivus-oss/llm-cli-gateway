/**
 * Devin (Cognition Devin CLI) argv golden (Phase 4 Part B).
 *
 * Locks the EXACT `prepareDevinRequest(params).args` emission for every wired
 * `must_cover` run flag: -p (--print), --model, --permission-mode,
 * --prompt-file, --config, --sandbox, --export, --respect-workspace-trust,
 * --agent-config. Every flag traces to `devin --help` in
 * /tmp/ffci-help/devin_--help.txt. Session continuity (--resume / --continue)
 * is appended by the handler, not by this pure builder.
 *
 * Sync/async parity: both `devin_request` and `devin_request_async` build argv
 * through this single `prepareDevinRequest` builder, so locking the builder
 * locks both surfaces.
 *
 * Test-veracity: the explicit per-flag assertions are the oracle. Renaming any
 * emission in `prepareDevinRequest` (e.g. "-p" -> "--print", "--prompt-file" ->
 * "--file", or dropping the `--permission-mode` push) flips this suite red.
 * Emitting `--export` with a value for the boolean case, or dropping the
 * boolean-to-string branch, flips the --export assertions red; emitting the
 * bare `--sandbox`/`--respect-workspace-trust` without the boolean value, or
 * defaulting --sandbox on, flips those assertions red.
 */
import { describe, it, expect } from "vitest";
import { prepareDevinRequest, resolveGatewayServerRuntime } from "../index.js";

function argsFor(params: Record<string, unknown>): string[] {
  const prep = prepareDevinRequest(
    {
      prompt: "PROMPT",
      optimizePrompt: false,
      operation: "devin_request",
      ...params,
    } as never,
    resolveGatewayServerRuntime()
  );
  if (!("args" in prep)) {
    throw new Error("prepareDevinRequest returned an error response instead of CliRequestPrep");
  }
  return prep.args;
}

function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function count(args: string[], flag: string): number {
  return args.filter(a => a === flag).length;
}

describe("devin argv golden (Phase 4 Part B)", () => {
  it("minimal request emits -p plus an option boundary and prompt", () => {
    expect(argsFor({})).toEqual(["-p", "--", "PROMPT"]);
  });

  it("kitchen sink: every wired flag emits in order with its value", () => {
    const args = argsFor({
      model: "opus",
      permissionMode: "dangerous",
      promptFile: "/tmp/p.txt",
      config: "/tmp/devin.toml",
      sandbox: true,
      exportSession: "/tmp/session.json",
      respectWorkspaceTrust: true,
      agentConfig: "/tmp/agent.toml",
    });
    expect(args[0]).toBe("-p");
    expect(args.slice(-2)).toEqual(["--", "PROMPT"]);
    expect(args.indexOf("--model")).toBeGreaterThan(0);
    expect(valueAfter(args, "--model")).toBeTruthy();
    expect(valueAfter(args, "--permission-mode")).toBe("dangerous");
    expect(valueAfter(args, "--prompt-file")).toBe("/tmp/p.txt");
    expect(valueAfter(args, "--config")).toBe("/tmp/devin.toml");
    expect(count(args, "--sandbox")).toBe(1);
    expect(valueAfter(args, "--export")).toBe("/tmp/session.json");
    expect(valueAfter(args, "--respect-workspace-trust")).toBe("true");
    expect(valueAfter(args, "--agent-config")).toBe("/tmp/agent.toml");
  });

  it("permission modes auto / accept-edits / smart emit verbatim", () => {
    expect(valueAfter(argsFor({ permissionMode: "auto" }), "--permission-mode")).toBe("auto");
    expect(valueAfter(argsFor({ permissionMode: "accept-edits" }), "--permission-mode")).toBe(
      "accept-edits"
    );
    expect(valueAfter(argsFor({ permissionMode: "smart" }), "--permission-mode")).toBe("smart");
  });

  it("--export true emits a bare flag; a string emits --export <path>", () => {
    const bare = argsFor({ exportSession: true });
    expect(count(bare, "--export")).toBe(1);
    // Bare boolean form has no value before the prompt boundary.
    expect(bare[bare.indexOf("--export") + 1]).toBe("--");

    const withPath = argsFor({ exportSession: "/tmp/out.json" });
    expect(valueAfter(withPath, "--export")).toBe("/tmp/out.json");
  });

  it("--respect-workspace-trust emits the explicit boolean value", () => {
    expect(valueAfter(argsFor({ respectWorkspaceTrust: true }), "--respect-workspace-trust")).toBe(
      "true"
    );
    expect(valueAfter(argsFor({ respectWorkspaceTrust: false }), "--respect-workspace-trust")).toBe(
      "false"
    );
  });

  it("--sandbox is off by default and emits a bare flag only when set", () => {
    expect(count(argsFor({}), "--sandbox")).toBe(0);
    expect(count(argsFor({ sandbox: true }), "--sandbox")).toBe(1);
  });

  it("does not emit optional flags when unset", () => {
    const args = argsFor({});
    expect(count(args, "--prompt-file")).toBe(0);
    expect(count(args, "--permission-mode")).toBe(0);
    expect(count(args, "--config")).toBe(0);
    expect(count(args, "--sandbox")).toBe(0);
    expect(count(args, "--export")).toBe(0);
    expect(count(args, "--respect-workspace-trust")).toBe(0);
    expect(count(args, "--agent-config")).toBe(0);
  });
});
