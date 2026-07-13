import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getProviderDefinition } from "../provider-definitions.js";
import {
  discoverProviderCapabilities,
  type DiscoveredCapabilitySet,
  type ProbeRunner,
  type ProbeResult,
} from "../provider-capability-discovery.js";
import type { ApprovalManager, ApprovalRecord } from "../approval-manager.js";
import {
  adminRiskToExposure,
  classifyOperationRisk,
  isSafeAdminToken,
  projectProviderAdminOperations,
  redactAdminOutput,
  runReadOnlyAdminOperation,
  runMutatingAdminOperation,
  type AdminCommandRunner,
  type AdminOperation,
} from "../provider-admin-tools.js";

// A fake probe runner keyed by "<exe> <argv...>" (never spawns).
function makeRunner(config: Record<string, string>): ProbeRunner {
  return async (exe, argv): Promise<ProbeResult> => {
    const key = `${exe} ${argv.join(" ")}`.trim();
    return { stdout: config[key] ?? "", stderr: "", code: 0 };
  };
}

const CLAUDE_ROOT_HELP = `Usage: claude [options]

Commands:
  mcp     Manage MCP server configuration
  plugin  Manage plugins
  doctor  Run diagnostics
`;

// mcp advertises read (list/get) + mutating (add/remove) sub-operations.
const CLAUDE_MCP_HELP_FULL = `Usage: claude mcp <command>

Commands:
  list    List configured servers
  get     Show one server
  add     Add a server
  remove  Remove a server
`;

// Reduced tree: only the read-only "list" sub-operation is advertised.
const CLAUDE_MCP_HELP_REDUCED = `Usage: claude mcp <command>

Commands:
  list  List configured servers
`;

function claudeConfig(mcpHelp: string): Record<string, string> {
  return {
    "claude --version": "2.1.198 (Claude Code)",
    "claude --help": CLAUDE_ROOT_HELP,
    "claude mcp --help": mcpHelp,
    "claude plugin --help": "Usage: claude plugin\n\nCommands:\n  list  List plugins\n",
    "claude doctor --help": "Usage: claude doctor\n\nRun diagnostics.\n",
  };
}

async function discoverClaude(mcpHelp: string): Promise<DiscoveredCapabilitySet> {
  return discoverProviderCapabilities(getProviderDefinition("claude"), {
    runner: makeRunner(claudeConfig(mcpHelp)),
    gatewayVersion: "test-gw",
    resolveExecutablePath: () => "/abs/bin/claude",
  });
}

describe("provider-admin-tools safety policy", () => {
  it("maps read_only to mcp_readonly and mutating risks to approval/none", () => {
    expect(adminRiskToExposure("read_only")).toBe("mcp_readonly");
    expect(adminRiskToExposure("writes_local_config")).toBe("mcp_requires_approval");
    expect(adminRiskToExposure("auth")).toBe("mcp_requires_approval");
    expect(adminRiskToExposure("destructive")).toBe("mcp_requires_approval");
    expect(adminRiskToExposure("updates_binary")).toBe("not_exposed");
    expect(adminRiskToExposure("starts_server")).toBe("not_exposed");
    expect(adminRiskToExposure("executes_agent")).toBe("not_exposed");
  });

  it("classifies operation verbs, inheriting family risk for unknown verbs", () => {
    // Mutation probe: change READ_VERBS to drop "list" -> this flips red.
    expect(classifyOperationRisk("list", "writes_local_config")).toBe("read_only");
    expect(classifyOperationRisk("remove", "writes_local_config")).toBe("destructive");
    expect(classifyOperationRisk("login", "writes_local_config")).toBe("auth");
    expect(classifyOperationRisk("add", "writes_local_config")).toBe("writes_local_config");
    // Unknown verb inherits the (conservative) family risk, never read_only.
    expect(classifyOperationRisk("frobnicate", "writes_local_config")).toBe("writes_local_config");
    // Server-starting verbs classify as starts_server (-> not_exposed), never
    // inheriting the config-mutating family risk. Mutation probe: drop "serve"
    // from STARTS_SERVER_VERBS -> this flips red (serve becomes writes_local_config).
    expect(classifyOperationRisk("serve", "writes_local_config")).toBe("starts_server");
    expect(adminRiskToExposure(classifyOperationRisk("serve", "writes_local_config"))).toBe(
      "not_exposed"
    );
  });

  it("rejects unsafe argv tokens", () => {
    // Mutation probe: relax the isSafeAdminToken regex -> these flip red.
    expect(isSafeAdminToken("list")).toBe(true);
    expect(isSafeAdminToken("--json")).toBe(true);
    expect(isSafeAdminToken("mcp;rm -rf")).toBe(false);
    expect(isSafeAdminToken("$(whoami)")).toBe(false);
    expect(isSafeAdminToken("a b")).toBe(false);
    expect(isSafeAdminToken("")).toBe(false);
  });
});

describe("provider-admin-tools discovery-driven projection (#6/#7)", () => {
  it("projects mcp read + mutating ops from the discovered subcommand tree", async () => {
    const set = await discoverClaude(CLAUDE_MCP_HELP_FULL);
    const ops = projectProviderAdminOperations(getProviderDefinition("claude"), set);
    const byId = new Map(ops.map(o => [o.operationId, o]));

    // read-only op is available + exposed read-only
    expect(byId.get("mcp.list")).toMatchObject({
      exposure: "mcp_readonly",
      mutating: false,
      available: true,
      discoverySource: "subcommand-help",
    });
    // mutating ops are approval-gated
    expect(byId.get("mcp.add")).toMatchObject({
      exposure: "mcp_requires_approval",
      mutating: true,
    });
    expect(byId.get("mcp.remove")).toMatchObject({
      exposure: "mcp_requires_approval",
      mutating: true,
    });
    // doctor is a read-only leaf, advertised at root
    expect(byId.get("doctor")).toMatchObject({
      exposure: "mcp_readonly",
      available: true,
      argv: ["doctor"],
    });
    // auth is declared in provider-definitions but NOT advertised by this tree.
    expect(byId.get("auth")).toMatchObject({ available: false });
  });

  it("re-projects WITHOUT source edits when the discovered tree changes (#7)", async () => {
    const full = projectProviderAdminOperations(
      getProviderDefinition("claude"),
      await discoverClaude(CLAUDE_MCP_HELP_FULL)
    );
    const reduced = projectProviderAdminOperations(
      getProviderDefinition("claude"),
      await discoverClaude(CLAUDE_MCP_HELP_REDUCED)
    );
    const fullIds = new Set(full.map(o => o.operationId));
    const reducedIds = new Set(reduced.map(o => o.operationId));

    // Mutation probe: if projection read a static table instead of discovery,
    // these assertions flip red (add/remove would persist across trees).
    expect(fullIds.has("mcp.add")).toBe(true);
    expect(fullIds.has("mcp.remove")).toBe(true);
    expect(reducedIds.has("mcp.list")).toBe(true);
    expect(reducedIds.has("mcp.add")).toBe(false);
    expect(reducedIds.has("mcp.remove")).toBe(false);
  });

  it("exposes nothing when discovery is unavailable (fail closed)", () => {
    const ops = projectProviderAdminOperations(getProviderDefinition("claude"), null);
    // Mutation probe: default availability to true when discovered===null -> red.
    expect(ops.every(o => o.available === false)).toBe(true);
    expect(ops.every(o => o.discoverySource === "no-discovery")).toBe(true);
  });

  // BLOCKER 5: auth `status` must project read-only once the auth family is probed.
  it("projects auth `status` read-only when the CLI advertises it", async () => {
    const rootHelp = `Usage: claude [options]

Commands:
  auth    Manage authentication
  mcp     Manage MCP server configuration
  doctor  Run diagnostics
`;
    const authHelp = `Usage: claude auth [options] [command]

Commands:
  status         Show authentication status
  login          Log in to Claude
  logout         Log out of Claude
`;
    const set = await discoverProviderCapabilities(getProviderDefinition("claude"), {
      runner: makeRunner({
        "claude --version": "2.1.198 (Claude Code)",
        "claude --help": rootHelp,
        "claude auth --help": authHelp,
      }),
      gatewayVersion: "test-gw",
      resolveExecutablePath: () => "/abs/bin/claude",
    });
    const byId = new Map(
      projectProviderAdminOperations(getProviderDefinition("claude"), set).map(o => [
        o.operationId,
        o,
      ])
    );
    // Mutation probe: drop the `["auth","--help"]` discovery probe OR revert the
    // parser regex -> auth.status is never projected -> this flips red.
    expect(byId.get("auth.status")).toMatchObject({
      exposure: "mcp_readonly",
      mutating: false,
      available: true,
    });
    // login/logout under the (mutating-gated) auth family stay approval-gated.
    expect(byId.get("auth.login")).toMatchObject({
      exposure: "mcp_requires_approval",
      mutating: true,
    });
  });

  // BLOCKER 6: codex session admin is a set of TOP-LEVEL subcommands.
  it("projects codex top-level session verbs (resume/archive/delete/unarchive)", async () => {
    const rootHelp = `Codex CLI

Usage: codex [OPTIONS] [PROMPT]

Commands:
  exec       Run Codex non-interactively
  login      Manage login
  mcp        Manage external MCP servers for Codex
  doctor     Diagnose local Codex installation
  resume     Resume a previous interactive session
  archive    Archive a saved session by id or session name
  delete     Permanently delete a saved session by id or session name
  unarchive  Unarchive a saved session by id or session name
  fork       Fork a previous interactive session
`;
    const set = await discoverProviderCapabilities(getProviderDefinition("codex"), {
      runner: makeRunner({
        "codex --version": "codex-cli 0.142.4",
        "codex --help": rootHelp,
      }),
      gatewayVersion: "test-gw",
      resolveExecutablePath: () => "/abs/bin/codex",
    });
    const byId = new Map(
      projectProviderAdminOperations(getProviderDefinition("codex"), set).map(o => [
        o.operationId,
        o,
      ])
    );
    // `resume` launches an agent session, so the upstream contract keeps it
    // catalogued but not exposed as an admin operation.
    expect(byId.get("resume")).toMatchObject({
      available: false,
      exposure: "not_exposed",
      risk: "executes_agent",
      mutating: false,
    });
    // Archive/unarchive stay approval-gated, but delete is catalog-only: an
    // explicit contract `not_exposed` ceiling must override the generic admin
    // family declaration rather than reopening a destructive command.
    expect(byId.get("archive")).toMatchObject({ available: true, mutating: true });
    expect(byId.get("delete")).toMatchObject({
      available: false,
      exposure: "not_exposed",
      risk: "destructive",
      mutating: false,
    });
    expect(byId.get("unarchive")).toMatchObject({ available: true, mutating: true });
    // `fork` is executes_agent per the upstream contract, so it stays NOT exposed:
    // a verb heuristic must never downgrade a not-exposed family into a mutating op.
    expect(byId.get("fork")).toMatchObject({ available: false });
  });
});

describe("provider-admin-tools output redaction", () => {
  it("scrubs tokens, emails, and paths from read-only output", () => {
    const raw =
      "servers: sk-ant-ABCDEFGHIJKLMNOPQRST configured for user@example.com at /home/alice/.claude/creds.json";
    const out = redactAdminOutput(raw);
    // Mutation probe: drop redactSecrets/redactAcpMessage composition -> red.
    expect(out).not.toContain("sk-ant-ABCDEFGHIJKLMNOPQRST");
    expect(out).not.toContain("user@example.com");
    expect(out).not.toContain("/home/alice/.claude/creds.json");
  });

  it("scrubs auth-status credentials (bearer token + account id)", () => {
    const raw =
      "Logged in. Authorization: Bearer eyJhbGciOiJExample.Payload.Sig account_1234567890 (ok)";
    const out = redactAdminOutput(raw);
    expect(out).not.toMatch(/eyJhbGciOiJExample/);
    expect(out).not.toContain("account_1234567890");
  });
});

describe("provider-admin-tools read-only execution", () => {
  const readOp: AdminOperation = {
    provider: "claude",
    family: "mcp",
    operationId: "mcp.list",
    argv: ["mcp", "list"],
    risk: "read_only",
    exposure: "mcp_readonly",
    mutating: false,
    available: true,
    discoverySource: "subcommand-help",
    summary: "List configured servers",
  };

  it("executes and returns redacted output", async () => {
    let seen: { exe: string; argv: readonly string[] } | null = null;
    const runner: AdminCommandRunner = async (exe, argv) => {
      seen = { exe, argv };
      return { stdout: "server-a token=sk-ant-SECRETSECRETSECRETSECRET", stderr: "", code: 0 };
    };
    const res = await runReadOnlyAdminOperation(readOp, { runner });
    expect(seen).toEqual({ exe: "claude", argv: ["mcp", "list"] });
    expect(res.ok).toBe(true);
    // Mutation probe: return result.stdout unredacted -> red.
    expect(res.stdout).not.toContain("sk-ant-SECRETSECRETSECRETSECRET");
    expect(res.redacted).toBe(true);
  });

  it("refuses a non-read-only operation on the read path (no spawn)", async () => {
    let called = false;
    const runner: AdminCommandRunner = async () => {
      called = true;
      return { stdout: "", stderr: "", code: 0 };
    };
    const mutatingOp: AdminOperation = {
      ...readOp,
      operationId: "mcp.remove",
      argv: ["mcp", "remove"],
      risk: "destructive",
      exposure: "mcp_requires_approval",
      mutating: true,
    };
    const res = await runReadOnlyAdminOperation(mutatingOp, { runner });
    // Mutation probe: drop the exposure guard -> called becomes true -> red.
    expect(called).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not read-only/);
  });
});

describe("provider-admin-tools mutating execution (gate + approval + audit)", () => {
  let tmpDir: string;
  let auditPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "gw-admin-audit-"));
    auditPath = path.join(tmpDir, "admin-audit.jsonl");
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  const mutateOp: AdminOperation = {
    provider: "claude",
    family: "mcp",
    operationId: "mcp.remove",
    argv: ["mcp", "remove"],
    risk: "destructive",
    exposure: "mcp_requires_approval",
    mutating: true,
    available: true,
    discoverySource: "subcommand-help",
    summary: "Remove a server",
  };

  function approvalStub(status: "approved" | "denied"): ApprovalManager {
    return {
      decide: (): ApprovalRecord =>
        ({ id: "appr-1", status, reasons: ["stub"] }) as unknown as ApprovalRecord,
    } as unknown as ApprovalManager;
  }

  function readAudit(): Record<string, unknown>[] {
    if (!existsSync(auditPath)) return [];
    return readFileSync(auditPath, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map(l => JSON.parse(l) as Record<string, unknown>);
  }

  it("fails closed when the gate is off and never spawns", async () => {
    let called = false;
    const runner: AdminCommandRunner = async () => {
      called = true;
      return { stdout: "", stderr: "", code: 0 };
    };
    const res = await runMutatingAdminOperation(mutateOp, {
      allowMutating: false,
      approvalManager: approvalStub("approved"),
      runner,
      auditPath,
    });
    // Mutation probe: remove the `if (!ctx.allowMutating)` gate -> called true -> red.
    expect(called).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/disabled/);
    expect(readAudit()).toEqual([expect.objectContaining({ outcome: "gate_closed" })]);
  });

  it("routes through approval and audits an execution when the gate is on", async () => {
    let called = false;
    const runner: AdminCommandRunner = async () => {
      called = true;
      return { stdout: "removed token=sk-ant-SECRETSECRETSECRETSECRET", stderr: "", code: 0 };
    };
    const res = await runMutatingAdminOperation(mutateOp, {
      allowMutating: true,
      approvalManager: approvalStub("approved"),
      runner,
      auditPath,
    });
    expect(called).toBe(true);
    expect(res.ok).toBe(true);
    // output still redacted on the mutating path
    expect(res.stdout).not.toContain("sk-ant-SECRETSECRETSECRETSECRET");
    // BLOCKER 2: the durable approved-intent record is written BEFORE the spawn,
    // then a best-effort executed outcome after it.
    expect(readAudit()).toEqual([
      expect.objectContaining({ outcome: "approved", approvalId: "appr-1" }),
      expect.objectContaining({ outcome: "executed", approvalId: "appr-1" }),
    ]);
  });

  it("denies (no spawn) and audits when approval is refused", async () => {
    let called = false;
    const runner: AdminCommandRunner = async () => {
      called = true;
      return { stdout: "", stderr: "", code: 0 };
    };
    const res = await runMutatingAdminOperation(mutateOp, {
      allowMutating: true,
      approvalManager: approvalStub("denied"),
      runner,
      auditPath,
    });
    // Mutation probe: skip the decision.status check -> called true -> red.
    expect(called).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/denied/);
    expect(readAudit()).toEqual([expect.objectContaining({ outcome: "denied" })]);
  });

  // BLOCKER 1: remote HTTP/OAuth callers need the dedicated CLI-admin gate.
  it("rejects a remote caller without the CLI-admin gate (no spawn) and records the principal", async () => {
    let called = false;
    const runner: AdminCommandRunner = async () => {
      called = true;
      return { stdout: "", stderr: "", code: 0 };
    };
    const res = await runMutatingAdminOperation(mutateOp, {
      allowMutating: true,
      remoteCaller: true,
      remoteAdminAllowed: false,
      principal: "oauth-client-xyz",
      approvalManager: approvalStub("approved"),
      runner,
      auditPath,
    });
    // Mutation probe: remove the `ctx.remoteCaller && !ctx.remoteAdminAllowed`
    // gate -> called becomes true -> this flips red.
    expect(called).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/remote callers|cli:admin/i);
    expect(readAudit()).toEqual([
      expect.objectContaining({ outcome: "gate_closed", principal: "oauth-client-xyz" }),
    ]);
  });

  it("allows a remote caller WITH the CLI-admin gate (env + scope) and records the principal", async () => {
    let called = false;
    const runner: AdminCommandRunner = async () => {
      called = true;
      return { stdout: "removed", stderr: "", code: 0 };
    };
    const res = await runMutatingAdminOperation(mutateOp, {
      allowMutating: true,
      remoteCaller: true,
      remoteAdminAllowed: true,
      principal: "oauth-client-xyz",
      approvalManager: approvalStub("approved"),
      runner,
      auditPath,
    });
    expect(called).toBe(true);
    expect(res.ok).toBe(true);
    // Principal is threaded into every admin audit record.
    expect(readAudit()).toEqual([
      expect.objectContaining({ outcome: "approved", principal: "oauth-client-xyz" }),
      expect.objectContaining({ outcome: "executed", principal: "oauth-client-xyz" }),
    ]);
  });

  it("allows a LOCAL stdio caller with only the config gate (no remote gate needed)", async () => {
    let called = false;
    const runner: AdminCommandRunner = async () => {
      called = true;
      return { stdout: "removed", stderr: "", code: 0 };
    };
    const res = await runMutatingAdminOperation(mutateOp, {
      allowMutating: true,
      remoteCaller: false,
      remoteAdminAllowed: false,
      principal: "local",
      approvalManager: approvalStub("approved"),
      runner,
      auditPath,
    });
    expect(called).toBe(true);
    expect(res.ok).toBe(true);
    expect(readAudit()).toEqual([
      expect.objectContaining({ outcome: "approved", principal: "local" }),
      expect.objectContaining({ outcome: "executed", principal: "local" }),
    ]);
  });

  // BLOCKER 2: the approved-intent record must persist BEFORE the spawn.
  it("aborts without spawning when the pre-spawn audit write fails", async () => {
    let called = false;
    const runner: AdminCommandRunner = async () => {
      called = true;
      return { stdout: "", stderr: "", code: 0 };
    };
    const res = await runMutatingAdminOperation(mutateOp, {
      allowMutating: true,
      approvalManager: approvalStub("approved"),
      runner,
      // Mutation probe: make appendAdminAuditBestEffort swallow this and spawn
      // anyway (i.e. write the approved record best-effort) -> called true -> red.
      auditSink: () => {
        throw new Error("audit disk full");
      },
    });
    expect(called).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/aborted/i);
  });

  // BLOCKER 4: an un-advertised mutating op (available: false) never spawns.
  it("rejects an un-advertised mutating op (available:false) with no spawn", async () => {
    let called = false;
    const runner: AdminCommandRunner = async () => {
      called = true;
      return { stdout: "", stderr: "", code: 0 };
    };
    const unavailableOp: AdminOperation = { ...mutateOp, available: false };
    const res = await runMutatingAdminOperation(unavailableOp, {
      allowMutating: true,
      approvalManager: approvalStub("approved"),
      runner,
      auditPath,
    });
    // Mutation probe: remove the `if (!op.available)` guard -> called true -> red.
    expect(called).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not advertised/i);
  });
});
