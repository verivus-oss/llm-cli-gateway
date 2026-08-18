/**
 * Pass-through across all seven providers.
 *
 * The hazard this file exists for: four of the seven append the prompt inside
 * their own prep function, so `args` already ends with the `--` terminator.
 * Appending pass-through tokens there turns them into PROMPT TEXT, silently, and
 * an argv assertion that only checks membership passes anyway.
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
import { runWithRequestContext, type GatewayRequestContext } from "../request-context.js";

const REMOTE: GatewayRequestContext = { transport: "http", authScopes: [], authPrincipal: "p1" };

const COMMON = { prompt: "hi", approvalStrategy: "legacy" as const, optimizePrompt: false };

const PROVIDERS = [
  { name: "claude", prepare: prepareClaudeRequest, op: "claude_request" },
  { name: "codex", prepare: prepareCodexRequest, op: "codex_request" },
  { name: "gemini", prepare: prepareGeminiRequest, op: "gemini_request" },
  { name: "grok", prepare: prepareGrokRequest, op: "grok_request" },
  { name: "mistral", prepare: prepareMistralRequest, op: "mistral_request" },
  { name: "devin", prepare: prepareDevinRequest, op: "devin_request" },
  { name: "cursor", prepare: prepareCursorRequest, op: "cursor_request" },
] as const;

function argvOf(result: unknown): string[] {
  if (typeof result === "object" && result !== null && "args" in result) {
    return (result as { args: string[] }).args;
  }
  throw new Error(`expected a prepared request, got: ${JSON.stringify(result)}`);
}

function errorText(result: unknown): string {
  if (typeof result === "object" && result !== null && !("args" in result)) {
    return (result as { content: { text: string }[] }).content[0].text;
  }
  throw new Error("expected an error response");
}

describe.each(PROVIDERS)("$name pass-through", ({ prepare, op }) => {
  const call = (providerFlags: Record<string, unknown>) =>
    prepare({ ...COMMON, operation: op, providerFlags } as never, resolveGatewayServerRuntime());

  it("reaches argv with a flag that has no named parameter", () => {
    const args = argvOf(call({ "--gateway-probe-unknown": "3" }));
    expect(args).toContain("--gateway-probe-unknown");
    expect(args[args.indexOf("--gateway-probe-unknown") + 1]).toBe("3");
  });

  it("lands BEFORE the prompt terminator, not as prompt text", () => {
    const args = argvOf(call({ "--gateway-probe-unknown": true }));
    const terminator = args.lastIndexOf("--");
    if (terminator === -1) return; // this provider appends the prompt downstream
    expect(args.indexOf("--gateway-probe-unknown")).toBeLessThan(terminator);
  });

  it("refuses a value that could be parsed as another option", () => {
    expect(errorText(call({ "--gateway-probe-unknown": "--always-approve" }))).toMatch(
      /must not start with/
    );
  });

  it("LOCAL callers are unrestricted", () => {
    expect(argvOf(call({ "--dangerously-skip-permissions": true }))).toContain(
      "--dangerously-skip-permissions"
    );
  });

  it("REMOTE callers are refused the approval and host-path classes", () => {
    for (const flag of ["--dangerously-skip-permissions", "--add-dir", "--sandbox"]) {
      const res = runWithRequestContext(REMOTE, () => call({ [flag]: true }));
      expect(errorText(res), flag).toContain("refused for remote HTTP/OAuth callers");
    }
  });
});
