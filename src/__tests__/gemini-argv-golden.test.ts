/**
 * Gemini (Antigravity `agy`) argv golden (Phase 4 Part B).
 *
 * Locks the EXACT `prepareGeminiRequest(params).args` emission for every wired
 * `must_cover` flag: --print, --model, --add-dir (includeDirs), --sandbox,
 * --dangerously-skip-permissions (yolo), --project, --new-project,
 * --print-timeout. Every flag traces to `agy --help` in
 * /tmp/ffci-help/agy_--help.txt.
 *
 * Sync/async parity: both `gemini_request` and `gemini_request_async` build
 * argv through this single `prepareGeminiRequest` builder, so locking the
 * builder locks both surfaces.
 *
 * Interactive-only (--prompt-interactive) and admin-deferred (--log-file)
 * must_cover flags are NOT wired as passthrough request fields; that
 * classification is asserted in provider-part-b-flag-classification.test.ts.
 *
 * Test-veracity: the explicit per-flag assertions are the oracle. Renaming any
 * emission in `prepareGeminiRequest` (e.g. "--add-dir" -> "--dir", dropping the
 * `--new-project` push, emitting "--project" when only `newProject` is set, or
 * dropping the `--print-timeout` push) flips this suite red.
 */
import { describe, it, expect } from "vitest";
import { prepareGeminiRequest } from "../index.js";

function prepFor(params: Record<string, unknown>): ReturnType<typeof prepareGeminiRequest> {
  return prepareGeminiRequest({
    prompt: "PROMPT",
    approvalStrategy: "legacy",
    optimizePrompt: false,
    operation: "gemini_request",
    ...params,
  } as never);
}

function argsFor(params: Record<string, unknown>): string[] {
  const prep = prepFor(params);
  if (!("args" in prep)) {
    throw new Error("prepareGeminiRequest returned an error response instead of CliRequestPrep");
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

describe("gemini argv golden (Phase 4 Part B)", () => {
  it("emits only --print + prompt for a minimal request", () => {
    expect(argsFor({})).toEqual(["--print", "PROMPT"]);
  });

  it("kitchen sink (project variant): every wired flag emits in order", () => {
    const args = argsFor({
      model: "gemini-3-pro-preview",
      includeDirs: ["/a", "/b"],
      sandbox: true,
      yolo: true,
      project: "proj-1",
    });
    // Prompt run head.
    expect(args.slice(0, 2)).toEqual(["--print", "PROMPT"]);
    // --model with a resolved value.
    expect(args.indexOf("--model")).toBeGreaterThan(0);
    expect(valueAfter(args, "--model")).toBeTruthy();
    // --add-dir emitted once per includeDirs entry, in order.
    expect(count(args, "--add-dir")).toBe(2);
    const firstDir = args.indexOf("--add-dir");
    expect(args[firstDir + 1]).toBe("/a");
    expect(args[firstDir + 3]).toBe("/b");
    // --sandbox (bare) and --dangerously-skip-permissions (from yolo).
    expect(count(args, "--sandbox")).toBe(1);
    expect(count(args, "--dangerously-skip-permissions")).toBe(1);
    // --project with its id; --new-project absent.
    expect(valueAfter(args, "--project")).toBe("proj-1");
    expect(count(args, "--new-project")).toBe(0);
  });

  it("printTimeout emits --print-timeout with its duration value", () => {
    const args = argsFor({ printTimeout: "30s" });
    expect(valueAfter(args, "--print-timeout")).toBe("30s");
    // Absent by default (no value flag when unset or empty).
    expect(count(argsFor({}), "--print-timeout")).toBe(0);
    expect(count(argsFor({ printTimeout: "" }), "--print-timeout")).toBe(0);
  });

  it("newProject emits --new-project and never --project", () => {
    const args = argsFor({ newProject: true });
    expect(count(args, "--new-project")).toBe(1);
    expect(count(args, "--project")).toBe(0);
  });

  it("approvalMode yolo also emits --dangerously-skip-permissions", () => {
    const args = argsFor({ approvalMode: "yolo" });
    expect(count(args, "--dangerously-skip-permissions")).toBe(1);
  });

  it("project + newProject together is rejected (no args)", () => {
    const prep = prepFor({ project: "p", newProject: true });
    expect("args" in prep).toBe(false);
  });
});
