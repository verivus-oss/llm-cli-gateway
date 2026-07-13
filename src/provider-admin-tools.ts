/**
 * Provider admin surfaces (phase-6).
 *
 * This module exposes provider CLI *admin* operations (auth status, model
 * listing, doctor/status, `mcp list/get`, `plugin list`, session listing, and
 * their mutating siblings) as gateway tools. It is built on three hard rules:
 *
 *  1. DISCOVERY-DRIVEN AVAILABILITY. Which (provider, family, operation) tuples
 *     are exposed is DERIVED at runtime from the phase-1b discovered subcommand
 *     help ({@link DiscoveredCapabilitySet}) intersected with the provider
 *     admin-family declarations in `provider-definitions.ts` and a SAFETY POLICY
 *     mapping (risk -> exposure). There is NO hand-coded per-provider
 *     admin-availability table here. The checked-in `UPSTREAM_CLI_CONTRACTS`
 *     stay guardrails/regression fixtures; the availability projection reads
 *     discovery. Inject a different discovered tree and the projection changes
 *     with zero source edits (see the phase-6 acceptance test).
 *
 *  2. NO SHELL INTERPOLATION. Every admin operation is spawned with a fixed argv
 *     array whose tokens come from the provider registry (family) and the parsed
 *     discovered subcommand names (operation), never caller free text. Each token
 *     is additionally validated against {@link isSafeAdminToken} before spawn.
 *
 *  3. MUTATING OPS ARE DENY-BY-DEFAULT. A mutating admin op (mcp add/remove,
 *     login/logout, plugin install/remove, session delete/archive, ...) is only
 *     runnable when the operator sets `[admin] allow_mutating_cli_admin_ops =
 *     true`. When the gate is off the call FAILS CLOSED without spawning. When on
 *     it is routed through the {@link ApprovalManager} and an audit record is
 *     written. Read-only ops are always safe to execute; their output is
 *     redacted so credentials/tokens/paths/emails never leak.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { executeCli, type ExecuteResult } from "./executor.js";
import { noopLogger, type Logger } from "./logger.js";
import { redactSecrets } from "./secret-redaction.js";
import { redactAcpMessage } from "./acp/errors.js";
import {
  adminSurfaceKind,
  getAllProviderDefinitions,
  getProviderDefinition,
  type CliType,
  type ProviderAdminFamily,
  type ProviderDefinition,
} from "./provider-definitions.js";
import {
  peekProviderCapabilitySet,
  resolveProviderCapabilitySet,
} from "./provider-capability-resolver.js";
import type { DiscoveredCapabilitySet } from "./provider-capability-discovery.js";
import {
  getCliSubcommandContract,
  type CliSubcommandExposure,
  type CliSubcommandRisk,
} from "./upstream-contracts.js";
import type { ApprovalManager, ApprovalCli } from "./approval-manager.js";
import {
  getRequestContext,
  resolveOwnerPrincipal,
  type GatewayRequestContext,
} from "./request-context.js";

// ---------------------------------------------------------------------------
// Safety policy: risk -> MCP exposure. This is the single, provider-agnostic
// mapping. `mcp_readonly` ops become read-only tools; `mcp_requires_approval`
// ops become gated mutating tools; everything else is never exposed.
// ---------------------------------------------------------------------------

/** Map a subcommand risk class to its MCP exposure class (the safety policy). */
export function adminRiskToExposure(risk: CliSubcommandRisk): CliSubcommandExposure {
  switch (risk) {
    case "read_only":
      return "mcp_readonly";
    case "writes_local_config":
    case "auth":
    case "network":
    case "destructive":
      return "mcp_requires_approval";
    case "starts_server":
    case "updates_binary":
    case "executes_agent":
      return "not_exposed";
    default: {
      // Exhaustiveness guard: an added risk class must be classified here.
      const never: never = risk;
      return never;
    }
  }
}

// Verb -> risk heuristic used to classify a DISCOVERED subcommand name within a
// family. Read verbs are the only ones that can lower a family's risk to
// read-only; unknown verbs conservatively inherit the family's risk.
const READ_VERBS = new Set([
  "list",
  "ls",
  "get",
  "show",
  "status",
  "view",
  "info",
  "doctor",
  "about",
  "version",
  "help",
  "models",
  "model",
  "print",
  "describe",
  "cat",
  "export",
  "paths",
  "path",
  "whoami",
  "current",
  "inspect",
  "trace",
  "changelog",
  "completion",
  "debug",
]);
const AUTH_VERBS = new Set(["login", "logout"]);
const DESTRUCTIVE_VERBS = new Set([
  "delete",
  "remove",
  "rm",
  "purge",
  "destroy",
  "wipe",
  "reset",
  "clear",
  "uninstall",
]);
// Server-starting operations must never be exposed as admin tools: they spawn a
// long-running daemon/listener rather than return, so the safety policy maps
// starts_server -> not_exposed. Discovered subcommands like `mcp serve` inherit
// this class regardless of the (config-mutating) family they sit under.
const STARTS_SERVER_VERBS = new Set([
  "serve",
  "server",
  "listen",
  "daemon",
  "mcp-server",
  "app-server",
]);
const CONFIG_MUTATE_VERBS = new Set([
  "add",
  "set",
  "enable",
  "disable",
  "install",
  "import",
  "archive",
  "fork",
  "marketplace",
  "register",
  "unregister",
  "edit",
  "create",
  "init",
  "save",
  "apply",
  "sync",
  "start",
  "run",
  "exec",
]);

/**
 * Classify the risk of a discovered operation NAME within a family, given the
 * family's base risk. Read verbs downgrade to read_only; auth/destructive/config
 * verbs map to their class.
 *
 * Unknown verbs: for a discovered SUBcommand (`isSubcommand`), an unknown verb
 * must NOT inherit a `read_only` family risk. A provider CLI upgrade can add a
 * mutating subcommand (e.g. `rotate`, `revoke`, `publish`, `rename`) under a
 * family we classified read-only, and inheriting `read_only` would run it on the
 * unapproved read path. Such a subcommand is escalated to `writes_local_config`
 * so it requires approval. A LEAF family (not a subcommand) keeps its declared
 * risk: the family name is deliberately classified and its read-only leaves
 * (e.g. `doctor`, `models`) must stay on the read path.
 */
export function classifyOperationRisk(
  operationName: string,
  familyRisk: CliSubcommandRisk,
  opts: { isSubcommand?: boolean } = {}
): CliSubcommandRisk {
  const n = operationName.trim().toLowerCase();
  if (READ_VERBS.has(n)) return "read_only";
  if (AUTH_VERBS.has(n)) return "auth";
  if (DESTRUCTIVE_VERBS.has(n)) return "destructive";
  if (STARTS_SERVER_VERBS.has(n)) return "starts_server";
  if (CONFIG_MUTATE_VERBS.has(n)) return "writes_local_config";
  if (opts.isSubcommand && familyRisk === "read_only") {
    return "writes_local_config";
  }
  return familyRisk;
}

/** The base risk of an admin FAMILY: contract risk when declared, else its coarse safety. */
export function familyBaseRisk(provider: CliType, fam: ProviderAdminFamily): CliSubcommandRisk {
  const contract = getCliSubcommandContract(provider, [fam.family]);
  if (contract) return contract.risk;
  return fam.safety === "read-only" ? "read_only" : "writes_local_config";
}

/**
 * The upstream contract can explicitly close its generic admin projection for
 * one exact command. This stays separate from ordinary subcommand `exposure`,
 * because discovery intentionally projects established child operations, such
 * as `auth status` and `mcp list`, independently from their parent catalog.
 */
function contractAdminProjectionCeiling(
  provider: CliType,
  commandPath: readonly string[]
): CliSubcommandExposure | null {
  const exactContract = getCliSubcommandContract(provider, commandPath);
  return exactContract?.adminProjection === "not_exposed" ? "not_exposed" : null;
}

/** Resolve projection exposure without allowing registry metadata to widen a contract ceiling. */
function projectedAdminExposure(
  provider: CliType,
  commandPath: readonly string[],
  risk: CliSubcommandRisk
): CliSubcommandExposure {
  return contractAdminProjectionCeiling(provider, commandPath) ?? adminRiskToExposure(risk);
}

// ---------------------------------------------------------------------------
// Projection: (provider def + discovered help) -> admin operations.
// ---------------------------------------------------------------------------

/** How the availability of an admin operation was decided from discovery. */
export type AdminDiscoverySource =
  "subcommand-help" | "root-help" | "not-advertised" | "no-discovery";

/** A single projected admin operation for one provider. */
export interface AdminOperation {
  readonly provider: CliType;
  readonly family: string;
  /** Stable id, e.g. `mcp.list` or the bare family for a leaf command. */
  readonly operationId: string;
  /** Fixed argv (no shell); tokens come from the registry + discovered help. */
  readonly argv: readonly string[];
  readonly risk: CliSubcommandRisk;
  readonly exposure: CliSubcommandExposure;
  /** True iff exposure is `mcp_requires_approval` (a gated mutating op). */
  readonly mutating: boolean;
  /** True iff the installed CLI advertises this op and the policy exposes it. */
  readonly available: boolean;
  readonly discoverySource: AdminDiscoverySource;
  readonly summary: string;
}

/** Case-insensitive membership of a subcommand name in discovered root help. */
function rootAdvertises(discovered: DiscoveredCapabilitySet, family: string): boolean {
  const wanted = family.toLowerCase();
  return discovered.rootHelp.subcommands.some(s => s.name.toLowerCase() === wanted);
}

/** Find the parsed sub-help for a family, matching keys like `mcp --help`. */
function familySubHelp(
  discovered: DiscoveredCapabilitySet,
  family: string
): DiscoveredCapabilitySet["subcommandHelp"][string] | null {
  const wanted = family.toLowerCase();
  for (const [key, help] of Object.entries(discovered.subcommandHelp)) {
    const tokens = key.split(/\s+/).filter(Boolean);
    // Drop an optional leading executable token (exe-prefixed keys), then match
    // the first argv token against the family name.
    const first = tokens.find(t => !t.startsWith("-"));
    if (first && first.toLowerCase() === wanted) return help;
  }
  return null;
}

/**
 * Project the admin operations for one provider from the discovered capability
 * set. Pure and deterministic. When `discovered` is null NOTHING is available
 * (fail closed): availability can only be asserted from discovery, never assumed.
 */
export function projectProviderAdminOperations(
  def: ProviderDefinition,
  discovered: DiscoveredCapabilitySet | null
): AdminOperation[] {
  const ops: AdminOperation[] = [];
  for (const fam of def.adminSubcommands) {
    // Only real invokable subcommands are executable admin surfaces. cli-flag
    // and config-projection families have no subcommand to spawn.
    if (adminSurfaceKind(fam) !== "cli-subcommand") continue;

    const baseRisk = familyBaseRisk(def.id, fam);
    const familyExposure = projectedAdminExposure(def.id, [fam.family], baseRisk);

    if (!discovered) {
      ops.push({
        provider: def.id,
        family: fam.family,
        operationId: fam.family,
        argv: [fam.family],
        risk: baseRisk,
        exposure: familyExposure,
        mutating: familyExposure === "mcp_requires_approval",
        available: false,
        discoverySource: "no-discovery",
        summary: fam.evidence,
      });
      continue;
    }

    const advertised = rootAdvertises(discovered, fam.family);
    const subHelp = familySubHelp(discovered, fam.family);
    const subOps = subHelp?.subcommands ?? [];

    if (subOps.length > 0) {
      for (const sub of subOps) {
        if (!isSafeAdminToken(sub.name)) continue; // never build argv from junk
        const risk = classifyOperationRisk(sub.name, baseRisk, { isSubcommand: true });
        const exposure = projectedAdminExposure(def.id, [fam.family, sub.name], risk);
        ops.push({
          provider: def.id,
          family: fam.family,
          operationId: `${fam.family}.${sub.name}`,
          argv: [fam.family, sub.name],
          risk,
          exposure,
          mutating: exposure === "mcp_requires_approval",
          available: exposure !== "not_exposed" && exposure !== "tracked_only",
          discoverySource: "subcommand-help",
          summary: sub.description || fam.evidence,
        });
      }
      continue;
    }

    // Leaf family (no discovered sub-operations, e.g. `doctor`, `models`, or a
    // top-level session verb like codex `delete`). The family NAME *is* the verb,
    // so refine the risk from it (e.g. `delete` -> destructive) EXCEPT when the
    // family's base risk already resolves to `not_exposed` (starts_server /
    // updates_binary / executes_agent). In that case we keep the more-severe base
    // risk: a verb heuristic must never downgrade a not-exposed family (e.g.
    // codex `fork` = executes_agent) into an exposed mutating op. Availability is
    // then computed from exposure exactly like the sub-operation path, so an
    // advertised mutating leaf IS available to the mutate tool (the read tool
    // still rejects it by exposure).
    const baseExposure = adminRiskToExposure(baseRisk);
    const risk =
      baseExposure === "not_exposed" ? baseRisk : classifyOperationRisk(fam.family, baseRisk);
    const exposure = projectedAdminExposure(def.id, [fam.family], risk);
    ops.push({
      provider: def.id,
      family: fam.family,
      operationId: fam.family,
      argv: [fam.family],
      risk,
      exposure,
      mutating: exposure === "mcp_requires_approval",
      available: advertised && exposure !== "not_exposed" && exposure !== "tracked_only",
      discoverySource: advertised ? "root-help" : "not-advertised",
      summary: fam.evidence,
    });
  }
  return ops;
}

/** Compact catalog row shape for the read-only listing tool. */
export interface AdminCatalogRow {
  readonly provider: CliType;
  readonly operationId: string;
  readonly family: string;
  readonly argv: readonly string[];
  readonly risk: CliSubcommandRisk;
  readonly exposure: CliSubcommandExposure;
  readonly mutating: boolean;
  readonly available: boolean;
  readonly discoverySource: AdminDiscoverySource;
  readonly summary: string;
}

/**
 * Build the admin-operation catalog for one or all providers, projected from a
 * discovered-set lookup. The lookup defaults to the memo-only peek (never
 * spawns). Tests pass a lookup returning fake capability sets to prove the
 * projection is discovery-driven.
 */
export function buildProviderAdminCatalog(
  options: {
    provider?: CliType;
    lookup?: (id: CliType) => DiscoveredCapabilitySet | null;
    includeUnavailable?: boolean;
  } = {}
): AdminCatalogRow[] {
  const lookup = options.lookup ?? ((id: CliType) => peekProviderCapabilitySet(id)?.set ?? null);
  const defs = options.provider
    ? [getProviderDefinition(options.provider)]
    : getAllProviderDefinitions();
  const rows: AdminCatalogRow[] = [];
  for (const def of defs) {
    const discovered = lookup(def.id);
    for (const op of projectProviderAdminOperations(def, discovered)) {
      if (!options.includeUnavailable && !op.available) continue;
      rows.push({
        provider: op.provider,
        operationId: op.operationId,
        family: op.family,
        argv: op.argv,
        risk: op.risk,
        exposure: op.exposure,
        mutating: op.mutating,
        available: op.available,
        discoverySource: op.discoverySource,
        summary: op.summary.length > 80 ? `${op.summary.slice(0, 77).trimEnd()}...` : op.summary,
      });
    }
  }
  return rows.sort((a, b) =>
    `${a.provider}:${a.operationId}`.localeCompare(`${b.provider}:${b.operationId}`)
  );
}

// ---------------------------------------------------------------------------
// Redaction of admin command output.
// ---------------------------------------------------------------------------

const REDACTED = "[REDACTED]";
// OAuth authorization/verification codes and account identifiers not covered by
// the shared redactor. Applied in addition to redactSecrets + the ACP path/email
// redactor so auth-status output can never leak a credential.
const OAUTH_CODE_RE =
  /\b(code|verifier|challenge|state|nonce|otp)\s*[:=]\s*[A-Za-z0-9._~+/=-]{6,}/gi;
const ACCOUNT_ID_RE = /\b(?:user|customer|account|acct|org|tenant)[_-][A-Za-z0-9]{6,}\b/gi;

/**
 * Redact every recognisable secret, OAuth code, account id, local path, and
 * email from admin command stdout/stderr before it is returned to a client.
 * Composes the shared {@link redactSecrets} (key shapes / bearer / url creds),
 * {@link redactAcpMessage} (paths / emails / tokens), plus admin-specific OAuth
 * code + account-id rules. Idempotent.
 */
export function redactAdminOutput(text: string): string {
  if (!text) return text;
  let out = redactSecrets(text);
  out = out.replace(OAUTH_CODE_RE, (_m, key: string) => `${key}=${REDACTED}`);
  out = out.replace(ACCOUNT_ID_RE, REDACTED);
  // redactAcpMessage handles filesystem paths + emails + bearer/token shapes.
  out = redactAcpMessage(out);
  return out;
}

// ---------------------------------------------------------------------------
// Execution.
// ---------------------------------------------------------------------------

/** A fixed-argv, no-shell command runner (injectable for tests). */
export type AdminCommandRunner = (
  executable: string,
  argv: readonly string[],
  options: { timeoutMs?: number }
) => Promise<ExecuteResult>;

const defaultAdminRunner: AdminCommandRunner = (executable, argv, options) =>
  executeCli(executable, [...argv], { timeout: options.timeoutMs });

/** Reject any token that is not a plain subcommand/flag word (defense in depth). */
export function isSafeAdminToken(token: string): boolean {
  if (token.length === 0 || token.length > 64) return false;
  // Allow bare subcommand words and simple long flags; NEVER shell metacharacters.
  return /^-{0,2}[A-Za-z0-9][A-Za-z0-9._-]*$/.test(token);
}

/** Result of running an admin operation. Output fields are always redacted. */
export interface AdminRunResult {
  readonly ok: boolean;
  readonly provider: CliType;
  readonly operationId: string;
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly redacted: true;
  readonly error?: string;
}

function assertSafeArgv(argv: readonly string[]): void {
  for (const token of argv) {
    if (!isSafeAdminToken(token)) {
      throw new Error(`Unsafe admin argv token rejected: ${JSON.stringify(token)}`);
    }
  }
}

/**
 * Execute a READ-ONLY admin operation and return redacted output. Refuses any
 * operation whose exposure is not `mcp_readonly`, so a mutating op can never be
 * spawned through the read path.
 */
export async function runReadOnlyAdminOperation(
  op: AdminOperation,
  deps: { runner?: AdminCommandRunner; timeoutMs?: number; logger?: Logger } = {}
): Promise<AdminRunResult> {
  const logger = deps.logger ?? noopLogger;
  if (op.exposure !== "mcp_readonly") {
    return {
      ok: false,
      provider: op.provider,
      operationId: op.operationId,
      argv: op.argv,
      exitCode: null,
      stdout: "",
      stderr: "",
      redacted: true,
      error: `Operation ${op.operationId} is not read-only (exposure=${op.exposure}); use the mutating admin tool.`,
    };
  }
  if (!op.available) {
    return {
      ok: false,
      provider: op.provider,
      operationId: op.operationId,
      argv: op.argv,
      exitCode: null,
      stdout: "",
      stderr: "",
      redacted: true,
      error: `Operation ${op.operationId} is not advertised by the installed ${op.provider} CLI.`,
    };
  }
  assertSafeArgv(op.argv);
  const def = getProviderDefinition(op.provider);
  const runner = deps.runner ?? defaultAdminRunner;
  try {
    const result = await runner(def.primaryExecutable, op.argv, { timeoutMs: deps.timeoutMs });
    return {
      ok: result.code === 0,
      provider: op.provider,
      operationId: op.operationId,
      argv: op.argv,
      exitCode: result.code,
      stdout: redactAdminOutput(result.stdout),
      stderr: redactAdminOutput(result.stderr),
      redacted: true,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.debug(`admin read-only op failed: ${op.operationId}`, { reason });
    return {
      ok: false,
      provider: op.provider,
      operationId: op.operationId,
      argv: op.argv,
      exitCode: null,
      stdout: "",
      stderr: "",
      redacted: true,
      error: redactAdminOutput(reason),
    };
  }
}

/** An admin audit record (persisted for every mutating attempt, allowed or not). */
export interface AdminAuditRecord {
  readonly ts: string;
  readonly provider: CliType;
  readonly operationId: string;
  readonly argv: readonly string[];
  /**
   * `gate_closed` (a gate refused; no spawn), `denied` (approval refused; no
   * spawn), `approved` (the DURABLE pre-spawn intent record; persisted before the
   * mutating spawn), or `executed` (best-effort post-spawn outcome with exit
   * code).
   */
  readonly outcome: "gate_closed" | "denied" | "approved" | "executed";
  readonly approvalId?: string;
  readonly exitCode?: number | null;
  readonly principal?: string;
}

/** Default admin-audit log path (0600, alongside the approvals log). */
export function defaultAdminAuditPath(): string {
  return join(homedir(), ".llm-cli-gateway", "admin-audit.jsonl");
}

/**
 * An audit sink: persist one record durably or THROW. The default sink appends a
 * JSON line to the on-disk audit trail; the parent `~/.llm-cli-gateway` dir is
 * created 0700 (it holds the audit trail) and the file is 0600. Injectable so the
 * strict pre-spawn audit (BLOCKER 2) is testable.
 */
export type AdminAuditSink = (record: AdminAuditRecord) => void;

/** The default file-backed audit sink. Throws if the record cannot be written. */
export function defaultAdminAuditSink(auditPath?: string): AdminAuditSink {
  return record => {
    const path = auditPath ?? defaultAdminAuditPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf-8", mode: 0o600 });
  };
}

/** Append one audit record best-effort through `sink` (never throws). */
function appendAdminAuditBestEffort(record: AdminAuditRecord, sink: AdminAuditSink): void {
  try {
    sink(record);
  } catch {
    // A completion/outcome audit is best-effort; a log-write failure here must
    // not throw. The DURABLE pre-spawn intent record is written strictly below.
  }
}

/** Append one audit record (best-effort; never throws into the caller). */
export function appendAdminAudit(record: AdminAuditRecord, auditPath?: string): void {
  appendAdminAuditBestEffort(record, defaultAdminAuditSink(auditPath));
}

/** Dependencies for a mutating admin op: the gate, approval, audit, runner. */
export interface AdminMutateContext {
  /** The resolved `[admin] allow_mutating_cli_admin_ops` gate (local sufficiency). */
  readonly allowMutating: boolean;
  /**
   * BLOCKER 1: whether the caller reached the gateway over the remote HTTP/OAuth
   * surface (vs a local stdio caller). Remote callers may mutate a host-global
   * provider CLI surface ONLY when `remoteAdminAllowed` is also true.
   */
  readonly remoteCaller?: boolean;
  /**
   * BLOCKER 1: whether the dedicated remote CLI-admin gate is satisfied
   * (`LLM_GATEWAY_CLI_ADMIN=1` + the `cli:admin` OAuth scope). Ignored for local
   * stdio callers, whose config gate (`allowMutating`) is sufficient.
   */
  readonly remoteAdminAllowed?: boolean;
  readonly approvalManager: ApprovalManager;
  readonly runner?: AdminCommandRunner;
  readonly timeoutMs?: number;
  readonly logger?: Logger;
  readonly principal?: string;
  readonly auditPath?: string;
  /** Injectable audit sink (defaults to the file-backed sink at `auditPath`). */
  readonly auditSink?: AdminAuditSink;
}

/**
 * Execute a MUTATING admin operation. Deny-by-default, in this order:
 *  - reject a non-advertised op (`op.available === false`): FAIL CLOSED, no spawn.
 *  - reject a non-mutating exposure (belongs on the read path).
 *  - BLOCKER 1: a REMOTE HTTP/OAuth caller must also satisfy the dedicated
 *    CLI-admin gate (env + `cli:admin` scope). Local stdio callers do not.
 *  - if the config gate is off, FAIL CLOSED (no spawn) and audit `gate_closed`.
 *  - route through {@link ApprovalManager}. A denial audits `denied`, no spawn.
 *  - BLOCKER 2: persist a DURABLE `approved` intent record BEFORE spawning; if it
 *    cannot be written, FAIL CLOSED (no spawn). Then spawn; the post-spawn
 *    `executed` outcome audit is best-effort. Output is always redacted.
 *
 * Every audit record carries the caller principal.
 */
export async function runMutatingAdminOperation(
  op: AdminOperation,
  ctx: AdminMutateContext
): Promise<AdminRunResult> {
  const logger = ctx.logger ?? noopLogger;
  const sink = ctx.auditSink ?? defaultAdminAuditSink(ctx.auditPath);
  const base = {
    provider: op.provider,
    operationId: op.operationId,
    argv: op.argv,
    redacted: true as const,
  };
  const fail = (error: string): AdminRunResult => ({
    ok: false,
    ...base,
    exitCode: null,
    stdout: "",
    stderr: "",
    error,
  });
  const auditBestEffort = (
    outcome: AdminAuditRecord["outcome"],
    extra: { approvalId?: string; exitCode?: number | null } = {}
  ): void =>
    appendAdminAuditBestEffort(
      {
        ts: new Date().toISOString(),
        provider: op.provider,
        operationId: op.operationId,
        argv: op.argv,
        outcome,
        principal: ctx.principal,
        ...extra,
      },
      sink
    );

  // BLOCKER 4: an un-advertised leaf/op (available === false) must never reach
  // approval or spawn, even on the mutating path. Fail closed.
  if (!op.available) {
    return fail(
      `Operation ${op.operationId} is not advertised by the installed ${op.provider} CLI.`
    );
  }

  if (op.exposure !== "mcp_requires_approval") {
    return fail(
      `Operation ${op.operationId} (exposure=${op.exposure}) is not an approval-gated mutating admin op.`
    );
  }

  // BLOCKER 1: remote-surface gate. Host-global CLI admin mutation must never be
  // triggerable by a remote HTTP/OAuth caller lacking the dedicated CLI-admin
  // gate. Fail closed WITHOUT spawning; audit gate_closed with the principal.
  if (ctx.remoteCaller && !ctx.remoteAdminAllowed) {
    auditBestEffort("gate_closed");
    return fail(
      `Mutating admin operation ${op.operationId} is not permitted for remote callers. ` +
        `Set LLM_GATEWAY_CLI_ADMIN=1 and grant the cli:admin OAuth scope to permit it.`
    );
  }

  // CONFIG GATE: deny-by-default. Fail closed WITHOUT spawning when disabled.
  if (!ctx.allowMutating) {
    auditBestEffort("gate_closed");
    return fail(
      `Mutating admin operation ${op.operationId} is disabled. Set [admin] ` +
        `allow_mutating_cli_admin_ops = true in ~/.llm-cli-gateway/config.toml to permit it.`
    );
  }

  assertSafeArgv(op.argv);

  // APPROVAL: route the mutating op through the ApprovalManager.
  const decision = ctx.approvalManager.decide({
    cli: op.provider as ApprovalCli,
    operation: `cli_admin:${op.operationId}`,
    prompt: `Provider CLI admin mutation: ${op.provider} ${op.argv.join(" ")} (${op.risk})`,
    bypassRequested: false,
    fullAuto: false,
    requestedMcpServers: [],
    metadata: { adminOperation: op.operationId, risk: op.risk, argv: op.argv },
  });

  if (decision.status !== "approved") {
    auditBestEffort("denied", { approvalId: decision.id });
    return fail(
      `Mutating admin operation ${op.operationId} denied by approval policy (${decision.reasons.join("; ")}).`
    );
  }

  // BLOCKER 2: persist the DURABLE approved-intent record BEFORE the spawn. If it
  // cannot be written, FAIL CLOSED so an approved mutation is never unlogged.
  try {
    sink({
      ts: new Date().toISOString(),
      provider: op.provider,
      operationId: op.operationId,
      argv: op.argv,
      outcome: "approved",
      approvalId: decision.id,
      principal: ctx.principal,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error(`admin mutating op aborted: audit write failed for ${op.operationId}`, { reason });
    return fail(
      `Mutating admin operation ${op.operationId} aborted: the approved-intent audit record ` +
        `could not be persisted, so the mutation was not run.`
    );
  }

  const def = getProviderDefinition(op.provider);
  const runner = ctx.runner ?? defaultAdminRunner;
  try {
    const result = await runner(def.primaryExecutable, op.argv, { timeoutMs: ctx.timeoutMs });
    auditBestEffort("executed", { approvalId: decision.id, exitCode: result.code });
    return {
      ok: result.code === 0,
      ...base,
      exitCode: result.code,
      stdout: redactAdminOutput(result.stdout),
      stderr: redactAdminOutput(result.stderr),
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.debug(`admin mutating op failed: ${op.operationId}`, { reason });
    auditBestEffort("executed", { approvalId: decision.id, exitCode: null });
    return fail(redactAdminOutput(reason));
  }
}

// ---------------------------------------------------------------------------
// Tool registration.
// ---------------------------------------------------------------------------

/** Whether the current request reached the gateway over the remote HTTP/OAuth surface. */
export function isRemoteAdminCaller(ctx: GatewayRequestContext | undefined): boolean {
  return ctx?.transport === "http" || ctx?.authKind === "oauth";
}

/**
 * Whether the dedicated remote CLI-admin gate is satisfied: the
 * `LLM_GATEWAY_CLI_ADMIN=1` env flag AND the `cli:admin` OAuth scope. Mirrors
 * `workspaceAdminEnabled()` for the workspace-admin surface: a remote caller may
 * mutate a host-global provider CLI surface only when BOTH hold.
 */
export function remoteCliAdminEnabled(ctx: GatewayRequestContext | undefined): boolean {
  const scopes = ctx?.authScopes ?? [];
  return process.env.LLM_GATEWAY_CLI_ADMIN === "1" && scopes.includes("cli:admin");
}

/** Runtime surface this module needs from the gateway server runtime. */
export interface ProviderAdminToolRuntime {
  readonly approvalManager: ApprovalManager;
  readonly logger: Logger;
  /** Resolved `[admin] allow_mutating_cli_admin_ops` gate. */
  readonly allowMutatingCliAdminOps: boolean;
}

/** Resolve a provider's admin operation by id, seeding discovery on demand. */
async function resolveAdminOperation(
  provider: CliType,
  operationId: string,
  logger: Logger
): Promise<AdminOperation | null> {
  const def = getProviderDefinition(provider);
  // Prefer the memo; otherwise resolve (cache/discovery) so the tool works even
  // before startup warm completes. Never throws (returns null -> no discovery).
  let discovered = peekProviderCapabilitySet(provider)?.set ?? null;
  if (!discovered) {
    const resolved = await resolveProviderCapabilitySet(def, { logger });
    discovered = resolved?.set ?? null;
  }
  const ops = projectProviderAdminOperations(def, discovered);
  return ops.find(o => o.operationId === operationId) ?? null;
}

const PROVIDER_ADMIN_ENUM = z.enum(
  getAllProviderDefinitions().map(d => d.id) as [CliType, ...CliType[]]
);

/**
 * M2: gate the READ-ONLY admin surface for remote callers.
 *
 * `provider_admin_list` and `provider_admin_run` are read-only but still SPAWN
 * host-global provider CLIs (discovery / `doctor` / `auth status`) and disclose
 * host auth/config state. A remote HTTP/OAuth principal must therefore satisfy
 * the same dedicated CLI-admin gate as the mutating path (`LLM_GATEWAY_CLI_ADMIN=1`
 * + the `cli:admin` OAuth scope); otherwise a remote caller could enumerate and
 * trigger unbounded host-CLI spawns. Returns a redacted error content block when
 * a remote caller is not permitted, else null. Local stdio callers are exempt.
 */
function remoteReadOnlyAdminGate(
  toolName: string
): { content: { type: "text"; text: string }[] } | null {
  const ctx = getRequestContext();
  if (isRemoteAdminCaller(ctx) && !remoteCliAdminEnabled(ctx)) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: false,
            error:
              `${toolName} is not permitted for remote callers. Set LLM_GATEWAY_CLI_ADMIN=1 ` +
              `and grant the cli:admin OAuth scope to permit read-only provider admin operations remotely.`,
          }),
        },
      ],
    };
  }
  return null;
}

/**
 * Register the three provider-admin tools:
 *  - `provider_admin_list`   read-only catalog projected from discovery.
 *  - `provider_admin_run`    execute a read-only admin op (redacted output).
 *  - `provider_admin_mutate` execute a gated mutating admin op (approval+audit).
 */
export function registerProviderAdminTools(
  server: McpServer,
  runtime: ProviderAdminToolRuntime
): void {
  server.tool(
    "provider_admin_list",
    "List provider CLI admin operations (auth status, model list, mcp list, plugin list, doctor, etc.) available on the installed CLIs, projected from runtime discovery. Read-only.",
    {
      provider: z
        .preprocess(
          value => (value === "" || value === null ? undefined : value),
          PROVIDER_ADMIN_ENUM.optional()
        )
        .describe("Optional provider filter"),
      includeUnavailable: z
        .boolean()
        .default(false)
        .describe("Include operations the installed CLI does not advertise or the policy hides"),
    },
    {
      title: "Provider admin operations catalog",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ provider, includeUnavailable }) => {
      const gate = remoteReadOnlyAdminGate("provider_admin_list");
      if (gate) return gate;
      // Seed discovery for the requested providers (never throws).
      const targets = provider ? [getProviderDefinition(provider)] : getAllProviderDefinitions();
      await Promise.all(
        targets.map(def =>
          peekProviderCapabilitySet(def.id)
            ? Promise.resolve(null)
            : resolveProviderCapabilitySet(def, { logger: runtime.logger }).catch(() => null)
        )
      );
      const rows = buildProviderAdminCatalog({ provider, includeUnavailable });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              schemaVersion: "provider-admin-catalog.v1",
              mutatingEnabled: runtime.allowMutatingCliAdminOps,
              total: rows.length,
              rows,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "provider_admin_run",
    "Execute a READ-ONLY provider CLI admin operation (from provider_admin_list) and return redacted output. Rejects mutating operations.",
    {
      provider: PROVIDER_ADMIN_ENUM.describe("Provider whose admin operation to run"),
      operationId: z
        .string()
        .min(1)
        .describe("Operation id from provider_admin_list, e.g. 'mcp.list' or 'doctor'"),
    },
    {
      title: "Run read-only provider admin operation",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ provider, operationId }) => {
      const gate = remoteReadOnlyAdminGate("provider_admin_run");
      if (gate) return gate;
      const op = await resolveAdminOperation(provider, operationId, runtime.logger);
      if (!op) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                error: `No admin operation '${operationId}' for ${provider} (not advertised by the installed CLI).`,
              }),
            },
          ],
        };
      }
      const result = await runReadOnlyAdminOperation(op, { logger: runtime.logger });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "provider_admin_mutate",
    "Execute a MUTATING provider CLI admin operation (mcp add/remove, login/logout, plugin install/remove, session delete/archive, ...). Disabled unless [admin] allow_mutating_cli_admin_ops=true; routed through approval and audited.",
    {
      provider: PROVIDER_ADMIN_ENUM.describe("Provider whose admin operation to run"),
      operationId: z
        .string()
        .min(1)
        .describe("Mutating operation id from provider_admin_list, e.g. 'mcp.remove'"),
    },
    {
      title: "Run mutating provider admin operation (gated)",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    async ({ provider, operationId }) => {
      const op = await resolveAdminOperation(provider, operationId, runtime.logger);
      if (!op) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                error: `No admin operation '${operationId}' for ${provider} (not advertised by the installed CLI).`,
              }),
            },
          ],
        };
      }
      const reqCtx = getRequestContext();
      const result = await runMutatingAdminOperation(op, {
        allowMutating: runtime.allowMutatingCliAdminOps,
        remoteCaller: isRemoteAdminCaller(reqCtx),
        remoteAdminAllowed: remoteCliAdminEnabled(reqCtx),
        principal: resolveOwnerPrincipal(reqCtx),
        approvalManager: runtime.approvalManager,
        logger: runtime.logger,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );
}
