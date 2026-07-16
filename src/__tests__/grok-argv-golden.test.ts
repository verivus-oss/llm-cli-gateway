/**
 * Grok argv golden — behaviour-preservation baseline for the contract-driven
 * argv cutover.
 *
 * These snapshots capture the EXACT `prepareGrokRequest(params).args` output
 * for requests that interleave covered flags with every special flag
 * (`--model`, `--always-approve` / `--permission-mode`, `--agents`,
 * `--prompt-json`, `--worktree`). The snapshot is written against the
 * hand-written argv block, then must remain byte-identical after the block is
 * replaced by `buildArgvFromGeneration` run-segments. Any reordering or dropped
 * flag changes the snapshot and fails the cutover.
 */
import { describe, it, expect } from "vitest";
import { prepareGrokRequest } from "../index.js";

function argsFor(params: Record<string, unknown>): string[] {
  const prep = prepareGrokRequest({
    prompt: "PROMPT",
    operation: "grok_request",
    approvalStrategy: "legacy",
    optimizePrompt: false,
    ...params,
  });
  if (!("args" in prep)) throw new Error("prepareGrokRequest returned an error response");
  return prep.args;
}

describe("grok argv golden (pre/post cutover parity)", () => {
  it("minimal prompt-only request", () => {
    expect(argsFor({})).toMatchSnapshot();
  });

  it("permission-mode path with covered flags across every special boundary", () => {
    expect(
      argsFor({
        model: "grok-4",
        outputFormat: "json",
        permissionMode: "acceptEdits",
        effort: "high",
        reasoningEffort: "medium",
        allowedTools: ["Read", "Edit"],
        disallowedTools: ["Bash"],
        maxTurns: 9,
        workingDir: "/tmp/wd",
        sandbox: "workspace-write",
        rules: "@rules.md",
        systemPromptOverride: "be terse",
        allow: ["read", "write"],
        deny: ["exec"],
        compactionMode: "segments",
        compactionDetail: "verbose",
        agent: "reviewer",
        bestOfN: 3,
        check: true,
        disableWebSearch: true,
        todoGate: true,
        verbatim: true,
        agents: '{"reviewer":{"description":"d","prompt":"p"}}',
        promptFile: "/tmp/p.txt",
        promptJson: '[{"type":"text","text":"x"}]',
        experimentalMemory: true,
        noAltScreen: true,
        noMemory: true,
        noPlan: true,
        noSubagents: true,
        oauth: true,
        restoreCode: true,
        leaderSocket: "/run/grok.sock",
        nativeWorktree: true,
      })
    ).toMatchSnapshot();
  });

  it("always-approve path with named worktree string", () => {
    expect(
      argsFor({
        model: "grok-4",
        alwaysApprove: true,
        effort: "low",
        allow: ["read"],
        nativeWorktree: "feature-branch",
      })
    ).toMatchSnapshot();
  });

  it("no covered flags, only specials", () => {
    expect(
      argsFor({ model: "grok-4", permissionMode: "plan", nativeWorktree: true })
    ).toMatchSnapshot();
  });

  it("named worktree with --worktree-ref (cross-flag guard)", () => {
    // Phase 4 Part B: worktreeRef is a must_cover flag; it may only emit
    // alongside nativeWorktree. Mutation flip: dropping the `--worktree-ref`
    // push, or emitting it without `--worktree`, changes this snapshot.
    const args = argsFor({ nativeWorktree: "feat", worktreeRef: "main" });
    expect(args).toMatchSnapshot();
    const w = args.indexOf("--worktree");
    expect(w).toBeGreaterThanOrEqual(0);
    const r = args.indexOf("--worktree-ref");
    expect(r).toBeGreaterThan(w);
    expect(args[r + 1]).toBe("main");
  });
});
