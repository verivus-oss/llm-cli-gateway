/**
 * Regression tests for the branch code-review fixes.
 *
 * Each block pins one reviewed defect so a later refactor that reopens the hole
 * flips this suite red:
 *  - H1: remote (HTTP/OAuth) callers may not pass host-path / plugin fields.
 *  - M3: the ACP permission bridge never turns one approval into allow_always.
 *  - M4: Codex/Gemini clean-exit failures surface a warning (not silent success).
 *  - L3: an unknown subcommand verb never inherits a read-only family risk.
 *  - L5: session_info_update is a forward-compatible unknown variant.
 *  - L6: ACP error redaction covers Google/GitHub/Slack token shapes.
 *  - L7/L8: json-mode parsers tolerate a surrounding banner line + delta replace.
 */
import { describe, expect, it } from "vitest";

import {
  buildCliResponse,
  prepareClaudeRequest,
  prepareCodexRequest,
  prepareDevinRequest,
  prepareGrokRequest,
  resolveGatewayServerRuntime,
} from "../index.js";
import { runWithRequestContext, type GatewayRequestContext } from "../request-context.js";
import { createAcpPermissionDecider } from "../acp/permission-bridge.js";
import type {
  HostCallbackContext,
  PermissionOption,
  RequestPermissionRequest,
} from "../acp/types.js";
import { ApprovalManager } from "../approval-manager.js";
import { classifyOperationRisk, registerProviderAdminTools } from "../provider-admin-tools.js";
import { noopLogger } from "../logger.js";
import { KNOWN_SESSION_UPDATE_VARIANTS, isUnknownSessionUpdate } from "../acp/types.js";
import { redactAcpMessage } from "../acp/errors.js";
import { parseGeminiJson, parseGeminiStreamJson } from "../gemini-json-parser.js";
import { parseGrokJson } from "../grok-json-parser.js";

const REMOTE: GatewayRequestContext = { transport: "http", authScopes: [], authPrincipal: "p1" };

function isErrorResponse(result: unknown): result is { content: { text: string }[] } {
  return typeof result === "object" && result !== null && !("args" in result);
}

// -------------------------------------------------------------------------
// H1: remote host-path / plugin field rejection
// -------------------------------------------------------------------------

describe("H1: remote callers may not pass host-path / plugin fields", () => {
  const CLAUDE_BASE = {
    prompt: "hi",
    outputFormat: "text" as const,
    dangerouslySkipPermissions: false,
    approvalStrategy: "legacy" as const,
    mcpServers: [] as never[],
    strictMcpConfig: false,
    optimizePrompt: false,
    operation: "claude_request",
  };
  const CODEX_BASE = {
    prompt: "hi",
    fullAuto: false,
    dangerouslyBypassApprovalsAndSandbox: false,
    approvalStrategy: "legacy" as const,
    mcpServers: [] as never[],
    optimizePrompt: false,
    operation: "codex_request",
  };
  const DEVIN_BASE = { prompt: "hi", optimizePrompt: false, operation: "devin_request" };
  const GROK_BASE = {
    prompt: "hi",
    approvalStrategy: "legacy" as const,
    optimizePrompt: false,
    operation: "grok_request",
  };

  it.each([
    ["systemPromptFile", { systemPromptFile: "/etc/passwd" }],
    ["appendSystemPromptFile", { appendSystemPromptFile: "/etc/hosts" }],
    ["settings", { settings: "/root/.secret.json" }],
    ["pluginDir", { pluginDir: ["/opt/evil"] }],
    ["pluginUrl", { pluginUrl: ["https://evil.example/p.zip"] }],
    ["debugFile", { debugFile: "/home/u/.ssh/authorized_keys" }],
  ])("rejects Claude %s over the remote surface", (field, extra) => {
    const res = runWithRequestContext(REMOTE, () =>
      prepareClaudeRequest({ ...CLAUDE_BASE, ...extra } as never)
    );
    expect(isErrorResponse(res)).toBe(true);
    if (isErrorResponse(res)) expect(res.content[0].text).toContain(field);
  });

  it.each([
    ["outputLastMessage", { outputLastMessage: "/home/u/.ssh/authorized_keys" }],
    ["images", { images: ["/etc/shadow"] }],
    ["outputSchema", { outputSchema: "/etc/passwd" }],
  ])("rejects Codex %s over the remote surface", (field, extra) => {
    const res = runWithRequestContext(REMOTE, () =>
      prepareCodexRequest({ ...CODEX_BASE, ...extra } as never)
    );
    expect(isErrorResponse(res)).toBe(true);
    if (isErrorResponse(res)) expect(res.content[0].text).toContain(field);
  });

  it.each([
    ["promptFile", { promptFile: "/etc/passwd" }],
    ["config", { config: "/root/.config" }],
    ["agentConfig", { agentConfig: "/root/.agent" }],
    ["exportSession", { exportSession: "/home/u/.ssh/authorized_keys" }],
  ])("rejects Devin %s over the remote surface", (field, extra) => {
    const res = runWithRequestContext(REMOTE, () =>
      prepareDevinRequest({ ...DEVIN_BASE, ...extra } as never, resolveGatewayServerRuntime())
    );
    expect(isErrorResponse(res)).toBe(true);
    if (isErrorResponse(res)) expect(res.content[0].text).toContain(field);
  });

  it.each([
    ["promptFile", { promptFile: "/etc/passwd" }],
    ["leaderSocket", { leaderSocket: "/tmp/evil.sock" }],
    ["rules", { rules: "@/etc/shadow" }],
    ["agent", { agent: "/opt/evil/agent.md" }],
  ])("rejects Grok %s over the remote surface", (field, extra) => {
    const res = runWithRequestContext(REMOTE, () =>
      prepareGrokRequest({ ...GROK_BASE, ...extra } as never)
    );
    expect(isErrorResponse(res)).toBe(true);
    if (isErrorResponse(res)) expect(res.content[0].text).toContain(field);
  });

  it("allows Grok promptFile for a LOCAL (stdio) caller", () => {
    const res = prepareGrokRequest({ ...GROK_BASE, promptFile: "/tmp/p.txt" } as never);
    expect(isErrorResponse(res)).toBe(false);
  });

  it("allows the same fields for a LOCAL (stdio) caller", () => {
    // No request context means a local caller. The field is emitted, not rejected.
    const res = prepareClaudeRequest({ ...CLAUDE_BASE, systemPromptFile: "/tmp/sp.txt" } as never);
    expect(isErrorResponse(res)).toBe(false);
    if (!isErrorResponse(res)) {
      expect((res as { args: string[] }).args).toContain("--system-prompt-file");
    }
  });

  it("does not reject a remote request that uses no restricted field", () => {
    const res = runWithRequestContext(REMOTE, () =>
      prepareClaudeRequest({ ...CLAUDE_BASE } as never)
    );
    expect(isErrorResponse(res)).toBe(false);
  });

  it("leaves the bare-boolean exportSession form alone (not a caller path)", () => {
    const res = runWithRequestContext(REMOTE, () =>
      prepareDevinRequest(
        { ...DEVIN_BASE, exportSession: true } as never,
        resolveGatewayServerRuntime()
      )
    );
    expect(isErrorResponse(res)).toBe(false);
  });
});

// -------------------------------------------------------------------------
// M3: ACP permission bridge never grants allow_always from one approval
// -------------------------------------------------------------------------

describe("M3: permission bridge prefers a single-use allow", () => {
  const CTX: HostCallbackContext = { provider: "grok", method: "session/request_permission" };
  const ALLOW_ONCE: PermissionOption = { optionId: "once", name: "Once", kind: "allow_once" };
  const ALLOW_ALWAYS: PermissionOption = {
    optionId: "always",
    name: "Always",
    kind: "allow_always",
  };
  const REJECT: PermissionOption = { optionId: "rej", name: "Reject", kind: "reject_once" };

  const approve = (): ApprovalManager =>
    ({ decide: () => ({ status: "approved" }) }) as unknown as ApprovalManager;
  const request = (options: PermissionOption[]): RequestPermissionRequest => ({
    sessionId: "s1",
    options,
    toolCall: { kind: "read", title: "read a file" },
  });

  it("selects allow_once even when allow_always is listed first", async () => {
    const decide = createAcpPermissionDecider({ approvalManager: approve(), provider: "grok" });
    const res = await decide(request([ALLOW_ALWAYS, ALLOW_ONCE, REJECT]), CTX);
    expect(res.outcome).toEqual({ outcome: "selected", optionId: "once" });
  });

  it("denies (never grants allow_always) when only a persistent allow is offered", async () => {
    const decide = createAcpPermissionDecider({ approvalManager: approve(), provider: "grok" });
    const res = await decide(request([ALLOW_ALWAYS, REJECT]), CTX);
    expect(res.outcome).toEqual({ outcome: "cancelled" });
  });

  it("accepts a generic non-always allow when allow_once is absent", async () => {
    const decide = createAcpPermissionDecider({ approvalManager: approve(), provider: "grok" });
    const generic: PermissionOption = { optionId: "gen", name: "Allow", kind: "allow" };
    const res = await decide(request([generic, REJECT]), CTX);
    expect(res.outcome).toEqual({ outcome: "selected", optionId: "gen" });
  });
});

// -------------------------------------------------------------------------
// M2: read-only admin ops are gated for remote callers
// -------------------------------------------------------------------------

describe("M2: read-only provider admin ops require the remote CLI-admin gate", () => {
  type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

  function captureAdminTools(): Map<string, ToolHandler> {
    const handlers = new Map<string, ToolHandler>();
    const server = {
      tool: (name: string, _d: unknown, _s: unknown, _a: unknown, handler: ToolHandler) => {
        handlers.set(name, handler);
      },
    };
    registerProviderAdminTools(server as never, {
      approvalManager: {} as never,
      logger: noopLogger,
      allowMutatingCliAdminOps: false,
    });
    return handlers;
  }

  // Remote HTTP caller with no cli:admin scope. The gate short-circuits BEFORE
  // any provider CLI discovery/spawn, so this needs no provider binaries.
  const remoteNoScope: GatewayRequestContext = { transport: "http", authScopes: [] };

  it("gates provider_admin_list for a remote caller lacking cli:admin", async () => {
    const handler = captureAdminTools().get("provider_admin_list")!;
    const res = await runWithRequestContext(remoteNoScope, () =>
      handler({ includeUnavailable: false })
    );
    expect(res.content[0].text).toContain("not permitted for remote callers");
  });

  it("gates provider_admin_run for a remote caller lacking cli:admin", async () => {
    const handler = captureAdminTools().get("provider_admin_run")!;
    const res = await runWithRequestContext(remoteNoScope, () =>
      handler({ provider: "claude", operationId: "doctor" })
    );
    expect(res.content[0].text).toContain("not permitted for remote callers");
  });
});

// -------------------------------------------------------------------------
// M4: Codex/Gemini clean-exit failures surface a warning
// -------------------------------------------------------------------------

describe("M4: clean-exit provider failures are not silent success", () => {
  function minimalPrep(): never {
    return {
      corrId: "c",
      effectivePrompt: "hi",
      resolvedModel: undefined,
      requestedMcpServers: [],
      approvalDecision: null,
      args: [],
      stablePrefixHash: null,
      stablePrefixTokens: null,
    } as never;
  }

  it("flags a Codex turn.failed emitted before exit 0", () => {
    const stdout = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "partial" } }),
      JSON.stringify({ type: "turn.failed", error: { message: "context deadline exceeded" } }),
    ].join("\n");
    const res = buildCliResponse(
      "codex",
      stdout,
      false,
      "c",
      undefined,
      minimalPrep(),
      5,
      undefined,
      "json"
    );
    expect(res.structuredContent?.resultIsError).toBe(true);
    expect(res.warnings?.some(w => w.code === "codex_result_error")).toBe(true);
    expect(res.isError).toBeUndefined();
  });

  it("flags a Gemini result status:error on exit 0", () => {
    const stdout = JSON.stringify({ response: "partial", status: "error" });
    const res = buildCliResponse(
      "gemini",
      stdout,
      false,
      "c",
      undefined,
      minimalPrep(),
      5,
      undefined,
      "json"
    );
    expect(res.warnings?.some(w => w.code === "gemini_result_error")).toBe(true);
  });

  it("does NOT flag a clean Gemini result", () => {
    const stdout = JSON.stringify({ response: "ok", status: "success" });
    const res = buildCliResponse(
      "gemini",
      stdout,
      false,
      "c",
      undefined,
      minimalPrep(),
      5,
      undefined,
      "json"
    );
    expect(res.warnings?.some(w => w.code === "gemini_result_error")).toBeFalsy();
  });
});

// -------------------------------------------------------------------------
// L3: unknown subcommand verb never inherits a read-only family risk
// -------------------------------------------------------------------------

describe("L3: unknown subcommand verbs escalate off read_only", () => {
  it("escalates an unknown subcommand under a read-only family to require approval", () => {
    expect(classifyOperationRisk("rotate", "read_only", { isSubcommand: true })).toBe(
      "writes_local_config"
    );
  });
  it("keeps a known read verb read_only even as a subcommand", () => {
    expect(classifyOperationRisk("list", "read_only", { isSubcommand: true })).toBe("read_only");
  });
  it("does NOT escalate a read-only LEAF family (not a subcommand)", () => {
    expect(classifyOperationRisk("doctor", "read_only")).toBe("read_only");
  });
  it("still maps a destructive verb to destructive", () => {
    expect(classifyOperationRisk("delete", "read_only", { isSubcommand: true })).toBe(
      "destructive"
    );
  });
});

// -------------------------------------------------------------------------
// L5: session_info_update is a forward-compatible unknown variant
// -------------------------------------------------------------------------

describe("L5: session_info_update known/unknown notions agree", () => {
  it("is not listed as a known variant", () => {
    expect(KNOWN_SESSION_UPDATE_VARIANTS as readonly string[]).not.toContain("session_info_update");
  });
  it("is reported unknown (tolerant passthrough)", () => {
    expect(isUnknownSessionUpdate({ sessionUpdate: "session_info_update" })).toBe(true);
  });
  it("every listed variant is still reported known", () => {
    for (const v of KNOWN_SESSION_UPDATE_VARIANTS) {
      expect(isUnknownSessionUpdate({ sessionUpdate: v })).toBe(false);
    }
  });
});

// -------------------------------------------------------------------------
// L6: ACP error redaction covers more token shapes
// -------------------------------------------------------------------------

describe("L6: redactAcpMessage scrubs Google/GitHub/Slack tokens", () => {
  it("redacts a Google AIza key", () => {
    const key = "AIzaSyA1234567890abcdefghijklmnopqrstuvw";
    expect(redactAcpMessage(`spawn failed with ${key}`)).not.toContain(key);
  });
  it("redacts a GitHub token", () => {
    const tok = "ghp_0123456789012345678901234567890123Ab";
    expect(redactAcpMessage(`auth ${tok} rejected`)).not.toContain(tok);
  });
  it("redacts a Slack token", () => {
    const tok = "xoxb-1234567890-0987654321-abcdefghij";
    expect(redactAcpMessage(`slack ${tok}`)).not.toContain(tok);
  });
});

// -------------------------------------------------------------------------
// L7 / L8: json-mode parsers tolerate a surrounding banner; delta replace
// -------------------------------------------------------------------------

describe("L7/L8: tolerant json-mode parsing", () => {
  it("parseGeminiJson recovers telemetry despite a leading banner line", () => {
    const stdout =
      "Ripgrep not available; falling back.\n" +
      JSON.stringify({
        response: "hi",
        status: "success",
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
      });
    const parsed = parseGeminiJson(stdout);
    expect(parsed?.response).toBe("hi");
    expect(parsed?.usage?.input_tokens).toBe(5);
  });

  it("parseGrokJson recovers telemetry despite a leading banner line", () => {
    const stdout = "WARN: deprecated flag\n" + JSON.stringify({ text: "hi", sessionId: "s1" });
    const parsed = parseGrokJson(stdout);
    expect(parsed?.text).toBe("hi");
    expect(parsed?.sessionId).toBe("s1");
  });

  it("parseGeminiStreamJson replaces (not doubles) on a consolidated non-delta message", () => {
    const stdout = [
      JSON.stringify({ type: "message", role: "assistant", content: "partial" }),
      JSON.stringify({ type: "message", role: "assistant", content: "full answer", delta: false }),
    ].join("\n");
    const parsed = parseGeminiStreamJson(stdout);
    expect(parsed?.response).toBe("full answer");
  });
});
