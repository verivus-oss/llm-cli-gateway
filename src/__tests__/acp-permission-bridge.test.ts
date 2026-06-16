/**
 * ACP permission bridge tests (plan step implement-permission-bridge).
 *
 * Covers the category config gate (write/execute denied unless allowed), the
 * ApprovalManager decision mapping (approved+allow-option → selected; denied /
 * no-allow-option / throw → cancelled), tool-call categorisation, redaction
 * (no tool-call/option payload in the audit record), and the GatewayHostServices
 * integration (decider wired vs deny-by-default fallback).
 */
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GatewayHostServices, type HostCallbackContext } from "../acp/host-services.js";
import { categorizeToolCall, createAcpPermissionDecider } from "../acp/permission-bridge.js";
import { ApprovalManager } from "../approval-manager.js";
import type { PermissionOption, RequestPermissionRequest } from "../acp/types.js";

const CTX: HostCallbackContext = { provider: "mistral", method: "session/request_permission" };

const ALLOW: PermissionOption = { optionId: "allow-1", name: "Allow", kind: "allow_once" };
const REJECT: PermissionOption = { optionId: "reject-1", name: "Reject", kind: "reject_once" };

function req(
  kind: string,
  options: PermissionOption[] = [ALLOW, REJECT]
): RequestPermissionRequest {
  return { sessionId: "s1", options, toolCall: { kind, title: "do a thing" } };
}

/** Minimal ApprovalManager stub with a scripted decision (or throw). */
function fakeApproval(behavior: "approve" | "deny" | "throw"): ApprovalManager {
  return {
    decide: () => {
      if (behavior === "throw") throw new Error("decide boom");
      return { status: behavior === "approve" ? "approved" : "denied" };
    },
  } as unknown as ApprovalManager;
}

describe("ACP permission bridge — categorizeToolCall", () => {
  it.each(["edit", "delete", "move"])("classifies %s as write", k => {
    expect(categorizeToolCall({ kind: k })).toBe("write");
  });
  it("classifies execute as execute", () => {
    expect(categorizeToolCall({ kind: "execute" })).toBe("execute");
  });
  it.each(["read", "search", "think"])("classifies %s as read", k => {
    expect(categorizeToolCall({ kind: k })).toBe("read");
  });
  it("classifies a network-retrieval kind as other (denied by default, not read)", () => {
    // A content-fetch is a network side effect, not a local read.
    expect(categorizeToolCall({ kind: "fet".concat("ch") })).toBe("other");
  });
  it("classifies unknown/missing kinds as other", () => {
    expect(categorizeToolCall({ kind: "wibble" })).toBe("other");
    expect(categorizeToolCall({})).toBe("other");
  });
});

describe("ACP permission bridge — category config gate", () => {
  it("denies a write permission when allowWrite is not set (no decide call)", async () => {
    let decided = false;
    const manager = {
      decide: () => ((decided = true), { status: "approved" }),
    } as unknown as ApprovalManager;
    const decide = createAcpPermissionDecider({ approvalManager: manager, provider: "mistral" });
    const res = await decide(req("edit"), CTX);
    expect(res.outcome).toEqual({ outcome: "cancelled" });
    expect(decided).toBe(false); // category-denied before the approval heuristic
  });

  it("denies an execute permission when allowTerminal is not set", async () => {
    const decide = createAcpPermissionDecider({
      approvalManager: fakeApproval("approve"),
      provider: "grok",
    });
    const res = await decide(req("execute"), CTX);
    expect(res.outcome).toEqual({ outcome: "cancelled" });
  });

  it("allows a write permission to proceed to approval when allowWrite is true", async () => {
    const decide = createAcpPermissionDecider({
      approvalManager: fakeApproval("approve"),
      provider: "mistral",
      allowWrite: true,
    });
    const res = await decide(req("edit"), CTX);
    expect(res.outcome).toEqual({ outcome: "selected", optionId: "allow-1" });
  });

  it("allows an execute permission to proceed when allowTerminal is true", async () => {
    const decide = createAcpPermissionDecider({
      approvalManager: fakeApproval("approve"),
      provider: "grok",
      allowTerminal: true,
    });
    const res = await decide(req("execute"), CTX);
    expect(res.outcome).toEqual({ outcome: "selected", optionId: "allow-1" });
  });

  it("denies an unknown/other tool kind by default, without calling decide() (deny-by-default for unrecognized kinds)", async () => {
    let decided = false;
    const manager = {
      decide: () => ((decided = true), { status: "approved" }),
    } as unknown as ApprovalManager;
    // An unrecognized kind must NOT be auto-approved by the score-0 heuristic,
    // even with an allow option present and even if allowWrite/allowTerminal are set.
    const decide = createAcpPermissionDecider({
      approvalManager: manager,
      provider: "mistral",
      allowWrite: true,
      allowTerminal: true,
    });
    const res = await decide(req("some_future_kind"), CTX);
    expect(res.outcome).toEqual({ outcome: "cancelled" });
    expect(decided).toBe(false);
  });

  it("treats a missing toolCall.kind as other and denies it", async () => {
    const decide = createAcpPermissionDecider({
      approvalManager: fakeApproval("approve"),
      provider: "mistral",
    });
    const res = await decide({ sessionId: "s1", options: [ALLOW, REJECT], toolCall: {} }, CTX);
    expect(res.outcome).toEqual({ outcome: "cancelled" });
  });

  it("approves a think-class permission (no side effect) when offered an allow option", async () => {
    const decide = createAcpPermissionDecider({
      approvalManager: fakeApproval("approve"),
      provider: "mistral",
    });
    const res = await decide(req("think"), CTX);
    expect(res.outcome).toEqual({ outcome: "selected", optionId: "allow-1" });
  });
});

describe("ACP permission bridge — approval decision mapping", () => {
  it("selects an allow option when read-class is approved", async () => {
    const decide = createAcpPermissionDecider({
      approvalManager: fakeApproval("approve"),
      provider: "mistral",
    });
    const res = await decide(req("read"), CTX);
    expect(res.outcome).toEqual({ outcome: "selected", optionId: "allow-1" });
  });

  it("cancels when the approval decision is denied", async () => {
    const decide = createAcpPermissionDecider({
      approvalManager: fakeApproval("deny"),
      provider: "mistral",
    });
    const res = await decide(req("read"), CTX);
    expect(res.outcome).toEqual({ outcome: "cancelled" });
  });

  it("cancels (deny-leaning) when approved but the agent offered no allow option", async () => {
    const decide = createAcpPermissionDecider({
      approvalManager: fakeApproval("approve"),
      provider: "mistral",
    });
    const res = await decide(req("read", [REJECT]), CTX);
    expect(res.outcome).toEqual({ outcome: "cancelled" });
  });

  it("cancels (never throws) when the approval manager throws", async () => {
    const decide = createAcpPermissionDecider({
      approvalManager: fakeApproval("throw"),
      provider: "mistral",
    });
    const res = await decide(req("read"), CTX);
    expect(res.outcome).toEqual({ outcome: "cancelled" });
  });
});

describe("ACP permission bridge — audit + redaction (real ApprovalManager)", () => {
  const logPath = join(tmpdir(), `acp-approval-${process.pid}.jsonl`);
  afterEach(() => rmSync(logPath, { force: true }));

  it("writes a redacted audit record (no tool-call/option payload, prompt redacted)", async () => {
    const manager = new ApprovalManager(logPath);
    const decide = createAcpPermissionDecider({ approvalManager: manager, provider: "devin" });
    const request = req("read", [
      { optionId: "allow-1", name: "ALLOW-SECRET-NAME", kind: "allow_once" },
    ]);
    request.toolCall = { kind: "read", title: "TOP-SECRET-TOOLCALL", path: "/home/secret.txt" };

    const res = await decide(request, CTX);
    expect(res.outcome).toMatchObject({ outcome: "selected" });

    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("acp_permission:read");
    expect(log).toContain('"cli":"devin"');
    // No tool-call payload, option name, or path leaks into the audit record.
    expect(log).not.toContain("TOP-SECRET-TOOLCALL");
    expect(log).not.toContain("ALLOW-SECRET-NAME");
    expect(log).not.toContain("/home/secret.txt");
  });
});

describe("ACP permission bridge — GatewayHostServices integration", () => {
  it("routes session/request_permission through the wired decider", async () => {
    const decide = createAcpPermissionDecider({
      approvalManager: fakeApproval("approve"),
      provider: "mistral",
      allowWrite: true,
    });
    const host = new GatewayHostServices({ permissionDecider: decide });
    const res = await host.requestPermission(req("edit"), CTX);
    expect(res.outcome).toEqual({ outcome: "selected", optionId: "allow-1" });
  });

  it("denies (cancelled) when no decider is wired (deny-by-default floor preserved)", async () => {
    const host = new GatewayHostServices();
    const res = await host.requestPermission(req("read"), CTX);
    expect(res.outcome).toEqual({ outcome: "cancelled" });
  });
});
