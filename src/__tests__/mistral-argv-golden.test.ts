/**
 * Mistral (Vibe) argv golden (Phase 4 Part B).
 *
 * Locks the EXACT `prepareMistralRequest(params).args` emission for every wired
 * `must_cover` flag: -p (--prompt), --output, --agent (permissionMode /
 * auto-approve alias), --enabled-tools (allowedTools), --disabled-tools
 * (disallowedTools), --trust, --max-turns, --max-price, --max-tokens, --workdir
 * (workingDir), --add-dir. Every flag
 * traces to `vibe --help` in /tmp/ffci-help/vibe_--help.txt.
 *
 * Sync/async parity: both `mistral_request` and `mistral_request_async` build
 * argv through this single `prepareMistralRequest` builder, so locking the
 * builder locks both surfaces.
 *
 * Admin-deferred (--setup, --check-upgrade) must_cover flags are NOT wired as
 * passthrough request fields; that classification is asserted in
 * provider-part-b-flag-classification.test.ts. --auto-approve / --yolo are
 * covered as the permissionMode "auto-approve" alias (--agent auto-approve).
 *
 * Test-veracity: the explicit per-flag assertions are the oracle. Renaming any
 * emission in `prepareMistralRequest` (e.g. "--enabled-tools" -> "--tools",
 * "--workdir" -> "--cwd", or dropping the default `--agent accept-edits` push)
 * flips this suite red.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prepareMistralRequest } from "../index.js";

function argsFor(params: Record<string, unknown>): string[] {
  const prep = prepareMistralRequest({
    prompt: "PROMPT",
    approvalStrategy: "legacy",
    optimizePrompt: false,
    operation: "mistral_request",
    ...params,
  } as never);
  if (!("args" in prep)) {
    throw new Error("prepareMistralRequest returned an error response instead of CliRequestPrep");
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

describe("mistral argv golden (Phase 4 Part B)", () => {
  // The legacy default is bypass-sensitive (#155); pin the operator opt-in off
  // so the golden argv is deterministic, and restore it afterward.
  let savedBypass: string | undefined;
  beforeEach(() => {
    savedBypass = process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
    delete process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
  });
  afterEach(() => {
    if (savedBypass === undefined) delete process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
    else process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = savedBypass;
  });

  it("minimal request emits -p + prompt and the default --agent accept-edits (#155)", () => {
    expect(argsFor({})).toEqual(["-p", "PROMPT", "--agent", "accept-edits"]);
  });

  it("legacy default escalates to --agent auto-approve only with the operator opt-in (#155)", () => {
    process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = "1";
    expect(argsFor({})).toEqual(["-p", "PROMPT", "--agent", "auto-approve"]);
  });

  it("kitchen sink: every wired flag emits with its value", () => {
    const args = argsFor({
      permissionMode: "accept-edits",
      outputFormat: "json",
      allowedTools: ["bash", "grep"],
      disallowedTools: ["network", "shell"],
      trust: true,
      maxTurns: 7,
      maxPrice: 1.5,
      maxTokens: 4096,
      workingDir: "/tmp/wd",
      addDir: ["/x", "/y"],
    });
    expect(args.slice(0, 2)).toEqual(["-p", "PROMPT"]);
    expect(valueAfter(args, "--output")).toBe("json");
    expect(valueAfter(args, "--agent")).toBe("accept-edits");
    expect(count(args, "--enabled-tools")).toBe(2);
    const firstTool = args.indexOf("--enabled-tools");
    expect(args[firstTool + 1]).toBe("bash");
    expect(args[firstTool + 3]).toBe("grep");
    expect(count(args, "--disabled-tools")).toBe(2);
    const firstDisabledTool = args.indexOf("--disabled-tools");
    expect(args[firstDisabledTool + 1]).toBe("network");
    expect(args[firstDisabledTool + 3]).toBe("shell");
    expect(firstDisabledTool).toBeGreaterThan(args.lastIndexOf("--enabled-tools"));
    expect(count(args, "--trust")).toBe(1);
    expect(valueAfter(args, "--max-turns")).toBe("7");
    expect(valueAfter(args, "--max-price")).toBe("1.5");
    expect(valueAfter(args, "--max-tokens")).toBe("4096");
    expect(valueAfter(args, "--workdir")).toBe("/tmp/wd");
    expect(count(args, "--add-dir")).toBe(2);
    const firstDir = args.indexOf("--add-dir");
    expect(args[firstDir + 1]).toBe("/x");
    expect(args[firstDir + 3]).toBe("/y");
  });

  it("permissionMode auto-approve is the --auto-approve / --yolo alias", () => {
    const args = argsFor({ permissionMode: "auto-approve" });
    expect(valueAfter(args, "--agent")).toBe("auto-approve");
  });

  it("resolved model selects via VIBE_ACTIVE_MODEL env, never a --model flag", () => {
    const prep = prepareMistralRequest({
      prompt: "PROMPT",
      approvalStrategy: "legacy",
      optimizePrompt: false,
      operation: "mistral_request",
      model: "mistral-large",
    } as never);
    if (!("args" in prep)) throw new Error("unexpected error response");
    expect(count(prep.args, "--model")).toBe(0);
    expect(prep.mistralEnv.VIBE_ACTIVE_MODEL).toBeTruthy();
  });
});
