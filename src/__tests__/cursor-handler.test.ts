import { describe, expect, it } from "vitest";
import { handleCursorRequest, prepareCursorRequest, type GatewayServerRuntime } from "../index.js";
import { runWithRequestContext } from "../request-context.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";

const RUNTIME = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  approvalManager: {
    decide: (request: { bypassRequested?: boolean }) => ({
      status: request.bypassRequested ? "denied" : "approved",
      id: "approval-1",
      reasons: [],
    }),
  },
} as never;

function prep(params: {
  prompt?: string;
  model?: string;
  mode?: "plan" | "ask";
  outputFormat?: "text" | "json" | "stream-json";
  force?: boolean;
  autoReview?: boolean;
  sandbox?: "enabled" | "disabled";
  trust?: boolean;
  workspace?: string;
  addDir?: string[];
  optimizePrompt?: boolean;
  approvalStrategy?: "legacy" | "mcp_managed";
  approvalPolicy?: "strict" | "balanced" | "permissive";
}): { args: string[] } | { content: unknown } {
  return prepareCursorRequest(
    {
      prompt: params.prompt,
      model: params.model,
      mode: params.mode,
      outputFormat: params.outputFormat,
      force: params.force,
      autoReview: params.autoReview,
      sandbox: params.sandbox,
      trust: params.trust,
      workspace: params.workspace,
      addDir: params.addDir,
      approvalStrategy: params.approvalStrategy,
      approvalPolicy: params.approvalPolicy,
      optimizePrompt: params.optimizePrompt ?? false,
      operation: "cursor_request",
    },
    RUNTIME
  ) as { args: string[] } | { content: unknown };
}

function disabledWorkspaces(): WorkspaceRegistry {
  return {
    enabled: false,
    defaultAlias: null,
    allowUnregisteredWorkingDir: false,
    repos: [],
    allowedRoots: [],
    sources: { configFile: null },
  };
}

function fakeRuntime(overrides: Partial<GatewayServerRuntime> = {}): GatewayServerRuntime {
  const sessions = new Map<string, any>();
  return {
    sessionManager: {
      getSession: (id: string) => sessions.get(id) ?? null,
      createSession: (cli: string, description?: string, sessionId?: string) => {
        const session = {
          id: sessionId ?? `s-${sessions.size}`,
          cli,
          description,
          createdAt: "t",
          lastUsedAt: "t",
        };
        sessions.set(session.id, session);
        return session;
      },
      updateSessionUsage: () => true,
      updateSessionMetadata: () => true,
    },
    approvalManager: { decide: () => ({ status: "approved" }) },
    flightRecorder: { logStart() {}, logComplete() {} },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    performanceMetrics: { recordRequest() {} },
    workspaces: disabledWorkspaces(),
  } as unknown as GatewayServerRuntime;
}

function argsOf(result: { args: string[] } | { content: unknown }): string[] {
  if (!("args" in result)) {
    throw new Error("expected a successful prep with argv, got an error response");
  }
  return result.args;
}

describe("prepareCursorRequest", () => {
  it("emits cursor-agent print mode with the prompt as the final positional", () => {
    expect(argsOf(prep({ prompt: "review this" }))).toEqual(["--print", "review this"]);
  });

  it("rejects an empty prompt", () => {
    const result = prep({ prompt: "   " });
    expect("args" in result).toBe(false);
    expect("content" in result).toBe(true);
  });

  it("omits --model when no model is supplied", () => {
    expect(argsOf(prep({ prompt: "x" }))).not.toContain("--model");
  });

  it("forwards supported Cursor execution controls before the prompt", () => {
    const args = argsOf(
      prep({
        prompt: "x",
        model: "gpt-5",
        mode: "plan",
        outputFormat: "json",
        force: true,
        autoReview: true,
        sandbox: "enabled",
        trust: true,
        workspace: "/repo",
        addDir: ["/extra-a", "/extra-b"],
      })
    );
    expect(args).toEqual([
      "--print",
      "--output-format",
      "json",
      "--model",
      "gpt-5",
      "--mode",
      "plan",
      "--force",
      "--auto-review",
      "--sandbox",
      "enabled",
      "--trust",
      "--workspace",
      "/repo",
      "--add-dir",
      "/extra-a",
      "--add-dir",
      "/extra-b",
      "x",
    ]);
  });

  it("does not emit --output-format for the default text mode", () => {
    const args = argsOf(prep({ prompt: "x", outputFormat: "text" }));
    expect(args).toEqual(["--print", "x"]);
  });

  it("rewrites the prompt text when optimizePrompt is true", () => {
    const raw = "please    review      this";
    const args = argsOf(prep({ prompt: raw, optimizePrompt: true }));
    expect(args.at(-1)).not.toBe(raw);
    expect(args.at(-1)!.length).toBeLessThanOrEqual(raw.length);
  });

  it("denies high-impact Cursor flags under mcp_managed approval when bypass is not enabled", () => {
    const result = prep({ prompt: "x", force: true, approvalStrategy: "mcp_managed" });
    expect("args" in result).toBe(false);
    expect(JSON.stringify(result)).toContain("denied by MCP-managed approval policy");
  });
});

describe("handleCursorRequest", () => {
  it("rejects unsupported Cursor CLI-only options on transport=acp instead of dropping them", async () => {
    const runtime = fakeRuntime();
    const res = await handleCursorRequest(
      { sessionManager: runtime.sessionManager, logger: runtime.logger, runtime } as never,
      {
        transport: "acp",
        prompt: "x",
        mode: "ask",
        optimizePrompt: false,
      }
    );
    expect(JSON.stringify(res)).toContain("transport=acp does not support");
    expect(JSON.stringify(res)).toContain("mode");
  });

  it("requires a registered workspace before accepting raw Cursor paths over remote HTTP", async () => {
    const runtime = fakeRuntime();
    const res = await runWithRequestContext(
      { transport: "http", authKind: "oauth", authScopes: ["mcp"], authPrincipal: "remote-user" },
      () =>
        handleCursorRequest(
          { sessionManager: runtime.sessionManager, logger: runtime.logger, runtime } as never,
          {
            prompt: "x",
            workspace: "/tmp/outside",
            optimizePrompt: false,
          }
        )
    );
    const text = JSON.stringify(res);
    expect(text).toContain("Invalid workspace alias");
    expect(text).toContain("/tmp/outside");
  });
});
