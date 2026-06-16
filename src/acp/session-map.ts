/**
 * ACP session map (plan step `implement-session-map`).
 *
 * Maps gateway sessions to provider ACP sessions WITHOUT ever reusing a
 * provider-owned ACP session id as a gateway session id:
 *
 *   - Gateway session ids are gateway-owned `gw-*` ids (the existing
 *     {@link GATEWAY_SESSION_PREFIX}). The provider's ACP session id lives only
 *     in `session.metadata.acp.sessionId`
 *     (`do_not_reuse_provider_id_as_gateway_id`,
 *     `gateway_session_ids_remain_gateway_owned`).
 *   - The session is scoped by provider AND transport
 *     (`active_session_scope = "provider plus transport"`). A gateway ACP
 *     session can be resumed only through the SAME provider and the ACP
 *     transport; cross-provider and cross-transport resume are rejected
 *     (`provider_native_sessions_are_not_gateway_sessions`).
 *
 * This module is pure orchestration over an {@link ISessionManager}; it performs
 * no provider I/O. The runtime handlers (a later slice) create a gateway ACP
 * session, run `session/new` against the provider, record the returned provider
 * id here, and resolve resumes through {@link resolveAcpResume}.
 */

import { randomUUID } from "node:crypto";

import { GATEWAY_SESSION_PREFIX } from "../request-helpers.js";
import type { CliType, ISessionManager } from "../session-manager.js";

/** The ACP transport tag stored on gateway sessions created for ACP. */
export const ACP_TRANSPORT = "acp" as const;

/**
 * The `session.metadata.acp` shape. Redacted-friendly: the provider ACP session
 * id is the only provider-owned value and is never surfaced as a gateway id.
 */
export interface AcpSessionMetadata {
  /** Provider that owns the ACP session. */
  readonly provider: CliType;
  /** Transport tag — always "acp" for sessions created here. */
  readonly transport: typeof ACP_TRANSPORT;
  /** Provider-owned ACP session id (set after `session/new`); absent until then. */
  readonly sessionId?: string;
  /** Negotiated ACP protocol version. */
  readonly protocolVersion?: number;
  /** Agent display name (`agentInfo.name`). */
  readonly agentName?: string;
  /** Agent version (`agentInfo.version`). */
  readonly agentVersion?: string;
  /** Working directory the ACP session was created against. */
  readonly cwd?: string;
  /** Registered workspace alias, when the request used one. */
  readonly workspaceAlias?: string;
  /** Gateway-owned worktree path, when the request used one. */
  readonly worktreePath?: string;
  /** ISO timestamp the gateway ACP session was created. */
  readonly createdAt: string;
  /** ISO timestamp the gateway ACP session was last touched. */
  readonly lastSeenAt: string;
}

/** True when `id` is a gateway-owned session id (the `gw-` prefix). */
export function isGatewaySessionId(id: string): boolean {
  return id.startsWith(GATEWAY_SESSION_PREFIX);
}

/** Generate a fresh gateway-owned session id. Never derived from a provider id. */
export function newGatewaySessionId(): string {
  return `${GATEWAY_SESSION_PREFIX}${randomUUID()}`;
}

/** Parameters for {@link createAcpSession}. */
export interface CreateAcpSessionParams {
  readonly provider: CliType;
  readonly cwd?: string;
  readonly workspaceAlias?: string;
  readonly worktreePath?: string;
  /** Injectable clock (ISO string) for deterministic tests. */
  readonly now?: () => string;
}

/**
 * Create a fresh gateway-owned ACP session (a `gw-*` id) and stamp its
 * `metadata.acp` with the provider + transport scope. The provider ACP session
 * id is NOT known yet (it is recorded by {@link recordAcpSessionInfo} after
 * `session/new`). Returns the gateway session id.
 */
export async function createAcpSession(
  sessionManager: ISessionManager,
  params: CreateAcpSessionParams
): Promise<string> {
  const now = (params.now ?? (() => new Date().toISOString()))();
  const gatewaySessionId = newGatewaySessionId();
  const metadata: AcpSessionMetadata = {
    provider: params.provider,
    transport: ACP_TRANSPORT,
    cwd: params.cwd,
    workspaceAlias: params.workspaceAlias,
    worktreePath: params.worktreePath,
    createdAt: now,
    lastSeenAt: now,
  };
  await sessionManager.createSession(
    params.provider,
    `${params.provider} ACP Session`,
    gatewaySessionId
  );
  const stamped = await sessionManager.updateSessionMetadata(gatewaySessionId, { acp: metadata });
  if (!stamped) {
    // The session vanished between create and stamp (e.g. TTL eviction). A gw-*
    // id without its acp scope is not a valid ACP session, so fail loudly rather
    // than return an id that resolveAcpResume would later reject as wrong_transport.
    throw new Error("failed to stamp ACP metadata on the new gateway session");
  }
  return gatewaySessionId;
}

/** Fields recorded after a provider `session/new`/`initialize` completes. */
export interface AcpSessionInfo {
  /** Provider-owned ACP session id from `session/new`. */
  readonly providerSessionId: string;
  readonly protocolVersion?: number;
  readonly agentName?: string;
  readonly agentVersion?: string;
  readonly now?: () => string;
}

/**
 * Record the provider ACP session id + protocol/agent info onto an existing
 * gateway ACP session's metadata. Merges with the existing `metadata.acp`
 * (preserving provider/transport/cwd) and bumps `lastSeenAt`.
 *
 * Returns false when the gateway session does not exist or is not an ACP
 * session (so a CLI session can never be coerced into an ACP one).
 */
export async function recordAcpSessionInfo(
  sessionManager: ISessionManager,
  gatewaySessionId: string,
  info: AcpSessionInfo
): Promise<boolean> {
  const existing = await readAcpMetadata(sessionManager, gatewaySessionId);
  if (!existing) return false;
  const now = (info.now ?? (() => new Date().toISOString()))();
  const merged: AcpSessionMetadata = {
    ...existing,
    sessionId: info.providerSessionId,
    protocolVersion: info.protocolVersion ?? existing.protocolVersion,
    agentName: info.agentName ?? existing.agentName,
    agentVersion: info.agentVersion ?? existing.agentVersion,
    lastSeenAt: now,
  };
  // Propagate the write result: a caller is told "recorded" only when the
  // provider session id actually persisted (not on a lost write).
  return sessionManager.updateSessionMetadata(gatewaySessionId, { acp: merged });
}

/** Outcome of {@link resolveAcpResume}. */
export type AcpResumeResult =
  | { readonly ok: true; readonly providerSessionId: string; readonly metadata: AcpSessionMetadata }
  | {
      readonly ok: false;
      readonly reason: "not_found" | "wrong_provider" | "wrong_transport" | "no_provider_session";
    };

/**
 * Resolve a resume request to the provider ACP session id, enforcing the
 * provider+transport ownership scope:
 *
 *   - `not_found`         — no gateway session with this id.
 *   - `wrong_transport`   — the session exists but is not an ACP session
 *                           (e.g. a CLI session; cross-transport resume rejected).
 *   - `wrong_provider`    — the ACP session belongs to a different provider
 *                           (cross-provider resume rejected).
 *   - `no_provider_session` — an ACP session exists but `session/new` was never
 *                           recorded, so there is no provider id to resume.
 */
export async function resolveAcpResume(
  sessionManager: ISessionManager,
  gatewaySessionId: string,
  provider: CliType
): Promise<AcpResumeResult> {
  const acp = await readAcpMetadata(sessionManager, gatewaySessionId);
  if (!acp) {
    // Either no session at all, or a non-ACP (CLI) session. Both are rejected
    // for an ACP resume; the distinction is not security-relevant.
    const session = await sessionManager.getSession(gatewaySessionId);
    return { ok: false, reason: session ? "wrong_transport" : "not_found" };
  }
  if (acp.transport !== ACP_TRANSPORT) {
    return { ok: false, reason: "wrong_transport" };
  }
  if (acp.provider !== provider) {
    return { ok: false, reason: "wrong_provider" };
  }
  if (!acp.sessionId) {
    return { ok: false, reason: "no_provider_session" };
  }
  return { ok: true, providerSessionId: acp.sessionId, metadata: acp };
}

/** Read + shape the `metadata.acp` block, or null when absent/not an object. */
async function readAcpMetadata(
  sessionManager: ISessionManager,
  gatewaySessionId: string
): Promise<AcpSessionMetadata | null> {
  const session = await sessionManager.getSession(gatewaySessionId);
  const acp = session?.metadata?.acp as AcpSessionMetadata | undefined;
  if (!acp || typeof acp !== "object") return null;
  return acp;
}
