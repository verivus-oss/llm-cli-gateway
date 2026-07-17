/**
 * Devin's CLI adapter cannot isolate ambient MCP configuration. Keep its
 * mcp_managed surface fail-closed until that boundary is implemented.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleDevinRequest,
  handleDevinRequestAsync,
  prepareDevinRequest,
  type GatewayServerRuntime,
} from "../index.js";
import { ApprovalManager } from "../approval-manager.js";
import { noopLogger } from "../logger.js";

let approvalTempDir: string;
let originalApprovalAllowBypass: string | undefined;

beforeEach(() => {
  approvalTempDir = mkdtempSync(join(tmpdir(), "devin-managed-approval-"));
  originalApprovalAllowBypass = process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
  delete process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
});

afterEach(() => {
  if (originalApprovalAllowBypass === undefined) {
    delete process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
  } else {
    process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = originalApprovalAllowBypass;
  }
  rmSync(approvalTempDir, { recursive: true, force: true });
});

function managedRuntime(): { runtime: GatewayServerRuntime; approvalManager: ApprovalManager } {
  const approvalManager = new ApprovalManager(join(approvalTempDir, "approvals.jsonl"), noopLogger);
  return {
    runtime: { logger: noopLogger, approvalManager } as unknown as GatewayServerRuntime,
    approvalManager,
  };
}

function hasArgs(result: unknown): result is { args: string[] } {
  return typeof result === "object" && result !== null && "args" in result;
}

function responseText(result: unknown): string {
  return JSON.stringify(result);
}

describe("Devin managed approval isolation", () => {
  it.each(["devin_request", "devin_request_async"] as const)(
    "rejects mcp_managed before an approval decision for %s preparation",
    operation => {
      const { runtime, approvalManager } = managedRuntime();
      const result = prepareDevinRequest(
        {
          prompt: "Inspect this change",
          approvalStrategy: "mcp_managed",
          optimizePrompt: false,
          operation,
        },
        runtime
      );

      expect(hasArgs(result)).toBe(false);
      expect(responseText(result)).toContain(
        "approvalStrategy:mcp_managed is unavailable for devin"
      );
      expect(approvalManager.list()).toEqual([]);
    }
  );

  it("rejects a managed dangerous request even with bypass opt-in and permissive policy", () => {
    process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = "1";
    const { runtime, approvalManager } = managedRuntime();
    const result = prepareDevinRequest(
      {
        prompt: "Inspect this change",
        permissionMode: "dangerous",
        approvalStrategy: "mcp_managed",
        approvalPolicy: "permissive",
        optimizePrompt: false,
        operation: "devin_request",
      },
      runtime
    );

    expect(hasArgs(result)).toBe(false);
    expect(responseText(result)).toContain("cannot isolate ambient MCP configuration");
    expect(approvalManager.list()).toEqual([]);
  });

  it("leaves legacy dangerous execution unchanged and does not create an approval record", () => {
    const { runtime, approvalManager } = managedRuntime();
    const result = prepareDevinRequest(
      {
        prompt: "Inspect this change",
        permissionMode: "dangerous",
        approvalStrategy: "legacy",
        optimizePrompt: false,
        operation: "devin_request",
      },
      runtime
    );

    if (!hasArgs(result)) throw new Error("expected legacy Devin preparation to return argv");
    const permissionModeIndex = result.args.indexOf("--permission-mode");
    expect(permissionModeIndex).toBeGreaterThan(-1);
    expect(result.args[permissionModeIndex + 1]).toBe("dangerous");
    expect(approvalManager.list()).toEqual([]);
  });

  it("rejects mcp_managed on the synchronous handler before spawning Devin", async () => {
    const { runtime, approvalManager } = managedRuntime();
    const result = await handleDevinRequest(
      { runtime, logger: noopLogger, sessionManager: {} as never } as never,
      {
        prompt: "Inspect this change",
        approvalStrategy: "mcp_managed",
        optimizePrompt: false,
      }
    );

    expect(responseText(result)).toContain("approvalStrategy:mcp_managed is unavailable for devin");
    expect(approvalManager.list()).toEqual([]);
  });

  it("rejects mcp_managed on the asynchronous handler before starting a job", async () => {
    const { runtime, approvalManager } = managedRuntime();
    const result = await handleDevinRequestAsync(
      {
        runtime,
        logger: noopLogger,
        sessionManager: {} as never,
        asyncJobManager: {} as never,
      } as never,
      {
        prompt: "Inspect this change",
        approvalStrategy: "mcp_managed",
        optimizePrompt: false,
      }
    );

    expect(responseText(result)).toContain("approvalStrategy:mcp_managed is unavailable for devin");
    expect(approvalManager.list()).toEqual([]);
  });

  it("rejects managed approval fields on the ACP path instead of silently dropping them", async () => {
    const { runtime, approvalManager } = managedRuntime();
    const result = await handleDevinRequest(
      { runtime, logger: noopLogger, sessionManager: {} as never } as never,
      {
        transport: "acp",
        prompt: "Inspect this change",
        approvalStrategy: "mcp_managed",
        optimizePrompt: false,
      }
    );

    expect(responseText(result)).toContain("does not support approvalStrategy:mcp_managed");
    expect(responseText(result)).toContain("transport=cli");
    expect(approvalManager.list()).toEqual([]);
  });
});
