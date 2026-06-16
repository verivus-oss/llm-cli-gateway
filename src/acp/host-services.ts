/**
 * Gateway-owned ACP HostServices — deny-by-default boundary (plan step
 * `define-host-services-boundary`).
 *
 * The {@link AcpClient} dispatches agent-initiated callbacks
 * (`fs/read_text_file`, `fs/write_text_file`, `session/request_permission`)
 * into a {@link HostServices} implementation. This module is the gateway's
 * concrete implementation, and in this slice it is a strict **deny-by-default
 * skeleton**:
 *
 *   - `fs/read_text_file`  → denied (filesystem read host service is disabled
 *     until a later phase wires a workspace-scoped reader),
 *   - `fs/write_text_file` → denied (`write_host_services_disabled_by_default`),
 *   - `session/request_permission` → denied by returning a VALID `cancelled`
 *     ACP outcome (there is no ApprovalManager bridge yet — that is the next
 *     slice; until then a side effect must never be granted),
 *   - terminal and MCP host methods are not part of the {@link HostServices}
 *     dispatch surface at all, so the client already answers them with a
 *     JSON-RPC method-not-found. They remain denied by construction.
 *
 * Security posture:
 *   - Every side-effect-capable request is denied. Read/write denials are thrown
 *     as typed {@link AcpPermissionDeniedError}s; the client turns them into a
 *     redacted JSON-RPC error reply (never a process crash). The permission
 *     callback returns a structured `cancelled` outcome — also a valid ACP
 *     response, never an allow.
 *   - No request field (path, content, permission options, tool call) is ever
 *     logged or echoed into the denial. Denial reasons are static strings, and
 *     the `AcpPermissionDeniedError` message is redacted at construction
 *     (`resources_redact_local_paths_and_auth_state`). Logs carry only the
 *     provider and method.
 */

import type { HostCallbackContext, HostServices } from "./client.js";
import { AcpPermissionDeniedError } from "./errors.js";
import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "./types.js";
import type { Logger } from "../logger.js";
import { noopLogger } from "../logger.js";

/**
 * A `session/request_permission` decider (the Slice B3 ApprovalManager bridge).
 * When omitted, the host denies every permission by cancelling the turn.
 */
export type AcpPermissionDecider = (
  request: RequestPermissionRequest,
  context: HostCallbackContext
) => Promise<RequestPermissionResponse>;

/** Construction options for {@link GatewayHostServices}. */
export interface GatewayHostServicesOptions {
  /** Gateway logger (stderr sink). Defaults to a no-op. */
  readonly logger?: Logger;
  /**
   * Optional permission decider (the ApprovalManager bridge). When provided,
   * `session/request_permission` routes through it; when omitted, every
   * permission is denied by cancelling the turn (the deny-by-default floor).
   */
  readonly permissionDecider?: AcpPermissionDecider;
}

/**
 * Deny-by-default gateway ACP HostServices.
 *
 * Later slices replace individual denials with workspace-scoped reads, an
 * ApprovalManager-backed permission bridge, and (optionally) approved writes —
 * each gated by config. Until then this is the safe floor: no agent-initiated
 * side effect is ever granted, and every denial is a valid ACP response.
 */
export class GatewayHostServices implements HostServices {
  private readonly logger: Logger;
  private readonly permissionDecider?: AcpPermissionDecider;

  constructor(options: GatewayHostServicesOptions = {}) {
    this.logger = options.logger ?? noopLogger;
    this.permissionDecider = options.permissionDecider;
  }

  /**
   * Deny `fs/read_text_file`. Filesystem read is unavailable until a later
   * phase wires a workspace-scoped reader; the request path is never inspected
   * or logged. The thrown error becomes a redacted JSON-RPC error reply.
   */
  async readTextFile(
    _request: ReadTextFileRequest,
    context: HostCallbackContext
  ): Promise<ReadTextFileResponse> {
    this.logger.info("acp.host.read_denied", { provider: context.provider });
    throw new AcpPermissionDeniedError(
      context.provider,
      "filesystem read host service is disabled",
      { provider: context.provider, debug: { method: context.method } }
    );
  }

  /**
   * Deny `fs/write_text_file` (`write_host_services_disabled_by_default`). The
   * request path and content are never inspected or logged.
   */
  async writeTextFile(
    _request: WriteTextFileRequest,
    context: HostCallbackContext
  ): Promise<WriteTextFileResponse> {
    this.logger.info("acp.host.write_denied", { provider: context.provider });
    throw new AcpPermissionDeniedError(
      context.provider,
      "filesystem write host service is disabled",
      { provider: context.provider, debug: { method: context.method } }
    );
  }

  /**
   * Deny `session/request_permission` by returning a structured `cancelled`
   * outcome. There is no ApprovalManager bridge yet (next slice), so no side
   * effect may be approved; cancelling the turn is the valid ACP denial. The
   * permission options / tool call are never inspected or logged.
   */
  async requestPermission(
    request: RequestPermissionRequest,
    context: HostCallbackContext
  ): Promise<RequestPermissionResponse> {
    // Slice B3: when a permission decider (ApprovalManager bridge) is wired,
    // route through it. Otherwise deny-by-default by cancelling the turn.
    if (this.permissionDecider) {
      return this.permissionDecider(request, context);
    }
    this.logger.info("acp.permission.denied", {
      provider: context.provider,
      reason: "no_approval_bridge",
      // Count only — never the option ids/names or the tool call payload.
      optionCount: request.options.length,
    });
    return { outcome: { outcome: "cancelled" } };
  }
}
