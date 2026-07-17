/**
 * U27: Gemini-compatible Antigravity high-impact features.
 *
 * Tests the schema additions on `gemini_request` / `gemini_request_async`:
 *   - sandbox → `--sandbox`
 *   - policyFiles/adminPolicyFiles/attachments are rejected because agy has
 *     no matching non-interactive flags
 *   - createNewSession=true → no session flag (NOT `--resume`)
 *   - createNewSession=false + sessionId → `--conversation <id>`
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { GEMINI_HIGH_IMPACT_PARAMS_SCHEMA, resolveGeminiSessionPlan } from "../request-helpers.js";
import { prepareGeminiRequest, type GatewayServerRuntime } from "../index.js";
import { ApprovalManager } from "../approval-manager.js";
import { noopLogger } from "../logger.js";

let tmp: string;
let realFile1: string;
let originalApprovalAllowBypass: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "u27-gemini-"));
  realFile1 = join(tmp, "policy-1.json");
  originalApprovalAllowBypass = process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
  delete process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
  writeFileSync(realFile1, "{}", { mode: 0o600 });
});

afterEach(() => {
  if (originalApprovalAllowBypass === undefined) {
    delete process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
  } else {
    process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = originalApprovalAllowBypass;
  }
  rmSync(tmp, { recursive: true, force: true });
});

function managedRuntime(): { runtime: GatewayServerRuntime; approvalManager: ApprovalManager } {
  const approvalManager = new ApprovalManager(join(tmp, "approvals.jsonl"), noopLogger);
  return {
    approvalManager,
    runtime: {
      logger: noopLogger,
      approvalManager,
    } as unknown as GatewayServerRuntime,
  };
}

function baseParams(extra: Record<string, unknown> = {}) {
  return {
    prompt: "hello",
    approvalStrategy: "legacy" as const,
    optimizePrompt: false,
    operation: "gemini_request",
    ...extra,
  };
}

describe("U27 GEMINI_HIGH_IMPACT_PARAMS_SCHEMA", () => {
  it("rejects relative attachment paths at Zod validation", () => {
    const parsed = GEMINI_HIGH_IMPACT_PARAMS_SCHEMA.safeParse({
      attachments: ["./rel.png"],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toMatch(/absolute/);
    }
  });

  it("accepts absolute attachment paths at Zod validation", () => {
    const parsed = GEMINI_HIGH_IMPACT_PARAMS_SCHEMA.safeParse({
      attachments: ["/abs/path.png"],
    });
    expect(parsed.success).toBe(true);
  });
});

describe("U27 resolveGeminiSessionPlan", () => {
  it("emits no session flag for fresh sessions (createNewSession=true)", () => {
    const plan = resolveGeminiSessionPlan({ createNewSession: true });
    expect(plan.args).toEqual([]);
    expect(plan.resumed).toBe(false);
  });

  it("emits no session flag when no sessionId and no resumeLatest", () => {
    const plan = resolveGeminiSessionPlan({});
    expect(plan.args).toEqual([]);
    expect(plan.resumed).toBe(false);
  });

  it("emits --conversation <id> when user supplies sessionId and createNewSession=false", () => {
    const plan = resolveGeminiSessionPlan({ sessionId: "user-abc-42" });
    expect(plan.args).toEqual(["--conversation", "user-abc-42"]);
    expect(plan.resumed).toBe(true);
  });

  it("emits --continue when resumeLatest=true and no sessionId", () => {
    const plan = resolveGeminiSessionPlan({ resumeLatest: true });
    expect(plan.args).toEqual(["--continue"]);
    expect(plan.resumed).toBe(false);
  });

  it("createNewSession=true wins over a user-supplied sessionId", () => {
    const plan = resolveGeminiSessionPlan({
      createNewSession: true,
      sessionId: "user-abc-42",
    });
    expect(plan.args).toEqual([]);
    expect(plan.resumed).toBe(false);
  });
});

describe("U27 prepareGeminiRequest end-to-end", () => {
  it("appends --sandbox when sandbox=true", () => {
    const prep = prepareGeminiRequest(baseParams({ sandbox: true }));
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).toContain("--sandbox");
  });

  it("accepts mcpServers for approval tracking without emitting them to agy argv", () => {
    const prep = prepareGeminiRequest(baseParams({ mcpServers: ["sqry"] }));
    if (!("args" in prep)) throw new Error("expected args, not a rejection");

    // Tracked for the approval policy...
    expect(prep.requestedMcpServers).toEqual(["sqry"]);
    // ...but never passed to the Antigravity CLI (it owns its own MCP config).
    expect(prep.args).not.toContain("sqry");
    expect(prep.args.join(" ")).not.toMatch(/mcp/i);
  });

  it("returns error response when policyFiles is set because agy does not support --policy", () => {
    const prep = prepareGeminiRequest(baseParams({ policyFiles: [realFile1] }));
    expect("args" in prep).toBe(false);
    if ("args" in prep) throw new Error("expected error response");
    expect(prep.content[0].text).toContain("policyFiles");
    expect(prep.content[0].text).toContain("Antigravity CLI");
  });

  it("returns error response when adminPolicyFiles is set because agy does not support --admin-policy", () => {
    const prep = prepareGeminiRequest(baseParams({ adminPolicyFiles: [realFile1] }));
    expect("args" in prep).toBe(false);
    if ("args" in prep) throw new Error("expected error response");
    expect(prep.content[0].text).toContain("adminPolicyFiles");
    expect(prep.content[0].text).toContain("Antigravity CLI");
  });

  it("returns error response when attachments are set because agy has no attachment token contract", () => {
    const prep = prepareGeminiRequest(baseParams({ attachments: [realFile1] }));
    expect("args" in prep).toBe(false);
    if ("args" in prep) throw new Error("expected error response");
    expect(prep.content[0].text).toContain("attachments");
    expect(prep.content[0].text).toContain("Antigravity CLI");
  });

  it("emits agy print-mode args before other flags", () => {
    const prep = prepareGeminiRequest(
      baseParams({
        model: "flash",
        sandbox: true,
      })
    );
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args[0]).toBe("--print");
    expect(prep.args[1]).toBe("hello");
    const remainder = prep.args.slice(2);
    expect(remainder).toContain("--model");
    expect(remainder).toContain("--sandbox");
  });

  it("rejects mcp_managed before a Gemini approval decision", () => {
    const { runtime, approvalManager } = managedRuntime();
    const prep = prepareGeminiRequest(
      baseParams({
        approvalStrategy: "mcp_managed",
        includeDirs: ["/workspace/extra"],
      }) as never,
      runtime
    );

    expect("args" in prep).toBe(false);
    expect(JSON.stringify(prep)).toContain(
      "approvalStrategy:mcp_managed is unavailable for gemini"
    );
    expect(approvalManager.list()).toEqual([]);
  });

  it("rejects mcp_managed even when the operator bypass setting is enabled", () => {
    process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = "1";
    const { runtime, approvalManager } = managedRuntime();
    const prep = prepareGeminiRequest(
      baseParams({
        approvalStrategy: "mcp_managed",
        includeDirs: ["/workspace/extra"],
      }) as never,
      runtime
    );

    expect("args" in prep).toBe(false);
    expect(JSON.stringify(prep)).toContain(
      "approvalStrategy:mcp_managed is unavailable for gemini"
    );
    expect(approvalManager.list()).toEqual([]);
  });
});

describe("Phase 4 slice γ — Antigravity rejects Gemini --skip-trust wiring", () => {
  it("returns an error when skipTrust=true", () => {
    const prep = prepareGeminiRequest(baseParams({ skipTrust: true }));
    expect("args" in prep).toBe(false);
    if ("args" in prep) throw new Error("expected error response");
    expect(prep.content[0].text).toContain("skipTrust");
  });

  it("does NOT emit --skip-trust when skipTrust=false", () => {
    const prep = prepareGeminiRequest(baseParams({ skipTrust: false }));
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).not.toContain("--skip-trust");
  });

  it("does NOT emit --skip-trust when skipTrust is omitted (default behaviour preserved)", () => {
    const prep = prepareGeminiRequest(baseParams({}));
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).not.toContain("--skip-trust");
  });
});

describe("Gemini --yolo wiring", () => {
  it("emits --mode accept-edits for legacy auto_edit", () => {
    const prep = prepareGeminiRequest(baseParams({ approvalMode: "auto_edit" }));
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).toContain("--mode");
    expect(prep.args[prep.args.indexOf("--mode") + 1]).toBe("accept-edits");
    expect(prep.args).not.toContain("--dangerously-skip-permissions");
  });

  it("emits --mode plan for legacy plan", () => {
    const prep = prepareGeminiRequest(baseParams({ approvalMode: "plan" }));
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).toContain("--mode");
    expect(prep.args[prep.args.indexOf("--mode") + 1]).toBe("plan");
    expect(prep.args).not.toContain("--dangerously-skip-permissions");
  });

  it("emits --dangerously-skip-permissions when yolo=true (legacy, no approvalMode)", () => {
    const prep = prepareGeminiRequest(baseParams({ yolo: true }));
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).toContain("--dangerously-skip-permissions");
    // No approval-mode emitted, so the agy permission bypass is the sole auto-approve signal.
    expect(prep.args).not.toContain("--approval-mode");
  });

  it("does NOT emit --dangerously-skip-permissions when yolo is omitted", () => {
    const prep = prepareGeminiRequest(baseParams({}));
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).not.toContain("--dangerously-skip-permissions");
  });

  it("emits one agy permission bypass for yolo=true + approvalMode=yolo", () => {
    const prep = prepareGeminiRequest(baseParams({ yolo: true, approvalMode: "yolo" }));
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args.filter(arg => arg === "--dangerously-skip-permissions")).toHaveLength(1);
    expect(prep.args).not.toContain("--approval-mode");
  });

  it("rejects legacy yolo combined with another execution mode", () => {
    const prep = prepareGeminiRequest(baseParams({ yolo: true, approvalMode: "auto_edit" }));
    expect("args" in prep).toBe(false);
    if ("args" in prep) throw new Error("expected error response");
    expect(prep.content[0].text).toContain("cannot be combined");
  });
});
