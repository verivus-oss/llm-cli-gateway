import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ApprovalManager } from "../approval-manager.js";

describe("ApprovalManager", () => {
  let testDir: string;
  let logPath: string;
  let originalPolicy: string | undefined;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "approval-manager-test-"));
    logPath = join(testDir, "approvals.jsonl");
    originalPolicy = process.env.LLM_GATEWAY_APPROVAL_POLICY;
    delete process.env.LLM_GATEWAY_APPROVAL_POLICY;
  });

  afterEach(() => {
    if (originalPolicy === undefined) {
      delete process.env.LLM_GATEWAY_APPROVAL_POLICY;
    } else {
      process.env.LLM_GATEWAY_APPROVAL_POLICY = originalPolicy;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  it("uses env policy when request policy is omitted and records decision", () => {
    process.env.LLM_GATEWAY_APPROVAL_POLICY = "strict";
    const manager = new ApprovalManager(logPath);
    const decision = manager.decide({
      cli: "claude",
      operation: "claude_request",
      prompt: "delete leaked secret immediately",
      bypassRequested: false,
      fullAuto: false,
      requestedMcpServers: []
    });

    expect(decision.policy).toBe("strict");
    expect(decision.status).toBe("denied");
    expect(decision.reasons.some(reason => reason.includes("sensitive or destructive keywords"))).toBe(true);

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const logged = JSON.parse(lines[0]);
    expect(logged.id).toBe(decision.id);
    expect(logged.status).toBe("denied");
  });

  it("lists records newest-first and supports cli filtering", () => {
    const manager = new ApprovalManager(logPath);
    const first = manager.decide({
      cli: "claude",
      operation: "claude_request",
      prompt: "safe prompt one",
      bypassRequested: false,
      fullAuto: false,
      requestedMcpServers: []
    });
    const second = manager.decide({
      cli: "codex",
      operation: "codex_request",
      prompt: "safe prompt two",
      bypassRequested: false,
      fullAuto: false,
      requestedMcpServers: []
    });
    const third = manager.decide({
      cli: "claude",
      operation: "claude_request_async",
      prompt: "safe prompt three",
      bypassRequested: false,
      fullAuto: false,
      requestedMcpServers: []
    });

    const latestTwo = manager.list(2);
    expect(latestTwo.map(item => item.id)).toEqual([third.id, second.id]);

    const claudeOnly = manager.list(10, "claude");
    expect(claudeOnly.map(item => item.id)).toEqual([third.id, first.id]);
    expect(claudeOnly.every(item => item.cli === "claude")).toBe(true);
  });

  it("approves standard full-auto codex requests under balanced policy", () => {
    const manager = new ApprovalManager(logPath);
    const decision = manager.decide({
      cli: "codex",
      operation: "codex_request",
      prompt: "Summarize this document",
      bypassRequested: false,
      fullAuto: true,
      requestedMcpServers: ["sqry", "exa", "ref_tools"],
      policy: "balanced"
    });

    expect(decision.status).toBe("approved");
    expect(decision.score).toBe(5);
  });

  it("denies bypass plus full-auto even with minimal MCP servers", () => {
    const manager = new ApprovalManager(logPath);
    const decision = manager.decide({
      cli: "codex",
      operation: "codex_request",
      prompt: "Run the task",
      bypassRequested: true,
      fullAuto: true,
      requestedMcpServers: ["sqry"],
      policy: "balanced"
    });

    expect(decision.status).toBe("denied");
    expect(decision.score).toBeGreaterThan(5);
  });
});
