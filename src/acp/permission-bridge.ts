/**
 * ACP permission bridge (plan step `implement-permission-bridge`).
 *
 * Routes an agent's `session/request_permission` callback through the gateway's
 * {@link ApprovalManager} instead of leaving it denied-by-default. This is the
 * single place where an ACP-driven side effect can be approved, so it is
 * deny-leaning by construction:
 *
 *   1. **Category gate (config + deny-by-default).** The requested tool-call
 *      category is derived from the ACP `toolCall.kind`. Write-class categories
 *      (`edit`/`delete`/`move`) are denied unless `allowWrite`; execute/terminal-
 *      class categories (`execute`) are denied unless `allowTerminal`
 *      (`write_host_services_disabled_by_default`,
 *      `terminal_host_services_disabled_by_default`). Crucially, any kind the
 *      gateway cannot categorize as a known no-side-effect read (`other`) is
 *      **denied by default** — an unrecognized or future side-effecting kind
 *      must never be auto-approved by the score-0 heuristic. Only local read-
 *      class kinds (`read`/`search`/`think`) proceed without an explicit config
 *      gate; a network-retrieval kind is treated as `other` (denied by default).
 *      A category-denied request never reaches the approval heuristic.
 *   2. **ApprovalManager.** Categories that pass the config gate are recorded
 *      and decided by {@link ApprovalManager.decide} — the existing audit
 *      surface (`approval_manager_required_for_provider_permissions`).
 *   3. **Option selection.** Approval is expressed only by selecting an
 *      agent-offered "allow" option. If the agent offered no allow option, or
 *      the decision is "denied", or anything throws, the turn is **cancelled**
 *      (the safe ACP denial).
 *
 * Redaction: no `toolCall` payload, option id/name, or path is ever logged or
 * placed in the approval prompt. The approval prompt is a static per-provider
 * string; logs carry only provider, derived category, and decision.
 */

import type { HostCallbackContext } from "./client.js";
import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "./types.js";
import { ApprovalManager, type ApprovalCli, type ApprovalPolicy } from "../approval-manager.js";
import type { Logger } from "../logger.js";
import { noopLogger } from "../logger.js";

/** Tool-call categories the bridge gates on, derived from ACP `toolCall.kind`. */
export type AcpPermissionCategory = "read" | "write" | "execute" | "other";

/** ACP `toolCall.kind` values that mutate the workspace (write-class). */
const WRITE_KINDS: ReadonlySet<string> = new Set(["edit", "delete", "move"]);
/** ACP `toolCall.kind` values that run commands (terminal-class). */
const EXECUTE_KINDS: ReadonlySet<string> = new Set(["execute"]);
/**
 * ACP `toolCall.kind` values that have no local workspace side effect
 * (read-class): a local read, a workspace search, and a pure reasoning step.
 * A network-retrieval kind is intentionally NOT read-class — it is a network
 * side effect and falls to `other` (denied by default). Any kind NOT in the
 * read/write/execute sets is treated as `other` and denied by default.
 */
const READ_KINDS: ReadonlySet<string> = new Set(["read", "search", "think"]);

/** Construction deps for {@link createAcpPermissionDecider}. */
export interface AcpPermissionBridgeDeps {
  /** Approval audit + decision surface. */
  readonly approvalManager: ApprovalManager;
  /** The ACP provider, as an approval cli (for the audit record). */
  readonly provider: ApprovalCli;
  /** Whether write-class permissions may be approved (config). Default false. */
  readonly allowWrite?: boolean;
  /** Whether execute/terminal-class permissions may be approved (config). Default false. */
  readonly allowTerminal?: boolean;
  /** Approval policy override. */
  readonly policy?: ApprovalPolicy;
  /** Gateway logger (stderr sink). Defaults to a no-op. */
  readonly logger?: Logger;
}

/**
 * Derive the gated category from an ACP `toolCall.kind`. Unknown/missing kinds
 * are treated as `other` (still subject to the approval heuristic, but neither a
 * known read nor auto-denied as write/execute).
 */
export function categorizeToolCall(toolCall: Record<string, unknown>): AcpPermissionCategory {
  const kind = typeof toolCall.kind === "string" ? toolCall.kind.toLowerCase() : "";
  if (WRITE_KINDS.has(kind)) return "write";
  if (EXECUTE_KINDS.has(kind)) return "execute";
  if (READ_KINDS.has(kind)) return "read";
  return "other";
}

/** True when the option is an agent-offered "allow" (ACP kind `allow_*`). */
function isAllowOption(option: PermissionOption): boolean {
  const kind = typeof option.kind === "string" ? option.kind.toLowerCase() : "";
  return kind.startsWith("allow");
}

/** The cancelled (deny) ACP outcome. */
const CANCELLED: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

/**
 * Build a `requestPermission` handler that bridges to {@link ApprovalManager}.
 * The returned function never throws and is deny-leaning: it returns a
 * `selected` allow outcome only when the config category gate passes, the
 * approval decision is "approved", and the agent offered an allow option.
 */
export function createAcpPermissionDecider(
  deps: AcpPermissionBridgeDeps
): (
  request: RequestPermissionRequest,
  context: HostCallbackContext
) => Promise<RequestPermissionResponse> {
  const logger = deps.logger ?? noopLogger;

  return async (request, _context) => {
    const category = categorizeToolCall(request.toolCall);

    // 1. Config category gate — deny write/execute unless explicitly allowed.
    if (category === "write" && deps.allowWrite !== true) {
      logger.info("acp.permission.denied", {
        provider: deps.provider,
        category,
        reason: "write_disabled",
      });
      return CANCELLED;
    }
    if (category === "execute" && deps.allowTerminal !== true) {
      logger.info("acp.permission.denied", {
        provider: deps.provider,
        category,
        reason: "terminal_disabled",
      });
      return CANCELLED;
    }
    // Deny-by-default for unrecognized/unknown tool kinds: a kind the gateway
    // cannot categorize as a known no-side-effect read MUST NOT be auto-approved
    // by the score-0 heuristic, because it may represent a future side effect.
    // Only read/search/fetch/think proceed without an explicit config gate;
    // write/execute proceed only when allowWrite/allowTerminal is set above.
    if (category === "other") {
      logger.info("acp.permission.denied", {
        provider: deps.provider,
        category,
        reason: "unknown_kind_denied",
      });
      return CANCELLED;
    }

    // 2. Record + decide through the gateway approval surface. No tool-call
    //    payload, option, or path enters the prompt/metadata.
    let approved: boolean;
    try {
      const record = deps.approvalManager.decide({
        cli: deps.provider,
        operation: `acp_permission:${category}`,
        prompt: `ACP permission request from ${deps.provider}`,
        bypassRequested: false,
        fullAuto: false,
        requestedMcpServers: [],
        policy: deps.policy,
        metadata: { acp: true, category, optionCount: request.options.length },
      });
      approved = record.status === "approved";
    } catch (err) {
      logger.error("acp.permission.decide_error", {
        provider: deps.provider,
        category,
        errorClass: err instanceof Error ? err.name : "unknown",
      });
      return CANCELLED;
    }

    if (!approved) {
      logger.info("acp.permission.denied", {
        provider: deps.provider,
        category,
        reason: "approval_denied",
      });
      return CANCELLED;
    }

    // 3. Express approval ONLY by selecting an agent-offered allow option.
    const allow = request.options.find(isAllowOption);
    if (!allow) {
      logger.info("acp.permission.denied", {
        provider: deps.provider,
        category,
        reason: "no_allow_option",
      });
      return CANCELLED;
    }

    logger.info("acp.permission.approved", { provider: deps.provider, category });
    return { outcome: { outcome: "selected", optionId: allow.optionId } };
  };
}
