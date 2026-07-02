/**
 * ACP runtime — the gated path that routes a request through a provider's
 * native ACP transport (plan steps `pilot-mistral-acp-runtime` /
 * `pilot-grok-acp-runtime`, extended to Devin).
 *
 * This is the single place the foundation modules are assembled into a live
 * prompt round-trip. It is reached ONLY when a request explicitly selects
 * `transport: "acp"` AND both config gates are on; otherwise the caller uses
 * the existing CLI transport. The runtime fails closed:
 *
 *   - `[acp].enabled` off                    → {@link AcpDisabledError}
 *   - provider `enabled` off / absent         → {@link ProviderAcpDisabledError}
 *   - provider `runtime_enabled` off / absent → {@link ProviderRuntimeDisabledError}
 *
 * Flow: deny-by-default HostServices (with the ApprovalManager permission
 * bridge) → spawn + initialize via the process manager → gateway-owned session
 * (create or scope-checked resume) → `session/new`/`session/load` → `prompt`
 * with `session/update` streamed through the event normalizer → redacted
 * flight-recorder rows → accumulated final text. The provider process is always
 * torn down.
 */

import { AcpEventNormalizer } from "./event-normalizer.js";
import {
  AcpDisabledError,
  AcpError,
  AcpProtocolError,
  ProviderAcpDisabledError,
  ProviderRuntimeDisabledError,
  isAcpError,
} from "./errors.js";
import { buildAcpFlightResult, buildAcpFlightStart } from "./flight-redaction.js";
import { GatewayHostServices } from "./host-services.js";
import { createAcpPermissionDecider } from "./permission-bridge.js";
import { AcpProcessManager, type AcpSpawnFn, type ProcessEnv } from "./process-manager.js";
import { createAcpSession, recordAcpSessionInfo, resolveAcpResume } from "./session-map.js";
import type { ContentBlock } from "./types.js";
import { DEVIN_ACP_AGENT_TYPES } from "../provider-definitions.js";
import type { ApprovalCli, ApprovalManager } from "../approval-manager.js";
import type { AcpConfig } from "../config.js";
import type { FlightLogResult, FlightLogStart } from "../flight-recorder.js";
import type { Logger } from "../logger.js";
import { noopLogger } from "../logger.js";
import type { CliType, ISessionManager } from "../session-manager.js";

/** Minimal flight-recorder surface the runtime writes to (logStart/logComplete). */
export interface AcpFlightSink {
  logStart(entry: FlightLogStart): void;
  logComplete(correlationId: string, result: FlightLogResult): void;
}

/** Dependencies for {@link runAcpRequest}. */
export interface AcpRuntimeDeps {
  readonly config: AcpConfig;
  readonly sessionManager: ISessionManager;
  readonly approvalManager: ApprovalManager;
  readonly flightRecorder?: AcpFlightSink;
  readonly logger?: Logger;
  /** Injectable spawner (tests). Defaults to the process manager's shell:false spawn. */
  readonly spawn?: AcpSpawnFn;
  readonly baseEnv?: ProcessEnv;
  /** Injectable clock (ms) for deterministic durations. */
  readonly now?: () => number;
}

/** A single ACP prompt request. */
export interface AcpRunRequest {
  readonly provider: CliType;
  readonly prompt: string;
  readonly model?: string;
  /** Gateway gw-* session id to resume; omit to create a fresh ACP session. */
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly correlationId: string;
  /**
   * Devin-only: which ACP agent to run (`devin acp --agent-type <type>`). Ignored
   * for other providers. A validated enum value (summarizer|review), never
   * free-form input; appended as fixed argv (no shell interpolation).
   */
  readonly agentType?: string;
}

/** Successful ACP run outcome. */
export interface AcpRunResult {
  readonly text: string;
  readonly gatewaySessionId: string;
  readonly protocolVersion: number | null;
  readonly durationMs: number;
  /**
   * The terminal stop reason from the ACP `session/prompt` response (e.g.
   * `end_turn`, `refusal`, `cancelled`, `max_tokens`), or null when the provider
   * omits one. Surfaced so a refused/cancelled/truncated turn that produced no
   * text is not indistinguishable from a normal empty answer at the caller.
   */
  readonly stopReason: string | null;
}

/** Per-request token usage lifted from an ACP `session/prompt` response `_meta`. */
export interface AcpPromptUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

/**
 * Phase 7 / acceptance #1: extract per-request token usage from an ACP
 * `session/prompt` response `_meta`.
 *
 * Field names are the live-verified grok `agent stdio` shape captured on
 * 2026-06-13 (documented in docs/personal-mcp/PROVIDER_CACHE_SURFACES.md):
 * `inputTokens`, `outputTokens`, and `cachedReadTokens` (cache READS). They are
 * read defensively: only finite numeric fields are lifted, so a provider whose
 * ACP `_meta` omits usage (or names it differently) yields `{}` rather than a
 * fabricated count, and the flight-recorder columns stay NULL (typed capability
 * fact). `totalTokens` is deliberately NOT surfaced: the same capture pins it as
 * the per-turn input+output SUM, never a per-request input count, so lifting it
 * as usage would double-count.
 */
export function extractAcpPromptUsage(meta: unknown): AcpPromptUsage {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  const record = meta as Record<string, unknown>;
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const usage: AcpPromptUsage = {};
  const inputTokens = num(record.inputTokens);
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  const outputTokens = num(record.outputTokens);
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  const cacheReadTokens = num(record.cachedReadTokens);
  if (cacheReadTokens !== undefined) usage.cacheReadTokens = cacheReadTokens;
  return usage;
}

/**
 * Route a request through a provider's native ACP transport. Throws a typed
 * {@link AcpError} on a closed gate, a failed resume, or a provider/protocol
 * failure; always tears down the provider process.
 */
export async function runAcpRequest(
  deps: AcpRuntimeDeps,
  req: AcpRunRequest
): Promise<AcpRunResult> {
  const logger = deps.logger ?? noopLogger;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const elapsed = (): number => Math.max(0, now() - startedAt);

  // Fail closed on the config gates BEFORE any process work.
  if (!deps.config.enabled) {
    throw new AcpDisabledError({ provider: req.provider });
  }
  const providerConfig = deps.config.providers[req.provider];
  // Fail closed unless the provider is BOTH enabled and runtime-routing enabled.
  // A provider with enabled=false must never spawn, even if runtime_enabled=true.
  if (providerConfig?.enabled !== true) {
    throw new ProviderAcpDisabledError(req.provider, { provider: req.provider });
  }
  if (providerConfig?.runtimeEnabled !== true) {
    throw new ProviderRuntimeDisabledError(req.provider, { provider: req.provider });
  }

  // Deny-by-default host services with the ApprovalManager permission bridge.
  const permissionDecider = createAcpPermissionDecider({
    approvalManager: deps.approvalManager,
    provider: req.provider as ApprovalCli,
    allowWrite: deps.config.allowWriteHostServices,
    allowTerminal: deps.config.allowTerminalHostServices,
    logger,
  });
  const hostServices = new GatewayHostServices({ logger, permissionDecider });

  const manager = new AcpProcessManager({
    config: deps.config,
    logger,
    spawn: deps.spawn,
    baseEnv: deps.baseEnv,
  });
  const normalizer = new AcpEventNormalizer();

  // Resolve the gateway session: scope-checked resume, or a fresh gateway id.
  let gatewaySessionId: string;
  let resumeProviderSessionId: string | null = null;
  if (req.sessionId) {
    const resume = await resolveAcpResume(deps.sessionManager, req.sessionId, req.provider);
    if (!resume.ok) {
      throw new AcpProtocolError(`ACP session resume failed (${resume.reason}).`, {
        provider: req.provider,
        debug: { reason: resume.reason },
      });
    }
    gatewaySessionId = req.sessionId;
    resumeProviderSessionId = resume.providerSessionId;
  } else {
    gatewaySessionId = await createAcpSession(deps.sessionManager, {
      provider: req.provider,
      cwd: req.cwd,
    });
  }

  const promptBlocks: ContentBlock[] = [{ type: "text", text: req.prompt }];
  deps.flightRecorder?.logStart(
    buildAcpFlightStart({
      correlationId: req.correlationId,
      provider: req.provider,
      model: req.model ?? "default",
      prompt: promptBlocks,
      gatewaySessionId,
    })
  );

  // Devin-only: thread a validated `--agent-type` into the spawn argv. The value
  // must be a known enum member; an unknown value is dropped (never injected as
  // arbitrary argv). Other providers never receive extra args here.
  const extraArgs =
    req.provider === "devin" &&
    req.agentType !== undefined &&
    (DEVIN_ACP_AGENT_TYPES as readonly string[]).includes(req.agentType)
      ? ["--agent-type", req.agentType]
      : [];

  let proc: Awaited<ReturnType<AcpProcessManager["start"]>> | null = null;
  try {
    proc = await manager.start({
      provider: req.provider,
      cwd: req.cwd,
      hostServices,
      callbacks: { onSessionUpdate: update => normalizer.handle(update) },
      extraArgs,
    });
    const cwd = proc.resolved.cwd;
    const init = proc.client.agentInfo;

    // Create or resume the provider ACP session.
    let providerSessionId: string;
    if (resumeProviderSessionId) {
      await proc.client.loadSession({ sessionId: resumeProviderSessionId, cwd, mcpServers: [] });
      providerSessionId = resumeProviderSessionId;
    } else {
      const session = await proc.client.newSession({ cwd, mcpServers: [] });
      providerSessionId = session.sessionId;
      await recordAcpSessionInfo(deps.sessionManager, gatewaySessionId, {
        providerSessionId,
        protocolVersion: init?.protocolVersion,
        agentName: init?.agentInfo?.name,
        agentVersion: init?.agentInfo?.version,
      });
    }

    const promptResult = await proc.client.prompt({
      sessionId: providerSessionId,
      prompt: promptBlocks,
    });
    // Phase 7: ACP carries the stop reason on the session/prompt response (not a
    // session/update), so record it through the normalizer's completion event.
    normalizer.completeWith(promptResult.stopReason);
    const text = normalizer.finalText;
    const durationMs = elapsed();

    // Phase 7 / acceptance #1: lift per-request token usage from the ACP
    // `session/prompt` response `_meta` (grok's live-verified shape). Absent for
    // providers whose ACP transport omits usage → columns stay NULL, never faked.
    const usage = extractAcpPromptUsage(promptResult._meta);

    deps.flightRecorder?.logComplete(
      req.correlationId,
      buildAcpFlightResult({
        responseText: text,
        durationMs,
        status: "completed",
        exitCode: 0,
        // Phase 7: persist the provider session id (resume) + stop reason.
        providerSessionId,
        stopReason: normalizer.stopReason,
        // Phase 7 / acceptance #1: per-request usage from `_meta` (when emitted).
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
      })
    );
    logger.info("acp.request.success", { provider: req.provider, durationMs });
    return {
      text,
      gatewaySessionId,
      protocolVersion: init?.protocolVersion ?? null,
      durationMs,
      stopReason: normalizer.stopReason ?? null,
    };
  } catch (err) {
    const durationMs = elapsed();
    deps.flightRecorder?.logComplete(
      req.correlationId,
      buildAcpFlightResult({
        responseText: "",
        durationMs,
        status: "failed",
        exitCode: 1,
        errorMessage: isAcpError(err) ? err.userMessage : "ACP request failed.",
      })
    );
    logger.error("acp.request.failure", {
      provider: req.provider,
      durationMs,
      errorClass: err instanceof Error ? err.name : "unknown",
    });
    throw err instanceof AcpError
      ? err
      : new AcpProtocolError("ACP request failed unexpectedly.", {
          provider: req.provider,
          debug: { errorClass: err instanceof Error ? err.name : "unknown" },
        });
  } finally {
    proc?.shutdown("SIGTERM");
    manager.shutdownAll("SIGKILL");
  }
}
